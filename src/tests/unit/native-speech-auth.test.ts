import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeSpeechAuth, NativeSpeechAuthorizationError } from '@/modules/proxy-gateway/server/speech/native-speech-auth';

const account = (overrides: Record<string, unknown> = {}) => ({
  id: 'pinned', provider: 'google', email: 'pinned@example.test', status: 'active',
  token: { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: Math.floor(Date.now() / 1000) + 3600, project_id: 'project' },
  created_at: 1, last_used: 1, ...overrides,
} as any);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('NativeSpeechAuth', () => {
  it('uses the ordinary account pool lease without requiring a speech-only pin', async () => {
    vi.stubEnv('AG_PROXY_SPEECH_ACCOUNT_ID', '');
    const releaseReservation = vi.fn();
    const leases = { acquireAttemptLease: vi.fn().mockResolvedValue({ account: account(), releaseReservation }) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioTranscriptionModelIds: ['speech-1'] }), { status: 200 })));
    const auth = new NativeSpeechAuth(leases as any);
    const result = await auth.resolve();
    expect(leases.acquireAttemptLease).toHaveBeenCalledWith({ signal: undefined });
    expect(result.accountId).toBe('pinned');
    expect(result.release).toBe(releaseReservation);
    result.release();
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it('rejects when the ordinary account pool has no eligible account', async () => {
    vi.stubEnv('AG_PROXY_SPEECH_ACCOUNT_ID', 'pinned');
    const leases = { acquireAttemptLease: vi.fn().mockResolvedValue(null) };
    await expect(new NativeSpeechAuth(leases as any).resolve()).rejects.toMatchObject({ code: 'account_unavailable' });
  });

  it('uses the selected token without treating a consumer companion project as a billing project', async () => {
    vi.stubEnv('AG_PROXY_SPEECH_ACCOUNT_ID', 'pinned');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioTranscriptionModelIds: ['speech-1'] }), { status: 200 })));
    const releaseReservation = vi.fn();
    const leases = { acquireAttemptLease: vi.fn().mockResolvedValue({ account: account(), releaseReservation }) };
    const result = await new NativeSpeechAuth(leases as any).resolve(undefined, 'speech-1');
    expect(result).toMatchObject({ accountId: 'pinned', accessToken: 'access', models: ['speech-1'] });
    expect(result.projectId).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leases.acquireAttemptLease).toHaveBeenCalledWith({ signal: undefined });
    result.release();
  });

  it('retains an explicit GCP billing project for GCP authorization', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioTranscriptionModelIds: ['speech-1'] }), { status: 200 })));
    const selected = account(); selected.token.is_gcp_tos = true;
    const leases = { acquireAttemptLease: vi.fn().mockResolvedValue({ account: selected, releaseReservation: vi.fn() }) };
    const result = await new NativeSpeechAuth(leases as any).resolve();
    expect(result.projectId).toBe('project');
    result.release();
  });

  it('fails closed on catalog errors and does not retry another account', async () => {
    vi.stubEnv('AG_PROXY_SPEECH_ACCOUNT_ID', 'pinned');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 403 })));
    const releaseReservation = vi.fn();
    const leases = { acquireAttemptLease: vi.fn().mockResolvedValue({ account: account(), releaseReservation }) };
    const auth = new NativeSpeechAuth(leases as any);
    await expect(auth.resolve()).rejects.toBeInstanceOf(NativeSpeechAuthorizationError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leases.acquireAttemptLease).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it('rejects models absent from the pinned account catalog without inference fallback', async () => {
    vi.stubEnv('AG_PROXY_SPEECH_ACCOUNT_ID', 'pinned');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audioTranscriptionModelIds: ['speech-1'] }), { status: 200 })));
    const releaseReservation = vi.fn();
    const leases = { acquireAttemptLease: vi.fn().mockResolvedValue({ account: account(), releaseReservation }) };
    await expect(new NativeSpeechAuth(leases as any).resolve(undefined, 'speech-2')).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

});
