import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountSchema } from '@/modules/cloud-account/types';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { AdminService } from '@/admin/admin.service';
import { AccountLeaseHydrationPolicy } from '@/modules/proxy-gateway/server/account-lease-hydration-policy';
import { AccountLeaseTokenCache } from '@/modules/proxy-gateway/server/account-lease-token-cache';
import { AccountLeaseFulfillmentPolicy } from '@/modules/proxy-gateway/server/account-lease-fulfillment-policy';
import { NativeSpeechAuth } from '@/modules/proxy-gateway/server/speech/native-speech-auth';

const logger = { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() };
const scopes = 'openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/aicode';
const tokenData = (scope?: string) => ({
  account_id: 'account-1', email: 'owner@example.test', access_token: 'old-access', refresh_token: 'old-refresh',
  id_token: 'old-id', oauth_client_key: 'client-a', scope, token_type: 'Bearer', expires_in: 3600,
  expiry_timestamp: 1, project_id: 'project-1', session_id: 'session-1', model_quotas: {}, model_limits: {},
  model_reset_times: {}, model_forwarding_rules: {},
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native OAuth grant preservation', () => {
  it('persists OAuth consent scopes and the selected OAuth client on account exchange', async () => {
    vi.spyOn(GoogleAPIService, 'exchangeCode').mockResolvedValue({
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer',
      scope: scopes, oauth_client_key: 'client-a',
    });
    vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({ email: 'owner@example.test', name: 'Owner' } as never);
    const importAccount = vi.spyOn(CloudAccountRepo, 'importAccount').mockImplementation(async (input) => input);
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue(undefined);
    const reloadAllAccounts = vi.fn().mockResolvedValue(0);
    const result = await new AdminService({ reloadAllAccounts } as never).exchangeOAuthCode({ code: 'authorization-code', fetch_quota: false });
    expect(importAccount.mock.calls[0][0].token).toMatchObject({ scope: scopes, oauth_client_key: 'client-a' });
    expect(result.token.oauth_client_key).toBe('client-a');
    expect(JSON.stringify(result)).not.toContain(scopes);
    expect(reloadAllAccounts).toHaveBeenCalledOnce();
  });

  it('validates and loads granted scopes without inventing scopes for legacy tokens', async () => {
    const account = CloudAccountSchema.parse({
      id: 'account-1', provider: 'google', email: 'owner@example.test', created_at: 1, last_used: 1,
      token: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, expiry_timestamp: 9999,
        token_type: 'Bearer', scope: scopes, oauth_client_key: 'client-a' },
    });
    const cache = new AccountLeaseTokenCache({ accountStore: { getAccounts: vi.fn().mockResolvedValue([account]) } as never, logger });
    const snapshot = await cache.loadAccounts();
    expect(snapshot?.tokens.get('account-1')).toMatchObject({ scope: scopes, oauth_client_key: 'client-a' });

    const legacy = cache.mapAccountToTokenData({ ...account, token: { ...account.token, scope: undefined } });
    expect(legacy?.scope).toBeUndefined();
  });

  it('retains old scopes and OAuth client when refresh omits them, while persisting rotated tokens', async () => {
    const cached = tokenData(scopes);
    const map = new Map([['account-1', cached]]);
    const persisted = vi.fn(async () => true);
    const refreshAccessToken = vi.fn().mockResolvedValue({
      access_token: 'new-access', refresh_token: 'rotated-refresh', id_token: 'new-id',
      expires_in: 7200, token_type: 'Bearer',
    });
    const policy = new AccountLeaseHydrationPolicy({
      accountStore: {} as never,
      upstream: {
        refreshAccessToken,
        normalizeRefreshedOAuthClientKey: (current: { oauth_client_key?: string; project_id?: string }) => current.oauth_client_key,
      } as never,
      getTokenCache: () => map,
      logger: logger as never,
      persistTokenState: persisted,
    });
    expect(await policy.refreshSelectedTokenIfNeeded('account-1', cached, 100)).toBe(true);
    expect(refreshAccessToken).toHaveBeenCalledWith('old-refresh', undefined, 'client-a');
    expect(cached).toMatchObject({ access_token: 'new-access', refresh_token: 'rotated-refresh', id_token: 'new-id', scope: scopes, oauth_client_key: 'client-a' });
    expect(persisted).toHaveBeenCalledWith('account-1', expect.objectContaining({ refresh_token: 'rotated-refresh', scope: scopes }));
  });

  it('replaces scope only when Google returns a new granted scope string', async () => {
    const cached = tokenData(scopes);
    const map = new Map([['account-1', cached]]);
    const policy = new AccountLeaseHydrationPolicy({
      accountStore: {} as never,
      upstream: { refreshAccessToken: vi.fn().mockResolvedValue({ access_token: 'new', expires_in: 3600, token_type: 'Bearer', scope: 'openid https://www.googleapis.com/auth/aicode' }), normalizeRefreshedOAuthClientKey: (current: { oauth_client_key?: string; project_id?: string }) => current.oauth_client_key } as never,
      getTokenCache: () => map,
      logger: logger as never,
      persistTokenState: vi.fn(async () => true),
    });
    expect(await policy.refreshSelectedTokenIfNeeded('account-1', cached, 100)).toBe(true);
    expect(cached.scope).toBe('openid https://www.googleapis.com/auth/aicode');
  });
  it.each([true, false])('preserves GCP billing identity=%s through the real cache and lease fulfillment', async (isGcp) => {
    const account = CloudAccountSchema.parse({
      id: 'account-1', provider: 'google', email: 'owner@example.test', created_at: 1, last_used: 1,
      token: { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer',
        expires_in: 3600, expiry_timestamp: 9999999999, project_id: 'project-1', scope: scopes, is_gcp_tos: isGcp },
    });
    const cache = new AccountLeaseTokenCache({ accountStore: {} as never, logger });
    const cached = cache.mapAccountToTokenData(account)!;
    const fulfillment = new AccountLeaseFulfillmentPolicy({
      hydrationPolicy: {
        hydrateSelectedToken: vi.fn().mockResolvedValue({ outcome: 'hydrated', projectId: 'project-1' }),
        recordSelectedTokenUse: vi.fn().mockResolvedValue('recorded'),
      } as never,
      bindSession: vi.fn(), stickySessionTtlMs: 1000, resolveFallbackProjectId: () => 'fallback', logger,
    });
    const selected = await fulfillment.finalizeSelectedToken({ accountId: account.id, tokenData: cached, nowSeconds: 100 });
    expect(selected?.token).toMatchObject({ scope: scopes, is_gcp_tos: isGcp });
    vi.spyOn(GoogleAPIService, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioTranscriptionModelIds: ['speech-1'] }))));
    const auth = new NativeSpeechAuth({ acquireAttemptLease: vi.fn().mockResolvedValue({ account: selected, releaseReservation: vi.fn() }) } as never);
    const resolved = await auth.resolve();
    expect(resolved.projectId).toBe(isGcp ? 'project-1' : undefined);
    resolved.release();
  });
});
