import { z } from 'zod';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { AuthServer } from '@/modules/cloud-account/ipc/authServer';
import { EnvHttpProxyAgent, ProxyAgent } from 'undici';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/modules/proxy-gateway/server/request-user-agent';
import { isEmpty, isNumber, isString } from 'lodash-es';
import { v4 } from 'uuid';
import { logger } from '@/shared/logging/logger';
import {
  type OAuthClientDescriptor,
  OAuthClientRegistryService,
} from './OAuthClientRegistryService';
import {
  AICreditsAuthenticationError,
  isAICreditsAuthenticationError,
} from './ai-credits-authentication-error';
import { isStrictAuthenticationFailure } from './strict-authentication-classifier';

// --- Constants & Config ---
const URLS = {
  TOKEN: 'https://oauth2.googleapis.com/token',
  USER_INFO: 'https://www.googleapis.com/oauth2/v2/userinfo',
  AUTH: 'https://accounts.google.com/o/oauth2/v2/auth',
  LOAD_PROJECT: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  SANDBOX_LOAD_PROJECT:
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  DAILY_LOAD_PROJECT: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  FETCH_CREDITS: 'https://cloudcode-pa.googleapis.com/v1internal:fetchCredits',
};

const QUOTA_API_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
] as const;

const QUOTA_SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
] as const;

// Request timeout in milliseconds (30 seconds)
const REQUEST_TIMEOUT_MS = 30000;

function isClientMismatchError(status: number, errorText: string): boolean {
  const text = errorText.toLowerCase();
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    text.includes('unauthorized_client') ||
    text.includes('invalid_client')
  );
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  const status =
    candidate.status ??
    candidate.statusCode ??
    candidate.response?.status ??
    candidate.response?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function toSafeRequestError(error: unknown): Error {
  if (isAICreditsAuthenticationError(error)) {
    return error;
  }

  if (
    error instanceof Error &&
    /^(?:FORBIDDEN|UNAUTHORIZED|TIMEOUT|REQUEST_FAILED|HTTP [1-5]\d{2})$/.test(error.message)
  ) {
    return new Error(error.message);
  }

  const status = getErrorStatus(error);
  if (status !== undefined) {
    return new Error(`HTTP ${status}`);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('TIMEOUT');
  }
  return new Error('REQUEST_FAILED');
}

function toSafeHttpError(status: number): Error {
  return new Error(`HTTP ${status}`);
}

interface DisposableRequestSignal {
  signal: AbortSignal;
  dispose(): void;
}

function createDisposableRequestSignal(
  ms: number,
  parentSignal?: AbortSignal,
): DisposableRequestSignal {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    timeout = setTimeout(() => controller.abort(), ms);
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

// --- Types ---

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  oauth_client_key?: string;
}

export type { OAuthClientDescriptor };

export interface UserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export const UserInfoSchema = z.object({
  id: z.string(),
  email: z.string(),
  verified_email: z.boolean().optional().default(false),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().optional(),
});

export interface QuotaData {
  models: Record<string, ModelQuotaInfo>;
  model_forwarding_rules?: Record<string, string>;
  subscription_tier?: string;
  is_forbidden?: boolean;
  ai_credits?: { credits: number; expiryDate: string };
  quota_groups?: QuotaGroup[];
}

export interface ModelQuotaInfo {
  percentage: number;
  resetTime: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

export interface QuotaBucket {
  bucket_id: string;
  window: string;
  remaining_fraction: number;
  reset_time: string;
  display_name?: string;
  description?: string;
}

export interface QuotaGroup {
  display_name: string;
  description?: string;
  buckets: QuotaBucket[];
}

// Internal types for API parsing
interface ModelInfoRaw {
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  displayName?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  recommended?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportedMimeTypes?: Record<string, boolean>;
}

interface DeprecatedModelInfoRaw {
  newModelId?: string;
}

interface IneligibleTierRaw {
  reasonCode?: string;
}

interface TierRaw {
  is_default?: boolean;
  id?: string;
  quotaTier?: string;
  name?: string;
  slug?: string;
  availableCredits?: AvailableCreditRaw[];
}

interface AvailableCreditRaw {
  creditType?: string;
  creditAmount?: string | number;
  minimumCreditAmountForUsage?: string | number;
}

interface LoadProjectResponse {
  cloudaicompanionProject?: string;
  currentTier?: TierRaw;
  paidTier?: TierRaw;
  allowedTiers?: TierRaw[];
  ineligibleTiers?: IneligibleTierRaw[];
}

interface FetchModelsResponse {
  models?: Record<string, ModelInfoRaw>;
  deprecatedModelIds?: Record<string, DeprecatedModelInfoRaw>;
}

interface QuotaSummaryBucketRaw {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  displayName?: string;
  description?: string;
}

interface QuotaSummaryGroupRaw {
  displayName?: string;
  description?: string;
  buckets?: QuotaSummaryBucketRaw[];
}

interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroupRaw[];
}

