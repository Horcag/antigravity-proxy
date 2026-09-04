import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { CloudAccount } from '@/modules/cloud-account/types';
import { RateLimitTracker } from './rate-limit-tracker';
import {
  ACCOUNT_LEASE_ACCOUNT_STORE,
  ACCOUNT_LEASE_UPSTREAM,
  type AccountLeaseAccountStore,
  type AccountLeaseUpstream,
  cloudAccountStoreAdapter,
  googleAccountLeaseUpstreamAdapter,
} from './account-lease-adapters';
import { AccountLeaseQuotaRefreshPolicy } from './account-lease-quota-refresh-policy';
import type { AccountLeaseQuotaCatalogRefreshResult } from './account-lease-quota-refresh-policy';
import { AccountLeaseTokenCache } from './account-lease-token-cache';
import { AccountLeaseHydrationPolicy } from './account-lease-hydration-policy';
import { AccountLeaseFulfillmentPolicy } from './account-lease-fulfillment-policy';
import { AccountLeaseSelectionPolicy } from './account-lease-selection-policy';
import { AccountLeaseModelPolicy } from './account-lease-model-policy';
import { type AccountLeaseTokenData } from './account-lease-token-types';
import {
  AccountLeaseLimitPolicy,
  type AccountLeaseUpstreamErrorParams,
} from './account-lease-limit-policy';
import { AccountLeaseConfigPolicy } from './account-lease-config-policy';

interface GetNextTokenOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
}

type TokenData = AccountLeaseTokenData;
type TokenEntry = [string, TokenData];

