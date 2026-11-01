import type { CloudAccount } from '@/modules/cloud-account/types';
import type { AccountLeaseAccountStore } from './account-lease-adapters';
import { buildAccountLeaseQuotaSnapshot } from './account-lease-quota-policy';
import { type AccountLeaseTokenData, normalizeClientKey } from './account-lease-token-types';

interface AccountLeaseTokenCacheLogger {
  error(message: string, error?: unknown): void;
  log(message: string): void;
}

interface AccountLeaseTokenCacheOptions {
  accountStore: AccountLeaseAccountStore;
  logger: AccountLeaseTokenCacheLogger;
}

export interface AccountLeaseTokenCacheSnapshot {
  count: number;
  tokens: Map<string, AccountLeaseTokenData>;
}

export class AccountLeaseTokenCache {
  constructor(private readonly options: AccountLeaseTokenCacheOptions) {}

  async loadAccounts(
    currentTokens?: ReadonlyMap<string, AccountLeaseTokenData>,
  ): Promise<AccountLeaseTokenCacheSnapshot | null> {
    try {
      const accounts = await this.options.accountStore.getAccounts();
      let count = 0;
      const tokens = new Map<string, AccountLeaseTokenData>();

      for (const account of accounts) {
        const tokenData = this.mapAccountToTokenData(account, currentTokens?.get(account.id)?.session_id);
        if (tokenData) {
          tokens.set(account.id, tokenData);
          count++;
        }
      }

      this.options.logger.log(`Account lease loaded ${count} cloud accounts into cache`);
      return {
        count,
        tokens,
      };
    } catch (error) {
      this.options.logger.error('Failed to load cloud accounts into token cache', error);
      return null;
    }
  }

  mapAccountToTokenData(account: CloudAccount, existingSessionId?: string): AccountLeaseTokenData | null {
    if (!account.token || account.status === 'expired') {
      return null;
    }

    const quota = account.quota;
    const extractedState = buildAccountLeaseQuotaSnapshot(quota);

    return {
      account_id: account.id,
      email: account.email,
      access_token: account.token.access_token,
      refresh_token: account.token.refresh_token,
      id_token: account.token.id_token,
      oauth_client_key: normalizeClientKey(account.token.oauth_client_key),
      token_type: account.token.token_type || 'Bearer',
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || existingSessionId || this.generateSessionId(),
      upstream_proxy_url: account.token.upstream_proxy_url || account.proxy_url || undefined,
      quota,
      last_successful_quota_refresh_at: quota?.last_successful_refresh_at,
      status: account.status ?? 'active',
      model_quotas: extractedState.modelQuotas,
      model_limits: extractedState.modelLimits,
      model_reset_times: extractedState.modelResetTimes,
      model_forwarding_rules: extractedState.modelForwardingRules,
      last_used: account.last_used,
    };
  }

  private generateSessionId(): string {
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }
}
