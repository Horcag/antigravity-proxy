import { AccountLeaseSuspensionPolicy, type SuspensionReview } from './account-lease-suspension-policy';
import { runReleaseBackground } from '../../../server/release-admission';
import { randomInt } from 'node:crypto';
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
import {
  AccountLeaseQuotaRefreshPolicy,
  QUOTA_REFRESH_INTERVAL_MS,
} from './account-lease-quota-refresh-policy';
import type { AccountLeaseQuotaCatalogRefreshResult } from './account-lease-quota-refresh-policy';
import { AccountLeaseTokenCache } from './account-lease-token-cache';
import { AccountLeaseHydrationPolicy } from './account-lease-hydration-policy';
import { AccountLeaseFulfillmentPolicy } from './account-lease-fulfillment-policy';
import { ProductionOwnerGate } from '@/modules/cloud-account/persistence/production-owner-gate';
import {
  AccountLeaseSelectionPolicy,
  type SessionBindingEntry,
  type MigrationCapability,
  isVerifiedSessionKey,
  isHintSessionKey,
} from './account-lease-selection-policy';
export type { MigrationCapability };
export { isVerifiedSessionKey, isHintSessionKey };
import { AccountLeaseModelPolicy } from './account-lease-model-policy';
import { normalizeModelId, type AccountLeaseTokenData, type QuotaDiagnostics, type QuotaDiagnosticsTemporaryBlock } from './account-lease-token-types';
export type { QuotaDiagnostics, QuotaDiagnosticsTemporaryBlock, AccountQuotaDiagnostics, AccountQuotaDiagnosticsModel } from './account-lease-token-types';
import { resolveAccountPoolCapacityFailure } from './account-pool-capacity';
import {
  AccountLeaseLimitPolicy,
  type AccountLeaseUpstreamErrorParams,
} from './account-lease-limit-policy';
import { AccountLeaseConfigPolicy } from './account-lease-config-policy';
import { proxyModelAvailabilityStore } from './proxy-model-availability-store';
import { AccountPerformancePolicy } from './account-performance-policy';
import { CaManager } from './cert/ca-manager';
import { waitForAdmissionSlot } from './admission-wait';
import {
  authorizesMigration,
  CacheAffinityCoordinator,
  confirmOrBindAffinitySession,
  type AffinityCommitResult,
  type AffinityPlacementOutcome,
  type MigrationAuthorization,
} from './cache-affinity-coordinator';
import { authorizeBoundSessionMigration, selectUnadvertisedFallbackCandidates } from './bound-session-migration-authorization';
export interface AttemptLease {
  account: CloudAccount;
  sessionKey?: string;
  generation: number;
  tableIncarnation: number;
  breakerGeneration: number;
  releaseReservation: () => void;
  completeAffinityPlacement?: (outcome: AffinityPlacementOutcome) => void;
  affinityAbortSignal?: AbortSignal;
  readonly isReleased: boolean;
}
export type { AffinityCommitResult } from './cache-affinity-coordinator';
export class Mutex {
  private queue = Promise.resolve();
  acquire(): Promise<() => void> {
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = this.queue;
    this.queue = current.then(() => next);
    return current.then(() => release);
  }
}
export interface GetNextTokenOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
  deferSessionBinding?: boolean;
  migrationAuthorization?: MigrationAuthorization;
  signal?: AbortSignal;
  requestId?: string;
  /** Internal re-entry after a placement owner has settled. */
  skipAffinityCoordination?: boolean;
  affinityOwnerTimeoutMs?: number; allowUnadvertisedModelFallback?: boolean;
}
type TokenData = AccountLeaseTokenData;
type TokenEntry = [string, TokenData];
function quotaDiagnosticSwapIndex(maxExclusive: number, random?: () => number): number {
  if (random) {
    try {
      const sample = random();
      if (Number.isFinite(sample) && sample >= 0 && sample < 1) {
        return Math.floor(sample * maxExclusive);
      }
    } catch { return randomInt(maxExclusive); }
  }
  return randomInt(maxExclusive);
}
export function shuffleForQuotaDiagnostics<T>(entries: readonly T[], random?: () => number): T[] {
  const shuffled = [...entries];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = quotaDiagnosticSwapIndex(index + 1, random);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}
