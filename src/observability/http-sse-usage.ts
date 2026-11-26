import type http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyReply } from 'fastify';
import {
  extractResponseUsage,
  mergeStreamResponseUsage,
  type RequestObservation,
  type ResponseUsage,
} from './request-context';

const MESSAGE_LIMIT = 64 * 1024;
const DECODED_LIMIT = 16 * 1024 * 1024;

export interface HttpSseUsageTap {
  readonly isSse: () => boolean;
  readonly statusCode: () => number | undefined;
  finalize(success: boolean): void;
  discard(): void;
}

function headerValueFromArgs(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    }
    return undefined;
  }
  if (typeof headers === 'object') {
    for (const [key, val] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === name && val !== undefined) return Array.isArray(val) ? val.join(', ') : String(val);
    }
  }
  return undefined;
}

function isSseContentType(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('text/event-stream');
}

/** Non-invasive read-only SSE tap on reply.raw for hijacked HTTP streaming endpoints. */
export function attachHttpSseUsageTap(reply: FastifyReply, context: RequestObservation): HttpSseUsageTap {
  const raw = reply.raw as http.ServerResponse;
  const decoder = new StringDecoder('utf8');
  let sseDetected = false;
  let capturedStatus: number | undefined;
  let disabled = false;
  let pending = '';
  let skipping = false;
  let decodedBytes = 0;
  let usage: ResponseUsage = {};

  const discard = () => {
    disabled = true;
    pending = '';
    usage = {};
  };

  const parseData = (text: string) => {
    try {
      const payload = JSON.parse(text);
      const frames = Array.isArray(payload) ? payload : [payload];
      if (frames.some((frame) => frame?.error || frame?.response?.error || frame?.type === 'error')) {
        discard();
        return;
      }
      for (const frame of frames) {
        mergeStreamResponseUsage(usage, extractResponseUsage(frame));
      }
    } catch {
      /* Incomplete or non-JSON frames do not produce usage counts. */
    }
  };

  const consumeChunk = (chunk: unknown) => {
    if (disabled) return;
    if (!sseDetected) {
      const header = raw.getHeader('content-type') ?? reply.getHeader('content-type');
      if (isSseContentType(Array.isArray(header) ? header.join(', ') : String(header ?? ''))) {
        sseDetected = true;
      } else {
        return;
      }
    }
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? decoder.write(chunk)
        : chunk instanceof Uint8Array
          ? decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          : '';
    if (!text) return;
    decodedBytes += Buffer.byteLength(text);
    if (decodedBytes > DECODED_LIMIT) {
      discard();
      return;
    }
    pending += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      if (!skipping && Buffer.byteLength(event) <= MESSAGE_LIMIT) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') parseData(data);
      }
      skipping = false;
    }
    if (Buffer.byteLength(pending) > MESSAGE_LIMIT) {
      pending = pending.slice(-3);
      skipping = true;
    }
  };

  const originalWriteHead = raw.writeHead.bind(raw);
  raw.writeHead = ((statusCode: number, ...args: unknown[]) => {
    capturedStatus = statusCode;
    const headersArg = typeof args[0] === 'string' ? args[1] : args[0];
    const ct = headerValueFromArgs(headersArg, 'content-type')
      ?? String(raw.getHeader('content-type') ?? reply.getHeader('content-type') ?? '');
    if (isSseContentType(ct)) sseDetected = true;
    return (originalWriteHead as (...params: unknown[]) => http.ServerResponse)(statusCode, ...args);
  }) as typeof raw.writeHead;

  const originalWrite = raw.write.bind(raw);
  raw.write = ((chunk: unknown, ...args: unknown[]) => {
    try { consumeChunk(chunk); } catch { discard(); }
    return (originalWrite as (...params: unknown[]) => boolean)(chunk, ...args);
  }) as typeof raw.write;

  const originalEnd = raw.end.bind(raw);
  raw.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk !== undefined && typeof chunk !== 'function') {
      try { consumeChunk(chunk); } catch { discard(); }
    }
    return (originalEnd as (...params: unknown[]) => http.ServerResponse)(chunk, ...args);
  }) as typeof raw.end;

  return {
    isSse: () => sseDetected,
    statusCode: () => capturedStatus,
    finalize(success: boolean) {
      if (!success || disabled || !sseDetected) {
        discard();
        return;
      }
      pending += decoder.end();
      if (pending.trim() && !skipping && Buffer.byteLength(pending) <= MESSAGE_LIMIT) {
        const data = pending
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') parseData(data);
      }
      if (!disabled && !context.finished && Object.keys(usage).length > 0) {
        Object.assign(context, usage);
      }
      discard();
    },
    discard,
  };
}
