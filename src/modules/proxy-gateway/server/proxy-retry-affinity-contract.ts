import type { CloudAccount } from '@/modules/cloud-account/types';
import type { MigrationCapability } from './account-lease-selection-policy';
import type { AffinityCommitResult } from './account-lease.service';
import type { MigrationAuthorization } from './cache-affinity-coordinator';
import type { RateLimitReason } from './rate-limit-tracker';

export type ProxyRetryLifecycleState = 'active' | 'confirmed' | 'failed' | 'cancelled' | 'disposed';

export interface ProxyTokenRetryState {
  attemptedAccountIds: Set<string>;
  requestId: string;
  activeReservation?: () => void;
  completeAffinityPlacement?: (outcome: 'aborted' | 'committed') => void;
  sessionGeneration?: number;
  tableIncarnation?: number;
  breakerGeneration?: number;
  migrationCapability?: MigrationCapability;
  migrationAuthorization?: MigrationAuthorization;
  sessionKey?: string;
  migrationRenewalTimer?: NodeJS.Timeout;
  signal?: AbortSignal;
  status: ProxyRetryLifecycleState;
  removeAbortListener?: () => void;
}

export interface ProxyRetryAccountLeaseService {
  getNextToken(options?: RetryTokenOptions): Promise<CloudAccount | null>;
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
  acquireAttemptLease?(options?: RetryTokenOptions): Promise<RetryAttemptLease | null>;
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
  abortSessionMigration?(
    sessionKey: string | undefined,
    expectedGeneration: number,
    ownerRequestId?: string,
    expectedIncarnation?: number,
  ): boolean;
  getSessionBinding?(sessionKey: string | undefined): {
    accountId?: string;
    generation: number;
    tableIncarnation?: number;
  } | null;
  authorizeBoundSessionMigration?(sessionKey: string | undefined, model: string | undefined, ownerRequestId: string | undefined): MigrationAuthorization | undefined;
}

interface RetryTokenOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
  deferSessionBinding?: boolean;
  migrationAuthorization?: MigrationAuthorization;
  signal?: AbortSignal;
  requestId?: string;
}

interface RetryAttemptLease {
  account: CloudAccount;
  sessionKey?: string;
  generation: number;
  tableIncarnation?: number;
  breakerGeneration?: number;
  releaseReservation: () => void;
  completeAffinityPlacement?: (outcome: 'aborted' | 'committed') => void;
  affinityAbortSignal?: AbortSignal;
}

export interface ProxyRetryLogger {
  log(message: string): void;
  warn(message: string): void;
}
