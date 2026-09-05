import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService, type TokenResponse } from '@/modules/cloud-account/services/GoogleAPIService';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('headless encrypted account storage', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-proxy-test-'));
    process.env.AG_PROXY_DATA_DIR = dataDir;
    process.env.AG_PROXY_MASTER_KEY = '11'.repeat(32);
    resetMasterKeyCacheForTesting();
  });

  afterEach(() => {
    CloudAccountRepo.close();
    resetMasterKeyCacheForTesting();
    vi.restoreAllMocks();
    delete process.env.AG_PROXY_DATA_DIR;
    delete process.env.AG_PROXY_MASTER_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips an account without storing token plaintext in SQLite', async () => {
    const secretAccessToken = 'access-token-that-must-not-appear-in-the-database';
    const secretRefreshToken = 'refresh-token-that-must-not-appear-in-the-database';
    await CloudAccountRepo.addAccount({
      id: 'account-1',
      provider: 'google',
      email: 'account@example.com',
      token: {
        access_token: secretAccessToken,
        refresh_token: secretRefreshToken,
        expires_in: 3600,
        expiry_timestamp: 4_000_000_000,
        token_type: 'Bearer',
      },
      created_at: 1,
      last_used: 1,
      status: 'active',
    });

    await expect(CloudAccountRepo.getAccount('account-1')).resolves.toMatchObject({
      email: 'account@example.com',
      token: {
        access_token: secretAccessToken,
        refresh_token: secretRefreshToken,
      },
    });

    const databaseBytes = fs.readFileSync(path.join(dataDir, 'accounts.db'));
    expect(databaseBytes.includes(Buffer.from(secretAccessToken))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(secretRefreshToken))).toBe(false);
  });

  it('serializes an accepted token and project write before a queued cache replacement', async () => {
    const initialToken = {
      access_token: 'access-initial',
      refresh_token: 'refresh-initial',
      expires_in: 3600,
      expiry_timestamp: 4_000_000_000,
      token_type: 'Bearer',
    };
    const persistedToken = {
      ...initialToken,
      access_token: 'access-refreshed',
      project_id: 'project-refreshed',
    };
    await CloudAccountRepo.addAccount({
      id: 'account-1',
      provider: 'google',
      email: 'account@example.com',
      token: initialToken,
      created_at: 1,
      last_used: 1,
      status: 'active',
    });

    let currentToken = initialToken;
    let predicateCalls = 0;
    const committed = CloudAccountRepo.updateTokenIfCurrent('account-1', persistedToken, () => {
      predicateCalls += 1;
      queueMicrotask(() => {
        currentToken = { ...initialToken, access_token: 'access-replacement' };
      });
      return currentToken === initialToken;
    });

    expect(committed).toBe(true);
    expect(predicateCalls).toBe(1);
    await Promise.resolve();
    expect(currentToken).toMatchObject({ access_token: 'access-replacement' });
    await expect(CloudAccountRepo.getAccount('account-1')).resolves.toMatchObject({
      token: persistedToken,
    });
  });

  it('rejects stale token/project and last-used writes without invoking a second predicate', async () => {
    const initialToken = {
      access_token: 'access-initial',
      refresh_token: 'refresh-initial',
      expires_in: 3600,
      expiry_timestamp: 4_000_000_000,
      token_type: 'Bearer',
    };
    await CloudAccountRepo.addAccount({
      id: 'account-1',
      provider: 'google',
      email: 'account@example.com',
      token: initialToken,
      created_at: 1,
      last_used: 1,
      status: 'active',
    });

    let predicateCalls = 0;
    const stale = () => {
      predicateCalls += 1;
      return false;
    };

    expect(
      CloudAccountRepo.updateTokenIfCurrent('account-1', {
        ...initialToken,
        access_token: 'access-stale',
        project_id: 'project-stale',
      }, stale),
    ).toBe(false);
    expect(CloudAccountRepo.updateLastUsedIfCurrent('account-1', 99, stale)).toBe(false);
    expect(predicateCalls).toBe(2);
    await expect(CloudAccountRepo.getAccount('account-1')).resolves.toMatchObject({
      token: initialToken,
      last_used: 1,
    });
  });

  it('serializes accepted last-used persistence before queued cache mutation', async () => {
    const initialToken = {
      access_token: 'access-initial',
      refresh_token: 'refresh-initial',
      expires_in: 3600,
      expiry_timestamp: 4_000_000_000,
      token_type: 'Bearer',
    };
    await CloudAccountRepo.addAccount({
      id: 'account-1',
      provider: 'google',
      email: 'account@example.com',
      token: initialToken,
      created_at: 1,
      last_used: 1,
      status: 'active',
    });

    let currentLastUsed = 1;
    let predicateCalls = 0;
    const committed = CloudAccountRepo.updateLastUsedIfCurrent('account-1', 99, () => {
      predicateCalls += 1;
      queueMicrotask(() => {
        currentLastUsed = 777;
      });
      return currentLastUsed === 1;
    });

    expect(committed).toBe(true);
    expect(predicateCalls).toBe(1);
    await Promise.resolve();
    expect(currentLastUsed).toBe(777);
    await expect(CloudAccountRepo.getAccount('account-1')).resolves.toMatchObject({ last_used: 99 });
  });

  it('persists a committed AccountLeaseService refresh, project, recency, cache, and session through SQLite', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await CloudAccountRepo.addAccount({
      id: 'account-service',
      provider: 'google',
      email: 'account-service@example.com',
      token: {
        access_token: 'access-initial',
        refresh_token: 'refresh-initial',
        expires_in: 3600,
        expiry_timestamp: nowSeconds - 1,
        token_type: 'Bearer',
      },
      created_at: 1,
      last_used: 1,
      status: 'active',
    });
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'access-refreshed',
      refresh_token: 'refresh-refreshed',
      expires_in: 7200,
      token_type: 'Bearer',
    });
    vi.spyOn(GoogleAPIService, 'fetchProjectId').mockResolvedValue('project-refreshed');
    const service = new AccountLeaseService();
    await service.loadAccounts();

    const lease = await service.getNextToken({ sessionKey: 'openai:sqlite-committed' });
    const persisted = await CloudAccountRepo.getAccount('account-service');
    const cached = (service as any).tokens.get('account-service');
    const binding = (service as any).selectionPolicy.sessionBindings.get('openai:sqlite-committed');

    expect(lease).toMatchObject({
      id: 'account-service',
      token: {
        access_token: 'access-refreshed',
        refresh_token: 'refresh-refreshed',
        project_id: 'project-refreshed',
      },
    });
    expect(persisted).toMatchObject({
      token: {
        access_token: 'access-refreshed',
        refresh_token: 'refresh-refreshed',
        project_id: 'project-refreshed',
        session_id: lease?.token.session_id,
      },
      last_used: lease?.last_used,
    });
    expect(cached).toMatchObject({
      access_token: 'access-refreshed',
      refresh_token: 'refresh-refreshed',
      project_id: 'project-refreshed',
      last_used: lease?.last_used,
    });
    expect(binding).toMatchObject({ accountId: 'account-service' });
    await service.onModuleDestroy();
  });

  async function assertPreStorageRaceLeavesSqliteAndSessionStale(
    cacheMutation: 'replace' | 'remove',
  ): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await CloudAccountRepo.addAccount({
      id: 'account-race',
      provider: 'google',
      email: 'account-race@example.com',
      token: {
        access_token: 'access-initial',
        refresh_token: 'refresh-initial',
        expires_in: 3600,
        expiry_timestamp: nowSeconds - 1,
        token_type: 'Bearer',
        project_id: 'project-initial',
      },
      created_at: 1,
      last_used: 1,
      status: 'active',
    });
    const refresh = deferred<TokenResponse>();
    const refreshSpy = vi
      .spyOn(GoogleAPIService, 'refreshAccessToken')
      .mockImplementation(() => refresh.promise);
    const service = new AccountLeaseService();
    await service.loadAccounts();

    const selected = service.getNextToken({ sessionKey: `openai:sqlite-${cacheMutation}` });
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    if (cacheMutation === 'replace') {
      (service as any).tokens.set('account-race', {
        ...(service as any).tokens.get('account-race'),
        access_token: 'access-replacement',
        expiry_timestamp: nowSeconds + 7200,
      });
    } else {
      (service as any).tokens.delete('account-race');
    }
    refresh.resolve({
      access_token: 'access-refreshed',
      refresh_token: 'refresh-refreshed',
      expires_in: 7200,
      token_type: 'Bearer',
    });

    await expect(selected).resolves.toBeNull();
    await expect(CloudAccountRepo.getAccount('account-race')).resolves.toMatchObject({
      token: {
        access_token: 'access-initial',
        project_id: 'project-initial',
      },
      last_used: 1,
    });
    if (cacheMutation === 'replace') {
      expect((service as any).tokens.get('account-race')).toMatchObject({
        access_token: 'access-replacement',
      });
    } else {
      expect((service as any).tokens.has('account-race')).toBe(false);
    }
    expect(
      (service as any).selectionPolicy.sessionBindings.get(`openai:sqlite-${cacheMutation}`),
    ).toBeUndefined();
    await service.onModuleDestroy();
  }

  it('rejects a replacement at the pre-storage boundary without changing SQLite or session state', async () => {
    await assertPreStorageRaceLeavesSqliteAndSessionStale('replace');
  });

  it('rejects removal at the pre-storage boundary without changing SQLite or session state', async () => {
    await assertPreStorageRaceLeavesSqliteAndSessionStale('remove');
  });
});
