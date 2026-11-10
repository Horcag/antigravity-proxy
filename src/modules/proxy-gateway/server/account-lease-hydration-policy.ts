import type { Logger } from '@nestjs/common';
import type { AccountLeaseAccountStore, AccountLeaseUpstream } from './account-lease-adapters';
import {
  type AccountLeaseTokenData,
  normalizeClientKey,
  normalizeProjectId,
} from './account-lease-token-types';

type AccountLeaseHydrationLogger = Pick<Logger, 'debug' | 'error' | 'log' | 'warn'>;

interface AccountLeaseHydrationPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseHydrationLogger;
  persistTokenState?: (
    accountId: string,
    tokenData: AccountLeaseTokenData,
  ) => Promise<boolean>;
}

interface HydrateSelectedTokenRequest {
  accountId: string;
  tokenData: AccountLeaseTokenData;
  nowSeconds: number;
  fallbackProjectId: string;
}

type SelectedTokenUseOutcome = 'recorded' | 'stale';

type HydratedSelectedTokenOutcome =
  | { outcome: 'hydrated'; projectId: string }
  | { outcome: 'stale' };

export class AccountLeaseHydrationPolicy {
  private readonly refreshLocks = new Map<string, Promise<boolean>>();
  private readonly projectIdLocks = new Map<string, Promise<string | undefined>>();

  constructor(private readonly options: AccountLeaseHydrationPolicyOptions) {}

  async hydrateSelectedToken(
    request: HydrateSelectedTokenRequest,
  ): Promise<HydratedSelectedTokenOutcome> {
    const { accountId, tokenData, nowSeconds, fallbackProjectId } = request;

    if (!this.isCurrentToken(accountId, tokenData)) {
      return { outcome: 'stale' };
    }

    if (!(await this.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds))) {
      return { outcome: 'stale' };
    }

    if (!this.isCurrentToken(accountId, tokenData)) {
      return { outcome: 'stale' };
    }

    if (normalizeProjectId(tokenData.project_id) === undefined) {
      tokenData.project_id = undefined;
    }
    let effectiveProjectId = tokenData.project_id;

    if (!effectiveProjectId) {
      effectiveProjectId = await this.resolveProjectIdWithLock(accountId, tokenData);
      if (!this.isCurrentToken(accountId, tokenData)) {
        return { outcome: 'stale' };
      }
    }

    if (!effectiveProjectId) {
      effectiveProjectId = fallbackProjectId;
      this.options.logger.warn(
        'Using non-persistent fallback project ID: operation=project_context reason=fallback_project',
      );
    }