@Injectable()
export class AccountLeaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountLeaseService.name);
  private readonly stickySessionTtlMs = 10 * 60 * 1000;
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;
  private readonly quotaCatalogRefreshIntervalMs = 10 * 60 * 1000;

  private tokens: Map<string, TokenData> = new Map();
  private quotaCatalogRefreshTimer?: NodeJS.Timeout;
  private readonly configPolicy = new AccountLeaseConfigPolicy();
  private readonly quotaRefreshPolicy: AccountLeaseQuotaRefreshPolicy;
  private readonly tokenCache: AccountLeaseTokenCache;
  private readonly selectionPolicy = new AccountLeaseSelectionPolicy();
  private readonly hydrationPolicy: AccountLeaseHydrationPolicy;
  private readonly fulfillmentPolicy: AccountLeaseFulfillmentPolicy;
  private readonly modelPolicy: AccountLeaseModelPolicy;
  private readonly limitPolicy: AccountLeaseLimitPolicy;

  constructor(
    @Optional()
    @Inject(ACCOUNT_LEASE_ACCOUNT_STORE)
    private readonly accountStore: AccountLeaseAccountStore = cloudAccountStoreAdapter,
    @Optional()
    @Inject(ACCOUNT_LEASE_UPSTREAM)
    private readonly upstream: AccountLeaseUpstream = googleAccountLeaseUpstreamAdapter,
  ) {
    this.quotaRefreshPolicy = new AccountLeaseQuotaRefreshPolicy({
      accountStore: this.accountStore,
      upstream: this.upstream,
      getTokenCache: () => this.tokens,
      hydrateTokenIfNeeded: (accountId, tokenData, nowSeconds) =>
        this.hydrationPolicy.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds),
      hydrateTokenAfterAuthFailure: (accountId, tokenData, nowSeconds) =>
        this.hydrationPolicy.refreshSelectedTokenAfterAuthFailure(accountId, tokenData, nowSeconds),
      setLockoutUntilIso: (accountId, resetTime, reason, model) =>
        this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model),
      logger: this.logger,
    });
    this.tokenCache = new AccountLeaseTokenCache({
      accountStore: this.accountStore,
      getTokenCache: () => this.tokens,
      applyQuotaSnapshot: (snapshot) => this.quotaRefreshPolicy.applyModelForwardingRules(snapshot),
      logger: this.logger,
    });
    this.hydrationPolicy = new AccountLeaseHydrationPolicy({
      accountStore: this.accountStore,
      upstream: this.upstream,
      getTokenCache: () => this.tokens,
      logger: this.logger,
      persistTokenState: (accountId, tokenData) => this.persistTokenState(accountId, tokenData),
    });
    this.fulfillmentPolicy = new AccountLeaseFulfillmentPolicy({
      hydrationPolicy: this.hydrationPolicy,
      bindSession: (sessionKey, accountId, expiresAt) =>
        this.selectionPolicy.bindSession(sessionKey, accountId, expiresAt),
      stickySessionTtlMs: this.stickySessionTtlMs,
      resolveFallbackProjectId: () => this.configPolicy.resolveFallbackProjectId(),
      logger: this.logger,
    });
    this.modelPolicy = new AccountLeaseModelPolicy({
      getTokenCache: () => this.tokens,
      logger: this.logger,
    });
    this.limitPolicy = new AccountLeaseLimitPolicy({
      rateLimitCooldownMs: this.rateLimitCooldownMs,
      forbiddenCooldownMs: this.forbiddenCooldownMs,
      resolveAccountId: (accountIdOrEmail) => this.resolveAccountId(accountIdOrEmail),
      getCircuitBreakerBackoffSteps: () => this.configPolicy.getCircuitBreakerBackoffSteps(),
      refreshRealtimeQuotaAndSetPreciseLockout: (accountId, reason, model) =>
        this.quotaRefreshPolicy.refreshRealtimeQuotaAndSetPreciseLockout(accountId, reason, model),
      setPreciseLockoutFromCachedQuota: (accountId, reason, model) =>
        this.quotaRefreshPolicy.setPreciseLockoutFromCachedQuota(accountId, reason, model),
      logger: this.logger,
    });
  }

  private get accountCooldowns(): Map<string, number> {
    return this.limitPolicy.getAccountCooldowns();
  }

  private get rateLimitTracker(): RateLimitTracker {
    return this.limitPolicy.getRateLimitTracker();
  }

  private get shadowComparisonCount(): number {
    return this.selectionPolicy.getShadowComparisonCount();
  }

  private get noGoBlocked(): boolean {
    return this.selectionPolicy.isNoGoBlocked();
  }

  async onModuleInit() {
    await this.loadAccounts();
    void this.refreshQuotaCatalog({ force: true }).catch((error: unknown) => {
      this.logger.warn('Startup quota catalog refresh failed', error);
    });
    this.startQuotaCatalogRefreshTimer();
  }

  async onModuleDestroy() {
    this.stopQuotaCatalogRefreshTimer();
    await this.quotaRefreshPolicy.shutdown();
  }

  async loadAccounts(): Promise<number> {
    this.quotaRefreshPolicy.invalidateActiveRefreshes();
    return this.tokenCache.loadAccounts();
  }

  async reloadAllAccounts(): Promise<number> {
    const count = await this.loadAccounts();
    this.clearAllRateLimits();
    this.clearAllSessions();
    return count;
  }

  refreshQuotaCatalog(options: {
    force?: boolean;
    model?: string;
  } = {}): Promise<AccountLeaseQuotaCatalogRefreshResult> {
    return this.quotaRefreshPolicy.refreshQuotaCatalog(options);
  }

  clearAllSessions(): void {
    this.selectionPolicy.clearSessions();
  }

  clearAllRateLimits(): void {
    this.limitPolicy.clearAllRateLimits();
  }

  recordParityError(): void {
    this.selectionPolicy.recordParityError(this.configPolicy.getSelectionConfig(), this.logger);
  }

  setPreferredAccount(accountId?: string): void {
    this.configPolicy.setPreferredAccount(accountId);
  }

  isRateLimited(accountIdOrEmail: string, model?: string): boolean {
    return this.limitPolicy.isRateLimited(accountIdOrEmail, model);
  }

  markAsRateLimited(accountIdOrEmail: string) {
    this.limitPolicy.markAsRateLimited(accountIdOrEmail);
  }

  markAsForbidden(accountIdOrEmail: string) {
    this.limitPolicy.markAsForbidden(accountIdOrEmail);
  }

  markModelSuccess(accountIdOrEmail: string, model: string): void {
    this.limitPolicy.markModelSuccess(accountIdOrEmail, model);
  }

  async markFromUpstreamError(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    await this.limitPolicy.markFromUpstreamError(params);
  }

  async getNextToken(options?: GetNextTokenOptions): Promise<CloudAccount | null> {
    try {
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) {
        return null;
      }

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      const sessionKey = options?.sessionKey?.trim();
      const model = options?.model;
      const excludedAccountIds = new Set(options?.excludeAccountIds ?? []);

      this.rateLimitTracker.cleanupExpired();

      const fullAccountPool = Array.from(this.tokens.entries());
      let modelCapableAccountPool = this.selectModelCapableAccounts(fullAccountPool, model);
      if (model && modelCapableAccountPool.length === 0) {
        await this.refreshQuotaCatalog({ force: true, model });
        modelCapableAccountPool = this.selectModelCapableAccounts(
          Array.from(this.tokens.entries()),
          model,
        );
      }
      if (modelCapableAccountPool.length === 0) {
        this.logger.warn(`No account advertises requested model: ${model ?? 'unknown'}`);
        return null;
      }

      const requestableAccountPool = model
        ? modelCapableAccountPool.filter(([accountId]) =>
            this.modelPolicy.isModelRequestableForAccount(accountId, model),
          )
        : modelCapableAccountPool;
      if (requestableAccountPool.length === 0) {
        this.logger.warn(`All compatible account/model pairs are temporarily unavailable: ${model}`);
        return null;
      }

      const rateLimitEligiblePool = model
        ? requestableAccountPool.filter(([accountId]) => {
            const effectiveModel = this.modelPolicy.resolveDynamicModelForAccount(
              accountId,
              model,
              false,
            );
            return !this.rateLimitTracker.isRateLimited(accountId, effectiveModel);
          })
        : requestableAccountPool;
      if (rateLimitEligiblePool.length === 0) {
        this.logger.warn(`All model-capable accounts are rate limited: ${model ?? 'unknown'}`);
        return null;
      }

      const filteredAccountPool = rateLimitEligiblePool.filter(
        ([accountId]) => !excludedAccountIds.has(accountId),
      );
      if (filteredAccountPool.length === 0 && excludedAccountIds.size > 0) {
        this.logger.warn('All eligible accounts were already attempted for this request');
        return null;
      }

      const selectedTokenEntry = await this.selectionPolicy.selectCandidate({
        allTokens: filteredAccountPool,
        sessionKey,
        model,
        now,
        accountCooldowns: this.accountCooldowns,
        rateLimitTracker: this.rateLimitTracker,
        config: this.configPolicy.getSelectionConfig(),
        logger: this.logger,
      });

      if (!selectedTokenEntry) {
        return null;
      }

      const [accountId, tokenData] = selectedTokenEntry;
      return this.finalizeSelectedToken(accountId, tokenData, nowSeconds, sessionKey);
    } catch (error) {
      this.logger.error('Failed to select the next account token', error);
      return null;
    }
  }

  private selectModelCapableAccounts(allTokens: TokenEntry[], model?: string): TokenEntry[] {
    if (!model) {
      return allTokens;
    }

    const available: TokenEntry[] = [];
    const unknown: TokenEntry[] = [];
    for (const entry of allTokens) {
      const availability = this.modelPolicy.getModelAvailabilityForAccount(entry[0], model);
      if (availability === 'available') {
        available.push(entry);
      } else if (availability === 'unknown') {
        unknown.push(entry);
      }
    }

    return available.length > 0 ? available : unknown;
  }

  public resetSelectionState(): void {
    this.selectionPolicy.resetSelectionState();
  }

  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    return this.fulfillmentPolicy.finalizeSelectedToken({
      accountId,
      tokenData,
      nowSeconds,
      sessionKey,
    });
  }

  private async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    await this.hydrationPolicy.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);
  }

  private async refreshSelectedTokenLocked(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    await this.hydrationPolicy.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds);
  }

  private async resolveProjectIdWithLock(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    return this.hydrationPolicy.resolveProjectIdWithLock(accountId, tokenData);
  }

  private async runAccountLock<T>(
    locks: Map<string, Promise<T>>,
    accountId: string,
    createPromise: () => Promise<T>,
  ): Promise<T> {
    return this.hydrationPolicy.runAccountLock(locks, accountId, createPromise);
  }

  private syncTokenDataFromCache(accountId: string, tokenData: TokenData): void {
    this.hydrationPolicy.syncTokenDataFromCache(accountId, tokenData);
  }

  private async resolveProjectIdLocked(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    return this.hydrationPolicy.resolveProjectIdLocked(accountId, tokenData);
  }

  private resolveAccountId(accountIdOrEmail: string): string | null {
    if (this.tokens.has(accountIdOrEmail)) {
      return accountIdOrEmail;
    }

    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (tokenData.email === accountIdOrEmail) {
        return accountId;
      }
    }

    return null;
  }

  private async persistTokenState(accountId: string, tokenData: TokenData) {
    await this.hydrationPolicy.persistTokenState(accountId, tokenData);
  }

  getAccountCount(): number {
    return this.tokens.size;
  }

  getModelCapableAccountCount(model?: string): number {
    return this.selectModelCapableAccounts(Array.from(this.tokens.entries()), model).length;
  }

  async getRefreshedModelCapableAccountCount(model?: string): Promise<number> {
    let count = this.getModelCapableAccountCount(model);
    if (model && count === 0) {
      await this.refreshQuotaCatalog({ force: true, model });
      count = this.getModelCapableAccountCount(model);
    }
    return count;
  }

  private normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return this.hydrationPolicy.normalizeRefreshedOauthClientKey(currentToken, refreshedClientKey);
  }

  getAllCollectedModels(): Set<string> {
    return this.modelPolicy.getAllCollectedModels();
  }

  async getRefreshedAllCollectedModels(): Promise<Set<string>> {
    await this.refreshQuotaCatalog();
    return this.getAllCollectedModels();
  }

  private getAvailableModelsFromToken(tokenData: TokenData): Set<string> {
    return this.modelPolicy.getAvailableModelsFromToken(tokenData);
  }

  private buildDynamicModelCandidates(modelName: string): string[] | null {
    return this.modelPolicy.buildDynamicModelCandidates(modelName);
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string): string {
    return this.modelPolicy.resolveDynamicModelForAccount(accountId, mappedModel);
  }

  markModelUnrequestable(modelId: string): void {
    this.modelPolicy.markModelUnrequestable(modelId);
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    return this.modelPolicy.getModelOutputLimitForAccount(accountId, modelName);
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    return this.modelPolicy.getModelThinkingBudgetForAccount(accountId, modelName);
  }

  private startQuotaCatalogRefreshTimer(): void {
    this.stopQuotaCatalogRefreshTimer();
    this.quotaCatalogRefreshTimer = setInterval(() => {
      void this.refreshQuotaCatalog({ force: true }).catch((error: unknown) => {
        this.logger.warn('Scheduled quota catalog refresh failed', error);
      });
    }, this.quotaCatalogRefreshIntervalMs);
    this.quotaCatalogRefreshTimer.unref?.();
  }

  private stopQuotaCatalogRefreshTimer(): void {
    if (!this.quotaCatalogRefreshTimer) {
      return;
    }
    clearInterval(this.quotaCatalogRefreshTimer);
    this.quotaCatalogRefreshTimer = undefined;
  }
}
