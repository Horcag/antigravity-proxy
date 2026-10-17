import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { Readable } from 'node:stream';
import { isAccountSuspended } from '../account-suspension';
import { throwIfUpstreamRequestCanceled, UpstreamRequestError } from './upstream-error';

const INSPECTION_BYTES = 64 * 1024;
const INSPECTION_TIMEOUT_MS = 2000;

function classificationText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, INSPECTION_BYTES);
  if (Buffer.isBuffer(value)) return value.subarray(0, INSPECTION_BYTES).toString('utf8');
  if (!value || typeof value !== 'object') return '';
  try { return JSON.stringify(value).slice(0, INSPECTION_BYTES); }
  catch { return ''; }
}

/** Read only rejected 403 bodies, before project retry or public-safe sanitization. */
export async function inspectSuspensionResponse(error: unknown, signal?: AxiosRequestConfig['signal']): Promise<void> {
  throwIfUpstreamRequestCanceled(error, signal);
  if (!axios.isAxiosError(error) || error.response?.status !== 403 || !(error.response.data instanceof Readable)) return;
  const stream = error.response.data;
  error.response.data = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', data); stream.off('end', finish); stream.off('close', finish); stream.off('error', finish);
      signal?.removeEventListener?.('abort', finish);
      stream.destroy();
      resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const part = bytes.subarray(0, INSPECTION_BYTES - size);
      chunks.push(part); size += part.length;
      if (size >= INSPECTION_BYTES) finish();
    };
    const timer = setTimeout(finish, INSPECTION_TIMEOUT_MS);
    stream.on('data', data); stream.once('end', finish); stream.once('close', finish); stream.once('error', finish);
    signal?.addEventListener?.('abort', finish, { once: true });
    if (stream.destroyed || stream.readableEnded || signal?.aborted) finish();
  });
  throwIfUpstreamRequestCanceled(error, signal);
}

export function isSuspendedAxiosResponse(error: unknown): boolean {
  return axios.isAxiosError(error) && isAccountSuspended(error.response?.status, classificationText(error.response?.data));
}

export function toGeminiUpstreamError(error: AxiosError): UpstreamRequestError {
  const status = error.response?.status;
  const text = classificationText(error.response?.data).toLowerCase();
  let reason: UpstreamRequestError['reason'] = 'upstream_error';
  if (isAccountSuspended(status, text)) reason = 'account_suspended';
  else if (status === 401 || status === 403) reason = 'authentication';
  else if (status === 404) reason = 'model_not_found';
  else if (text.includes('quota')) reason = 'quota_exhausted';
  else if (status === 429 || text.includes('resource_exhausted')) reason = 'rate_limited';
  else if (status === undefined && /timeout|socket|connect|network|reset/i.test(error.message)) reason = 'transport';
  const value = Object.entries(error.response?.headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  const retryAfter = Array.isArray(value) ? value[0] : value;
  return new UpstreamRequestError({ status, reason, headers: { retryAfter: typeof retryAfter === 'string' ? retryAfter.trim() : undefined } });
}
