import crypto from 'node:crypto';
import { CloudAccount } from '@/modules/cloud-account/types';
import { calculateRetryDelay, sleep } from '../antigravity/retry-utils';
import { UpstreamRequestError } from './clients/upstream-error';
import { proxyModelAvailabilityStore } from './proxy-model-availability-store';
import { isStrictAuthenticationFailure } from '@/modules/cloud-account/services/strict-authentication-classifier';
import { RateLimitReason } from './rate-limit-tracker';
import {
  type MigrationCapability,
  isVerifiedSessionKey,
} from './account-lease-selection-policy';
import { type AffinityCommitResult } from './account-lease.service';

export { type AffinityCommitResult };

export interface ProxyTokenRetryState {
  attemptedAccountIds: Set<string>;
  requestId: string;
  activeReservation?: () => void;
  sessionGeneration?: number;
  tableIncarnation?: number;
  breakerGeneration?: number;
  migrationCapability?: MigrationCapability;
  migrationRenewalTimer?: NodeJS.Timeout;
}

export interface ProxyRetryAccountLeaseService {
  getNextToken(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
    deferSessionBinding?: boolean;
  }): Promise<CloudAccount | null>;
  recordParityError(): void;
  markAsForbidden(accountIdOrEmail: string): void;
  markAsRateLimited(accountIdOrEmail: string): void;
  markFromUpstreamError(params: {
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    reason?: RateLimitReason;
    model?: string;
  }): Promise<void>;
  acquireAttemptLease?(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
    deferSessionBinding?: boolean;
  }): Promise<{
    account: CloudAccount;
    sessionKey?: string;
    generation: number;
    tableIncarnation?: number;
    breakerGeneration?: number;
    releaseReservation: () => void;
  } | null>;
  getTableIncarnation?(): number;
  getBreakerGeneration?(accountId: string): number | undefined;
  markModelSuccess?(accountId: string, model: string, breakerGeneration?: number): void;
  recordPerformanceSuccess?(accountId: string, model: string, latencyMs?: number): void;
  bindSession?(
    sessionKey: string | undefined,
    accountId: string,
    ttlMs?: number,
    expectedGeneration?: number,
    expectedIncarnation?: number,
  ): boolean | void;
  confirmOrBindSession?(
    sessionKey: string | undefined,
    accountId: string,
    expectedGeneration?: number,
    ownerRequestId?: string,
    ttlMs?: number,
    expectedIncarnation?: number,
  ): AffinityCommitResult | boolean;
  startSessionMigration?(
    sessionKey: string | undefined,
    currentGeneration: number,
    targetAccountId: string,
    ownerRequestId?: string,
    expectedIncarnation?: number,
  ): MigrationCapability | null;
  renewSessionMigration?(
    sessionKey: string | undefined,
    expectedGeneration: number,
    ownerRequestId?: string,
    extensionMs?: number,
    expectedIncarnation?: number,
  ): boolean;
  failSessionMigrationCandidate?(
    sessionKey: string | undefined,
    expectedGeneration: number,
    failedAccountId: string,
    ownerRequestId?: string,
    expectedIncarnation?: number,
  ): boolean;
  getSessionBinding?(sessionKey: string | undefined): { accountId?: string; generation: number } | null;
}

interface ProxyRetryLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ProxyUpstreamFailureClassification {
  retry: boolean;
  markAsForbidden: boolean;
  markAsRateLimited: boolean;
}

export class ProxyRetryPolicy {
  constructor(
    private readonly accountLeaseService: ProxyRetryAccountLeaseService,
    private readonly logger: ProxyRetryLogger,
  ) {}

