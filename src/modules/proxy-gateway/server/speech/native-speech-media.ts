import { spawn } from 'node:child_process';
import { HttpException } from '@nestjs/common';
import { MAX_SPEECH_PCM_BYTES } from './native-speech-input';

/** Decode in a pipe-only sandbox: uploaded playlists cannot open files or network URLs. */
export function decodeSpeechAudio(file: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.AG_PROXY_FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe',
      '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const stop = (error: Error) => {
      failure ??= error;
      if (closed || killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
    };
    const abort = () => stop(new HttpException({ error: { code: 'cancelled', message: 'Audio decoding cancelled.' } }, 499));
    const timer = setTimeout(() => stop(new HttpException({ error: { code: 'decode_timeout', message: 'Audio decoding timed out.' } }, 504)), 20000);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => { failure ??= new HttpException({ error: { code: 'decoder_unavailable', message: 'The server requires ffmpeg to decode audio files.' } }, 503); });
    child.stdin.on('error', () => { /* ffmpeg may reject an invalid upload before stdin finishes. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SPEECH_PCM_BYTES) stop(new HttpException({ error: { code: 'audio_too_long', message: 'Audio exceeds five minutes.' } }, 413));
      else chunks.push(chunk);
    });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(killTimer);
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !size) reject(new HttpException({ error: { code: 'invalid_audio', message: 'Cannot decode the uploaded audio.' } }, 400));
      else resolve(Buffer.concat(chunks, size));
    });
    if (signal.aborted) abort();
    else child.stdin.end(file);
  });
}

export async function* speechPcmChunks(pcm: Buffer): AsyncGenerator<Buffer> {
  // Five audio frames per second of upload; server processing remains independent of playback.
  for (let offset = 0; offset < pcm.length; offset += 6400) yield pcm.subarray(offset, offset + 6400);
}

export async function* boundedLivePcm(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let size = 0;
  let remainder = Buffer.alloc(0);
  for await (const chunk of input) {
    size += chunk.length;
    if (size > MAX_SPEECH_PCM_BYTES) throw new HttpException({ error: { code: 'audio_too_long', message: 'Live audio exceeds five minutes.' } }, 413);
    const data = Buffer.concat([remainder, chunk]);
    const end = data.length - data.length % 2;
    for (let offset = 0; offset < end; offset += 6400) yield data.subarray(offset, Math.min(end, offset + 6400));
    remainder = data.subarray(end);
  }
  if (remainder.length) throw new HttpException({ error: { code: 'invalid_pcm', message: 'PCM16 audio ends with an incomplete sample.' } }, 400);
  if (!size) throw new HttpException({ error: { code: 'empty_audio', message: 'Live audio is empty.' } }, 400);
}
