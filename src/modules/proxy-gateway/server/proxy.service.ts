import { isPerformanceFailure } from './proxy-attempt-performance';
import { observeUpstreamStreamFailure } from '../../../observability/request-context';
import { createHash } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, Inject } from '@nestjs/common';
import { isEmpty, isFunction, isNil, isNumber, isPlainObject, isString } from 'lodash-es';
import { AccountLeaseService, type AffinityCommitResult } from './account-lease.service';
import { GeminiClient, unwrapInternalGeminiResponse } from './clients/gemini.client';
import { getUpstreamRequestCancellation, UpstreamRequestError } from './clients/upstream-error';
import { AccountPoolUnavailableException, OpenAIProtocolException } from './openai-protocol-error';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { resolveSafetySettings, transformClaudeRequestIn } from '../antigravity/ClaudeRequestMapper';
import { supportsAnthropicAssistantPrefill } from '../antigravity/ModelMapping';
import { transformResponse } from '../antigravity/ClaudeResponseMapper';
import { StreamingState, PartProcessor } from '../antigravity/ClaudeStreamingMapper';
import { type SignatureContext, SignatureStore } from '../antigravity/SignatureStore';
import { decodeSignature } from '../antigravity/signature-utils';
import {
  ToolCallIdConflictError,
  ToolCallIdIntegrityTracker,
} from '../antigravity/tool-call-id-integrity';
import {
  type GeminiResponsesGroundingMetadata,
  type GeminiResponsesStreamPart,
  type GeminiResponsesUsageMetadata,
  type OpenAIResponsesConfiguration,
  OpenAIResponsesStreamingMapper,
} from '../antigravity/OpenAIResponsesStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  GroundingMetadata,
  GeminiInternalRequest,
  GeminiPart as InternalGeminiPart,
} from '../antigravity/types';
import { normalizeObjectJsonSchema } from '../antigravity/JsonSchemaUtils';
import { mapGeminiFinishReasonToOpenAI } from '../antigravity/gemini-finish-reason';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiResponse,
  GeminiRequest,
  AnthropicChatResponse,
  OpenAIChatResponse,
  AnthropicContent,
} from './interfaces/request-interfaces';
import { getServerConfig } from '../../../server/server-config';
import { resolveRequestUserAgent } from './request-user-agent';
import { CloudAccount } from '@/modules/cloud-account/types';
import { ProxyGenerationConstraints } from './proxy-generation-constraints';
import {
  ProxyRetryPolicy,
  type ProxyTokenRetryState,
  type ProxyUpstreamFailureClassification,
} from './proxy-retry-policy';
import { ProxyModelRoutingPolicy } from './proxy-model-routing-policy';
import { parseImageDataUrl } from './image-data-url';
import {
  InvalidFunctionCallArgumentsError,
  normalizeFunctionCallArgs,
} from '../antigravity/function-call-args';
import { preflightNativeGeminiRequest } from './native-gemini-request';
import { extractCanonicalUserTurnText } from './cloudcode-failover-gateway';
import { getUpstreamDiagnosticContext, logUpstreamTerminalDiagnostic } from './cloudcode-diagnostics';
import { UPSTREAM_STREAM_STATUS_CODES } from './upstream-stream-status';

interface StreamIdleTimer {
  reset: () => void;
  clear: () => void;
  dispose: () => void;
}

interface StreamHealthLifecycle {
  markUsableOutput: () => boolean;
  recordFailure: (error: unknown) => void;
  cleanup?: () => void;
}

interface UpstreamAttempt<T> {
  result: T;
  startedAt: number;
}

type OpenAIOutputProtocol = 'chat-completions' | 'responses' | 'text-completions';

/** Wire shape emitted by the OpenAI streaming mappers. */
type OpenAIStreamVariant = 'chat' | 'text';

interface OpenAIStreamOptions {
  variant: OpenAIStreamVariant;
  includeUsage: boolean;
  idPrefix?: 'chatcmpl' | 'cmpl';
}

