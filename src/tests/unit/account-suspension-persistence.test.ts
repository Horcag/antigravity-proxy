import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { cloudAccountStoreAdapter, type AccountLeaseAccountStore } from '@/modules/proxy-gateway/server/account-lease-adapters';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function account(id: string) {
  return {
    id,
    provider: 'google' as const,
    email: `${id}@example.test`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: 4_000_000_000,
      token_type: 'Bearer',
    },
    quota: { models: { 'gemini-test': { percentage: 23, resetTime: '2030-01-01T00:00:00Z' } } },
    created_at: 1,
    last_used: 2,
    status: 'active' as const,
    status_reason: 'operator-note',
    is_active: true,
    proxy_url: `http://${id}.proxy.test`,
  };
}

describe('persistent account suspension', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-suspension-test-'));
    process.env.AG_PROXY_DATA_DIR = dataDir;
    process.env.AG_PROXY_MASTER_KEY = '22'.repeat(32);
    resetMasterKeyCacheForTesting();
  });

  afterEach(() => {
    CloudAccountRepo.close();
    resetMasterKeyCacheForTesting();
    delete process.env.AG_PROXY_DATA_DIR;
    delete process.env.AG_PROXY_MASTER_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists suspension across repository restart without changing unrelated account data', async () => {
    await CloudAccountRepo.addAccount(account('suspended'));
    await CloudAccountRepo.addAccount(account('untouched'));
    const untouchedBefore = await CloudAccountRepo.getAccount('untouched');
    await CloudAccountRepo.suspendAccount('suspended');

    const suspended = await CloudAccountRepo.getAccount('suspended');
    const untouchedAfter = await CloudAccountRepo.getAccount('untouched');
    expect(suspended).toMatchObject({
      status: 'expired', status_reason: 'upstream_tos_suspended', is_active: false,
      token: account('suspended').token,
      quota: account('suspended').quota,
      email: account('suspended').email,
      proxy_url: account('suspended').proxy_url,
    });
    expect(untouchedAfter).toEqual(untouchedBefore);

    CloudAccountRepo.close();
    const restarted = await CloudAccountRepo.getAccounts();
    expect(restarted.find((item) => item.id === 'suspended')).toMatchObject({
      status: 'expired', status_reason: 'upstream_tos_suspended', is_active: false,
    });
    expect(restarted.map((item) => item.id)).toEqual(expect.arrayContaining(['untouched', 'suspended']));
  });

  it('keeps the synchronous fence after persistence failure and refuses stale snapshots', async () => {
    await CloudAccountRepo.addAccount(account('suspended'));
    let storedAccounts = await cloudAccountStoreAdapter.getAccounts();
    const store: AccountLeaseAccountStore = {
      ...cloudAccountStoreAdapter,
      getAccounts: async () => storedAccounts,
      suspendAccount: async () => { throw new Error('persistence unavailable'); },
    };
    const service = new AccountLeaseService(store);
    await service.loadAccounts();
    const sessionKey = 'openai:suspension-fence';
    (service as any).selectionPolicy.bindSession(sessionKey, 'suspended');

    await expect(service.suspendAccount('suspended')).rejects.toThrow('persistence unavailable');
    expect((service as any).tokens.has('suspended')).toBe(false);
    expect((service as any).selectionPolicy.sessionBindings.get(sessionKey)).toBeUndefined();

    storedAccounts = await cloudAccountStoreAdapter.getAccounts();
    expect(await service.loadAccounts()).toBe(0);
    expect((service as any).tokens.has('suspended')).toBe(false);
  });

  it('filters a load already in progress when suspension fences the account', async () => {
    await CloudAccountRepo.addAccount(account('suspended'));
    const snapshot = await cloudAccountStoreAdapter.getAccounts();
    const pending = deferred<typeof snapshot>();
    const store: AccountLeaseAccountStore = {
      ...cloudAccountStoreAdapter,
      getAccounts: () => pending.promise,
      suspendAccount: async () => undefined,
    };
    const service = new AccountLeaseService(store);
    const loading = service.loadAccounts();
    await Promise.resolve();
    await service.suspendAccount('suspended');
    pending.resolve(snapshot);

    expect(await loading).toBe(0);
    expect((service as any).tokens.has('suspended')).toBe(false);
  });

  it('refuses an account store without persistent suspension support and keeps the fence', async () => {
    await CloudAccountRepo.addAccount(account('suspended'));
    const store: AccountLeaseAccountStore = {
      ...cloudAccountStoreAdapter,
      suspendAccount: undefined,
    };
    const service = new AccountLeaseService(store);
    await service.loadAccounts();

    await expect(service.suspendAccount('suspended')).rejects.toThrow('does not support persistent account suspension');
    expect((service as any).tokens.has('suspended')).toBe(false);
    expect(await service.loadAccounts()).toBe(0);
  });

  it('rejects attempts to suspend a missing account', async () => {
    await expect(CloudAccountRepo.suspendAccount('missing')).rejects.toThrow(/exactly one/u);
  });
});
