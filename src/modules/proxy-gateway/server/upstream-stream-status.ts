import { classifyAxiosFailure } from './clients/upstream-error-classification';
import type { UpstreamFailureReason } from './clients/upstream-error';
import { HttpStatus } from '@nestjs/common';

export const UPSTREAM_STREAM_STATUS_CODES: Readonly<Record<string, HttpStatus>> = {
  DEADLINE_EXCEEDED: HttpStatus.REQUEST_TIMEOUT,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
  PERMISSION_DENIED: HttpStatus.FORBIDDEN,
  RESOURCE_EXHAUSTED: HttpStatus.TOO_MANY_REQUESTS,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

/** Сохраняет точную ToS-причину до удаления исходного error envelope. */
export function resolveUpstreamStreamFailureReason(status: number | undefined, payload: unknown): UpstreamFailureReason {
  if (classifyAxiosFailure(status, payload, '') === 'tos_violation') return 'tos_violation';
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) return 'authentication';
  if (status === HttpStatus.NOT_FOUND) return 'model_not_found';
  if (status === HttpStatus.TOO_MANY_REQUESTS) return 'rate_limited';
  return 'upstream_error';
}
