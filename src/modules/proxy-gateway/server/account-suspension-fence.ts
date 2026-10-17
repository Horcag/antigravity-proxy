import type { AccountLeaseAccountStore } from './account-lease-adapters';
import type { AccountLeaseTokenData } from './account-lease-token-types';
import type { AccountLeaseTokenCache } from './account-lease-token-cache';
import type { AccountLeaseQuotaRefreshPolicy } from './account-lease-quota-refresh-policy';
import type { AccountLeaseSelectionPolicy } from './account-lease-selection-policy';
import type { AccountPerformancePolicy } from './account-performance-policy';

export class AccountSuspensionFence {
  private readonly accountIds = new Set<string>();

  filter(tokens: Map<string, AccountLeaseTokenData>): void {
    for (const accountId of this.accountIds) tokens.delete(accountId);
  }

  async suspend(
    accountId: string,
    tokens: Map<string, AccountLeaseTokenData>,
    accountStore: AccountLeaseAccountStore,
    clearUnavailableState: () => void,
  ): Promise<void> {
    this.accountIds.add(accountId);
    tokens.delete(accountId);
    clearUnavailableState();
    if (!accountStore.suspendAccount) {
      throw new Error('Account store does not support persistent account suspension');
    }
    await accountStore.suspendAccount(accountId);
  }
}

export async function loadAccountLeaseSnapshot(
  tokenCache: AccountLeaseTokenCache,
  quotaRefreshPolicy: AccountLeaseQuotaRefreshPolicy,
  suspensionFence: AccountSuspensionFence,
  selectionPolicy: AccountLeaseSelectionPolicy,
  performancePolicy: AccountPerformancePolicy,
  installTokens: (tokens: Map<string, AccountLeaseTokenData>) => void,
): Promise<number> {
  const generation = quotaRefreshPolicy.beginSnapshotReload();
  try {
    const snapshot = await tokenCache.loadAccounts();
    if (!snapshot || !quotaRefreshPolicy.canInstallSnapshot(generation)) return 0;
    suspensionFence.filter(snapshot.tokens);
    installTokens(snapshot.tokens);
    selectionPolicy.clearSessionBindingsForUnavailableAccounts(new Set(snapshot.tokens.keys()));
    performancePolicy.resetAccounts(new Set(snapshot.tokens.keys()));
    return snapshot.tokens.size;
  } finally {
    quotaRefreshPolicy.finishSnapshotReload(generation);
  }
}
