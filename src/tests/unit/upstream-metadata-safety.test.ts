import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeAttemptRequest } from '@/modules/proxy-gateway/server/cloudcode-request-adapter';

function compose(headers: Record<string, string | string[]>) {
  return composeAttemptRequest({
    rawBody: Buffer.from('{"request":{"contents":[]}}'),
    reqHeaders: headers,
    targetHost: 'cloudcode-pa.googleapis.com',
    method: 'POST',
    urlPath: '/v1internal:generateContent',
    quotaHeaderMode: 'without-quota-header',
    accessToken: 'upstream-token',
    attempt: 1,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('CONNECT upstream header isolation', () => {
  it('removes proxy credentials and local routing metadata regardless of case', () => {
    const { headers } = compose({
      'Proxy-Authorization': 'Basic local-secret',
      'Proxy-Connection': 'keep-alive',
      'X-AG-Proxy-Session-Id': 'private-session',
      'X-Ag-Proxy-Debug': 'private-debug',
      'X-Forwarded-For': '192.168.1.10',
      'X-Forwarded-Host': 'private-host',
      Forwarded: 'for=192.168.1.10',
      Via: '1.1 private-host',
      'X-Real-IP': '192.168.1.10',
      Authorization: 'Bearer caller-token',
      'X-Goog-Api-Key': 'caller-api-key',
      'X-Goog-User-Project': 'caller-project',
      'X-Goog-Session-Id': 'private-session',
    });
    expect(headers).toEqual({
      host: 'cloudcode-pa.googleapis.com',
      authorization: 'Bearer upstream-token',
      'content-length': String(Buffer.byteLength('{"request":{"contents":[]}}')),
    });
  });

  it('removes all Connection-nominated headers including array and mixed-case entries', () => {
    const { headers } = compose({
      Connection: ['X-Private-One, keep-alive', 'X-Private-Two'],
      'X-Private-One': 'secret-one',
      'X-Private-Two': 'secret-two',
      'Keep-Alive': 'timeout=5',
      TE: 'trailers',
      Trailer: 'X-Private-One',
      'Transfer-Encoding': 'chunked',
      Upgrade: 'h2c',
    });
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-length', 'host']);
  });

  it('preserves native client metadata and payload without inventing identity fields', () => {
    const { headers, payloadToSend } = compose({
      'User-Agent': 'agy/1.4.0',
      'X-Goog-Api-Client': 'native-client-metadata',
      'Content-Type': 'application/json',
      'X-Request-Id': 'native-request',
    });
    expect(headers).toMatchObject({
      'user-agent': 'agy/1.4.0',
      'x-goog-api-client': 'native-client-metadata',
      'content-type': 'application/json',
      'x-request-id': 'native-request',
    });
    expect(payloadToSend.toString()).toBe('{"request":{"contents":[]}}');
  });
});

describe('Explicit upstream client version', () => {
  it.each(['1.4.0', '2.0.3', '99.0.0'])('uses pinned %s without remote discovery', async (version) => {
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', version);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', 'false');
    const lookup = vi.spyOn(axios, 'get').mockRejectedValue(new Error('must not discover'));
    const { resolveRequestUserAgent, buildUserAgent } = await import('@/modules/proxy-gateway/server/request-user-agent');
    expect(await resolveRequestUserAgent()).toBe(buildUserAgent(version));
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['version 1.4.0 and 9.9.9', '1.4.0\r\nInjected: value', 'latest'])('rejects malformed explicit versions', async (version) => {
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', version);
    const { resolveRequestUserAgent } = await import('@/modules/proxy-gateway/server/request-user-agent');
    await expect(resolveRequestUserAgent()).rejects.toThrow('AG_PROXY_UPSTREAM_VERSION');
  });
});
