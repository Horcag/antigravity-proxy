import { BadRequestException, HttpException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const MAX_SPEECH_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SPEECH_PCM_BYTES = 300 * 16000 * 2;
export interface SpeechInput {
  model?: string;
  language?: string;
  context?: string;
  vocabulary?: string[];
  timeoutMs: number;
  stream: boolean;
  file?: Buffer;
}
export function speechInputError(message: string): never {
  throw new BadRequestException({ error: { code: 'invalid_request', message } });
}
function stringOption(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  })) {
    speechInputError(`Invalid ${name}.`);
  }
  return value.trim() || undefined;
}
export function parseSpeechOptions(body: Record<string, unknown>): SpeechInput {
  const allowed = new Set(['file', 'audio', 'model', 'language', 'context', 'vocabulary', 'timeout_ms', 'stream']);
  if (Object.keys(body).some((key) => !allowed.has(key))) speechInputError('Unsupported speech option.');
  const model = stringOption(body.model, 'model', 200);
  const language = stringOption(body.language, 'language', 35);
  if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) speechInputError('Invalid language tag.');
  const context = stringOption(body.context, 'context', 8000);
  const timeoutMs = body.timeout_ms === undefined ? 120000 : Number(body.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    speechInputError('timeout_ms must be an integer between 1000 and 300000.');
  }
  if (body.stream !== undefined && ![true, false, 'true', 'false'].includes(body.stream as boolean)) {
    speechInputError('stream must be a boolean.');
  }
  let vocabulary = body.vocabulary;
  if (typeof vocabulary === 'string') {
    try { vocabulary = JSON.parse(vocabulary); } catch { speechInputError('vocabulary must be a JSON array of terms.'); }
  }
  if (vocabulary !== undefined && (!Array.isArray(vocabulary) || vocabulary.length > 100
    || vocabulary.some((term) => typeof term !== 'string' || !term.trim() || term.length > 100))) {
    speechInputError('vocabulary must contain at most 100 nonempty terms of at most 100 characters.');
  }
  return { model, language, context, vocabulary: vocabulary as string[] | undefined,
    timeoutMs, stream: body.stream === true || body.stream === 'true' };
}
export async function readSpeechUpload(request: FastifyRequest, body: unknown): Promise<SpeechInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) speechInputError('A file upload or JSON audio is required.');
  const record = body as Record<string, unknown>;
  let options: Record<string, unknown>;
  let file: Buffer;
  if (request.isMultipart()) {
    options = {};
    let upload: { toBuffer: () => Promise<Buffer>; file: { truncated?: boolean } } | undefined;
    for (const [name, raw] of Object.entries(record)) {
      if (Array.isArray(raw)) speechInputError('Duplicate speech fields are not supported.');
      const part = raw as { type?: string; value?: unknown };
      if (name === 'file' && part?.type === 'file') {
        upload = raw as typeof upload;
        options.file = true;
      } else {
        if (part?.type !== 'field') speechInputError('Only one file field named file is supported.');
        options[name] = part.value;
      }
    }
    if (!upload) speechInputError('Missing file.');
    file = await upload.toBuffer();
    if (upload.file.truncated) throw new HttpException({ error: { code: 'file_too_large', message: 'Audio exceeds 25 MiB.' } }, 413);
  } else {
    options = record;
    if (record.file !== undefined || typeof record.audio !== 'string') speechInputError('JSON audio must be an audio data URL.');
    const match = /^data:audio\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(record.audio);
    if (!match || match[1].length % 4 !== 0) speechInputError('Invalid audio data URL.');
    file = Buffer.from(match[1], 'base64');
    if (file.toString('base64') !== match[1]) speechInputError('Invalid base64 audio.');
  }
  if (!file.length) speechInputError('Audio file is empty.');
  if (file.length > MAX_SPEECH_FILE_BYTES) throw new HttpException({ error: { code: 'file_too_large', message: 'Audio exceeds 25 MiB.' } }, 413);
  return { ...parseSpeechOptions(options), file };
}
