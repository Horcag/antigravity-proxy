import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from 'axios';
import { isEmpty, isFunction, isNil, isObjectLike, isString } from 'lodash-es';
import { Readable } from 'node:stream';
import { GeminiRequest, GeminiResponse } from '../interfaces/request-interfaces';
import { GeminiInternalRequest } from '../../antigravity/types';
import { getServerConfig } from '../../../../server/server-config';
import { resolveRequestUserAgent } from '../request-user-agent';
import { UpstreamRequestError } from './upstream-error';

export function unwrapInternalGeminiResponse<T>(payload: T | { response: T }): T {
  if (isObjectLike(payload)) {
    const record = payload as Record<string, unknown>;
    if (Object.hasOwn(record, 'response') && isObjectLike(record.response)) {
      return record.response as T;
    }
  }

  return payload as T;
}

export interface NegativeProjectCapabilityEntry {
  accountKey: string;
  project: string;
  cachedAt: number;
  expiresAt: number;
}

export const DEFAULT_PROJECT_CAPABILITY_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROJECT_HEADER_ATTEMPT_COUNT = 2;

export class UserProjectCapabilityCache {
  private readonly entries = new Map<string, NegativeProjectCapabilityEntry>();
  private readonly maxEntries = 1000;

  private createKey(accountKey: string, project: string): string | null {
    const safeAccount = accountKey?.trim();
    const safeProject = project?.trim();
    if (!safeAccount || !safeProject) {
      return null;
    }
    // Never key by token: reject any token-like value
    if (
      safeAccount.startsWith('ya29.') ||
      safeAccount.toLowerCase().startsWith('bearer ') ||
      safeAccount.length > 256
    ) {
      return null;
    }
    return `${safeAccount}:${safeProject}`;
  }

  hasNegativeCapability(accountKey: string, project: string, now = Date.now()): boolean {
    const key = this.createKey(accountKey, project);
    if (!key) {
      return false;
    }
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  recordNegativeCapability(
    accountKey: string,
    project: string,
    ttlMs = DEFAULT_PROJECT_CAPABILITY_TTL_MS,
    now = Date.now(),
  ): void {
    const key = this.createKey(accountKey, project);
    if (!key) {
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      this.pruneExpired(now);
      if (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey) {
          this.entries.delete(oldestKey);
        }
      }
    }
    this.entries.set(key, {
      accountKey: accountKey.trim(),
      project: project.trim(),
      cachedAt: now,
      expiresAt: now + ttlMs,
    });
  }

  clearNegativeCapability(accountKey: string, project: string): void {
    const key = this.createKey(accountKey, project);
    if (!key) {
      return;
    }
    this.entries.delete(key);
  }

