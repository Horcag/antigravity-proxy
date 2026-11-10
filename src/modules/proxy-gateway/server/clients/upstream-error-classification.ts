import type { AxiosError, AxiosRequestConfig } from 'axios';
import { Readable } from 'node:stream';
import { isObjectLike, isString } from 'lodash-es';
import { classifyUpstreamFailure } from '../upstream-failure';
import { throwIfUpstreamRequestCanceled, UpstreamRequestError } from './upstream-error';

export async function readForbiddenErrorBody(error: AxiosError, signal?: AxiosRequestConfig['signal']): Promise<void> {
  throwIfUpstreamRequestCanceled(error, signal);
  const response = error.response;
  if (response?.status !== 403 || !(response.data instanceof Readable)) return;
  const stream = response.data;
  const onAbort = () => { stream.destroy(); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Bound both the error payload and time spent inspecting a rejected stream.
  const timer = setTimeout(() => stream.destroy(new Error('Error body timeout')), 1000);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer.subarray(0, 65536 - bytes));
      bytes += Math.min(buffer.length, 65536 - bytes);
      if (bytes >= 65536) break;
    }
  } catch { /* Classify the available prefix without retaining the transport error. */ }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    stream.destroy();
  }
  response.data = Buffer.concat(chunks);
  throwIfUpstreamRequestCanceled(error, signal);
}

export function classifyAxiosFailure(
  status: number | undefined,
  responseData: unknown,
  transportMessage: string,
): UpstreamRequestError['reason'] {
  if (status === 403 && classifyUpstreamFailure({
    statusCode: status,
    headers: {},
    errorText: toClassificationText(responseData),
  }).ruleId === 'google.tos.violation') {
    return 'tos_violation';
  }
  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 404) {
    return 'model_not_found';
  }

  const classificationText = toClassificationText(responseData).toLowerCase();
  if (classificationText.includes('quota')) {
    return 'quota_exhausted';
  }
  if (status === 429 || classificationText.includes('resource_exhausted')) {
    return 'rate_limited';
  }
  if (status === undefined && /timeout|socket|connect|network|reset/i.test(transportMessage)) {
    return 'transport';
  }
  return 'upstream_error';
}

function toClassificationText(value: unknown): string {
  if (isString(value)) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf-8');
  }
  if (!isObjectLike(value)) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function toGeminiUpstreamRequestError(error: AxiosError): UpstreamRequestError {
  const status = error.response?.status;
  return new UpstreamRequestError({
    status,
    headers: { retryAfter: extractRetryAfterHeader(error.response?.headers) },
    reason: classifyAxiosFailure(status, error.response?.data, error.message),
  });
}

function extractRetryAfterHeader(headers: unknown): string | undefined {
  if (!isObjectLike(headers)) {
    return undefined;
  }

  const retryAfter = Object.entries(headers as Record<string, unknown>).find(
    ([name]) => name.toLowerCase() === 'retry-after',
  )?.[1];
  if (isString(retryAfter)) {
    return retryAfter.trim();
  }
  if (Array.isArray(retryAfter) && retryAfter.length > 0) {
    const first = retryAfter[0];
    if (isString(first)) {
      return first.trim();
    }
  }
  return undefined;
}