interface OpenAIStreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly streamIdleTimeoutMs = 300_000;
  private readonly streamPenaltyTimeoutMs = 10_000;
  private readonly generationConstraints: ProxyGenerationConstraints;
  private readonly retryPolicy: ProxyRetryPolicy;
  private readonly modelRoutingPolicy = new ProxyModelRoutingPolicy();

  constructor(
    @Inject(AccountLeaseService) private readonly accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) private readonly geminiClient: GeminiClient,
  ) {
    this.generationConstraints = new ProxyGenerationConstraints(this.accountLeaseService);
    this.retryPolicy = new ProxyRetryPolicy(this.accountLeaseService, this.logger);
  }

  private createOfficialRequestId(): string {
    const timestampMs = Date.now();
    const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
    return `agent/${timestampMs}/${randomHex}`;
  }

  private createCloudCodeTraceId(): string {
    return `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  }

  private shouldEmitCloudCodeMeta(): boolean {
    return Boolean(getServerConfig()?.experimental?.enable_cloud_code_meta);
  }

  private createCloudCodeMetaChunk(traceId: string): string {
    const payload = {
      __cloudCodeMeta: {
        traceId,
      },
    };

    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private destroyUpstreamStream(upstreamStream: NodeJS.ReadableStream): void {
    const destroy = (upstreamStream as { destroy?: () => void }).destroy;
    if (isFunction(destroy)) {
      destroy.call(upstreamStream);
    }
  }

  private createStreamIdleTimer(
    upstreamStream: NodeJS.ReadableStream,
    label: string,
    onTimeout: () => void,
  ): StreamIdleTimer {
    let idleTimer: NodeJS.Timeout | undefined;

    const clear = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const reset = (): void => {
      clear();
      idleTimer = setTimeout(() => {
        this.logger.error(`[${label}] Idle timeout after 300s, terminating stream`);
        onTimeout();
      }, this.streamIdleTimeoutMs);
    };

    return {
      reset,
      clear,
      dispose: () => {
        clear();
        this.destroyUpstreamStream(upstreamStream);
      },
    };
  }

  private createStreamHealthLifecycle(
    accountId: string,
    model: string,
    startedAt: number,
    releaseReservation?: () => void,
    sessionKey?: string,
    sessionGeneration?: number,
    expectedBreakerGeneration?: number,
    ownerRequestId?: string,
    tableIncarnation?: number,
    retryState?: ProxyTokenRetryState,
  ): StreamHealthLifecycle {
    let hasMarkedSuccess = false;
    let hasRecordedFailure = false;
    let hasCleanedUp = false;

    const cleanup = (): void => {
      if (hasCleanedUp) {
        return;
      }
      hasCleanedUp = true;
      if (retryState) {
        this.retryPolicy.disposeTokenRetryState(retryState);
      }
      releaseReservation?.();
    };

    return {
      markUsableOutput: () => {
        if (hasMarkedSuccess) {
          return true;
        }
        const commitResult = this.retryPolicy.markUpstreamSuccess(
          accountId,
          model,
          sessionKey,
          sessionGeneration,
          expectedBreakerGeneration,
          ownerRequestId,
          tableIncarnation,
          retryState,
        );
        if (commitResult.kind === 'rejected') {
          return false;
        }
        hasMarkedSuccess = true;
        if (retryState) {
          this.retryPolicy.stopMigrationRenewal(retryState);
        }
        this.accountLeaseService.recordPerformanceSuccess?.(
          accountId,
          model,
          performance.now() - startedAt,
        );
        return true;
      },
      recordFailure: (error: unknown) => {
        cleanup();
        if (getUpstreamRequestCancellation(error) || hasRecordedFailure) {
          return;
        }
        hasRecordedFailure = true;
        observeUpstreamStreamFailure(accountId, model);
        if (!hasMarkedSuccess) {
          this.recordPerformanceFailureForAttempt(accountId, model, error);
        }
        this.recordBoundedStreamPenalty(accountId, model, error);
      },
      cleanup,
    };
  }

  private markUpstreamSuccess(
    accountId: string,
    model: string,
    sessionKey?: string,
    retryState?: ProxyTokenRetryState,
  ): AffinityCommitResult {
    retryState?.activeReservation?.();
    if (retryState) {
      retryState.activeReservation = undefined;
    }
    const commitResult = this.retryPolicy.markUpstreamSuccess(
      accountId,
      model,
      sessionKey,
      retryState?.sessionGeneration,
      retryState?.breakerGeneration,
      retryState?.requestId,
      retryState?.tableIncarnation,
      retryState,
    );
    this.accountLeaseService.recordPerformanceSuccess?.(accountId, model);
    return commitResult;
  }

  private async executeUpstreamAttempt<T>(
    accountId: string,
    model: string,
    request: () => Promise<T>,
  ): Promise<UpstreamAttempt<T>> {
    const startedAt = performance.now();
    try {
      return { result: await request(), startedAt };
    } catch (error) {
      this.recordPerformanceFailureForAttempt(accountId, model, error);
      throw error;
    }
  }

  private recordPerformanceFailureForAttempt(accountId: string, model: string, error: unknown): void {
    if (!isPerformanceFailure(error)) {
      return;
    }
    this.accountLeaseService.recordPerformanceFailure?.(accountId, model);
  }

  private recordBoundedStreamPenalty(accountId: string, model: string, error: unknown): void {
    // Caller cancellation ends this request without marking the upstream account unhealthy.
    if (getUpstreamRequestCancellation(error)) return;
    const penaltyError =
      error instanceof UpstreamRequestError
        ? error
        : new UpstreamRequestError({
            status: HttpStatus.SERVICE_UNAVAILABLE,
            reason: 'upstream_error',
          });
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.streamPenaltyTimeoutMs);
    });

    void Promise.race([this.applyUpstreamPenalty(accountId, model, penaltyError), timeoutPromise])
      .then(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
      })
      .catch(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.logger.warn('Unable to record stream health penalty');
      });
  }

  private createTokenRetryState(signal?: AbortSignal): ProxyTokenRetryState {
    return this.retryPolicy.createTokenRetryState(signal);
  }

  private async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    return this.retryPolicy.selectRetryToken(retryState, model, sessionKey);
  }

  private async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
  ): Promise<void> {
    await this.retryPolicy.waitBeforeRetry(attemptIndex, maxRetries, label);
  }

  private async getModelRetryBudget(model: string): Promise<number> {
    const accountCount = await this.accountLeaseService.getRefreshedModelCapableAccountCount(model);
    if (accountCount === 0) {
      throw new AccountPoolUnavailableException(
        'No account advertises a compatible upstream model.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return accountCount;
  }

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
    clientSignal?: AbortSignal,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const sessionKey = this.extractAnthropicSessionKey(request);

    const targetModel = this.resolveTargetModel(request.model);
    if (
      request.messages.at(-1)?.role === 'assistant' &&
      !supportsAnthropicAssistantPrefill(targetModel)
    ) {
      throw this.invalidOpenAIRequest(
        'Final assistant prefill is not supported for this model.',
        'messages',
      );
    }
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(`Anthropic request received: operation=anthropic_request stream=${request.stream}`);

    // Retry loop
    let lastError: unknown = null;
    const maxRetries = await this.getModelRetryBudget(targetModel);
    const retryState = this.createTokenRetryState(clientSignal);
    let streamTransferred = false;

    try {
      for (let i = 0; i < maxRetries; i++) {
        await this.waitBeforeRetry(i, maxRetries, 'Anthropic');

        const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
        if (!token) {
          if (lastError) {
            throw lastError;
          }
          throw new AccountPoolUnavailableException(
            'All model-capable accounts are exhausted or rate limited',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
          token.id,
          targetModel,
        );

        const signatureContext: SignatureContext = {
          accountId: token.id,
          model: effectiveTargetModel,
        };

        try {
          const projectId = token.token.project_id ?? '';
          const requestUserAgent = await resolveRequestUserAgent();
          const geminiBody = transformClaudeRequestIn(
            this.toClaudeRequest(request),
            projectId,
            requestUserAgent,
            signatureContext,
          );
          geminiBody.model = effectiveTargetModel;
          this.applyInternalGenerationConstraints(geminiBody, effectiveTargetModel, token.id);

          if (request.stream) {
            const { result: stream, startedAt } = await this.executeUpstreamAttempt(
              token.id,
              effectiveTargetModel,
              () => this.geminiClient.streamGenerateInternal(
                geminiBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
                token.id, retryState.upstreamSignal,
              ),
            );
            const streamHealth = this.createStreamHealthLifecycle(
              token.id,
              effectiveTargetModel,
              startedAt,
              token.releaseReservation,
              sessionKey,
              retryState.sessionGeneration,
              retryState.breakerGeneration,
              retryState.requestId,
              retryState.tableIncarnation,
              retryState,
            );
            retryState.activeReservation = undefined;
            streamTransferred = true;
            return this.processAnthropicInternalStream(
              stream,
              geminiBody.model,
              streamHealth,
              signatureContext,
              request.model,
            );
          } else {
            const { result: response } = await this.generateInternalWithStreamFallback(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              token.id,
              effectiveTargetModel, retryState.upstreamSignal,
            );
            const commitResult = this.markUpstreamSuccess(token.id, effectiveTargetModel, sessionKey, retryState);
            if (commitResult.kind === 'rejected') {
              throw new HttpException(
                `Session affinity confirmation rejected: ${commitResult.reason}`,
                HttpStatus.CONFLICT,
              );
            }
            return this.toAnthropicChatResponse(
              transformResponse(response, signatureContext, request.model),
            );
          }
        } catch (error) {
          let effectiveError: unknown = error;
          if (this.isQuotaExhaustedError(error)) {
            this.logger.warn(
              'Anthropic request retrying with fallback: operation=anthropic_request reason=quota_exhausted',
            );
            try {
              const downgradedRequest: ClaudeRequest = {
                ...this.toClaudeRequest(request),
                model: 'gemini-3-flash',
              };
              const requestUserAgent = await resolveRequestUserAgent();
              const downgradedSignatureContext: SignatureContext = {
                accountId: token.id,
                model: 'gemini-3-flash',
              };
              const downgradedBody = transformClaudeRequestIn(
                downgradedRequest,
                token.token.project_id ?? '',
                requestUserAgent,
                downgradedSignatureContext,
              );
              downgradedBody.model = 'gemini-3-flash';
              this.applyInternalGenerationConstraints(downgradedBody, 'gemini-3-flash', token.id);

              if (request.stream) {
                const { result: stream, startedAt } = await this.executeUpstreamAttempt(
                  token.id,
                  'gemini-3-flash',
                  () => this.geminiClient.streamGenerateInternal(
                    downgradedBody,
                    token.token.access_token,
                    token.token.upstream_proxy_url,
                    extraHeaders,
                    token.id, retryState.upstreamSignal,
                  ),
                );
                const streamHealth = this.createStreamHealthLifecycle(
                  token.id,
                  'gemini-3-flash',
                  startedAt,
                  token.releaseReservation,
                  sessionKey,
                  retryState.sessionGeneration,
                  retryState.breakerGeneration,
                  retryState.requestId,
                  retryState.tableIncarnation,
                  retryState,
                );
                retryState.activeReservation = undefined;
                streamTransferred = true;
                return this.processAnthropicInternalStream(
                  stream,
                  downgradedBody.model,
                  streamHealth,
                  downgradedSignatureContext,
                  request.model,
                );
              } else {
                const { result: response } = await this.generateInternalWithStreamFallback(
                  downgradedBody,
                  token.token.access_token,
                  token.token.upstream_proxy_url,
                  extraHeaders,
                  token.id,
                  'gemini-3-flash', retryState.upstreamSignal,
                );
                const commitResult = this.markUpstreamSuccess(token.id, 'gemini-3-flash', sessionKey, retryState);
                if (commitResult.kind === 'rejected') {
                  throw new HttpException(
                    `Session affinity confirmation rejected: ${commitResult.reason}`,
                    HttpStatus.CONFLICT,
                  );
                }
                const transformed = this.toAnthropicChatResponse(
                  transformResponse(response, downgradedSignatureContext, request.model),
                );
                return {
                  ...transformed,
                  model: request.model,
                };
              }
            } catch (downgradeErr) {
              effectiveError = downgradeErr;
            }
          }

          lastError = effectiveError;
          const shouldRetry = await this.applyUpstreamPenalty(
            token.id,
            effectiveTargetModel,
            lastError,
            retryState,
          );
          if (!shouldRetry) {
            throw lastError;
          }
        }
      }
      throw lastError || new Error('Request failed after retries');
    } finally {
      if (!streamTransferred) {
        this.retryPolicy.disposeTokenRetryState(retryState);
      }
    }
  }

  private processAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    streamHealth: StreamHealthLifecycle,
    signatureContext?: SignatureContext,
    publicModelFallback: string = model,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState(publicModelFallback);
      const processor = new PartProcessor(state, signatureContext);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: Record<string, unknown> | undefined;

      let hasUsableEvent = false;
      let terminated = false;

      const cleanup = (): void => {
        idleTimer.clear();
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('error', onError);
        streamHealth.cleanup?.();
      };

      const failStream = (error: Error, destroyUpstream = false): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        cleanup();
        const canceled = getUpstreamRequestCancellation(error);
        if (destroyUpstream || canceled) {
          this.destroyUpstreamStream(upstreamStream);
        }
        streamHealth.recordFailure(canceled ?? error);
        subscriber.error(canceled ?? new Error('Upstream stream failed'));
      };

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          return;
        }
        const dataStr = trimmed.slice('data:'.length).trim();
        if (dataStr.length === 0 || dataStr === '[DONE]') {
          return;
        }

        try {
          const rawPayload = JSON.parse(dataStr);
          const upstreamError = this.getUpstreamStreamError(rawPayload);
          if (upstreamError) {
            failStream(upstreamError, true);
            return;
          }
          const json = unwrapInternalGeminiResponse(rawPayload);

          const candidate = json?.candidates?.[0];
          const parts = candidate?.content?.parts;
          const normalizedParts = Array.isArray(parts)
            ? parts.flatMap((part) => {
                const normalizedPart = this.normalizeGeminiPart(part);
                return normalizedPart ? [normalizedPart] : [];
              })
            : [];
          const hasGrounding = state.recordGroundingMetadata(candidate?.groundingMetadata);
          const hasUsableCandidate = hasGrounding || normalizedParts.length > 0;

          if (candidate?.finishReason) {
            lastFinishReason = candidate.finishReason;
          }
          if (json?.usageMetadata) {
            lastUsageMetadata = json.usageMetadata;
          }

          if (hasUsableCandidate) {
            const startMsg = state.emitMessageStart(json);
            if (startMsg) {
              if (!streamHealth.markUsableOutput()) {
                failStream(new Error('Session affinity confirmation rejected'), true);
                return;
              }
              hasUsableEvent = true;
              subscriber.next(startMsg);
            }

            for (const part of normalizedParts) {
              const chunks = processor.process(part);
              chunks.forEach((chunk) => subscriber.next(chunk));
            }
          }

          state.resetErrorState();
        } catch (error) {
          if (
            error instanceof ToolCallIdConflictError ||
            error instanceof InvalidFunctionCallArgumentsError
          ) {
            failStream(error, true);
            return;
          }
          void error;
          this.logger.error('Stream parse error: operation=anthropic_stream reason=invalid_payload');
          const errorChunks = state.handleParseError(dataStr);
          errorChunks.forEach((chunk) => subscriber.next(chunk));
          if (state.getErrorCount() > 3) {
            failStream(new Error('Malformed upstream stream payload'), true);
          }
        }
      };

      const onData = (chunk: Buffer): void => {
        if (terminated) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (terminated) {
            return;
          }
          processLine(line);
        }
      };

      const onEnd = (): void => {
        if (terminated) {
          return;
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          processLine(buffer);
        }
        if (terminated) {
          return;
        }
        if (!hasUsableEvent || !state.messageStartSent) {
          this.logger.warn('Upstream stream ended without a usable Anthropic message start');
          failStream(new Error('Empty response stream'));
          return;
        }

        const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
        finishChunks.forEach((c) => subscriber.next(c));
        terminated = true;
        cleanup();
        subscriber.complete();
      };

      const onError = (err: unknown): void => {
        const canceled = getUpstreamRequestCancellation(err);
        if (!canceled) this.logger.error('Stream error: operation=anthropic_stream reason=upstream_error');
        failStream(canceled ?? new Error('Upstream stream failed'));
      };

      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Claude-SSE', () => {
        failStream(new Error('Upstream stream idle timeout after 300s'), true);
      });

      upstreamStream.on('data', onData);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('error', onError);
      idleTimer.reset();

      return () => {
        if (terminated) {
          return;
        }
        terminated = true;
        cleanup();
        this.destroyUpstreamStream(upstreamStream);
      };
    });
  }

  // --- OpenAI / Universal Handlers ---
  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    clientSignal?: AbortSignal,
  ): Promise<GeminiResponse> {
    return this.handlePreflightedGeminiGenerateContent(
      model,
      preflightNativeGeminiRequest(request),
      clientSignal,
    );
  }

  /** Controller callers must run the shared structural preflight before invoking this method. */
  async handlePreflightedGeminiGenerateContent(
    model: string,
    preflightRequest: GeminiInternalRequest['request'],
    clientSignal?: AbortSignal,
  ): Promise<GeminiResponse> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const targetModel = this.resolveTargetModel(normalizedModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log('Gemini generate request received: operation=gemini_generate');

    let lastError: unknown = null;
    const maxRetries = await this.getModelRetryBudget(targetModel);
    const retryState = this.createTokenRetryState(clientSignal);

    try {
      for (let i = 0; i < maxRetries; i++) {
        await this.waitBeforeRetry(i, maxRetries, 'Gemini');

        const token = await this.selectRetryToken(retryState, targetModel);
        if (!token) {
          if (lastError) {
            throw lastError;
          }
          throw new AccountPoolUnavailableException(
            'All model-capable accounts are exhausted or rate limited',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
          token.id,
          targetModel,
        );

        try {
          const requestUserAgent = await resolveRequestUserAgent();
          const internalBody = this.createGeminiInternalRequest(
            effectiveTargetModel,
            preflightRequest,
            token.token.project_id ?? '',
            'generate-content',
            requestUserAgent,
            { accountId: token.id, model: effectiveTargetModel },
          );
          this.applyInternalGenerationConstraints(internalBody, effectiveTargetModel, token.id);

          const { result: response } = await this.generateInternalWithStreamFallback(
            internalBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
            token.id,
            effectiveTargetModel, retryState.upstreamSignal,
          );

          const commitResult = this.markUpstreamSuccess(token.id, effectiveTargetModel, undefined, retryState);
          if (commitResult.kind === 'rejected') {
            throw new HttpException(
              `Session affinity confirmation rejected: ${commitResult.reason}`,
              HttpStatus.CONFLICT,
            );
          }
          return this.normalizeGeminiGenerateResponse(response);
        } catch (err) {
          if (err instanceof BadRequestException) {
            throw err;
          }
          lastError = err;

          const shouldRetry = await this.applyUpstreamPenalty(
            token.id,
            effectiveTargetModel,
            lastError,
            retryState,
          );
          if (!shouldRetry) {
            throw lastError;
          }
        }
      }

      throw lastError || new Error('Gemini request failed after retries');
    } finally {
      this.retryPolicy.disposeTokenRetryState(retryState);
    }
  }

  async handleGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
    clientSignal?: AbortSignal,
  ): Promise<Observable<string>> {
    return this.handlePreflightedGeminiStreamGenerateContent(
      model,
      preflightNativeGeminiRequest(request),
      clientSignal,
    );
  }

  /** Controller callers must run the shared structural preflight before invoking this method. */
  async handlePreflightedGeminiStreamGenerateContent(
    model: string,
    preflightRequest: GeminiInternalRequest['request'],
    clientSignal?: AbortSignal,
  ): Promise<Observable<string>> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const targetModel = this.resolveTargetModel(normalizedModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log('Gemini stream request received: operation=gemini_stream');

    let lastError: unknown = null;
    const maxRetries = await this.getModelRetryBudget(targetModel);
    const retryState = this.createTokenRetryState(clientSignal);
    let streamTransferred = false;

    try {
      for (let i = 0; i < maxRetries; i++) {
        await this.waitBeforeRetry(
          i,
          maxRetries,
          'Gemini stream',
        );

        const token = await this.selectRetryToken(retryState, targetModel);
        if (!token) {
          if (lastError) {
            throw lastError;
          }
          throw new AccountPoolUnavailableException(
            'All model-capable accounts are exhausted or rate limited',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
          token.id,
          targetModel,
        );

        try {
          const requestUserAgent = await resolveRequestUserAgent();
          const internalBody = this.createGeminiInternalRequest(
            effectiveTargetModel,
            preflightRequest,
            token.token.project_id ?? '',
            'generate-content',
            requestUserAgent,
            { accountId: token.id, model: effectiveTargetModel },
          );
          this.applyInternalGenerationConstraints(internalBody, effectiveTargetModel, token.id);

          const { result: stream, startedAt } = await this.executeUpstreamAttempt(
            token.id,
            effectiveTargetModel,
            () => this.geminiClient.streamGenerateInternal(
              internalBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              token.id, retryState.upstreamSignal,
            ),
          );
          const streamHealth = this.createStreamHealthLifecycle(
            token.id,
            effectiveTargetModel,
            startedAt,
            token.releaseReservation,
            undefined,
            retryState.sessionGeneration,
            retryState.breakerGeneration,
            retryState.requestId,
            retryState.tableIncarnation,
            retryState,
          );
          retryState.activeReservation = undefined;
          streamTransferred = true;
          return this.passthroughSseStream(
            stream,
            streamHealth,
          );
        } catch (err) {
          if (err instanceof BadRequestException) {
            throw err;
          }
          lastError = err;

          const shouldRetry = await this.applyUpstreamPenalty(
            token.id,
            effectiveTargetModel,
            lastError,
            retryState,
          );
          if (!shouldRetry) {
            throw lastError;
          }
        }
      }

      throw lastError || new Error('Gemini stream request failed after retries');
    } finally {
      if (!streamTransferred) {
        this.retryPolicy.disposeTokenRetryState(retryState);
      }
    }
  }

  private passthroughSseStream(
    upstreamStream: NodeJS.ReadableStream,
    streamHealth: StreamHealthLifecycle,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedUsableOutput = false;
      let terminated = false;

      const cleanup = (): void => {
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('error', onError);
        idleTimer.dispose();
        streamHealth.cleanup?.();
      };

      const terminate = (): boolean => {
        if (terminated) {
          return false;
        }
        terminated = true;
        cleanup();
        return true;
      };

      const failStream = (error: unknown): void => {
        if (!terminate()) {
          return;
        }
        const safeError = getUpstreamRequestCancellation(error) ?? new Error('Upstream stream failed');
        streamHealth.recordFailure(error instanceof UpstreamRequestError ? error : safeError);
        subscriber.error(safeError);
      };
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-SSE', () => {
        failStream(new Error('Upstream stream idle timeout after 300s'));
      });

      idleTimer.reset();

      const processFrame = (frame: string): void => {
        const validation = this.validateNativeGeminiSseFrame(frame);
        if (validation.error) {
          failStream(validation.error);
          return;
        }
        if (validation.hasUsableOutput) {
          if (!streamHealth.markUsableOutput()) {
            failStream(new Error('Session affinity confirmation rejected'));
            return;
          }
          receivedUsableOutput = true;
        }
        subscriber.next(frame);
      };

      const findCompletedFrameEnd = (allowTrailingCr: boolean): number => {
        let lineStart = 0;
        for (let index = 0; index < buffer.length; index += 1) {
          const character = buffer[index];
          if (character !== '\r' && character !== '\n') {
            continue;
          }

          if (character === '\r' && index + 1 === buffer.length && !allowTrailingCr) {
            return -1;
          }
          const lineEndingLength = character === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
          if (index === lineStart) {
            return index + lineEndingLength;
          }
          lineStart = index + lineEndingLength;
          index += lineEndingLength - 1;
        }
        return -1;
      };

      const processCompletedFrames = (allowTrailingCr = false): void => {
        let frameEnd: number;
        while ((frameEnd = findCompletedFrameEnd(allowTrailingCr)) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd);
          processFrame(frame);
          if (terminated) {
            return;
          }
        }
      };

      const onData = (chunk: Buffer): void => {
        if (terminated) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        processCompletedFrames();
      };

      const onEnd = (): void => {
        if (terminated) {
          return;
        }
        buffer += decoder.decode();
        processCompletedFrames(true);
        if (!terminated && buffer.length > 0) {
          processFrame(buffer);
          buffer = '';
        }
        if (terminated) {
          return;
        }
        if (!receivedUsableOutput) {
          failStream(new Error('Empty response stream'));
          return;
        }
        terminate();
        subscriber.complete();
      };

      const onError = (err: unknown): void => {
        failStream(getUpstreamRequestCancellation(err) ?? new Error('Upstream stream failed'));
      };

      upstreamStream.on('data', onData);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('error', onError);

      return () => {
        terminate();
      };
    });
  }

  private validateNativeGeminiSseFrame(frame: string): {
    error?: UpstreamRequestError;
    hasUsableOutput: boolean;
  } {
    const data = this.getSseFrameData(frame);
    if (data === null || data.length === 0 || data === '[DONE]') {
      return { hasUsableOutput: false };
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(data);
    } catch {
      return {
        error: new UpstreamRequestError({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          reason: 'upstream_error',
        }),
        hasUsableOutput: false,
      };
    }

    const upstreamError = this.getUpstreamStreamError(rawPayload);
    if (upstreamError) {
      return { error: upstreamError, hasUsableOutput: false };
    }

    const response = unwrapInternalGeminiResponse(rawPayload);
    if (!this.isValidGeminiFallbackFrame(response)) {
      return {
        error: new UpstreamRequestError({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          reason: 'upstream_error',
        }),
        hasUsableOutput: false,
      };
    }

    const hasUsableOutput = response.candidates?.some((candidate) => {
      const parts = candidate.content?.parts;
      return (
        (Array.isArray(parts) && parts.some((part) => this.normalizeGeminiPart(part))) ||
        Boolean(candidate.groundingMetadata) ||
        (isString(candidate.finishReason) && candidate.finishReason.length > 0)
      );
    }) ?? false;
    return { hasUsableOutput };
  }

  private getSseFrameData(frame: string): string | null {
    const dataLines = frame
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        const value = line.slice('data:'.length);
        return value.startsWith(' ') ? value.slice(1) : value;
      });
    return dataLines.length > 0 ? dataLines.join('\n') : null;
  }

  private normalizeGeminiModel(model: string): string {
    return this.modelRoutingPolicy.normalizeGeminiModel(model);
  }

  private applyInternalGenerationConstraints(
    body: GeminiInternalRequest,
    model: string,
    accountId: string,
  ): void {
    this.generationConstraints.applyInternalGenerationConstraints(body, model, accountId);
    const safetySettings = resolveSafetySettings(model);
    if (safetySettings.length === 0) {
      delete body.request.safetySettings;
      return;
    }
    body.request.safetySettings = safetySettings;
  }

  private createGeminiInternalRequest(
    model: string,
    request: GeminiInternalRequest['request'],
    projectId: string | undefined,
    requestType: string,
    requestUserAgent: string,
    signatureContext?: SignatureContext,
  ): GeminiInternalRequest {
    const normalizedProjectId = projectId?.trim();

    const internalRequest: GeminiInternalRequest = {
      requestId: this.createOfficialRequestId(),
      request: this.applyNativeGeminiSignatureTransform(request, model, signatureContext),
      model,
      userAgent: requestUserAgent,
      requestType,
    };

    if (normalizedProjectId) {
      internalRequest.project = normalizedProjectId;
    }

    if (requestType !== 'image_gen') {
      internalRequest.enabledCreditTypes = ['GOOGLE_ONE_AI'];
    }

    return internalRequest;
  }

  private normalizeGeminiGenerateResponse(response: GeminiResponse): GeminiResponse {
    const candidates = Array.isArray(response.candidates)
      ? response.candidates.map((candidate, index) => ({
          content: candidate?.content,
          finishReason: candidate?.finishReason,
          index: isNumber(candidate?.index) ? candidate.index : index,
        }))
      : [];

    const normalized: GeminiResponse = {
      candidates,
    };

    const usage = response.usageMetadata;
    if (usage) {
      const usageMetadata: NonNullable<GeminiResponse['usageMetadata']> = {};
      if (usage.promptTokenCount !== undefined) {
        usageMetadata.promptTokenCount = usage.promptTokenCount;
      }
      if (usage.candidatesTokenCount !== undefined) {
        usageMetadata.candidatesTokenCount = usage.candidatesTokenCount;
      }
      if (usage.totalTokenCount !== undefined) {
        usageMetadata.totalTokenCount = usage.totalTokenCount;
      }
      if (usage.promptTokensDetails !== undefined) {
        usageMetadata.promptTokensDetails = usage.promptTokensDetails;
      }
      if (usage.candidatesTokensDetails !== undefined) {
        usageMetadata.candidatesTokensDetails = usage.candidatesTokensDetails;
      }
      if (usage.trafficType !== undefined) {
        usageMetadata.trafficType = usage.trafficType;
      }
      if (!isEmpty(usageMetadata)) {
        normalized.usageMetadata = usageMetadata;
      }
    }

    return normalized;
  }

  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
    responsesConfiguration?: OpenAIResponsesConfiguration,
    clientSignal?: AbortSignal,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const sessionKey = this.extractOpenAISessionKey(request);

    const targetModel = this.resolveTargetModel(request.model);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `OpenAI-compatible request received: operation=openai_request stream=${request.stream}`,
    );

    // Deterministic request conversion happens before any account is leased so a local
    // mapping failure never selects an account or penalizes one.
    const claudeRequest = this.convertOpenAIToClaude(request);
    const streamOptions = this.resolveOpenAIStreamOptions(request, outputProtocol);

    // Retry loop for account selection
    let lastError: unknown = null;
    const maxRetries = await this.getModelRetryBudget(targetModel);
    const retryState = this.createTokenRetryState(clientSignal);
    let streamTransferred = false;

    try {
      for (let i = 0; i < maxRetries; i++) {
        await this.waitBeforeRetry(
          i,
          maxRetries,
          'OpenAI-compatible',
        );

        // 1. Get Token
        const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
        if (!token) {
          if (lastError) {
            throw lastError;
          }
          throw new AccountPoolUnavailableException(
            'All model-capable accounts are exhausted or rate limited',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
          token.id,
          targetModel,
        );

        const signatureContext: SignatureContext = {
          accountId: token.id,
          model: effectiveTargetModel,
        };

        try {
          const projectId = token.token.project_id ?? '';
          const requestUserAgent = await resolveRequestUserAgent();
          const geminiBody = transformClaudeRequestIn(
            claudeRequest,
            projectId,
            requestUserAgent,
            signatureContext,
          );
          geminiBody.model = effectiveTargetModel;
          this.applyInternalGenerationConstraints(geminiBody, effectiveTargetModel, token.id);

          // Use v1internal API (same as Anthropic handler)
          if (request.stream) {
            try {
              const { result: stream, startedAt } = await this.executeUpstreamAttempt(
                token.id,
                effectiveTargetModel,
                () => this.geminiClient.streamGenerateInternal(
                  geminiBody,
                  token.token.access_token,
                  token.token.upstream_proxy_url,
                  extraHeaders,
                  token.id, retryState.upstreamSignal,
                ),
              );
              const streamHealth = this.createStreamHealthLifecycle(
                token.id,
                effectiveTargetModel,
                startedAt,
                token.releaseReservation,
                sessionKey,
                retryState.sessionGeneration,
                retryState.breakerGeneration,
                retryState.requestId,
                retryState.tableIncarnation,
                retryState,
              );
              retryState.activeReservation = undefined;
              streamTransferred = true;
              return this.createOpenAIProtocolStream(
                stream,
                request.model,
                outputProtocol,
                streamOptions,
                signatureContext,
                responsesConfiguration,
                streamHealth,
              );
            } catch (streamError) {
              if ((streamError instanceof Error && streamError.name === 'AbortError') || this.retryPolicy.shouldFailoverImmediately(streamError)) {
                throw streamError;
              }
              this.logger.warn(
                'Stream path fallback: operation=openai_request reason=stream_to_non_stream',
              );

              const { result: response } = await this.generateInternalWithStreamFallback(
                geminiBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
                token.id,
                effectiveTargetModel, retryState.upstreamSignal,
              );
              const commitResult = this.markUpstreamSuccess(token.id, effectiveTargetModel, sessionKey, retryState);
              if (commitResult.kind === 'rejected') {
                throw new HttpException(
                  `Session affinity confirmation rejected: ${commitResult.reason}`,
                  HttpStatus.CONFLICT,
                );
              }
              const claudeResponse = transformResponse(response, signatureContext);
              const openaiResponse = this.convertClaudeToOpenAIResponse(
                claudeResponse,
                request.model,
                response.usageMetadata,
                outputProtocol,
              );
              streamTransferred = true;
              return outputProtocol === 'responses'
                ? this.createSyntheticResponsesStream(openaiResponse, responsesConfiguration)
                : this.createSyntheticOpenAIStream(openaiResponse, streamOptions);
            }
          } else {
            const { result: response } = await this.generateInternalWithStreamFallback(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              token.id,
              effectiveTargetModel, retryState.upstreamSignal,
            );
            const commitResult = this.markUpstreamSuccess(token.id, effectiveTargetModel, sessionKey, retryState);
            if (commitResult.kind === 'rejected') {
              throw new HttpException(
                `Session affinity confirmation rejected: ${commitResult.reason}`,
                HttpStatus.CONFLICT,
              );
            }
            // Transform Gemini response to OpenAI format
            const claudeResponse = transformResponse(response, signatureContext);
            return this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              response.usageMetadata,
              outputProtocol,
            );
          }
        } catch (err) {
          lastError = err;

          const shouldRetry = await this.applyUpstreamPenalty(
            token.id,
            effectiveTargetModel,
            lastError,
            retryState,
          );
          if (!shouldRetry) {
            throw lastError;
          }
        }
      }
      throw lastError || new Error('Request failed after retries');
    } finally {
      if (!streamTransferred) {
        this.retryPolicy.disposeTokenRetryState(retryState);
      }
    }
  }

  private async generateInternalWithStreamFallback(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    accountId: string,
    effectiveModel: string, signal?: AbortSignal,
  ): Promise<UpstreamAttempt<GeminiResponse>> {
    const direct = await this.executeUpstreamAttempt(accountId, effectiveModel, () => this.geminiClient.generateInternal(
      body,
      accessToken,
      upstreamProxyUrl,
      extraHeaders,
      accountId, signal,
    ));
    if (this.hasUsableGeminiCandidate(direct.result)) {
      return direct;
    }

    this.recordPerformanceFailureForAttempt(
      accountId,
      effectiveModel,
      new UpstreamRequestError({ reason: 'upstream_error' }),
    );
    this.logger.warn('Empty non-stream response detected, falling back to stream aggregation.');
    return this.executeUpstreamAttempt(accountId, effectiveModel, async () => {
      const stream = await this.geminiClient.streamGenerateInternal(
        body,
        accessToken,
        upstreamProxyUrl,
        extraHeaders,
        accountId, signal,
      );
      return this.collectGeminiStreamAsResponse(stream);
    });
  }

  private hasUsableGeminiCandidate(response: GeminiResponse): boolean {
    const candidates = response?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return false;
    }

    const first = candidates[0];
    const parts = first?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return false;
    }
    for (const part of parts) {
      this.normalizeGeminiPart(part);
    }
    return true;
  }

  private getUpstreamStreamError(payload: unknown): UpstreamRequestError | null {
    const record = this.toUnknownRecord(payload);
    if (!record || !Object.hasOwn(record, 'error') || isNil(record.error)) {
      return null;
    }

    const error = record.error;
    const errorRecord = this.toUnknownRecord(error);
    if (errorRecord) {
      const status =
        this.normalizeUpstreamStreamStatus(errorRecord.code) ??
        this.normalizeUpstreamStreamStatus(errorRecord.status);
      return new UpstreamRequestError({
        status,
        headers: { retryAfter: this.extractUpstreamStreamRetryAfter(errorRecord, record) },
        reason: this.resolveUpstreamFailureReason(status),
      });
    }

    return new UpstreamRequestError({
      reason: 'upstream_error',
    });
  }

  private normalizeUpstreamStreamStatus(value: unknown): number | undefined {
    if (isNumber(value) && value >= 400 && value <= 599) {
      return value;
    }
    if (!isString(value)) {
      return undefined;
    }

    const normalized = value.trim().toUpperCase();
    if (/^[4-5]\d{2}$/.test(normalized)) {
      return Number(normalized);
    }
    return UPSTREAM_STREAM_STATUS_CODES[normalized];
  }

  private resolveUpstreamFailureReason(
    status: number | undefined,
  ): UpstreamRequestError['reason'] {
    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
      return 'authentication';
    }
    if (status === HttpStatus.NOT_FOUND) {
      return 'model_not_found';
    }
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return 'rate_limited';
    }
    return 'upstream_error';
  }

  private extractUpstreamStreamRetryAfter(
    error: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): string | undefined {
    for (const source of [
      error,
      this.toUnknownRecord(error.headers),
      payload,
      this.toUnknownRecord(payload.headers),
    ]) {
      if (!source) {
        continue;
      }
      const value = Object.entries(source).find(([name]) => {
        const normalized = name.toLowerCase();
        return normalized === 'retry-after' || normalized === 'retryafter' || normalized === 'retry_after';
      })?.[1];
      if (isString(value)) {
        return value;
      }
      if (Array.isArray(value) && isString(value[0])) {
        return value[0];
      }
    }
    return undefined;
  }

  private collectGeminiStreamAsResponse(
    upstreamStream: NodeJS.ReadableStream,
  ): Promise<GeminiResponse> {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedData = false;
      const mergedParts: InternalGeminiPart[] = [];
      let groundingMetadata: GroundingMetadata | undefined;
      const toolCallIdIntegrity = new ToolCallIdIntegrityTracker();
      let finishReason: string | undefined;
      let usageMetadata: GeminiResponse['usageMetadata'];
      let modelVersion: GeminiResponse['modelVersion'];
      let promptFeedback: GeminiResponse['promptFeedback'];
      let responseId: GeminiResponse['responseId'];
      let receivedCandidate = false;
      let receivedValidFrame = false;
      let settled = false;

      const cleanup = (): void => {
        idleTimer.clear();
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('error', onError);
      };

      const rejectOnce = (error: Error, destroyUpstream = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (destroyUpstream) {
          this.destroyUpstreamStream(upstreamStream);
        }
        reject(error);
      };

      const resolveOnce = (response: GeminiResponse): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      };

      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-Collect', () => {
        rejectOnce(new UpstreamRequestError({ reason: 'upstream_error' }), true);
      });

      const onData = (chunk: Buffer): void => {
        if (settled) {
          return;
        }
        receivedData = true;
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
          if (settled) {
            return;
          }
        }
      };

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          return;
        }

        const dataStr = trimmed.slice('data:'.length).trim();
        if (dataStr.length === 0 || dataStr === '[DONE]') {
          return;
        }

        try {
          const rawPayload = JSON.parse(dataStr);
          const upstreamError = this.getUpstreamStreamError(rawPayload);
          if (upstreamError) {
            rejectOnce(upstreamError, true);
            return;
          }
          const parsed = unwrapInternalGeminiResponse(rawPayload);
          if (!this.isValidGeminiFallbackFrame(parsed)) {
            rejectOnce(new UpstreamRequestError({ reason: 'upstream_error' }), true);
            return;
          }
          receivedValidFrame = true;

          const candidate = parsed?.candidates?.[0];
          if (candidate) {
            receivedCandidate = true;
          }
          groundingMetadata = this.mergeGroundingMetadata(
            groundingMetadata,
            candidate?.groundingMetadata,
          );
          const parts = candidate?.content?.parts;
          if (Array.isArray(parts)) {
            for (const rawPart of parts) {
              const part = this.normalizeGeminiPart(rawPart);
              if (!part) {
                continue;
              }
              if (
                part.functionCall &&
                toolCallIdIntegrity.record(
                  part.functionCall.id,
                  part.functionCall.name,
                  part.functionCall.args,
                ) === 'replay'
              ) {
                continue;
              }
              mergedParts.push(part);
            }
          }

          if (candidate?.finishReason) {
            finishReason = candidate.finishReason;
          }
          if (parsed?.usageMetadata) {
            usageMetadata = parsed.usageMetadata;
          }
          if (parsed.modelVersion) {
            modelVersion = parsed.modelVersion;
          }
          if (parsed.promptFeedback) {
            promptFeedback = parsed.promptFeedback;
          }
          if (parsed.responseId) {
            responseId = parsed.responseId;
          }
        } catch (error) {
          if (
            error instanceof ToolCallIdConflictError ||
            error instanceof InvalidFunctionCallArgumentsError
          ) {
            rejectOnce(new UpstreamRequestError({ reason: 'upstream_error' }), true);
            return;
          }
          rejectOnce(new UpstreamRequestError({ reason: 'upstream_error' }), true);
        }
      };

      const onEnd = (): void => {
        if (settled) {
          return;
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          processLine(buffer);
        }
        if (settled) {
          return;
        }
        if (!receivedData || !receivedValidFrame) {
          rejectOnce(new UpstreamRequestError({ reason: 'upstream_error' }));
          return;
        }

        resolveOnce({
          ...(receivedCandidate
            ? {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: mergedParts,
                    },
                    finishReason,
                    groundingMetadata,
                  },
                ],
              }
            : {}),
          ...(usageMetadata ? { usageMetadata } : {}),
          ...(modelVersion ? { modelVersion } : {}),
          ...(promptFeedback ? { promptFeedback } : {}),
          ...(responseId ? { responseId } : {}),
        });
      };

      const onError = (error: unknown): void => {
        const canceled = getUpstreamRequestCancellation(error);
        rejectOnce(
          canceled ??
            (error instanceof UpstreamRequestError
              ? error
              : new UpstreamRequestError({ reason: 'transport' })),
          Boolean(canceled),
        );
      };

      upstreamStream.on('data', onData);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('error', onError);
      idleTimer.reset();
    });
  }

  private isValidGeminiFallbackFrame(value: unknown): value is GeminiResponse {
    const frame = this.toUnknownRecord(value);
    if (!frame) {
      return false;
    }

    let hasValidResponseField = false;
    if (Object.hasOwn(frame, 'candidates')) {
      if (!this.hasValidGeminiFallbackCandidates(frame.candidates)) {
        return false;
      }
      hasValidResponseField = true;
    }
    if (Object.hasOwn(frame, 'usageMetadata')) {
      if (!this.isValidGeminiFallbackUsageMetadata(frame.usageMetadata)) {
        return false;
      }
      hasValidResponseField = true;
    }
    if (Object.hasOwn(frame, 'promptFeedback')) {
      if (!this.isValidGeminiFallbackPromptFeedback(frame.promptFeedback)) {
        return false;
      }
      hasValidResponseField = true;
    }
    for (const field of ['modelVersion', 'responseId'] as const) {
      if (Object.hasOwn(frame, field)) {
        if (!isString(frame[field]) || isEmpty(frame[field].trim())) {
          return false;
        }
        hasValidResponseField = true;
      }
    }
    return hasValidResponseField;
  }

  private hasValidGeminiFallbackCandidates(value: unknown): boolean {
    if (!Array.isArray(value) || value.length === 0) {
      return false;
    }
    return value.every((candidate) => this.isValidGeminiFallbackCandidate(candidate));
  }

  private isValidGeminiFallbackCandidate(value: unknown): boolean {
    const candidate = this.toUnknownRecord(value);
    if (!candidate) {
      return false;
    }

    let hasValidCandidateField = false;
    if (Object.hasOwn(candidate, 'content')) {
      const content = this.toUnknownRecord(candidate.content);
      if (
        !content ||
        !Array.isArray(content.parts) ||
        content.parts.length === 0 ||
        !content.parts.every((part) => this.isGeminiPart(part)) ||
        (Object.hasOwn(content, 'role') && !isString(content.role))
      ) {
        return false;
      }
      hasValidCandidateField = true;
    }
    if (Object.hasOwn(candidate, 'finishReason')) {
      if (!isString(candidate.finishReason) || isEmpty(candidate.finishReason.trim())) {
        return false;
      }
      hasValidCandidateField = true;
    }
    if (Object.hasOwn(candidate, 'finishMessage') && !isString(candidate.finishMessage)) {
      return false;
    }
    if (Object.hasOwn(candidate, 'index') && !isNumber(candidate.index)) {
      return false;
    }
    if (Object.hasOwn(candidate, 'safetyRatings')) {
      if (!Array.isArray(candidate.safetyRatings) || !candidate.safetyRatings.every(isPlainObject)) {
        return false;
      }
      hasValidCandidateField = true;
    }
    if (Object.hasOwn(candidate, 'groundingMetadata')) {
      if (!this.toUnknownRecord(candidate.groundingMetadata)) {
        return false;
      }
      hasValidCandidateField = true;
    }
    return hasValidCandidateField;
  }

  private isValidGeminiFallbackUsageMetadata(value: unknown): boolean {
    const usage = this.toUnknownRecord(value);
    if (!usage) {
      return false;
    }

    const numericFields = [
      'promptTokenCount',
      'candidatesTokenCount',
      'totalTokenCount',
      'thoughtsTokenCount',
    ] as const;
    const detailFields = ['promptTokensDetails', 'candidatesTokensDetails'] as const;
    let hasValidUsageField = false;
    for (const field of numericFields) {
      if (Object.hasOwn(usage, field)) {
        if (!isNumber(usage[field])) {
          return false;
        }
        hasValidUsageField = true;
      }
    }
    for (const field of detailFields) {
      if (Object.hasOwn(usage, field)) {
        if (!Array.isArray(usage[field]) || !usage[field].every(isPlainObject)) {
          return false;
        }
        hasValidUsageField = true;
      }
    }
    if (Object.hasOwn(usage, 'trafficType')) {
      if (!isString(usage.trafficType)) {
        return false;
      }
      hasValidUsageField = true;
    }
    return hasValidUsageField;
  }

  private isValidGeminiFallbackPromptFeedback(value: unknown): boolean {
    const promptFeedback = this.toUnknownRecord(value);
    if (!promptFeedback) {
      return false;
    }

    let hasValidPromptFeedbackField = false;
    if (Object.hasOwn(promptFeedback, 'blockReason')) {
      if (!isString(promptFeedback.blockReason) || isEmpty(promptFeedback.blockReason.trim())) {
        return false;
      }
      hasValidPromptFeedbackField = true;
    }
    if (Object.hasOwn(promptFeedback, 'safetyRatings')) {
      if (
        !Array.isArray(promptFeedback.safetyRatings) ||
        !promptFeedback.safetyRatings.every(isPlainObject)
      ) {
        return false;
      }
      hasValidPromptFeedbackField = true;
    }
    return hasValidPromptFeedbackField;
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    streamOptions: OpenAIStreamOptions,
    signatureContext?: SignatureContext,
    responsesConfiguration?: OpenAIResponsesConfiguration,
    streamHealth?: StreamHealthLifecycle,
  ): Observable<string> {
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        signatureContext,
        responsesConfiguration,
        streamHealth,
      );
    }
    return this.processStreamResponse(
      upstreamStream,
      model,
      signatureContext,
      streamOptions,
      streamHealth,
    );
  }

  private resolveOpenAIStreamOptions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol,
  ): OpenAIStreamOptions {
    return {
      variant: outputProtocol === 'text-completions' ? 'text' : 'chat',
      includeUsage: request.stream_options?.include_usage === true,
      idPrefix: outputProtocol === 'text-completions' ? 'cmpl' : 'chatcmpl',
    };
  }

  /**
   * Maps upstream Gemini usage metadata onto the OpenAI usage shape, and only that.
   * Both the prompt and the candidates counters have to be real numbers before any
   * usage can be reported: empty or partial metadata returns null so no caller can put
   * an invented 0/0/0 on the wire. `thoughtsTokenCount` stays optional because upstreams
   * omit it for non-thinking models, where it is genuinely zero rather than unknown.
   */
  private mapGeminiUsageMetadata(usage: unknown): OpenAIStreamUsage | null {
    const record = this.toUnknownRecord(usage);
    if (!record) {
      return null;
    }

    const promptTokens = record.promptTokenCount;
    const candidatesTokens = record.candidatesTokenCount;
    if (!isNumber(promptTokens) || !isNumber(candidatesTokens)) {
      return null;
    }

    const thoughtsTokens = isNumber(record.thoughtsTokenCount) ? record.thoughtsTokenCount : 0;
    const completionTokens = candidatesTokens + thoughtsTokens;
    const totalTokens = isNumber(record.totalTokenCount)
      ? record.totalTokenCount
      : promptTokens + completionTokens;

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(thoughtsTokens > 0
        ? { completion_tokens_details: { reasoning_tokens: thoughtsTokens } }
        : {}),
    };
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureContext?: SignatureContext,
    responsesConfiguration?: OpenAIResponsesConfiguration,
    streamHealth?: StreamHealthLifecycle,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      let receivedUsableOutput = false;
      let lastFinishReason: string | undefined;
      const mapper = new OpenAIResponsesStreamingMapper({
        model,
        responseId: `resp_${uuidv4()}`,
        signatureContext,
        configuration: responsesConfiguration,
      });
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const cleanup = (): void => {
        clearHeartbeat();
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('error', onError);
        idleTimer.dispose();
        streamHealth?.cleanup?.();
      };

      const terminate = (): boolean => {
        if (completed) {
          return false;
        }
        completed = true;
        cleanup();
        return true;
      };

      const complete = (finishReason?: string): void => {
        if (!terminate()) {
          return;
        }
        if (streamHealth && !streamHealth.markUsableOutput()) {
          subscriber.error(new Error('Session affinity confirmation rejected'));
          return;
        }
        logUpstreamTerminalDiagnostic(getUpstreamDiagnosticContext(upstreamStream), 'terminal', finishReason);
        for (const event of mapper.complete(finishReason)) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      const fail = (
        message: string,
        code = 'upstream_error',
        error: Error = new UpstreamRequestError({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          reason: 'upstream_error',
        }),
      ): void => {
        if (!terminate()) {
          return;
        }
        const canceled = getUpstreamRequestCancellation(error);
        if (canceled) return subscriber.error(canceled);
        logUpstreamTerminalDiagnostic(getUpstreamDiagnosticContext(upstreamStream), 'failure');
        streamHealth?.recordFailure(error);
        for (const event of mapper.fail(message, code)) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      heartbeatTimer = setInterval(() => {
        if (!completed) {
          subscriber.next(': ping\n\n');
        }
      }, 15_000);
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-Responses-SSE', () =>
        fail('Upstream Responses stream timed out', 'stream_timeout'),
      );
      idleTimer.reset();

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          return;
        }
        const dataString = trimmed.slice('data:'.length).trim();
        if (dataString.length === 0 || dataString === '[DONE]') {
          return;
        }
        try {
          const payload = this.toUnknownRecord(JSON.parse(dataString));
          if (!payload) {
            fail('Upstream Responses stream payload was not an object', 'invalid_upstream_payload');
            return;
          }
          const upstreamError = this.getUpstreamStreamError(payload);
          if (upstreamError) {
            // Upstream error payloads can contain credentials, account identifiers, or
            // provider diagnostics. The Responses stream has already started, so retain
            // its terminal SSE shape while exposing only this bounded public message.
            fail('Upstream Responses stream failed', 'upstream_error', upstreamError);
            return;
          }
          const responsePayload = this.toUnknownRecord(payload.response) ?? payload;
          const usageMetadata = this.toResponsesUsageMetadata(
            responsePayload.usageMetadata ?? payload.usageMetadata,
          );
          if (!Array.isArray(responsePayload.candidates)) {
            if (usageMetadata) {
              mapper.setUsageMetadata(usageMetadata);
              return;
            }
            fail(
              'Upstream Responses stream payload did not include candidates',
              'invalid_upstream_payload',
            );
            return;
          }
          const candidate = this.toUnknownRecord(responsePayload.candidates[0]);
          if (!candidate) {
            fail(
              'Upstream Responses stream payload did not include a usable candidate',
              'invalid_upstream_payload',
            );
            return;
          }
          mapper.setUsageMetadata(usageMetadata);
          if (isString(candidate.finishReason) && candidate.finishReason.length > 0) {
            lastFinishReason = candidate.finishReason;
          }
          const content = this.toUnknownRecord(candidate?.content);
          if (Array.isArray(content?.parts)) {
            for (const part of content.parts) {
              const normalizedPart = this.toResponsesStreamPart(part);
              if (normalizedPart) {
                const events = mapper.processPart(normalizedPart);
                if (events.length > 0) {
                  if (streamHealth && !streamHealth.markUsableOutput()) {
                    fail('Session affinity confirmation rejected', 'affinity_rejected');
                    return;
                  }
                  receivedUsableOutput = true;
                }
                for (const event of events) {
                  subscriber.next(event);
                }
              }
            }
          }
          const grounding = this.toResponsesGroundingMetadata(candidate?.groundingMetadata);
          if (grounding) {
            const events = mapper.processGrounding(grounding);
            if (events.length > 0) {
              if (streamHealth && !streamHealth.markUsableOutput()) {
                fail('Session affinity confirmation rejected', 'affinity_rejected');
                return;
              }
              receivedUsableOutput = true;
            }
            for (const event of events) {
              subscriber.next(event);
            }
          }
          if (
            receivedUsableOutput &&
            isString(candidate?.finishReason) &&
            candidate.finishReason.length > 0
          ) {
            complete(candidate.finishReason);
          }
        } catch (error) {
          void error;
          fail('Malformed upstream Responses payload', 'invalid_upstream_payload');
        }
      };

      const onData = (chunk: Buffer): void => {
        if (completed) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
          if (completed) {
            return;
          }
        }
      };

      const onEnd = (): void => {
        if (completed) {
          return;
        }
        if (buffer.trim()) {
          processLine(buffer);
        }
        if (completed) {
          return;
        }
        if (!receivedUsableOutput) {
          const mappedFinishReason = mapGeminiFinishReasonToOpenAI(lastFinishReason);
          if (mappedFinishReason === 'length' || mappedFinishReason === 'content_filter') {
            complete(lastFinishReason);
            return;
          }
          fail('Upstream Responses stream was empty', 'empty_stream');
          return;
        }
        complete(lastFinishReason);
      };

      const onError = (error: unknown): void => {
        if (completed) {
          return;
        }
        const canceled = getUpstreamRequestCancellation(error);
        if (!canceled) this.logger.error('OpenAI Responses stream error: operation=responses_stream reason=upstream_error');
        fail('Upstream Responses stream failed', 'upstream_error', canceled);
      };

      upstreamStream.on('data', onData);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('error', onError);

      return () => {
        terminate();
      };
    });
  }

  private toResponsesStreamPart(value: unknown): GeminiResponsesStreamPart | null {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return null;
    }

    const hasFunctionCall = Object.hasOwn(part, 'functionCall');
    const functionCallRecord = this.toUnknownRecord(part.functionCall);
    const functionName = isString(functionCallRecord?.name) ? functionCallRecord.name : null;
    const functionArgs = hasFunctionCall ? normalizeFunctionCallArgs(functionCallRecord) : null;
    const functionId = isString(functionCallRecord?.id) ? functionCallRecord.id : undefined;
    const inlineDataRecord = this.toUnknownRecord(part.inlineData);
    const inlineData =
      isString(inlineDataRecord?.mimeType) && isString(inlineDataRecord.data)
        ? {
            data: inlineDataRecord.data,
            mimeType: inlineDataRecord.mimeType,
          }
        : undefined;

    return {
      functionCall:
        functionName && functionArgs
          ? {
              args: functionArgs,
              id: functionId,
              name: functionName,
            }
          : undefined,
      inlineData,
      text: isString(part.text) ? part.text : undefined,
      thought: part.thought === true,
      thoughtSignature: isString(part.thoughtSignature) ? part.thoughtSignature : undefined,
      thought_signature: isString(part.thought_signature) ? part.thought_signature : undefined,
    };
  }

  private toResponsesGroundingMetadata(value: unknown): GeminiResponsesGroundingMetadata | null {
    const grounding = this.toUnknownRecord(value);
    if (!grounding) {
      return null;
    }

    const webSearchQueries = Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.filter(isString)
      : undefined;
    const groundingChunks = Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks.flatMap((chunk) => {
          const web = this.toUnknownRecord(this.toUnknownRecord(chunk)?.web);
          if (!web) {
            return [];
          }
          return [
            {
              web: {
                title: isString(web.title) ? web.title : undefined,
                uri: isString(web.uri) ? web.uri : undefined,
              },
            },
          ];
        })
      : undefined;

    if (!webSearchQueries?.length && !groundingChunks?.length) {
      return null;
    }
    return { groundingChunks, webSearchQueries };
  }

  private mergeGroundingMetadata(
    existing: GroundingMetadata | undefined,
    value: unknown,
  ): GroundingMetadata | undefined {
    const grounding = this.toUnknownRecord(value);
    if (!grounding) {
      return existing;
    }

    const webSearchQueries = Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.filter(
          (query): query is string => isString(query) && !isEmpty(query.trim()),
        )
      : [];
    const groundingChunks = Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks.flatMap((chunk) => {
          const web = this.toUnknownRecord(this.toUnknownRecord(chunk)?.web);
          if (!web) {
            return [];
          }
          const title = isString(web.title) ? web.title : undefined;
          const uri = isString(web.uri) ? web.uri : undefined;
          return title || uri ? [{ web: { title, uri } }] : [];
        })
      : [];
    if (webSearchQueries.length === 0 && groundingChunks.length === 0) {
      return existing;
    }

    const mergedQueries = [
      ...new Set([...(existing?.webSearchQueries ?? []), ...webSearchQueries]),
    ];
    const mergedChunks = [...(existing?.groundingChunks ?? [])];
    const chunkKeys = new Set(
      mergedChunks.map((chunk) => `${chunk.web?.title ?? ''}\u0000${chunk.web?.uri ?? ''}`),
    );
    for (const chunk of groundingChunks) {
      const key = `${chunk.web?.title ?? ''}\u0000${chunk.web?.uri ?? ''}`;
      if (!chunkKeys.has(key)) {
        mergedChunks.push(chunk);
        chunkKeys.add(key);
      }
    }

    return {
      groundingChunks: mergedChunks.length > 0 ? mergedChunks : undefined,
      webSearchQueries: mergedQueries.length > 0 ? mergedQueries : undefined,
    };
  }

  private formatGroundingAsAssistantText(grounding: GroundingMetadata | undefined): string {
    if (!grounding) {
      return '';
    }

    let groundingText = '';
    if (grounding.webSearchQueries?.length) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${grounding.webSearchQueries.join(', ')}`;
    }

    const links = (grounding.groundingChunks ?? []).flatMap((chunk, index) => {
      if (!chunk.web) {
        return [];
      }
      const title = chunk.web.title || 'Web source';
      const uri = chunk.web.uri || '#';
      return [`[${index + 1}] [${title}](${uri})`];
    });
    if (links.length) {
      groundingText += `\n\n**🌐 Citations:**\n${links.join('\n')}`;
    }

    return groundingText;
  }

  private toResponsesUsageMetadata(value: unknown): GeminiResponsesUsageMetadata | undefined {
    const usage = this.toUnknownRecord(value);
    if (!usage) {
      return undefined;
    }
    return {
      candidatesTokenCount: isNumber(usage.candidatesTokenCount)
        ? usage.candidatesTokenCount
        : undefined,
      promptTokenCount: isNumber(usage.promptTokenCount) ? usage.promptTokenCount : undefined,
      thoughtsTokenCount: isNumber(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount : undefined,
      totalTokenCount: isNumber(usage.totalTokenCount) ? usage.totalTokenCount : undefined,
    };
  }

  private toUnknownRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private buildOpenAIStreamChunk(
    identity: { streamId: string; created: number; model: string },
    streamOptions: OpenAIStreamOptions,
    choices: Array<Record<string, unknown>>,
    usage?: OpenAIStreamUsage,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      id: identity.streamId,
      object: streamOptions.variant === 'text' ? 'text_completion' : 'chat.completion.chunk',
      created: identity.created,
      model: identity.model,
      choices,
    };
    // Official semantics: usage is present-but-null on normal chunks only when the
    // caller opted in, and never fabricated otherwise.
    if (streamOptions.includeUsage) {
      payload.usage = usage ?? null;
    }
    return payload;
  }

  private buildOpenAIContentChoice(
    variant: OpenAIStreamVariant,
    text: string,
  ): Record<string, unknown> {
    if (variant === 'text') {
      return { text, index: 0, logprobs: null, finish_reason: null };
    }
    return { index: 0, delta: { content: text }, finish_reason: null };
  }

  private buildOpenAIAssistantRoleChoice(): Record<string, unknown> {
    return { index: 0, delta: { role: 'assistant' }, finish_reason: null };
  }

  private buildOpenAIFinishChoice(
    variant: OpenAIStreamVariant,
    finishReason: string | null,
  ): Record<string, unknown> {
    if (variant === 'text') {
      return { text: '', index: 0, logprobs: null, finish_reason: finishReason };
    }
    return { index: 0, delta: {}, finish_reason: finishReason };
  }

  // Handle SSE Stream conversion
  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureContext?: SignatureContext,
    streamOptions: OpenAIStreamOptions = { variant: 'chat', includeUsage: false },
    streamHealth?: StreamHealthLifecycle,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let hasSentDone = false;
      let terminated = false;
      let hasEmittedTerminalFinish = false;
      let emittedToolCall = false;
      let lastUsage: OpenAIStreamUsage | null = null;
      const toolCallIndices = new Map<string, number>();
      const toolCallIdIntegrity = new ToolCallIdIntegrityTracker();
      let groundingMetadata: GroundingMetadata | undefined;
      /** Signature seen earlier in THIS stream, used only for tool calls of this same stream. */
      let streamSignature: string | null = null;

      const cleanup = (): void => {
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('error', onError);
        idleTimer.dispose();
        streamHealth?.cleanup?.();
      };

      const terminate = (): boolean => {
        if (terminated) {
          return false;
        }
        terminated = true;
        cleanup();
        return true;
      };

      const idPrefix =
        streamOptions.idPrefix ?? (streamOptions.variant === 'text' ? 'cmpl' : 'chatcmpl');
      const streamId = `${idPrefix}-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      const identity = { streamId, created, model };
      const isTextVariant = streamOptions.variant === 'text';
      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChoice = (choice: Record<string, unknown>, countsAsUsable = true): void => {
        if (countsAsUsable) {
          if (streamHealth && !streamHealth.markUsableOutput()) {
            failStream(new Error('Session affinity confirmation rejected'));
            return;
          }
          hasEmittedChunk = true;
        }
        subscriber.next(
          `data: ${JSON.stringify(this.buildOpenAIStreamChunk(identity, streamOptions, [choice]))}\n\n`,
        );
      };

      if (!isTextVariant) {
        pushChoice(this.buildOpenAIAssistantRoleChoice(), false);
      }

      const sendDone = (): void => {
        if (hasSentDone) {
          return;
        }
        // Only emit the usage-only frame when upstream actually reported usage.
        // Fabricating a zero-token frame would be a lie on the wire.
        if (streamOptions.includeUsage && lastUsage) {
          subscriber.next(
            `data: ${JSON.stringify(
              this.buildOpenAIStreamChunk(identity, streamOptions, [], lastUsage),
            )}\n\n`,
          );
        }
        subscriber.next('data: [DONE]\n\n');
        hasSentDone = true;
      };

      const failStream = (error: unknown): void => {
        if (!terminate()) {
          return;
        }
        const canceled = getUpstreamRequestCancellation(error);
        const safeError = canceled ?? new Error('Upstream stream failed');
        if (!canceled) {
          logUpstreamTerminalDiagnostic(getUpstreamDiagnosticContext(upstreamStream), 'failure');
          this.logger.error('OpenAI-compatible stream error: operation=openai_stream reason=upstream_error');
        }
        streamHealth?.recordFailure(safeError);
        subscriber.error(safeError);
      };

      // An idle stream is a failed stream: terminate through the error path so the
      // client never mistakes a stalled upstream for a successful completion.
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-SSE', () => {
        failStream(new Error('Upstream stream idle timeout after 300s'));
      });

      idleTimer.reset();

      const handleLine = (line: string): void => {
        if (terminated) {
          return;
        }
        const trimmed = line.trim();
        // Upstreams emit both "data:" and "data: " forms.
        if (!trimmed.startsWith('data:')) return;

        const dataStr = trimmed.slice('data:'.length).trim();
        if (dataStr.length === 0 || dataStr === '[DONE]') return;

        let rawPayload: any;
        try {
          rawPayload = JSON.parse(dataStr);
        } catch {
          // A malformed upstream payload is a real failure: surface one terminal
          // stream error instead of silently completing as a successful stream.
          failStream(new Error('Malformed upstream stream payload'));
          return;
        }

        const upstreamError = this.getUpstreamStreamError(rawPayload);
        if (upstreamError) {
          failStream(upstreamError);
          return;
        }
        const json = unwrapInternalGeminiResponse(rawPayload);

        {
          const candidate = json?.candidates?.[0];
          const parts: InternalGeminiPart[] = [];
          if (Array.isArray(candidate?.content?.parts)) {
            for (const part of candidate.content.parts) {
              try {
                const normalizedPart = this.normalizeGeminiPart(part);
                if (normalizedPart) {
                  parts.push(normalizedPart);
                }
              } catch (error) {
                failStream(
                  error instanceof Error ? error : new Error('Malformed Gemini stream part'),
                );
                return;
              }
            }
          }
          groundingMetadata = this.mergeGroundingMetadata(
            groundingMetadata,
            candidate?.groundingMetadata,
          );

          // Partial metadata leaves the previously reported usage untouched rather than
          // downgrading it to zeros.
          const mappedUsage = this.mapGeminiUsageMetadata(json?.usageMetadata);
          if (mappedUsage) {
            lastUsage = mappedUsage;
          }

          // Gemini may deliver accounting metadata after its terminal candidate. That
          // terminal choice is already on the wire, so accept only usage from later
          // frames until the upstream stream itself ends.
          if (hasEmittedTerminalFinish) {
            return;
          }

          for (const part of parts) {
            const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
            if (signature) {
              streamSignature = signature;
            }
            let functionArgs: Record<string, unknown> = {};
            if (part.functionCall) {
              try {
                functionArgs = normalizeFunctionCallArgs(part.functionCall);
              } catch (error) {
                failStream(
                  error instanceof Error
                    ? error
                    : new Error('Malformed Gemini function call arguments'),
                );
                return;
              }
            }

            if (part.thought && part.text) {
              if (isTextVariant) {
                // Legacy completions have no reasoning channel.
                continue;
              }
              pushChoice({
                index: 0,
                delta: { reasoning_content: part.text },
                finish_reason: null,
              });
              continue;
            }

            if (part.functionCall) {
              const toolCallId =
                part.functionCall.id || [part.functionCall.name, uuidv4()].join('-');
              try {
                if (
                  toolCallIdIntegrity.record(
                    part.functionCall.id,
                    part.functionCall.name,
                    functionArgs,
                  ) === 'replay'
                ) {
                  continue;
                }
              } catch (error) {
                failStream(
                  error instanceof Error
                    ? error
                    : new Error('Conflicting explicit function call id'),
                );
                return;
              }
              const toolCallIndex = toolCallIndices.get(toolCallId) ?? toolCallIndices.size;
              toolCallIndices.set(toolCallId, toolCallIndex);
              // Capture for replay under the id the client actually sees (upstream id when
              // Gemini supplies one, otherwise the generated id), keyed by the account/model
              // that produced it.
              const capturedSignature = signature ?? streamSignature;
              if (capturedSignature && signatureContext) {
                SignatureStore.store(
                  {
                    accountId: signatureContext.accountId,
                    model: signatureContext.model,
                    toolCallId: toolCallId,
                  },
                  capturedSignature,
                );
              }
              if (isTextVariant) {
                // Legacy completions cannot express tool calls.
                continue;
              }
              emittedToolCall = true;
              pushChoice({
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolCallIndex,
                      id: toolCallId,
                      type: 'function',
                      function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(functionArgs),
                      },
                    },
                  ],
                },
                finish_reason: null,
              });
              continue;
            }

            if (part.inlineData) {
              const mimeType = part.inlineData.mimeType || 'image/jpeg';
              const data = part.inlineData.data || '';
              const imageMarkdown = `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
              pushChoice(this.buildOpenAIContentChoice(streamOptions.variant, imageMarkdown));
              continue;
            }

            if (part.text) {
              pushChoice(this.buildOpenAIContentChoice(streamOptions.variant, part.text));
            }
          }

          if (candidate?.finishReason) {
            const groundingText = this.formatGroundingAsAssistantText(groundingMetadata);
            if (groundingText) {
              pushChoice(this.buildOpenAIContentChoice(streamOptions.variant, groundingText));
            }
            logUpstreamTerminalDiagnostic(getUpstreamDiagnosticContext(upstreamStream), 'terminal', candidate.finishReason);
            const mappedFinishReason = emittedToolCall
              ? 'tool_calls'
              : mapGeminiFinishReasonToOpenAI(candidate.finishReason);
            pushChoice(this.buildOpenAIFinishChoice(streamOptions.variant, mappedFinishReason));
            hasEmittedTerminalFinish = true;
            return;
          }
        }
      };

      const onData = (chunk: Buffer): void => {
        if (terminated) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (terminated) {
            return;
          }
          handleLine(line);
        }
      };

      const onEnd = (): void => {
        if (terminated) {
          return;
        }
        // Upstream may end without a trailing newline: flush the decoder and process
        // whatever data line is still buffered before deciding how the stream ends.
        buffer += decoder.decode();
        const pending = buffer;
        buffer = '';
        for (const line of pending.split('\n')) {
          if (terminated) {
            return;
          }
          handleLine(line);
        }
        if (terminated) {
          return;
        }
        if (!hasEmittedChunk) {
          // No candidate, no content, no finish reason: this is a failed stream, not an
          // empty success. Terminate through the error path and emit no [DONE].
          failStream(new Error('Upstream stream ended without any usable content'));
          return;
        }
        if (!hasEmittedTerminalFinish) {
          logUpstreamTerminalDiagnostic(getUpstreamDiagnosticContext(upstreamStream), 'terminal');
        }
        terminate();
        sendDone();
        subscriber.complete();
      };

      const onError = (err: unknown): void => {
        failStream(getUpstreamRequestCancellation(err) ?? new Error('Upstream stream failed'));
      };

      upstreamStream.on('data', onData);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('error', onError);

      return () => {
        terminate();
      };
    });
  }

  private createSyntheticOpenAIStream(
    response: OpenAIChatResponse,
    streamOptions: OpenAIStreamOptions = { variant: 'chat', includeUsage: false },
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const idPrefix =
        streamOptions.idPrefix ?? (streamOptions.variant === 'text' ? 'cmpl' : 'chatcmpl');
      const streamId = response.id || `${idPrefix}-${uuidv4()}`;
      const created = response.created || Math.floor(Date.now() / 1000);
      const model = response.model;
      const identity = { streamId, created, model };
      const choice = response.choices?.[0];
      const toolCalls = choice?.message?.tool_calls ?? [];
      // Legacy text completions have no tool-call channel, so they never claim tool_calls.
      const emitsToolCalls = streamOptions.variant !== 'text' && toolCalls.length > 0;
      const finishReason = emitsToolCalls
        ? 'tool_calls'
        : this.normalizeSyntheticOpenAIFinishReason(choice?.finish_reason, streamOptions.variant);
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : '';
      const chunkSize = 80;

      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChoice = (payloadChoice: Record<string, unknown>): void => {
        subscriber.next(
          `data: ${JSON.stringify(
            this.buildOpenAIStreamChunk(identity, streamOptions, [payloadChoice]),
          )}\n\n`,
        );
      };

      if (streamOptions.variant !== 'text') {
        pushChoice(this.buildOpenAIAssistantRoleChoice());
      }

      const sendDone = (): void => {
        // Never invent usage the upstream response did not carry.
        if (streamOptions.includeUsage && response.usage) {
          subscriber.next(
            `data: ${JSON.stringify(
              this.buildOpenAIStreamChunk(identity, streamOptions, [], {
                prompt_tokens: response.usage.prompt_tokens,
                completion_tokens: response.usage.completion_tokens,
                total_tokens: response.usage.total_tokens,
              }),
            )}\n\n`,
          );
        }
        subscriber.next('data: [DONE]\n\n');
        subscriber.complete();
      };

      for (let index = 0; index < content.length; index += chunkSize) {
        const piece = content.slice(index, index + chunkSize);
        const isLast = index + chunkSize >= content.length;
        const payloadChoice = this.buildOpenAIContentChoice(streamOptions.variant, piece);
        // The finish chunk is deferred when tool-call deltas still have to be emitted.
        if (isLast && !emitsToolCalls) {
          payloadChoice.finish_reason = finishReason;
        }
        pushChoice(payloadChoice);
      }

      if (emitsToolCalls) {
        // Replay the actual calls on the wire with their original ids and deterministic
        // indexes, so a synthetic fallback stream is not silently stripped of tool calls.
        toolCalls.forEach((toolCall, toolCallIndex) => {
          pushChoice({
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                  },
                },
              ],
            },
            finish_reason: null,
          });
        });
      }

      if (content.length === 0 || emitsToolCalls) {
        pushChoice(this.buildOpenAIFinishChoice(streamOptions.variant, finishReason));
      }

      sendDone();
    });
  }

  private normalizeSyntheticOpenAIFinishReason(
    finishReason: string | null | undefined,
    variant: OpenAIStreamOptions['variant'],
  ): string | null {
    if (variant !== 'text') {
      return finishReason ?? 'stop';
    }
    if (finishReason === undefined) {
      return 'stop';
    }
    if (finishReason === null) {
      return null;
    }
    if (finishReason === 'stop' || finishReason === 'length' || finishReason === 'content_filter') {
      return finishReason;
    }
    return 'stop';
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    configuration?: OpenAIResponsesConfiguration,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const mapper = new OpenAIResponsesStreamingMapper({
        model: response.model,
        responseId: `resp_${uuidv4()}`,
        configuration,
      });
      const choice = response.choices?.[0];
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : undefined;

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      if (response.usage) {
        const reasoningTokens = response.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        mapper.setUsageMetadata({
          candidatesTokenCount: response.usage.completion_tokens - reasoningTokens,
          promptTokenCount: response.usage.prompt_tokens,
          thoughtsTokenCount: reasoningTokens,
          totalTokenCount: response.usage.total_tokens,
        });
      }
      if (content) {
        for (const event of mapper.processPart({ text: content })) {
          subscriber.next(event);
        }
      }

      for (const toolCall of choice?.message?.tool_calls ?? []) {
        for (const event of mapper.processPart({
          functionCall: {
            args: this.parseOpenAIFunctionArguments(toolCall.function.arguments),
            id: toolCall.id,
            name: toolCall.function.name,
          },
        })) {
          subscriber.next(event);
        }
      }

      for (const event of mapper.complete(choice?.finish_reason, 'openai')) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  private toClaudeRequest(request: AnthropicChatRequest): ClaudeRequest {
    return {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      system: request.system,
      tools: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        type: tool.type,
      })),
      tool_choice: this.convertAnthropicToolChoice(request.tool_choice),
      stream: request.stream,
      max_tokens: request.max_tokens,
      stop_sequences: request.stop_sequences,
      temperature: request.temperature,
      top_p: request.top_p,
      top_k: request.top_k,
      thinking: request.thinking,
      metadata: request.metadata,
    };
  }

  private convertAnthropicToolChoice(
    toolChoice: AnthropicChatRequest['tool_choice'],
  ): ClaudeRequest['tool_choice'] {
    if (!toolChoice || toolChoice.type === 'auto') {
      return toolChoice ? 'auto' : undefined;
    }
    if (toolChoice.type === 'any') {
      return 'required';
    }
    if (toolChoice.type === 'none') {
      return 'none';
    }
    if (toolChoice.type === 'tool') {
      return { type: 'tool', name: toolChoice.name };
    }
    return undefined;
  }

  private toAnthropicChatResponse(response: ClaudeResponse): AnthropicChatResponse {
    return {
      id: response.id,
      type: response.type,
      role: response.role,
      model: response.model,
      content: response.content,
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage?.cache_read_input_tokens,
      },
    };
  }

  // Convert OpenAI request format to Claude/Anthropic format
  private convertOpenAIToClaude(request: OpenAIChatRequest): ClaudeRequest {
    const messages = request.messages || [];
    const systemPromptParts: string[] = [];
    const anthropicMessages: ClaudeRequest['messages'] = [];

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const msg = messages[messageIndex];
      // `developer` is the current OpenAI spelling of `system`; both are instructions,
      // never user turns.
      if (msg.role === 'system' || msg.role === 'developer') {
        const systemText = this.extractOpenAITextContent(msg.content);
        if (systemText) {
          systemPromptParts.push(systemText);
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolResults: AnthropicContent[] = [];
        do {
          const toolMessage = messages[messageIndex];
          const toolResultText = this.extractOpenAITextContent(toolMessage.content) || '';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMessage.tool_call_id ?? '',
            content: toolResultText,
            is_error: false,
          });
          messageIndex++;
        } while (messages[messageIndex]?.role === 'tool');

        anthropicMessages.push({
          role: 'user',
          content: toolResults,
        });
        messageIndex--;
        continue;
      }

      const contentBlocks = this.convertOpenAIPartsToAnthropicContent(msg.content);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: this.parseOpenAIFunctionArguments(toolCall.function.arguments),
          });
        }
      }

      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: contentBlocks.length > 0 ? contentBlocks : '',
      });
    }

    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

    return {
      model: request.model,
      messages: anthropicMessages,
      system: systemPrompt,
      tools: this.convertOpenAIToolsToAnthropicTools(request.tools),
      tool_choice: this.convertOpenAIToolChoice(request.tool_choice, request.tools),
      max_tokens: request.max_completion_tokens ?? request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      seed: request.seed,
      stop_sequences: this.convertOpenAIStopSequences(request.stop),
      response_mime_type: this.convertOpenAIResponseFormat(request.response_format),
      stream: request.stream,
      metadata: { ...(request.extra ?? {}), source: 'openai' },
    };
  }

  private applyNativeGeminiSignatureTransform(
    request: GeminiInternalRequest['request'],
    model: string,
    signatureContext?: SignatureContext,
  ): GeminiInternalRequest['request'] {
    if (!this.isGeminiFlashToolHistoryModel(model)) {
      return request;
    }

    return {
      ...request,
      contents: request.contents.map((content) => ({
        ...content,
        parts: content.parts.map((part) => {
          if (
            content.role !== 'model' ||
            !part.functionCall ||
            part.thoughtSignature ||
            part.thought_signature
          ) {
            return part;
          }

          const toolCallId = part.functionCall.id;
          const storedSignature =
            signatureContext && toolCallId
              ? SignatureStore.get({ ...signatureContext, toolCallId })
              : null;
          const effectiveSignature = storedSignature ?? 'skip_thought_signature_validator';
          return {
            ...part,
            thoughtSignature: effectiveSignature,
            thought_signature: effectiveSignature,
          };
        }),
      })),
    };
  }

  private isGeminiFlashToolHistoryModel(model: string): boolean {
    return /^(?:models\/)?gemini-3(?:\.\d+)?-flash(?!-image(?:-|$))(?:-|$)/.test(
      model.toLowerCase(),
    );
  }

  private convertOpenAIToolChoice(
    toolChoice: unknown,
    tools: OpenAIChatRequest['tools'],
  ): ClaudeRequest['tool_choice'] {
    if (toolChoice === undefined) {
      return undefined;
    }
    if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') {
      return toolChoice;
    }

    const namedChoice = this.toUnknownRecord(toolChoice);
    if (namedChoice?.type !== 'function') {
      throw this.invalidOpenAIRequest(
        'tool_choice must be none, auto, required, or a named function selection',
        'tool_choice',
      );
    }

    const functionChoice = this.toUnknownRecord(namedChoice.function);
    const name = isString(functionChoice?.name) ? functionChoice.name.trim() : '';
    if (!name) {
      throw this.invalidOpenAIRequest(
        'tool_choice.function.name is required for named function selection',
        'tool_choice',
      );
    }

    const hasNamedTool = tools?.some((tool) => tool.function?.name === name);
    if (!hasNamedTool) {
      throw this.invalidOpenAIRequest(
        `tool_choice function "${name}" is not among the provided tools`,
        'tool_choice',
      );
    }
    return { type: 'tool', name };
  }

  private convertOpenAIStopSequences(stop: OpenAIChatRequest['stop']): string[] | undefined {
    if (isNil(stop)) {
      return undefined;
    }

    const entries = isString(stop) ? [stop] : stop;
    if (!Array.isArray(entries)) {
      throw this.invalidOpenAIRequest('stop must be a string or an array of strings', 'stop');
    }
    if (entries.length === 0) {
      return undefined;
    }
    if (entries.length > 4) {
      throw this.invalidOpenAIRequest('stop supports at most 4 sequences', 'stop');
    }
    for (const entry of entries) {
      if (!isString(entry) || isEmpty(entry)) {
        throw this.invalidOpenAIRequest('stop entries must be non-empty strings', 'stop');
      }
    }
    return [...entries];
  }

  private convertOpenAIResponseFormat(
    responseFormat: OpenAIChatRequest['response_format'],
  ): string | undefined {
    if (isNil(responseFormat)) {
      return undefined;
    }
    const type = responseFormat.type;
    if (type === 'text') {
      return undefined;
    }
    if (type === 'json_object') {
      return 'application/json';
    }
    // A response_format object without a usable type is a malformed request, not an
    // implicit "text": silently defaulting it would hide the caller's mistake.
    if (!isString(type) || isEmpty(type)) {
      throw this.invalidOpenAIRequest(
        "response_format.type is required and must be one of 'text' or 'json_object'",
        'response_format',
      );
    }
    // json_schema (and anything unknown) is rejected rather than silently dropped
    // until real schema passthrough exists.
    throw this.invalidOpenAIRequest(
      `response_format type '${type}' is not supported`,
      'response_format',
    );
  }

  private invalidOpenAIRequest(message: string, param: string): OpenAIProtocolException {
    return new OpenAIProtocolException(message, HttpStatus.BAD_REQUEST, { param });
  }

  private convertOpenAIPartsToAnthropicContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): AnthropicContent[] {
    if (content === null || content === undefined) {
      return [];
    }

    if (isString(content)) {
      return content.trim() ? [{ type: 'text', text: content }] : [];
    }

    const blocks: AnthropicContent[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        const dataUrl = parseImageDataUrl(url);
        if (dataUrl) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataUrl.mimeType,
              data: dataUrl.data,
            },
          });
        } else if (!/^data:/i.test(url)) {
          blocks.push({ type: 'text', text: `[image_url] ${url}` });
        }
      }
    }
    return blocks;
  }

  private extractOpenAITextContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): string {
    if (content === null || content === undefined) {
      return '';
    }

    if (isString(content)) {
      return content;
    }

    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }

  private parseOpenAIFunctionArguments(argumentsString: string): Record<string, unknown> {
    if (isEmpty(argumentsString.trim())) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsString);
      if (isPlainObject(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: argumentsString };
    }
  }

  private convertOpenAIToolsToAnthropicTools(
    tools: OpenAIChatRequest['tools'],
  ): AnthropicChatRequest['tools'] {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const result: NonNullable<AnthropicChatRequest['tools']> = [];
    const searchToolTypes = new Set([
      'web_search_20250305',
      'google_search',
      'google_search_retrieval',
      'builtin_web_search',
    ]);

    for (const tool of tools) {
      if (!tool) {
        continue;
      }

      const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
      const functionName = isString(tool.function?.name) ? tool.function.name : '';
      const normalizedFunctionName = functionName.toLowerCase();
      const isSearchTool =
        searchToolTypes.has(toolType) || searchToolTypes.has(normalizedFunctionName);

      if (isSearchTool) {
        result.push({
          name: functionName || 'builtin_web_search',
          type: 'web_search_20250305',
          input_schema: {
            type: 'object',
            properties: {},
          },
        });
        continue;
      }

      if (!tool.function || !functionName) {
        continue;
      }

      const inputSchema = normalizeObjectJsonSchema(tool.function.parameters);

      result.push({
        name: functionName,
        description: tool.function.description,
        input_schema: inputSchema,
      });
    }

    return result.length > 0 ? result : undefined;
  }

  private mapAnthropicStopReasonToOpenAIFinishReason(stopReason?: string | null): string | null {
    if (!stopReason) {
      return null;
    }

    if (stopReason === 'end_turn') {
      return 'stop';
    }
    if (stopReason === 'max_tokens') {
      return 'length';
    }
    if (stopReason === 'tool_use') {
      return 'tool_calls';
    }
    if (stopReason === 'refusal') {
      return 'content_filter';
    }

    return 'content_filter';
  }

  private normalizeToolCallArguments(input: unknown): string {
    if (isString(input)) {
      return input;
    }
    if (isNil(input)) {
      return '{}';
    }

    try {
      return JSON.stringify(input);
    } catch {
      return '{}';
    }
  }

  /**
   * Converts the Claude-shaped intermediate response to the OpenAI Chat wire shape.
   *
   * Usage is resolved from the raw upstream Gemini payload first because it is the only
   * source that carries thinking tokens; the Claude intermediate is a fallback for the
   * callers that only hold that shape. Neither is defaulted: an upstream that reported
   * nothing yields a response with no usage key rather than a fabricated 0/0/0.
   */
  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    upstreamUsageMetadata?: unknown,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): OpenAIChatResponse {
    const contentBlocks = Array.isArray(claudeResponse?.content) ? claudeResponse.content : [];

    const textContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<ClaudeResponse['content'][number], { type: 'text'; text: string }> =>
          block?.type === 'text',
      )
      .map((block) => block.text || '')
      .join('');

    const reasoningContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'thinking'; thinking: string }
        > => block?.type === 'thinking',
      )
      .map((block) => block.thinking || '')
      .join('');

    const toolCalls = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        > => block?.type === 'tool_use',
      )
      .map((block, index: number) => ({
        id: block.id || `tool-call-${index}`,
        type: 'function' as const,
        function: {
          name: block.name || 'unknown_tool',
          arguments: this.normalizeToolCallArguments(block.input),
        },
      }));

    // Raw upstream metadata is the richest source (it carries thinking tokens); the
    // Claude intermediate is the fallback and now only carries usage when it was real.
    const usage =
      this.mapGeminiUsageMetadata(upstreamUsageMetadata) ??
      this.toOpenAIUsageFromClaudeUsage(claudeResponse.usage);

    return {
      id: `${outputProtocol === 'text-completions' ? 'cmpl' : 'chatcmpl'}-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning_content: reasoningContent || undefined,
          },
          logprobs: null,
          finish_reason: this.mapAnthropicStopReasonToOpenAIFinishReason(
            claudeResponse.stop_reason,
          ),
        },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  private toOpenAIUsageFromClaudeUsage(usage: ClaudeResponse['usage']): OpenAIStreamUsage | null {
    if (!usage || !isNumber(usage.input_tokens) || !isNumber(usage.output_tokens)) {
      return null;
    }
    return {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    };
  }

  private resolveTargetModel(model: string): string {
    return this.modelRoutingPolicy.resolveTargetModel(model);
  }

  private async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
    retryState?: ProxyTokenRetryState,
  ): Promise<boolean> {
    const modelWasNotFound = this.isModelNotFoundError(error);
    if (modelWasNotFound && !model.toLowerCase().includes('-image')) {
      // Quota metadata can advertise ids the generation API rejects; mark the
      // id so the in-flight retry loop and later requests reroute to a sibling.
      this.accountLeaseService.markModelUnrequestable(accountId, model);
    }
    const shouldRetry = await this.retryPolicy.applyUpstreamPenalty(
      accountId,
      model,
      error,
      retryState,
    );
    return modelWasNotFound || shouldRetry;
  }

  private isModelNotFoundError(error: unknown): boolean {
    if (error instanceof UpstreamRequestError) {
      return error.status === HttpStatus.NOT_FOUND || error.reason === 'model_not_found';
    }
    return false;
  }

  private classifyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
    return this.retryPolicy.classifyUpstreamFailure(errorMessage);
  }

  private createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    return this.modelRoutingPolicy.createModelSpecificHeaders(model);
  }

  private isQuotaExhaustedError(error: unknown): boolean {
    return error instanceof UpstreamRequestError && error.reason === 'quota_exhausted';
  }

  private extractAnthropicSessionKey(request: AnthropicChatRequest): string | undefined {
    const metadata = request.metadata;
    const sessionCandidate =
      metadata?.session_id ??
      metadata?.sessionId ??
      metadata?.conversation_id ??
      metadata?.conversationId;
    if (isString(sessionCandidate) && !isEmpty(sessionCandidate.trim())) {
      return `session:${sessionCandidate.trim()}`;
    }

    if (Array.isArray(request.messages) && request.messages.length > 0) {
      const userMsg = request.messages.find((m: any) => m?.role === 'user');
      const text = extractCanonicalUserTurnText(userMsg);
      if (text) {
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
        return `hint:prefix:${hash}`;
      }
    }

    return undefined;
  }

  private extractOpenAISessionKey(request: OpenAIChatRequest): string | undefined {
    const extra = request.extra;
    const sessionCandidate =
      extra?.session_id ??
      extra?.sessionId ??
      extra?.conversation_id ??
      extra?.conversationId;
    if (isString(sessionCandidate) && !isEmpty(sessionCandidate.trim())) {
      return `session:${sessionCandidate.trim()}`;
    }

    if (Array.isArray(request.messages) && request.messages.length > 0) {
      const userMsg = request.messages.find((m: any) => m?.role === 'user');
      const text = extractCanonicalUserTurnText(userMsg);
      if (text) {
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
        return `hint:prefix:${hash}`;
      }
    }

    return undefined;
  }

  private isGeminiPart(value: unknown): value is InternalGeminiPart {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return false;
    }

    const hasText = isString(part.text) && !isEmpty(part.text);
    const signature = part.thoughtSignature ?? part.thought_signature;
    const hasSignature = isString(signature) && !isEmpty(decodeSignature(signature));
    const functionCall = this.toUnknownRecord(part.functionCall);
    const hasFunctionCall =
      functionCall !== null &&
      isString(functionCall.name) &&
      !isEmpty(functionCall.name) &&
      (!Object.hasOwn(functionCall, 'args') || isPlainObject(functionCall.args));
    const hasServerToolCombination =
      isPlainObject(part.toolCall) || isPlainObject(part.toolResponse);
    const inlineData = this.toUnknownRecord(part.inlineData);
    const hasInlineData =
      inlineData !== null &&
      isString(inlineData.mimeType) &&
      !isEmpty(inlineData.mimeType) &&
      isString(inlineData.data) &&
      !isEmpty(inlineData.data);

    return hasText || hasSignature || hasFunctionCall || hasServerToolCombination || hasInlineData;
  }

  private normalizeGeminiPart(value: unknown): InternalGeminiPart | null {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return null;
    }

    const hasFunctionCall = Object.hasOwn(part, 'functionCall');
    const functionCall = this.toUnknownRecord(part.functionCall);
    const normalizedPart = hasFunctionCall
      ? {
          ...part,
          functionCall: { ...functionCall, args: normalizeFunctionCallArgs(functionCall) },
        }
      : part;

    return this.isGeminiPart(normalizedPart) ? normalizedPart : null;
  }
}
