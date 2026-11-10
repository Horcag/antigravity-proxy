import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { extractResponseUsage, getRequestObservation, type ResponseUsage } from './request-context';

const MESSAGE_LIMIT = 64 * 1024;
const DECODED_LIMIT = 16 * 1024 * 1024;

/** Числовая статистика из копии потока; исходные байты передаются без изменений. */
export function createNativeResponseUsage(contentType: string | undefined, encoding: string | undefined) {
  const context = getRequestObservation();
  const mediaType = contentType?.toLowerCase();
  const sse = mediaType?.includes('text/event-stream');
  const json = !mediaType || mediaType.includes('application/json');
  const decoder = new StringDecoder('utf8');
  const compression = encoding?.toLowerCase().trim();
  const inflater = compression === 'gzip' || compression === 'x-gzip' ? createGunzip()
    : compression === 'deflate' ? createInflate() : compression === 'br' ? createBrotliDecompress() : undefined;
  let disabled = !context || (!sse && !json) || Boolean(compression && compression !== 'identity' && !inflater);
  let pending = '', skipping = false, decodedBytes = 0;
  let usage: ResponseUsage = {};
  const discard = () => { disabled = true; pending = ''; usage = {}; inflater?.destroy(); };
  const parse = (text: string) => {
    try {
      const payload = JSON.parse(text);
      const frames = Array.isArray(payload) ? payload : [payload];
      if (frames.some(frame => frame?.error || frame?.response?.error)) { discard(); return; }
      for (const frame of frames) Object.assign(usage, extractResponseUsage(frame));
    } catch { /* Неполный или неподдерживаемый формат не даёт измерений. */ }
  };
  const consume = (chunk: Buffer) => {
    if (disabled) return;
    decodedBytes += chunk.length;
    if (decodedBytes > DECODED_LIMIT) { discard(); return; }
    for (let offset = 0; offset < chunk.length; offset += 8192) {
      pending += decoder.write(chunk.subarray(offset, offset + 8192));
      if (sse) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const event = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          if (!skipping && Buffer.byteLength(event) <= MESSAGE_LIMIT) {
            const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data !== '[DONE]') parse(data);
          }
          skipping = false;
        }
        if (Buffer.byteLength(pending) > MESSAGE_LIMIT) { pending = pending.slice(-3); skipping = true; }
      } else if (Buffer.byteLength(pending) > MESSAGE_LIMIT) { discard(); return; }
    }
  };
  inflater?.on('data', consume);
  inflater?.on('error', discard);
  return {
    supportedFormat: Boolean((sse || json) && (!compression || compression === 'identity' || inflater)),
    write(chunk: Buffer) {
      if (disabled) return;
      try {
        if (!inflater) consume(chunk);
        else {
          inflater.write(chunk);
          if (inflater.writableLength > MESSAGE_LIMIT) discard();
        }
      } catch { discard(); }
    },
    async finish(success: boolean) {
      if (!success || disabled) { discard(); return; }
      if (inflater) await new Promise<void>((resolve) => {
        const settle = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { discard(); settle(); }, 50);
        inflater.once('end', settle); inflater.once('close', settle); inflater.once('error', settle);
        try { inflater.end(); } catch { discard(); settle(); }
      });
      if (!disabled) {
        pending += decoder.end();
        if (json) parse(pending);
        if (context && !context.finished) Object.assign(context, usage);
      }
      discard();
    },
    discard,
  };
}
