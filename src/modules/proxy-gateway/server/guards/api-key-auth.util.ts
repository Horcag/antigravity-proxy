import { timingSafeEqual } from 'node:crypto';
import { isEmpty, isString } from 'lodash-es';
import type { ProxyConfig } from '../../../config/types';

type ProxyApiKeyConfig = Pick<ProxyConfig, 'api_key' | 'projects'> | null | undefined;

export interface ApiProjectIdentity {
  id: string;
  name: string;
}

export function isProxyApiKeyConfigured(config: ProxyApiKeyConfig): boolean {
  return hasConfiguredApiKey(config?.api_key) ||
    (config?.projects ?? []).some((project) => hasConfiguredApiKey(project.api_key));
}

export function resolveApiProject(config: ProxyApiKeyConfig, token: string | null): ApiProjectIdentity | null {
  const matches = (config?.projects ?? []).filter((project) => hasMatchingApiKey(token, project.api_key));
  const project = matches[0];
  if (matches.length !== 1 || !project?.enabled ||
    (hasConfiguredApiKey(config?.api_key) && hasMatchingApiKey(token, config.api_key))) {
    return null;
  }
  return { id: project.id, name: project.name };
}

export function hasMatchingProxyApiKey(config: ProxyApiKeyConfig, token: string | null): boolean {
  if ((config?.projects ?? []).some((project) => hasMatchingApiKey(token, project.api_key))) {
    return resolveApiProject(config, token) !== null;
  }
  return hasConfiguredApiKey(config?.api_key) && hasMatchingApiKey(token, config.api_key);
}

export type RequestHeaderValue = string | string[] | undefined;

export type RequestHeaders = Record<string, RequestHeaderValue>;

export function hasConfiguredApiKey(apiKey: string | undefined): apiKey is string {
  return isString(apiKey) && !isEmpty(apiKey.trim());
}

export function hasMatchingApiKey(clientToken: string | null, apiKey: string): boolean {
  if (!clientToken) {
    return false;
  }

  const clientTokenBuffer = Buffer.from(clientToken);
  const apiKeyBuffer = Buffer.from(apiKey);
  return (
    clientTokenBuffer.length === apiKeyBuffer.length &&
    timingSafeEqual(clientTokenBuffer, apiKeyBuffer)
  );
}

export function extractApiKeyToken(headers: RequestHeaders): string | null {
  const authorizationHeader = readHeaderValue(headers['authorization']);
  if (authorizationHeader) {
    const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);
    if (rest.length === 0 && token && scheme?.toLowerCase() === 'bearer') {
      return token;
    }
  }

  const xApiKeyHeader = readHeaderValue(headers['x-api-key']);
  if (xApiKeyHeader) {
    return xApiKeyHeader;
  }

  const xGoogApiKeyHeader = readHeaderValue(headers['x-goog-api-key']);
  if (xGoogApiKeyHeader) {
    return xGoogApiKeyHeader;
  }

  return null;
}

function readHeaderValue(headerValue: RequestHeaderValue): string | null {
  if (isString(headerValue)) {
    const trimmedValue = headerValue.trim();
    return !isEmpty(trimmedValue) ? trimmedValue : null;
  }

  if (Array.isArray(headerValue)) {
    for (const value of headerValue) {
      if (isString(value)) {
        const trimmedValue = value.trim();
        if (!isEmpty(trimmedValue)) {
          return trimmedValue;
        }
      }
    }
  }

  return null;
}
