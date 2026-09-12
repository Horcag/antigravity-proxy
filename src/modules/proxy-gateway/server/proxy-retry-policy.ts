import { CloudAccount } from '@/modules/cloud-account/types';
import { calculateRetryDelay, sleep } from '../antigravity/retry-utils';
import { UpstreamRequestError } from './clients/upstream-error';
import { proxyModelAvailabilityStore } from './proxy-model-availability-store';
import { isStrictAuthenticationFailure } from '@/modules/cloud-account/services/strict-authentication-classifier';
import { RateLimitReason } from './rate-limit-tracker';

export interface ProxyTokenRetryState {
  attemptedAccountIds: Set<string>;
  activeReservation?: () => void;
  sessionGeneration?: number;
  breakerGeneration?: number;
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
    breakerGeneration: number;
    releaseReservation: () => void;
  } | null>;
  getBreakerGeneration?(accountId: string): number;
  markModelSuccess?(accountIdOrEmail: string, model: string, expectedBreakerGeneration?: number): void;
  bindSession?(sessionKey: string | undefined, accountId: string, ttlMs?: number, expectedGeneration?: number): boolean | void;
  getSessionBinding?(sessionKey: string | undefined): { generation: number } | null;
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

  createTokenRetryState(): ProxyTokenRetryState {
    return {
      attemptedAccountIds: new Set<string>(),
    };
  }

  async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    retryState.activeReservation?.();
    retryState.activeReservation = undefined;

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
      retryState.breakerGeneration = lease.breakerGeneration;
      return lease.account;
    }

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
    if (this.accountLeaseService.getBreakerGeneration) {
      retryState.breakerGeneration = this.accountLeaseService.getBreakerGeneration(token.id);
    }
    return token;
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
  ): void {
    if (sessionKey && this.accountLeaseService.bindSession) {
      if (expectedGeneration !== undefined) {
        this.accountLeaseService.bindSession(sessionKey, accountId, undefined, expectedGeneration);
      } else {
        this.accountLeaseService.bindSession(sessionKey, accountId);
      }
    }
    if (!model) {
      return;
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
  }

  async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
    retryState?: ProxyTokenRetryState,
  ): Promise<boolean> {
    retryState?.activeReservation?.();
    if (retryState) {
      retryState.activeReservation = undefined;
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
