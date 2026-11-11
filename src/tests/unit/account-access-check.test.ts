import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessCheckService } from '@/admin-console/account-access-check.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { OAuthClientRegistryService } from '@/modules/cloud-account/services/OAuthClientRegistryService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';
import type { CloudAccount } from '@/modules/cloud-account/types';

const ban = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Service has been disabled in this account for violation of terms of service' } };
const generated = { response: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] } };

describe('explicit account access checks', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: AccountAccessCheckService;
  let account: CloudAccount;
  beforeEach(async () => {
    env = { ...process.env };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-access-check-'));
    process.env.AG_PROXY_DATA_DIR = dir;
    process.env.AG_PROXY_MASTER_KEY = '34'.repeat(32);
    process.env.PROXY_INTERNAL_BASE_URLS = 'https://probe.example.test/v1internal';
    resetMasterKeyCacheForTesting();
    account = { id: 'disabled-account', name: null, avatar_url: null, provider: 'google', email: 'fixture@example.test',
      status: 'expired', status_reason: 'tos_violation', is_active: false, created_at: 1, last_used: 2,
      token: { access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, expiry_timestamp: Date.now() / 1000 + 3600, token_type: 'Bearer', project_id: 'private-project', oauth_client_key: 'client-a' },
      quota: { models: { 'gemini-2.5-flash': { percentage: 0, resetTime: '' } }, is_forbidden: true }, proxy_url: 'http://account-proxy.test' };
    await CloudAccountRepo.addAccount(account);
    vi.spyOn(GoogleAPIService, 'getFetchOptions').mockReturnValue({});
    fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    service = new AccountAccessCheckService();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); CloudAccountRepo.close(); resetMasterKeyCacheForTesting();
    process.env = env;
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
  function reply(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }
  it('checks disabled/review accounts directly and preserves state, quota and timestamps on restored generation', async () => {
    reply(200, generated);
    const result = await service.check(account.id);
    expect(result).toMatchObject({ outcome: 'working', comparison: 'restored', previous_reason: 'tos_violation', reason: 'generation_succeeded', evidence: { stage: 'generation', model: 'gemini-2.5-flash', http_status: 200 } });
    expect(await CloudAccountRepo.getAccount(account.id)).toEqual(account);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://probe.example.test/v1internal:generateContent');
    expect(request.headers.Authorization).toBe('Bearer secret-access');
    expect(JSON.parse(request.body)).toMatchObject({ model: 'gemini-2.5-flash', project: 'private-project', request: { generationConfig: { maxOutputTokens: 16 } } });
    expect(GoogleAPIService.getFetchOptions).toHaveBeenCalledWith('http://account-proxy.test');
    expect(JSON.stringify(result)).not.toMatch(/secret-|private-project|fixture@/);
  });
  it('persists bounded last result and prior comparison across database/service restart', async () => {
    reply(403, ban);
    const first = await service.check(account.id);
    expect(first).toMatchObject({ outcome: 'banned', reason: 'tos_violation', comparison: 'same' });
    CloudAccountRepo.close(); service = new AccountAccessCheckService();
    expect(CloudAccountRepo.getAccessCheck(account.id)).toEqual(first);
    reply(200, generated);
    const restored = await service.check(account.id);
    expect(restored).toMatchObject({ comparison: 'restored', previous_checked_at: first.checked_at, previous_reason: 'tos_violation' });
    reply(200, generated);
    const same = await service.check(account.id);
    expect(same).toMatchObject({ comparison: 'same', previous_reason: 'generation_succeeded', previous_checked_at: restored.checked_at });
    expect(JSON.stringify(same)).not.toContain('previous_result');
    await CloudAccountRepo.removeAccount(account.id);
    expect(CloudAccountRepo.getAccessCheck(account.id)).toBeNull();
  });
  it.each([
    [403, { error: { status: 'PERMISSION_DENIED', message: 'forbidden' } }, 'permission-denied'],
    [429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'quota'],
    [503, { error: { status: 'UNAVAILABLE' } }, 'transient'],
    [500, { error: { status: 'INTERNAL' } }, 'unknown'],
    [404, { error: { message: 'model not found' } }, 'model-capability'],
    [200, { response: { candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }] } }] } }, 'invalid_generation_response'],
    [200, { candidates: [{ content: { role: 'user', parts: [{ text: 'echoed request' }] } }] }, 'invalid_generation_response'],
    [200, {}, 'invalid_generation_response'],
    [200, { response: { candidates: [{ content: { parts: [{ text: '' }] } }] } }, 'invalid_generation_response'],
  ])('keeps HTTP %s inconclusive rather than declaring a ban or restoration', async (status, body, reason) => {
    reply(status, body);
    const result = await service.check(account.id);
    expect(result).toMatchObject({ outcome: 'inconclusive', reason, comparison: 'changed' });
    expect(await CloudAccountRepo.getAccount(account.id)).toEqual(account);
  });
  it('rejects malformed JSON success and network errors without exposing upstream text', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not-json secret-access', { status: 200 }));
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'invalid_generation_response' });
    fetchMock.mockRejectedValueOnce(new Error('network secret-refresh'));
    const result = await service.check(account.id);
    expect(result).toMatchObject({ outcome: 'inconclusive', reason: 'request_failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('refreshes expired OAuth on the account proxy/client and verifies generation separately', async () => {
    await CloudAccountRepo.updateToken(account.id, { ...account.token, expiry_timestamp: 0 });
    const refresh = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' });
    vi.spyOn(GoogleAPIService, 'normalizeRefreshedOAuthClientKey').mockReturnValue('client-a');
    reply(403, ban);
    expect(await service.check(account.id)).toMatchObject({ outcome: 'banned' });
    expect(refresh).toHaveBeenCalledWith('secret-refresh', 'http://account-proxy.test', 'client-a', { signal: expect.any(AbortSignal), reportInvalidGrant: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer fresh-access');
    expect(await CloudAccountRepo.getAccount(account.id)).toMatchObject({ status: 'expired', status_reason: 'tos_violation', quota: account.quota, token: { access_token: 'fresh-access', refresh_token: 'secret-refresh' } });
  });
  it('retries a 401 once with fresh OAuth for the same account', async () => {
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' });
    reply(401, { error: { status: 'UNAUTHENTICATED' } }); reply(401, { error: { status: 'UNAUTHENTICATED' } });
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'authentication' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-access');
  });
  it('reports invalid_grant distinctly and never treats OAuth success as generation success', async () => {
    await CloudAccountRepo.updateToken(account.id, { ...account.token, expiry_timestamp: 0 });
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockRejectedValue(new Error('OAUTH_INVALID_GRANT'));
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'oauth_revoked', evidence: { stage: 'oauth' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await CloudAccountRepo.getAccount(account.id)).toMatchObject({ status: 'expired', status_reason: 'tos_violation', quota: account.quota });
  });
  it('uses the real OAuth registry path to classify invalid_grant safely', async () => {
    await CloudAccountRepo.updateToken(account.id, { ...account.token, expiry_timestamp: 0 });
    vi.spyOn(OAuthClientRegistryService, 'getCandidateClients').mockReturnValue([{ key: 'client-a', label: 'Fixture', client_id: 'client-id', client_secret: 'private-secret', is_builtin: false }]);
    reply(400, { error: 'invalid_grant', error_description: 'secret-refresh rejected' });
    const result = await service.check(account.id);
    expect(result).toMatchObject({ outcome: 'inconclusive', reason: 'oauth_revoked', evidence: { stage: 'oauth' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(JSON.stringify(result)).not.toMatch(/private-secret|secret-refresh/);
  });
  it('uses one 24-second deadline for OAuth and generation', async () => {
    await CloudAccountRepo.updateToken(account.id, { ...account.token, expiry_timestamp: 0 });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const refresh = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' });
    reply(200, generated);
    expect(await service.check(account.id)).toMatchObject({ outcome: 'working' });
    expect(timeout).toHaveBeenCalledWith(24000);
    expect(fetchMock.mock.calls[0][1].signal).toBe(refresh.mock.calls[0][3]?.signal);
  });
  it('reports an aborted check as inconclusive without persisting a ban', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('secret-access', 'AbortError');
    });
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'timeout' });
    expect(await CloudAccountRepo.getAccount(account.id)).toEqual(account);
  });
  it('coalesces concurrent same-account checks and sequential batches including disabled accounts', async () => {
    await CloudAccountRepo.addAccount({ ...account, id: 'second', email: 'second@example.test', status_reason: 'operator_disabled' });
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const single = service.check(account.id); const duplicate = service.check(account.id);
    const batch = service.checkAll(); expect(service.checkAll()).toBe(batch);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(duplicate).toBe(single);
    reply(200, generated);
    release(new Response(JSON.stringify(generated), { status: 200 }));
    const [result, all] = await Promise.all([single, batch]);
    expect(all.results).toHaveLength(2); expect(all.results[0]).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('compares HTTP status, rule, stage and probe model before reporting the same error', async () => {
    reply(403, { error: { status: 'PERMISSION_DENIED' } });
    expect(await service.check(account.id)).toMatchObject({ reason: 'permission-denied', comparison: 'changed' });
    reply(403, { error: { status: 'PERMISSION_DENIED' } });
    expect(await service.check(account.id)).toMatchObject({ comparison: 'same' });
    reply(200, { error: { status: 'PERMISSION_DENIED' } });
    expect(await service.check(account.id)).toMatchObject({ reason: 'permission-denied', comparison: 'changed' });
    await CloudAccountRepo.updateQuota(account.id, { models: { 'gemini-3.5-flash-lite': { percentage: 10, resetTime: '' } } });
    reply(200, { error: { status: 'PERMISSION_DENIED' } });
    expect(await service.check(account.id)).toMatchObject({ comparison: 'changed', evidence: { model: 'gemini-3.5-flash-lite' } });
  });
  it('reports restored after an inconclusive check against a stored explicit ban, then same on repeated success', async () => {
    reply(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive' });
    reply(200, generated);
    expect(await service.check(account.id)).toMatchObject({ outcome: 'working', comparison: 'restored' });
    reply(200, generated);
    expect(await service.check(account.id)).toMatchObject({ outcome: 'working', comparison: 'same' });
  });
  it('chooses a stable native flash-lite model independently of catalog order and forwards known aliases', async () => {
    const info = { percentage: 10, resetTime: '' };
    await CloudAccountRepo.updateQuota(account.id, { models: { 'gemini-2.5-flash': info, 'gemini-3.5-flash-lite': info }, model_forwarding_rules: { 'gemini-2.5-flash': 'gemini-3.5-flash-lite' } });
    reply(200, generated);
    expect(await service.check(account.id)).toMatchObject({ evidence: { model: 'gemini-3.5-flash-lite' } });
    await CloudAccountRepo.updateQuota(account.id, { models: { 'gemini-3.5-flash-lite': info, 'gemini-2.5-flash': info } });
    reply(200, generated);
    expect(await service.check(account.id)).toMatchObject({ comparison: 'same', evidence: { model: 'gemini-3.5-flash-lite' } });
  });
  it('keeps preferred-client invalid_grant evidence after another client rejects the grant', async () => {
    await CloudAccountRepo.updateToken(account.id, { ...account.token, expiry_timestamp: 0 });
    vi.spyOn(OAuthClientRegistryService, 'getCandidateClients').mockReturnValue(['client-a', 'client-b'].map((key) => ({ key, label: key, client_id: key, client_secret: '', is_builtin: false })));
    reply(400, { error: 'invalid_grant' }); reply(401, { error: 'invalid_client' });
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'oauth_revoked' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('compares refreshed credential identity canonically when OAuth adds optional fields', async () => {
    const legacyToken = { ...account.token };
    delete legacyToken.oauth_client_key;
    await CloudAccountRepo.updateToken(account.id, { ...legacyToken, expiry_timestamp: 0 });
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer', scope: 'openid', id_token: 'fresh-id', oauth_client_key: 'client-a' });
    vi.spyOn(GoogleAPIService, 'normalizeRefreshedOAuthClientKey').mockReturnValue('client-a');
    reply(200, generated);
    expect(await service.check(account.id)).toMatchObject({ outcome: 'working' });
    expect(CloudAccountRepo.getAccessCheck(account.id)).toMatchObject({ outcome: 'working' });
  });
  it('does not overwrite credentials replaced while OAuth refresh is pending', async () => {
    await CloudAccountRepo.updateToken(account.id, { ...account.token, expiry_timestamp: 0 });
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockImplementation(async () => {
      await CloudAccountRepo.updateToken(account.id, { ...account.token, refresh_token: 'new-import-refresh', project_id: 'new-project' });
      return { access_token: 'obsolete-access', expires_in: 3600, token_type: 'Bearer' };
    });
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'account_changed' });
    expect(await CloudAccountRepo.getAccount(account.id)).toMatchObject({ token: { refresh_token: 'new-import-refresh', project_id: 'new-project' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(CloudAccountRepo.getAccessCheck(account.id)).toBeNull();
  });
  it('does not persist obsolete generation success after account replacement', async () => {
    fetchMock.mockImplementationOnce(async () => {
      await CloudAccountRepo.removeAccount(account.id);
      await CloudAccountRepo.addAccount({ ...account, token: { ...account.token, refresh_token: 'replacement-refresh' } });
      return new Response(JSON.stringify(generated), { status: 200 });
    });
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'account_changed' });
    expect(CloudAccountRepo.getAccessCheck(account.id)).toBeNull();
  });
  it('does not accept an oversized response as successful generation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x'.repeat(70000) }] } }] }), { status: 200 }));
    expect(await service.check(account.id)).toMatchObject({ outcome: 'inconclusive', reason: 'request_failed' });
  });
});
