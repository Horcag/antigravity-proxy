import { randomUUID } from 'node:crypto';
import { classifyAxiosFailure, readForbiddenErrorBody } from './upstream-error-classification';
import { UserProjectCapabilityCache } from './user-project-capability-cache';
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from 'axios';
import { isObjectLike, isString } from 'lodash-es';
import { Readable } from 'node:stream';
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
const PROJECT_HEADER_ATTEMPT_COUNT = 2;

@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
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
        await readForbiddenErrorBody(error);
        const upstreamError = this.toUpstreamRequestError(error);
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
        await readForbiddenErrorBody(error);
        const upstreamError = this.toUpstreamRequestError(error);
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

  private resolveAccountKey(
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string },
  ): string {
    if (typeof accountKeyOrOptions === 'string') {
      return accountKeyOrOptions.trim();
    }
    return (accountKeyOrOptions?.accountKey ?? accountKeyOrOptions?.accountId ?? '').trim();
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
    const safeProject = body.project?.trim();
    const safeAccount = this.resolveAccountKey(accountKeyOrOptions);
    const hasKnownNegativeCapability = Boolean(
      safeProject &&
        this.userProjectCapabilityCache.hasNegativeCapability(safeAccount, safeProject),
    );
    let hasTriggeredProjectHeaderDowngrade = hasKnownNegativeCapability;

    const baseUrls = this.getOrderedInternalBaseUrls();
    const timeout = this.getInternalTimeoutMs();
    const requestUserAgent = await resolveRequestUserAgent();
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    let lastError: unknown = null;

    for (
      let projectHeaderAttempt = 0;
      projectHeaderAttempt < PROJECT_HEADER_ATTEMPT_COUNT;
      projectHeaderAttempt++
    ) {
      let shouldRetryWithoutProjectHeader = false;
      const projectHeaders = hasTriggeredProjectHeaderDowngrade
        ? {}
        : this.createProjectHeaders(body);
      const requestBody = hasTriggeredProjectHeaderDowngrade
        ? this.createProjectlessRequestBody(body)
        : body;

      for (let index = 0; index < baseUrls.length; index++) {
        const baseUrl = baseUrls[index];
        const url = `${baseUrl}${path}`;

        try {
          const response = await axios.post<T>(url, this.createInternalRequestBody(path, requestBody), {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': requestUserAgent,
              ...projectHeaders,
              ...(extraHeaders ?? {}),
            },
            timeout,
            proxy: axiosProxy,
            ...config,
            signal: signal ?? config.signal,
          });

          diagnostics.httpStatus = response.status;
          registerUpstreamDiagnosticContext(response.data, diagnostics);
          logUpstreamTerminalDiagnostic(diagnostics, 'http_response');
          this.preferredInternalBaseUrl = baseUrl;
          if (Boolean(projectHeaders['x-goog-user-project']) && safeProject) {
            this.userProjectCapabilityCache.clearNegativeCapability(safeAccount, safeProject);
          }
          return response;
        } catch (error) {
          throwIfUpstreamRequestCanceled(error, signal ?? config.signal);
          diagnostics.httpStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
          logUpstreamTerminalDiagnostic(diagnostics, 'failure');
          if (axios.isAxiosError(error)) await readForbiddenErrorBody(error);
          lastError = error;

          if (this.shouldRetryWithoutProjectHeader(error, projectHeaders)) {
            this.logger.warn(
              `[${operation}] project_context_rejected status=403 action=retry_without_project`,
            );
            if (safeProject) {
              this.userProjectCapabilityCache.recordNegativeCapability(safeAccount, safeProject);
            }
            hasTriggeredProjectHeaderDowngrade = true;
            shouldRetryWithoutProjectHeader = true;
            break;
          }

          const hasNextEndpoint = index < baseUrls.length - 1;

          if (!hasNextEndpoint || !this.shouldFailoverToNextEndpoint(error)) {
            await this.throwUpstreamRequestError(error, operation);
          }

          this.logger.warn(
            `[${operation}] upstream_endpoint_retry attempt=${index + 2} total=${baseUrls.length}`,
          );
        }
      }

      if (shouldRetryWithoutProjectHeader) {
        continue;
      }

      return await this.throwUpstreamRequestError(lastError, operation);
    }

    return await this.throwUpstreamRequestError(lastError, operation);
  }

  private createInternalRequestBody(path: string, body: GeminiInternalRequest): string | Readable {
    const bodyText = JSON.stringify(body);
    if (path.startsWith(':streamGenerateContent')) {
      return Readable.from([bodyText]);
    }

    return bodyText;
  }

  private createProjectlessRequestBody(body: GeminiInternalRequest): GeminiInternalRequest {
    const projectlessBody = { ...body };
    delete projectlessBody.project;
    return projectlessBody;
  }

  private createProjectHeaders(body: GeminiInternalRequest): Record<string, string> {
    const project = body.project?.trim();
    if (!project) {
      return {};
    }

    return {
      'x-goog-user-project': project,
    };
  }

  private shouldRetryWithoutProjectHeader(
    error: unknown,
    projectHeaders: Record<string, string>,
  ): boolean {
    return (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      classifyAxiosFailure(403, error.response.data, error.message) !== 'tos_violation' &&
      Boolean(projectHeaders['x-goog-user-project'])
    );
  }

  private async throwUpstreamRequestError(error: unknown, operation: string): Promise<never> {
    if (axios.isAxiosError(error)) {
      await readForbiddenErrorBody(error);
      const upstreamError = this.toUpstreamRequestError(error);
      this.logUpstreamFailure(operation, upstreamError);
      throw upstreamError;
    }
    this.throwAsCleanError(error);
  }

  private toUpstreamRequestError(error: AxiosError): UpstreamRequestError {
    const status = error.response?.status;
    return new UpstreamRequestError({
      status,
      headers: { retryAfter: this.extractRetryAfterHeader(error.response?.headers) },
      reason: classifyAxiosFailure(status, error.response?.data, error.message),
    });
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

  private extractRetryAfterHeader(headers: unknown): string | undefined {
    if (!isObjectLike(headers)) {
      return undefined;
    }

    const retryAfter = Object.entries(headers as Record<string, unknown>).find(
      ([name]) => name.toLowerCase() === 'retry-after',
    )?.[1];
    if (isString(retryAfter)) {
      return retryAfter.trim();
    }
    if (Array.isArray(retryAfter) && retryAfter.length > 0) {
      const first = retryAfter[0];
      if (isString(first)) {
        return first.trim();
      }
    }
    return undefined;
  }
  private throwAsCleanError(_error: unknown): never {
    throw new UpstreamRequestError({ reason: 'transport' });
  }
}
