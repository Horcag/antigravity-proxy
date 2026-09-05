const NORMALIZED_AUTHENTICATION_FAILURE_MESSAGES = new Set([
  'HTTP 401',
  'HTTP 403',
  'UNAUTHORIZED',
  'FORBIDDEN',
]);

function hasAuthenticationStatus(error: object): boolean {
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  return [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
    candidate.response?.statusCode,
  ].some((status) => status === 401 || status === 403);
}

export function isStrictAuthenticationFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && hasAuthenticationStatus(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : error;
  return (
    typeof message === 'string' &&
    NORMALIZED_AUTHENTICATION_FAILURE_MESSAGES.has(message.trim().toUpperCase())
  );
}
