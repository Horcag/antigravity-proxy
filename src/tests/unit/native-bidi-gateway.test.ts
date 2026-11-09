import { afterEach, describe, expect, it, vi } from 'vitest';
import http2 from 'node:http2';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { getNativeAudioOutcome, NativeBidiGateway, NATIVE_AUDIO_HOST, NATIVE_AUDIO_PATH } from '../../modules/proxy-gateway/server/native-bidi-gateway';
import type { AttemptLease } from '../../modules/proxy-gateway/server/account-lease.service';

const servers: http2.Http2Server[] = [];
const sessions: http2.Http2Session[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function accountLease(releaseReservation = vi.fn()): AttemptLease {
  return {
    account: {
      id: 'native-audio-account', provider: 'google', email: 'audio@example.invalid',
      created_at: 0, last_used: 0,
      token: { access_token: 'pool-token', refresh_token: '', expires_in: 3600, expiry_timestamp: Date.now() + 3600000, token_type: 'Bearer' },
    },
    generation: 1, tableIncarnation: 1, breakerGeneration: 1, isReleased: false,
    releaseReservation,
  };
}

async function listen(server: http2.Http2Server): Promise<string> {
  servers.push(server);
  server.on('session', session => sessions.push(session));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type StreamHandler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void;

async function fixture(handler: StreamHandler, options: {
  acquire?: (options?: { signal?: AbortSignal }) => Promise<AttemptLease | null>;
  setupTimeoutMs?: number;
} = {}) {
  const upstream = http2.createServer();
  upstream.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    handler(stream, headers);
  });
  const origin = await listen(upstream);
  const lease = accountLease();
  const acquire = vi.fn(options.acquire ?? (async () => lease));
  const connect = vi.fn(() => {
    const session = http2.connect(origin);
    sessions.push(session);
    return session;
  });
  const markAsForbidden = vi.fn();
  const gateway = new NativeBidiGateway({ acquireAttemptLease: acquire, markAsForbidden }, { connect, setupTimeoutMs: options.setupTimeoutMs });
  let requestObject: http2.Http2ServerRequest | undefined;
  const proxy = http2.createServer((req, res) => { requestObject = req; void gateway.handleRequest(req, res); });
  const proxyOrigin = await listen(proxy);
  const client = http2.connect(proxyOrigin);
  sessions.push(client);
  const request = (extra: http2.OutgoingHttpHeaders = {}, requestOptions?: http2.ClientSessionRequestOptions) => {
    const stream = client.request({
      ':authority': NATIVE_AUDIO_HOST, ':method': 'POST', ':path': NATIVE_AUDIO_PATH,
      'content-type': 'application/grpc', authorization: 'Bearer native-token', ...extra,
    }, requestOptions);
    stream.on('error', () => {});
    return stream;
  };
  return { client, lease, acquire, connect, request, markAsForbidden, outcome: () => requestObject && getNativeAudioOutcome(requestObject) };
}

function response(stream: http2.ClientHttp2Stream) {
  const chunks: Buffer[] = [];
  let headers: http2.IncomingHttpHeaders = {};
  let trailers: http2.IncomingHttpHeaders = {};
  stream.on('response', value => { headers = value; });
  stream.on('trailers', value => { trailers = value; });
  stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  return once(stream, 'end').then(() => ({ headers, trailers, body: Buffer.concat(chunks) }));
}