    return { outcome: 'hydrated', projectId: effectiveProjectId };
  }

  async recordSelectedTokenUse(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    lastUsed: number,
  ): Promise<SelectedTokenUseOutcome> {
    const cachedToken = this.options.getTokenCache().get(accountId);
    if (cachedToken !== tokenData) {
      this.options.logger.debug(
        'Selected token recency update skipped: operation=record_selected_token reason=cache_changed',
      );
      return 'stale';
    }

    try {
      const persisted = this.options.accountStore.updateLastUsedIfCurrent(
        accountId,
        lastUsed,
        () => this.isCurrentToken(accountId, tokenData),
      );
      if (!persisted) {
        this.options.logger.debug(
          'Selected token recency update skipped: operation=record_selected_token reason=cache_changed',
        );
        return 'stale';
      }
      if (!this.isCurrentToken(accountId, tokenData)) {
        return 'stale';
      }
      tokenData.last_used = lastUsed;
    } catch {
      this.options.logger.error(
        'Selected token recency persistence failed: operation=record_selected_token reason=persistence_failed',
      );
      if (this.isCurrentToken(accountId, tokenData)) {
        tokenData.last_used = lastUsed;
      }
    }

    return this.isCurrentToken(accountId, tokenData) ? 'recorded' : 'stale';
  }

  async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ): Promise<boolean> {
    if (nowSeconds < tokenData.expiry_timestamp - 300) {
      return true;
    }

    const refreshed = await this.runAccountLock(this.refreshLocks, accountId, () =>
      this.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds),
    );
    return refreshed && this.isCurrentToken(accountId, tokenData);
  }

  async refreshSelectedTokenAfterAuthFailure(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ): Promise<boolean> {
    const refreshed = await this.runAccountLock(this.refreshLocks, accountId, () =>
      this.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds, true),
    );
    return refreshed && this.isCurrentToken(accountId, tokenData);
  }

  async refreshSelectedTokenLocked(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
    force = false,
  ): Promise<boolean> {
    const tokenCache = this.options.getTokenCache();
    const latestToken = tokenCache.get(accountId);
    if (latestToken !== tokenData) {
      this.options.logger.debug(
        'Token refresh skipped: operation=refresh_token reason=cache_changed',
      );
      return false;
    }

    if (!force && latestToken && nowSeconds < latestToken.expiry_timestamp - 300) {
      this.options.logger.debug(
        'Token refresh skipped: operation=refresh_token reason=already_refreshed',
      );
      return true;
    }

    const tokenToRefresh = latestToken;
    this.options.logger.log('Token refresh started: operation=refresh_token reason=refresh_required');
    try {
      const refreshedToken = await this.options.upstream.refreshAccessToken(
        tokenToRefresh.refresh_token,
        tokenToRefresh.upstream_proxy_url,
        tokenToRefresh.oauth_client_key,
      );
      if (!this.isCurrentToken(accountId, tokenToRefresh)) {
        this.options.logger.debug(
          'Token refresh result ignored: operation=refresh_token reason=cache_changed',
        );
        return false;
      }
      tokenToRefresh.access_token = refreshedToken.access_token;
      tokenToRefresh.refresh_token = refreshedToken.refresh_token ?? tokenToRefresh.refresh_token;
      tokenToRefresh.id_token = refreshedToken.id_token ?? tokenToRefresh.id_token;
      tokenToRefresh.scope = refreshedToken.scope ?? tokenToRefresh.scope;
      tokenToRefresh.expires_in = refreshedToken.expires_in;
      tokenToRefresh.expiry_timestamp = nowSeconds + refreshedToken.expires_in;
      tokenToRefresh.oauth_client_key = this.normalizeRefreshedOauthClientKey(
        tokenToRefresh,
        refreshedToken.oauth_client_key,
      );
      Object.assign(tokenData, tokenToRefresh);
      if (!this.isCurrentToken(accountId, tokenToRefresh)) {
        this.options.logger.debug(
          'Token refresh persistence skipped: operation=refresh_token reason=cache_changed',
        );
        return false;
      }
      if (
        !(await this.saveTokenState(accountId, tokenToRefresh)) ||
        !this.isCurrentToken(accountId, tokenToRefresh)
      ) {
        this.options.logger.debug(
          'Token refresh cache update skipped: operation=refresh_token reason=cache_changed',
        );
        return false;
      }
      tokenCache.set(accountId, tokenToRefresh);
      this.options.logger.log('Token refresh finished: operation=refresh_token reason=success');
      return true;
    } catch {
      this.options.logger.error(
        'Token refresh failed: operation=refresh_token reason=refresh_failed',
      );
      return this.isCurrentToken(accountId, tokenToRefresh);
    }
  }

  async resolveProjectIdWithLock(
    accountId: string,
    tokenData: AccountLeaseTokenData,
  ): Promise<string | undefined> {
    if (!this.isCurrentToken(accountId, tokenData)) {
      return undefined;
    }

    const existingProjectId = normalizeProjectId(
      this.options.getTokenCache().get(accountId)?.project_id,
    );
    if (existingProjectId) {
      tokenData.project_id = existingProjectId;
      return existingProjectId;
    }

    const projectId = await this.runAccountLock(this.projectIdLocks, accountId, () =>
      this.resolveProjectIdLocked(accountId, tokenData),
    );
    if (projectId && this.isCurrentToken(accountId, tokenData)) {
      tokenData.project_id = projectId;
    }

    return projectId;
  }

  async runAccountLock<T>(
    locks: Map<string, Promise<T>>,
    accountId: string,
    createPromise: () => Promise<T>,
  ): Promise<T> {
    const existingPromise = locks.get(accountId);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = createPromise();
    locks.set(accountId, promise);
    try {
      return await promise;
    } finally {
      if (locks.get(accountId) === promise) {
        locks.delete(accountId);
      }
    }
  }

  syncTokenDataFromCache(accountId: string, tokenData: AccountLeaseTokenData): void {
    if (!this.isCurrentToken(accountId, tokenData)) {
      return;
    }
  }

  async resolveProjectIdLocked(
    accountId: string,
    tokenData: AccountLeaseTokenData,
  ): Promise<string | undefined> {
    const tokenCache = this.options.getTokenCache();
    const latestToken = tokenCache.get(accountId);
    if (latestToken !== tokenData) {
      return undefined;
    }

    const existingProjectId = normalizeProjectId(latestToken.project_id);
    if (existingProjectId) {
      tokenData.project_id = existingProjectId;
      return existingProjectId;
    }

    try {
      const fetchedProjectId = await this.options.upstream.fetchProjectId(
        latestToken.access_token,
        latestToken.upstream_proxy_url,
      );
      if (!this.isCurrentToken(accountId, latestToken)) {
        this.options.logger.debug(
          'Project ID result ignored: operation=project_context reason=cache_changed',
        );
        return undefined;
      }

      const normalizedProjectId = normalizeProjectId(fetchedProjectId);
      if (normalizedProjectId) {
        latestToken.project_id = normalizedProjectId;
        tokenData.project_id = normalizedProjectId;
        if (!this.isCurrentToken(accountId, latestToken)) {
          return undefined;
        }
        if (
          !(await this.saveTokenState(accountId, latestToken)) ||
          !this.isCurrentToken(accountId, latestToken)
        ) {
          return undefined;
        }
        tokenCache.set(accountId, latestToken);
        this.options.logger.log(
          'Project ID resolved: operation=project_context reason=project_resolved',
        );
        return normalizedProjectId;
      }

      this.options.logger.warn(
        'Project ID unavailable: operation=project_context reason=project_unavailable',
      );
    } catch {
      this.options.logger.warn(
        'Project ID resolution failed: operation=project_context reason=project_lookup_failed',
      );
    }

    return undefined;
  }

  async persistTokenState(accountId: string, tokenData: AccountLeaseTokenData): Promise<boolean> {
    try {
      if (!this.isCurrentToken(accountId, tokenData)) {
        return false;
      }

      const persistedAccount = await this.options.accountStore.getAccount(accountId);
      if (!this.isCurrentToken(accountId, tokenData)) {
        return false;
      }

      if (persistedAccount?.token) {
        const updatedToken = {
          ...persistedAccount.token,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          id_token: tokenData.id_token ?? persistedAccount.token.id_token,
          scope: tokenData.scope ?? persistedAccount.token.scope,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id ?? persistedAccount.token.project_id,
          oauth_client_key:
            tokenData.oauth_client_key ??
            normalizeClientKey(persistedAccount.token.oauth_client_key) ??
            persistedAccount.token.oauth_client_key,
          session_id: tokenData.session_id ?? persistedAccount.token.session_id,
          upstream_proxy_url:
            tokenData.upstream_proxy_url ?? persistedAccount.token.upstream_proxy_url,
        };
        if (!this.isCurrentToken(accountId, tokenData)) {
          return false;
        }
        return this.options.accountStore.updateTokenIfCurrent(accountId, updatedToken, () =>
          this.isCurrentToken(accountId, tokenData),
        );
      }
      return false;
    } catch {
      this.options.logger.error(
        'Token persistence failed: operation=persist_token reason=persistence_failed',
      );
      return false;
    }
  }

  normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return this.options.upstream.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey);
  }

  private async saveTokenState(
    accountId: string,
    tokenData: AccountLeaseTokenData,
  ): Promise<boolean> {
    if (!this.isCurrentToken(accountId, tokenData)) {
      return false;
    }

    if (this.options.persistTokenState) {
      const persisted = await this.options.persistTokenState(accountId, tokenData);
      return persisted !== false && this.isCurrentToken(accountId, tokenData);
    }

    return this.persistTokenState(accountId, tokenData);
  }

  private isCurrentToken(accountId: string, tokenData: AccountLeaseTokenData): boolean {
    return this.options.getTokenCache().get(accountId) === tokenData;
  }
}
