import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { hedgedStreamRequest, STREAM_ENDPOINT_HEDGE_DELAY_MS } from '@/modules/proxy-gateway/server/clients/hedged-stream-request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const retry = (error: unknown) => ![400, 401, 403].includes((error as { status?: number }).status ?? 0);
const response = () => ({ data: new PassThrough() });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded streaming endpoint hedge', () => {
  it('keeps preferred alive and launches exactly one backup after four seconds', async () => {
    vi.useFakeTimers();
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    const signals: AbortSignal[] = [];
    const request = vi.fn((index: number, signal: AbortSignal) => { signals.push(signal); return index ? second.promise : first.promise; });
    const result = hedgedStreamRequest({ request, endpointCount: 4, shouldRetry: retry });
    await vi.advanceTimersByTimeAsync(STREAM_ENDPOINT_HEDGE_DELAY_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(2);
    const winning = response();
    second.resolve(winning);
    await expect(result).resolves.toEqual({ response: winning, index: 1 });
    expect(signals[0].aborted).toBe(true);
    const late = response();
    first.resolve(late);
    await Promise.resolve(); await Promise.resolve();
    expect(late.data.destroyed).toBe(true);
    expect(winning.data.destroyed).toBe(false);
    winning.data.destroy();
  });

  it('fast success does not launch a hedge', async () => {
    vi.useFakeTimers();
    const value = response();
    const request = vi.fn().mockResolvedValue(value);
    await hedgedStreamRequest({ request, endpointCount: 2, shouldRetry: retry });
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    value.data.destroy();
  });

  it('one configured endpoint never duplicates a pending request', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const result = hedgedStreamRequest({ request, endpointCount: 1, shouldRetry: retry });
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(1);
    const value = response(); pending.resolve(value); await result; value.data.destroy();
  });

  it('transient rejection starts backup immediately and all failures settle', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 499 });
    await expect(hedgedStreamRequest({ request, endpointCount: 3, shouldRetry: retry })).rejects.toEqual({ status: 499 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403])('permanent %s fails immediately without another endpoint', async (status) => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue({ status });
    await expect(hedgedStreamRequest({ request, endpointCount: 2, shouldRetry: retry })).rejects.toEqual({ status });
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('permanent rejection from endpoint %s cancels its running peer', async (index) => {
    vi.useFakeTimers();
    const attempts = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    const signals: AbortSignal[] = [];
    const result = hedgedStreamRequest({ request: (i, signal) => { signals[i] = signal; return attempts[i].promise; }, endpointCount: 2, shouldRetry: retry });
    const assertion = expect(result).rejects.toEqual({ status: 403 });
    await vi.advanceTimersByTimeAsync(4000);
    attempts[index].reject({ status: 403 });
    await assertion;
    expect(signals[1 - index].aborted).toBe(true);
    expect(signals[index].aborted).toBe(false);
    const late = response(); attempts[1 - index].resolve(late);
    await Promise.resolve(); await Promise.resolve();
    expect(late.data.destroyed).toBe(true);
  });

  it.each([0, 4001])('client cancellation at %sms aborts every started attempt and handles late rejection', async (delay) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const attempts = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    const signals: AbortSignal[] = [];
    const request = vi.fn((i: number, signal: AbortSignal) => { signals.push(signal); return attempts[i].promise; });
    const result = hedgedStreamRequest({ request, endpointCount: 2, shouldRetry: retry, signal: abort.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Upstream request canceled' });
    await vi.advanceTimersByTimeAsync(delay);
    abort.abort('private cancellation reason');
    await assertion;
    expect(request).toHaveBeenCalledTimes(delay ? 2 : 1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    attempts.slice(0, request.mock.calls.length).forEach((attempt) => attempt.reject(new Error('private headers')));
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('already aborted signal does not start an upstream request', async () => {
    const abort = new AbortController(); abort.abort();
    const request = vi.fn();
    await expect(hedgedStreamRequest({ request, endpointCount: 2, shouldRetry: retry, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('winner remains cancellable after its headers resolve', async () => {
    const abort = new AbortController(); const value = response();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const request = vi.fn().mockResolvedValue(value);
    await hedgedStreamRequest({ request, endpointCount: 2, shouldRetry: retry, signal: abort.signal });
    abort.abort();
    expect(value.data.destroyed).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('destroys the simultaneous successful loser without splicing either stream', async () => {
    vi.useFakeTimers();
    const attempts = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    const result = hedgedStreamRequest({ request: (i) => attempts[i].promise, endpointCount: 2, shouldRetry: retry });
    await vi.advanceTimersByTimeAsync(4000);
    const values = [response(), response()];
    attempts[0].resolve(values[0]); attempts[1].resolve(values[1]);
    await expect(result).resolves.toEqual({ response: values[0], index: 0 });
    expect(values[0].data.destroyed).toBe(false);
    expect(values[1].data.destroyed).toBe(true);
    values[0].data.destroy();
  });
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  return `http://127.0.0.1:${address.port}`;
}

describe('stream hedge over real local HTTP sockets', () => {
  it('reaches a fast backup while the preferred has no headers, then closes the preferred socket', async () => {
    const sockets = new Set<Socket>();
    const urls: string[] = [];
    const server = createServer((req, res) => {
      urls.push(req.url!);
      if (req.url === '/backup') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: backup\n\n'); }
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const base = await listen(server);
    const abort = new AbortController();
    try {
      const result = await hedgedStreamRequest({
        endpointCount: 2, delayMs: 30, signal: abort.signal, shouldRetry: retry,
        request: (index, signal) => axios.post(`${base}/${index ? 'backup' : 'preferred'}`, '{}', { proxy: false, responseType: 'stream', signal, timeout: 1000 }),
      });
      expect(result.index).toBe(1);
      expect(urls).toEqual(['/preferred', '/backup']);
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      const chunk = await new Promise<Buffer>((resolve) => result.response.data.once('data', resolve));
      expect(chunk.toString()).toBe('data: backup\n\n');
      abort.abort();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      abort.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(sockets.size).toBe(0);
  });

  it.each([false, true])('client cancel closes real sockets with hedge started=%s', async (hedged) => {
    const sockets = new Set<Socket>();
    let requests = 0;
    const server = createServer(() => { requests++; });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const base = await listen(server);
    const abort = new AbortController();
    const result = hedgedStreamRequest({
      endpointCount: 2, delayMs: hedged ? 20 : 4000, signal: abort.signal, shouldRetry: retry,
      request: (index, signal) => axios.post(`${base}/${index}`, '{}', { proxy: false, responseType: 'stream', signal, timeout: 1000 }),
    });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await vi.waitFor(() => expect(requests).toBe(hedged ? 2 : 1), { interval: 5 });
      abort.abort();
      await assertion;
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      abort.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(sockets.size).toBe(0);
  });

  it('GeminiClient sends fixed-length native JSON and reads streamed ToS rejection before closing it', async () => {
    const seen: { headers: Record<string, unknown>; body: string }[] = [];
    const sockets = new Set<Socket>();
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      seen.push({ headers: req.headers, body });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.write('{"error":{"code":403,"message":');
      setImmediate(() => res.end('"This service has been disabled for violation of Terms of Service.","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"TOS_VIOLATION"}]}}'));
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const base = await listen(server);
    const old = process.env.PROXY_INTERNAL_BASE_URLS;
    process.env.PROXY_INTERNAL_BASE_URLS = `${base}/preferred,${base}/backup`;
    const body = { project: 'native-project', requestId: 'native-request', model: 'gemini-3-flash', request: { contents: [] } } as never;
    try {
      await expect(new GeminiClient().streamGenerateInternal(body, 'fixture'))
        .rejects.toMatchObject({ status: 403, reason: 'tos_violation' });
      expect(seen).toHaveLength(1);
      expect(seen[0].body).toBe(JSON.stringify(body));
      expect(seen[0].headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(body))));
      expect(seen[0].headers['transfer-encoding']).toBeUndefined();
      expect(seen[0].headers['x-goog-user-project']).toBeUndefined();
    } finally {
      if (old === undefined) delete process.env.PROXY_INTERNAL_BASE_URLS;
      else process.env.PROXY_INTERNAL_BASE_URLS = old;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it('GeminiClient reads streamed 429 quota_exhausted body after all endpoints exhaust', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Resource has been exhausted (e.g. check quota).","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED"}]}}');
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const base = await listen(server);
    const old = process.env.PROXY_INTERNAL_BASE_URLS;
    process.env.PROXY_INTERNAL_BASE_URLS = `${base}/preferred,${base}/backup`;
    const body = { project: 'native-project', requestId: 'native-request', model: 'gemini-3.8-flash-high', request: { contents: [] } } as never;
    try {
      await expect(new GeminiClient().streamGenerateInternal(body, 'fixture'))
        .rejects.toMatchObject({ status: 429, reason: 'quota_exhausted' });
    } finally {
      if (old === undefined) delete process.env.PROXY_INTERNAL_BASE_URLS;
      else process.env.PROXY_INTERNAL_BASE_URLS = old;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

});
