import { getServerConfig } from '../server/server-config';

export function safeLabel(value: unknown, fallback = 'unknown', privateValues: string[] = []): string {
  const config = getServerConfig();
  const secrets = [...privateValues, config?.api_key, config?.admin_api_key, ...(config?.projects ?? []).map((project) => project.api_key)];
  if (typeof value === 'string' && secrets.some((secret) => secret && value.includes(secret))) return fallback;
  return typeof value === 'string' && /^[\p{L}\p{N}_. @:+-]{1,100}$/u.test(value) ? value : fallback;
}

export function normalizedRoute(value: unknown): string {
  const path = typeof value === 'string' ? value.split('?')[0] : '';
  if (/^\/v1internal:(?:streamGenerateContent|generateContent|countTokens)$/.test(path)) return path;
  if (path === '/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent') return path;
  if (/^\/(?:v1|v1beta)\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(path)) return '/v1beta/models/:model:generateContent';
  return ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1/audio/transcriptions', '/v1/audio/translations', '/v1/audio/speech'].includes(path) ? path : 'other';
}

export function nullableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function errorCategory(status: number): string | null {
  if (status === 499) return 'client_cancelled';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'upstream_error';
  return status >= 400 ? 'request_error' : null;
}
