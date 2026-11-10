import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseSuspensionPolicy } from '@/modules/proxy-gateway/server/account-lease-suspension-policy';
import { AccountLeaseQuotaRefreshPolicy } from '@/modules/proxy-gateway/server/account-lease-quota-refresh-policy';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import type { AccountLeaseAccountStore, AccountLeaseUpstream } from '@/modules/proxy-gateway/server/account-lease-adapters';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/account-lease-token-types';
import { ConsoleAccountsService } from '@/admin-console/console-accounts.service';
import { AdminService } from '@/admin/admin.service';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function account(id = 'A'): CloudAccount {
  return { id, provider: 'google', email: `${id}@fixture.test`, status: 'active', is_active: true,
    created_at: 1, last_used: 1, token: { access_token: 'fixture', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 4_000_000_000, project_id: 'fixture-project', session_id: 'session-fixture' } };
}
function token(id = 'A'): AccountLeaseTokenData {
  return { account_id: id, email: `${id}@fixture.test`, access_token: 'fixture', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 4_000_000_000, model_quotas: {}, model_limits: {}, model_reset_times: {}, model_forwarding_rules: {} };
}
function policyFixture(persist = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  let generation = 0, current = new Map([['A', token()]]);
  const refreshPolicy = { invalidateActiveRefreshes: () => { generation++; }, beginSnapshotReload: () => ++generation,
    canInstallSnapshot: (value: number) => value === generation, finishSnapshotReload: vi.fn() };
  const loadAccounts = vi.fn().mockImplementation(async () => ({ count: 1, tokens: new Map([['A', token()]]) }));
  const policy = new AccountLeaseSuspensionPolicy({ accountStore: { suspendAccount: persist }, tokenCache: { loadAccounts }, refreshPolicy,
    getTokens: () => current, setTokens: value => { current = value; }, onCacheChange: vi.fn() });
  return { policy, persist, loadAccounts, tokens: () => current };
}

function serviceFixture() {
  let accounts = [account()];
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)), getAccount: vi.fn(async id => structuredClone(accounts.find(a => a.id === id))),
    updateToken: vi.fn(), updateTokenIfCurrent: vi.fn(() => true), updateQuota: vi.fn(), updateQuotaIfCurrent: vi.fn(() => true), updateLastUsed: vi.fn(), updateLastUsedIfCurrent: vi.fn(() => true),
    suspendAccount: vi.fn(async id => { accounts = accounts.map(a => a.id === id ? { ...a, status: 'expired', status_reason: 'tos_violation', is_active: false } : a); }),
  };
  const upstream: AccountLeaseUpstream = { fetchQuota: vi.fn(), refreshAccessToken: vi.fn(), fetchProjectId: vi.fn(), normalizeRefreshedOAuthClientKey: vi.fn() };
  const service = new AccountLeaseService(store, upstream);
  return { service, store, upstream, activate: () => { accounts = [account()]; } };
}

