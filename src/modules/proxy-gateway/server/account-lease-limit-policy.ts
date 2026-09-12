import { isEmpty, isString } from 'lodash-es';
import {
  hasExplicitQuotaExhaustedSignal,
  hasGenericResourceExhaustedSignal,
  parseRetryDelayMilliseconds,
  RateLimitReason,
  RateLimitTracker,
} from './rate-limit-tracker';
import { normalizeModelId } from './account-lease-token-types';

export interface AccountLeaseUpstreamErrorParams {
  accountIdOrEmail: string;
  status?: number;
  retryAfter?: string;
  body?: string;
  headers?: Record<string, string | string[] | undefined>;
  reason?: RateLimitReason;
  model?: string;
}

interface AccountLeaseLimitLogger {
  warn(message: string, error?: unknown): void;
}

interface AccountLeaseLimitPolicyOptions {
  rateLimitCooldownMs: number;
  forbiddenCooldownMs: number;
  resolveAccountId: (accountIdOrEmail: string) => string | null;
  getCircuitBreakerBackoffSteps: () => number[];
  refreshRealtimeQuotaAndSetPreciseLockout: (
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ) => Promise<boolean>;
  setPreciseLockoutFromCachedQuota: (
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  logger: AccountLeaseLimitLogger;
  rateLimitTracker?: RateLimitTracker;
}

export interface ActiveAccountCooldown {
  accountId: string;
  reason: string;
  unavailableUntil: number;
  remainingSeconds: number;
}

export class AccountLeaseLimitPolicy {
  private readonly accountCooldowns = new Map<string, number>();
  private readonly accountCooldownReasons = new Map<string, string>();
  private readonly rateLimitTracker: RateLimitTracker;

  constructor(private readonly options: AccountLeaseLimitPolicyOptions) {
    this.rateLimitTracker = options.rateLimitTracker ?? new RateLimitTracker();
  }

  getAccountCooldowns(): Map<string, number> {
    return this.accountCooldowns;
  }

  getRateLimitTracker(): RateLimitTracker {
    return this.rateLimitTracker;
  }

  clearAllRateLimits(): void {
    this.accountCooldowns.clear();
    this.accountCooldownReasons.clear();
    this.rateLimitTracker.clearAll();
  }

  getActiveAccountCooldowns(now = Date.now()): ActiveAccountCooldown[] {
    for (const [accountId, unavailableUntil] of this.accountCooldowns) {
      if (unavailableUntil <= now) {
        this.accountCooldowns.delete(accountId);
        this.accountCooldownReasons.delete(accountId);
      }
    }
    return this.peekActiveAccountCooldowns(now);
  }

  peekActiveAccountCooldowns(now = Date.now()): ActiveAccountCooldown[] {
    const active: ActiveAccountCooldown[] = [];
    for (const [accountId, unavailableUntil] of this.accountCooldowns) {
      if (unavailableUntil <= now) {
        continue;
      }
      active.push({
        accountId,
        reason: this.accountCooldownReasons.get(accountId) ?? 'rate_limited',
        unavailableUntil,
        remainingSeconds: Math.max(0, Math.ceil((unavailableUntil - now) / 1000)),
      });
    }
    return active;
  }

  markModelSuccess(accountIdOrEmail: string, model: string): void {
    const accountId = this.resolveAccountId(accountIdOrEmail);
    this.rateLimitTracker.markModelSuccess(accountId, model);
  }

  isRateLimited(accountIdOrEmail: string, model?: string): boolean {
    const accountId = this.resolveAccountId(accountIdOrEmail);
    const now = Date.now();
    const legacyCooldownUntil = this.accountCooldowns.get(accountId);
    if (legacyCooldownUntil && legacyCooldownUntil > now) {
      return true;
    }
    return this.rateLimitTracker.isRateLimited(accountId, model);
  }

  markAsRateLimited(accountIdOrEmail: string): void {
    this.setAccountCooldown(accountIdOrEmail, 'rate limited', this.options.rateLimitCooldownMs);
  }

  markAsForbidden(accountIdOrEmail: string): void {
    this.setAccountCooldown(accountIdOrEmail, 'forbidden', this.options.forbiddenCooldownMs);
  }

