import { configureRequestHistory, closeRequestHistory, getRequestHistory } from '../../observability/request-history';
import { observeNativeRequest } from '../../dashboard/native-request-journal';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { isNativeControlPlaneRequest } from '../../modules/proxy-gateway/server/native-control-plane';
import { ProxyConfigSchema } from '../../modules/config/types';
import { setServerConfig } from '../../server/server-config';

const servers: http.Server[] = [];
async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  closeRequestHistory();
  vi.restoreAllMocks();
  setServerConfig(null);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function setup(status = 200, hang = false) {
  configureRequestHistory(':memory:');
  const calls: Array<{ headers: http.IncomingHttpHeaders; body: Buffer; url?: string }> = [];
  let reportReceived!: () => void;
  let reportClosed!: () => void;
  const received = new Promise<void>((resolve) => { reportReceived = resolve; });
  const upstreamClosed = new Promise<void>((resolve) => { reportClosed = resolve; });
  const upstreamPort = await listen(async (req, res) => {
    res.once('close', reportClosed);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url });
    reportReceived();
    if (!hang) {
      res.writeHead(status, { 'content-type': 'application/json', 'x-upstream-result': 'original' });
      res.end(status === 403 ? '{"error":{"message":"TOS_VIOLATION"}}' : '{"userTier":"PAID"}');
    }
  });
  const transport = vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    expect(options.hostname).toBe('daily-cloudcode-pa.googleapis.com');
    expect(options.port).toBe(443);
    return http.request({ ...options, hostname: '127.0.0.1', port: upstreamPort }, callback);
  }) as typeof https.request);
  const leases = { getNextToken: vi.fn().mockResolvedValue(null), getAccountCount: vi.fn(() => 0) };
  const gateway = new CloudCodeFailoverGateway(leases as never);
  const port = await listen((req, res) => { observeNativeRequest(req, res, () => { void gateway.handleRequest(req, res); }); });
  return { calls, transport, leases, port, received, upstreamClosed };
}

function request(port: number, url = '/v1internal:loadCodeAssist', body = Buffer.from('{"project":"caller-project"}'), host = 'daily-cloudcode-pa.googleapis.com') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: 'POST', headers: {
      host, authorization: 'Bearer original-user-token', 'x-goog-user-project': 'caller-project',
      'content-type': 'application/json', 'content-length': body.length,
    } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('native control-plane separation', () => {
  it('uses a strict operation and path allowlist', () => {
    for (const operation of ['loadCodeAssist', 'onboardUser', 'fetchUserInfo', 'fetchAvailableModels', 'retrieveUserQuota']) {
      expect(isNativeControlPlaneRequest('POST', `/v1internal:${operation}?original=%2f`)).toBe(true);
    }
    for (const url of ['/v1internal:generateContent', '/v1internal:streamGenerateContent', '/v1internal:predict', '/v1internal:countTokens', '/v1internal:unknown', '/v1internal:loadCodeAssist/extra', '/other:loadCodeAssist', '/v1internal:loadCodeAssist#fragment']) {
      expect(isNativeControlPlaneRequest('POST', url)).toBe(false);
    }
    expect(isNativeControlPlaneRequest('GET', '/v1internal:loadCodeAssist')).toBe(false);
  });

  it('passes original auth, project, bytes and raw query once with an empty managed pool', async () => {
    const { calls, leases, port } = await setup();
    const body = Buffer.from('{ "project" : "caller-project", "untouched":1e10 }');
    const response = await request(port, '/v1internal:loadCodeAssist?raw=%2f%2F+test', body);
    expect(response.status).toBe(200);
    expect(response.headers['x-upstream-result']).toBe('original');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/v1internal:loadCodeAssist?raw=%2f%2F+test', headers: { authorization: 'Bearer original-user-token', 'x-goog-user-project': 'caller-project' } });
    expect(calls[0].body.equals(body)).toBe(true);
    expect(leases.getNextToken).not.toHaveBeenCalled();
    expect(getRequestHistory().items[0]).toMatchObject({ request_kind: 'service', authorization_source: 'client', requested_model: null, account_id: null });
  });

  it('returns the original upstream 403 without retry or pool fallback', async () => {
    const { port, calls, leases } = await setup(403);
    const response = await request(port, '/v1internal:fetchUserInfo');
    expect(response.status).toBe(403);
    expect(response.body).toBe('{"error":{"message":"TOS_VIOLATION"}}');
    expect(calls).toHaveLength(1);
    expect(leases.getNextToken).not.toHaveBeenCalled();
  });

  it('keeps generation on the managed pool and rejects forbidden authorities', async () => {
    const { port, transport, leases } = await setup();
    expect((await request(port, '/v1internal:generateContent')).status).toBe(503);
    expect(leases.getNextToken).toHaveBeenCalled();
    expect((await request(port, '/v1internal:loadCodeAssist', undefined, 'attacker.example')).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });

  it('times out and destroys a stalled transport', async () => {
    setServerConfig(ProxyConfigSchema.parse({ request_timeout: 0.03 }));
    const { port, calls, transport } = await setup(200, true);
    expect((await request(port)).status).toBe(504);
    expect(calls).toHaveLength(1);
    expect(transport.mock.results[0].value.destroyed).toBe(true);
  });

  it('cancels the upstream connection when the caller disconnects', async () => {
    const { port, received, upstreamClosed, transport } = await setup(200, true);
    const caller = http.request({ hostname: '127.0.0.1', port, path: '/v1internal:loadCodeAssist', method: 'POST',
      headers: { host: 'daily-cloudcode-pa.googleapis.com', authorization: 'Bearer original-user-token' },
    });
    caller.on('error', () => undefined);
    caller.end('{}');
    await received;
    caller.destroy();
    await upstreamClosed;
    expect(transport.mock.results[0].value.destroyed).toBe(true);
  });

  it('cleans up an unfinished upload after an upstream early 401 response', async () => {
    let upstreamSocketClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamSocketClosed = resolve; });
    const upstreamPort = await listen((req, res) => {
      req.socket.once('close', upstreamSocketClosed);
      req.once('data', () => {
        expect(req.complete).toBe(false);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"original-auth-rejected"}');
      });
    });
    const transport = vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
      http.request({ ...options, hostname: '127.0.0.1', port: upstreamPort }, callback)) as typeof https.request);
    const gateway = new CloudCodeFailoverGateway();
    let completed!: () => void;
    const handled = new Promise<void>((resolve) => { completed = resolve; });
    const port = await listen((req, res) => { void gateway.handleRequest(req, res).then(completed); });
    let caller!: http.ClientRequest;
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        caller = http.request({ hostname: '127.0.0.1', port, path: '/v1internal:loadCodeAssist', method: 'POST',
          headers: { host: 'daily-cloudcode-pa.googleapis.com', 'content-length': 1000000 },
        }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode!, body }));
          response.on('error', reject);
        });
        caller.on('error', reject);
        caller.write('first chunk');
      });
      expect(result).toEqual({ status: 401, body: '{"error":"original-auth-rejected"}' });
      await handled;
      await closed;
      expect(transport).toHaveBeenCalledTimes(1);
      const upstream = transport.mock.results[0].value as http.ClientRequest;
      expect(upstream.writableEnded).toBe(false);
      expect(upstream.destroyed).toBe(true);
    } finally {
      caller?.destroy();
    }
  });
});
