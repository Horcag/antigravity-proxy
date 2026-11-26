import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';
import {
  formatSafeUpstreamErrorDetail,
  readUpstreamErrorBody,
  toGeminiUpstreamRequestError,
} from '@/modules/proxy-gateway/server/clients/upstream-error-classification';

function makeAxiosStreamError(
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): AxiosError {
  const error = new Error(`Request failed with status code ${status}`) as AxiosError;
  error.isAxiosError = true;
  error.response = {
    status,
    statusText: 'Error',
    headers,
    config: {} as never,
    data: Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]),
  };
  return error;
}

describe('readUpstreamErrorBody & formatSafeUpstreamErrorDetail', () => {
  it('reads 429 stream bodies so quota exhaustion is classified instead of dropped', async () => {
    const error = makeAxiosStreamError(
      429,
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for quota metric and limit.',
        },
      }),
    );

    await readUpstreamErrorBody(error);
    const classified = toGeminiUpstreamRequestError(error);

    expect(classified.status).toBe(429);
    expect(classified.reason).toBe('quota_exhausted');
    const detail = formatSafeUpstreamErrorDetail(error);
    expect(detail).toContain('[google.quota.exhausted]');
    expect(detail).toContain('RESOURCE_EXHAUSTED');
    expect(detail).not.toContain('Quota exceeded');
  });

  it('decodes gzip-compressed 429 stream bodies and never leaks raw upstream text or tokens', async () => {
    const compressed = gzipSync(
      Buffer.from(
        JSON.stringify({
          error: {
            status: 'RESOURCE_EXHAUSTED',
            message: 'Rate limit Bearer ya29.secret_token_123456 exceeded',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'RATE_LIMIT_EXCEEDED',
              },
            ],
          },
        }),
      ),
    );
    const error = makeAxiosStreamError(429, compressed, { 'content-encoding': 'gzip' });

    await readUpstreamErrorBody(error);
    const detail = formatSafeUpstreamErrorDetail(error);

    expect(detail).toContain('RATE_LIMIT_EXCEEDED');
    expect(detail).not.toContain('ya29.secret_token_123456');
    expect(detail).not.toContain('Rate limit');
  });

  it('leaves non-error (<400) streams untouched (negative control)', async () => {
    const stream = Readable.from([Buffer.from('ok')]);
    const error = new Error('not an error') as AxiosError;
    error.isAxiosError = true;
    error.response = {
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as never,
      data: stream,
    };

    await readUpstreamErrorBody(error);

    expect(error.response.data).toBe(stream);
    expect(formatSafeUpstreamErrorDetail(error)).toBeUndefined();
  });
});