  createTokenRetryState(signal?: AbortSignal): ProxyTokenRetryState {
    const retryState: ProxyTokenRetryState = {
      attemptedAccountIds: new Set<string>(),
      requestId: crypto.randomUUID(),
    };
    if (signal) {
      const onAbort = () => {
        this.stopMigrationRenewal(retryState);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    return retryState;
  }

  startMigrationRenewal(retryState: ProxyTokenRetryState, sessionKey?: string): void {
    this.stopMigrationRenewal(retryState);
    if (!sessionKey || !retryState.migrationCapability) return;

    const migrationCap = retryState.migrationCapability;
    const renewalIntervalMs = 20000;

    retryState.migrationRenewalTimer = setInterval(() => {
      if (typeof this.accountLeaseService.renewSessionMigration === 'function') {
        const expectedGen = retryState.sessionGeneration ?? migrationCap.generation;
        const renewed = this.accountLeaseService.renewSessionMigration(
          sessionKey,
          expectedGen,
          retryState.requestId,
          60000,
          retryState.tableIncarnation,
        );
        if (!renewed) {
          this.logger.warn(
            `[ProxyRetryPolicy] Migration renewal rejected for session ${sessionKey}; stopping renewal`,
          );
          this.stopMigrationRenewal(retryState);
        }
      }
    }, renewalIntervalMs);
    retryState.migrationRenewalTimer.unref?.();
  }

  stopMigrationRenewal(retryState?: ProxyTokenRetryState): void {
    if (retryState?.migrationRenewalTimer) {
      clearInterval(retryState.migrationRenewalTimer);
      retryState.migrationRenewalTimer = undefined;
    }
  }

  disposeTokenRetryState(retryState?: ProxyTokenRetryState): void {
    if (!retryState) return;
    this.stopMigrationRenewal(retryState);
    retryState.activeReservation?.();
    retryState.activeReservation = undefined;
  }

  async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    retryState.activeReservation?.();
    retryState.activeReservation = undefined;

    const isRetryAttempt = retryState.attemptedAccountIds.size > 0;

    const initialBinding =
      sessionKey && typeof this.accountLeaseService.getSessionBinding === 'function'
        ? this.accountLeaseService.getSessionBinding(sessionKey)
        : null;

    let selectedAccount: CloudAccount | null = null;

    if (this.accountLeaseService.acquireAttemptLease) {
      const lease = await this.accountLeaseService.acquireAttemptLease({
        sessionKey,
        excludeAccountIds: Array.from(retryState.attemptedAccountIds),
        model,
        deferSessionBinding: true,
      });
      if (!lease) {
        return null;
      }
      retryState.attemptedAccountIds.add(lease.account.id);
      retryState.activeReservation = lease.releaseReservation;
      retryState.sessionGeneration = lease.generation;
      retryState.tableIncarnation = lease.tableIncarnation;
      retryState.breakerGeneration = lease.breakerGeneration;
      selectedAccount = lease.account;
    } else {
      const token = await this.accountLeaseService.getNextToken({
        sessionKey,
        excludeAccountIds: Array.from(retryState.attemptedAccountIds),
        model,
        deferSessionBinding: true,
      });
      if (!token) {
        return null;
      }

      retryState.attemptedAccountIds.add(token.id);
      retryState.activeReservation = token.releaseReservation;
      if (sessionKey && this.accountLeaseService.getSessionBinding) {
        retryState.sessionGeneration =
          this.accountLeaseService.getSessionBinding(sessionKey)?.generation ?? 1;
      }
      if (this.accountLeaseService.getTableIncarnation) {
        retryState.tableIncarnation = this.accountLeaseService.getTableIncarnation();
      }
      if (this.accountLeaseService.getBreakerGeneration) {
        retryState.breakerGeneration = this.accountLeaseService.getBreakerGeneration(token.id);
      }
      selectedAccount = token;
    }

    const needsMigration = Boolean(
      sessionKey &&
      isVerifiedSessionKey(sessionKey) &&
      selectedAccount &&
      initialBinding &&
      initialBinding.accountId !== selectedAccount.id,
    );

    // Gate 4: If this is a retry attempt or account changed on a verified session, initiate versioned migration to the candidate account
    if (
      selectedAccount &&
      sessionKey &&
      isVerifiedSessionKey(sessionKey) &&
      (isRetryAttempt || needsMigration) &&
      typeof this.accountLeaseService.startSessionMigration === 'function'
    ) {
      const currentGen =
        retryState.sessionGeneration ??
        initialBinding?.generation ??
        1;
      const migrationCap = this.accountLeaseService.startSessionMigration(
        sessionKey,
        currentGen,
        selectedAccount.id,
        retryState.requestId,
        retryState.tableIncarnation,
      );
      if (migrationCap) {
        retryState.sessionGeneration = migrationCap.generation;
        retryState.tableIncarnation = migrationCap.tableIncarnation;
        retryState.migrationCapability = migrationCap;
        this.startMigrationRenewal(retryState, sessionKey);
      }
    }

    return selectedAccount;
  }

  async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
  ): Promise<void> {
    if (attemptIndex === 0) {
      return;
    }

    const delay = calculateRetryDelay(attemptIndex - 1);
    this.logger.log(
      `${label} retry ${attemptIndex + 1}/${maxRetries}, backoff=${delay}ms (jittered)`,
    );
    await sleep(delay);
  }

