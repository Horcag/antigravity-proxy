import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory, APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProxyGuard } from '../../modules/proxy-gateway/server/proxy.guard';
import { NativeSpeechController } from '../../modules/proxy-gateway/server/speech/native-speech.controller';
import { NativeSpeechService } from '../../modules/proxy-gateway/server/speech/native-speech.service';
import { parseSpeechOptions } from '../../modules/proxy-gateway/server/speech/native-speech-input';
import { FastifyMultipartProvider, MultipartOpenAIExceptionFilter } from '../../modules/proxy-gateway/server/fastify-multipart.provider';
import { DEFAULT_PROXY_CONFIG } from '../../modules/config/types';
import { setServerConfig } from '../../server/server-config';

const result = { text: 'confirmed', draft_text: 'rough', final_text: 'confirmed', draft_received: true,
  final_received: true, completed: true, model: 'models/native-test', elapsed_ms: 42, source: 'antigravity-native-stt' };
const transcribe = vi.fn(async function* (_input: unknown, _signal: AbortSignal, live?: AsyncIterable<Uint8Array>) {
  yield { type: 'ready', model: result.model };
  yield { type: 'draft', text: result.draft_text };
  if (live) for await (const chunk of live) { expect(chunk.byteLength).toBeGreaterThan(0); }
  yield { type: 'final', text: result.final_text };
  yield { type: 'completed', result };
});
@Module({ controllers: [NativeSpeechController], providers: [ProxyGuard, FastifyMultipartProvider,
  { provide: NativeSpeechService, useValue: { transcribe, models: async () => ({ models: [result.model] }) } },
  { provide: APP_FILTER, useClass: MultipartOpenAIExceptionFilter },
] })
class TestSpeechModule {}

describe('native speech API boundaries', () => {
  let app: NestFastifyApplication;
  let server: FastifyInstance;
  const headers = { authorization: 'Bearer speech-client' };
  beforeAll(async () => {
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, api_key: 'speech-client' });
    app = await NestFactory.create<NestFastifyApplication>(TestSpeechModule, new FastifyAdapter(), { logger: false });
    await app.init();
    server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    await server.ready();
  });
  afterAll(async () => { await app.close(); setServerConfig(null); });
  it('requires the application API key for native models and transcription', async () => {
    expect((await server.inject('/v1/audio/native/models')).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/audio/native/transcriptions', payload: { audio: 'data:audio/wav;base64,YQ==' } })).statusCode).toBe(401);
    expect((await server.inject({ url: '/v1/audio/native/models', headers })).json().models).toEqual([result.model]);
  });
  it('accepts JSON audio and returns separate native draft and final', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/audio/native/transcriptions', headers,
      payload: { audio: 'data:audio/mpeg;base64,YQ==', language: 'ru-RU', vocabulary: ['MAPE'] } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(result);
    expect(transcribe.mock.calls.at(-1)?.[0]).toMatchObject({ file: Buffer.from('a'), language: 'ru-RU', vocabulary: ['MAPE'] });
  });
  it('parses multipart file/options and emits genuine SSE events', async () => {
    const boundary = 'speech-boundary';
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\naudio\r\n--${boundary}\r\nContent-Disposition: form-data; name="stream"\r\n\r\ntrue\r\n--${boundary}--\r\n`);
    const response = await server.inject({ method: 'POST', url: '/v1/audio/native/transcriptions',
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: draft\n');
    expect(response.body).toContain('event: completed\n');
    expect(transcribe.mock.calls.at(-1)?.[0]).toMatchObject({ file: Buffer.from('audio') });
  });
  it('rejects unsupported options and invalid/empty audio before upstream', async () => {
    for (const payload of [{ audio: 'data:audio/wav;base64,!!!' }, { audio: 'data:audio/wav;base64,YQ==', prompt: 'execute me' },
      { audio: 'data:audio/wav;base64,YQ==', timeout_ms: true }, { audio: 'data:audio/wav;base64,YQ==', stream: 'yes' }]) {
      const before = transcribe.mock.calls.length;
      const response = await server.inject({ method: 'POST', url: '/v1/audio/native/transcriptions', headers, payload });
      expect(response.statusCode).toBe(400); expect(transcribe.mock.calls.length).toBe(before);
    }
  });
  it('keeps raw PCM streaming scoped to the live route', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/audio/native/transcriptions',
      headers: { ...headers, 'content-type': 'audio/pcm;rate=16000' }, payload: Buffer.alloc(16) });
    expect(response.statusCode).toBe(415);
  });
  it('returns draft while upload is open, then final after half-close', async () => {
    await app.listen(0, '127.0.0.1');
    const address = server.server.address() as { port: number };
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: address.port,
        path: '/v1/audio/native/transcriptions/stream?language=ru-RU', method: 'POST',
        headers: { ...headers, 'content-type': 'audio/pcm;rate=16000' },
      }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (data: string) => {
          events.push(data);
          if (data.includes('event: draft')) { expect(request.writableEnded).toBe(false); request.end(Buffer.alloc(16)); }
        });
        response.on('end', resolve); response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(2000, () => { request.destroy(); reject(new Error('live fixture timed out')); });
      request.write(Buffer.alloc(16));
    });
    expect(events.join('')).toContain('event: completed');
  });
  it('validates explicit hints and server deadline bounds', () => {
    expect(() => parseSpeechOptions({ language: 'ru_RU' })).toThrow();
    expect(() => parseSpeechOptions({ vocabulary: [''] })).toThrow();
    expect(() => parseSpeechOptions({ timeout_ms: 300001 })).toThrow();
  });
  it('releases a suspended producer when an open SSE client never drains', async () => {
    let released = false;
    const speech = { transcribe: async function* () {
      try { yield { type: 'ready', model: 'models/native-test' }; }
      finally { released = true; }
    } };
    const raw = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, writableFinished: false,
      writeHead: vi.fn(), write: vi.fn(() => false), end: vi.fn(),
      destroy() { this.destroyed = true; EventEmitter.prototype.emit.call(this, 'close'); },
    });
    const response = { raw, hijack: vi.fn() } as unknown as FastifyReply;
    const request = { raw: new EventEmitter(), isMultipart: () => false } as unknown as FastifyRequest;
    const started = Date.now();
    await new NativeSpeechController(speech as unknown as NativeSpeechService).transcribe({
      audio: 'data:audio/wav;base64,YQ==', stream: true, timeout_ms: 1000,
    }, request, response);
    expect(released).toBe(true); expect(raw.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
