import type { AccountLeaseAccountStore, AccountLeaseUpstream } from './account-lease-adapters';
import type { CloudQuotaData } from '@/modules/cloud-account/types';
import {
  buildAccountLeaseQuotaSnapshot,
  findEarliestQuotaResetTime,
  type AccountLeaseQuotaSnapshot,
} from './account-lease-quota-policy';
import type { AccountLeaseTokenData } from './account-lease-token-types';
import { RateLimitReason } from './rate-limit-tracker';
import { updateDynamicForwardingRules } from '../antigravity/ModelMapping';

interface AccountLeaseQuotaRefreshLogger {
  log(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface AccountLeaseQuotaCatalogRefreshResult {
  refreshed: number;
  skipped: number;
  failed: number;
  account_ids: string[];
}

interface AccountLeaseQuotaRefreshPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  hydrateTokenIfNeeded: (
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ) => Promise<void>;
  hydrateTokenAfterAuthFailure: (
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ) => Promise<void>;
  setLockoutUntilIso: (
    accountId: string,
    resetTime: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  logger: AccountLeaseQuotaRefreshLogger;
}

const QUOTA_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const QUOTA_REFRESH_FAILURE_COOLDOWN_MS = 60 * 1000;
const QUOTA_REFRESH_FORCE_COOLDOWN_MS = 60 * 1000;
const QUOTA_REFRESH_CONCURRENCY = 2;

export class AccountLeaseQuotaRefreshPolicy {
  private readonly accountRefreshLocks = new Map<string, Promise<boolean | null>>();
  private catalogRefreshLock?: Promise<AccountLeaseQuotaCatalogRefreshResult>;
  private readonly accountFailureCooldownUntil = new Map<string, number>();
  private forceRefreshCooldownUntil = 0;
  private lastCatalogRefreshMs = 0;
  private generation = 0;

  constructor(private readonly options: AccountLeaseQuotaRefreshPolicyOptions) {}

  applyModelForwardingRules(snapshot: AccountLeaseQuotaSnapshot): void {
    for (const [oldModel, newModel] of Object.entries(snapshot.modelForwardingRules)) {
      updateDynamicForwardingRules(oldModel, newModel);
    }
  }

  invalidateActiveRefreshes(): void {
    this.generation += 1;
    this.lastCatalogRefreshMs = 0;
    this.forceRefreshCooldownUntil = 0;
  }

  async shutdown(): Promise<void> {
    this.invalidateActiveRefreshes();
    const pending = [
      ...(this.catalogRefreshLock ? [this.catalogRefreshLock] : []),
      ...this.accountRefreshLocks.values(),
    ];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  setPreciseLockoutFromCachedQuota(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return false;
    }

    const resetTime = findEarliestQuotaResetTime(tokenData.model_reset_times);
    if (!resetTime) {
      return false;
    }

    return this.options.setLockoutUntilIso(accountId, resetTime, reason, model);
  }

  async refreshQuotaCatalog(options: {
    force?: boolean;
    model?: string;
    nowMs?: number;
  } = {}): Promise<AccountLeaseQuotaCatalogRefreshResult> {
    const nowMs = options.nowMs ?? Date.now();
    const force = options.force ?? false;
    if (this.catalogRefreshLock) {
      return this.catalogRefreshLock;
    }

    if (!force && nowMs - this.lastCatalogRefreshMs < QUOTA_REFRESH_INTERVAL_MS) {
      return {
        refreshed: 0,
        skipped: this.options.getTokenCache().size,
        failed: 0,
        account_ids: [],
      };
    }
    if (force && this.forceRefreshCooldownUntil > nowMs) {
      return {
        refreshed: 0,
        skipped: this.options.getTokenCache().size,
        failed: 0,
        account_ids: [],
      };
    }

    const refresh = this.refreshQuotaCatalogLocked({
      force,
      nowMs,
      generation: this.generation,
    });
    this.catalogRefreshLock = refresh;
    try {
      return await refresh;
    } finally {
      if (this.catalogRefreshLock === refresh) {
        this.catalogRefreshLock = undefined;
      }
    }
  }

  private async refreshQuotaCatalogLocked(options: {
    force: boolean;
    nowMs: number;
    generation: number;
  }): Promise<AccountLeaseQuotaCatalogRefreshResult> {
    const accountIds = Array.from(this.options.getTokenCache().keys());
    const result: AccountLeaseQuotaCatalogRefreshResult = {
      refreshed: 0,
      skipped: 0,
      failed: 0,
      account_ids: [],
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const accountId = accountIds[cursor];
        cursor += 1;
        if (!accountId) {
          return;
        }

        const refreshed = await this.refreshAccountQuota(accountId, options);
        if (refreshed === true) {
          result.refreshed += 1;
          result.account_ids.push(accountId);
        } else if (refreshed === false) {
          result.failed += 1;
        } else {
          result.skipped += 1;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(QUOTA_REFRESH_CONCURRENCY, accountIds.length) }, () =>
        worker(),
      ),
    );

    const completedAtMs = Date.now();
    if (result.refreshed > 0 || accountIds.length === 0) {
      this.lastCatalogRefreshMs = completedAtMs;
    }
    if (options.force) {
      this.forceRefreshCooldownUntil = completedAtMs + QUOTA_REFRESH_FORCE_COOLDOWN_MS;
    }

    this.options.logger.log(
      `Quota catalog refresh finished: refreshed=${result.refreshed} skipped=${result.skipped} failed=${result.failed}`,
    );
    return result;
  }

  private async refreshAccountQuota(
    accountId: string,
    options: { force: boolean; nowMs: number; generation: number },
  ): Promise<boolean | null> {
    const existingLock = this.accountRefreshLocks.get(accountId);
    if (existingLock) {
      return existingLock;
    }

    const cooldownUntil = this.accountFailureCooldownUntil.get(accountId) ?? 0;
    if (cooldownUntil > options.nowMs) {
      return Promise.resolve(null);
    }

    const refresh = this.refreshAccountQuotaLocked(accountId, options.nowMs, options.generation);
    this.accountRefreshLocks.set(accountId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.accountRefreshLocks.get(accountId) === refresh) {
        this.accountRefreshLocks.delete(accountId);
      }
    }
  }

