/**
 * The only transferable authority for moving a hard session binding. Keeping
 * it as data (rather than a boolean) prevents a retry from borrowing a
 * previous request's permission after the binding table has changed.
 */
export type MigrationAuthorizationReason =
  | 'account-cooldown'
  | 'account-deleted'
  | 'account-disabled'
  | 'authentication-failure'
  | 'model-incompatible'
  | 'quota-exhausted'
  | 'project-rejected'
  | 'ambiguity-probe'
  | 'upstream-transient';

export interface MigrationAuthorization {
  reason: MigrationAuthorizationReason;
  sessionKey: string;
  expectedGeneration: number;
  expectedTableIncarnation: number;
  ownerRequestId: string;
}

export interface AffinityBindingFence {
  generation: number;
  tableIncarnation?: number;
}

export type AffinityCommitResult =
  | { kind: 'confirmed' }
  | { kind: 'hint-recorded' }
  | { kind: 'not-applicable' }
  | { kind: 'rejected'; reason: AffinityCommitRejectionReason };

export type AffinityCommitRejectionReason =
  | 'active-binding-conflict'
  | 'generation-mismatch'
  | 'initial-bind-rejected'
  | 'migration-confirmation-rejected'
  | 'migration-owner-required'
  | 'table-incarnation-mismatch'
  | 'active-bind-rejected';

const AFFINITY_COMMIT_REJECTION_REASONS = new Set<AffinityCommitRejectionReason>([
  'active-binding-conflict',
  'generation-mismatch',
  'initial-bind-rejected',
  'migration-confirmation-rejected',
  'migration-owner-required',
  'table-incarnation-mismatch',
  'active-bind-rejected',
]);

/** Return a diagnostic-safe reason even if a boundary implementation is malformed. */
export function safeAffinityCommitRejectionReason(
  result: unknown,
): AffinityCommitRejectionReason | 'unrecognized' {
  if (!result || typeof result !== 'object') return 'unrecognized';
  const reason = (result as { reason?: unknown }).reason;
  return typeof reason === 'string' && AFFINITY_COMMIT_REJECTION_REASONS.has(reason as AffinityCommitRejectionReason)
    ? reason as AffinityCommitRejectionReason
    : 'unrecognized';
}

export type AffinityPlacementRejectionReason =
  | 'cancelled'
  | 'queue-full'
  | 'timeout'
  | 'unverified-session';

export type AffinityPlacementOutcome = 'aborted' | 'committed';

export type AffinityPlacementLease =
  | {
      kind: 'owner';
      complete(outcome: AffinityPlacementOutcome): void;
      /** Aborts when this owner loses its exclusive placement fence. */
      signal: AbortSignal;
    }
  | {
      kind: 'follower';
      outcome: AffinityPlacementOutcome;
    }
  | {
      kind: 'rejected';
      reason: AffinityPlacementRejectionReason;
    };

export interface CacheAffinityCoordinatorOptions {
  maxOwners?: number;
  maxWaitersPerSession?: number;
  ownerTimeoutMs?: number;
  waitTimeoutMs?: number;
}

interface PlacementWaiter {
  resolve(lease: AffinityPlacementLease): void;
  cleanup(): void;
}

interface PlacementOwner {
  waiters: Set<PlacementWaiter>;
  cleanup(): void;
}

/**
 * Coalesces only competing initial placement and migration decisions for one
 * verified conversation. It intentionally does not hold the account-selection
 * mutex while followers wait for the owner to commit or abort.
 */
export class CacheAffinityCoordinator {
  private readonly owners = new Map<string, PlacementOwner>();
  private readonly maxOwners: number;
  private readonly maxWaitersPerSession: number;
  private readonly ownerTimeoutMs: number;
  private readonly waitTimeoutMs: number;

  constructor(options: CacheAffinityCoordinatorOptions = {}) {
    this.maxOwners = options.maxOwners ?? 1024;
    this.maxWaitersPerSession = options.maxWaitersPerSession ?? 32;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
    this.ownerTimeoutMs = options.ownerTimeoutMs ?? this.waitTimeoutMs;
  }

