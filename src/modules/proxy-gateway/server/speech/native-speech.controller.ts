import { Body, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { observeNativeModel } from '@/shared/request-observation';
import { ProxyGuard } from '../proxy.guard';
import { parseSpeechOptions, readSpeechUpload, speechInputError, type SpeechInput } from './native-speech-input';
import { NativeSpeechService, speechFailure, type SpeechOutputEvent } from './native-speech.service';

function connectionSignal(request: FastifyRequest, response: FastifyReply) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const close = () => { if (!response.raw.writableEnded) cancel(); };
  request.raw.once('aborted', cancel);
  response.raw.once('close', close);
  return { signal: abort.signal, dispose: () => {
    request.raw.off('aborted', cancel); response.raw.off('close', close);
  } };
}

@Controller('v1/audio/native')
@UseGuards(ProxyGuard)
export class NativeSpeechController {
  constructor(@Inject(NativeSpeechService) private readonly speech: NativeSpeechService) {}

  @Get('models')
  async models(@Req() request: FastifyRequest, @Res() response: FastifyReply) {
    const connection = connectionSignal(request, response);
    try { response.send(await this.speech.models(connection.signal)); }
    catch (error) { this.sendError(response, error); }
    finally { connection.dispose(); }
  }

  @Post('transcriptions')
  async transcribe(@Body() body: unknown, @Req() request: FastifyRequest, @Res() response: FastifyReply) {
    const connection = connectionSignal(request, response);
    try {
      const input = await readSpeechUpload(request, body);
      await this.respond(input, request, response, connection.signal);
    } catch (error) { this.sendError(response, error); }
    finally { connection.dispose(); }
  }

  @Post('transcriptions/stream')
  async live(@Body() body: unknown, @Query() query: Record<string, unknown>, @Req() request: FastifyRequest, @Res() response: FastifyReply) {
    const connection = connectionSignal(request, response);
    try {
      const contentType = request.headers['content-type']?.replace(/\s/g, '').toLowerCase();
      if (contentType !== 'audio/pcm;rate=16000') speechInputError('Live input requires audio/pcm;rate=16000, mono signed PCM16LE.');
      if (!(body instanceof Readable)) speechInputError('A streaming PCM body is required.');
      const input = parseSpeechOptions({ ...query, stream: true });
      await this.respond(input, request, response, connection.signal, body);
    } catch (error) { this.sendError(response, error); }
    finally {
      connection.dispose();
      // This readable is the current request's parser stream, never a shared producer.
      if (body instanceof Readable && !body.readableEnded) {
        if (response.raw.destroyed || response.raw.writableFinished) body.destroy();
        else response.raw.once('finish', () => body.destroy());
      }
    }
  }

  private async respond(input: SpeechInput, request: FastifyRequest, response: FastifyReply, signal: AbortSignal, live?: Readable) {
    let streaming = false;
    // A non-reading client must not hold a suspended generator and its pool lease forever.
    const writeSignal = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
    try {
      for await (const event of this.speech.transcribe(input, signal, live)) {
        if (event.type === 'ready') observeNativeModel(request, event.model);
        if (input.stream) {
          if (!streaming) {
            response.hijack(); streaming = true;
            response.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
          }
          await this.writeEvent(response, event, writeSignal);
        } else if (event.type === 'completed') {
          observeNativeModel(request, event.result.model);
          response.status(200).send(event.result);
        }
      }
    } catch (error) {
      if (!streaming) throw error;
      if (!signal.aborted && !response.raw.destroyed) {
        const { code, message } = speechFailure(error);
        await this.writeEvent(response, { type: 'error', error: { code, message } }, writeSignal);
      }
    } finally {
      if (streaming && !response.raw.destroyed) {
        if (writeSignal.aborted) response.raw.destroy();
        else response.raw.end();
      }
    }
  }

  private async writeEvent(response: FastifyReply, event: SpeechOutputEvent | { type: 'error'; error: { code: string; message: string } }, signal: AbortSignal) {
    if (signal.aborted || response.raw.destroyed) return;
    if (!response.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
      await once(response.raw, 'drain', { signal });
    }
  }

  private sendError(response: FastifyReply, error: unknown) {
    if (response.raw.destroyed || response.sent) return;
    const { status, code, message } = speechFailure(error);
    response.status(status).send({ error: { code, message } });
  }
}
