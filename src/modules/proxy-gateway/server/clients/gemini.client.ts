import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readForbiddenErrorBody, toGeminiUpstreamRequestError } from './upstream-error-classification';
import { UserProjectCapabilityCache } from './user-project-capability-cache';
import { hedgedStreamRequest } from './hedged-stream-request';
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from 'axios';
import { isObjectLike } from 'lodash-es';
import { GeminiRequest, GeminiResponse } from '../interfaces/request-interfaces';
import { GeminiInternalRequest } from '../../antigravity/types';
import { getServerConfig } from '../../../../server/server-config';
import { resolveRequestUserAgent } from '../request-user-agent';
import { throwIfUpstreamRequestCanceled, UpstreamRequestError } from './upstream-error';
import {
  getUpstreamDiagnosticContext,
  logUpstreamTerminalDiagnostic,
  registerUpstreamDiagnosticContext,
  type UpstreamDiagnosticContext,
} from '../cloudcode-diagnostics';

export function unwrapInternalGeminiResponse<T>(payload: T | { response: T }): T {
  if (isObjectLike(payload)) {
    const record = payload as Record<string, unknown>;
    if (Object.hasOwn(record, 'response') && isObjectLike(record.response)) {
      return record.response as T;
    }
  }

  return payload as T;
}

export { UserProjectCapabilityCache, DEFAULT_PROJECT_CAPABILITY_TTL_MS, type NegativeProjectCapabilitySnapshot } from './user-project-capability-cache';