interface TemporaryBlockSource {
  reason: string;
  unavailableUntil: number;
  remainingSeconds: number;
}
@Injectable()
export class AccountLeaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountLeaseService.name);
  private readonly stickySessionTtlMs = 60 * 60 * 1000;
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;
  private readonly quotaCatalogRefreshIntervalMs = QUOTA_REFRESH_INTERVAL_MS;
  private tokens: Map<string, TokenData> = new Map();
  private quotaCatalogRefreshTimer?: NodeJS.Timeout;
  private readonly configPolicy = new AccountLeaseConfigPolicy();
  private readonly quotaRefreshPolicy: AccountLeaseQuotaRefreshPolicy;
  private readonly tokenCache: AccountLeaseTokenCache;
  private readonly selectionPolicy = new AccountLeaseSelectionPolicy();
  private readonly selectionMutex = new Mutex();
  private readonly affinityCoordinator = new CacheAffinityCoordinator({ ownerTimeoutMs: 125_000 });
  private readonly hydrationPolicy: AccountLeaseHydrationPolicy;
  private readonly fulfillmentPolicy: AccountLeaseFulfillmentPolicy;
  private readonly modelPolicy: AccountLeaseModelPolicy;
  private readonly limitPolicy: AccountLeaseLimitPolicy;
  private readonly activeReservations = new Map<string, string>();
  private readonly accountReservations = new Map<string, Set<string>>();
  private readonly accountBreakerGenerations = new Map<string, number>();
  private readonly performancePolicy = new AccountPerformancePolicy();
  private readonly suspensionPolicy: AccountLeaseSuspensionPolicy;
  constructor(
    @Optional()
    @Inject(ACCOUNT_LEASE_ACCOUNT_STORE)
    private readonly accountStore: AccountLeaseAccountStore = cloudAccountStoreAdapter,
    @Optional()
    @Inject(ACCOUNT_LEASE_UPSTREAM)
    private readonly upstream: AccountLeaseUpstream = googleAccountLeaseUpstreamAdapter,
  ) {
    this.quotaRefreshPolicy = new AccountLeaseQuotaRefreshPolicy({
      suspendAccount: (accountId) => this.suspensionPolicy.suspend(accountId),
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
    this.suspensionPolicy = new AccountLeaseSuspensionPolicy({
      accountStore: this.accountStore, tokenCache: this.tokenCache, refreshPolicy: this.quotaRefreshPolicy,
      getTokens: () => this.tokens, setTokens: (tokens) => { this.tokens = tokens; },
      onCacheChange: () => {
        this.selectionPolicy.clearSessionBindingsForUnavailableAccounts(new Set(this.tokens.keys()));
        this.performancePolicy.resetAccounts(new Set(this.tokens.keys()));
      },
    });
  }
  private get accountCooldowns(): Map<string, number> {
    return this.limitPolicy.getAccountCooldowns();
  }
  private get rateLimitTracker(): RateLimitTracker {
    return this.limitPolicy.getRateLimitTracker();
  }
  private get shadowComparisonCount(): number { return this.selectionPolicy.getShadowComparisonCount(); }
  private get noGoBlocked(): boolean { return this.selectionPolicy.isNoGoBlocked(); }
  async onModuleInit() {
    await ProductionOwnerGate.acquireExclusiveOwnership();
    await this.loadAccounts();
    void runReleaseBackground(() => this.refreshQuotaCatalog({ force: true })).catch((err) => this.logger.warn('Startup quota refresh failed', err));
    this.startQuotaCatalogRefreshTimer();
  }
  async onModuleDestroy() {
    this.stopQuotaCatalogRefreshTimer();
    await this.quotaRefreshPolicy.shutdown();
    await ProductionOwnerGate.releaseExclusiveOwnership();
  }
  loadAccounts(): Promise<number> { return this.suspensionPolicy.loadAccounts(); }
  waitForAccountSuspension(accountId: string): Promise<SuspensionReview> { return this.suspensionPolicy.waitForPending(accountId); }
  isAccountSuspensionFenced(accountId: string): boolean { return this.suspensionPolicy.isFenced(accountId); }
  clearAccountSuspensionAfterReview(accountId: string, revision: SuspensionReview): void { this.suspensionPolicy.clearAfterReview(accountId, revision); }
  async reloadAllAccounts(): Promise<number> {
    const previousIds = new Set(this.tokens.keys());
    const count = await this.loadAccounts();
    for (const id of this.tokens.keys()) { if (!previousIds.has(id)) this.limitPolicy.clearAccountLimits(id); }
    for (const id of previousIds) { if (!this.tokens.has(id)) this.limitPolicy.clearAccountLimits(id); }
    return count;
  }
  refreshQuotaCatalog(options: { force?: boolean; model?: string } = {}): Promise<AccountLeaseQuotaCatalogRefreshResult> {
    return this.quotaRefreshPolicy.refreshQuotaCatalog(options);
  }
  getPoolCapacityFailure(model: string, now = Date.now()) {
    const blocks = [...proxyModelAvailabilityStore.peekSnapshot(now),
      ...this.rateLimitTracker.peekActiveLockouts(now), ...this.limitPolicy.peekActiveAccountCooldowns(now)];
    return resolveAccountPoolCapacityFailure([...this.tokens.entries()]
      .filter(([, token]) => token.status !== 'expired')
      .map(([accountId]) => {
        const requestable = this.modelPolicy.isModelRequestableForAccount(accountId, model, { now, readOnly: true });
        const effectiveModel = this.modelPolicy.resolveDynamicModelForAccount(accountId, model, false, !requestable);
        return {
          availability: this.modelPolicy.getModelAvailabilityForAccount(accountId, model, { now, readOnly: true }),
          blocks: blocks.filter((block) => block.accountId === accountId &&
            (!('modelId' in block) || !block.modelId || block.modelId === effectiveModel || (!requestable && block.modelId === model)))
            .map((block) => ({ ...block, reason: block.reason === 'rate_limit_exceeded' ? 'rate_limited' : block.reason })),
        };
      }), now);
  }
  getQuotaDiagnostics(now = Date.now()): QuotaDiagnostics {
    const availabilityEntries = proxyModelAvailabilityStore.peekSnapshot(now);
    const availabilityByAccountModel = new Map(
      availabilityEntries
        .map(
          (entry) =>
            [
              `${entry.accountId}:${entry.modelId}`,
              {
                reason: entry.reason,
                unavailableUntil: entry.unavailableUntil,
                remainingSeconds: Math.max(0, Math.ceil((entry.unavailableUntil - now) / 1000)),
              },
            ] as const,
        ),
    );
    const lockouts = this.rateLimitTracker.peekActiveLockouts(now);
    const modelLockouts = new Map(
      lockouts
        .filter((entry) => entry.modelId)
        .map((entry) => [`${entry.accountId}:${entry.modelId}`, entry] as const),
    );
    const accountCooldowns = new Map(
      this.limitPolicy
        .peekActiveAccountCooldowns(now)
        .map((entry) => [entry.accountId, entry] as const),
    );
    const accountLockouts = new Map(
      lockouts
        .filter((entry) => !entry.modelId)
        .map((entry) => [entry.accountId, entry] as const),
    );
    return {
      refresh_interval_seconds: Math.floor(QUOTA_REFRESH_INTERVAL_MS / 1000),
      accounts: shuffleForQuotaDiagnostics([...this.tokens.entries()]).map(
        ([accountId, tokenData], accountIndex) => {
        const refreshedAt = tokenData.last_successful_quota_refresh_at;
        const refreshAgeMs =
          typeof refreshedAt === 'number' && Number.isFinite(refreshedAt)
            ? Math.max(0, now - refreshedAt)
            : null;
        const accountCooldownSource = this.selectTemporaryBlock(
          accountCooldowns.get(accountId),
          accountLockouts.get(accountId),
        );
        const accountCooldown = this.toTemporaryBlock(accountCooldownSource);
        const models = new Map<string, { publicModelId: string; physicalModelId: string }>();
        const addModel = (publicModelId: string, physicalModelId: string): void => {
          const publicId = normalizeModelId(publicModelId)?.toLowerCase();
          const physicalId = normalizeModelId(physicalModelId)?.toLowerCase();
          if (!publicId || !physicalId) {
            return;
          }
          models.set(`${publicId}:${physicalId}`, {
            publicModelId: publicId,
            physicalModelId: physicalId,
          });
        };
        for (const physicalModelId of Object.keys(tokenData.model_quotas)) {
          addModel(physicalModelId, physicalModelId);
        }
        for (const [publicModelId, physicalModelId] of Object.entries(
          tokenData.model_forwarding_rules,
        )) {
          addModel(publicModelId, physicalModelId);
        }
        for (const entry of availabilityEntries) {
          if (entry.accountId === accountId) {
            addModel(entry.modelId, entry.modelId);
          }
        }
        for (const entry of lockouts) {
          if (entry.accountId === accountId && entry.modelId) {
            addModel(entry.modelId, entry.modelId);
          }
        }
        return {
          account_label: `account-${accountIndex + 1}`,
          status: tokenData.status === 'rate_limited' ? 'rate_limited' : 'active',
          last_successful_refresh_at:
            refreshAgeMs === null ? null : new Date(refreshedAt as number).toISOString(),
          refresh_age_seconds: refreshAgeMs === null ? null : Math.floor(refreshAgeMs / 1000),
          refresh_state:
            refreshAgeMs === null
              ? 'unknown'
              : refreshAgeMs >= QUOTA_REFRESH_INTERVAL_MS
                ? 'stale'
                : 'fresh',
          ...(accountCooldown ? { account_cooldown: accountCooldown } : {}),
          models: [...models.values()]
            .map(({ publicModelId, physicalModelId }) => {
              const availabilityBlock = this.selectTemporaryBlock(
                availabilityByAccountModel.get(`${accountId}:${publicModelId}`),
                availabilityByAccountModel.get(`${accountId}:${physicalModelId}`),
              );
              const rateLimitBlock = this.selectTemporaryBlock(
                modelLockouts.get(`${accountId}:${publicModelId}`),
                modelLockouts.get(`${accountId}:${physicalModelId}`),
              );
              const temporaryBlock = this.toTemporaryBlock(
                this.selectTemporaryBlock(availabilityBlock, rateLimitBlock),
              );
              const baseAvailability = this.modelPolicy.getModelAvailabilityForAccount(
                accountId,
                publicModelId,
                { now, readOnly: true },
              );
              const availability = availabilityBlock ? 'unavailable' : baseAvailability;
              return {
                public_model_id: publicModelId,
                physical_model_id: physicalModelId,
                remaining_percentage:
                  tokenData.model_quotas[physicalModelId] ??
                  tokenData.model_quotas[publicModelId] ??
                  null,
                reset_time:
                  tokenData.model_reset_times[physicalModelId] ??
                  tokenData.model_reset_times[publicModelId] ??
                  null,
                availability,
                requestable:
                  !accountCooldownSource &&
                  !rateLimitBlock &&
                  !availabilityBlock &&
                  this.modelPolicy.isModelRequestableForAccount(accountId, publicModelId, {
                    now,
                    readOnly: true,
                  }),
                ...(temporaryBlock ? { temporary_block: temporaryBlock } : {}),
              };
            })
            .sort((left, right) => left.public_model_id.localeCompare(right.public_model_id)),
        };
        },
      ),
    };
  }
  private selectTemporaryBlock(
    ...entries: Array<TemporaryBlockSource | undefined>
  ): TemporaryBlockSource | undefined {
    return entries
      .filter((candidate): candidate is TemporaryBlockSource => Boolean(candidate))
      .sort((left, right) => right.unavailableUntil - left.unavailableUntil)[0];
  }
  private toTemporaryBlock(
    entry: TemporaryBlockSource | undefined,
  ): QuotaDiagnosticsTemporaryBlock | undefined {
    return entry
      ? {
          reason: entry.reason,
          unavailable_until: new Date(entry.unavailableUntil).toISOString(),
          remaining_seconds: entry.remainingSeconds,
        }
      : undefined;
  }
  clearAllSessions(): void {
    this.selectionPolicy.clearSessions();
  }
  clearAllRateLimits(): void {
    this.limitPolicy.clearAllRateLimits();
  }
  clearAllWorkReservationsForTesting(): void {
    this.activeReservations.clear();
    this.accountReservations.clear();
  }
  recordParityError(): void {
    this.selectionPolicy.recordParityError(this.configPolicy.getSelectionConfig(), this.logger);
  }
  setPreferredAccount(accountId?: string): void { this.configPolicy.setPreferredAccount(accountId); }
  isRateLimited(accountIdOrEmail: string, model?: string): boolean { return this.limitPolicy.isRateLimited(accountIdOrEmail, model); }
  markAsRateLimited(accountIdOrEmail: string) { this.limitPolicy.markAsRateLimited(accountIdOrEmail); }
  markAsForbidden(accountIdOrEmail: string, reason?: string) {
    this.limitPolicy.markAsForbidden(accountIdOrEmail);
    if (reason === 'tos_violation') {
      const id = this.resolveAccountId(accountIdOrEmail);
      if (id) void this.suspensionPolicy.suspend(id).catch(() => this.logger.error('Account suspension persistence failed; account remains fenced'));
    }
  }
  public getBreakerGeneration(accountId: string): number {
    return this.accountBreakerGenerations.get(accountId) ?? 0;
  }
  public incrementBreakerGeneration(accountId: string): number {
    const next = (this.accountBreakerGenerations.get(accountId) ?? 0) + 1;
    this.accountBreakerGenerations.set(accountId, next);
    return next;
  }
  markModelSuccess(accountIdOrEmail: string, model: string, expectedBreakerGeneration?: number): void {
    const resolvedId = this.resolveAccountId(accountIdOrEmail);
    if (resolvedId && expectedBreakerGeneration !== undefined) {
      const currentGen = this.getBreakerGeneration(resolvedId);
      if (expectedBreakerGeneration < currentGen) {
        return;
      }
    }
    this.limitPolicy.markModelSuccess(accountIdOrEmail, model);
  }
  recordPerformanceSuccess(accountId: string, effectiveModel: string, ttftMs?: number): void {
    this.performancePolicy.recordSuccess(accountId, effectiveModel, ttftMs);
  }
  recordPerformanceFailure(accountId: string, effectiveModel: string): void {
    this.performancePolicy.recordFailure(accountId, effectiveModel);
  }
  async markFromUpstreamError(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    const resolvedId = this.resolveAccountId(params.accountIdOrEmail);
    if (resolvedId) {
      this.incrementBreakerGeneration(resolvedId);
    }
    await this.limitPolicy.markFromUpstreamError(params);
  }
  async acquireAttemptLease(options?: GetNextTokenOptions): Promise<AttemptLease | null> {
    let completeAffinityPlacement: ((outcome: AffinityPlacementOutcome) => void) | undefined, affinityAbortSignal: AbortSignal | undefined;
    const abortAffinityPlacement = () => { completeAffinityPlacement?.('aborted'); completeAffinityPlacement = undefined; };
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
      const stickyForWait = sessionKey ? this.getSessionBinding(sessionKey) : null;
      const needsPlacementCoordination = Boolean(
        sessionKey && isVerifiedSessionKey(sessionKey) && !options?.skipAffinityCoordination &&
        (!stickyForWait || stickyForWait.state === 'migrating' || options?.migrationAuthorization),
      );
      if (needsPlacementCoordination) {
        const placement = await this.affinityCoordinator.acquire(sessionKey, { signal: options?.signal, ownerTimeoutMs: options?.affinityOwnerTimeoutMs });
        if (placement.kind === 'rejected') {
          if (options?.signal?.aborted) return null;
        } else if (placement.kind === 'follower') {
          return placement.outcome === 'committed'
            ? this.acquireAttemptLease({ ...options, excludeAccountIds: undefined, migrationAuthorization: undefined, skipAffinityCoordination: true })
            : this.acquireAttemptLease(options);
        } else {
          completeAffinityPlacement = placement.complete;
          affinityAbortSignal = placement.signal;
        }
      }
      if (stickyForWait && !excludedAccountIds.has(stickyForWait.accountId)) {
        const effectiveModel = model ? this.modelPolicy.resolveDynamicModelForAccount(stickyForWait.accountId, model, false) : undefined;
        const waitMs = this.rateLimitTracker.getRemainingWaitSeconds(stickyForWait.accountId, effectiveModel) * 1000;
        const maxWaitMs = this.configPolicy.getSelectionConfig().maxWaitMs;
        if (waitMs > 0 && waitMs <= maxWaitMs) {
          await waitForAdmissionSlot(waitMs, options?.signal);
          if (options?.signal?.aborted) { abortAffinityPlacement(); return null; }
        }
      }
      let candidateAccountPool = await this.buildCurrentCandidatePool(model, excludedAccountIds, Boolean(options?.allowUnadvertisedModelFallback));
      const isStickyAvailable = stickyForWait && candidateAccountPool.some(([id]) => id === stickyForWait.accountId);
      const isMigratingTargetAvailable = stickyForWait?.state === 'migrating' && stickyForWait.migratingToAccountId && candidateAccountPool.some(([id]) => id === stickyForWait.migratingToAccountId);
      const migrationAuthorized = authorizesMigration(options?.migrationAuthorization, sessionKey, stickyForWait, options?.requestId);
      if (stickyForWait && options?.deferSessionBinding && !migrationAuthorized) {
        const targetId = isMigratingTargetAvailable ? stickyForWait.migratingToAccountId : isStickyAvailable ? stickyForWait.accountId : undefined;
        if (targetId) candidateAccountPool = candidateAccountPool.filter(([accountId]) => accountId === targetId);
      }
      if (candidateAccountPool.length === 0) { abortAffinityPlacement(); return null; }
      if (options?.signal?.aborted || affinityAbortSignal?.aborted) { abortAffinityPlacement(); return null; }
      const stickyBinding = sessionKey ? this.getSessionBinding(sessionKey) : null;
      if (stickyBinding && !excludedAccountIds.has(stickyBinding.accountId) && candidateAccountPool.some(([accountId]) => accountId === stickyBinding.accountId)) {
        const maxWaitMs = this.configPolicy.getSelectionConfig().maxWaitMs;
        const maxConcurrency = this.configPolicy.getSelectionConfig().maxConcurrencyPerAccount ?? 8;
        const deadline = Date.now() + maxWaitMs;
        while (this.getInFlightWork(stickyBinding.accountId) >= maxConcurrency) {
          if (options?.signal?.aborted || Date.now() >= deadline) { abortAffinityPlacement(); return null; }
          await waitForAdmissionSlot(Math.min(25, Math.max(1, deadline - Date.now())), options?.signal);
          if (options?.signal?.aborted) { abortAffinityPlacement(); return null; }
          candidateAccountPool = await this.buildCurrentCandidatePool(model, excludedAccountIds, Boolean(options?.allowUnadvertisedModelFallback));
          if (!candidateAccountPool.some(([accountId]) => accountId === stickyBinding.accountId)) break;
        }
      }
      let accountId: string, tokenData: TokenData, releaseReservation: () => void, breakerGeneration = 0, generation = 1, admissionTableIncarnation = 1, selectedTokenEntry: TokenEntry | null = null;
      const releaseMutex = await this.selectionMutex.acquire();
      try {
        const currentNow = Date.now();
        const currentBinding = sessionKey ? this.getSessionBinding(sessionKey) : null;
        const currentMigrationAuthorized = authorizesMigration(options?.migrationAuthorization, sessionKey, currentBinding, options?.requestId);
        if (options?.migrationAuthorization && !currentMigrationAuthorized) { abortAffinityPlacement(); return null; }
        const isCurrentStickyAvailable = currentBinding && candidateAccountPool.some(([id]) => id === currentBinding.accountId);
        const isCurrentMigratingAvailable = currentBinding?.state === 'migrating' && currentBinding.migratingToAccountId && candidateAccountPool.some(([id]) => id === currentBinding.migratingToAccountId);
        const effectiveStickyId = (currentBinding?.state === 'migrating' && isCurrentMigratingAvailable) ? currentBinding.migratingToAccountId : (isCurrentStickyAvailable ? currentBinding?.accountId : undefined);
        if (currentBinding && options?.deferSessionBinding && !currentMigrationAuthorized) {
          const freshCandidates = await this.buildCurrentCandidatePool(model, excludedAccountIds, Boolean(options?.allowUnadvertisedModelFallback));
          candidateAccountPool = effectiveStickyId && freshCandidates.some(([id]) => id === effectiveStickyId) ? freshCandidates.filter(([accountId]) => accountId === effectiveStickyId) : freshCandidates;
        }
        const boundCandidate = effectiveStickyId && !currentMigrationAuthorized && !(
          (this.accountCooldowns.get(effectiveStickyId) ?? 0) > currentNow ||
          this.rateLimitTracker.isRateLimited(effectiveStickyId, model ? this.modelPolicy.resolveDynamicModelForAccount(effectiveStickyId, model, false) : undefined)
        ) ? candidateAccountPool.find(([accountId]) => accountId === effectiveStickyId) : undefined;
        if (boundCandidate) {
          if (this.getInFlightWork(effectiveStickyId!) >= (this.configPolicy.getSelectionConfig().maxConcurrencyPerAccount ?? 8)) {
            abortAffinityPlacement();
            return null;
          }
          candidateAccountPool = [boundCandidate];
        }
        selectedTokenEntry = await this.selectionPolicy.selectCandidate({
          allTokens: candidateAccountPool,
          getCurrentCandidates: () => this.buildCurrentCandidatePool(model, excludedAccountIds, Boolean(options?.allowUnadvertisedModelFallback)),
          sessionKey,
          skipWait: true,
          model,
          getEffectiveModelForAccount: (id) =>
            model ? this.modelPolicy.resolveDynamicModelForAccount(id, model, false) : undefined,
          getPerformanceScore: (id, effectiveModel) =>
            this.performancePolicy.score({
              accountId: id,
              effectiveModel: effectiveModel ?? model ?? '',
              remainingQuotaPercent:
                this.tokens.get(id)?.model_quotas?.[effectiveModel ?? model ?? ''],
              remainingCooldownMs: Math.max(0, (this.accountCooldowns.get(id) ?? currentNow) - currentNow),
            }),
          getInFlightCount: (id) => this.getInFlightWork(id),
          now: currentNow,
          accountCooldowns: this.accountCooldowns,
          rateLimitTracker: this.rateLimitTracker,
          config: this.configPolicy.getSelectionConfig(),
          logger: this.logger,
        });
        if (!selectedTokenEntry) {
          abortAffinityPlacement();
          return null;
        }
        [accountId, tokenData] = selectedTokenEntry;
        releaseReservation = this.acquireWorkReservation(accountId);
        breakerGeneration = this.getBreakerGeneration(accountId);
        admissionTableIncarnation = this.selectionPolicy.getTableIncarnation();
        generation = sessionKey
          ? (this.getSessionBinding(sessionKey)?.generation ?? 1)
          : 1;
      } finally {
        releaseMutex();
      }
      let isReservationReleased = false;
      const releaseReservationOnce = () => {
        if (!isReservationReleased) {
          isReservationReleased = true;
          releaseReservation();
        }
      };
      if (options?.signal?.aborted) {
        releaseReservationOnce();
        abortAffinityPlacement();
        return null;
      }
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<null>((resolve) => {
        onAbort = () => {
          releaseReservationOnce();
          resolve(null);
        };
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        affinityAbortSignal?.addEventListener('abort', onAbort, { once: true });
      }); let finalized: CloudAccount | null = null;
      try {
        const hydrationPromise = this.finalizeSelectedToken(
          accountId,
          tokenData,
          nowSeconds,
          sessionKey,
          options?.deferSessionBinding,
        );
        hydrationPromise.catch(() => {});
        finalized = await Promise.race([hydrationPromise, abortPromise]);
        if (options?.signal?.aborted || !finalized) {
          releaseReservationOnce();
          abortAffinityPlacement();
          return null;
        }
        if (!finalized) {
          releaseReservationOnce();
          abortAffinityPlacement();
          return null;
        }
        if (this.selectionPolicy.getTableIncarnation() !== admissionTableIncarnation) {
          releaseReservationOnce();
          abortAffinityPlacement();
          this.logger.warn(
            `Table incarnation advanced from ${admissionTableIncarnation} to ${this.selectionPolicy.getTableIncarnation()} during hydration; reacquiring lease`,
          );
          return this.acquireAttemptLease(options);
        }
        const cooldownUntil = this.accountCooldowns.get(accountId);
        const effectiveModel = model
          ? this.modelPolicy.resolveDynamicModelForAccount(accountId, model, false)
          : undefined;
        const isCooldowned = cooldownUntil && cooldownUntil > Date.now();
        const isRateLimited = this.rateLimitTracker.isRateLimited(accountId, effectiveModel);
        if (isCooldowned || isRateLimited) {
          releaseReservationOnce();
          abortAffinityPlacement();
          this.logger.warn(
            `Account ${accountId} became unavailable during hydration; failing over to next candidate`,
          );
          return this.acquireAttemptLease({
            ...options,
            excludeAccountIds: [...(options?.excludeAccountIds ?? []), accountId],
          });
        }
      } catch (err) {
        releaseReservationOnce();
        abortAffinityPlacement();
        throw err;
      } finally {
        if (onAbort) {
          options?.signal?.removeEventListener('abort', onAbort);
          affinityAbortSignal?.removeEventListener('abort', onAbort);
        }
      }
      const idempotentRelease = () => {
        releaseReservationOnce();
      };
      finalized.releaseReservation = idempotentRelease;
      return {
        account: finalized,
        sessionKey,
        generation,
        tableIncarnation: admissionTableIncarnation,
        breakerGeneration,
        releaseReservation: idempotentRelease,
        completeAffinityPlacement: (outcome) => {
          completeAffinityPlacement?.(outcome);
          completeAffinityPlacement = undefined;
        },
        affinityAbortSignal,
        get isReleased() {
          return isReservationReleased;
        },
      };
    } catch (error) {
      abortAffinityPlacement();
      this.logger.error('Failed to acquire attempt lease', error);
      return null;
    }
  }
  async getNextToken(options?: GetNextTokenOptions): Promise<CloudAccount | null> {
    const defer = options?.deferSessionBinding ?? false;
    const lease = await this.acquireAttemptLease({
      ...options,
      deferSessionBinding: defer,
    });
    if (lease && options?.sessionKey && !defer) {
      const bound = this.bindSession(options.sessionKey, lease.account.id);
      lease.completeAffinityPlacement?.(bound ? 'committed' : 'aborted');
    }
    return lease ? lease.account : null;
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
  private async buildCurrentCandidatePool(model: string | undefined, excludedAccountIds: ReadonlySet<string>, allowUnadvertisedModelFallback = false): Promise<TokenEntry[]> {
    const activeTokens = () => Array.from(this.tokens.entries()).filter(([, token]) => token.status !== 'expired');
    let modelCapableAccountPool = this.selectModelCapableAccounts(activeTokens(), model);
    if (model && modelCapableAccountPool.length === 0) {
      await this.refreshQuotaCatalog({ force: true, model });
      modelCapableAccountPool = this.selectModelCapableAccounts(activeTokens(), model);
    }
    const useUnadvertised = Boolean(allowUnadvertisedModelFallback && model && modelCapableAccountPool.length === 0);
    const unadvertisedPool = useUnadvertised ? selectUnadvertisedFallbackCandidates(activeTokens(), model!, (id, m) => proxyModelAvailabilityStore.hasHardCapabilityFailure(id, m)) : modelCapableAccountPool;
    if (unadvertisedPool.length === 0) {
      this.logger.warn(`No account advertises requested model: ${model ?? 'unknown'}`);
      return [];
    }
    const requestableAccountPool = useUnadvertised
      ? unadvertisedPool.filter(([accountId]) => (this.accountCooldowns.get(accountId) ?? 0) <= Date.now() && !this.rateLimitTracker.isRateLimited(accountId, model) && proxyModelAvailabilityStore.isAvailable(accountId, model!))
      : this.selectModelCapableAccounts(activeTokens().filter(([accountId]) =>
        (this.accountCooldowns.get(accountId) ?? 0) <= Date.now() &&
        !this.rateLimitTracker.isRateLimited(accountId, model ? this.modelPolicy.resolveDynamicModelForAccount(accountId, model, false) : undefined) &&
        (!model || this.modelPolicy.isModelRequestableForAccount(accountId, model))), model);
    if (requestableAccountPool.length === 0) {
      this.logger.warn(`All compatible account/model pairs are temporarily unavailable: ${model ?? 'unknown'}`);
      return [];
    }
    const filteredAccountPool = requestableAccountPool.filter(([accountId]) => !excludedAccountIds.has(accountId));
    if (filteredAccountPool.length === 0 && excludedAccountIds.size > 0) this.logger.warn('All eligible accounts were already attempted for this request');
    return filteredAccountPool;
  }
  public resetSelectionState(): void {
    this.selectionPolicy.resetSelectionState();
  }
  public bindSession(
    sessionKey: string | undefined,
    accountId: string,
    ttlMs?: number,
    expectedGeneration?: number,
    expectedIncarnation?: number,
  ): boolean {
    if (!sessionKey || !accountId) {
      return false;
    }
    if (!isVerifiedSessionKey(sessionKey)) {
      if (isHintSessionKey(sessionKey)) {
        this.selectionPolicy.recordCacheHint(sessionKey, accountId, ttlMs);
      }
      return false;
    }
    const expiresAt = Date.now() + (ttlMs ?? this.stickySessionTtlMs);
    return this.selectionPolicy.bindSession(
      sessionKey,
      accountId,
      expiresAt,
      expectedGeneration,
      expectedIncarnation,
    );
  }
  public getSessionBinding(sessionKey: string | undefined): SessionBindingEntry | null {
    return this.selectionPolicy.getSessionBinding(sessionKey);
  }
  public recordCacheHint(hintKey: string, accountId: string, ttlMs?: number): void {
    this.selectionPolicy.recordCacheHint(hintKey, accountId, ttlMs ?? this.stickySessionTtlMs);
  }
  public startSessionMigration(
    sessionKey: string | undefined,
    currentGeneration: number,
    targetAccountId: string,
    ownerRequestId?: string,
    expectedIncarnation?: number,
  ): MigrationCapability | null {
    return this.selectionPolicy.startSessionMigration(
      sessionKey,
      currentGeneration,
      targetAccountId,
      ownerRequestId,
      expectedIncarnation,
    );
  }
  public confirmSessionMigration(
    sessionKey: string | undefined,
    expectedGeneration: number,
    targetAccountId: string,
    ownerRequestId?: string,
    ttlMs?: number,
    expectedIncarnation?: number,
  ): boolean {
    const expiresAt = Date.now() + (ttlMs ?? this.stickySessionTtlMs);
    return this.selectionPolicy.confirmSessionMigration(
      sessionKey,
      expectedGeneration,
      targetAccountId,
      ownerRequestId,
      expiresAt,
      expectedIncarnation,
    );
  }
  public failSessionMigrationCandidate(
    sessionKey: string | undefined,
    expectedGeneration: number,
    failedAccountId: string,
    ownerRequestId?: string,
    expectedIncarnation?: number,
  ): boolean {
    return this.selectionPolicy.failSessionMigrationCandidate(
      sessionKey,
      expectedGeneration,
      failedAccountId,
      ownerRequestId,
      expectedIncarnation,
    );
  }
  public abortSessionMigration(sessionKey: string | undefined, expectedGeneration: number, ownerRequestId?: string, expectedIncarnation?: number): boolean { return this.selectionPolicy.abortSessionMigration(sessionKey, expectedGeneration, ownerRequestId, expectedIncarnation); }
  public renewSessionMigration(sessionKey: string | undefined, expectedGeneration: number, ownerRequestId?: string, extensionMs?: number, expectedIncarnation?: number): boolean { return this.selectionPolicy.renewSessionMigration(sessionKey, expectedGeneration, ownerRequestId, extensionMs, expectedIncarnation); }
  public getTableIncarnation(): number {
    return this.selectionPolicy.getTableIncarnation();
  }
  public authorizeBoundSessionMigration(sessionKey: string | undefined, model: string | undefined, ownerRequestId: string | undefined, allowUnadvertisedModelFallback = false): MigrationAuthorization | undefined {
    return authorizeBoundSessionMigration(this.tokens, this.getSessionBinding(sessionKey), sessionKey, model, ownerRequestId,
      (accountId, requestedModel) => this.modelPolicy.isModelRequestableForAccount(accountId, requestedModel) || Boolean(allowUnadvertisedModelFallback && proxyModelAvailabilityStore.isAvailable(accountId, requestedModel) && this.selectModelCapableAccounts(Array.from(this.tokens.entries()).filter(([, t]) => t.status !== 'expired'), requestedModel).length === 0),
      (accountId) => (this.accountCooldowns.get(accountId) ?? 0) > Date.now() || this.rateLimitTracker.isRateLimited(accountId, model ? this.modelPolicy.resolveDynamicModelForAccount(accountId, model, false) : undefined));
  }
  public clearSessions(): void {
    this.selectionPolicy.clearSessions();
  }
  public confirmOrBindSession(
    sessionKey: string | undefined,
    accountId: string,
    expectedGeneration?: number,
    ownerRequestId?: string,
    ttlMs?: number,
    expectedIncarnation?: number,
  ): AffinityCommitResult {
    return confirmOrBindAffinitySession(
      this.selectionPolicy, sessionKey, accountId, Date.now() + (ttlMs ?? this.stickySessionTtlMs),
      expectedGeneration, ownerRequestId, expectedIncarnation,
    );
  }
  public acquireWorkReservation(accountId: string): () => void {
    const reservationId = crypto.randomUUID();
    this.activeReservations.set(reservationId, accountId);
    let set = this.accountReservations.get(accountId);
    if (!set) {
      set = new Set();
      this.accountReservations.set(accountId, set);
    }
    set.add(reservationId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeReservations.delete(reservationId);
      const accSet = this.accountReservations.get(accountId);
      if (accSet) {
        accSet.delete(reservationId);
        if (accSet.size === 0) {
          this.accountReservations.delete(accountId);
        }
      }
    };
  }
  public getInFlightWork(accountId: string): number {
    return this.accountReservations.get(accountId)?.size ?? 0;
  }
  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    sessionKey?: string,
    deferSessionBinding?: boolean,
  ): Promise<CloudAccount | null> {
    return this.fulfillmentPolicy.finalizeSelectedToken({
      accountId,
      tokenData,
      nowSeconds,
      sessionKey,
      deferSessionBinding,
    });
  }
  private async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<boolean> {
    return this.hydrationPolicy.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);
  }
  private async refreshSelectedTokenLocked(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<boolean> {
    return this.hydrationPolicy.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds);
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
  private async persistTokenState(accountId: string, tokenData: TokenData): Promise<boolean> {
    return this.hydrationPolicy.persistTokenState(accountId, tokenData);
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
  markModelUnrequestable(accountId: string, modelId: string): void {
    this.modelPolicy.markModelUnrequestable(accountId, modelId);
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
      void runReleaseBackground(async () => {
        try { CaManager.ensureAgyLauncher(); } catch { /* empty */ }
        return this.refreshQuotaCatalog({ force: true });
      }).catch((error: unknown) => {
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
