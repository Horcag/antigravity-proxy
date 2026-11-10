import { isString } from 'lodash-es';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';

export interface AccountLeaseTokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  id_token?: string;
  oauth_client_key?: string;
  scope?: string;
  is_gcp_tos?: boolean;
  token_type: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
  upstream_proxy_url?: string;
  quota?: CloudQuotaData;
  last_successful_quota_refresh_at?: number;
  status?: CloudAccount['status'];
  model_quotas: Record<string, number>;
  model_limits: Record<string, number>;
  model_reset_times: Record<string, string>;
  model_forwarding_rules: Record<string, string>;
  last_used?: number;
}

export function normalizeProjectId(projectId: string | null | undefined): string | undefined {
  if (!isString(projectId)) {
    return undefined;
  }

  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId === '' || /^cloud-code-\d+$/i.test(trimmedProjectId)) {
    return undefined;
  }

  if (/^projects(?:\/.*)?$/i.test(trimmedProjectId)) {
    return undefined;
  }

  return trimmedProjectId;
}

export function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }
  const normalized = modelId.replace(/^models\//i, '').trim();
  return normalized !== '' ? normalized : undefined;
}

export function normalizeClientKey(clientKey: string | undefined): string | undefined {
  if (!isString(clientKey)) {
    return undefined;
  }
  const normalized = clientKey.trim().toLowerCase();
  return normalized !== '' ? normalized : undefined;
}

export interface QuotaDiagnosticsTemporaryBlock {
  reason: string;
  unavailable_until: string;
  remaining_seconds: number;
}
export interface AccountQuotaDiagnosticsModel {
  public_model_id: string;
  physical_model_id: string;
  remaining_percentage: number | null;
  reset_time: string | null;
  availability: 'unknown' | 'available' | 'unavailable';
  requestable: boolean;
  temporary_block?: QuotaDiagnosticsTemporaryBlock;
}
export interface AccountQuotaDiagnostics {
  /** Request-local ordinal only; it is not stable across diagnostic responses. */
  account_label: string;
  status: 'active' | 'rate_limited';
  last_successful_refresh_at: string | null;
  refresh_age_seconds: number | null;
  refresh_state: 'fresh' | 'stale' | 'unknown';
  account_cooldown?: QuotaDiagnosticsTemporaryBlock;
  models: AccountQuotaDiagnosticsModel[];
}
export interface QuotaDiagnostics {
  refresh_interval_seconds: number;
  accounts: AccountQuotaDiagnostics[];
}
