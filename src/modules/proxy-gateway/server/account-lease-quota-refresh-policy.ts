import type { AccountLeaseAccountStore, AccountLeaseUpstream } from './account-lease-adapters';
import type { CloudQuotaData } from '@/modules/cloud-account/types';
import { tryRecordQuotaSnapshot } from '@/observability/request-history';
import { isAICreditsAuthenticationError } from '@/modules/cloud-account/services/ai-credits-authentication-error';
import {
  buildAccountLeaseQuotaSnapshot,
  findEarliestQuotaResetTime,
} from './account-lease-quota-policy';
import type { AccountLeaseTokenData } from './account-lease-token-types';
import { RateLimitReason } from './rate-limit-tracker';
import { proxyModelAvailabilityStore } from './proxy-model-availability-store';

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
  ) => Promise<boolean>;
  hydrateTokenAfterAuthFailure: (
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ) => Promise<boolean>;
  setLockoutUntilIso: (
    accountId: string,
    resetTime: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  suspendAccount: (accountId: string) => Promise<void>;
  logger: AccountLeaseQuotaRefreshLogger;
}

export const QUOTA_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
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
  private snapshotReloadGeneration?: number;

  constructor(private readonly options: AccountLeaseQuotaRefreshPolicyOptions) {}

  invalidateActiveRefreshes(): void {
    this.generation += 1;
    this.lastCatalogRefreshMs = 0;
    this.forceRefreshCooldownUntil = 0;
  }

  beginSnapshotReload(): number {
    this.invalidateActiveRefreshes();
    this.snapshotReloadGeneration = this.generation;
    return this.generation;
  }

  canInstallSnapshot(generation: number): boolean {
    return this.snapshotReloadGeneration === generation && this.generation === generation;
  }

  finishSnapshotReload(generation: number): void {
    if (this.snapshotReloadGeneration === generation) {
      this.snapshotReloadGeneration = undefined;
    }
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

    const modelResetTime = model ? tokenData.model_reset_times[model] : undefined;
    const resetTime = modelResetTime || findEarliestQuotaResetTime(tokenData.model_reset_times);
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
    if (this.snapshotReloadGeneration !== undefined) {
      return {
        refreshed: 0,
        skipped: this.options.getTokenCache().size,
        failed: 0,
        account_ids: [],
      };
    }
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
    if (this.snapshotReloadGeneration !== undefined) {
      return null;
    }
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

    let currentToken = tokenData;
    try {
      const hydrated = await this.options.hydrateTokenIfNeeded(
        accountId,
        tokenData,
        Math.floor(nowMs / 1000),
      );
      if (!hydrated) {
        return null;
      }
      const latestToken = this.options.getTokenCache().get(accountId) ?? tokenData;
      currentToken = latestToken;
      const latestQuota = await this.options.upstream.fetchQuota(
        latestToken.access_token,
        latestToken.upstream_proxy_url,
      );
      if (!this.canApplyQuotaRefresh(accountId, latestToken, generation)) {
        return null;
      }
      if (!this.applyQuotaRefresh(accountId, latestToken, latestQuota, nowMs, generation)) {
        return null;
      }
      this.accountFailureCooldownUntil.delete(accountId);
      return true;
    } catch (error) {
      const suspended = await this.suspendAfterQuotaFailure(error, accountId, currentToken, generation);
      if (suspended !== undefined) return suspended;
      if (isQuotaAuthError(error)) {
        try {
          const refreshedAfterAuthFailure = await this.options.hydrateTokenAfterAuthFailure(
            accountId,
            tokenData,
            Math.floor(nowMs / 1000),
          );
          if (!refreshedAfterAuthFailure) {
            return null;
          }
          const latestToken = this.options.getTokenCache().get(accountId) ?? tokenData;
          currentToken = latestToken;
          const latestQuota = await this.options.upstream.fetchQuota(
            latestToken.access_token,
            latestToken.upstream_proxy_url,
          );
          if (!this.canApplyQuotaRefresh(accountId, latestToken, generation)) {
            return null;
          }
          if (!this.applyQuotaRefresh(accountId, latestToken, latestQuota, nowMs, generation)) {
            return null;
          }
          this.accountFailureCooldownUntil.delete(accountId);
          return true;
        } catch (retryError) {
          const suspended = await this.suspendAfterQuotaFailure(retryError, accountId, currentToken, generation);
          if (suspended !== undefined) return suspended;
          this.accountFailureCooldownUntil.set(
            accountId,
            nowMs + QUOTA_REFRESH_FAILURE_COOLDOWN_MS,
          );
          this.options.logger.warn(
            'Quota refresh failed: operation=refresh_account reason=auth_retry_failed',
          );
          return false;
        }
      }
      this.accountFailureCooldownUntil.set(accountId, nowMs + QUOTA_REFRESH_FAILURE_COOLDOWN_MS);
      this.options.logger.warn(
        'Quota refresh failed: operation=refresh_account reason=quota_fetch_failed',
      );
      return false;
    }
  }

  private async suspendAfterQuotaFailure(error: unknown, accountId: string, tokenData: AccountLeaseTokenData, generation: number): Promise<false | null | undefined> {
    if (!(error instanceof Error) || !error.message.includes('TOS_VIOLATION')) return undefined;
    if (!this.canApplyQuotaRefresh(accountId, tokenData, generation)) return null;
    try { await this.options.suspendAccount(accountId); }
    catch { this.options.logger.warn('Account suspension persistence failed; account remains fenced'); }
    return false;
  }

  private applyQuotaRefresh(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    latestQuota: CloudQuotaData,
    refreshedAt: number,
    generation: number,
  ): boolean {
    const quotaSnapshot: CloudQuotaData = {
      ...latestQuota,
      last_successful_refresh_at: refreshedAt,
    };
    const extractedState = buildAccountLeaseQuotaSnapshot(quotaSnapshot);

    if (
      !this.options.accountStore.updateQuotaIfCurrent(accountId, quotaSnapshot, () =>
        this.canApplyQuotaRefresh(accountId, tokenData, generation),
      )
    ) {
      return false;
    }

    tokenData.quota = quotaSnapshot;
    tokenData.last_successful_quota_refresh_at = refreshedAt;
    tokenData.model_quotas = extractedState.modelQuotas;
    tokenData.model_limits = extractedState.modelLimits;
    tokenData.model_reset_times = extractedState.modelResetTimes;
    tokenData.model_forwarding_rules = extractedState.modelForwardingRules;
    const tokenCache = this.options.getTokenCache();
    tokenCache.set(accountId, tokenData);
    proxyModelAvailabilityStore.clearCapabilityFailuresForModels(
      accountId,
      Object.keys(extractedState.modelQuotas),
    );
    tryRecordQuotaSnapshot(accountId, quotaSnapshot, refreshedAt);
    return true;
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
  if (isAICreditsAuthenticationError(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const normalizedMessage = error.message.trim().toUpperCase();
  return (
    normalizedMessage === 'UNAUTHORIZED' ||
    normalizedMessage === 'HTTP 401' ||
    normalizedMessage === 'FORBIDDEN' ||
    normalizedMessage === 'HTTP 403'
  );
}
