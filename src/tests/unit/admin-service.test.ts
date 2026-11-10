import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '@/admin/admin.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { ConfigManager, ConfigPersistenceError } from '@/modules/config/ipc/manager';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import type { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';

function createAccount(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return {
    id: 'acc-1',
    provider: 'google',
    email: 'user@example.com',
    name: 'User',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 123456,
      token_type: 'Bearer',
      id_token: 'id-token',
      project_id: 'project-1',
    },
    created_at: 1,
    last_used: 2,
    status: 'active',
    is_active: false,
    ...overrides,
  };
}

function createService() {
  const leaseService = {
    loadAccounts: vi.fn().mockResolvedValue(1),
    reloadAllAccounts: vi.fn().mockResolvedValue(1),
    setPreferredAccount: vi.fn(),
    refreshQuotaCatalog: vi.fn().mockResolvedValue({
      refreshed: 1,
      skipped: 0,
      failed: 0,
      account_ids: ['acc-1'],
    }),
    getQuotaDiagnostics: vi.fn().mockReturnValue({
      refresh_interval_seconds: 600,
      accounts: [],
    }),
  } as Pick<AccountLeaseService, 'loadAccounts' | 'reloadAllAccounts'> as AccountLeaseService;

  return new AdminService(leaseService);
}