describe('NativeBidiGateway', () => {
  it('streams both directions before request EOF, preserving frames, metadata and trailers under one lease', async () => {
    const input: Buffer[] = [];
    let upstreamHeaders: http2.IncomingHttpHeaders = {};
    let requestTrailers: http2.IncomingHttpHeaders = {};
    const firstFrame = Buffer.from([0, 0, 0, 0, 3, 0, 255, 42]);
    const finalFrame = Buffer.from([0, 0, 0, 0, 2, 254, 0]);
    const reply = Buffer.from([0, 0, 0, 0, 1, 7]);
    const f = await fixture((stream, headers) => {
      upstreamHeaders = headers;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'x-native-metadata': 'unchanged' }, { waitForTrailers: true });
      stream.on('data', chunk => { input.push(Buffer.from(chunk)); if (input.length === 1) stream.write(reply); });
      stream.on('trailers', value => { requestTrailers = value; });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'x-native-trailer': 'exact' }));
      stream.on('end', () => stream.end(finalFrame));
    });
    const stream = f.request({
      'x-goog-api-key': 'original-key', 'x-goog-user-project': 'native-project',
      'x-native-session': 'original-session', 'grpc-encoding': 'gzip',
    }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'x-request-trailer': 'unchanged' }));
    const result = response(stream);
    const earlyReply = once(stream, 'data');
    stream.write(firstFrame);
    expect((await earlyReply)[0]).toEqual(reply);
    expect(f.lease.releaseReservation).not.toHaveBeenCalled();
    expect(stream.writableEnded).toBe(false);
    stream.end(finalFrame);
    const received = await result;
    expect(Buffer.concat(input)).toEqual(Buffer.concat([firstFrame, finalFrame]));
    expect(received.body).toEqual(Buffer.concat([reply, finalFrame]));
    expect(upstreamHeaders.authorization).toBe('Bearer pool-token');
    expect(upstreamHeaders['x-goog-api-key']).toBeUndefined();
    expect(upstreamHeaders[':authority']).toBe(NATIVE_AUDIO_HOST);
    expect(upstreamHeaders[':path']).toBe(NATIVE_AUDIO_PATH);
    expect(upstreamHeaders['x-goog-user-project']).toBe('native-project');
    expect(upstreamHeaders['x-native-session']).toBe('original-session');
    expect(upstreamHeaders['grpc-encoding']).toBe('gzip');
    expect(requestTrailers['x-request-trailer']).toBe('unchanged');
    expect(received.headers['x-native-metadata']).toBe('unchanged');
    expect(received.trailers).toMatchObject({ 'grpc-status': '0', 'x-native-trailer': 'exact' });
    await vi.waitFor(() => expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1));
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.outcome()).toBe('0');
  });

  it('preserves a terminal TOS denial without replay or account rotation', async () => {
    const denied = 'This service has been disabled in this account for violation of Terms of Service.';
    const f = await fixture(stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '7', 'grpc-message': encodeURIComponent(denied) });
      stream.end();
    });
    const stream = f.request();
    const result = response(stream);
    stream.write(Buffer.from([0, 0, 0, 0, 0]));
    const received = await result;
    expect(received.headers['grpc-status']).toBe('7');
    expect(decodeURIComponent(String(received.headers['grpc-message']))).toBe(denied);
    await vi.waitFor(() => expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1));
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.markAsForbidden).toHaveBeenCalledExactlyOnceWith('native-audio-account', 'tos_violation');
    expect(f.outcome()).toBe('7');
  });

  it.each([
    ['7', 'The caller does not have permission'],
    ['14', 'This service has been disabled in this account for violation of Terms of Service.'],
  ])('does not quarantine an account without an explicit TOS denial under permission status: %s', async (status, message) => {
    const f = await fixture(stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': status, 'grpc-message': encodeURIComponent(message) }));
      stream.end();
    });
    const stream = f.request();
    const result = response(stream);
    stream.end();
    expect((await result).trailers['grpc-status']).toBe(status);
    expect(f.markAsForbidden).not.toHaveBeenCalled();
    expect(f.outcome()).toBe(status);
  });

  it('quarantines an explicit TOS denial received in trailers without replaying', async () => {
    const f = await fixture(stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({
        'grpc-status': '7', 'grpc-message': encodeURIComponent('This service has been disabled in this account for violation of Terms of Service. Please submit an appeal.'),
      }));
      stream.end();
    });
    const stream = f.request();
    const result = response(stream);
    stream.end();
    expect((await result).trailers['grpc-status']).toBe('7');
    expect(f.markAsForbidden).toHaveBeenCalledExactlyOnceWith('native-audio-account', 'tos_violation');
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.acquire).toHaveBeenCalledTimes(1);
  });

  it('fails closed when no native account is available', async () => {
    const f = await fixture(() => { throw new Error('Must not connect'); }, { acquire: async () => null });
    const stream = f.request();
    const result = response(stream);
    stream.end();
    expect((await result).trailers['grpc-status']).toBe('14');
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([
    { ':authority': 'aicode.googleapis.com.attacker.invalid' },
    { ':authority': 'cloudcode-pa.googleapis.com' },
    { ':path': `${NATIVE_AUDIO_PATH}?other=1` },
    { ':path': '/google.gca.aicode.v1alpha.PredictionService/OtherMethod' },
    { 'content-type': 'application/json' },
    { 'content-type': 'application/grpc-web+proto' },
  ])('rejects traffic outside the exact native gRPC operation: %j', async extra => {
    const f = await fixture(() => { throw new Error('Must not connect'); });
    const stream = f.request(extra);
    const result = response(stream);
    stream.end();
    expect((await result).trailers['grpc-status']).toBe('12');
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('cancels upstream and releases the single reservation when the native client aborts', async () => {
    let upstreamStream: http2.ServerHttp2Stream | undefined;
    const f = await fixture(stream => {
      upstreamStream = stream;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
      stream.write(Buffer.from([0, 0, 0, 0, 0]));
    });
    const stream = f.request();
    const ready = once(stream, 'data');
    stream.write(Buffer.from([0, 0, 0, 0, 0]));
    await ready;
    stream.close(http2.constants.NGHTTP2_CANCEL);
    await vi.waitFor(() => {
      expect(upstreamStream?.destroyed).toBe(true);
      expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1);
    });
    expect(f.acquire).toHaveBeenCalledTimes(1);
  });

  it('does not open an upstream connection if a cancelled acquisition returns a late lease', async () => {
    let fulfill!: (lease: AttemptLease) => void;
    const lateLease = accountLease();
    const f = await fixture(() => { throw new Error('Must not connect'); }, {
      acquire: () => new Promise(resolve => { fulfill = resolve; }),
    });
    const stream = f.request();
    stream.write(Buffer.from([0, 0, 0, 0, 0]));
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledTimes(1));
    const signal = f.acquire.mock.calls[0][0]?.signal;
    stream.close(http2.constants.NGHTTP2_CANCEL);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    fulfill(lateLease);
    await vi.waitFor(() => expect(lateLease.releaseReservation).toHaveBeenCalledTimes(1));
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('terminates a stalled setup and releases its reservation without retry', async () => {
    const f = await fixture(() => {}, { setupTimeoutMs: 30 });
    const stream = f.request();
    const result = response(stream);
    stream.write(Buffer.from([0, 0, 0, 0, 0]));
    expect((await result).trailers['grpc-status']).toBe('14');
    await vi.waitFor(() => expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1));
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable and releases the account when upstream resets before response headers', async () => {
    const f = await fixture(stream => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
    const stream = f.request();
    const result = response(stream);
    stream.write(Buffer.from([0, 0, 0, 0, 0]));
    expect((await result).trailers['grpc-status']).toBe('14');
    await vi.waitFor(() => expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1));
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.outcome()).toBe('14');
  });

  it('resets an already streaming response on upstream failure without pretending it completed', async () => {
    let upstreamStream: http2.ServerHttp2Stream | undefined;
    const f = await fixture(stream => {
      upstreamStream = stream;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
      stream.write(Buffer.from([0, 0, 0, 0, 0]));
    });
    const stream = f.request();
    const closed = new Promise<void>(resolve => stream.once('close', resolve));
    const receivedData = once(stream, 'data');
    stream.write(Buffer.from([0, 0, 0, 0, 0]));
    await receivedData;
    upstreamStream!.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    await closed;
    expect(stream.rstCode).not.toBe(http2.constants.NGHTTP2_NO_ERROR);
    await vi.waitFor(() => expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1));
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.outcome()).toBe('14');
  });

  it('streams a flow-controlled large payload byte for byte in both directions', async () => {
    const payload = Buffer.alloc(512 * 1024, 0xa5);
    const input: Buffer[] = [];
    const f = await fixture(stream => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.on('data', chunk => input.push(Buffer.from(chunk)));
      stream.on('end', () => stream.end(Buffer.concat(input)));
    });
    const stream = f.request();
    const result = response(stream);
    stream.end(payload);
    const received = await result;
    expect(received.body).toEqual(payload);
    expect(received.trailers['grpc-status']).toBe('0');
    await vi.waitFor(() => expect(f.lease.releaseReservation).toHaveBeenCalledTimes(1));
  });
});
