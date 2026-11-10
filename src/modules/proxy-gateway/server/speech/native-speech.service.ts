import { HttpException, Inject, Injectable } from '@nestjs/common';
import { observeSelectedAccount } from '@/observability/request-context';
import { NativeSpeechAuth } from './native-speech-auth';
import type { NativeSpeechAuthorization } from './native-speech-auth';
import { NativeSpeechError, transcribeNativeSpeech } from './native-speech-client';
import { boundedLivePcm, decodeSpeechAudio, speechPcmChunks } from './native-speech-media';
import type { SpeechInput } from './native-speech-input';

export interface SpeechResult {
  text: string | null;
  draft_text: string;
  final_text: string | null;
  draft_received: boolean;
  final_received: boolean;
  completed: boolean;
  model: string;
  elapsed_ms: number;
  source: 'antigravity-native-stt';
  error?: { code: string; message: string };
}
export type SpeechOutputEvent =
  | { type: 'ready'; model: string }
  | { type: 'draft' | 'final'; text: string }
  | { type: 'completed'; result: SpeechResult };

export function speechFailure(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof NativeSpeechError) return { status: error.httpStatus, code: error.code, message: error.message };
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body && 'error' in body) {
      const detail = body.error as { code?: unknown; message?: unknown };
      if (typeof detail.code === 'string' && typeof detail.message === 'string') {
        return { status: error.getStatus(), code: detail.code, message: detail.message };
      }
    }
  }
  return { status: 502, code: 'speech_failed', message: 'Native speech processing failed.' };
}

function appendSegment(text: string, segment: string): string {
  if (!text || !segment || /\s$/.test(text) || /^\s/.test(segment)) return text + segment;
  return `${text} ${segment}`;
}

@Injectable()
export class NativeSpeechService {
  constructor(@Inject(NativeSpeechAuth) private readonly auth: NativeSpeechAuth) {}

  async models(signal: AbortSignal) {
    const authorization = await this.auth.resolve(signal);
    try { return { models: authorization.models, default_model: authorization.models[0] ?? null, source: 'antigravity-native-stt' }; }
    finally { authorization.release(); }
  }

  async *transcribe(input: SpeechInput, signal: AbortSignal, live?: AsyncIterable<Uint8Array>): AsyncGenerator<SpeechOutputEvent> {
    const started = Date.now();
    const deadline = AbortSignal.timeout(input.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    let authorization: NativeSpeechAuthorization | undefined;
    try {
      authorization = await this.auth.resolve(combined, input.model);
      yield* this.transcribeAuthorized(input, combined, authorization, started, deadline, signal, live);
    } catch (error) {
      if (deadline.aborted && !signal.aborted) throw new HttpException({ error: { code: 'timeout', message: 'Native speech deadline exceeded.' } }, 504);
      if (signal.aborted) throw new HttpException({ error: { code: 'cancelled', message: 'Native speech request cancelled.' } }, 499);
      throw error;
    } finally { authorization?.release(); }
  }

  private async *transcribeAuthorized(input: SpeechInput, combined: AbortSignal, authorization: NativeSpeechAuthorization,
    started: number, deadline: AbortSignal, signal: AbortSignal, live?: AsyncIterable<Uint8Array>): AsyncGenerator<SpeechOutputEvent> {
    const model = input.model ?? authorization.models[0];
    if (!model) throw new HttpException({ error: { code: 'model_unavailable', message: 'No native speech model is advertised.' } }, 503);
    const audio = live ? boundedLivePcm(live) : speechPcmChunks(await decodeSpeechAudio(input.file!, combined));
    observeSelectedAccount(authorization.accountId);
    let confirmed = '', draft = '';
    let finalReceived = false, draftReceived = false, completed = false;
    let failure: ReturnType<typeof speechFailure> | undefined;
    try {
      for await (const event of transcribeNativeSpeech(audio, {
        accessToken: authorization.accessToken, model, projectId: authorization.projectId,
        upstreamProxyUrl: authorization.upstreamProxyUrl, language: input.language,
        context: input.context, vocabulary: input.vocabulary, signal: combined,
        timeoutMs: Math.max(1, input.timeoutMs - (Date.now() - started)),
      })) {
        if (event.type === 'ready') yield event;
        else if (event.type === 'draft') {
          draftReceived = true;
          draft = appendSegment(confirmed, event.text);
          yield { type: 'draft', text: draft };
        } else if (event.type === 'final') {
          if (!event.text.trim()) continue;
          confirmed = appendSegment(confirmed, event.text);
          finalReceived = true;
          yield { type: 'final', text: confirmed };
        } else if (event.type === 'complete') completed = event.finalReceived;
      }
    } catch (error) {
      failure = deadline.aborted && !signal.aborted
        ? { status: 504, code: 'timeout', message: 'Native speech deadline exceeded.' }
        : speechFailure(error);
      if (failure.code === 'tos_violation') await this.auth.suspend(authorization.accountId);
      if (!draftReceived && !finalReceived) throw new HttpException({ error: { code: failure.code, message: failure.message } }, failure.status);
    }
    if (!completed && !failure) failure = { status: 502, code: 'incomplete_transcription', message: 'Native speech did not confirm completion.' };
    yield { type: 'completed', result: {
      text: finalReceived ? confirmed : null, draft_text: draft, final_text: finalReceived ? confirmed : null,
      draft_received: draftReceived, final_received: finalReceived, completed, model,
      elapsed_ms: Date.now() - started, source: 'antigravity-native-stt',
      ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
    } };
  }
}