describe('account suspension fencing', () => {
  it('invalidates a snapshot read before suspension', async () => {
    const { service, store } = serviceFixture();
    await service.loadAccounts();
    const snapshot = deferred<CloudAccount[]>();
    vi.mocked(store.getAccounts).mockReturnValueOnce(snapshot.promise);
    const reload = service.reloadAllAccounts();
    service.markAsForbidden('A', 'tos_violation');
    await service.waitForAccountSuspension('A');
    snapshot.resolve([account()]); await reload;
    expect(await service.getNextToken()).toBeNull();
    expect(store.suspendAccount).toHaveBeenCalledOnce();
  });

  it('invalidates reloads started during persistence before releasing the transient fence', async () => {
    const write = deferred<void>(); const f = policyFixture(vi.fn(() => write.promise));
    const pending = f.policy.suspend('A');
    const snapshot = deferred<{ count: number; tokens: Map<string, AccountLeaseTokenData> }>();
    f.loadAccounts.mockReturnValueOnce(snapshot.promise);
    const reload = f.policy.loadAccounts();
    write.resolve(); await pending;
    snapshot.resolve({ count: 1, tokens: new Map([['A', token()]]) });
    expect(await reload).toBe(0); expect(f.tokens().has('A')).toBe(false);
  });

  it('deduplicates writes and keeps failed persistence fenced across generic reloads', async () => {
    const write = deferred<void>(); const f = policyFixture(vi.fn(() => write.promise));
    const first = f.policy.suspend('A'), second = f.policy.suspend('A');
    expect(first).toBe(second); expect(f.persist).toHaveBeenCalledOnce();
    write.reject(new Error('fixture-write-failure')); await expect(first).rejects.toThrow('fixture-write-failure');
    expect(f.policy.isFenced('A')).toBe(true);
    expect(await f.policy.loadAccounts()).toBe(0); expect(f.tokens().has('A')).toBe(false);
    const reviewed = await f.policy.waitForPending('A'); f.policy.clearAfterReview('A', reviewed);
    expect(await f.policy.loadAccounts()).toBe(1);
  });

  it('does not let an older review clear a newer failed suspension', async () => {
    const f = policyFixture(); await f.policy.suspend('A'); const old = await f.policy.waitForPending('A');
    f.persist.mockRejectedValueOnce(new Error('fixture-write-failure'));
    await expect(f.policy.suspend('A')).rejects.toThrow();
    f.policy.clearAfterReview('A', old); expect(f.policy.isFenced('A')).toBe(true);
  });

  it('preserves reviewed reactivation and ignores stale quota ToS responses after reload', async () => {
    const f = serviceFixture(); await f.service.loadAccounts();
    const response = deferred<never>(); vi.mocked(f.upstream.fetchQuota).mockReturnValueOnce(response.promise);
    const refresh = f.service.refreshQuotaCatalog({ force: true });
    await vi.waitFor(() => expect(f.upstream.fetchQuota).toHaveBeenCalledOnce());
    f.activate(); await f.service.reloadAllAccounts();
    response.reject(new Error('TOS_VIOLATION')); await refresh;
    expect(f.store.suspendAccount).not.toHaveBeenCalled();
    expect((await f.service.getNextToken())?.id).toBe('A');
    f.service.markAsForbidden('A', 'tos_violation'); await f.service.waitForAccountSuspension('A');
    f.activate(); const review = await f.service.waitForAccountSuspension('A');
    f.service.clearAccountSuspensionAfterReview('A', review); await f.service.reloadAllAccounts();
    expect((await f.service.getNextToken())?.id).toBe('A');
  });

  it('keeps generated native session identity across an ordinary account reload', async () => {
    const f = serviceFixture(); const incoming = account(); delete incoming.token.session_id;
    vi.mocked(f.store.getAccounts).mockResolvedValue([incoming]);
    await f.service.loadAccounts(); const first = await f.service.getNextToken(); first?.releaseReservation?.();
    await f.service.loadAccounts(); const second = await f.service.getNextToken(); second?.releaseReservation?.();
    expect(first?.token.session_id).toBeTruthy(); expect(second?.token.session_id).toBe(first?.token.session_id);
  });

  it('fences ToS returned by quota fetch after an authentication refresh retry', async () => {
    const f = serviceFixture(), tokens = new Map([['A', token()]]), suspend = vi.fn(async () => { tokens.delete('A'); });
    const fetchQuota = vi.fn().mockRejectedValueOnce(new Error('HTTP 401')).mockRejectedValueOnce(new Error('TOS_VIOLATION'));
    const policy = new AccountLeaseQuotaRefreshPolicy({ accountStore: f.store, upstream: {...f.upstream, fetchQuota},
      getTokenCache: () => tokens, hydrateTokenIfNeeded: vi.fn().mockResolvedValue(true), hydrateTokenAfterAuthFailure: vi.fn().mockResolvedValue(true),
      setLockoutUntilIso: vi.fn(() => true), suspendAccount: suspend, logger: {log: vi.fn(), warn: vi.fn()} });
    await policy.refreshQuotaCatalog({force: true});
    expect(fetchQuota).toHaveBeenCalledTimes(2); expect(suspend).toHaveBeenCalledWith('A'); expect(tokens.has('A')).toBe(false);
  });

  it('routes current quota ToS failures through the same durable suspension', async () => {
    const f = serviceFixture(); await f.service.loadAccounts();
    vi.mocked(f.upstream.fetchQuota).mockRejectedValueOnce(new Error('TOS_VIOLATION'));
    await f.service.refreshQuotaCatalog({ force: true });
    expect(f.store.suspendAccount).toHaveBeenCalledWith('A');
    expect(await f.service.getNextToken()).toBeNull();
  });
});

