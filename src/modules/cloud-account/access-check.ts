import type { CloudAccount } from './types';

export interface AccountAccessCheck {
  account_id: string;
  outcome: 'working' | 'banned' | 'inconclusive';
  checked_at: string;
  duration_ms?: number;
  reason: string;
  message: string;
  comparison: 'restored' | 'same' | 'changed' | 'first';
  previous_reason?: string;
  previous_checked_at?: string;
  evidence: { stage: 'generation' | 'oauth' | 'configuration'; model?: string; http_status?: number; rule_id?: string };
}

export function accountAccessCheckIdentity(account: CloudAccount): string {
  const token = Object.fromEntries(Object.entries(account.token).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([account.id, account.provider, account.email, account.created_at, token, account.proxy_url]);
}
