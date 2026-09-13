import crypto from 'node:crypto';
import { CloudAccount } from '@/modules/cloud-account/types';
import { calculateRetryDelay, sleep } from '../antigravity/retry-utils';
import { UpstreamRequestError } from './clients/upstream-error';
import { proxyModelAvailabilityStore } from './proxy-model-availability-store';
import { isStrictAuthenticationFailure } from '@/modules/cloud-account/services/strict-authentication-classifier';
import { RateLimitReason } from './rate-limit-tracker';
import { isVerifiedSessionKey } from './account-lease-selection-policy';
import { type AffinityCommitResult } from './account-lease.service';
import {
  authorizesMigration,
  createMigrationAuthorization,
  type MigrationAuthorization,
  type MigrationAuthorizationReason,
} from './cache-affinity-coordinator';
import {
  type ProxyRetryAccountLeaseService,
  type ProxyRetryLogger,
  type ProxyTokenRetryState,
} from './proxy-retry-affinity-contract';
export { type AffinityCommitResult };
export type {
  ProxyRetryAccountLeaseService,
  ProxyRetryLifecycleState,
  ProxyRetryLogger,
  ProxyTokenRetryState,
} from './proxy-retry-affinity-contract';
export interface ProxyUpstreamFailureClassification {
  retry: boolean;
  markAsForbidden: boolean;
  markAsRateLimited: boolean;
}
export class ProxyRetryPolicy {
  constructor(private readonly accountLeaseService: ProxyRetryAccountLeaseService, private readonly logger: ProxyRetryLogger) {}
  isTerminal(retryState?: ProxyTokenRetryState): boolean {
    if (!retryState) return true;
    return retryState.status !== 'active' || Boolean(retryState.signal?.aborted);
  }
  createTokenRetryState(signal?: AbortSignal): ProxyTokenRetryState {
    const retryState: ProxyTokenRetryState = {
      attemptedAccountIds: new Set<string>(),
      requestId: crypto.randomUUID(),
      signal,
      status: 'active',
    };
    if (signal) {
      const onAbort = () => {
        this.cancelTokenRetryState(retryState);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        retryState.removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    }
    return retryState;
  }
  cancelTokenRetryState(retryState?: ProxyTokenRetryState): void {
    if (!retryState) return;
    if (retryState.status === 'cancelled' || retryState.status === 'disposed') {
      this.stopMigrationRenewal(retryState);
      this.releaseReservation(retryState);
      return;
    }
    retryState.status = 'cancelled';
    retryState.removeAbortListener?.();
    retryState.removeAbortListener = undefined;
    this.stopMigrationRenewal(retryState);
    this.abortMigration(retryState);
    this.releaseReservation(retryState); this.abortAffinityPlacement(retryState);
  }
  startMigrationRenewal(retryState: ProxyTokenRetryState, sessionKey?: string): void {
    this.stopMigrationRenewal(retryState);
    if (this.isTerminal(retryState)) return;
    if (!sessionKey || !retryState.migrationCapability) return;
    const migrationCap = retryState.migrationCapability;
    const renewalIntervalMs = 20000;
    retryState.migrationRenewalTimer = setInterval(() => {
      if (this.isTerminal(retryState)) {
        this.stopMigrationRenewal(retryState);
        return;
      }
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
            '[ProxyRetryPolicy] Migration renewal rejected; stopping renewal',
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
    if (retryState.status === 'disposed') return;
    retryState.status = 'disposed';
    retryState.removeAbortListener?.();
    retryState.removeAbortListener = undefined;
    this.stopMigrationRenewal(retryState);
    this.abortMigration(retryState);
    this.releaseReservation(retryState); this.abortAffinityPlacement(retryState);
  }
  private releaseReservation(retryState: ProxyTokenRetryState): void {
    if (retryState.activeReservation) {
      const release = retryState.activeReservation;
      retryState.activeReservation = undefined;
      try {
        release();
      } catch (err) {
        this.logger.warn(`[ProxyRetryPolicy] Error releasing reservation: ${err}`);
      }
    }
  }
  private abortAffinityPlacement(retryState: ProxyTokenRetryState): void { retryState.completeAffinityPlacement?.('aborted'); retryState.completeAffinityPlacement = undefined; }
  private abortMigration(retryState: ProxyTokenRetryState): void {
    const capability = retryState.migrationCapability;
    if (!capability) return;
    this.accountLeaseService.abortSessionMigration?.(
      capability.sessionKey,
      retryState.sessionGeneration ?? capability.generation,
      retryState.requestId,
      retryState.tableIncarnation ?? capability.tableIncarnation,
    );
    retryState.migrationCapability = undefined;
  }
  async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    if (this.isTerminal(retryState)) {
      return null;
    }
    this.releaseReservation(retryState); this.abortAffinityPlacement(retryState);
    retryState.sessionKey = sessionKey;
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
        migrationAuthorization: retryState.migrationAuthorization,
        signal: retryState.signal, requestId: retryState.requestId,
      });
      if (this.isTerminal(retryState)) {
        if (lease) {
          try {
            lease.releaseReservation();
          } catch { /* empty */ }
          lease.completeAffinityPlacement?.('aborted');
        }
        return null;
      }
      if (!lease) {
        return null;
      }
      retryState.attemptedAccountIds.add(lease.account.id);
      retryState.activeReservation = lease.releaseReservation;
      retryState.sessionGeneration = lease.generation;
      retryState.tableIncarnation = lease.tableIncarnation;
      retryState.breakerGeneration = lease.breakerGeneration; retryState.completeAffinityPlacement = lease.completeAffinityPlacement;
      selectedAccount = lease.account;
    } else {
      const token = await this.accountLeaseService.getNextToken({
        sessionKey,
        excludeAccountIds: Array.from(retryState.attemptedAccountIds),
        model,
        deferSessionBinding: true,
        migrationAuthorization: retryState.migrationAuthorization,
        signal: retryState.signal,
      });
      if (this.isTerminal(retryState)) {
        if (token) {
          try {
            token.releaseReservation?.();
          } catch { /* empty */ }
        }
        return null;
      }
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
    if (this.isTerminal(retryState)) {
      this.releaseReservation(retryState);
      return null;
    }
    const needsMigration = Boolean(
      sessionKey &&
      isVerifiedSessionKey(sessionKey) &&
      selectedAccount &&
      initialBinding &&
      initialBinding.accountId !== selectedAccount.id,
    );
    const migrationAuthorized = authorizesMigration(
      retryState.migrationAuthorization,
      sessionKey,
      initialBinding,
      retryState.requestId,
    );
    if (needsMigration && !migrationAuthorized) {
      this.releaseReservation(retryState);
      return null;
    }
    if (needsMigration && typeof this.accountLeaseService.startSessionMigration !== 'function') {
      this.releaseReservation(retryState);
      return null;
    }
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
      } else { this.releaseReservation(retryState); return null; }
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
      retryState.status = 'confirmed';
      retryState.removeAbortListener?.();
      retryState.removeAbortListener = undefined;
      this.stopMigrationRenewal(retryState);
      this.releaseReservation(retryState);
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
              : { kind: 'rejected', reason: 'migration-confirmation-rejected' }
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
          commitResult = bound ? { kind: 'confirmed' } : { kind: 'rejected', reason: 'active-bind-rejected' };
        } else {
          const bound = this.accountLeaseService.bindSession(sessionKey, accountId) !== false;
          commitResult = bound ? { kind: 'confirmed' } : { kind: 'rejected', reason: 'active-bind-rejected' };
        }
      }
    }
    if (retryState) { retryState.completeAffinityPlacement?.(commitResult.kind === 'confirmed' ? 'committed' : 'aborted'); retryState.completeAffinityPlacement = undefined; }
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
      this.releaseReservation(retryState);
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
    if (retryState) this.abortAffinityPlacement(retryState);
    this.accountLeaseService.recordParityError();
    if (error instanceof UpstreamRequestError) {
      const status = error.status;
      if (retryState) {
        const reason = this.migrationReasonForUpstreamError(error);
        retryState.migrationAuthorization = reason
          ? this.issueMigrationAuthorization(retryState, reason)
          : undefined;
      }
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
      if (retryState) {
        retryState.migrationAuthorization = this.issueMigrationAuthorization(
          retryState,
          'authentication-failure',
        );
      }
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
  private issueMigrationAuthorization(
    retryState: ProxyTokenRetryState,
    reason: MigrationAuthorizationReason,
  ): MigrationAuthorization | undefined {
    const sessionKey = retryState.sessionKey;
    const binding = this.accountLeaseService.getSessionBinding?.(sessionKey);
    const tableIncarnation = retryState.tableIncarnation ?? binding?.tableIncarnation;
    if (!binding || tableIncarnation === undefined || binding.tableIncarnation !== tableIncarnation) {
      return undefined;
    }
    return createMigrationAuthorization(reason, sessionKey, binding, retryState.requestId) ?? undefined;
  }
  private migrationReasonForUpstreamError(
    error: UpstreamRequestError,
  ): MigrationAuthorizationReason | undefined {
    if (error.status === 401 || error.status === 403) return 'authentication-failure';
    if (error.reason === 'model_not_found') return 'model-incompatible';
    if (error.reason === 'quota_exhausted') return 'quota-exhausted';
    if (error.reason === 'rate_limited' || error.status === 429) return 'account-cooldown';
    return undefined;
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
