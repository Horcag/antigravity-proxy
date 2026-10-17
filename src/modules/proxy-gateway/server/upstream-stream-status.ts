import { isAccountSuspended } from './account-suspension';
import type { UpstreamRequestError } from './clients/upstream-error';
import { HttpStatus } from '@nestjs/common';

export const UPSTREAM_STREAM_STATUS_CODES: Readonly<Record<string, HttpStatus>> = {
  DEADLINE_EXCEEDED: HttpStatus.REQUEST_TIMEOUT,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
  PERMISSION_DENIED: HttpStatus.FORBIDDEN,
  RESOURCE_EXHAUSTED: HttpStatus.TOO_MANY_REQUESTS,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

export function resolveUpstreamStreamFailureReason(status: number | undefined, message: unknown): UpstreamRequestError['reason'] {
  if (typeof message === 'string' && isAccountSuspended(status, message)) return 'account_suspended';
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) return 'authentication';
  if (status === HttpStatus.NOT_FOUND) return 'model_not_found';
  if (status === HttpStatus.TOO_MANY_REQUESTS) return 'rate_limited';
  return 'upstream_error';
}
