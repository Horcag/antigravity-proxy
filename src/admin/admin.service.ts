import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  CloudAccount,
  CloudAccountExport,
  CloudAccountExportSchema,
  CloudAccountSchema,
  CloudQuotaData,
} from '@/modules/cloud-account/types';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { getDatabasePath } from '@/shared/paths';

export interface SanitizedCloudAccount {
  id: string;
  provider: CloudAccount['provider'];
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  quota?: CloudQuotaData;
  created_at: number;
  last_used: number;
  status: CloudAccount['status'];
  status_reason?: string;
  is_active: boolean;
  proxy_url?: string;
  token: {
    has_access_token: boolean;
    has_refresh_token: boolean;
    expires_in: number;
    expiry_timestamp: number;
    token_type: string;
    email?: string;
    project_id?: string;
    oauth_client_key?: string;
    session_id?: string;
    has_id_token: boolean;
    upstream_proxy_url?: string;
    is_gcp_tos?: boolean;
  };
}

export interface ProxyAdminStatus {
  ok: true;
  account_count: number;
  active_account_count: number;
  data: {
    database_path: string;
  };
}

export interface ImportAccountsResult {
  imported: number;
  skipped: number;
  accounts: SanitizedCloudAccount[];
}

export interface OAuthExchangeRequest {
  code: string;
  proxy_url?: string;
  oauth_client_key?: string;
  fetch_quota?: boolean;
}

function requireObjectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new BadRequestException('Expected a JSON object payload');
  }
  return payload as Record<string, unknown>;
}

function normalizeImportPayload(payload: unknown): CloudAccountExport {
  const body = requireObjectPayload(payload);
  const candidate =
    body.version === '1.0'
      ? body
      : {
          version: '1.0',
          exportedAt: Math.floor(Date.now() / 1000),
          accounts: body.accounts,
        };

  const parsed = CloudAccountExportSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new BadRequestException({
      message: 'Invalid account import payload',
      issues: parsed.error.issues,
    });
  }

  return parsed.data;
}

function toSanitizedAccount(account: CloudAccount): SanitizedCloudAccount {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    name: account.name,
    avatar_url: account.avatar_url,
    quota: account.quota,
    created_at: account.created_at,
    last_used: account.last_used,
    status: account.status ?? 'active',
    status_reason: account.status_reason,
    is_active: account.is_active ?? false,
    proxy_url: account.proxy_url,
    token: {
      has_access_token: account.token.access_token.length > 0,
      has_refresh_token: account.token.refresh_token.length > 0,
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      token_type: account.token.token_type,
      email: account.token.email,
      project_id: account.token.project_id,
      oauth_client_key: account.token.oauth_client_key,
      session_id: account.token.session_id,
      has_id_token: Boolean(account.token.id_token),
      upstream_proxy_url: account.token.upstream_proxy_url,
      is_gcp_tos: account.token.is_gcp_tos,
    },
  };
}

function toExportAccount(
  account: CloudAccount,
  includeTokens: boolean,
): CloudAccountExport['accounts'][number] {
  return {
    provider: account.provider,
    email: account.email,
    name: account.name,
    avatar_url: account.avatar_url,
    token: includeTokens ? account.token : undefined,
    quota: account.quota,
    proxy_url: account.proxy_url,
    status: account.status,
    status_reason: account.status_reason,
  };
}

@Injectable()
export class AdminService {
  constructor(private readonly accountLeaseService: AccountLeaseService) {}

  async getStatus(): Promise<ProxyAdminStatus> {
    const accounts = await CloudAccountRepo.getAccounts();
    return {
      ok: true,
      account_count: accounts.length,
      active_account_count: accounts.filter((account) => account.status !== 'expired').length,
      data: {
        database_path: getDatabasePath(),
      },
    };
  }

  async listAccounts(): Promise<SanitizedCloudAccount[]> {
    const accounts = await CloudAccountRepo.getAccounts();
    return accounts.map((account) => toSanitizedAccount(account));
  }

