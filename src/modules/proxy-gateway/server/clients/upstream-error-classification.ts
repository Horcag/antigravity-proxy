import type { AxiosError } from 'axios';
import { Readable } from 'node:stream';
import { isObjectLike, isString } from 'lodash-es';
import { classifyUpstreamFailure } from '../upstream-failure';
import type { UpstreamRequestError } from './upstream-error';

export async function readForbiddenErrorBody(error: AxiosError): Promise<void> {
  const response = error.response;
  if (response?.status !== 403 || !(response.data instanceof Readable)) return;
  const stream = response.data;
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
    stream.destroy();
  }
  response.data = Buffer.concat(chunks);
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
