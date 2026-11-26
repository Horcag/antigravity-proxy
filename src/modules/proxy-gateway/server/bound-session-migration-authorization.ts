import {
  createMigrationAuthorization,
  type AffinityBindingFence,
  type MigrationAuthorization,
} from './cache-affinity-coordinator';
import type { AccountLeaseTokenData } from './account-lease-token-types';

export function authorizeBoundSessionMigration(
  tokens: ReadonlyMap<string, AccountLeaseTokenData>,
  binding: (AffinityBindingFence & { accountId: string }) | null,
  sessionKey: string | undefined,
  model: string | undefined,
  ownerRequestId: string | undefined,
  isModelRequestable: (accountId: string, model: string) => boolean,
  isTemporarilyUnavailable: (accountId: string) => boolean,
): MigrationAuthorization | undefined {
  if (!binding) return undefined;
  const token = tokens.get(binding.accountId);
  const reason = !token ? 'account-deleted'
    : token.status === 'expired' ? 'account-disabled'
      : model && !isModelRequestable(binding.accountId, model) ? 'model-incompatible' : undefined;
  const authorizedReason = reason ?? (isTemporarilyUnavailable(binding.accountId) ? 'account-cooldown' : undefined);
  return authorizedReason ? createMigrationAuthorization(authorizedReason, sessionKey, binding, ownerRequestId) ?? undefined : undefined;
}

export function selectUnadvertisedFallbackCandidates<T extends [string, unknown]>(
  activeTokens: T[],
  model: string,
  hasHardCapabilityFailure: (accountId: string, modelId: string) => boolean,
): T[] {
  return activeTokens.filter(([accountId]) => !hasHardCapabilityFailure(accountId, model));
}