@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  // Retained for callers that inspect the legacy cache; generation does not consult it.
  public readonly userProjectCapabilityCache = new UserProjectCapabilityCache();
  private preferredInternalBaseUrl?: string;
  private lastConfiguredBaseUrlsKey = '';

  // Default to v1beta for most features
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly defaultInternalBaseUrls = [
    'https://daily-cloudcode-pa.googleapis.com/v1internal',
    'https://cloudcode-pa.googleapis.com/v1internal',
  ];
  async streamGenerate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string, signal?: AbortSignal,
  ): Promise<NodeJS.ReadableStream> {
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);

    try {
      const response = await axios.post(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 60000,
        proxy: axiosProxy, signal,
      });
      return response.data;
    } catch (error) {
      throwIfUpstreamRequestCanceled(error, signal);
      if (axios.isAxiosError(error)) {
        await readForbiddenErrorBody(error, signal);
        throwIfUpstreamRequestCanceled(error, signal);
        const upstreamError = toGeminiUpstreamRequestError(error);
        this.logUpstreamFailure('stream_generate', upstreamError);
        throw upstreamError;
      }
      this.throwAsCleanError(error);
    }
  }

  async generate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string, signal?: AbortSignal,
  ): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);

    try {
      const response = await axios.post<GeminiResponse>(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000, // 60s timeout
        proxy: axiosProxy, signal,
      });
      return response.data;
    } catch (error) {
      throwIfUpstreamRequestCanceled(error, signal);
      if (axios.isAxiosError(error)) {
        await readForbiddenErrorBody(error, signal);
        throwIfUpstreamRequestCanceled(error, signal);
        const upstreamError = toGeminiUpstreamRequestError(error);
        this.logUpstreamFailure('generate', upstreamError);
        throw upstreamError;
      }
      this.throwAsCleanError(error);
    }
  }
  // --- Internal Gateway API Support ---
  async streamGenerateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string }, signal?: AbortSignal,
  ): Promise<NodeJS.ReadableStream> {
    const response = await this.executeRequestWithEndpointFailover<NodeJS.ReadableStream>(
      ':streamGenerateContent?alt=sse',
      body,
      accessToken,
      upstreamProxyUrl,
      {
        responseType: 'stream',
      },
      'stream-generate',
      extraHeaders,
      accountKeyOrOptions, signal,
    );

    return response.data;
  }

  async generateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string }, signal?: AbortSignal,
  ): Promise<GeminiResponse> {
    const response = await this.executeRequestWithEndpointFailover<
      GeminiResponse | { response: GeminiResponse }
    >(
      ':generateContent',
      body,
      accessToken,
      upstreamProxyUrl,
      {},
      'generate-content',
      extraHeaders,
      accountKeyOrOptions, signal,
    );
    const result = unwrapInternalGeminiResponse(response.data);
    const diagnostics = getUpstreamDiagnosticContext(response.data);
    if (diagnostics) registerUpstreamDiagnosticContext(result, diagnostics);
    logUpstreamTerminalDiagnostic(diagnostics, 'terminal', result?.candidates?.[0]?.finishReason);
    return result;
  }

  getOrderedInternalBaseUrls(): string[] {
    const configuredBaseUrls = this.getInternalBaseUrls();
    const configKey = configuredBaseUrls.join('|');

    if (this.lastConfiguredBaseUrlsKey !== configKey) {
      this.preferredInternalBaseUrl = undefined;
      this.lastConfiguredBaseUrlsKey = configKey;
    }

    if (configuredBaseUrls.length <= 1) {
      return configuredBaseUrls;
    }

    if (
      this.preferredInternalBaseUrl &&
      configuredBaseUrls.includes(this.preferredInternalBaseUrl)
    ) {
      return [
        this.preferredInternalBaseUrl,
        ...configuredBaseUrls.filter((url) => url !== this.preferredInternalBaseUrl),
      ];
    }

    return configuredBaseUrls;
  }

  resetPreferredEndpoint(): void {
    this.preferredInternalBaseUrl = undefined;
    this.lastConfiguredBaseUrlsKey = '';
  }

  private getInternalBaseUrls(): string[] {
    const fromEnv =
      process.env.PROXY_INTERNAL_BASE_URLS ?? process.env.ANTIGRAVITY_INTERNAL_BASE_URLS;
    const configuredBaseUrls = fromEnv
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (configuredBaseUrls && configuredBaseUrls.length > 0) {
      return configuredBaseUrls.map((url) => url.replace(/\/+$/, ''));
    }

    return this.defaultInternalBaseUrls.map((url) => url.replace(/\/+$/, ''));
  }

  private getInternalTimeoutMs(): number {
    const config = getServerConfig();
    const timeoutSeconds = config?.request_timeout ?? 300;
    return Math.max(1, timeoutSeconds) * 1000;
  }

  private shouldFailoverToNextEndpoint(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    if (!error.response) {
      return true;
    }

    const status = error.response.status;

    // Permanent auth errors and ordinary client errors should not rotate endpoints.
    if (status === 400 || status === 401 || status === 403) {
      return false;
    }

    // 499 is Google's client-cancelled code emitted for upstream aborts.
    return status === 408 || status === 429 || status === 499 || status >= 500;
  }

  private async executeRequestWithEndpointFailover<T>(
    path: string,
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    config: AxiosRequestConfig,
    operation: string,
    extraHeaders?: Record<string, string>,
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string }, signal?: AbortSignal,
  ): Promise<AxiosResponse<T>> {
    const diagnostics: UpstreamDiagnosticContext = { requestId: randomUUID() };
    logUpstreamTerminalDiagnostic(diagnostics, 'start');
    // Project is native body metadata; do not synthesize quota-project headers or strip it.
    void accountKeyOrOptions;
    const baseUrls = this.getOrderedInternalBaseUrls();
    const timeout = this.getInternalTimeoutMs();
    const requestUserAgent = await resolveRequestUserAgent();
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    const requestBody = JSON.stringify(body);
    const requestSignal = signal ?? config.signal;
    const request = (index: number, attemptSignal = requestSignal) => axios.post<T>(
      `${baseUrls[index]}${path}`, requestBody, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': requestUserAgent,
          ...(extraHeaders ?? {}),
        },
        timeout,
        proxy: axiosProxy,
        ...config,
        signal: attemptSignal,
      },
    );
    const accept = (response: AxiosResponse<T>, index: number) => {
      diagnostics.httpStatus = response.status;
      registerUpstreamDiagnosticContext(response.data, diagnostics);
      logUpstreamTerminalDiagnostic(diagnostics, 'http_response');
      this.preferredInternalBaseUrl = baseUrls[index];
      return response;
    };
    const fail = async (error: unknown): Promise<never> => {
      throwIfUpstreamRequestCanceled(error, requestSignal);
      diagnostics.httpStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
      logUpstreamTerminalDiagnostic(diagnostics, 'failure');
      return this.throwUpstreamRequestError(error, operation, requestSignal);
    };

    if (config.responseType === 'stream') {
      try {
        const { response, index } = await hedgedStreamRequest({
          request,
          endpointCount: baseUrls.length,
          shouldRetry: (error) => this.shouldFailoverToNextEndpoint(error),
          signal: requestSignal,
        });
        return accept(response, index);
      } catch (error) {
        return fail(error);
      }
    }

    for (let index = 0; index < baseUrls.length; index++) {
      try {
        return accept(await request(index), index);
      } catch (error) {
        throwIfUpstreamRequestCanceled(error, requestSignal);
        if (index === baseUrls.length - 1 || !this.shouldFailoverToNextEndpoint(error)) {
          return fail(error);
        }
        diagnostics.httpStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
        logUpstreamTerminalDiagnostic(diagnostics, 'failure');
        this.logger.warn(
          `[${operation}] upstream_endpoint_retry attempt=${index + 2} total=${baseUrls.length}`,
        );
      }
    }
    return fail(undefined);
  }

  private async throwUpstreamRequestError(error: unknown, operation: string, signal?: AxiosRequestConfig['signal']): Promise<never> {
    if (axios.isAxiosError(error)) {
      await readForbiddenErrorBody(error, signal);
      if (error.response?.data instanceof Readable) error.response.data.destroy();
      throwIfUpstreamRequestCanceled(error, signal);
      const upstreamError = toGeminiUpstreamRequestError(error);
      this.logUpstreamFailure(operation, upstreamError);
      throw upstreamError;
    }
    this.throwAsCleanError(error);
  }

  private logUpstreamFailure(operation: string, error: UpstreamRequestError): void {
    this.logger.error(
      `[${operation}] upstream_request_failed status=${error.status ?? 'none'} reason=${error.reason}`,
    );
  }

  private resolveUpstreamAxiosProxy(
    upstreamProxyUrl?: string,
  ): AxiosProxyConfig | false | undefined {
    const config = getServerConfig();
    const configuredProxyUrl =
      upstreamProxyUrl ||
      (config?.upstream_proxy?.enabled && config.upstream_proxy.url
        ? config.upstream_proxy.url
        : '');

    if (!configuredProxyUrl) {
      return undefined;
    }

    try {
      const parsed = new URL(configuredProxyUrl);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

      const proxyConfig: AxiosProxyConfig = {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port,
      };

      if (parsed.username || parsed.password) {
        proxyConfig.auth = {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        };
      }

      return proxyConfig;
    } catch {
      this.logger.warn('Upstream proxy configuration is invalid: category=invalid_url');
      return undefined;
    }
  }

  private throwAsCleanError(_error: unknown): never {
    throw new UpstreamRequestError({ reason: 'transport' });
  }
}
