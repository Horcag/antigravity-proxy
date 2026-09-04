import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  GeminiClient,
  UserProjectCapabilityCache,
} from '@/modules/proxy-gateway/server/clients/gemini.client';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

function createAxiosError(status: number, message: string, data?: unknown) {
  const error = new Error(message) as any;
  error.isAxiosError = true;
  error.response = {
    status,
    statusText: String(status),
    headers: {},
    config: {},
    data: data ?? { error: { code: status, message, status: 'ERROR' } },
  };
  return error;
}

function createInternalRequest(params?: Partial<GeminiInternalRequest>): GeminiInternalRequest {
  return {
    project: '',
    requestId: 'req-test',
    model: 'gemini-3-flash',
    userAgent: 'test-agent',
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    ...params,
  };
}

describe('Upstream Endpoint and Project Header Stability', () => {
  const originalEnv = process.env.PROXY_INTERNAL_BASE_URLS;
  const originalAntigravityEnv = process.env.ANTIGRAVITY_INTERNAL_BASE_URLS;

  beforeEach(() => {
    delete process.env.PROXY_INTERNAL_BASE_URLS;
    delete process.env.ANTIGRAVITY_INTERNAL_BASE_URLS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv !== undefined) {
      process.env.PROXY_INTERNAL_BASE_URLS = originalEnv;
    } else {
      delete process.env.PROXY_INTERNAL_BASE_URLS;
    }
    if (originalAntigravityEnv !== undefined) {
      process.env.ANTIGRAVITY_INTERNAL_BASE_URLS = originalAntigravityEnv;
    } else {
      delete process.env.ANTIGRAVITY_INTERNAL_BASE_URLS;
    }
  });

  describe('1. 499 Failover & Transient vs Client Statuses', () => {
    it('fails over to next endpoint on HTTP 499 (upstream client-cancelled)', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      postSpy.mockRejectedValueOnce(createAxiosError(499, 'Client Closed Request'));
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'failover 499 ok' }] } }] },
        headers: {},
      } as any);

      const res = await client.generateInternal(createInternalRequest(), 'token-1');
      expect(res).toBeDefined();
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(postSpy.mock.calls[0][0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal');
      expect(postSpy.mock.calls[1][0]).toContain('https://cloudcode-pa.googleapis.com/v1internal');
    });

    it('fails over to next endpoint on HTTP 499 for streaming requests (stream parity)', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      postSpy.mockRejectedValueOnce(createAxiosError(499, 'Client Closed Request'));
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { pipe: vi.fn() },
        headers: {},
      } as any);

      const stream = await client.streamGenerateInternal(createInternalRequest(), 'token-1');
      expect(stream).toBeDefined();
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(postSpy.mock.calls[0][0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal');
      expect(postSpy.mock.calls[1][0]).toContain('https://cloudcode-pa.googleapis.com/v1internal');
    });

    it('still fails over on other transient statuses (408, 429, 503)', async () => {
      for (const status of [408, 429, 503]) {
        const client = new GeminiClient();
        const postSpy = vi.spyOn(axios, 'post');

        postSpy.mockRejectedValueOnce(createAxiosError(status, `Error ${status}`));
        postSpy.mockResolvedValueOnce({
          status: 200,
          data: { candidates: [{ content: { role: 'model', parts: [{ text: 'recovered' }] } }] },
          headers: {},
        } as any);

        await client.generateInternal(createInternalRequest(), 'token-1');
        expect(postSpy).toHaveBeenCalledTimes(2);
        postSpy.mockRestore();
      }
    });
  });

  describe('2. No Endpoint Failover on Ordinary 400/401/403', () => {
    it('does not rotate endpoints on HTTP 400 (Bad Request)', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      postSpy.mockRejectedValue(createAxiosError(400, 'Invalid argument'));

      await expect(
        client.generateInternal(createInternalRequest(), 'token-1'),
      ).rejects.toThrow(UpstreamRequestError);

      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(postSpy.mock.calls[0][0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal');
    });

    it('does not rotate endpoints on HTTP 401 (Unauthorized)', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      postSpy.mockRejectedValue(createAxiosError(401, 'Invalid credential'));

      await expect(
        client.generateInternal(createInternalRequest(), 'token-1'),
      ).rejects.toThrow(UpstreamRequestError);

      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(postSpy.mock.calls[0][0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal');
    });

    it('does not rotate endpoints on HTTP 403 when no project header is present', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      postSpy.mockRejectedValue(createAxiosError(403, 'Permission denied on account'));

      await expect(
        client.generateInternal(createInternalRequest({ project: '' }), 'token-1'),
      ).rejects.toThrow(UpstreamRequestError);

      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(postSpy.mock.calls[0][0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal');
    });
  });

  describe('3. Exactly One Project-Context Downgrade', () => {
    it('retries exactly once without project context when 403 received, and preserves final 403 if retry also fails', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      // Both attempts return 403
      postSpy.mockRejectedValue(createAxiosError(403, 'Permission denied'));

      const requestBody = createInternalRequest({ project: 'project-1' });

      await expect(
        client.generateInternal(requestBody, 'token-1', undefined, undefined, 'acc-1'),
      ).rejects.toThrow(UpstreamRequestError);

      // Attempt 1 with header, Attempt 2 without header, then stop (exactly 2 calls)
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect((postSpy.mock.calls[0][2] as any)?.headers?.['x-goog-user-project']).toBe('project-1');
      expect((postSpy.mock.calls[1][2] as any)?.headers?.['x-goog-user-project']).toBeUndefined();
      expect(JSON.parse(postSpy.mock.calls[0][1] as string).project).toBe('project-1');
      expect(JSON.parse(postSpy.mock.calls[1][1] as string).project).toBeUndefined();
    });

    it('retries without project context and succeeds on 200', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post');

      postSpy.mockRejectedValueOnce(createAxiosError(403, 'The caller does not have permission for project project-1'));
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'fallback succeeded' }] } }] },
        headers: {},
      } as any);

      const requestBody = createInternalRequest({ project: 'project-1' });

      const res = await client.generateInternal(requestBody, 'token-1', undefined, undefined, 'acc-1');
      expect(res).toBeDefined();
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect((postSpy.mock.calls[0][2] as any)?.headers?.['x-goog-user-project']).toBe('project-1');
      expect((postSpy.mock.calls[1][2] as any)?.headers?.['x-goog-user-project']).toBeUndefined();
      expect(JSON.parse(postSpy.mock.calls[1][1] as string).project).toBeUndefined();
    });

    it('uses the same two-call projectless bound for streaming failures', async () => {
      const client = new GeminiClient();
      const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(createAxiosError(403, 'Permission denied'));

      await expect(
        client.streamGenerateInternal(createInternalRequest({ project: 'project-1' }), 'token-1', undefined, undefined, 'acc-1'),
      ).rejects.toThrow(UpstreamRequestError);

      expect(postSpy).toHaveBeenCalledTimes(2);
      expect((postSpy.mock.calls[0][2] as any)?.headers?.['x-goog-user-project']).toBe('project-1');
      expect((postSpy.mock.calls[1][2] as any)?.headers?.['x-goog-user-project']).toBeUndefined();
      let projectlessBody = '';
      for await (const chunk of postSpy.mock.calls[1][1] as NodeJS.ReadableStream) {
        projectlessBody += String(chunk);
      }
      expect(JSON.parse(projectlessBody).project).toBeUndefined();
    });
  });

  describe('4. Negative Capability Cache: Reuse, Isolation, and TTL', () => {
    it('reuses cached negative capability to avoid repeated 403 preflight requests', async () => {
      const client = new GeminiClient();
      client.userProjectCapabilityCache.clearAll();
      const postSpy = vi.spyOn(axios, 'post');

      // Request 1: first call with header returns 403, retry without header returns 200
      postSpy.mockRejectedValueOnce(createAxiosError(403, 'Permission denied'));
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'req 1 ok' }] } }] },
        headers: {},
      } as any);

      // Request 2: should send directly without project header (no 403)
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'req 2 ok' }] } }] },
        headers: {},
      } as any);

      const requestBody = createInternalRequest({ project: 'proj-1' });

      // Request 1
      const res1 = await client.generateInternal(requestBody, 'token-1', undefined, undefined, 'acc-1');
      expect(res1).toBeDefined();
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect((postSpy.mock.calls[0][2] as any)?.headers?.['x-goog-user-project']).toBe('proj-1');
      expect((postSpy.mock.calls[1][2] as any)?.headers?.['x-goog-user-project']).toBeUndefined();

      // Request 2: directly without project header, only 1 call
      const res2 = await client.generateInternal(requestBody, 'token-1', undefined, undefined, 'acc-1');
      expect(res2).toBeDefined();
      expect(postSpy).toHaveBeenCalledTimes(3);
      expect((postSpy.mock.calls[2][2] as any)?.headers?.['x-goog-user-project']).toBeUndefined();
    });

    it('isolates cache by (accountId, projectId) scope and never keys by token', () => {
      const cache = new UserProjectCapabilityCache();
      cache.clearAll();

      cache.recordNegativeCapability('acc-1', 'proj-1');

      // Valid within scope
      expect(cache.hasNegativeCapability('acc-1', 'proj-1')).toBe(true);

      // Isolated across accounts
      expect(cache.hasNegativeCapability('acc-2', 'proj-1')).toBe(false);

      // Isolated across projects
      expect(cache.hasNegativeCapability('acc-1', 'proj-2')).toBe(false);

      // Rejects keying by access tokens (never key by token)
      cache.recordNegativeCapability('ya29.a0AfH6SMA...', 'proj-1');
      expect(cache.hasNegativeCapability('ya29.a0AfH6SMA...', 'proj-1')).toBe(false);

      cache.recordNegativeCapability('Bearer ya29.foo', 'proj-1');
      expect(cache.hasNegativeCapability('Bearer ya29.foo', 'proj-1')).toBe(false);

      // Snapshot contains only safe accountKey and project, no tokens
      const snapshot = cache.getSnapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].accountKey).toBe('acc-1');
      expect(snapshot[0].project).toBe('proj-1');
      expect((snapshot[0] as any).accessToken).toBeUndefined();
    });

    it('revalidates after TTL expiry, and success clears negative state', async () => {
      const client = new GeminiClient();
      client.userProjectCapabilityCache.clearAll();
      const postSpy = vi.spyOn(axios, 'post');

      // Record negative capability with short 25ms TTL
      client.userProjectCapabilityCache.recordNegativeCapability('acc-1', 'proj-1', 25);
      expect(client.userProjectCapabilityCache.hasNegativeCapability('acc-1', 'proj-1')).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(client.userProjectCapabilityCache.hasNegativeCapability('acc-1', 'proj-1')).toBe(false);

      // Revalidation probe succeeds
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'probed ok' }] } }] },
        headers: {},
      } as any);

      const requestBody = createInternalRequest({ project: 'proj-1' });

      const res = await client.generateInternal(requestBody, 'token-1', undefined, undefined, 'acc-1');
      expect(res).toBeDefined();

      // Probe included header
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect((postSpy.mock.calls[0][2] as any)?.headers?.['x-goog-user-project']).toBe('proj-1');

      // Success cleared negative capability
      expect(client.userProjectCapabilityCache.hasNegativeCapability('acc-1', 'proj-1')).toBe(false);
    });
  });

  describe('5. Upstream Endpoint Preference & Configuration Order', () => {
    it('daily-first default: attempts daily endpoint first, falls back on failure, and fallback becomes preferred', async () => {
      const client = new GeminiClient();
      client.resetPreferredEndpoint();

      const defaultEndpoints = client.getOrderedInternalBaseUrls();
      expect(defaultEndpoints[0]).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal');
      expect(defaultEndpoints[1]).toBe('https://cloudcode-pa.googleapis.com/v1internal');

      const postSpy = vi.spyOn(axios, 'post');

      // Request 1: Daily endpoint fails with 500, cloudcode-pa succeeds with 200
      postSpy.mockRejectedValueOnce(createAxiosError(500, 'Daily Down'));
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'cloudcode ok' }] } }] },
        headers: {},
      } as any);

      const requestBody = createInternalRequest();

      await client.generateInternal(requestBody, 'token-1');

      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(postSpy.mock.calls[0][0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal');
      expect(postSpy.mock.calls[1][0]).toContain('https://cloudcode-pa.googleapis.com/v1internal');

      // Health stickiness: successful fallback is now preferred
      const stickyEndpoints = client.getOrderedInternalBaseUrls();
      expect(stickyEndpoints[0]).toBe('https://cloudcode-pa.googleapis.com/v1internal');
      expect(stickyEndpoints[1]).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal');

      // Request 2: tries cloudcode-pa first directly
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'cloudcode direct' }] } }] },
        headers: {},
      } as any);

      await client.generateInternal(requestBody, 'token-1');
      expect(postSpy).toHaveBeenCalledTimes(3);
      expect(postSpy.mock.calls[2][0]).toContain('https://cloudcode-pa.googleapis.com/v1internal');
    });

    it('env order remains authoritative and config change clears stale sticky state', async () => {
      const client = new GeminiClient();

      // Configure env order
      process.env.PROXY_INTERNAL_BASE_URLS =
        'https://override-first.example.com/v1internal,https://override-second.example.com/v1internal';

      const envEndpoints = client.getOrderedInternalBaseUrls();
      expect(envEndpoints[0]).toBe('https://override-first.example.com/v1internal');
      expect(envEndpoints[1]).toBe('https://override-second.example.com/v1internal');

      const postSpy = vi.spyOn(axios, 'post');

      // Request fails on first, succeeds on second
      postSpy.mockRejectedValueOnce(createAxiosError(500, 'Override first down'));
      postSpy.mockResolvedValueOnce({
        status: 200,
        data: { candidates: [{ content: { role: 'model', parts: [{ text: 'override second ok' }] } }] },
        headers: {},
      } as any);

      await client.generateInternal(createInternalRequest(), 'token-1');

      // Now override second became preferred
      expect(client.getOrderedInternalBaseUrls()[0]).toBe('https://override-second.example.com/v1internal');

      // Now change config: new configuration order must immediately become authoritative without unbounded sticky state
      process.env.PROXY_INTERNAL_BASE_URLS =
        'https://brand-new-first.example.com/v1internal,https://brand-new-second.example.com/v1internal';

      const updatedEndpoints = client.getOrderedInternalBaseUrls();
      expect(updatedEndpoints[0]).toBe('https://brand-new-first.example.com/v1internal');
      expect(updatedEndpoints[1]).toBe('https://brand-new-second.example.com/v1internal');
    });
  });

  describe('6. Quota Summary 403 Retry Without Project', () => {
    it('retries grouped quota summary on the same endpoint without project after 403 and populates quota groups', async () => {
      const fetchMock = vi
        .fn()
        // 1. Models endpoint succeeds
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            models: {
              'gemini-3-flash': {
                quotaInfo: {
                  remainingFraction: 1,
                  resetTime: '2026-05-05T00:00:00Z',
                },
              },
            },
          }),
        })
        // 2. Quota summary with project returns 403
        .mockResolvedValueOnce({ ok: false, status: 403 })
        // 3. Retry on same endpoint without project returns 200
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  {
                    bucketId: 'gemini-weekly',
                    window: 'weekly',
                    remainingFraction: 1,
                    resetTime: '2026-05-05T00:00:00Z',
                  },
                ],
              },
            ],
          }),
        });

      vi.stubGlobal('fetch', fetchMock);

      vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
        projectId: 'project-1',
        subscriptionTier: 'pro',
      });

      const result = await GoogleAPIService.fetchQuota('access-token');

      expect(result).toMatchObject({
        quota_groups: [
          {
            display_name: 'Gemini Models',
            buckets: [{ bucket_id: 'gemini-weekly', window: 'weekly' }],
          },
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Calls 2 and 3 use the same endpoint
      expect(fetchMock.mock.calls[2]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
      // Call 2 included project
      expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ project: 'project-1' }));
      // Call 3 retried without project
      expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({}));
    });

    it('preserves truthful model quota errors if quota summary retry without project also fails', async () => {
      const fetchMock = vi
        .fn()
        // 1. Models endpoint succeeds
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            models: {
              'gemini-3-flash': {
                quotaInfo: {
                  remainingFraction: 0.8,
                  resetTime: '2026-05-05T00:00:00Z',
                },
              },
            },
          }),
        })
        // 2. Quota summary with project returns 403
        .mockResolvedValueOnce({ ok: false, status: 403 })
        // 3. Retry without project also returns 403
        .mockResolvedValueOnce({ ok: false, status: 403 });

      vi.stubGlobal('fetch', fetchMock);

      vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
        projectId: 'project-1',
        subscriptionTier: 'pro',
      });

      const result = await GoogleAPIService.fetchQuota('access-token');

      // Model quota is preserved truthfully, quota_groups is not populated
      expect(result.models['gemini-3-flash']).toBeDefined();
      expect(result.quota_groups).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