  async markFromUpstreamError(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    const accountId = this.resolveAccountId(params.accountIdOrEmail);
    const normalizedModel = normalizeModelId(params.model);
    const retryAfterHeader = params.headers?.['retry-after'];
    const retryAfterHeaderStr = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const effectiveRetryAfter = params.retryAfter ?? retryAfterHeaderStr;

    const hasExplicitRetryWindow =
      Boolean(isString(effectiveRetryAfter) && !isEmpty(effectiveRetryAfter.trim())) ||
      parseRetryDelayMilliseconds(params.body) !== null;

    // Immediately install provisional lockout so concurrent requests and immediate retry
    // failover cannot re-select this account while upstream quota refresh is in flight.
    this.trackParsedError(
      { ...params, retryAfter: effectiveRetryAfter },
      accountId,
      normalizedModel,
      true,
    );

    if (!hasExplicitRetryWindow && (params.status ?? 0) === 429) {
      const reason = params.reason ?? this.detectRateLimitReasonFromBody(params.body);
      const shouldAttemptPreciseLockout =
        reason === RateLimitReason.QuotaExhausted || reason === RateLimitReason.Unknown;

      if (!shouldAttemptPreciseLockout) {
        return;
      }

      const provisionalUntil = this.accountCooldowns.get(accountId);
      const provisionalReason = this.accountCooldownReasons.get(accountId);

      const isLockedByRealtimeQuota = await this.options.refreshRealtimeQuotaAndSetPreciseLockout(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByRealtimeQuota) {
        if (
          normalizedModel &&
          this.accountCooldowns.get(accountId) === provisionalUntil &&
          this.accountCooldownReasons.get(accountId) === provisionalReason &&
          provisionalReason === reason
        ) {
          this.accountCooldowns.delete(accountId);
          this.accountCooldownReasons.delete(accountId);
        }
        return;
      }

      const isLockedByQuotaCache = this.options.setPreciseLockoutFromCachedQuota(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByQuotaCache) {
        if (
          normalizedModel &&
          this.accountCooldowns.get(accountId) === provisionalUntil &&
          this.accountCooldownReasons.get(accountId) === provisionalReason &&
          provisionalReason === reason
        ) {
          this.accountCooldowns.delete(accountId);
          this.accountCooldownReasons.delete(accountId);
        }
        return;
      }
    }
  }

  private trackParsedError(
    params: AccountLeaseUpstreamErrorParams,
    accountId: string,
    normalizedModel: string | undefined,
    logResult: boolean,
  ): void {
    const parsed = this.rateLimitTracker.trackFromUpstreamError({
      accountId,
      status: params.status,
      retryAfter: params.retryAfter,
      body: params.body,
      reason: params.reason,
      model: normalizedModel,
      backoffSteps: this.options.getCircuitBreakerBackoffSteps(),
    });

    if (!parsed) {
      return;
    }

    const isModelScoped =
      Boolean(parsed.model && !isEmpty(parsed.model.trim())) &&
      (parsed.reason === RateLimitReason.QuotaExhausted ||
        parsed.reason === RateLimitReason.RateLimitExceeded ||
        parsed.reason === RateLimitReason.ModelCapacityExhausted);
    if (!isModelScoped) {
      this.accountCooldowns.set(accountId, Date.now() + parsed.retryAfterSec * 1000);
      this.accountCooldownReasons.set(accountId, parsed.reason);
    }

    if (logResult) {
      this.options.logger.warn(
        `Recorded upstream limit: operation=account_lease reason=${parsed.reason} cooldown_seconds=${parsed.retryAfterSec}`,
      );
    }
  }

  private detectRateLimitReasonFromBody(body: string | undefined): RateLimitReason {
    const lowerBody = (body ?? '').toLowerCase();
    if (lowerBody.includes('model_capacity')) {
      return RateLimitReason.ModelCapacityExhausted;
    }
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit') ||
      (hasGenericResourceExhaustedSignal(body) && !hasExplicitQuotaExhaustedSignal(body))
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    if (hasExplicitQuotaExhaustedSignal(body) || lowerBody.includes('quota')) {
      return RateLimitReason.QuotaExhausted;
    }
    return RateLimitReason.Unknown;
  }

  private resolveAccountId(accountIdOrEmail: string): string {
    return this.options.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
  }

  private setAccountCooldown(
    accountIdOrEmail: string,
    reason: 'rate limited' | 'forbidden',
    durationMs: number,
  ): void {
    const accountId = this.resolveAccountId(accountIdOrEmail);
    const cooldownUntil = Date.now() + durationMs;

    this.accountCooldowns.set(accountId, cooldownUntil);
    this.accountCooldownReasons.set(accountId, reason.replace(' ', '_'));
    this.options.logger.warn(
      `Applied account cooldown: operation=account_lease reason=${reason} cooldown_seconds=${Math.ceil(durationMs / 1000)}`,
    );
  }
}
