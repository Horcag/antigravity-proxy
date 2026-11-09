import { isStrictAuthenticationFailure } from '@/modules/cloud-account/services/strict-authentication-classifier';

export interface ProxyUpstreamFailureClassification {
  retry: boolean;
  markAsForbidden: boolean;
  markAsRateLimited: boolean;
}

export function classifyProxyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
  const normalizedErrorMessage = errorMessage.toLowerCase();
  if (isStrictAuthenticationFailure(errorMessage)) {
    return {
      retry: true,
      markAsForbidden: true,
      markAsRateLimited: false,
    };
  }
  const isRateLimitedSignal =
    normalizedErrorMessage.includes('429') ||
    normalizedErrorMessage.includes('resource_exhausted') ||
    normalizedErrorMessage.includes('quota') ||
    normalizedErrorMessage.includes('rate_limit') ||
    normalizedErrorMessage.includes('rate limit');
  const shouldRetryByStatus =
    normalizedErrorMessage.includes('408') ||
    normalizedErrorMessage.includes('429') ||
    normalizedErrorMessage.includes('500') ||
    normalizedErrorMessage.includes('502') ||
    normalizedErrorMessage.includes('503') ||
    normalizedErrorMessage.includes('504');
  const shouldRetryByKeyword =
    normalizedErrorMessage.includes('resource_exhausted') ||
    normalizedErrorMessage.includes('quota') ||
    normalizedErrorMessage.includes('rate_limit') ||
    normalizedErrorMessage.includes('timeout') ||
    normalizedErrorMessage.includes('socket hang up') ||
    normalizedErrorMessage.includes('empty response stream') ||
    normalizedErrorMessage.includes('connection reset');
  if (shouldRetryByStatus || shouldRetryByKeyword) {
    return {
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: isRateLimitedSignal,
    };
  }
  return {
    retry: false,
    markAsForbidden: false,
    markAsRateLimited: false,
  };
}
