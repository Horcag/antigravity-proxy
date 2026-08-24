import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '@/admin/admin.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
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
    reloadAllAccounts: vi.fn().mockResolvedValue(1),
  } as Pick<AccountLeaseService, 'reloadAllAccounts'> as AccountLeaseService;

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

  it('exports tokens only when explicitly requested', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([createAccount()]);
    const service = createService();

    const sanitized = await service.exportAccounts(false);
    const withTokens = await service.exportAccounts(true);

    expect(sanitized.accounts[0]?.token).toBeUndefined();
    expect(withTokens.accounts[0]?.token?.refresh_token).toBe('refresh-token');
  });

  it('imports token-bearing accounts and skips sanitized account exports', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue(undefined);
    const addAccount = vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue(undefined);
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
});
