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
): MigrationAuthorization | undefined {
  if (!binding) return undefined;
  const token = tokens.get(binding.accountId);
  const reason = !token ? 'account-deleted'
    : token.status === 'expired' ? 'account-disabled'
      : model && !isModelRequestable(binding.accountId, model) ? 'model-incompatible' : undefined;
  return reason ? createMigrationAuthorization(reason, sessionKey, binding, ownerRequestId) ?? undefined : undefined;
}
