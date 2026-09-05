const AI_CREDITS_AUTHENTICATION_ERROR_MESSAGE = 'AI credits authentication failed';

export class AICreditsAuthenticationError extends Error {
  constructor() {
    super(AI_CREDITS_AUTHENTICATION_ERROR_MESSAGE);
    this.name = 'AICreditsAuthenticationError';
  }
}

export function isAICreditsAuthenticationError(
  error: unknown,
): error is AICreditsAuthenticationError {
  return error instanceof AICreditsAuthenticationError;
}
