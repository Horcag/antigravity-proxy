import { once } from 'node:events';
import { HttpException } from '@nestjs/common';
import { transcriptionResidual } from './native-speech-residual';
import { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { connectNativeSpeech, SPEECH_RPC } from './native-speech-connection';
import {
  activityMessage, audioEndMessage, audioMessage, contextMessage, decodeSpeechResponse,
  GrpcFrameDecoder, grpcFrame, setupMessage,
} from './native-speech-protocol';

export interface NativeSpeechOptions {
  accessToken: string;
  model: string;
  projectId?: string;
  upstreamProxyUrl?: string;
  language?: string;
  context?: string;
  vocabulary?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type NativeSpeechEvent =
  | { type: 'ready'; model: string }
  | { type: 'draft' | 'final'; text: string }
  | { type: 'complete'; finalReceived: boolean };
export class NativeSpeechError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 502,
    public readonly grpcStatus?: number,
  ) { super(message); this.name = 'NativeSpeechError'; }
}
export interface NativeSpeechDependencies {
  connect?: (proxyUrl: string | undefined, signal: AbortSignal) => Promise<ClientHttp2Session>;
}

/** Final events contain confirmed segments; drafts contain only the current unconfirmed segment. */
export async function* transcribeNativeSpeech(
  audio: AsyncIterable<Uint8Array>, options: NativeSpeechOptions, dependencies: NativeSpeechDependencies = {},
): AsyncGenerator<NativeSpeechEvent> {
  const abort = new AbortController();
  let failure: NativeSpeechError | undefined;
  let session: ClientHttp2Session | undefined;
  let stream: ClientHttp2Stream | undefined;
  let wake: (() => void) | undefined;
  let setupReady: (() => void) | undefined;
  let ended = false, finalReceived = false, inputEnded = false;
  let pendingDraft = '';
  let successfulGrpcStatus = false;
  let eventBytes = 0;
  const events: NativeSpeechEvent[] = [];
  const ready = new Promise<void>((resolve) => { setupReady = resolve; });
  const fail = (error: NativeSpeechError) => {
    failure ??= error;
    abort.abort();
    setupReady?.();
    wake?.();
    stream?.destroy();
    session?.destroy();
  };
  const onAbort = () => fail(new NativeSpeechError('cancelled', 'Speech transcription cancelled', 499));
  const timer = setTimeout(() => fail(new NativeSpeechError('timeout', 'Speech transcription deadline exceeded', 504)), options.timeoutMs ?? 120_000);
  timer.unref();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const push = (event: NativeSpeechEvent) => {
    eventBytes += 'text' in event ? Buffer.byteLength(event.text) : 0;
    if (eventBytes > 4 * 1024 * 1024 || events.length >= 1024) {
      fail(new NativeSpeechError('response_limit', 'Speech response exceeded limit'));
      return;
    }
    events.push(event); wake?.();
  };
  try {
    if (options.signal?.aborted) onAbort();
    if (failure) throw failure;
    if (!options.accessToken || /[\r\n]/.test(options.accessToken) || !options.model) {
      throw new NativeSpeechError('invalid_options', 'Speech credentials and model are required', 400);
    }
    session = await (dependencies.connect ?? connectNativeSpeech)(options.upstreamProxyUrl, abort.signal);
    session.on('error', () => fail(new NativeSpeechError('transport_error', 'Speech connection failed')));
    if (failure) throw failure;
    stream = session.request({
      ':method': 'POST', ':path': SPEECH_RPC,
      'content-type': 'application/grpc', te: 'trailers',
      authorization: `Bearer ${options.accessToken}`,
      ...(options.projectId ? { 'x-goog-user-project': options.projectId } : {}),
    });
    const request = stream;
    const write = async (message: Buffer) => {
      if (abort.signal.aborted) throw failure;
      if (!request.write(grpcFrame(message))) await once(request, 'drain', { signal: abort.signal });
    };
    const maybeEnd = () => {
      if (inputEnded && finalReceived && !pendingDraft) request.end();
    };
    const decoder = new GrpcFrameDecoder();
    const checkStatus = (headers: Record<string, unknown>) => {
      const status = Number(headers['grpc-status'] ?? 0);
      if (headers['grpc-status'] !== undefined && status === 0) { successfulGrpcStatus = true; return; }
      if (headers['grpc-status'] === undefined) return;
      let message = String(headers['grpc-message'] ?? '');
      try { message = decodeURIComponent(message); } catch { /* Classification also handles unescaped messages. */ }
      if (status === 7 && /insufficient[^\r\n]*scope|access_token_scope_insufficient/i.test(message)) {
        fail(new NativeSpeechError('speech_scope_required',
          'The selected account needs the aicode OAuth permission for native speech.', 403, status));
        return;
      }
      const tosViolation = status === 7 && /disabled.*violation.*terms of service|tos_violation/i.test(message);
      fail(new NativeSpeechError(tosViolation ? 'tos_violation' : 'upstream_grpc_error',
        'Speech upstream rejected the request', status === 7 || status === 16 ? 403 : 502, status));
    };
    request.on('response', (headers) => {
      if (Number(headers[':status']) !== 200) fail(new NativeSpeechError('upstream_http_error', 'Speech upstream HTTP request failed', 502));
      checkStatus(headers);
    });
    request.on('trailers', checkStatus);
    request.on('error', () => fail(new NativeSpeechError('transport_error', 'Speech stream failed')));
    request.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const response = decodeSpeechResponse(frame);
          if (response.setupComplete && setupReady) {
            setupReady(); setupReady = undefined;
            push({ type: 'ready', model: options.model });
          }
          for (const transcript of response.transcripts) {
            if (transcript.kind === 'final') {
              finalReceived ||= transcript.text.trim().length > 0;
              pendingDraft = transcriptionResidual(pendingDraft, transcript.text);
            } else pendingDraft = transcript.text;
            push({ type: transcript.kind, text: transcript.text });
          }
          maybeEnd();
        }
      } catch { fail(new NativeSpeechError('invalid_response', 'Speech upstream returned invalid framing')); }
    });
    request.on('end', () => {
      try { decoder.finish(); } catch { fail(new NativeSpeechError('invalid_response', 'Speech upstream returned a truncated frame')); }
      ended = true; wake?.();
    });
    request.on('close', () => {
      if (!ended && !failure) fail(new NativeSpeechError('incomplete_transcription', 'Speech stream closed prematurely'));
    });
    // Observe producer failures even when the consumer is suspended at yield.
    void (async () => {
      await write(setupMessage(options.model, options.language));
      await ready;
      if (failure) return;
      const context = contextMessage(options.context, options.vocabulary);
      if (context) await write(context);
      await write(activityMessage(true));
      const iterator = audio[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await nextAudio(iterator, abort.signal);
          if (next.done) break;
          const chunk = next.value;
          for (let offset = 0; offset < chunk.length; offset += 32_768) {
            await write(audioMessage(chunk.subarray(offset, offset + 32_768)));
          }
        }
      } finally {
        // A foreign iterator may have an unresolvable next(); never await its return on cancellation.
        if (abort.signal.aborted) void Promise.resolve(iterator.return?.()).catch(() => {});
      }
      await write(activityMessage(false));
      await write(audioEndMessage());
      inputEnded = true; maybeEnd(); wake?.();
    })().catch((error: unknown) => { if (!failure) fail(audioInputFailure(error)); });
    while (true) {
      if (failure) throw failure;
      const event = events.shift();
      if (event) {
        eventBytes -= 'text' in event ? Buffer.byteLength(event.text) : 0;
        yield event; continue;
      }
      if (ended) {
        if (!successfulGrpcStatus) throw new NativeSpeechError('missing_grpc_status', 'Speech stream ended without a successful gRPC status');
        if (!inputEnded || !finalReceived || pendingDraft) {
          throw new NativeSpeechError('incomplete_transcription', 'Speech stream ended without a confirmed complete transcription');
        }
        yield { type: 'complete', finalReceived: true };
        return;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  } catch (error) {
    if (error instanceof NativeSpeechError) throw error;
    throw failure ?? new NativeSpeechError('transport_error', 'Speech connection failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    abort.abort(); setupReady?.();
    stream?.destroy(); session?.destroy();
  }
}

function nextAudio(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(new Error('Audio input cancelled')); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function audioInputFailure(error: unknown): NativeSpeechError {
  // Only these errors originate in the bounded live PCM adapter. Keep arbitrary
  // iterator exceptions and upstream details out of the public response.
  const known: Record<string, { status: number; message: string }> = {
    empty_audio: { status: 400, message: 'Live audio is empty.' },
    invalid_pcm: { status: 400, message: 'PCM16 audio ends with an incomplete sample.' },
    audio_too_long: { status: 413, message: 'Live audio exceeds five minutes.' },
  };
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body && 'error' in body && typeof body.error === 'object' && body.error && 'code' in body.error) {
      const code = body.error.code;
      const detail = typeof code === 'string' && Object.hasOwn(known, code) ? known[code] : undefined;
      if (detail && detail.status === error.getStatus()) return new NativeSpeechError(String(code), detail.message, detail.status);
    }
  }
  return new NativeSpeechError('audio_error', 'Speech audio input failed');
}