interface ProjectContext {
  projectId?: string;
  subscriptionTier?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInternalApiHeaders(accessToken: string): Record<string, string> {
  const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': buildUserAgent(discoveryVersion),
    'Content-Type': 'application/json',
  };
}

function resolveSubscriptionTier(payload: LoadProjectResponse): string | undefined {
  const paidTier = payload.paidTier;
  if (isString(paidTier?.name) && !isEmpty(paidTier.name.trim())) {
    return paidTier.name;
  }
  if (isString(paidTier?.id) && !isEmpty(paidTier.id.trim())) {
    return paidTier.id;
  }

  const ineligible = Array.isArray(payload.ineligibleTiers) && payload.ineligibleTiers.length > 0;
  if (!ineligible) {
    const currentTier = payload.currentTier;
    if (isString(currentTier?.name) && !isEmpty(currentTier.name.trim())) {
      return currentTier.name;
    }
    if (isString(currentTier?.id) && !isEmpty(currentTier.id.trim())) {
      return currentTier.id;
    }
  }

  if (Array.isArray(payload.allowedTiers)) {
    const preferredAllowedTier =
      payload.allowedTiers.find((tier) => tier.is_default === true) ?? payload.allowedTiers[0];
    if (isString(preferredAllowedTier?.name) && !isEmpty(preferredAllowedTier.name.trim())) {
      return ineligible ? `${preferredAllowedTier.name} (Restricted)` : preferredAllowedTier.name;
    }
    if (isString(preferredAllowedTier?.id) && !isEmpty(preferredAllowedTier.id.trim())) {
      return ineligible ? `${preferredAllowedTier.id} (Restricted)` : preferredAllowedTier.id;
    }
  }

  return undefined;
}

function isTrackedModel(modelName: string): boolean {
  return /^(gemini|claude|gpt|image|imagen)/i.test(modelName);
}

function toModelQuotaInfo(modelName: string, info: ModelInfoRaw): ModelQuotaInfo | null {
  if (!isTrackedModel(modelName) || !info.quotaInfo || modelName.endsWith('-disabled')) {
    return null;
  }

  const fraction = info.quotaInfo.remainingFraction ?? 0;
  return {
    percentage: Math.floor(fraction * 100),
    resetTime: info.quotaInfo.resetTime || '',
    display_name: info.displayName,
    supports_images: info.supportsImages,
    supports_thinking: info.supportsThinking,
    thinking_budget: info.thinkingBudget,
    recommended: info.recommended,
    max_tokens: info.maxTokens,
    max_output_tokens: info.maxOutputTokens,
    supported_mime_types: info.supportedMimeTypes,
  };
}

function toModelForwardingRules(
  deprecatedModelIds: FetchModelsResponse['deprecatedModelIds'],
): Record<string, string> | undefined {
  if (!deprecatedModelIds || Object.keys(deprecatedModelIds).length === 0) {
    return undefined;
  }

  const forwardingRules: Record<string, string> = {};
  for (const [oldModelId, deprecatedInfo] of Object.entries(deprecatedModelIds)) {
    if (isString(deprecatedInfo.newModelId) && deprecatedInfo.newModelId !== '') {
      forwardingRules[oldModelId] = deprecatedInfo.newModelId;
    }
  }

  return Object.keys(forwardingRules).length > 0 ? forwardingRules : undefined;
}