  async acquire(
    sessionKey: string | undefined,
    options: { signal?: AbortSignal; ownerTimeoutMs?: number } = {},
  ): Promise<AffinityPlacementLease> {
    if (!this.isVerifiedHardSession(sessionKey)) {
      return { kind: 'rejected', reason: 'unverified-session' };
    }
    if (options.signal?.aborted) {
      return { kind: 'rejected', reason: 'cancelled' };
    }
    const owner = this.owners.get(sessionKey);
    if (!owner) {
      if (this.owners.size >= this.maxOwners) {
        return { kind: 'rejected', reason: 'queue-full' };
      }
      const cancellation = new AbortController();
      let completed = false;
      const created: PlacementOwner = {
        waiters: new Set(),
        cleanup: () => {
          clearTimeout(ownerTimeout);
          options.signal?.removeEventListener('abort', cancelOwner);
        },
      };
      const complete = (outcome: AffinityPlacementOutcome) => {
        if (completed) return;
        completed = true;
        this.completeOwner(sessionKey, created, outcome);
      };
      const cancelOwner = () => {
        cancellation.abort();
        complete('aborted');
      };
      const ownerTimeout = setTimeout(cancelOwner, options.ownerTimeoutMs ?? this.ownerTimeoutMs);
      ownerTimeout.unref?.();
      this.owners.set(sessionKey, created);
      options.signal?.addEventListener('abort', cancelOwner, { once: true });
      if (options.signal?.aborted) cancelOwner();
      return {
        kind: 'owner',
        complete,
        signal: cancellation.signal,
      };
    }
    if (owner.waiters.size >= this.maxWaitersPerSession) {
      return { kind: 'rejected', reason: 'queue-full' };
    }
    return new Promise<AffinityPlacementLease>((resolve) => {
      let settled = false;
      const settle = (lease: AffinityPlacementLease) => {
        if (settled) return;
        settled = true;
        waiter.cleanup();
        resolve(lease);
      };
      const onAbort = () => settle({ kind: 'rejected', reason: 'cancelled' });
      const timeout = setTimeout(() => settle({ kind: 'rejected', reason: 'timeout' }), this.waitTimeoutMs);
      const waiter: PlacementWaiter = {
        resolve: settle,
        cleanup: () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', onAbort);
          owner.waiters.delete(waiter);
        },
      };
      owner.waiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  getStateForTesting(): { owners: number; waiters: number } {
    let waiters = 0;
    for (const owner of this.owners.values()) waiters += owner.waiters.size;
    return { owners: this.owners.size, waiters };
  }

  private completeOwner(
    sessionKey: string,
    owner: PlacementOwner,
    outcome: AffinityPlacementOutcome,
  ): void {
    if (this.owners.get(sessionKey) !== owner) return;
    this.owners.delete(sessionKey);
    owner.cleanup();
    for (const waiter of [...owner.waiters]) {
      waiter.resolve({ kind: 'follower', outcome });
    }
  }

  private isVerifiedHardSession(sessionKey: string | undefined): sessionKey is string {
    return Boolean(sessionKey?.trim()) && !sessionKey!.startsWith('hint:') && !sessionKey!.startsWith('cache-hint:');
  }
}

export function createMigrationAuthorization(
  reason: MigrationAuthorizationReason,
  sessionKey: string | undefined,
  binding: AffinityBindingFence | null | undefined,
  ownerRequestId: string | undefined,
): MigrationAuthorization | null {
  if (!sessionKey || !ownerRequestId || !binding || binding.tableIncarnation === undefined) return null;
  return {
    reason,
    sessionKey,
    expectedGeneration: binding.generation,
    expectedTableIncarnation: binding.tableIncarnation,
    ownerRequestId,
  };
}

export function authorizesMigration(
  authorization: MigrationAuthorization | undefined,
  sessionKey: string | undefined,
  binding: AffinityBindingFence | null | undefined,
  ownerRequestId: string | undefined,
): authorization is MigrationAuthorization {
  return Boolean(
    authorization &&
      binding &&
      sessionKey &&
      authorization.sessionKey === sessionKey &&
      authorization.expectedGeneration === binding.generation &&
      binding.tableIncarnation !== undefined &&
      authorization.expectedTableIncarnation === binding.tableIncarnation &&
      Boolean(ownerRequestId) && authorization.ownerRequestId === ownerRequestId,
  );
}

export function confirmOrBindAffinitySession(
  selectionPolicy: AccountLeaseSelectionPolicy,
  sessionKey: string | undefined,
  accountId: string,
  expiresAt: number,
  expectedGeneration?: number,
  ownerRequestId?: string,
  expectedIncarnation?: number,
): AffinityCommitResult {
  if (!sessionKey || !accountId) return { kind: 'not-applicable' };
  if (!isVerifiedSessionKey(sessionKey)) {
    if (isHintSessionKey(sessionKey)) {
      selectionPolicy.recordCacheHint(sessionKey, accountId, Math.max(0, expiresAt - Date.now()));
      return { kind: 'hint-recorded' };
    }
    return { kind: 'not-applicable' };
  }
  const tableIncarnation = selectionPolicy.getTableIncarnation();
  if (expectedIncarnation !== undefined && expectedIncarnation !== tableIncarnation) {
    return { kind: 'rejected', reason: 'table-incarnation-mismatch' };
  }
  const current = selectionPolicy.getSessionBinding(sessionKey);
  if (current?.state === 'migrating') {
    if (!ownerRequestId || expectedGeneration === undefined) {
      return { kind: 'rejected', reason: 'migration-owner-required' };
    }
    return selectionPolicy.confirmSessionMigration(
      sessionKey, expectedGeneration, accountId, ownerRequestId, expiresAt, expectedIncarnation,
    )
      ? { kind: 'confirmed' }
      : { kind: 'rejected', reason: 'migration-confirmation-rejected' };
  }
  if (current && current.accountId !== accountId) {
    return { kind: 'rejected', reason: 'active-binding-conflict' };
  }
  if (current && expectedGeneration !== undefined && expectedGeneration !== current.generation) {
    return { kind: 'rejected', reason: 'generation-mismatch' };
  }
  const bound = selectionPolicy.bindSession(
    sessionKey,
    accountId,
    expiresAt,
    current ? (expectedGeneration ?? current.generation) : expectedGeneration,
    expectedIncarnation,
  );
  if (bound) return { kind: 'confirmed' };
  return { kind: 'rejected', reason: current ? 'active-bind-rejected' : 'initial-bind-rejected' };
}
import {
  AccountLeaseSelectionPolicy,
  isHintSessionKey,
  isVerifiedSessionKey,
} from './account-lease-selection-policy';
