import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { composeAttemptRequest } from '../../modules/proxy-gateway/server/cloudcode-request-adapter';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';

const path = '/v1/../v1/models/native-alias:generateContent?alt=sse&opaque=%2f%2F&opaque=2';
const json = '{ "model":"native-alias", "project":"native-project", "metadata":{"sessionId":"native-session","unknown":[1,2]}, "requestId":"native-request", "request":{"project":"nested-project","contents":[{"parts":[{"functionCall":{"name":"tool","args":{"n":9007199254740993123}},"thoughtSignature":"opaque-signature"}]}]}, "unknown":1.00 }';
const headers = {
  ':authority': 'daily-cloudcode-pa.googleapis.com:443',
  'content-type': 'application/json',
  authorization: 'Bearer original-credential',
  'x-goog-api-key': 'original-key',
  'x-goog-user-project': 'native-quota-project',
  'x-goog-session-id': 'native-session',
  'x-request-id': 'native-request',
  'x-native-metadata': ['first', 'second'],
};

const encodings = [
  ['identity', (body: Buffer) => body],
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['br', brotliCompressSync],
] as const;

describe('native credential-only forwarding', () => {
  it.each(encodings)('preserves exact %s bytes, URL, authority and end-to-end headers', (encoding, compress) => {
    const rawBody = compress(Buffer.from(json));
    const reqHeaders = { ...headers, 'content-encoding': encoding, 'content-length': String(rawBody.length) };
    const result = composeAttemptRequest({ rawBody, reqHeaders, targetHost: 'daily-cloudcode-pa.googleapis.com', method: 'POST', urlPath: path, accessToken: 'replacement' });
    expect(result.payloadToSend).toBe(rawBody);
    expect(result.payloadToSend.equals(rawBody)).toBe(true);
    expect(result.urlPath).toBe(path);
    const preserved = Object.fromEntries(Object.entries(reqHeaders).filter(([name]) => ![':authority', 'authorization', 'x-goog-api-key'].includes(name)));
    expect(result.headers).toEqual({ ...preserved, host: reqHeaders[':authority'], authorization: 'Bearer replacement' });
    expect(reqHeaders.authorization).toBe('Bearer original-credential');
    expect(reqHeaders['x-goog-api-key']).toBe('original-key');
  });

  it('removes only connection framing and declared hop headers', () => {
    const result = composeAttemptRequest({ rawBody: Buffer.from(json), reqHeaders: { ...headers, connection: ['keep-alive, x-local-hop'], 'x-local-hop': 'local', te: 'trailers', trailer: 'checksum', 'transfer-encoding': 'chunked', 'proxy-authorization': 'local-proxy' }, targetHost: 'daily-cloudcode-pa.googleapis.com', method: 'POST', urlPath: path });
    for (const name of ['connection', 'x-local-hop', 'te', 'trailer', 'transfer-encoding', 'proxy-authorization']) expect(result.headers[name]).toBeUndefined();
    expect(result.headers.authorization).toBe(headers.authorization);
    expect(result.headers['x-goog-session-id']).toBe('native-session');
  });

  it('normalizes mixed-case Connection nominations while retaining native session and array values', () => {
    const result = composeAttemptRequest({ rawBody: Buffer.from(json), reqHeaders: {...headers,
      Connection: ['keep-alive, X-Private'], connection: 'x-another-hop', 'X-Private': 'private-hop', 'X-Another-Hop': 'second-hop', 'Proxy-Authorization': 'proxy-secret'},
      targetHost: 'daily-cloudcode-pa.googleapis.com', method: 'POST', urlPath: path });
    for (const name of ['connection','x-private','x-another-hop','proxy-authorization']) expect(result.headers[name]).toBeUndefined();
    expect(result.headers['x-goog-session-id']).toBe('native-session');
    expect(result.headers['x-native-metadata']).toEqual(['first','second']); expect(result.payloadToSend.equals(Buffer.from(json))).toBe(true);
  });

  it.each([
    ['transient same-account retry', 503, 'UNAVAILABLE', 'Service unavailable', false],
    ['quota account switch', 429, 'RESOURCE_EXHAUSTED', 'Quota exhausted', true],
    ['project rejection account switch', 403, 'PERMISSION_DENIED', 'serviceusage.services.use denied on quota project', true],
    ['model rejection account switch', 404, 'NOT_FOUND', 'Model native-alias not found', true],
  ] as const)('preserves every request byte/header during %s', async (_name, status, errorStatus, message, switchesAccount) => {
    const account = (id: string) => ({ id, token: { access_token: `credential-${id}`, project_id: `foreign-project-${id}` } });
    const leases = { getNextToken: vi.fn().mockResolvedValueOnce(account('a')).mockResolvedValue(account('b')), bindSession: vi.fn(), markFromUpstreamError: vi.fn().mockResolvedValue(undefined), markModelUnrequestable: vi.fn(), resolveDynamicModelForAccount: vi.fn(() => 'fallback-model') };
    const gateway = new CloudCodeFailoverGateway(leases as any);
    const execute = vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValueOnce({ statusCode: status, headers: { 'content-type': 'application/json' }, bufferedBody: Buffer.from(JSON.stringify({ error: { code: status, status: errorStatus, message } })), bodyStream: Readable.from([]) })
      .mockResolvedValueOnce({ statusCode: 200, headers: { 'content-type': 'application/json' }, bodyStream: Readable.from(['{"candidates":[]}']) });
    const rawBody = gzipSync(Buffer.from(json));
    const req = Object.assign(Readable.from([rawBody]), { complete: true, method: 'POST', url: `https://daily-cloudcode-pa.googleapis.com${path}`, headers: { ...headers, 'content-encoding': 'gzip', 'content-length': String(rawBody.length) } });
    const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, destroyed: false, writeHead: vi.fn(), write: vi.fn(() => true), end: vi.fn() });
    res.end.mockImplementation(() => { res.writableEnded = true; res.emit('finish'); });
    await gateway.handleRequest(req as any, res as any);
    expect(execute).toHaveBeenCalledTimes(2);
    for (const call of execute.mock.calls) {
      expect(call[0]).toBe('POST'); expect(call[1]).toBe(path);
      expect((call[3] as Buffer).equals(rawBody)).toBe(true);
      expect(call[4]).toBe('daily-cloudcode-pa.googleapis.com');
      expect(call[2]).toEqual({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(rawBody.length), host: headers[':authority'], authorization: expect.stringMatching(/^Bearer credential-/), 'x-goog-user-project': 'native-quota-project', 'x-goog-session-id': 'native-session', 'x-request-id': 'native-request', 'x-native-metadata': ['first', 'second'] });
    }
    expect((execute.mock.calls[0][2] as any).authorization).toBe('Bearer credential-a');
    expect((execute.mock.calls[1][2] as any).authorization).toBe(`Bearer credential-${switchesAccount ? 'b' : 'a'}`);
  });
});