  async importAccounts(payload: unknown): Promise<ImportAccountsResult> {
    const imported: SanitizedCloudAccount[] = [];
    let skipped = 0;
    const exportPayload = normalizeImportPayload(payload);
    const now = Math.floor(Date.now() / 1000);

    for (const account of exportPayload.accounts) {
      if (!account.token) {
        skipped += 1;
        continue;
      }

      const existing = await CloudAccountRepo.getAccountByEmail(account.email);
      const fullAccount = CloudAccountSchema.parse({
        id: existing?.id ?? uuidv4(),
        provider: account.provider,
        email: account.email,
        name: account.name ?? null,
        avatar_url: account.avatar_url ?? null,
        token: account.token,
        quota: account.quota,
        created_at: existing?.created_at ?? now,
        last_used: now,
        status: account.status ?? existing?.status ?? 'active',
        status_reason: account.status_reason,
        is_active: existing?.is_active ?? false,
        proxy_url: account.proxy_url ?? undefined,
      });

      await CloudAccountRepo.addAccount(fullAccount);
      imported.push(toSanitizedAccount(fullAccount));
    }

    await this.accountLeaseService.reloadAllAccounts();
    return {
      imported: imported.length,
      skipped,
      accounts: imported,
    };
  }

  async exportAccounts(includeTokens: boolean): Promise<CloudAccountExport> {
    const accounts = await CloudAccountRepo.getAccounts();
    return {
      version: '1.0',
      exportedAt: Math.floor(Date.now() / 1000),
      accounts: accounts.map((account) => toExportAccount(account, includeTokens)),
    };
  }

  async removeAccount(accountId: string): Promise<{ removed: true; account_id: string }> {
    const account = await CloudAccountRepo.getAccount(accountId);
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    await CloudAccountRepo.removeAccount(accountId);
    await this.accountLeaseService.reloadAllAccounts();
    return {
      removed: true,
      account_id: accountId,
    };
  }

  async reloadAccounts(): Promise<{ reloaded: true; account_count: number }> {
    const count = await this.accountLeaseService.reloadAllAccounts();
    return {
      reloaded: true,
      account_count: count,
    };
  }

  getOAuthUrl(oauthClientKey?: string): { url: string } {
    return {
      url: GoogleAPIService.getAuthUrl(oauthClientKey),
    };
  }

  async exchangeOAuthCode(request: OAuthExchangeRequest): Promise<SanitizedCloudAccount> {
    if (typeof request.code !== 'string' || request.code.trim() === '') {
      throw new BadRequestException('OAuth code is required');
    }

    const tokenResponse = await GoogleAPIService.exchangeCode(
      request.code.trim(),
      request.proxy_url,
      request.oauth_client_key,
    );
    if (!tokenResponse.refresh_token) {
      throw new BadRequestException('OAuth response did not include a refresh token');
    }

    const userInfo = await GoogleAPIService.getUserInfo(
      tokenResponse.access_token,
      request.proxy_url,
    );
    const existing = await CloudAccountRepo.getAccountByEmail(userInfo.email);
    const now = Math.floor(Date.now() / 1000);
    let quota: CloudQuotaData | undefined;
    if (request.fetch_quota ?? true) {
      quota = await GoogleAPIService.fetchQuota(tokenResponse.access_token, request.proxy_url);
    }

    const account = CloudAccountSchema.parse({
      id: existing?.id ?? uuidv4(),
      provider: 'google',
      email: userInfo.email,
      name: userInfo.name,
      avatar_url: userInfo.picture,
      token: {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_in: tokenResponse.expires_in,
        expiry_timestamp: now + tokenResponse.expires_in,
        token_type: tokenResponse.token_type,
        email: userInfo.email,
        oauth_client_key: tokenResponse.oauth_client_key,
        id_token: tokenResponse.id_token,
        upstream_proxy_url: request.proxy_url,
      },
      quota,
      created_at: existing?.created_at ?? now,
      last_used: now,
      status: 'active',
      is_active: existing?.is_active ?? false,
      proxy_url: request.proxy_url,
    });

    await CloudAccountRepo.addAccount(account);
    await this.accountLeaseService.reloadAllAccounts();
    return toSanitizedAccount(account);
  }
}
