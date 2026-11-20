import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeResponseUsage } from '@/observability/native-response-usage';
import * as nativeUsage from '@/observability/native-response-usage';
import { createNativeRelayEnd } from '@/modules/proxy-gateway/server/native-relay-completion';
import { createRequestObservation, runWithRequestObservation } from '@/observability/request-context';
import { configureRequestHistory, closeRequestHistory, getRequestHistory, getRequestHistoryStore } from '@/observability/request-history';
import { observeNativeRequest } from '@/dashboard/native-request-journal';
import { CloudCodeFailoverGateway } from '@/modules/proxy-gateway/server/cloudcode-failover-gateway';

const usage = { promptTokenCount: 12, candidatesTokenCount: 4, cachedContentTokenCount: 0 };
const message = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'private-response' }] } }], usageMetadata: usage } });
afterEach(() => { closeRequestHistory(); vi.restoreAllMocks(); });

async function capture(chunks: Buffer[], type = 'text/event-stream', encoding?: string, success = true) {
  const context = createRequestObservation();
  await runWithRequestObservation(context, async () => {
    const observer = createNativeResponseUsage(type, encoding);
    for (const chunk of chunks) observer.write(chunk);
    await observer.finish(success);
  });
  return context;
}

describe('native numeric usage sidechannel', () => {
  it('collects split SSE final usage and preserves earlier observed counters when later fields are absent', async () => {
    const bytes = Buffer.from(`data: {"usageMetadata":{"promptTokenCount":12}}\r\n\r\ndata: {"response":{"usageMetadata":{"candidatesTokenCount":4,"cachedContentTokenCount":0}}}\n\ndata: [DONE]\n\n`);
    const context = await capture(Array.from(bytes, (value) => Buffer.from([value])));
    expect(context).toMatchObject({ input_tokens: 12, output_tokens: 4, cache_tokens: 0 });
    expect(JSON.stringify(context)).not.toContain('usageMetadata');
  });

  it('accepts native JSON arrays with cumulative final usage without summing repeated counters', async () => {
    const bytes = Buffer.from(JSON.stringify([
      { response: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1 } } },
      { response: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, cachedContentTokenCount: 0 } } },
    ]));
    expect(await capture([bytes.subarray(0, 7), bytes.subarray(7)], 'Application/JSON')).toMatchObject({ input_tokens: 12, output_tokens: 4, cache_tokens: 0 });
    const error = Buffer.from(JSON.stringify([{ usageMetadata: usage }, { error: { message: 'private-error' } }]));
    expect((await capture([error], 'application/json')).input_tokens).toBeUndefined();
  });

  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)('decodes %s without changing supplied JSON bytes', async (encoding, compress) => {
    const bytes = compress(Buffer.from(message));
    const before = Buffer.from(bytes);
    expect(await capture([bytes.subarray(0, 3), bytes.subarray(3)], 'application/json', encoding)).toMatchObject({ input_tokens: 12, output_tokens: 4, cache_tokens: 0 });
    expect(bytes).toEqual(before);
  });

  it('keeps unsupported, malformed, error, cancelled and oversized responses unknown', async () => {
    const cases: [Buffer[], string, string | undefined, boolean][] = [
      [[Buffer.from(message)], 'application/grpc', undefined, true],
      [[Buffer.from(message)], 'application/json', 'unsupported', true],
      [[Buffer.from('{bad')], 'application/json', undefined, true],
      [[Buffer.from(message)], 'application/json', undefined, false],
      [[Buffer.from(JSON.stringify({ error: { message: 'private-error' }, usageMetadata: usage }))], 'application/json', undefined, true],
      [[Buffer.from(message)], 'application/json', 'gzip', true],
      [[Buffer.from(' '.repeat(65_537) + message)], 'application/json', undefined, true],
    ];
    for (const [chunks, type, encoding, success] of cases) {
      const context = await capture(chunks, type, encoding, success);
      expect(context.input_tokens).toBeUndefined();
      expect(context.output_tokens).toBeUndefined();
      expect(context.cache_tokens).toBeUndefined();
    }
  });

  it('skips an oversized SSE event and still sees later final metadata', async () => {
    const bytes = Buffer.from(`data: ${'x'.repeat(70_000)}\n\ndata: ${message}\n\n`);
    expect(await capture([bytes])).toMatchObject({ input_tokens: 12, output_tokens: 4, cache_tokens: 0 });
  });

  it('does not publish measurements after cancellation or context completion', async () => {
    const context = createRequestObservation();
    await runWithRequestObservation(context, async () => {
      const observer = createNativeResponseUsage('application/json', undefined);
      observer.write(Buffer.from(message));
      context.finished = true;
      await observer.finish(true);
    });
    expect(context.input_tokens).toBeUndefined();
  });
});