  shouldFailoverImmediately(error: unknown): boolean {
    return (
      error instanceof UpstreamRequestError &&
      (error.status === 401 || error.status === 403 || error.status === 429)
    );
  }

  markUpstreamSuccess(
    accountId: string,
    model?: string,
    sessionKey?: string,
    expectedGeneration?: number,
    expectedBreakerGeneration?: number,
    ownerRequestId?: string,
    expectedIncarnation?: number,
    retryState?: ProxyTokenRetryState,
  ): AffinityCommitResult {
    if (retryState) {
      this.stopMigrationRenewal(retryState);
    }
    let commitResult: AffinityCommitResult = { kind: 'not-applicable' };
    if (sessionKey) {
      if (typeof this.accountLeaseService.confirmOrBindSession === 'function') {
        const res = this.accountLeaseService.confirmOrBindSession(
          sessionKey,
          accountId,
          expectedGeneration,
          ownerRequestId,
          undefined,
          expectedIncarnation,
        );
        commitResult =
          typeof res === 'boolean'
            ? res
              ? { kind: 'confirmed' }
              : { kind: 'rejected', reason: 'confirmOrBindSession returned false' }
            : res;
      } else if (this.accountLeaseService.bindSession) {
        if (expectedGeneration !== undefined) {
          const bound =
            this.accountLeaseService.bindSession(
              sessionKey,
              accountId,
              undefined,
              expectedGeneration,
              expectedIncarnation,
            ) !== false;
          commitResult = bound ? { kind: 'confirmed' } : { kind: 'rejected', reason: 'bindSession returned false' };
        } else {
          const bound = this.accountLeaseService.bindSession(sessionKey, accountId) !== false;
          commitResult = bound ? { kind: 'confirmed' } : { kind: 'rejected', reason: 'bindSession returned false' };
        }
      }
    }
    if (!model) {
      return commitResult;
    }

    if (expectedBreakerGeneration !== undefined) {
      this.accountLeaseService.markModelSuccess?.(accountId, model, expectedBreakerGeneration);
    } else {
      this.accountLeaseService.markModelSuccess?.(accountId, model);
    }
    const currentBreaker = this.accountLeaseService.getBreakerGeneration
      ? this.accountLeaseService.getBreakerGeneration(accountId)
      : expectedBreakerGeneration;
    if (expectedBreakerGeneration === undefined || currentBreaker === expectedBreakerGeneration) {
      proxyModelAvailabilityStore.clearModel(accountId, model);
    }
    return commitResult;
  }

