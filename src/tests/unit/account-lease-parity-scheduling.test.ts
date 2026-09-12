import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROXY_CONFIG, ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';
import { resolveModelRoute } from '../../modules/proxy-gateway/antigravity/ModelMapping';
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

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

function createAccountStore(accounts: CloudAccount[]): AccountLeaseAccountStore {
  const store = {
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
    updateQuotaIfCurrent: vi.fn(() => false),
    updateLastUsed: vi.fn(async (accountId: string, lastUsed: number) => {
      const target = accounts.find((item) => item.id === accountId);
      if (target) {
        target.last_used = lastUsed;
      }
    }),
    updateTokenIfCurrent: vi.fn(() => false),
    updateLastUsedIfCurrent: vi.fn(() => false),
  } as AccountLeaseAccountStore;
  store.updateTokenIfCurrent = vi.fn((accountId, token, isCurrent) => {
    if (!isCurrent()) {
      return false;
    }
    const target = accounts.find((item) => item.id === accountId);
    if (target) {
      target.token = token;
    }
    return true;
  });
  store.updateQuotaIfCurrent = vi.fn((accountId, refreshedQuota, isCurrent) => {
    if (!isCurrent()) {
      return false;
    }
    void store.updateQuota(accountId, refreshedQuota);
    return true;
  });
  store.updateLastUsedIfCurrent = vi.fn((accountId, lastUsed, isCurrent) => {
    if (!isCurrent()) {
      return false;
    }
    const target = accounts.find((item) => item.id === accountId);
    if (target) {
      target.last_used = lastUsed;
    }
    return true;
  });
  return store;
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
    for (const { accountId } of proxyModelAvailabilityStore.getSnapshot()) {
      proxyModelAvailabilityStore.clearAccount(accountId);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('removes only the refreshed account forwarding rule without disturbing sibling routing', async () => {
    const accounts = [
      account('forwarding', {
        ...quota({ 'provider-flash': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-flash' },
      }),
      account('sibling', quota({ 'public-flash': 100 })),
    ];
    const upstream = createUpstream({
      fetchQuota: vi.fn((accessToken: string) =>
        Promise.resolve(
          accessToken === 'access-forwarding'
            ? quota({ 'provider-flash': 100 })
            : quota({ 'public-flash': 100 }),
        ),
      ),
    });
    service = new AccountLeaseService(createAccountStore(accounts), upstream);
    await service.loadAccounts();
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
    expect(service.resolveDynamicModelForAccount('forwarding', 'public-flash')).toBe(
      'provider-flash',
    );
    expect(service.resolveDynamicModelForAccount('sibling', 'public-flash')).toBe('public-flash');

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 2,
      failed: 0,
    });

    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
    expect(service.resolveDynamicModelForAccount('forwarding', 'public-flash')).toBe(
      'public-flash',
    );
    expect(resolveModelRoute('configured-model', { 'configured-model': 'static-provider' }, {}, {})).toBe(
      'static-provider',
    );
    await expect(service.getNextToken({ model: 'public-flash' })).resolves.toMatchObject({
      id: 'sibling',
    });
  });

  it('clears learned capability rejection only for the refreshed account and advertised model', async () => {
    const accounts = [
      account('refreshed', quota({ 'gemini-3.8-flash-high': 100 })),
      account('unrefreshed', quota({ 'gemini-3.8-flash-high': 100 })),
    ];
    const upstream = createUpstream({
      fetchQuota: vi.fn((accessToken: string) => {
        if (accessToken === 'access-refreshed') {
          return Promise.resolve(quota({ 'gemini-3.8-flash-high': 100 }));
        }
        return Promise.reject(new Error('unrefreshed quota unavailable'));
      }),
    });
    service = new AccountLeaseService(createAccountStore(accounts), upstream);
    await service.loadAccounts();
    proxyModelAvailabilityStore.mark(
      'refreshed',
      'gemini-3.8-flash-high',
      'model_not_supported',
    );
    proxyModelAvailabilityStore.mark(
      'unrefreshed',
      'gemini-3.8-flash-high',
      'model_not_supported',
    );

    await expect(service.refreshQuotaCatalog({ force: true, model: 'gemini-3.8-flash-high' })).resolves.toMatchObject({
      refreshed: 1,
      failed: 1,
    });

    expect(proxyModelAvailabilityStore.isAvailable('refreshed', 'gemini-3.8-flash-high')).toBe(true);
    expect(proxyModelAvailabilityStore.isAvailable('unrefreshed', 'gemini-3.8-flash-high')).toBe(
      false,
    );
  });

  it('keeps conflicting forwarding rules isolated to the selected account', async () => {
    const accounts = [
      account('account-b', {
        ...quota({ 'provider-b': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-b' },
      }),
      account('account-a', {
        ...quota({ 'provider-a': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-a' },
      }),
    ];
    accounts.forEach((item) => {
      item.last_used = 100;
    });
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));

    await service.loadAccounts();
    const firstWinner = resolveModelRoute('public-flash', {}, {}, {});
    accounts.reverse();
    await service.loadAccounts();

    expect(firstWinner).toBe('public-flash');
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
    expect(service.resolveDynamicModelForAccount('account-a', 'public-flash')).toBe('provider-a');
    expect(service.resolveDynamicModelForAccount('account-b', 'public-flash')).toBe('provider-b');
  });

  it('uses a selected account\'s fresh recency when rebuilding colliding forwarding rules', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:34:56.000Z'));
    const selectedLastUsed = Math.floor(Date.now() / 1000);
    const accounts = [
      account('older', {
        ...quota({ 'provider-older': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-older' },
      }),
      account('newer', {
        ...quota({ 'provider-newer': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-newer' },
      }),
    ];
    accounts[0].last_used = 100;
    accounts[1].last_used = 200;
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      fetchQuota: vi.fn((accessToken: string) =>
        Promise.resolve(
          accessToken === 'access-older'
            ? accounts[0].quota!
            : accounts[1].quota!,
        ),
      ),
    });
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: 'older',
      }),
    );
    service = new AccountLeaseService(store, upstream);

    await service.loadAccounts();
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');

    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'older' });
    expect(store.updateLastUsedIfCurrent).toHaveBeenCalledWith(
      'older',
      selectedLastUsed,
      expect.any(Function),
    );
    expect((service as any).tokens.get('older')?.last_used).toBe(selectedLastUsed);

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 2,
      failed: 0,
    });
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
  });

  it('returns a hydrated token when selected-token recency persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:34:56.000Z'));
    const selectedLastUsed = Math.floor(Date.now() / 1000);
    const accounts = [
      account('acc-1', {
        ...quota({ 'provider-older': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-older' },
      }),
      account('acc-2', {
        ...quota({ 'provider-newer': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-newer' },
      }),
    ];
    accounts[0].last_used = 100;
    accounts[1].last_used = 200;
    const store = createAccountStore(accounts);
    const persistenceError = new Error('recency persistence failed');
    store.updateLastUsedIfCurrent = vi.fn(() => {
      throw persistenceError;
    });
    const upstream = createUpstream({
      fetchQuota: vi.fn((accessToken: string) =>
        Promise.resolve(accessToken === 'access-acc-1' ? accounts[0].quota! : accounts[1].quota!),
      ),
    });
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: 'acc-1',
      }),
    );
    service = new AccountLeaseService(store, upstream);
    const errorSpy = vi.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await service.loadAccounts();
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');

    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-1' });
    expect(store.updateLastUsedIfCurrent).toHaveBeenCalledWith(
      'acc-1',
      selectedLastUsed,
      expect.any(Function),
    );
    expect((service as any).tokens.get('acc-1')?.last_used).toBe(selectedLastUsed);
    expect(errorSpy).toHaveBeenCalledWith(
      'Selected token recency persistence failed: operation=record_selected_token reason=persistence_failed',
    );

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 2,
      failed: 0,
    });
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
  });

  it('rejects a selected lease when project hydration replaces its cache token', async () => {
    const accounts = [account('acc-1')];
    accounts[0].token.project_id = undefined;
    const store = createAccountStore(accounts);
    let replacementToken: any;
    const upstream = createUpstream({
      fetchProjectId: vi.fn(() => {
        replacementToken = {
          ...(service as any).tokens.get('acc-1'),
          access_token: 'replacement-access',
          last_used: 777,
        };
        (service as any).tokens.set('acc-1', replacementToken);
        return Promise.resolve('stale-project-id');
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.getNextToken({ sessionKey: 'openai:project-replaced' })).resolves.toBeNull();

    expect((service as any).tokens.get('acc-1')).toBe(replacementToken);
    expect(replacementToken.project_id).toBeUndefined();
    expect(replacementToken.last_used).toBe(777);
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(store.updateLastUsed).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:project-replaced')).toBeUndefined();
  });

  it('rejects a selected lease when project hydration removes its cache token', async () => {
    const accounts = [account('acc-1')];
    accounts[0].token.project_id = undefined;
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      fetchProjectId: vi.fn(() => {
        (service as any).tokens.delete('acc-1');
        return Promise.resolve('stale-project-id');
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.getNextToken({ sessionKey: 'openai:project-removed' })).resolves.toBeNull();

    expect((service as any).tokens.has('acc-1')).toBe(false);
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(store.updateLastUsed).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:project-removed')).toBeUndefined();
  });

  it('rejects a selected lease when hydration removes its cache entry', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', undefined, nowSec + 1)];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      refreshAccessToken: vi.fn(() => {
        (service as any).tokens.delete('acc-1');
        return Promise.resolve({
          access_token: 'access-new',
          expires_in: 7200,
          token_type: 'Bearer',
        });
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.getNextToken({ sessionKey: 'openai:removed' })).resolves.toBeNull();

    expect(store.updateLastUsed).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:removed')).toBeUndefined();
  });

  it('rejects a selected lease when hydration replaces its cache token', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const replacementLastUsed = 777;
    const accounts = [account('acc-1', undefined, nowSec + 1)];
    const store = createAccountStore(accounts);
    let replacementToken: any;
    const upstream = createUpstream({
      refreshAccessToken: vi.fn(() => {
        replacementToken = {
          ...(service as any).tokens.get('acc-1'),
          access_token: 'replacement-access',
          expiry_timestamp: nowSec + 3600,
          last_used: replacementLastUsed,
        };
        (service as any).tokens.set('acc-1', replacementToken);
        return Promise.resolve({
          access_token: 'access-new',
          expires_in: 7200,
          token_type: 'Bearer',
        });
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.getNextToken({ sessionKey: 'openai:replaced' })).resolves.toBeNull();

    expect((service as any).tokens.get('acc-1')).toBe(replacementToken);
    expect(replacementToken.last_used).toBe(replacementLastUsed);
    expect(store.updateLastUsed).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:replaced')).toBeUndefined();
  });

  it('does not start an obsolete token write when cache identity changes during the account read', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', undefined, nowSec - 1)];
    const store = createAccountStore(accounts);
    const accountRead = deferred<CloudAccount | undefined>();
    store.getAccount = vi.fn(() => accountRead.promise);
    const upstream = createUpstream({
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: 'access-refreshed',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    const selected = service.getNextToken({ sessionKey: 'openai:read-boundary' });
    await vi.waitFor(() => expect(store.getAccount).toHaveBeenCalledTimes(1));
    const replacement = {
      ...(service as any).tokens.get('acc-1'),
      access_token: 'access-replacement',
      expiry_timestamp: nowSec + 7200,
    };
    (service as any).tokens.set('acc-1', replacement);
    accountRead.resolve(structuredClone(accounts[0]));

    await expect(selected).resolves.toBeNull();
    expect(store.updateTokenIfCurrent).not.toHaveBeenCalled();
    expect(accounts[0].token.access_token).toBe('access-acc-1');
    expect((service as any).tokens.get('acc-1')).toBe(replacement);
    expect((service as any).selectionPolicy.sessionBindings.get('openai:read-boundary')).toBeUndefined();
  });

  it('suppresses recency, session binding, and lease completion when token persistence is stale', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', undefined, nowSec - 1)];
    const store = createAccountStore(accounts);
    store.updateTokenIfCurrent = vi.fn().mockReturnValue(false);
    const upstream = createUpstream({
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: 'access-refreshed',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    await expect(service.getNextToken({ sessionKey: 'openai:stale-persist' })).resolves.toBeNull();

    expect(store.updateTokenIfCurrent).toHaveBeenCalledTimes(1);
    expect(store.updateLastUsedIfCurrent).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:stale-persist')).toBeUndefined();
  });

  it('rejects token refresh persistence when replacement wins its pre-storage barrier', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', undefined, nowSec - 1)];
    const store = createAccountStore(accounts);
    const refresh = deferred<TokenResponse>();
    const upstream = createUpstream({
      refreshAccessToken: vi.fn(() => refresh.promise),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    const selected = service.getNextToken({ sessionKey: 'openai:token-commit-boundary' });
    await vi.waitFor(() => expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1));
    const replacement = {
      ...(service as any).tokens.get('acc-1'),
      access_token: 'access-replacement',
      expiry_timestamp: nowSec + 7200,
    };
    (service as any).tokens.set('acc-1', replacement);
    refresh.resolve({
      access_token: 'access-refreshed',
      expires_in: 7200,
      token_type: 'Bearer',
    });

    await expect(selected).resolves.toBeNull();
    expect(accounts[0].token.access_token).toBe('access-acc-1');
    expect((service as any).tokens.get('acc-1')).toBe(replacement);
    expect(store.updateTokenIfCurrent).not.toHaveBeenCalled();
    expect(store.updateLastUsedIfCurrent).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:token-commit-boundary')).toBeUndefined();
  });

  it('rejects project persistence when removal wins its pre-storage barrier', async () => {
    const accounts = [account('acc-1')];
    accounts[0].token.project_id = undefined;
    const store = createAccountStore(accounts);
    const project = deferred<string | null>();
    const upstream = createUpstream({ fetchProjectId: vi.fn(() => project.promise) });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    const selected = service.getNextToken({ sessionKey: 'openai:project-commit-boundary' });
    await vi.waitFor(() => expect(upstream.fetchProjectId).toHaveBeenCalledTimes(1));
    (service as any).tokens.delete('acc-1');
    project.resolve('resolved-project');

    await expect(selected).resolves.toBeNull();
    expect(accounts[0].token.project_id).toBeUndefined();
    expect((service as any).tokens.has('acc-1')).toBe(false);
    expect(store.updateTokenIfCurrent).not.toHaveBeenCalled();
    expect(store.updateLastUsedIfCurrent).not.toHaveBeenCalled();
    expect((service as any).selectionPolicy.sessionBindings.get('openai:project-commit-boundary')).toBeUndefined();
  });

  it('keeps the prior cache and dynamic rules when an account reload mapping fails', async () => {
    const accounts = [
      account('old', {
        ...quota({ 'provider-old': 100 }),
        model_forwarding_rules: { 'public-old': 'provider-old' },
      }),
    ];
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));
    await service.loadAccounts();
    const priorTokens = (service as any).tokens;

    accounts.splice(
      0,
      accounts.length,
      account('new-first', quota({ 'provider-first': 100 })),
      account('new-second', quota({ 'provider-second': 100 })),
    );
    const tokenCache = (service as any).tokenCache;
    const originalMap = tokenCache.mapAccountToTokenData.bind(tokenCache);
    let mappedAccounts = 0;
    vi.spyOn(tokenCache, 'mapAccountToTokenData').mockImplementation((candidate: unknown) => {
      mappedAccounts += 1;
      if (mappedAccounts === 2) {
        throw new Error('injected mapping failure');
      }
      return originalMap(candidate as CloudAccount);
    });

    await expect(service.loadAccounts()).resolves.toBe(0);
    expect((service as any).tokens).toBe(priorTokens);
    expect(resolveModelRoute('public-old', {}, {}, {})).toBe('public-old');
    expect(resolveModelRoute('public-new', {}, {}, {})).toBe('public-new');
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

  it.each([
    ['HTTP 401', new Error('HTTP 401')],
    ['UNAUTHORIZED', new Error('UNAUTHORIZED')],
    ['HTTP 403', new Error('HTTP 403')],
    ['FORBIDDEN', new Error('FORBIDDEN')],
  ])('refreshes access token once after a sanitized %s quota failure', async (message, error) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }), nowSec + 3600)];
    const store = createAccountStore(accounts);
    const upstream = createUpstream({
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: `access-after-${message}`,
        expires_in: 7200,
        token_type: 'Bearer',
      }),
      fetchQuota: vi
        .fn()
        .mockRejectedValueOnce(error)
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
    expect(upstream.fetchQuota).toHaveBeenNthCalledWith(2, `access-after-${message}`, undefined);
  });

  it.each(['HTTP 4012', 'HTTP 4032', 'upstream said UNAUTHORIZED', 'upstream said 403 FORBIDDEN'])(
    'does not replay token refresh for non-auth quota error %s',
    async (message) => {
      const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }))];
      const upstream = createUpstream({
        fetchQuota: vi.fn().mockRejectedValue(new Error(message)),
        refreshAccessToken: vi.fn(),
      });
      service = new AccountLeaseService(createAccountStore(accounts), upstream);
      await service.loadAccounts();

      await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
        refreshed: 0,
        failed: 1,
      });

      expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
      expect(upstream.fetchQuota).toHaveBeenCalledOnce();
    },
  );

  it('redacts account and upstream details from a failed quota-refresh retry log', async () => {
    const accountId = 'canary-account-id';
    const rawError = new Error(
      'canary-raw-error canary-access-token canary-refresh-token canary-project-id',
    );
    const store = createAccountStore([account(accountId, quota({ 'gemini-old-flash-high': 10 }))]);
    const upstream = createUpstream({
      fetchQuota: vi
        .fn()
        .mockRejectedValueOnce(new Error('HTTP 401'))
        .mockRejectedValueOnce(rawError),
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: 'canary-access-token',
        expires_in: 7200,
        project_id: 'canary-project-id',
        refresh_token: 'canary-refresh-token',
        token_type: 'Bearer',
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    const serviceLogger = (service as any).logger;
    const warnSpy = vi.spyOn(serviceLogger, 'warn');
    const logSpy = vi.spyOn(serviceLogger, 'log');
    const errorSpy = vi.spyOn(serviceLogger, 'error');
    const debugSpy = vi.spyOn(serviceLogger, 'debug');

    await expect(service.refreshQuotaCatalog({ force: true })).resolves.toMatchObject({
      refreshed: 0,
      failed: 1,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Quota refresh failed: operation=refresh_account reason=auth_retry_failed',
    );
    const diagnostics = [
      ...warnSpy.mock.calls,
      ...logSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...debugSpy.mock.calls,
    ]
      .flat()
      .map(String)
      .join('\n');
    for (const canary of [
      accountId,
      'canary-access-token',
      'canary-refresh-token',
      'canary-project-id',
      'canary-raw-error',
    ]) {
      expect(diagnostics).not.toContain(canary);
    }
  });

  it('refreshes only after an AI-credit authentication failure aborts and settles quota summary', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accounts = [account('acc-1', quota({ 'gemini-old-flash-high': 10 }), nowSec + 3600)];
    const store = createAccountStore(accounts);
    vi.useFakeTimers();
    let blockInitialSummary = true;
    let initialSummaryAborted = false;
    let initialSummarySettled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('fetchAvailableModels')) {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({ models: { 'gemini-new-flash-high': {} } }),
        };
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        if (blockInitialSummary) {
          blockInitialSummary = false;
          return new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              initialSummaryAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }).finally(() => {
            initialSummarySettled = true;
          });
        }
        return { ok: false, status: 400 };
      }
      if (url.includes('daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')) {
        const authorization = (init?.headers as Record<string, string>).Authorization;
        if (authorization === 'Bearer access-acc-1') {
          return { ok: false, status: 401 };
        }
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            paidTier: { availableCredits: [{ creditType: 'AI', creditAmount: '22' }] },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({});
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal('fetch', fetchMock);
    const upstream = createUpstream({
      fetchQuota: vi.fn((accessToken: string, proxyUrl?: string) =>
        GoogleAPIService.fetchQuota(accessToken, proxyUrl),
      ),
      refreshAccessToken: vi.fn().mockResolvedValue({
        access_token: 'access-after-ai-credits-auth-failure',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
    });
    service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();

    const refresh = service.refreshQuotaCatalog({ force: true });
    const completedBeforeSummary = Promise.race([
      refresh.then(() => 'refreshed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1)),
    ]);
    await vi.advanceTimersByTimeAsync(1);

    expect(await completedBeforeSummary).toBe('refreshed');
    expect(initialSummaryAborted).toBe(true);
    expect(initialSummarySettled).toBe(true);
    await expect(refresh).resolves.toMatchObject({ refreshed: 1, failed: 0 });
    expect(upstream.refreshAccessToken).toHaveBeenCalledWith('refresh-acc-1', undefined, undefined);
    expect(upstream.fetchQuota).toHaveBeenNthCalledWith(1, 'access-acc-1', undefined);
    expect(upstream.fetchQuota).toHaveBeenNthCalledWith(
      2,
      'access-after-ai-credits-auth-failure',
      undefined,
    );
    expect(store.updateQuota).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ ai_credits: { credits: 22, expiryDate: '' } }),
    );
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

  it('selects performance-first by physical-model score, lexical ties, and does not advance round robin', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = (accountId: string, quotaPercentage: number) => ({
      account_id: accountId,
      email: `${accountId}@test.dev`,
      access_token: `token-${accountId}`,
      refresh_token: `refresh-${accountId}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec + 3600,
      project_id: `project-${accountId}`,
      session_id: `session-${accountId}`,
      model_quotas: { 'physical-shared': quotaPercentage },
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: { alias: 'physical-shared' },
    });
    (service as any).tokens = new Map([
      ['acc-2', tokenData('acc-2', 50)],
      ['acc-1', tokenData('acc-1', 40)],
    ]);
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'performance-first',
        preferred_account_id: '',
      }),
    );

    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-2' });
    for (let index = 0; index < 20; index++) {
      service.recordPerformanceFailure('acc-2', 'physical-shared');
    }
    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-1' });

    (service as any).tokens = new Map([
      ['acc-z', tokenData('acc-z', 40)],
      ['acc-a', tokenData('acc-a', 40)],
    ]);
    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-a' });

    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: '',
      }),
    );
    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-z' });
  });

  it('uses code-unit lexical score ties and a non-mutating, nonidentifying performance-first shadow prediction', async () => {
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
      session_id: `session-${accountId}`,
      model_quotas: { physical: 40 },
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: { alias: 'physical' },
    });
    (service as any).tokens = new Map([
      ['acc-ä', tokenData('acc-ä')],
      ['acc-z', tokenData('acc-z')],
    ]);
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'performance-first',
        preferred_account_id: '',
      }),
    );
    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-z' });

    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        parity_shadow_enabled: true,
        scheduling_mode: 'performance-first',
        preferred_account_id: '',
      }),
    );
    service.recordPerformanceFailure('acc-ä', 'physical');
    const warnSpy = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-ä' });
    await expect(service.getNextToken({ model: 'alias' })).resolves.toMatchObject({ id: 'acc-z' });

    expect(warnSpy).toHaveBeenCalledWith(
      'Parity shadow mismatch detected: legacy_candidate=true, parity_candidate=true',
    );
    const warnings = warnSpy.mock.calls.map(([message]) => String(message)).join('\n');
    for (const secret of [
      'acc-ä',
      'acc-z',
      Buffer.from('acc-ä').toString('base64'),
      createHash('sha256').update('acc-ä').digest('hex'),
      'acc-ä@test.dev',
      'project-acc-ä',
      'session-acc-ä',
      'token-acc-ä',
      'https://proxy.invalid/acc-ä',
    ]) {
      expect(warnings).not.toContain(secret);
    }
    expect((service as any).shadowComparisonCount).toBe(2);
  });

  it('keeps expired performance state and round-robin position unchanged by shadow scoring', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      service.recordPerformanceFailure('acc-1', 'gemini-2.5-flash');
      now.mockReturnValue(1_800_001);
      setServerConfig(
        createProxyConfig({
          parity_enabled: false,
          parity_shadow_enabled: true,
          scheduling_mode: 'performance-first',
        }),
      );

      const performancePolicy = (service as any).performancePolicy;
      const selectionPolicy = (service as any).selectionPolicy;
      expect(performancePolicy.size).toBe(1);

      await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toMatchObject({
        id: 'acc-1',
      });

      expect(performancePolicy.size).toBe(1);
      expect(selectionPolicy.currentIndex).toBe(1);

      service.recordPerformanceSuccess('acc-1', 'gemini-2.5-flash');
      expect(
        performancePolicy.score({ accountId: 'acc-1', effectiveModel: 'gemini-2.5-flash' }),
      ).toBeCloseTo(0.375);
    } finally {
      now.mockRestore();
    }
  });

  it.each(['cache-first', 'balance', 'performance-first'] as const)(
    'falls back when the preferred account is missing, disabled, or rate-limited in %s mode',
    async (schedulingMode) => {
      const scenarios = [
        {
          preferredAccountId: 'missing',
          prepare: () => undefined,
          expectedAccountId: 'acc-1',
        },
        {
          preferredAccountId: 'acc-1',
          prepare: () => service.markAsForbidden('acc-1'),
          expectedAccountId: 'acc-2',
        },
        {
          preferredAccountId: 'acc-1',
          prepare: () => service.markAsRateLimited('acc-1'),
          expectedAccountId: 'acc-2',
        },
      ];

      for (const scenario of scenarios) {
        setServerConfig(
          createProxyConfig({
            parity_enabled: true,
            parity_kill_switch: false,
            scheduling_mode: schedulingMode,
            preferred_account_id: scenario.preferredAccountId,
          }),
        );
        scenario.prepare();

        await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toMatchObject({
          id: scenario.expectedAccountId,
        });

        service.clearAllRateLimits();
      }
    },
  );

  it('honors an eligible preferred account in every scheduling mode', async () => {
    for (const schedulingMode of ['balance', 'cache-first', 'performance-first'] as const) {
      setServerConfig(
        createProxyConfig({
          parity_enabled: true,
          parity_kill_switch: false,
          scheduling_mode: schedulingMode,
          preferred_account_id: 'acc-2',
        }),
      );

      await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toMatchObject({
        id: 'acc-2',
      });
    }
  });

  it('uses round robin instead of session affinity in balance mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-2' });
    await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toMatchObject({
      id: 'acc-1',
    });
  });

  it('keeps a valid session affinity in cache-first mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
  });

  it('waits only within the cache-first budget before reclaiming its bound account', async () => {
    vi.useFakeTimers();
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'gemini-2.5-flash',
    });

    const selected = service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ id: 'acc-1' });
  });

  it('refreshes cache-first eligibility after waiting so a stale fallback is never selected', async () => {
    vi.useFakeTimers();
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'gemini-2.5-flash',
    });

    const selected = service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-2',
      status: 429,
      retryAfter: '30',
      model: 'gemini-2.5-flash',
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ id: 'acc-1' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rebuilds the cache-first pool after an account is removed and reloaded during its wait', async () => {
    vi.useFakeTimers();
    const accounts = [account('acc-1'), account('acc-2')];
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));
    await service.loadAccounts();
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'gemini-2.5-flash',
    });

    const selected = service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    accounts.splice(0, 1);
    await service.loadAccounts();
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ id: 'acc-2' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('excludes expired accounts while retaining active and rate-limited accounts after reload', async () => {
    const accounts = [account('active'), account('rate-limited'), account('expired')];
    accounts[0].status = 'active';
    accounts[1].status = 'rate_limited';
    accounts[2].status = 'expired';
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));

    await expect(service.loadAccounts()).resolves.toBe(2);
    expect((service as any).tokens).toEqual(
      expect.objectContaining({
        size: 2,
      }),
    );
    expect((service as any).tokens.has('active')).toBe(true);
    expect((service as any).tokens.has('rate-limited')).toBe(true);
    expect((service as any).tokens.has('expired')).toBe(false);
  });

  it('removes an expired account forwarding rule before rebuilding the sibling pool', async () => {
    const accounts = [
      account('forwarding', {
        ...quota({ 'provider-flash-a': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-flash-a' },
      }),
      account('sibling', quota({ 'public-flash': 100 })),
    ];
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));

    await service.loadAccounts();
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');

    accounts[0].status = 'expired';
    await service.loadAccounts();

    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
    expect(resolveModelRoute('configured-model', { 'configured-model': 'static-provider' }, {}, {})).toBe(
      'static-provider',
    );
    await expect(service.getNextToken({ model: 'public-flash' })).resolves.toMatchObject({
      id: 'sibling',
    });
  });

  it('removes a deleted account forwarding rule before rebuilding the sibling pool', async () => {
    const accounts = [
      account('forwarding', {
        ...quota({ 'provider-flash-a': 100 }),
        model_forwarding_rules: { 'public-flash': 'provider-flash-a' },
      }),
      account('sibling', quota({ 'public-flash': 100 })),
    ];
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));

    await service.loadAccounts();
    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');

    accounts.splice(0, 1);
    await service.loadAccounts();

    expect(resolveModelRoute('public-flash', {}, {}, {})).toBe('public-flash');
    await expect(service.getNextToken({ model: 'public-flash' })).resolves.toMatchObject({
      id: 'sibling',
    });
  });

  it('does not renew cache-first affinity for an account that expires during its wait', async () => {
    vi.useFakeTimers();
    const accounts = [account('acc-1'), account('acc-2')];
    service = new AccountLeaseService(createAccountStore(accounts), createUpstream({}));
    await service.loadAccounts();
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'gemini-2.5-flash',
    });

    const selected = service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    accounts[0].status = 'expired';
    await service.loadAccounts();
    expect((service as any).selectionPolicy.sessionBindings.has('openai:user-1')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ id: 'acc-2' });
    expect((service as any).selectionPolicy.sessionBindings.get('openai:user-1')).toMatchObject({
      accountId: 'acc-2',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rebuilds the cache-first pool after an account loses model requestability during its wait', async () => {
    vi.useFakeTimers();
    for (const token of (service as any).tokens.values()) {
      token.model_quotas = { 'gemini-2.5-flash': 100 };
    }
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'gemini-2.5-flash',
    });

    const selected = service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    await Promise.resolve();
    proxyModelAvailabilityStore.mark('acc-1', 'gemini-2.5-flash', 'quota_exhausted');
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ id: 'acc-2' });
    expect(vi.getTimerCount()).toBe(0);
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('rechecks the effective physical model after a cache-first wait', async () => {
    vi.useFakeTimers();
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
          model_quotas: { 'provider-flash-a': 100, 'provider-flash-b': 100 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: { 'public-flash': 'provider-flash-a' },
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
          model_quotas: { 'public-flash': 100 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'public-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'provider-flash-a',
    });

    const selected = service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'public-flash',
    });
    await Promise.resolve();
    (service as any).tokens.set('acc-1', {
      ...(service as any).tokens.get('acc-1'),
      model_forwarding_rules: { 'public-flash': 'provider-flash-b' },
    });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '30',
      model: 'provider-flash-b',
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ id: 'acc-2' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revalidates cache-first session affinity at each TTL boundary after waiting', async () => {
    vi.useFakeTimers();
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 2,
        preferred_account_id: '',
      }),
    );

    for (const [offsetMs, expectedAccountId] of [
      [-1, 'acc-2'],
      [0, 'acc-2'],
      [1, 'acc-1'],
    ] as const) {
      service.clearAllRateLimits();
      service.clearAllWorkReservationsForTesting?.();
      service.resetSelectionState();
      (service as any).selectionPolicy.bindSession(
        'openai:user-1',
        'acc-1',
        Date.now() + 2000 + offsetMs,
      );
      (service as any).selectionPolicy.currentIndex = 1;
      await service.markFromUpstreamError({
        accountIdOrEmail: 'acc-1',
        status: 429,
        retryAfter: '2',
        model: 'gemini-2.5-flash',
      });

      const selected = service.getNextToken({
        sessionKey: 'openai:user-1',
        model: 'gemini-2.5-flash',
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2000);

      await expect(selected).resolves.toMatchObject({ id: expectedAccountId });
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('fails over immediately when cache-first wait exceeds its budget', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'cache-first',
        max_wait_seconds: 1,
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '2',
      model: 'gemini-2.5-flash',
    });

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-2' });
  });

  it('checks a rate limit against each account effective physical model', async () => {
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
          model_quotas: { 'provider-flash': 100 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: { 'public-flash': 'provider-flash' },
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
          model_quotas: { 'public-flash': 100 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
      }),
    );
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '30',
      model: 'provider-flash',
    });

    await expect(service.getNextToken({ model: 'public-flash' })).resolves.toMatchObject({
      id: 'acc-2',
    });
  });

  it('keeps performance-first session fallback unchanged', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'performance-first',
        preferred_account_id: '',
      }),
    );

    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
    await expect(
      service.getNextToken({ sessionKey: 'openai:user-1', model: 'gemini-2.5-flash' }),
    ).resolves.toMatchObject({ id: 'acc-1' });
  });

  it('selects distinct eligible accounts for concurrent balance requests', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: '',
      }),
    );

    await expect(
      Promise.all([
        service.getNextToken({ model: 'gemini-2.5-flash' }),
        service.getNextToken({ model: 'gemini-2.5-flash' }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'acc-1' }),
      expect.objectContaining({ id: 'acc-2' }),
    ]);
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

  it('does not reset model A failure escalation when finalizing a model B selection', async () => {
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'model-a',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
        },
      }),
    });

    await expect(
      service.getNextToken({ model: 'model-b', excludeAccountIds: ['acc-2'] }),
    ).resolves.toMatchObject({ id: 'acc-1' });

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'model-a',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
        },
      }),
    });

    expect((service as any).rateLimitTracker.getRemainingWaitSeconds('acc-1', 'model-a')).toBe(
      10,
    );
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

  it('bypasses cooldown-only exhaustion in parity-disabled scheduling and shadows the same legacy choice', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        parity_shadow_enabled: true,
        scheduling_mode: 'balance',
      }),
    );
    const warnSpy = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const cooldownUntil = Date.now() + 30_000;
    (service as any).accountCooldowns.set('acc-1', cooldownUntil);
    (service as any).accountCooldowns.set('acc-2', cooldownUntil);

    await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toBeNull();
  });

  it('does not bypass a rate limit while recovering from cooldown-only exhaustion', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        scheduling_mode: 'balance',
      }),
    );
    const cooldownUntil = Date.now() + 30_000;
    (service as any).accountCooldowns.set('acc-1', cooldownUntil);
    (service as any).accountCooldowns.set('acc-2', cooldownUntil);
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '30',
      model: 'gemini-2.5-flash',
    });

    await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toBeNull();
  });

  it('strictly honors cooldown after parity no-go blocks scheduling', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_shadow_enabled: true,
        parity_no_go_error_rate: 0,
        scheduling_mode: 'balance',
      }),
    );

    await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toMatchObject({
      id: 'acc-1',
    });
    service.recordParityError();
    expect((service as any).noGoBlocked).toBe(true);
    service.resetSelectionState();

    const cooldownUntil = Date.now() + 30_000;
    (service as any).accountCooldowns.set('acc-1', cooldownUntil);
    (service as any).accountCooldowns.set('acc-2', cooldownUntil);

    await expect(service.getNextToken({ model: 'gemini-2.5-flash' })).resolves.toBeNull();
  });

  it('admits exactly cap concurrent acquisitions under overlapping load and limits beyond (T10-F01, Probe C02)', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        scheduling_mode: 'balance',
        max_concurrency_per_account: 8,
      }),
    );
    // Remove acc-2 to isolate concurrency limit on a single account acc-1
    (service as any).tokens.delete('acc-2');

    // Launch 16 concurrent acquisition requests
    const acquisitions = await Promise.all(
      Array.from({ length: 16 }, () => service.getNextToken({ model: 'gemini-2.5-flash' })),
    );

    const admitted = acquisitions.filter((acc) => acc !== null);
    const rejected = acquisitions.filter((acc) => acc === null);

    expect(admitted).toHaveLength(8);
    expect(rejected).toHaveLength(8);
    expect(service.getInFlightWork('acc-1')).toBe(8);

    // Releasing one admitted reservation frees up capacity for exactly one new request
    admitted[0]!.releaseReservation?.();
    expect(service.getInFlightWork('acc-1')).toBe(7);

    const followUp = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(followUp).not.toBeNull();
    expect(service.getInFlightWork('acc-1')).toBe(8);

    // Clean up remaining reservations
    for (const acc of admitted.slice(1)) {
      acc!.releaseReservation?.();
    }
    followUp!.releaseReservation?.();
    expect(service.getInFlightWork('acc-1')).toBe(0);
  });

  it('preserves in-flight reservations across resetSelectionState (T10-F01, Probe C03)', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        scheduling_mode: 'balance',
        max_concurrency_per_account: 8,
      }),
    );
    (service as any).tokens.delete('acc-2');

    // Acquire 4 reservations
    const reservations = await Promise.all(
      Array.from({ length: 4 }, () => service.getNextToken({ model: 'gemini-2.5-flash' })),
    );
    expect(reservations.every((r) => r !== null)).toBe(true);
    expect(service.getInFlightWork('acc-1')).toBe(4);

    // Call resetSelectionState() - must NOT clear inFlightWork
    service.resetSelectionState();
    expect(service.getInFlightWork('acc-1')).toBe(4);

    // Only 4 more should be admitted before hitting the cap of 8
    const moreAcquisitions = await Promise.all(
      Array.from({ length: 8 }, () => service.getNextToken({ model: 'gemini-2.5-flash' })),
    );
    const admittedMore = moreAcquisitions.filter((r) => r !== null);
    const rejectedMore = moreAcquisitions.filter((r) => r === null);

    expect(admittedMore).toHaveLength(4);
    expect(rejectedMore).toHaveLength(4);
    expect(service.getInFlightWork('acc-1')).toBe(8);

    // Clean up
    for (const r of reservations) r?.releaseReservation?.();
    for (const r of admittedMore) r?.releaseReservation?.();
    expect(service.getInFlightWork('acc-1')).toBe(0);
  });
});