async function relay(chunks: Buffer[], contentType: string, encoding?: string, options: {
  cancelAfterWrite?: boolean; failAfterChunks?: boolean; pool?: boolean; grpcStatus?: string; grpcTrailer?: string;
} = {}) {
  configureRequestHistory(':memory:');
  const grpc = contentType === 'application/grpc';
  const body = grpc ? Buffer.alloc(0) : Buffer.from(options.pool ? '{"model":"gpt-oss-120b-medium"}' : '{"model":"gemini-pro"}');
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: grpc ? '/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent' : '/v1internal:streamGenerateContent', complete: true,
    headers: { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': grpc ? contentType : 'application/json', authorization: 'Bearer fixture' },
    async *[Symbol.asyncIterator]() { yield body; },
  });
  const written: Buffer[] = [];
  const responseEvents = new EventEmitter();
  const res = Object.assign(responseEvents, {
    statusCode: 200, headersSent: false, writableEnded: false, writableFinished: false, destroyed: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; },
    write(chunk: Buffer) { written.push(Buffer.from(chunk)); if (options.cancelAfterWrite) this.destroy(); return true; },
    end(chunk?: Buffer) {
      if (chunk) written.push(Buffer.from(chunk));
      this.writableEnded = true; this.writableFinished = true; responseEvents.emit('finish'); responseEvents.emit('close');
    },
    destroy() { this.destroyed = true; responseEvents.emit('close'); },
  });
  const gateway = new CloudCodeFailoverGateway(options.pool ? {
    getNextToken: vi.fn().mockResolvedValue({ id: 'pool-account', token: { access_token: 'pool-token' } }),
    resolveDynamicModelForAccount: vi.fn().mockReturnValue('scheduler-alias'),
  } as never : undefined);
  const trailers: http.IncomingHttpHeaders = {};
  const bodyStream = Object.assign(Readable.from((async function* () {
    for (const chunk of chunks) { yield chunk; await new Promise((resolve) => setImmediate(resolve)); }
    if (options.grpcTrailer) trailers['grpc-status'] = options.grpcTrailer;
    if (options.failAfterChunks) throw new Error('private-stream-error');
  })()), { trailers });
  const upstream = vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
    statusCode: 200, headers: { 'content-type': contentType, ...(encoding ? { 'content-encoding': encoding } : {}),
      ...(options.grpcStatus ? { 'grpc-status': options.grpcStatus } : {}) },
    bodyStream,
  });
  await new Promise<void>((resolve, reject) => {
    observeNativeRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, () => {
      gateway.handleRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse).then(resolve, reject);
    });
  });
  return { bytes: Buffer.concat(written), history: getRequestHistory(), rollups: getRequestHistoryStore().quotaHistory.getHourlyRollups(), upstream };
}