function toQuotaGroups(data: QuotaSummaryResponse): QuotaGroup[] | undefined {
  if (!Array.isArray(data.groups) || data.groups.length === 0) {
    return undefined;
  }

  const groups = data.groups.map((group) => ({
    display_name: group.displayName || '',
    description: group.description,
    buckets: Array.isArray(group.buckets)
      ? group.buckets.map((bucket) => ({
          bucket_id: bucket.bucketId || '',
          window: bucket.window || '',
          remaining_fraction: bucket.remainingFraction ?? 0,
          reset_time: bucket.resetTime || '',
          display_name: bucket.displayName,
          description: bucket.description,
        }))
      : [],
  }));

  return groups;
}

function parseCreditAmount(value: string | number | undefined): number {
  if (isNumber(value)) {
    return value;
  }

  if (isString(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function extractAiCreditsFromProjectContext(
  payload: LoadProjectResponse,
): { credits: number; expiryDate: string } | null {
  const availableCredit = payload.paidTier?.availableCredits?.[0];
  if (!availableCredit) {
    return null;
  }

  return {
    credits: parseCreditAmount(availableCredit.creditAmount),
    expiryDate: '',
  };
}

// --- Service Implementation ---

export class GoogleAPIService {
  static listOAuthClients(): OAuthClientDescriptor[] {
    return OAuthClientRegistryService.listOAuthClients();
  }

  static getActiveOAuthClientKey(): string {
    return OAuthClientRegistryService.getActiveOAuthClientKey();
  }

  static setActiveOAuthClientKey(clientKey: string): void {
    OAuthClientRegistryService.setActiveOAuthClientKey(clientKey);
  }

  static normalizeRefreshedOAuthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return OAuthClientRegistryService.normalizeRefreshedOAuthClientKey(
      currentToken,
      refreshedClientKey,
    );
  }

  static getFetchOptions(proxyUrl?: string) {
    const proxyTraceEnabled = process.env.DEBUG_PROXY_TRACE === '1';

    if (proxyUrl && proxyUrl.length > 0) {
      if (proxyTraceEnabled) {
        logger.info('[GoogleAPIService] Proxy source: account proxy_url');
      }
      return {
        dispatcher: new ProxyAgent(proxyUrl),
      };
    }
    try {
      const config = ConfigManager.loadConfig();
      if (config.proxy?.upstream_proxy?.enabled) {
        if (!config.proxy.upstream_proxy.url) {
          throw new Error('Upstream proxy is enabled but URL is not configured');
        }
        if (proxyTraceEnabled) {
          logger.info('[GoogleAPIService] Proxy source: config.proxy.upstream_proxy.url');
        }
        return {
          dispatcher: new ProxyAgent(config.proxy.upstream_proxy.url),
        };
      }
    } catch (error) {
      logger.error('[GoogleAPIService] Proxy configuration error');
      throw toSafeRequestError(error);
    }

    const httpProxy = process.env.http_proxy?.trim() || process.env.HTTP_PROXY?.trim();
    const httpsProxy = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
    const noProxy = process.env.no_proxy?.trim() || process.env.NO_PROXY?.trim();
    const electronProxyServer = process.env.ELECTRON_PROXY_SERVER?.trim();

    if (httpProxy || httpsProxy) {
      if (proxyTraceEnabled) {
        logger.info('[GoogleAPIService] Proxy source: HTTP(S)_PROXY env');
      }
      return {
        dispatcher: new EnvHttpProxyAgent({
          httpProxy,
          httpsProxy,
          noProxy,
        }),
      };
    }

    if (electronProxyServer) {
      if (proxyTraceEnabled) {
        logger.info('[GoogleAPIService] Proxy source: ELECTRON_PROXY_SERVER env');
      }
      return {
        dispatcher: new ProxyAgent(electronProxyServer),
      };
    }

    if (proxyTraceEnabled) {
      logger.info('[GoogleAPIService] Proxy source: none');
    }

    return {};
  }

  /**
   * Generates the OAuth2 authorization URL.
   */
  static getAuthUrl(oauthClientKey?: string): string {
    const scopes = [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
      'https://www.googleapis.com/auth/aicode',
    ].join(' ');

    const oauthClient = OAuthClientRegistryService.selectAuthClient(oauthClientKey);
    const redirectUri = AuthServer.getRedirectUri();

    const params = new URLSearchParams({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      response_type: 'code',
      client_id: oauthClient.client_id,
      redirect_uri: redirectUri,
      include_granted_scopes: 'true',
      state: v4(),
    });

    return `${URLS.AUTH}?${params.toString()}`;
  }

  /**
   * Exchanges an authorization code for tokens.
   */
  static async exchangeCode(
    code: string,
    proxyUrl?: string,
    preferredClientKey?: string,
  ): Promise<TokenResponse> {
    const redirectUri = AuthServer.getRedirectUri();
    const candidates = OAuthClientRegistryService.getCandidateClients(preferredClientKey);
    if (candidates.length === 0) {
      throw new Error('No OAuth clients configured');
    }

    for (const client of candidates) {
      const params = new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      logger.info('[GoogleAPIService] OAuth request: operation=token_exchange');
      const fetchOpts = this.getFetchOptions(proxyUrl);
      logger.info('[GoogleAPIService] OAuth request options: operation=token_exchange');

      const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS);
      const response = await fetch(URLS.TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: request.signal,
        ...fetchOpts,
      })
        .catch((error: unknown) => {
          logger.error('[GoogleAPIService] OAuth request failed: operation=token_exchange');
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(
              'Token exchange timed out. Please check your network connection and try again.',
            );
          }
          throw toSafeRequestError(error);
        })
        .finally(() => request.dispose());

      logger.info(
        `[GoogleAPIService] OAuth response: operation=token_exchange status=${response.status}`,
      );

      if (response.ok) {
        const tokenResponse = (await response.json()) as TokenResponse;
        tokenResponse.oauth_client_key = client.key;
        return tokenResponse;
      }

      const text = await response.text();
      const failure = toSafeHttpError(response.status);
      if (isClientMismatchError(response.status, text)) {
        logger.warn(
          `[GoogleAPIService] OAuth client rejected: operation=token_exchange status=${response.status} action=retry_next_client`,
        );
        continue;
      }

      throw new Error(`Token exchange failed: ${failure.message}`);
    }

    throw new Error('Token exchange failed: configured clients rejected');
  }

  static async refreshAccessToken(
    refreshToken: string,
    proxyUrl?: string,
    preferredClientKey?: string,
    options?: { signal?: AbortSignal; reportInvalidGrant?: boolean },
  ): Promise<TokenResponse> {
    const candidates = OAuthClientRegistryService.getCandidateClients(preferredClientKey);
    if (candidates.length === 0) {
      throw new Error('No OAuth clients configured');
    }

    let invalidGrant = false;
    for (const client of candidates) {
      options?.signal?.throwIfAborted();
      const params = new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });

      logger.info('[GoogleAPIService] OAuth request: operation=token_refresh');
      const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS, options?.signal);
      const response = await fetch(URLS.TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        // Keep the caller deadline attached while reading the OAuth response body.
        signal: options?.signal ?? request.signal,
        ...this.getFetchOptions(proxyUrl),
      })
        .catch((error: unknown) => {
          logger.error('[GoogleAPIService] OAuth request failed: operation=token_refresh');
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Token refresh timed out. Please check your network connection and try again.');
          }
          throw toSafeRequestError(error);
        })
        .finally(() => request.dispose());

      logger.info(`[GoogleAPIService] OAuth response: operation=token_refresh status=${response.status}`);

      if (response.ok) {
        const tokenResponse = (await response.json()) as TokenResponse;
        tokenResponse.oauth_client_key = client.key;
        return tokenResponse;
      }

      const text = await response.text();
      // Keep a matching client's revocation evidence across later client mismatches.
      try {
        invalidGrant ||= (!preferredClientKey || client.key === preferredClientKey) && (JSON.parse(text) as { error?: unknown }).error === 'invalid_grant';
      } catch { /* Keep the rejection generic for a non-JSON OAuth response. */ }
      const failure = toSafeHttpError(response.status);
      if (isClientMismatchError(response.status, text)) {
        logger.warn(`[GoogleAPIService] OAuth client rejected: operation=token_refresh status=${response.status} action=retry_next_client`);
        continue;
      }

      throw new Error(`Token refresh failed: ${failure.message}`);
    }

    if (invalidGrant && options?.reportInvalidGrant) throw new Error('OAUTH_INVALID_GRANT');
    throw new Error('Token refresh failed: configured clients rejected');
  }

  /**
   * Fetches user profile information.
   */
  static async getUserInfo(accessToken: string, proxyUrl?: string): Promise<UserInfo> {
    const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS);
    const response = await fetch(URLS.USER_INFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: request.signal,
      ...this.getFetchOptions(proxyUrl),
    })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            'User info request timed out. Please check your network connection and try again.',
          );
        }
        throw toSafeRequestError(error);
      })
      .finally(() => request.dispose());

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: HTTP ${response.status}`);
    }

    const data = await response.json();
    try {
      const parsed = UserInfoSchema.parse(data);

      return {
        ...parsed,
        // Google may omit profile claims such as family_name for accounts with limited profile data.
        name: parsed.name ?? parsed.email,
      };
    } catch {
      logger.error('[GoogleAPIService] Malformed user info response');
      throw new Error('Received malformed user info from Google APIs');
    }
  }

  public static async fetchProjectContext(
    accessToken: string,
    proxyUrl?: string,
  ): Promise<ProjectContext> {
    const body = {
      metadata: { ideType: 'ANTIGRAVITY' },
    };

    let projectId: string | undefined;
    let subscriptionTier: string | undefined;
    let lastError: Error | undefined;
    const endpoints = [URLS.LOAD_PROJECT, URLS.SANDBOX_LOAD_PROJECT] as const;

    for (const endpoint of endpoints) {
      try {
        const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: buildInternalApiHeaders(accessToken),
          body: JSON.stringify(body),
          signal: request.signal,
          ...this.getFetchOptions(proxyUrl),
        }).finally(() => request.dispose());

        if (response.ok) {
          const data = (await response.json()) as LoadProjectResponse;
          if (isString(data.cloudaicompanionProject)) {
            projectId = data.cloudaicompanionProject;
          }
          subscriptionTier = resolveSubscriptionTier(data);
          break;
        } else {
          lastError = toSafeHttpError(response.status);
          if (response.status === 403) {
            const errBody = await response.text().catch(() => '');
            if (errBody.includes('TOS_VIOLATION') || errBody.includes('violation of Terms of Service')) {
              logger.error(`[GoogleAPIService] Account ToS violation detected at ${endpoint}`);
              throw new Error('TOS_VIOLATION');
            }
          }
          if (endpoint === URLS.LOAD_PROJECT && response.status === 429) {
            logger.warn(
              '[GoogleAPIService] Prod loadCodeAssist returned 429, falling back to sandbox endpoint',
            );
            continue;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'TOS_VIOLATION') throw error;
        lastError = toSafeRequestError(error);
        logger.warn(
          `[GoogleAPIService] Project context request failed at endpoint #${endpoints.indexOf(endpoint) + 1}: ${lastError.message}`,
        );
        await sleep(500);
      }

      if (projectId || subscriptionTier) {
        break;
      }

      if (endpoint !== URLS.LOAD_PROJECT || lastError?.message !== 'HTTP 429') {
        break;
      }
    }

    if (!projectId && !subscriptionTier) {
      throw lastError || new Error('Failed to fetch project context after multiple attempts.');
    }

    return {
      projectId,
      subscriptionTier,
    };
  }

  public static async fetchProjectId(
    accessToken: string,
    proxyUrl?: string,
  ): Promise<string | null> {
    const context = await this.fetchProjectContext(accessToken, proxyUrl);
    return context.projectId ?? null;
  }

  static async fetchAICredits(
    accessToken: string,
    proxyUrl?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ credits: number; expiryDate: string } | null> {
    try {
      const fetchOptions = this.getFetchOptions(proxyUrl);
      const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
      const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS, parentSignal);
      const fallbackResponse = await fetch(URLS.DAILY_LOAD_PROJECT, {
        method: 'POST',
        headers: buildInternalApiHeaders(accessToken),
        body: JSON.stringify({
          metadata: {
            ide_type: 'ANTIGRAVITY',
            ide_version: discoveryVersion,
            ide_name: 'antigravity',
          },
        }),
        signal: request.signal,
        ...fetchOptions,
      }).finally(() => request.dispose());

      if (!fallbackResponse.ok) {
        if (fallbackResponse.status === 401 || fallbackResponse.status === 403) {
          throw new AICreditsAuthenticationError();
        }
        return null;
      }

      const fallbackData = (await fallbackResponse.json()) as LoadProjectResponse;
      return extractAiCreditsFromProjectContext(fallbackData);
    } catch (error) {
      if (isAICreditsAuthenticationError(error)) {
        throw error;
      }
      if (isStrictAuthenticationFailure(error)) {
        throw new AICreditsAuthenticationError();
      }
      return null;
    }
  }

  private static toQuotaData(
    data: FetchModelsResponse,
    subscriptionTier: string | undefined,
  ): QuotaData {
    const result: QuotaData = {
      models: {},
      subscription_tier: subscriptionTier,
      is_forbidden: false,
    };

    for (const [modelName, modelInfoRaw] of Object.entries(data.models || {})) {
      const modelQuota = toModelQuotaInfo(modelName, modelInfoRaw);
      if (modelQuota) result.models[modelName] = modelQuota;
    }

    const modelForwardingRules = toModelForwardingRules(data.deprecatedModelIds);
    if (modelForwardingRules) result.model_forwarding_rules = modelForwardingRules;
    return result;
  }

  private static shouldFallbackQuotaEndpoint(status: number): boolean { return status === 429 || status >= 500; }
  private static isPermanentQuotaHttp4xx(errorMsg: string): boolean { return /^HTTP 4\d{2}\b/.test(errorMsg) && !errorMsg.startsWith('HTTP 429'); }

  /**
   * Core logic: Fetches detailed model quota information.
   */
  static async fetchQuota(accessToken: string, proxyUrl?: string): Promise<QuotaData> {
    let projectContext: ProjectContext = {};
    try {
      projectContext = await this.fetchProjectContext(accessToken, proxyUrl);
    } catch (error) {
      if (error instanceof Error && error.message === 'TOS_VIOLATION') throw error;
      logger.warn(
        '[GoogleAPIService] Project context unavailable; continuing quota lookup without project',
        toSafeRequestError(error).message,
      );
    }

    const { projectId, subscriptionTier } = projectContext;

    const payload: Record<string, unknown> = projectId ? { project: projectId } : {};
    let lastError: Error | null = null;
    const fetchOptions = this.getFetchOptions(proxyUrl);

    for (let endpointIndex = 0; endpointIndex < QUOTA_API_ENDPOINTS.length; endpointIndex++) {
      const endpoint = QUOTA_API_ENDPOINTS[endpointIndex];
      const hasNextEndpoint = endpointIndex + 1 < QUOTA_API_ENDPOINTS.length;
      let currentPayload = { ...payload };
      let retriedWithoutProject = false;

      while (true) {
        try {
          const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS);
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: buildInternalApiHeaders(accessToken),
            body: JSON.stringify(currentPayload),
            signal: request.signal,
            ...fetchOptions,
          }).finally(() => request.dispose());

          if (!response.ok) {
            const status = response.status;

            if (status === 403) {
              if ('project' in currentPayload && !retriedWithoutProject) {
                logger.warn(
                  '[GoogleAPIService] Quota API returned 403 with project ID, retrying without project ID',
                );
                currentPayload = {};
                retriedWithoutProject = true;
                continue;
              }

              throw new Error('FORBIDDEN');
            }
            if (status === 401) {
              throw new Error('UNAUTHORIZED');
            }

            const quotaError = toSafeHttpError(status);
            if (hasNextEndpoint && this.shouldFallbackQuotaEndpoint(status)) {
              logger.warn(
                `[GoogleAPIService] Quota API endpoint #${endpointIndex + 1} returned ${status}, falling back to next endpoint`,
              );
              lastError = quotaError;

              await sleep(1000);
              break;
            }

            throw quotaError;
          }

          const data = (await response.json()) as FetchModelsResponse;
          const result = this.toQuotaData(data, subscriptionTier);
          const enrichmentController = new AbortController();
          const quotaGroupsPromise = this.fetchQuotaSummary(
            accessToken,
            projectId,
            fetchOptions,
            enrichmentController.signal,
          );
          const aiCreditsPromise = this.fetchAICredits(
            accessToken,
            proxyUrl,
            enrichmentController.signal,
          );
          let quotaGroups: QuotaGroup[] | undefined;
          let aiCredits: { credits: number; expiryDate: string } | null;
          try {
            [quotaGroups, aiCredits] = await Promise.all([quotaGroupsPromise, aiCreditsPromise]);
          } catch (error) {
            enrichmentController.abort(error);
            await Promise.allSettled([quotaGroupsPromise, aiCreditsPromise]);
            throw error;
          }
          if (quotaGroups) {
            result.quota_groups = quotaGroups;
          }
          if (aiCredits) {
            result.ai_credits = aiCredits;
          }

          if (endpointIndex > 0) {
            logger.info(
              `[GoogleAPIService] Quota API fallback succeeded at endpoint #${endpointIndex + 1}`,
            );
          }

          return result;
        } catch (error: unknown) {
          if (isAICreditsAuthenticationError(error)) {
            throw error;
          }
          lastError = toSafeRequestError(error);
          const errorMsg = lastError.message;

          // Abort retries for auth errors
          if (errorMsg === 'FORBIDDEN' || errorMsg === 'UNAUTHORIZED' || errorMsg === 'TOS_VIOLATION') {
            throw error;
          }

          if (hasNextEndpoint && !this.isPermanentQuotaHttp4xx(errorMsg)) {
            logger.warn(
              `[GoogleAPIService] Quota API request failed at endpoint #${endpointIndex + 1}: ${errorMsg}. Falling back to next endpoint`,
            );
            await sleep(1000);
            break;
          }

          throw lastError;
        }
      }
    }

    throw lastError || new Error('Quota check failed');
  }

  private static async fetchQuotaSummary(
    accessToken: string,
    projectId: string | undefined,
    fetchOptions: ReturnType<typeof GoogleAPIService.getFetchOptions>,
    parentSignal?: AbortSignal,
  ): Promise<QuotaGroup[] | undefined> {
    const payload: Record<string, unknown> = projectId ? { project: projectId } : {};

    for (let endpointIndex = 0; endpointIndex < QUOTA_SUMMARY_ENDPOINTS.length; endpointIndex++) {
      if (parentSignal?.aborted) {
        return undefined;
      }
      const endpoint = QUOTA_SUMMARY_ENDPOINTS[endpointIndex];
      let currentPayload = { ...payload };
      let retriedWithoutProject = false;

      while (true) {
        try {
          const request = createDisposableRequestSignal(REQUEST_TIMEOUT_MS, parentSignal);
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: buildInternalApiHeaders(accessToken),
            body: JSON.stringify(currentPayload),
            signal: request.signal,
            ...fetchOptions,
          }).finally(() => request.dispose());

          if (parentSignal?.aborted) {
            return undefined;
          }

          if (!response.ok) {
            logger.warn(
              `[GoogleAPIService] Quota summary API endpoint #${endpointIndex + 1} returned ${response.status}`,
            );
            if (response.status === 403 && 'project' in currentPayload && !retriedWithoutProject) {
              logger.warn(
                '[GoogleAPIService] Quota summary returned 403 with project ID, retrying without project ID',
              );
              currentPayload = {};
              retriedWithoutProject = true;
              continue;
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
              return undefined;
            }
            break;
          }

          return toQuotaGroups((await response.json()) as QuotaSummaryResponse);
        } catch (error) {
          if (parentSignal?.aborted) {
            return undefined;
          }
          logger.warn(
            `[GoogleAPIService] Quota summary API request failed at endpoint #${endpointIndex + 1}: ${toSafeRequestError(error).message}`,
          );
          break;
        }
      }
    }

    return undefined;
  }
}
