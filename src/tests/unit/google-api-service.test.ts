import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AuthServer } from '@/modules/cloud-account/ipc/authServer';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { OAuthClientRegistryService } from '@/modules/cloud-account/services/OAuthClientRegistryService';
import { logger } from '@/shared/logging/logger';
import {
  AICreditsAuthenticationError,
  isAICreditsAuthenticationError,
} from '@/modules/cloud-account/services/ai-credits-authentication-error';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GoogleAPIService OAuth and AI credits', () => {
  it('builds an authorization URL with one openid scope and the required OAuth options', () => {
    vi.spyOn(OAuthClientRegistryService, 'selectAuthClient').mockReturnValue({
      key: 'selected-client',
      label: 'Selected client',
      client_id: 'selected-client-id',
      client_secret: '',
      is_builtin: false,
    });
    vi.spyOn(AuthServer, 'getRedirectUri').mockReturnValue('http://127.0.0.1/callback');

    const url = new URL(GoogleAPIService.getAuthUrl('selected-client'));
    const scopes = url.searchParams.get('scope')?.split(' ') ?? [];

    expect(scopes).toEqual(
      expect.arrayContaining([
        'openid',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
        'https://www.googleapis.com/auth/aicode',
      ]),
    );
    expect(scopes.filter((scope) => scope === 'openid')).toHaveLength(1);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('selected-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1/callback');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('fetches AI credits using the account proxy options', async () => {
    const dispatcher = {};
    const getFetchOptions = vi
      .spyOn(GoogleAPIService as any, 'getFetchOptions')
      .mockReturnValue({ dispatcher });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        paidTier: { availableCredits: [{ creditType: 'AI', creditAmount: '12.5' }] },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(GoogleAPIService.fetchAICredits('', 'http://proxy.example')).resolves.toEqual({
      credits: 12,
      expiryDate: '',
    });

    expect(getFetchOptions).toHaveBeenCalledWith('http://proxy.example');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('loadCodeAssist'),
      expect.objectContaining({ method: 'POST', dispatcher }),
    );
  });

  it('disposes the project-context timeout after a successful request', async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return Promise.resolve({
          ok: true,
          json: vi.fn().mockResolvedValue({ cloudaicompanionProject: 'project-1' }),
        });
      }),
    );

    try {
      await expect(GoogleAPIService.fetchProjectContext('access-token')).resolves.toEqual({
        projectId: 'project-1',
        subscriptionTier: undefined,
      });

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes token exchange, token refresh, and user-info timeouts after every fetch outcome', async () => {
    vi.useFakeTimers();
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.spyOn(OAuthClientRegistryService, 'getCandidateClients').mockReturnValue([
      {
        key: 'test-client',
        label: 'Test client',
        client_id: 'client-id',
        client_secret: 'client-secret',
        is_builtin: false,
      },
    ]);
    vi.spyOn(AuthServer, 'getRedirectUri').mockReturnValue('http://127.0.0.1/callback');

    const requests = [
      {
        name: 'token exchange',
        run: () => GoogleAPIService.exchangeCode('authorization-code'),
        success: { ok: true, json: vi.fn().mockResolvedValue({ access_token: 'access', expires_in: 1, token_type: 'Bearer' }) },
      },
      {
        name: 'token refresh',
        run: () => GoogleAPIService.refreshAccessToken('refresh-token'),
        success: { ok: true, json: vi.fn().mockResolvedValue({ access_token: 'access', expires_in: 1, token_type: 'Bearer' }) },
      },
      {
        name: 'user info',
        run: () => GoogleAPIService.getUserInfo('access-token'),
        success: { ok: true, json: vi.fn().mockResolvedValue({ id: 'id', email: 'email@test.dev' }) },
      },
    ];

    try {
      for (const request of requests) {
        for (const outcome of ['success', 'http failure', 'thrown fetch'] as const) {
          let aborts = 0;
          vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
              init?.signal?.addEventListener('abort', () => {
                aborts += 1;
              });
              if (outcome === 'success') {
                return Promise.resolve(request.success);
              }
              if (outcome === 'http failure') {
                return Promise.resolve({ ok: false, status: 500, text: vi.fn().mockResolvedValue('ignored') });
              }
              return Promise.reject(new Error('fetch failed'));
            }),
          );

          if (outcome === 'success') {
            await expect(request.run()).resolves.toBeDefined();
          } else {
            await expect(request.run()).rejects.toBeInstanceOf(Error);
          }
          expect(vi.getTimerCount()).toBe(0);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(aborts, `${request.name} ${outcome}`).toBe(0);
          vi.unstubAllGlobals();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts OAuth client and account canaries from exchange, refresh, and API diagnostics', async () => {
    const rawCanaries = [
      'canary-oauth-client-key',
      'canary-client-id',
      'canary-client-secret',
      'canary-api-key',
      'canary-authorization-code',
      'canary-refresh-token',
      'canary-access-token',
      'canary-email@example.test',
      'canary-account-id',
      'canary-project-id',
      'http://canary-proxy.example.test',
    ];
    const canaries = rawCanaries.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    const upstreamPayload = canaries.join('|');
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.spyOn(OAuthClientRegistryService, 'getCandidateClients').mockReturnValue([
      {
        key: rawCanaries[0],
        label: 'Canary client',
        client_id: rawCanaries[1],
        client_secret: rawCanaries[2],
        is_builtin: false,
      },
    ]);
    vi.spyOn(AuthServer, 'getRedirectUri').mockReturnValue('http://127.0.0.1/callback');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(upstreamPayload),
    });
    const exchangeError = await GoogleAPIService.exchangeCode(rawCanaries[4], rawCanaries[10]).catch(
      (caught: unknown) => caught,
    );
    expect(String(exchangeError)).toBe('Error: Token exchange failed: HTTP 500');

    fetchMock.mockReset().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(upstreamPayload),
    });
    const refreshError = await GoogleAPIService.refreshAccessToken(
      rawCanaries[5],
      rawCanaries[10],
    ).catch((caught: unknown) => caught);
    expect(String(refreshError)).toBe('Error: Token refresh failed: HTTP 500');

    fetchMock.mockReset().mockRejectedValueOnce(new Error(upstreamPayload));
    const projectError = await GoogleAPIService.fetchProjectContext(rawCanaries[6], rawCanaries[10]).catch(
      (caught: unknown) => caught,
    );
    expect(String(projectError)).toBe('Error: REQUEST_FAILED');

    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockRejectedValue(new Error(upstreamPayload));
    fetchMock.mockReset().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(upstreamPayload),
    });
    const quotaError = await GoogleAPIService.fetchQuota(rawCanaries[6], rawCanaries[10]).catch(
      (caught: unknown) => caught,
    );
    expect(String(quotaError)).toBe('Error: HTTP 400');

    const diagnostics = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    for (const canary of canaries) {
      expect(diagnostics).not.toContain(canary);
      expect(String(exchangeError)).not.toContain(canary);
      expect(String(refreshError)).not.toContain(canary);
      expect(String(projectError)).not.toContain(canary);
      expect(String(quotaError)).not.toContain(canary);
    }
    expect(diagnostics).toContain('operation=token_exchange');
    expect(diagnostics).toContain('operation=token_refresh');
  });

  it('disposes the AI-credit parent abort listener after an external abort', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const addListener = vi.spyOn(parent.signal, 'addEventListener');
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      ),
    );

    try {
      const credits = GoogleAPIService.fetchAICredits('access-token', undefined, parent.signal);
      parent.abort();

      await expect(credits).resolves.toBeNull();
      expect(addListener).toHaveBeenCalledOnce();
      expect(removeListener).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['direct HTTP 401', () => Promise.resolve({ ok: false, status: 401 })],
    ['direct HTTP 403', () => Promise.resolve({ ok: false, status: 403 })],
    ['sanitized HTTP 401', () => Promise.reject(new Error('HTTP 401'))],
    ['sanitized UNAUTHORIZED', () => Promise.reject(new Error('UNAUTHORIZED'))],
    [
      'caught HTTP 401',
      () =>
        Promise.reject(
          Object.assign(new Error('sensitive upstream failure detail'), { status: 401 }),
        ),
    ],
  ])('rethrows a sanitized authentication failure for %s', async (_scenario, fetchResult) => {
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal('fetch', vi.fn().mockImplementation(fetchResult));

    const error = await GoogleAPIService.fetchAICredits('redacted-test-value').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AICreditsAuthenticationError);
    expect(isAICreditsAuthenticationError(error)).toBe(true);
    expect(String(error)).toBe('AICreditsAuthenticationError: AI credits authentication failed');
    expect(String(error)).not.toContain('redacted-test-value');
    expect(String(error)).not.toContain('sensitive upstream failure detail');
  });

  it.each([
    ['non-auth HTTP failure', () => Promise.resolve({ ok: false, status: 503 })],
    ['network fallback failure', () => Promise.reject(new Error('network unavailable'))],
    ['unrelated numeric error', () => Promise.reject(new Error('HTTP 4012'))],
    ['untrusted message mentioning auth', () => Promise.reject(new Error('upstream said UNAUTHORIZED'))],
    ['untrusted message mentioning forbidden', () => Promise.reject(new Error('upstream said 403 FORBIDDEN'))],
  ])('keeps AI credits best-effort for %s', async (_scenario, fetchResult) => {
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal('fetch', vi.fn().mockImplementation(fetchResult));

    await expect(GoogleAPIService.fetchAICredits('')).resolves.toBeNull();
  });

  it('merges quota summary and AI credits when both optional lookups succeed', async () => {
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
      projectId: 'safe-project-id',
      subscriptionTier: 'pro',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ models: {} }) }),
    );
    vi.spyOn(GoogleAPIService as any, 'fetchQuotaSummary').mockResolvedValue([
      { display_name: 'Gemini Models', buckets: [] },
    ]);
    vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue({ credits: 12, expiryDate: '' });

    await expect(GoogleAPIService.fetchQuota('access-token')).resolves.toMatchObject({
      quota_groups: [{ display_name: 'Gemini Models', buckets: [] }],
      ai_credits: { credits: 12, expiryDate: '' },
    });
  });

  it('aborts and settles quota summary before propagating an AI-credit authentication failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({});
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('fetchAvailableModels')) {
        return Promise.resolve({ ok: true, json: vi.fn().mockResolvedValue({ models: {} }) });
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeDefined();
          signal?.addEventListener('abort', () => {
            summaryAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }).finally(() => {
          summarySettled = true;
        });
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    let summaryAborted = false;
    let summarySettled = false;
    vi.stubGlobal('fetch', fetchMock);
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const quota = GoogleAPIService.fetchQuota('access-token');
      const completion = Promise.race([
        quota.then(
          () => 'resolved',
          (error: unknown) => (isAICreditsAuthenticationError(error) ? 'authenticated' : 'failed'),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1)),
      ]);

      await vi.advanceTimersByTimeAsync(1);

      expect(summaryAborted).toBe(true);
      expect(summarySettled).toBe(true);
      expect(await completion).toBe('authenticated');
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('retrieveUserQuotaSummary')),
      ).toHaveLength(1);
      await vi.runAllTicks();
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      vi.useRealTimers();
    }
  });

  it('aborts and settles AI credits when quota summary rejects later', async () => {
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ models: {} }) }),
    );

    const summaryError = new Error('UNAUTHORIZED');
    let rejectSummary: (reason: Error) => void = () => undefined;
    let summaryStarted = false;
    let creditsAborted = false;
    let creditsSettled = false;
    vi.spyOn(GoogleAPIService as any, 'fetchQuotaSummary').mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          summaryStarted = true;
          rejectSummary = reject;
        }),
    );
    vi.spyOn(GoogleAPIService, 'fetchAICredits').mockImplementation(
      (_accessToken, _proxyUrl, signal?: AbortSignal) =>
        new Promise<null>((resolve) => {
          signal?.addEventListener('abort', () => {
            creditsAborted = true;
            resolve(null);
          });
        }).finally(() => {
          creditsSettled = true;
        }),
    );

    const quota = GoogleAPIService.fetchQuota('access-token');
    await vi.waitFor(() => {
      expect(summaryStarted).toBe(true);
    });
    rejectSummary(summaryError);

    await expect(quota).rejects.toBe(summaryError);
    expect(creditsAborted).toBe(true);
    expect(creditsSettled).toBe(true);
  });

  it('adds AI credits to the real quota result and keeps non-auth credit failures optional', async () => {
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
      projectId: 'safe-project-id',
      subscriptionTier: 'pro',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({ models: {} }),
        })
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            paidTier: { availableCredits: [{ creditType: 'AI', creditAmount: '12.5' }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({ models: {} }),
        })
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({ ok: false, status: 503 }),
    );

    await expect(GoogleAPIService.fetchQuota('access-token')).resolves.toMatchObject({
      ai_credits: { credits: 12, expiryDate: '' },
    });
    await expect(GoogleAPIService.fetchQuota('access-token')).resolves.not.toHaveProperty(
      'ai_credits',
    );
  });

  it('propagates a sanitized AI-credit authentication failure through fetchQuota', async () => {
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({ models: {} }),
        })
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({ ok: false, status: 401 }),
    );

    const error = await GoogleAPIService.fetchQuota('canary-access-token').catch(
      (caught: unknown) => caught,
    );

    expect(isAICreditsAuthenticationError(error)).toBe(true);
    expect(String(error)).toBe('AICreditsAuthenticationError: AI credits authentication failed');
    expect(String(error)).not.toContain('canary-access-token');
  });

  it('redacts upstream failure bodies from project, quota, token, and user-info diagnostics', async () => {
    const canary = 'raw-upstream-canary-secret';
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');
    vi.spyOn(GoogleAPIService as any, 'getFetchOptions').mockReturnValue({});
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockRejectedValueOnce(Object.assign(new Error(canary), { status: 503 }));
    const projectError = await GoogleAPIService.fetchProjectContext('canary-access-token').catch(
      (caught: unknown) => caught,
    );
    expect(String(projectError)).toBe('Error: HTTP 503');

    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({});
    fetchMock.mockReset().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(canary),
    });
    const quotaError = await GoogleAPIService.fetchQuota('canary-access-token').catch(
      (caught: unknown) => caught,
    );
    expect(String(quotaError)).toBe('Error: HTTP 400');

    fetchMock
      .mockReset()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ models: {} }) })
      .mockRejectedValueOnce(Object.assign(new Error(canary), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error(canary), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error(canary), { status: 503 }))
      .mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(GoogleAPIService.fetchQuota('canary-access-token')).resolves.toEqual({
      models: {},
      subscription_tier: undefined,
      is_forbidden: false,
    });

    vi.spyOn(OAuthClientRegistryService, 'getCandidateClients').mockReturnValue([
      {
        key: 'test-client',
        label: 'Test client',
        client_id: 'client-id',
        client_secret: 'client-secret',
        is_builtin: false,
      },
    ]);
    fetchMock.mockReset().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(canary),
    });
    const refreshError = await GoogleAPIService.refreshAccessToken('canary-refresh-token').catch(
      (caught: unknown) => caught,
    );
    expect(String(refreshError)).toContain('HTTP 500');

    fetchMock.mockReset().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue(canary),
    });
    const userInfoError = await GoogleAPIService.getUserInfo('canary-access-token').catch(
      (caught: unknown) => caught,
    );
    expect(String(userInfoError)).toBe('Error: Failed to fetch user info: HTTP 401');

    const diagnostics = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(diagnostics).toContain('HTTP 503');
    expect(diagnostics).toContain('endpoint #1');
    expect(diagnostics).not.toContain(canary);
    expect(String(projectError)).not.toContain(canary);
    expect(String(quotaError)).not.toContain(canary);
    expect(String(refreshError)).not.toContain(canary);
    expect(String(userInfoError)).not.toContain(canary);
  });
});
