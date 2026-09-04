import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROXY_CONFIG, ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';
import { GoogleAPIService, type TokenResponse } from '@/modules/cloud-account/services/GoogleAPIService';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/proxy-model-availability-store';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/account-lease-adapters';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';

function createProxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    ...DEFAULT_PROXY_CONFIG,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_PROXY_CONFIG.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
  };
}

function seedTokens(service: AccountLeaseService): void {
  const nowSec = Math.floor(Date.now() / 1000);
  (service as any).tokens = new Map([
    [
      'acc-1',
      {
        account_id: 'acc-1',
        email: 'acc-1@test.dev',
        access_token: 'token-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-1',
        session_id: 'session-1',
      },
    ],
    [
      'acc-2',
      {
        account_id: 'acc-2',
        email: 'acc-2@test.dev',
        access_token: 'token-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-2',
        session_id: 'session-2',
      },
    ],
  ]);
}

function quota(models: Record<string, number>): CloudQuotaData {
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([model, percentage]) => [
        model,
        {
          percentage,
          resetTime: '2026-09-02T12:00:00.000Z',
          max_output_tokens: percentage * 100,
        },
      ]),
    ),
  };
}

function account(id: string, accountQuota?: CloudQuotaData, expiryTimestamp?: number): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@test.dev`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: expiryTimestamp ?? Math.floor(Date.now() / 1000) + 3600,
      project_id: `project-${id}`,
    },
    quota: accountQuota,
    created_at: 1,
    last_used: 1,
  };
}

function createAccountStore(accounts: CloudAccount[]): AccountLeaseAccountStore {
  return {
    getAccounts: vi.fn().mockResolvedValue(accounts),
    getAccount: vi.fn(async (accountId: string) => accounts.find((item) => item.id === accountId)),
    updateToken: vi.fn(async (accountId: string, token: CloudAccount['token']) => {
      const target = accounts.find((item) => item.id === accountId);
      if (target) {
        target.token = token;
      }
    }),
    updateQuota: vi.fn(async (accountId: string, refreshedQuota: CloudQuotaData) => {
      const target = accounts.find((item) => item.id === accountId);
      if (target) {
        target.quota = refreshedQuota;
      }
    }),
  };
}

function createUpstream(overrides: Partial<AccountLeaseUpstream>): AccountLeaseUpstream {
  return {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn((currentToken, refreshedClientKey) =>
      refreshedClientKey ?? currentToken.oauth_client_key,
    ),
    ...overrides,
  };
}

describe('AccountLeaseService parity scheduling replay', () => {
  let service: AccountLeaseService;

  beforeEach(() => {
    service = new AccountLeaseService();
    seedTokens(service);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rewrites gemini pro model to first available account candidate', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
          model_quotas: {
            'gemini-3.1-pro-low': 80,
          },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const resolved = service.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro');
    expect(resolved).toBe('gemini-3.1-pro-low');
  });

  it('routes an explicit flash tier to an advertised tiered preset', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
          model_quotas: { 'gemini-3.8-flash-tiered': 99 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    expect(service.getModelCapableAccountCount('gemini-3.8-flash-low')).toBe(1);
    await expect(service.getNextToken({ model: 'gemini-3.8-flash-low' })).resolves.toEqual(
      expect.objectContaining({ id: 'acc-1' }),
    );
    expect(service.resolveDynamicModelForAccount('acc-1', 'gemini-3.8-flash-low')).toBe(
      'gemini-3.8-flash-tiered',
    );
  });

  it('resolves a stable image capability alias to the advertised upstream image model', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-image',
        {
          account_id: 'acc-image',
          email: 'acc-image@test.dev',
          access_token: 'token-image',
          refresh_token: 'refresh-image',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-image',
          model_quotas: { 'gemini-3.1-flash-image': 99 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    expect(service.getModelCapableAccountCount('gemini-3-pro-image')).toBe(1);
    await expect(service.getNextToken({ model: 'gemini-3-pro-image' })).resolves.toEqual(
      expect.objectContaining({ id: 'acc-image' }),
    );
    expect(service.resolveDynamicModelForAccount('acc-image', 'gemini-3-pro-image')).toBe(
      'gemini-3.1-flash-image',
    );
  });

  it('offers every compatible account once so failover is not capped at three accounts', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map(
      Array.from({ length: 5 }, (_, index) => {
        const accountId = `acc-${index + 1}`;
        return [
          accountId,
          {
            account_id: accountId,
            email: `${accountId}@test.dev`,
            access_token: `token-${accountId}`,
            refresh_token: `refresh-${accountId}`,
            token_type: 'Bearer',
            expires_in: 3600,
            expiry_timestamp: nowSec + 3600,
            project_id: `project-${accountId}`,
            model_quotas: { 'gemini-3.1-flash-image': 99 },
            model_limits: {},
            model_reset_times: {},
            model_forwarding_rules: {},
          },
        ];
      }),
    );

    expect(service.getModelCapableAccountCount('gemini-3-pro-image')).toBe(5);
    const attemptedAccountIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const token = await service.getNextToken({
        model: 'gemini-3-pro-image',
        excludeAccountIds: attemptedAccountIds,
      });
      expect(token).not.toBeNull();
      attemptedAccountIds.push(token!.id);
    }

    expect(new Set(attemptedAccountIds).size).toBe(5);
    await expect(
      service.getNextToken({
        model: 'gemini-3-pro-image',
        excludeAccountIds: attemptedAccountIds,
      }),
    ).resolves.toBeNull();
  });

  it('skips an account after an effective image model is marked unavailable', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = (accountId: string) => ({
      account_id: accountId,
      email: `${accountId}@test.dev`,
      access_token: `token-${accountId}`,
      refresh_token: `refresh-${accountId}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec + 3600,
      project_id: `project-${accountId}`,
      model_quotas: { 'gemini-3.1-flash-image': 99 },
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    });
    (service as any).tokens = new Map([
      ['acc-image-1', tokenData('acc-image-1')],
      ['acc-image-2', tokenData('acc-image-2')],
    ]);
    proxyModelAvailabilityStore.mark(
      'acc-image-1',
      'gemini-3.1-flash-image',
      'quota_exhausted',
    );

    await expect(service.getNextToken({ model: 'gemini-3-pro-image' })).resolves.toEqual(
      expect.objectContaining({ id: 'acc-image-2' }),
    );
    proxyModelAvailabilityStore.clearAccount('acc-image-1');
  });

  it('keeps original model when dynamic rewrite is not applicable', () => {
    const resolved = service.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash');
    expect(resolved).toBe('gemini-3-flash');
  });

  it('selects an account that advertises the requested dynamic model', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          model_quotas: { 'gemini-3-flash': 80 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
      [
        'acc-2',
        {
          account_id: 'acc-2',
          email: 'acc-2@test.dev',
          access_token: 'token-2',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-2',
          model_quotas: { 'gpt-oss-120b-medium': 80 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const fetchProjectIdSpy = vi
      .spyOn(GoogleAPIService, 'fetchProjectId')
      .mockRejectedValue(new Error('Project ID lookup must not run during model selection'));
    const fetchProjectContextSpy = vi
      .spyOn(GoogleAPIService, 'fetchProjectContext')
      .mockRejectedValue(new Error('Project context lookup must not run during model selection'));

    const selected = await service.getNextToken({ model: 'gpt-oss-120b-medium' });

    expect(selected?.id).toBe('acc-2');
    expect(fetchProjectIdSpy).not.toHaveBeenCalled();
    expect(fetchProjectContextSpy).not.toHaveBeenCalled();

    fetchProjectIdSpy.mockRestore();
    fetchProjectContextSpy.mockRestore();
  });

  it('refreshes quota catalog before rejecting a newly available model', async () => {
    const accounts = [account('acc-1', quota({ 'gemini-3.7-flash-high': 10 }))];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      fetchQuota: vi.fn().mockResolvedValue(quota({ 'gemini-new-flash-high': 88 })),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(
      service.getRefreshedModelCapableAccountCount('gemini-new-flash-high'),
    ).resolves.toBe(1);
    await expect(service.getNextToken({ model: 'gemini-new-flash-high' })).resolves.toEqual(
      expect.objectContaining({ id: 'acc-1' }),
    );
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
    expect(store.updateQuota).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        models: expect.objectContaining({
          'gemini-new-flash-high': expect.any(Object),
        }),
      }),
    );
  });

  it('coalesces concurrent forced quota catalog refreshes', async () => {
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }))];
    const store = createAccountStore(accounts);
    let resolveQuota: ((value: CloudQuotaData) => void) | undefined;
    const upstream = createUpstream({
      fetchQuota: vi.fn(
        () =>
          new Promise<CloudQuotaData>((resolve) => {
            resolveQuota = resolve;
          }),
      ),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    const first = service.getRefreshedModelCapableAccountCount('gemini-new-flash-high');
    const second = service.getRefreshedModelCapableAccountCount('gemini-new-flash-high');
    await Promise.resolve();

    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
    resolveQuota?.(quota({ 'gemini-new-flash-high': 77 }));
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });

  it('keeps the last good quota snapshot when refresh fails', async () => {
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 42 }))];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      fetchQuota: vi.fn().mockRejectedValue(new Error('quota endpoint down')),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 0,
      failed: 1,
    });

    expect(service.getAllCollectedModels()).toContain('gemini-old-flash-high');
    expect(service.getAllCollectedModels()).not.toContain('gemini-new-flash-high');
    expect(store.updateQuota).not.toHaveBeenCalled();
  });

  it('replaces stale quota and model limits with current quota metadata', async () => {
    const accounts = [account('acc-1', quota({ 'gemini-refresh-flash-high': 12 }))];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      fetchQuota: vi.fn().mockResolvedValue(quota({ 'gemini-refresh-flash-high': 91 })),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 1,
      failed: 0,
    });

    expect(service.getModelOutputLimitForAccount('acc-1', 'gemini-refresh-flash-high')).toBe(9100);
  });

  it('hydrates an expired access token through the existing policy before quota refresh', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }), nowSec - 1)];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: 'access-new',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
      fetchQuota: vi.fn().mockResolvedValue(quota({ 'gemini-new-flash-high': 66 })),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await service.refreshQuotaCatalog({ force: true });

    expect(upstream.refreshAccessToken).toHaveBeenCalledWith('refresh-acc-1', undefined, undefined);
    expect(upstream.fetchQuota).toHaveBeenCalledWith('access-new', undefined);
  });

  it('refreshes access token once after quota endpoint rejects an unexpired token', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }), nowSec + 3600)];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: 'access-after-401',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
      fetchQuota: vi
        .fn()
        .mockRejectedValueOnce(new Error('UNAUTHORIZED'))
        .mockResolvedValueOnce(quota({ 'gemini-new-flash-high': 66 })),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 1,
      failed: 0,
    });

    expect(upstream.refreshAccessToken).toHaveBeenCalledWith('refresh-acc-1', undefined, undefined);
    expect(upstream.fetchQuota).toHaveBeenNthCalledWith(1, 'access-acc-1', undefined);
    expect(upstream.fetchQuota).toHaveBeenNthCalledWith(2, 'access-after-401', undefined);
  });

  it('cools down repeated forced refreshes for a still-unknown model', async () => {
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }))];
    const upstream = createUpstream({
      fetchQuota: vi.fn().mockResolvedValue(quota({ 'gemini-old-flash-high': 10 })),
    });
    service = new AccountLeaseService(createAccountStore(accounts), upstream);
    await service.loadAccounts();

    await expect(
      service.getRefreshedModelCapableAccountCount('gemini-still-missing-high'),
    ).resolves.toBe(0);
    await expect(
      service.getRefreshedModelCapableAccountCount('gemini-still-missing-high'),
    ).resolves.toBe(0);

    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it('does not mark a cooldown-only catalog scan fresh for ten minutes', async () => {
    const baseNowMs = 1_000_000;
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }))];
    const upstream = createUpstream({
      fetchQuota: vi
        .fn()
        .mockRejectedValueOnce(new Error('quota endpoint down'))
        .mockResolvedValueOnce(quota({ 'gemini-new-flash-high': 66 })),
    });
    service = new AccountLeaseService(createAccountStore(accounts), upstream);
    await service.loadAccounts();

    await expect(
      (service as any).quotaRefreshPolicy.refreshQuotaCatalog({ force: true, nowMs: baseNowMs }),
    ).resolves.toMatchObject({ refreshed: 0, failed: 1 });
    await expect(
      (service as any).quotaRefreshPolicy.refreshQuotaCatalog({ nowMs: baseNowMs + 1_000 }),
    ).resolves.toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    await expect(
      (service as any).quotaRefreshPolicy.refreshQuotaCatalog({ nowMs: baseNowMs + 61_001 }),
    ).resolves.toMatchObject({ refreshed: 1, skipped: 0, failed: 0 });

    expect(upstream.fetchQuota).toHaveBeenCalledTimes(2);
    expect(service.getAllCollectedModels()).toContain('gemini-new-flash-high');
  });

  it('does not resurrect an account removed while quota refresh is in flight', async () => {
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }))];
    const store = createAccountStore(accounts);
    let resolveQuota: ((value: CloudQuotaData) => void) | undefined;
    const upstream = createUpstream({
      fetchQuota: vi.fn(
        () =>
          new Promise<CloudQuotaData>((resolve) => {
            resolveQuota = resolve;
          }),
      ),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    const refresh = service.refreshQuotaCatalog({ force: true });
    await Promise.resolve();
    accounts.length = 0;
    await service.reloadAllAccounts();
    resolveQuota?.(quota({ 'gemini-new-flash-high': 66 }));

    await expect(refresh).resolves.toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    expect(service.getAccountCount()).toBe(0);
    expect(store.updateQuota).not.toHaveBeenCalled();
  });

  it('does not persist or cache an access token refreshed after account removal', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }), nowSec - 1)];
    const store = createAccountStore(accounts);
    let resolveRefresh: ((value: TokenResponse) => void) | undefined;
    const upstream = createUpstream({
      refreshAccessToken: vi.fn(
        () =>
          new Promise<TokenResponse>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    const tokenData = (service as any).tokens.get('acc-1');

    const selected = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    await Promise.resolve();
    accounts.length = 0;
    await service.reloadAllAccounts();
    resolveRefresh?.({
      access_token: 'access-after-removal',
      expires_in: 7200,
      token_type: 'Bearer',
    });

    await selected;
    expect(service.getAccountCount()).toBe(0);
    expect(store.updateToken).not.toHaveBeenCalled();
  });

  it('tears down the periodic quota catalog refresh lifecycle', async () => {
    vi.useFakeTimers();
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }))];
    const upstream = createUpstream({
      fetchQuota: vi.fn().mockResolvedValue(quota({ 'gemini-new-flash-high': 66 })),
    });
    service = new AccountLeaseService(createAccountStore(accounts), upstream);

    await service.onModuleInit();
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(2);
  });

  it('passes oauth_client_key when refreshing token and persists refreshed key', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec - 1,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      expires_in: 7200,
      token_type: 'Bearer',
      oauth_client_key: 'custom-fallback',
    });
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const selected = await (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);

    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', 'http://127.0.0.1:8080', 'custom-client');
    expect(persistSpy).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        refresh_token: 'refresh-new',
        id_token: 'id-new',
      }),
    );
    expect(selected?.token.refresh_token).toBe('refresh-new');
    expect(selected?.token.id_token).toBe('id-new');
    expect(selected?.token.oauth_client_key).toBe('custom-fallback');
    expect((service as any).tokens.get('acc-1')?.oauth_client_key).toBe('custom-fallback');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('refreshes selected token when expiry is inside the request timeout buffer', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec + 100,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      expires_in: 7200,
      token_type: 'Bearer',
    });
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const selected = await (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);

    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', undefined, undefined);
    expect(selected?.token.access_token).toBe('token-new');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('coalesces concurrent token refreshes for the same account', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec - 1,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    let resolveRefresh: (() => void) | undefined;
    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            resolve({
              access_token: 'token-new',
              expires_in: 7200,
              token_type: 'Bearer',
              oauth_client_key: 'custom-client',
            });
          };
        }),
    );
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const first = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    const second = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    resolveRefresh?.();

    const selected = await Promise.all([first, second]);
    expect(selected[0]?.token.access_token).toBe('token-new');
    expect(selected[1]?.token.access_token).toBe('token-new');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('keeps oauth_client_key unset for legacy account refreshed by enterprise client', () => {
    const normalized = (service as any).normalizeRefreshedOauthClientKey(
      {
        oauth_client_key: undefined,
        project_id: undefined,
      },
      'antigravity_enterprise',
    );

    expect(normalized).toBeUndefined();
  });

  it('prioritizes preferred account in parity mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: 'acc-2',
      }),
    );

    const token = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(token?.id).toBe('acc-2');
  });

  it('rotates sticky account when limited in balance mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: '',
      }),
    );

    const first = await service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    expect(first?.id).toBe('acc-1');

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      }),
    });

    const second = await service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    expect(second?.id).toBe('acc-2');
  });

  it('applies model-level lock for quota exhausted only on the same model', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'performance-first',
      }),
    );

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '30s' } }],
        },
      }),
    });

    const sameModel = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(sameModel?.id).toBe('acc-2');

    const otherModel = await service.getNextToken({
      model: 'gemini-2.5-pro',
      excludeAccountIds: ['acc-2'],
    });
    expect(otherModel?.id).toBe('acc-1');
  });

  it('does not retry an account already attempted by the same request', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        parity_kill_switch: false,
      }),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
        },
      ],
    ]);

    const token = await service.getNextToken({ excludeAccountIds: ['acc-1'] });
    expect(token).toBeNull();
  });
});
