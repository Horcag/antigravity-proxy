import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import {
  GoogleAPIService,
  type TokenResponse,
} from '@/modules/cloud-account/services/GoogleAPIService';

export const ACCOUNT_LEASE_ACCOUNT_STORE = Symbol('ACCOUNT_LEASE_ACCOUNT_STORE');
export const ACCOUNT_LEASE_UPSTREAM = Symbol('ACCOUNT_LEASE_UPSTREAM');

export interface AccountLeaseAccountStore {
  getAccounts(): Promise<CloudAccount[]>;
  getAccount(accountId: string): Promise<CloudAccount | undefined>;
  updateToken(accountId: string, token: CloudAccount['token']): Promise<void>;
  updateTokenIfCurrent(
    accountId: string,
    token: CloudAccount['token'],
    isCurrent: () => boolean,
  ): boolean;
  updateQuota(accountId: string, quota: CloudQuotaData): Promise<void>;
  updateQuotaIfCurrent(
    accountId: string,
    quota: CloudQuotaData,
    isCurrent: () => boolean,
  ): boolean;
  updateLastUsed(accountId: string, lastUsed: number): Promise<void>;
  updateLastUsedIfCurrent(
    accountId: string,
    lastUsed: number,
    isCurrent: () => boolean,
  ): boolean;
}

export interface AccountLeaseUpstream {
  fetchQuota(accessToken: string, proxyUrl?: string): Promise<CloudQuotaData>;
  refreshAccessToken(
    refreshToken: string,
    proxyUrl?: string,
    oauthClientKey?: string,
  ): Promise<TokenResponse>;
  fetchProjectId(accessToken: string, proxyUrl?: string): Promise<string | null>;
  normalizeRefreshedOAuthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined;
}

export const cloudAccountStoreAdapter: AccountLeaseAccountStore = {
  getAccounts: () => CloudAccountRepo.getAccounts(),
  getAccount: (accountId) => CloudAccountRepo.getAccount(accountId),
  updateToken: (accountId, token) => CloudAccountRepo.updateToken(accountId, token),
  updateTokenIfCurrent: (accountId, token, isCurrent) =>
    CloudAccountRepo.updateTokenIfCurrent(accountId, token, isCurrent),
  updateQuota: (accountId, quota) => CloudAccountRepo.updateQuota(accountId, quota),
  updateQuotaIfCurrent: (accountId, quota, isCurrent) =>
    CloudAccountRepo.updateQuotaIfCurrent(accountId, quota, isCurrent),
  updateLastUsed: (accountId, lastUsed) => CloudAccountRepo.updateLastUsed(accountId, lastUsed),
  updateLastUsedIfCurrent: (accountId, lastUsed, isCurrent) =>
    CloudAccountRepo.updateLastUsedIfCurrent(accountId, lastUsed, isCurrent),
};

export const googleAccountLeaseUpstreamAdapter: AccountLeaseUpstream = {
  fetchQuota: (accessToken, proxyUrl) => GoogleAPIService.fetchQuota(accessToken, proxyUrl),
  refreshAccessToken: (refreshToken, proxyUrl, oauthClientKey) =>
    GoogleAPIService.refreshAccessToken(refreshToken, proxyUrl, oauthClientKey),
  fetchProjectId: (accessToken, proxyUrl) =>
    proxyUrl
      ? GoogleAPIService.fetchProjectId(accessToken, proxyUrl)
      : GoogleAPIService.fetchProjectId(accessToken),
  normalizeRefreshedOAuthClientKey: (currentToken, refreshedClientKey) =>
    GoogleAPIService.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey),
};
