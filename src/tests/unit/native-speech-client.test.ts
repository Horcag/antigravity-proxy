import { createServer as createHttpServer } from 'node:http';
import { connectNativeSpeech } from '../../modules/proxy-gateway/server/speech/native-speech-connection';
import { connect, createServer, type ServerHttp2Stream, type IncomingHttpHeaders } from 'node:http2';
import { type AddressInfo } from 'node:net';
import { HttpException } from '@nestjs/common';
import { boundedLivePcm } from '../../modules/proxy-gateway/server/speech/native-speech-media';
import { MAX_SPEECH_PCM_BYTES } from '../../modules/proxy-gateway/server/speech/native-speech-input';
import { afterEach, describe, expect, it } from 'vitest';
import { transcribeNativeSpeech, type NativeSpeechEvent } from '../../modules/proxy-gateway/server/speech/native-speech-client';
import { boolField, bytesField, GrpcFrameDecoder, grpcFrame, textField } from '../../modules/proxy-gateway/server/speech/native-speech-protocol';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void) {
  const server = createServer();
  server.on('session', (session) => { session.on('error', () => {}); });
  server.on('stream', (stream, headers) => { stream.on('error', () => {}); handler(stream, headers); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { connect: async () => connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) };
}
async function* audio() { yield Buffer.from([0, 0, 1, 0]); }
const options = { accessToken: 'test-secret', model: 'test-model', timeoutMs: 1000 };
const setup = grpcFrame(bytesField(1, Buffer.alloc(0)));
function transcript(field: number, text: string) { return grpcFrame(bytesField(2, bytesField(field, textField(1, text)))); }
const turn = grpcFrame(bytesField(2, boolField(3)));
async function collect(iterable: AsyncIterable<NativeSpeechEvent>) {
  const events: NativeSpeechEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('native speech client', () => {
  it('sends authorization, waits for setup, then emits draft and confirmed segments separately', async () => {
    const messages: Buffer[] = [];
    let headers: IncomingHttpHeaders = {};
    const transport = await fixture((stream, receivedHeaders) => {
      headers = receivedHeaders;
      stream.respond({ ':status': 200, 'grpc-status': '0' });
      stream.on('end', () => stream.end());
      const decoder = new GrpcFrameDecoder();
      stream.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          messages.push(message);
          if (messages.length === 1) stream.write(setup);
          if (message.equals(Buffer.from('1a021001', 'hex'))) {
            const payload = Buffer.concat([transcript(11, 'confirmed'), transcript(6, 'confirmed'), turn]);
            stream.write(payload.subarray(0, 3)); stream.write(payload.subarray(3));
          }
        }
      });
    });
    expect(await collect(transcribeNativeSpeech(audio(), options, transport))).toEqual([
      { type: 'ready', model: options.model }, { type: 'draft', text: 'confirmed' },
      { type: 'final', text: 'confirmed' }, { type: 'complete', finalReceived: true },
    ]);
    expect(headers.authorization).toBe('Bearer test-secret');
    expect(headers[':path']).toBe('/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent');
    expect(messages.map((message) => message.toString('hex')).slice(1)).toEqual([
      '1a022a00', '1a1e0a1c0a14617564696f2f70636d3b726174653d3136303030120400000100', '1a023200', '1a021001',
    ]);
  });
  it('half-closes after a confirmed segment with no turn_complete and accepts EOF', async () => {
    let ended = false;
    const transport = await fixture((stream) => {
      stream.respond({ ':status': 200 }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      const decoder = new GrpcFrameDecoder();
      stream.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (message[0] === 10) stream.write(setup);
          if (message.equals(Buffer.from('1a021001', 'hex'))) stream.write(transcript(6, 'done'));
        }
      });
      stream.on('end', () => { ended = true; stream.end(); });
    });
    expect((await collect(transcribeNativeSpeech(audio(), options, transport))).at(-1)).toEqual({ type: 'complete', finalReceived: true });
    expect(ended).toBe(true);
  });
  it('keeps an unconfirmed suffix until the next confirmed segment', async () => {
    let ended = false, endedBeforeFinal = false;
    const transport = await fixture((stream) => {
      stream.respond({ ':status': 200, 'grpc-status': '0' });
      stream.on('end', () => { ended = true; stream.end(); });
      const decoder = new GrpcFrameDecoder();
      stream.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (message[0] === 10) stream.write(setup);
          if (message.equals(Buffer.from('1a021001', 'hex'))) {
            stream.write(Buffer.concat([transcript(11, 'Well, HELLO world! More'), transcript(6, 'hello, world.')]));
            setTimeout(() => { endedBeforeFinal = ended; stream.write(transcript(6, 'More')); }, 10);
          }
        }
      });
    });
    const result = await collect(transcribeNativeSpeech(audio(), options, transport));
    expect(endedBeforeFinal).toBe(false);
    expect(result.flatMap((event) => event.type === 'final' ? [event.text] : [])).toEqual(['hello, world.', 'More']);
    expect(result.at(-1)?.type).toBe('complete');
  });
  it('checks error trailers after confirmed speech before reporting completion', async () => {
    const transport = await fixture((stream) => {
      stream.respond({ ':status': 200 }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '7', 'grpc-message': 'permission denied' }));
      stream.on('end', () => stream.end());
      const decoder = new GrpcFrameDecoder();
      stream.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (message[0] === 10) stream.write(setup);
          if (message.equals(Buffer.from('1a021001', 'hex'))) stream.write(transcript(6, 'done'));
        }
      });
    });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({ code: 'upstream_grpc_error', grpcStatus: 7 });
  });
  it('classifies explicit ToS restriction separately from other permission errors', async () => {
    const transport = await fixture((stream) => {
      stream.respond({ ':status': 200, 'grpc-status': '7', 'grpc-message': encodeURIComponent('Account disabled due to violation of terms of service') });
      stream.end();
    });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({ code: 'tos_violation', grpcStatus: 7, httpStatus: 403 });
  });
  it('returns a pending audio iterator when its deadline expires', async () => {
    let returned = false;
    const stalledAudio: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true, value: undefined }; },
    }) };
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); stream.write(setup); });
    await expect(collect(transcribeNativeSpeech(stalledAudio, { ...options, timeoutMs: 30 }, transport))).rejects.toMatchObject({ code: 'timeout' });
    expect(returned).toBe(true);
  });
  it('uses the configured HTTP CONNECT proxy and keeps tunnel failures sanitized', async () => {
    const proxy = createHttpServer();
    let target = '', authorization = '';
    proxy.on('connect', (request, socket) => {
      target = request.url ?? '';
      authorization = request.headers['proxy-authorization'] ?? '';
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const proxyUrl = `http://test:secret@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    await expect(connectNativeSpeech(proxyUrl, new AbortController().signal)).rejects.toThrow('Speech proxy tunnel failed');
    expect(target).toBe('aicode.googleapis.com:443');
    expect(authorization).toBe(`Basic ${Buffer.from('test:secret').toString('base64')}`);
  });
  it('rejects clean EOF without an explicit successful gRPC status', async () => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200 }); stream.end(setup); });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({ code: 'missing_grpc_status' });
  });
  it('does not count an empty or whitespace final as confirmed speech', async () => {
    const transport = await fixture((stream) => {
      stream.respond({ ':status': 200, 'grpc-status': '0' });
      stream.end(Buffer.concat([setup, transcript(6, '   ')]));
    });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({ code: 'incomplete_transcription' });
  });
  it('distinguishes insufficient OAuth scope from account restrictions', async () => {
    const transport = await fixture((stream) => {
      stream.respond({ ':status': 200, 'grpc-status': '7', 'grpc-message': encodeURIComponent('Request had insufficient authentication scopes.') });
      stream.end();
    });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({
      code: 'speech_scope_required', httpStatus: 403, grpcStatus: 7,
      message: 'The selected account needs the aicode OAuth permission for native speech.',
    });
  });
  it.each([
    { name: 'empty input', code: 'empty_audio', status: 400, chunks: [] },
    { name: 'oversized input', code: 'audio_too_long', status: 413, chunks: [Buffer.alloc(MAX_SPEECH_PCM_BYTES + 1)] },
    { name: 'incomplete sample', code: 'invalid_pcm', status: 400, chunks: [Buffer.from([1])] },
  ])('preserves bounded live PCM errors: $name', async ({ chunks, code, status }) => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); stream.write(setup); });
    async function* input() { yield* chunks; }
    await expect(collect(transcribeNativeSpeech(boundedLivePcm(input()), options, transport))).rejects.toMatchObject({ code, httpStatus: status });
  });
  it('sanitizes arbitrary audio iterator exceptions', async () => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); stream.write(setup); });
    const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: async () => {
      throw new HttpException({ error: { code: 'foreign_error', message: 'test-secret' } }, 400);
    } }) };
    await expect(collect(transcribeNativeSpeech(input, options, transport))).rejects.toMatchObject({
      code: 'audio_error', httpStatus: 502, message: 'Speech audio input failed',
    });
  });
  it('does not promote a draft when the stream closes prematurely', async () => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); stream.end(Buffer.concat([setup, transcript(11, 'draft')])); });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({ code: 'incomplete_transcription' });
  });
  it('rejects a completed turn with no confirmed transcription', async () => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); stream.end(Buffer.concat([setup, transcript(11, 'draft'), turn])); });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({ code: 'incomplete_transcription' });
  });
  it('sanitizes upstream grpc errors without copying the server message', async () => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '7', 'grpc-message': 'test-secret private details' }); stream.end(); });
    await expect(collect(transcribeNativeSpeech(audio(), options, transport))).rejects.toMatchObject({
      code: 'upstream_grpc_error', grpcStatus: 7, httpStatus: 403, message: 'Speech upstream rejected the request',
    });
  });
  it('cancels a pending stream', async () => {
    const controller = new AbortController();
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); controller.abort(); });
    await expect(collect(transcribeNativeSpeech(audio(), { ...options, signal: controller.signal }, transport))).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('applies a deadline while awaiting setup', async () => {
    const transport = await fixture((stream) => { stream.respond({ ':status': 200, 'grpc-status': '0' }); });
    await expect(collect(transcribeNativeSpeech(audio(), { ...options, timeoutMs: 30 }, transport))).rejects.toMatchObject({ code: 'timeout', httpStatus: 504 });
  });
});