  private async refreshAccountQuotaLocked(
    accountId: string,
    nowMs: number,
    generation: number,
  ): Promise<boolean | null> {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return false;
    }

    try {
      await this.options.hydrateTokenIfNeeded(accountId, tokenData, Math.floor(nowMs / 1000));
      const latestToken = this.options.getTokenCache().get(accountId) ?? tokenData;
      const latestQuota = await this.options.upstream.fetchQuota(
        latestToken.access_token,
        latestToken.upstream_proxy_url,
      );
      if (!this.canApplyQuotaRefresh(accountId, latestToken, generation)) {
        return null;
      }
      await this.applyQuotaRefresh(accountId, latestToken, latestQuota, generation);
      this.accountFailureCooldownUntil.delete(accountId);
      return true;
    } catch (error) {
      if (isQuotaAuthError(error)) {
        try {
          await this.options.hydrateTokenAfterAuthFailure(
            accountId,
            tokenData,
            Math.floor(nowMs / 1000),
          );
          const latestToken = this.options.getTokenCache().get(accountId) ?? tokenData;
          const latestQuota = await this.options.upstream.fetchQuota(
            latestToken.access_token,
            latestToken.upstream_proxy_url,
          );
          if (!this.canApplyQuotaRefresh(accountId, latestToken, generation)) {
            return null;
          }
          await this.applyQuotaRefresh(accountId, latestToken, latestQuota, generation);
          this.accountFailureCooldownUntil.delete(accountId);
          return true;
        } catch (retryError) {
          this.accountFailureCooldownUntil.set(
            accountId,
            nowMs + QUOTA_REFRESH_FAILURE_COOLDOWN_MS,
          );
          this.options.logger.warn(
            `Failed to refresh quota catalog for account ${accountId} after token refresh`,
            retryError,
          );
          return false;
        }
      }
      this.accountFailureCooldownUntil.set(accountId, nowMs + QUOTA_REFRESH_FAILURE_COOLDOWN_MS);
      this.options.logger.warn(`Failed to refresh quota catalog for account ${accountId}`, error);
      return false;
    }
  }

  private async applyQuotaRefresh(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    latestQuota: CloudQuotaData,
    generation: number,
  ): Promise<void> {
    const extractedState = buildAccountLeaseQuotaSnapshot(latestQuota);

    await this.options.accountStore.updateQuota(accountId, latestQuota);
    if (!this.canApplyQuotaRefresh(accountId, tokenData, generation)) {
      return;
    }

    tokenData.quota = latestQuota;
    tokenData.model_quotas = extractedState.modelQuotas;
    tokenData.model_limits = extractedState.modelLimits;
    tokenData.model_reset_times = extractedState.modelResetTimes;
    tokenData.model_forwarding_rules = extractedState.modelForwardingRules;
    this.applyModelForwardingRules(extractedState);
    this.options.getTokenCache().set(accountId, tokenData);
  }

  private canApplyQuotaRefresh(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    generation: number,
  ): boolean {
    return this.generation === generation && this.options.getTokenCache().get(accountId) === tokenData;
  }

  async refreshRealtimeQuotaAndSetPreciseLockout(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): Promise<boolean> {
    const refreshed = await this.refreshAccountQuota(accountId, {
      force: true,
      nowMs: Date.now(),
      generation: this.generation,
    });
    if (!refreshed) {
      return false;
    }

    return this.setPreciseLockoutFromCachedQuota(accountId, reason, model);
  }
}

function isQuotaAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'UNAUTHORIZED' || message.includes('HTTP 401');
}