describe('AdminService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sanitizes account tokens in list responses', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([createAccount()]);

    const accounts = await createService().listAccounts();

    expect(accounts).toEqual([
      expect.objectContaining({
        id: 'acc-1',
        email: 'user@example.com',
        token: expect.objectContaining({
          has_access_token: true,
          has_refresh_token: true,
          has_id_token: true,
          project_id: 'project-1',
        }),
      }),
    ]);
    expect(JSON.stringify(accounts)).not.toContain('access-token');
    expect(JSON.stringify(accounts)).not.toContain('refresh-token');
    expect(JSON.stringify(accounts)).not.toContain('id-token');
  });

  it('returns stable credential-free proxy representations in account read-backs', async () => {
    const rawProxyUrl =
      'https://proxy-user:proxy-password@proxy.example.test:8443/tunnel?proxy-query=secret#proxy-fragment';
    const rawValues = [
      rawProxyUrl,
      'proxy-user',
      'proxy-password',
      '/tunnel',
      'proxy-query=secret',
      'proxy-fragment',
    ];
    const canaries = rawValues.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([
      createAccount({
        proxy_url: rawProxyUrl,
        token: {
          ...createAccount().token,
          upstream_proxy_url: rawProxyUrl,
        },
      }),
    ]);

    const accounts = await createService().listAccounts();
    const serialized = JSON.stringify(accounts);

    expect(accounts[0]).toMatchObject({
      proxy_url: 'https://proxy.example.test:8443',
      token: { upstream_proxy_url: 'https://proxy.example.test:8443' },
    });
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('exports a safe proxy representation unless tokens are explicitly requested', async () => {
    const rawProxyUrl =
      'https://proxy-user:proxy-password@proxy.example.test:8443/tunnel?proxy-query=secret#proxy-fragment';
    const rawValues = [
      rawProxyUrl,
      'proxy-user',
      'proxy-password',
      '/tunnel',
      'proxy-query=secret',
      'proxy-fragment',
    ];
    const canaries = rawValues.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([
      createAccount({ proxy_url: rawProxyUrl }),
    ]);
    const service = createService();

    const sanitized = await service.exportAccounts(false);
    const withTokens = await service.exportAccounts(true);

    expect(sanitized.accounts[0]?.token).toBeUndefined();
    expect(sanitized.accounts[0]?.proxy_url).toBe('https://proxy.example.test:8443');
    expect(withTokens.accounts[0]?.token?.refresh_token).toBe('refresh-token');
    expect(withTokens.accounts[0]?.proxy_url).toBe(rawProxyUrl);
    const serialized = JSON.stringify(sanitized);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('imports token-bearing accounts and skips sanitized account exports', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue(undefined);
    const addAccount = vi.spyOn(CloudAccountRepo, 'importAccount').mockImplementation(async account => account);
    const service = createService();

    const result = await service.importAccounts({
      version: '1.0',
      exportedAt: 1,
      accounts: [
        {
          provider: 'google',
          email: 'imported@example.com',
          token: createAccount({ email: 'imported@example.com' }).token,
        },
        {
          provider: 'google',
          email: 'sanitized@example.com',
        },
      ],
    });

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(addAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'imported@example.com',
        token: expect.objectContaining({
          refresh_token: 'refresh-token',
        }),
      }),
    );
  });

  it('preserves existing account metadata while assigning timestamps only to new imports', async () => {
    const existing = createAccount({
      id: 'existing-id',
      email: 'user@example.com',
      created_at: 123,
      last_used: 0,
      is_active: true,
    });
    vi.spyOn(Date, 'now').mockReturnValue(456_000);
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockImplementation(async (email) => {
      return email.toLowerCase() === existing.email ? existing : undefined;
    });
    const service = createService();
    const addAccount = vi.spyOn(CloudAccountRepo, 'importAccount').mockImplementation(async (account) => {
      await Promise.resolve();
      expect((service as any).accountLeaseService.loadAccounts).not.toHaveBeenCalled();
      return account;
    });

    await service.importAccounts({
      version: '1.0',
      exportedAt: 1,
      accounts: [
        {
          provider: 'google',
          email: 'USER@EXAMPLE.COM',
          token: existing.token,
        },
        {
          provider: 'google',
          email: 'new@example.com',
          token: createAccount({ email: 'new@example.com' }).token,
        },
      ],
    });

    expect(CloudAccountRepo.getAccountByEmail).toHaveBeenCalledWith('USER@EXAMPLE.COM');
    expect(addAccount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'existing-id',
        created_at: 123,
        last_used: 0,
        is_active: true,
      }),
    );
    expect(addAccount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        email: 'new@example.com',
        created_at: 456,
        last_used: 456,
        is_active: false,
      }),
    );
    expect((addAccount.mock.calls[1]?.[0] as CloudAccount).id).not.toBe('existing-id');

    const { loadAccounts, reloadAllAccounts } = (service as any).accountLeaseService;
    expect(loadAccounts).toHaveBeenCalledOnce();
    expect(reloadAllAccounts).not.toHaveBeenCalled();
    for (const callOrder of addAccount.mock.invocationCallOrder) {
      expect(callOrder).toBeLessThan(loadAccounts.mock.invocationCallOrder[0]);
    }
  });

  it('keeps the explicit reload endpoint on the clear-all path', async () => {
    const service = createService();

    await expect(service.reloadAccounts()).resolves.toEqual({
      reloaded: true,
      account_count: 1,
    });

    const { loadAccounts, reloadAllAccounts } = (service as any).accountLeaseService;
    expect(reloadAllAccounts).toHaveBeenCalledOnce();
    expect(loadAccounts).not.toHaveBeenCalled();
  });

  it('preserves omitted optional import metadata while allowing explicit replacements and clears', async () => {
    const existing = createAccount({
      id: 'existing-id',
      name: 'Existing user',
      avatar_url: 'https://example.com/existing.png',
      quota: { models: { 'gemini-existing': { percentage: 50, resetTime: 'tomorrow' } } },
      status_reason: 'existing reason',
      proxy_url: 'http://existing-proxy.example',
    });
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue(existing);
    const addAccount = vi.spyOn(CloudAccountRepo, 'importAccount').mockImplementation(async account => account);
    const service = createService();

    await service.importAccounts({
      version: '1.0',
      exportedAt: 1,
      accounts: [
        {
          provider: 'google',
          email: existing.email,
          token: existing.token,
        },
      ],
    });

    expect(addAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: existing.id,
        last_used: existing.last_used,
        name: 'Existing user',
        avatar_url: 'https://example.com/existing.png',
        quota: existing.quota,
        status_reason: 'existing reason',
        proxy_url: 'http://existing-proxy.example',
      }),
    );

    const replacementQuota = { models: { 'gemini-replacement': { percentage: 25, resetTime: '' } } };
    await service.importAccounts({
      version: '1.0',
      exportedAt: 1,
      accounts: [
        {
          provider: 'google',
          email: existing.email,
          name: null,
          avatar_url: null,
          token: existing.token,
          quota: replacementQuota,
          status_reason: '',
          proxy_url: null,
        },
      ],
    });

    expect(addAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: existing.id,
        last_used: existing.last_used,
        name: null,
        avatar_url: null,
        quota: replacementQuota,
        status_reason: '',
        proxy_url: undefined,
      }),
    );
  });

  it('refreshes account quota through the lease service without exposing tokens', async () => {
    const service = createService();

    await expect(service.refreshQuotaCatalog(true)).resolves.toEqual({
      refreshed: true,
      quota: {
        refreshed: 1,
        skipped: 0,
        failed: 0,
        account_ids: ['acc-1'],
      },
    });
  });

  it('returns only the lease service quota diagnostics read model', () => {
    const service = createService();

    expect(service.getQuotaDiagnostics()).toEqual({
      refresh_interval_seconds: 600,
      accounts: [],
    });
    expect((service as any).accountLeaseService.getQuotaDiagnostics).toHaveBeenCalledOnce();
  });

  it('reads and sets a preferred account without exposing account secrets', async () => {
    const config = {
      proxy: {
        ...DEFAULT_PROXY_CONFIG,
        preferred_account_id: 'acc-1',
      },
    };
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue(config);
    const persistPreferredAccount = vi
      .spyOn(ConfigManager, 'setPreferredAccount')
      .mockResolvedValue(undefined);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(createAccount());
    const service = createService();

    const readBack = await service.getPreferredAccount();
    const updated = await service.setPreferredAccount('acc-1');

    expect(readBack).toEqual({
      preferred_account_id: 'acc-1',
      account: {
        id: 'acc-1',
        provider: 'google',
        name: 'User',
        avatar_url: null,
        status: 'active',
        is_active: false,
      },
    });
    expect(updated).toEqual(readBack);
    expect(JSON.stringify(updated)).not.toContain('user@example.com');
    expect(JSON.stringify(updated)).not.toContain('access-token');
    expect(persistPreferredAccount).toHaveBeenCalledWith('acc-1');
    expect((service as any).accountLeaseService.setPreferredAccount).toHaveBeenCalledWith('acc-1');
  });

  it('rejects an unknown preferred account without persisting a change', async () => {
    const persistPreferredAccount = vi
      .spyOn(ConfigManager, 'setPreferredAccount')
      .mockResolvedValue(undefined);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(undefined);
    const service = createService();

    await expect(service.setPreferredAccount('missing')).rejects.toMatchObject({ status: 404 });

    expect(persistPreferredAccount).not.toHaveBeenCalled();
    expect((service as any).accountLeaseService.setPreferredAccount).not.toHaveBeenCalled();
  });

  it('does not change the in-memory lease setting when atomic persistence fails', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(createAccount());
    vi.spyOn(ConfigManager, 'setPreferredAccount').mockImplementation(() => {
      throw new Error('disk full');
    });
    const service = createService();

    await expect(service.setPreferredAccount('acc-1')).rejects.toThrow('disk full');

    expect((service as any).accountLeaseService.setPreferredAccount).not.toHaveBeenCalled();
  });

  it('keeps the lease setting consistent after a post-rename durability failure', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(createAccount());
    vi.spyOn(ConfigManager, 'setPreferredAccount').mockImplementation(() => {
      throw new ConfigPersistenceError(true);
    });
    const service = createService();

    await expect(service.setPreferredAccount('acc-1')).rejects.toThrow(
      'configuration was updated',
    );

    expect((service as any).accountLeaseService.setPreferredAccount).toHaveBeenCalledWith('acc-1');
  });

  it('keeps a cleared lease setting consistent after a post-rename durability failure', async () => {
    vi.spyOn(ConfigManager, 'setPreferredAccount').mockImplementation(() => {
      throw new ConfigPersistenceError(true);
    });
    const service = createService();

    await expect(service.clearPreferredAccount()).rejects.toThrow('configuration was updated');
    expect((service as any).accountLeaseService.setPreferredAccount).toHaveBeenCalledWith();
  });

  it('clears the preferred account idempotently', async () => {
    const persistPreferredAccount = vi
      .spyOn(ConfigManager, 'setPreferredAccount')
      .mockResolvedValue(undefined);
    const service = createService();

    await expect(service.clearPreferredAccount()).resolves.toEqual({
      preferred_account_id: null,
      account: null,
    });
    await expect(service.clearPreferredAccount()).resolves.toEqual({
      preferred_account_id: null,
      account: null,
    });

    expect(persistPreferredAccount.mock.calls).toEqual([[], []]);
    expect((service as any).accountLeaseService.setPreferredAccount).toHaveBeenCalledTimes(2);
  });
});