describe('durable suspension and reviewed activation', () => {
  let directory: string; let previousDir: string | undefined; let previousKey: string | undefined;
  beforeEach(() => {
    previousDir = process.env.AG_PROXY_DATA_DIR; previousKey = process.env.AG_PROXY_MASTER_KEY;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-suspension-test-'));
    process.env.AG_PROXY_DATA_DIR = directory; process.env.AG_PROXY_MASTER_KEY = '34'.repeat(32); resetMasterKeyCacheForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks(); CloudAccountRepo.close(); resetMasterKeyCacheForTesting(); fs.rmSync(directory, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.AG_PROXY_DATA_DIR; else process.env.AG_PROXY_DATA_DIR = previousDir;
    if (previousKey === undefined) delete process.env.AG_PROXY_MASTER_KEY; else process.env.AG_PROXY_MASTER_KEY = previousKey;
  });
  it('keeps restrictions atomically through ordinary imports while returning the actual saved state', async () => {
    await CloudAccountRepo.addAccount(account()); await CloudAccountRepo.suspendAccount('A');
    const saved = await CloudAccountRepo.importAccount({...account(),name:'Updated',token:{...account().token,access_token:'new-fixture'}});
    expect(saved).toMatchObject({status:'expired',status_reason:'tos_violation',is_active:false,name:'Updated',token:{access_token:'new-fixture'}});
    const leases = {loadAccounts:vi.fn(),reloadAllAccounts:vi.fn()} as unknown as AccountLeaseService;
    const result = await new AdminService(leases).importAccounts({version:'1.0',exportedAt:1,accounts:[{...account(),status:'active',status_reason:''}]});
    expect(result.accounts[0]).toMatchObject({status:'expired',status_reason:'tos_violation'});
    expect(await CloudAccountRepo.enableAccount('A',false)).toBe('review_required');
  });

  it('reports the persisted blocked state if suspension arrives during OAuth renewal', async () => {
    await CloudAccountRepo.addAccount(account());
    vi.spyOn(GoogleAPIService,'exchangeCode').mockResolvedValue({access_token:'renewed-fixture',refresh_token:'renewed-refresh',expires_in:3600,token_type:'Bearer',oauth_client_key:'fixture'});
    vi.spyOn(GoogleAPIService,'getUserInfo').mockResolvedValue({id:'fixture',verified_email:true,email:account().email,name:'Fixture',picture:''});
    const ingest = CloudAccountRepo.importAccount.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo,'importAccount').mockImplementationOnce(async value => {await CloudAccountRepo.suspendAccount(value.id);return ingest(value);});
    const leases = {reloadAllAccounts:vi.fn()} as unknown as AccountLeaseService;
    const saved = await new AdminService(leases).exchangeOAuthCode({code:'fixture-code',fetch_quota:false});
    expect(saved).toMatchObject({status:'expired',status_reason:'tos_violation'});
    expect((await CloudAccountRepo.getAccount('A'))?.status).toBe('expired');
  });

  it('rejects an activation whose review snapshot is stale before the durable enable', async () => {
    await CloudAccountRepo.addAccount(account()); await CloudAccountRepo.suspendAccount('A');
    const enable = vi.spyOn(CloudAccountRepo,'enableAccount');
    const leases = {waitForAccountSuspension:vi.fn().mockResolvedValue({accountId:'A',revision:1,isCurrent:()=>false}),isAccountSuspensionFenced:vi.fn(()=>false),reloadAllAccounts:vi.fn()} as unknown as AccountLeaseService;
    const consoleService = new ConsoleAccountsService(new AdminService(leases),leases);
    await expect(consoleService.setDisabled('A',{disabled:false,confirmReview:true})).rejects.toThrow('suspended again');
    expect(enable).not.toHaveBeenCalled(); expect((await CloudAccountRepo.getAccount('A'))?.status).toBe('expired');
  });

  it('persists inactive ToS status across restart and requires atomic reviewed enable', async () => {
    await CloudAccountRepo.addAccount(account()); await CloudAccountRepo.suspendAccount('A'); CloudAccountRepo.close();
    expect(await CloudAccountRepo.getAccount('A')).toMatchObject({ status: 'expired', status_reason: 'tos_violation', is_active: false });
    expect(await CloudAccountRepo.enableAccount('A', false)).toBe('review_required');
    expect(await CloudAccountRepo.enableAccount('A', true)).toBe('enabled');
    expect(await CloudAccountRepo.getAccount('A')).toMatchObject({ status: 'active', status_reason: undefined });
    await expect(CloudAccountRepo.suspendAccount('missing')).rejects.toThrow('one existing account');
    expect(await CloudAccountRepo.enableAccount('missing', true)).toBe('missing');
  });
});
