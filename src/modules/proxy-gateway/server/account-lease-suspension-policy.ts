import type { AccountLeaseAccountStore } from './account-lease-adapters';
import type { AccountLeaseQuotaRefreshPolicy } from './account-lease-quota-refresh-policy';
import type { AccountLeaseTokenCache } from './account-lease-token-cache';
import type { AccountLeaseTokenData } from './account-lease-token-types';

export interface SuspensionReview {
  readonly accountId: string;
  readonly revision: number;
  isCurrent: () => boolean;
}

interface Options {
  accountStore: Pick<AccountLeaseAccountStore, 'suspendAccount'>;
  tokenCache: Pick<AccountLeaseTokenCache, 'loadAccounts'>;
  refreshPolicy: Pick<AccountLeaseQuotaRefreshPolicy, 'beginSnapshotReload' | 'canInstallSnapshot' | 'finishSnapshotReload' | 'invalidateActiveRefreshes'>;
  getTokens: () => Map<string, AccountLeaseTokenData>;
  setTokens: (tokens: Map<string, AccountLeaseTokenData>) => void;
  onCacheChange: () => void;
}

/** Fences pending/failed writes; successful suspension remains durable in the account store. */
export class AccountLeaseSuspensionPolicy {
  private readonly fenced = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();
  constructor(private readonly options: Options) {}

  suspend(accountId: string): Promise<void> {
    const existing = this.pending.get(accountId);
    if (existing) return existing;
    this.revisions.set(accountId, (this.revisions.get(accountId) ?? 0) + 1);
    this.fenced.add(accountId);
    this.options.refreshPolicy.invalidateActiveRefreshes();
    this.options.getTokens().delete(accountId);
    this.options.onCacheChange();
    const operation = (async () => {
      if (!this.options.accountStore.suspendAccount) throw new Error('Account store does not support durable suspension');
      await this.options.accountStore.suspendAccount(accountId);
      // A reload can begin while persistence is pending; invalidate it before dropping the fence.
      this.options.refreshPolicy.invalidateActiveRefreshes();
      this.fenced.delete(accountId);
    })().finally(() => {
      if (this.pending.get(accountId) === operation) this.pending.delete(accountId);
    });
    this.pending.set(accountId, operation);
    return operation;
  }

  async loadAccounts(): Promise<number> {
    const generation = this.options.refreshPolicy.beginSnapshotReload();
    try {
      const snapshot = await this.options.tokenCache.loadAccounts(this.options.getTokens());
      if (!snapshot || !this.options.refreshPolicy.canInstallSnapshot(generation)) return 0;
      for (const accountId of this.fenced) snapshot.tokens.delete(accountId);
      this.options.setTokens(snapshot.tokens);
      this.options.onCacheChange();
      return snapshot.tokens.size;
    } finally {
      this.options.refreshPolicy.finishSnapshotReload(generation);
    }
  }

  isFenced(accountId: string): boolean { return this.fenced.has(accountId); }

  async waitForPending(accountId: string): Promise<SuspensionReview> {
    while (this.pending.has(accountId)) {
      try { await this.pending.get(accountId); } catch { /* Reviewed activation can retry a failed durable write. */ }
    }
    const revision = this.revisions.get(accountId) ?? 0;
    return { accountId, revision, isCurrent: () => (this.revisions.get(accountId) ?? 0) === revision && !this.pending.has(accountId) };
  }

  clearAfterReview(accountId: string, review: SuspensionReview): void {
    if (review.accountId !== accountId || !review.isCurrent()) return;
    this.options.refreshPolicy.invalidateActiveRefreshes();
    this.fenced.delete(accountId);
  }
}