  clearAll(): void {
    this.entries.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  getSnapshot(): NegativeProjectCapabilityEntry[] {
    const now = Date.now();
    this.pruneExpired(now);
    return [...this.entries.values()];
  }
}

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
    upstreamProxyUrl?: string,
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
        proxy: axiosProxy,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(`Gemini stream request failed: ${error.message}`);
        throw new UpstreamRequestError({
          message: error.response?.data?.error?.message || error.message,
          status: error.response?.status,
          headers: {
            retryAfter: this.extractRetryAfterHeader(error.response?.headers),
          },
          body: this.describeAxiosErrorData(error.response?.data),
        });
      }
      this.throwAsCleanError(error);
    }
  }

  async generate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
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
        proxy: axiosProxy,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Gemini request failed: ${error.message} - ${this.safeStringify(error.response?.data)}`,
        );
        throw new UpstreamRequestError({
          message: error.response?.data?.error?.message || error.message,
          status: error.response?.status,
          headers: {
            retryAfter: this.extractRetryAfterHeader(error.response?.headers),
          },
          body: this.describeAxiosErrorData(error.response?.data),
        });
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
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string },
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
      accountKeyOrOptions,
    );

    return response.data;
  }

  async generateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string },
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
      accountKeyOrOptions,
    );
    return unwrapInternalGeminiResponse(response.data);
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
    accountKeyOrOptions?: string | { accountKey?: string; accountId?: string },
  ): Promise<AxiosResponse<T>> {
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
          });

          this.preferredInternalBaseUrl = baseUrl;
          if (Boolean(projectHeaders['x-goog-user-project']) && safeProject) {
            this.userProjectCapabilityCache.clearNegativeCapability(safeAccount, safeProject);
          }
          return response;
        } catch (error) {
          lastError = error;

          if (this.shouldRetryWithoutProjectHeader(error, projectHeaders)) {
            this.logger.warn(
              `[${operation}] received 403 with project context; retrying without project context.`,
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
            `[${operation}] request failed at ${baseUrl}; trying next endpoint (${index + 2}/${
              baseUrls.length
            }).`,
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
      Boolean(projectHeaders['x-goog-user-project'])
    );
  }

  private async throwUpstreamRequestError(error: unknown, operation: string): Promise<never> {
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      const upstreamMessage = await this.extractAxiosErrorMessage(responseData);
      this.logger.error(
        `[${operation}] upstream request error: ${error.message} - ${this.describeAxiosErrorData(
          responseData,
        )}`,
      );
      throw new UpstreamRequestError({
        message: upstreamMessage || error.message,
        status: error.response?.status,
        headers: {
          retryAfter: this.extractRetryAfterHeader(error.response?.headers),
        },
        body: this.describeAxiosErrorData(responseData),
      });
    }
    this.throwAsCleanError(error);
  }

  private async extractAxiosErrorMessage(responseData: unknown): Promise<string | null> {
    const fromObject = this.extractAxiosErrorMessageFromObject(responseData);
    if (fromObject) {
      return fromObject;
    }

    if (isString(responseData)) {
      return this.extractAxiosErrorMessageFromText(responseData);
    }

    if (Buffer.isBuffer(responseData)) {
      return this.extractAxiosErrorMessageFromText(responseData.toString('utf-8'));
    }

    if (this.isReadableStream(responseData)) {
      const streamText = await this.readStreamAsText(responseData);
      return streamText ? this.extractAxiosErrorMessageFromText(streamText) : null;
    }

    return null;
  }

  private extractAxiosErrorMessageFromObject(responseData: unknown): string | null {
    if (!isObjectLike(responseData) || this.isReadableStream(responseData)) {
      return null;
    }

    const errorRecord = (responseData as { error?: unknown }).error;
    if (isObjectLike(errorRecord)) {
      const message = (errorRecord as { message?: unknown }).message;
      if (isString(message) && !isEmpty(message.trim())) {
        return message.trim();
      }
    }

    const message = (responseData as { message?: unknown }).message;
    if (isString(message) && !isEmpty(message.trim())) {
      return message.trim();
    }

    return null;
  }

  private extractAxiosErrorMessageFromText(rawText: string): string | null {
    const text = rawText.trim();
    if (!text) {
      return null;
    }

    const sseLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));

    for (const line of sseLines) {
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      const parsed = this.tryParseJson(payload);
      const message = this.extractAxiosErrorMessageFromObject(parsed);
      if (message) {
        return message;
      }
    }

    const parsed = this.tryParseJson(text);
    const fromJson = this.extractAxiosErrorMessageFromObject(parsed);
    if (fromJson) {
      return fromJson;
    }

    return null;
  }

  private tryParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private isReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return isObjectLike(value) && isFunction((value as { pipe?: unknown }).pipe);
  }

  private async readStreamAsText(stream: NodeJS.ReadableStream): Promise<string | null> {
    return new Promise((resolve) => {
      let buffer = '';
      const maxChars = 512 * 1024;

      stream.on('data', (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        if (buffer.length >= maxChars) {
          return;
        }
        buffer += text;
        if (buffer.length > maxChars) {
          buffer = buffer.slice(0, maxChars);
        }
      });

      stream.on('end', () => resolve(buffer));
      stream.on('error', () => resolve(null));
    });
  }

  private describeAxiosErrorData(responseData: unknown): string {
    if (this.isReadableStream(responseData)) {
      return '[stream]';
    }
    return this.safeStringify(responseData);
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
      this.logger.warn(`Upstream proxy URL is invalid: ${configuredProxyUrl}`);
      return undefined;
    }
  }

  private extractRetryAfterHeader(headers: unknown): string | undefined {
    if (!isObjectLike(headers)) {
      return undefined;
    }

    const retryAfter = (headers as Record<string, unknown>)['retry-after'];
    if (isString(retryAfter) && !isEmpty(retryAfter.trim())) {
      return retryAfter.trim();
    }
    if (Array.isArray(retryAfter) && retryAfter.length > 0) {
      const first = retryAfter[0];
      if (isString(first) && !isEmpty(first.trim())) {
        return first.trim();
      }
    }
    return undefined;
  }

  private throwAsCleanError(error: unknown): never {
    // Re-throw as clean Error to avoid circular reference issues.
    throw error instanceof Error ? new Error(error.message) : new Error(String(error));
  }

  /**
   * Safely stringify an object, handling circular references
   */
  private safeStringify(obj: unknown): string {
    if (isNil(obj)) {
      return String(obj);
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(obj, (key, value) => {
        if (isObjectLike(value)) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      });
    } catch {
      return '[Unserializable]';
    }
  }
}