describe('native gateway persisted usage ordering', () => {
  it('clears the logical deadline at upstream EOF before an optional gzip metadata flush', async () => {
    const context = createRequestObservation();
    await runWithRequestObservation(context, async () => {
      const observer = createNativeResponseUsage('application/json', 'gzip');
      const finish = observer.finish;
      observer.finish = async (success) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await finish(success);
      };
      vi.spyOn(nativeUsage, 'createNativeResponseUsage').mockReturnValue(observer);
      let timedOut = false, completed = false;
      const deadline = setTimeout(() => { timedOut = true; }, 1);
      const stream = Readable.from([]);
      const res = Object.assign(new EventEmitter(), { writableEnded: false });
      const relay = createNativeRelayEnd(res as unknown as http.ServerResponse, stream, { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        () => { completed = true; return true; }, () => { throw new Error('Unexpected downstream failure'); }, () => clearTimeout(deadline));
      relay.responseUsage.write(gzipSync(Buffer.from(message)));
      const completion = relay.onStreamEnd();
      expect(completed).toBe(false);
      await completion;
      expect(timedOut).toBe(false);
      expect(completed).toBe(true);
      expect(context).toMatchObject({ input_tokens: 12, output_tokens: 4, cache_tokens: 0 });
    });
  });

  it('persists native JSON usage before downstream finish and relays the exact response', async () => {
    const bytes = Buffer.from(message);
    const result = await relay([bytes.subarray(0, 7), bytes.subarray(7)], 'application/json');
    expect(result.bytes).toEqual(bytes);
    expect(result.history).toMatchObject({ total: 1, items: [{ status: 200, input_tokens: 12, output_tokens: 4, cache_tokens: 0 }] });
    expect(JSON.stringify(result.history)).not.toMatch(/private-response|usageMetadata|fixture/);
  });

  it.each([['request model', undefined], ['response model', 'gpt-oss-120b-high']] as const)('attributes pool-authenticated native GPT usage to the %s', async (_source, responseModel) => {
    const requested = 'gpt-oss-120b-medium';
    const charged = responseModel ?? requested;
    const bytes = Buffer.from(`data: ${JSON.stringify({ response: { usageMetadata: usage, modelVersion: responseModel } })}\n\n`);
    const result = await relay([bytes], 'text/event-stream', undefined, { pool: true });
    expect(result.upstream.mock.calls[0][2]).toMatchObject({ authorization: 'Bearer pool-token' });
    expect(String(result.upstream.mock.calls[0][3])).toBe(`{"model":"${requested}"}`);
    expect(result.bytes).toEqual(bytes);
    expect(result.history).toMatchObject({ total: 1, items: [{
      protocol: 'connect', project_id: 'native', account_id: 'pool-account', authorization_source: 'pool',
      requested_model: requested, effective_model: charged, input_tokens: 12, output_tokens: 4, cache_tokens: 0,
      attempts: [{ account_id: 'pool-account', effective_model: charged, outcome: 'success' }],
    }] });
    expect(result.rollups).toMatchObject([{ account_id: 'pool-account', model: charged, pool: 'third_party',
      requests: 1, measured_requests: 1, input_tokens: 12, output_tokens: 4 }]);
    expect(JSON.stringify(result.history)).not.toMatch(/pool-token|scheduler-alias/);
  });

  it('records terminal native gRPC status when the HTTP transport returns 200', async () => {
    const result = await relay([], 'application/grpc', undefined, { grpcStatus: '7' });
    expect(result.history).toMatchObject({ total: 1, items: [{ status: 200, grpc_status: '7', input_tokens: null }] });
    expect(result.rollups).toMatchObject([{ requests: 1, failed_requests: 1, measured_requests: 0 }]);
  });

  it('updates a pool attempt when the native gRPC trailer reports failure after the first message', async () => {
    const frame = Buffer.from([0, 0, 0, 0, 2, 0x08, 0x01]);
    const result = await relay([frame], 'application/grpc', undefined, { pool: true, grpcTrailer: '7' });
    expect(result.bytes).toEqual(frame);
    expect(result.history).toMatchObject({ total: 1, items: [{ status: 200, grpc_status: '7', input_tokens: null,
      attempts: [{ account_id: 'pool-account', outcome: 'failure' }],
    }] });
    expect(result.rollups).toMatchObject([{ requests: 1, failed_requests: 1, measured_requests: 0 }]);
  });

  it.each([['cancel', 499], ['upstream failure', 502]] as const)('discards observed usage on %s without retaining response contents', async (failure, status) => {
    const bytes = Buffer.from(`data: ${message}\n\n`);
    const result = await relay([bytes], 'text/event-stream', undefined, { cancelAfterWrite: failure === 'cancel', failAfterChunks: failure === 'upstream failure' });
    expect(result.bytes).toEqual(bytes);
    expect(result.history).toMatchObject({ total: 1, items: [{ status, input_tokens: null, output_tokens: null, cache_tokens: null }] });
    expect(JSON.stringify(result.history)).not.toMatch(/private-response|private-stream-error/);
  });

  it.each([undefined, 'gzip'] as const)('persists final split SSE usage with encoding %s before native journal completion', async (encoding) => {
    const text = Buffer.from(`data: {"response":{"candidates":[]}}\n\ndata: ${message}\n\ndata: [DONE]\n\n`);
    const bytes = encoding ? gzipSync(text) : text;
    const result = await relay(Array.from({ length: Math.ceil(bytes.length / 13) }, (_, index) => bytes.subarray(index * 13, (index + 1) * 13)), 'text/event-stream', encoding);
    expect(result.bytes).toEqual(bytes);
    expect(result.history).toMatchObject({ total: 1, items: [{ status: 200, input_tokens: 12, output_tokens: 4, cache_tokens: 0 }] });
  });
});
