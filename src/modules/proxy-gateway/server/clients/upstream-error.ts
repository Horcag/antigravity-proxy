import { isNumber, isObjectLike, isString } from 'lodash-es';
import axios, { AxiosRequestConfig } from 'axios';

export function getUpstreamRequestCancellation(error: unknown, signal?: AxiosRequestConfig['signal']): Error | undefined {
  if (signal?.aborted || axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError')) {
    // Axios errors retain request headers and credentials; preserve only cancellation identity.
    const canceled = new Error('Upstream request canceled');
    canceled.name = 'AbortError';
    return canceled;
  }
  return undefined;
}

export function throwIfUpstreamRequestCanceled(error: unknown, signal?: AxiosRequestConfig['signal']): void {
  const canceled = getUpstreamRequestCancellation(error, signal);
  if (canceled) throw canceled;
}

export interface UpstreamErrorHeaders {
  retryAfter?: string;
}

export const UPSTREAM_FAILURE_REASONS = [
  'authentication',
  'tos_violation',
  'model_not_found',
  'quota_exhausted',
  'rate_limited',
  'transport',
  'upstream_error',
] as const;

export type UpstreamFailureReason = (typeof UPSTREAM_FAILURE_REASONS)[number];

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/**
 * Carries only public-safe upstream failure metadata across retry and protocol
 * boundaries. Raw upstream payloads and messages must be classified before
 * constructing this error, then discarded.
 */
export class UpstreamRequestError extends Error {
  readonly status?: number;
  readonly headers?: UpstreamErrorHeaders;
  readonly reason: UpstreamFailureReason;

  constructor(params: {
    status?: number;
    headers?: UpstreamErrorHeaders;
    reason?: UpstreamFailureReason;
  }) {
    if (params.status !== undefined && (!isNumber(params.status) || !Number.isInteger(params.status))) {
      throw new TypeError('status must be an integer');
    }
    if (params.headers !== undefined && !isObjectLike(params.headers)) {
      throw new TypeError('headers must be an object');
    }
    if (
      params.reason !== undefined &&
      !UPSTREAM_FAILURE_REASONS.includes(params.reason)
    ) {
      throw new TypeError('reason must be a supported upstream failure reason');
    }

    const status = params.status;
    super(status === undefined ? 'Upstream request failed' : `Upstream request failed (HTTP ${status})`);
    this.name = 'UpstreamRequestError';
    this.status = status;
    this.reason = params.reason ?? 'upstream_error';

    const retryAfter = normalizeRetryAfter(params.headers?.retryAfter);
    this.headers = retryAfter ? { retryAfter } : undefined;
  }
}

function normalizeRetryAfter(value: unknown): string | undefined {
  if (!isString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  if (/^\d{1,5}$/.test(normalized)) {
    const seconds = Number(normalized);
    if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS) {
      return String(seconds);
    }
  }

  if (!isImfFixdate(normalized)) {
    return undefined;
  }

  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }

  const canonical = new Date(retryAt).toUTCString();
  return canonical === normalized ? canonical : undefined;
}

function isImfFixdate(value: string): boolean {
  return /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
    value,
  );
}