  async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
    retryState?: ProxyTokenRetryState,
  ): Promise<boolean> {
    if (retryState) {
      this.stopMigrationRenewal(retryState);
    }
    retryState?.activeReservation?.();
    if (retryState) {
      retryState.activeReservation = undefined;
    }
    if (
      retryState?.migrationCapability &&
      typeof this.accountLeaseService.failSessionMigrationCandidate === 'function'
    ) {
      this.accountLeaseService.failSessionMigrationCandidate(
        retryState.migrationCapability.sessionKey,
        retryState.sessionGeneration ?? retryState.migrationCapability.generation,
        accountId,
        retryState.requestId,
        retryState.tableIncarnation ?? retryState.migrationCapability.tableIncarnation,
      );
    }
    this.accountLeaseService.recordParityError();

    if (error instanceof UpstreamRequestError) {
      const status = error.status;
      const isImageModel = model.toLowerCase().includes('-image');
      if (isImageModel && status === 404) {
        proxyModelAvailabilityStore.mark(accountId, model, 'model_not_supported');
        return true;
      }
      if (isImageModel && status === 403) {
        proxyModelAvailabilityStore.mark(accountId, model, 'model_forbidden');
        return true;
      }
      if (status === 429) {
        proxyModelAvailabilityStore.mark(
          accountId,
          model,
          error.reason === 'quota_exhausted'
            ? 'quota_exhausted'
            : 'rate_limited',
        );
      }
      if (status === 401 || status === 403) {
        this.accountLeaseService.markAsForbidden(accountId);
        return true;
      }

      const retryable =
        status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        error.reason === 'transport';
      if (retryable) {
        await this.accountLeaseService.markFromUpstreamError({
          accountIdOrEmail: accountId,
          status,
          retryAfter: error.headers?.retryAfter,
          reason: this.toRateLimitReason(error),
          model,
        });
      }
      return retryable;
    }

    if (!(error instanceof Error)) {
      return false;
    }

    this.logger.warn(
      `Upstream request failed: operation=proxy_request reason=${
        isStrictAuthenticationFailure(error) ? 'authentication' : 'generic_failure'
      }`,
    );
    if (isStrictAuthenticationFailure(error)) {
      this.accountLeaseService.markAsForbidden(accountId);
      return true;
    }
    const penaltyDecision = this.classifyUpstreamFailure(error.message);
    if (!penaltyDecision.retry) {
      return false;
    }

    if (penaltyDecision.markAsForbidden) {
      this.accountLeaseService.markAsForbidden(accountId);
      return true;
    }

    if (penaltyDecision.markAsRateLimited) {
      this.accountLeaseService.markAsRateLimited(accountId);
    }
    return true;
  }

  private toRateLimitReason(error: UpstreamRequestError): RateLimitReason {
    if (error.reason === 'quota_exhausted') {
      return RateLimitReason.QuotaExhausted;
    }
    if (error.reason === 'rate_limited') {
      return RateLimitReason.RateLimitExceeded;
    }
    return error.status === 429 ? RateLimitReason.Unknown : RateLimitReason.ServerError;
  }

  classifyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
    const normalizedErrorMessage = errorMessage.toLowerCase();
    if (isStrictAuthenticationFailure(errorMessage)) {
      return {
        retry: true,
        markAsForbidden: true,
        markAsRateLimited: false,
      };
    }

    const isRateLimitedSignal =
      normalizedErrorMessage.includes('429') ||
      normalizedErrorMessage.includes('resource_exhausted') ||
      normalizedErrorMessage.includes('quota') ||
      normalizedErrorMessage.includes('rate_limit') ||
      normalizedErrorMessage.includes('rate limit');

    const shouldRetryByStatus =
      normalizedErrorMessage.includes('408') ||
      normalizedErrorMessage.includes('429') ||
      normalizedErrorMessage.includes('500') ||
      normalizedErrorMessage.includes('502') ||
      normalizedErrorMessage.includes('503') ||
      normalizedErrorMessage.includes('504');

    const shouldRetryByKeyword =
      normalizedErrorMessage.includes('resource_exhausted') ||
      normalizedErrorMessage.includes('quota') ||
      normalizedErrorMessage.includes('rate_limit') ||
      normalizedErrorMessage.includes('timeout') ||
      normalizedErrorMessage.includes('socket hang up') ||
      normalizedErrorMessage.includes('empty response stream') ||
      normalizedErrorMessage.includes('connection reset');

    if (shouldRetryByStatus || shouldRetryByKeyword) {
      return {
        retry: true,
        markAsForbidden: false,
        markAsRateLimited: isRateLimitedSignal,
      };
    }

    return {
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    };
  }
}
