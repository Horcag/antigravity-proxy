import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { logger } from '../../../shared/logging/logger';
import { getServerConfig } from '../../../server/server-config';
import { AccountLeaseService } from './account-lease.service';
import { CloudAccount } from '../../cloud-account/types';
import { RateLimitReason } from './rate-limit-tracker';
import { parseTargetAuthority } from './cert/ca-manager';
import { type MigrationCapability, isVerifiedSessionKey, isHintSessionKey } from './account-lease-selection-policy';
import { AnonymousTransportReceiptOwner } from './anonymous-transport-receipt';
import { authorizesMigration, createMigrationAuthorization, safeAffinityCommitRejectionReason, type MigrationAuthorization, type MigrationAuthorizationReason } from './cache-affinity-coordinator';
import { extractModelName, extractSessionKey, isReplaySafeOperation, composeAttemptRequest, preflightValidateJsonRequest } from './cloudcode-request-adapter';
import { classifyUpstreamFailure, safeDecodeGrpcMessage, type FailureEvidence } from './upstream-failure';
import { evaluateRetryDecision } from './upstream-retry-decision';
import { logUpstreamFailure, sanitizeLogString } from './cloudcode-diagnostics';
import { formatPoolCapacityError, formatTerminalDownstreamError, resolveHasAlternativeAccounts } from './cloudcode-terminal-response';
export { isVerifiedSessionKey, isHintSessionKey };
export type ProtocolFailureCategory = 'inspection-limit' | 'unsupported-encoding' | 'malformed-upstream-message' | 'deadline-exceeded' | 'account-quota' | 'upstream-transient';
export interface ProtocolFrameDecision {
  state: 'NEED_MORE_DATA' | 'VALIDATED_RESPONSE' | 'VALIDATED_ERROR';
  isQuota?: boolean;
  isTransient?: boolean;
  errorText?: string;
  category?: ProtocolFailureCategory;
  isLocalValidationError?: boolean;
}
export interface CloudCodeGatewayOptions { accountLeaseService?: AccountLeaseService; upstreamHost?: string; }
function encodeErrorBody(error: Record<string, unknown>): Buffer<ArrayBuffer> {
  return Buffer.from(JSON.stringify({ error }), 'utf-8') as Buffer<ArrayBuffer>;
}
export class GatewayReceiptTransferError extends Error { constructor(readonly receiptOwner: AnonymousTransportReceiptOwner, readonly originalCause: unknown) { super('Gateway receipt ownership transferred to ingress', { cause: originalCause }); this.name = 'GatewayReceiptTransferError'; } }
export { extractCanonicalUserTurnText } from './cloudcode-request-adapter';
export class CloudCodeFailoverGateway {
  private defaultUpstreamHost: string;
  constructor(
    private readonly accountLeaseService?: AccountLeaseService,
    options: CloudCodeGatewayOptions = {},
  ) {
    this.defaultUpstreamHost = options.upstreamHost || 'daily-cloudcode-pa.googleapis.com';
  }
  async handleRequest(
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse,
  ): Promise<void> {
    const receiptOwner = new AnonymousTransportReceiptOwner(crypto.randomUUID()); receiptOwner.observeResponse(res);
    let responseCommitted = false; let downstreamFailed = false;
    const rejectAndTerminateDownstream = (cause: unknown): void => {
      downstreamFailed = true;
      receiptOwner.reject('internal_error');
      try { if (!res.writableFinished && !(res as any).destroyed) res.destroy(cause instanceof Error ? cause : new Error('Downstream response write failed')); } catch { /* empty */ }
      receiptOwner.emit();
    };
    const writeDownstreamHeaders = (classification: Parameters<AnonymousTransportReceiptOwner['expectDownstreamCommit']>[0], statusCode: number, headers: http.IncomingHttpHeaders): void => {
      receiptOwner.expectDownstreamCommit(classification);
      try { this.writeHeaders(res, statusCode, headers); } catch (err) { throw new GatewayReceiptTransferError(receiptOwner, err); }
      responseCommitted = true;
    };
    const endDownstream = (body?: string | Buffer): boolean => {
      try { if (body === undefined) res.end(); else res.end(body); return true; } catch (err) { rejectAndTerminateDownstream(err); return false; }
    };
    const writeDownstream = (classification: Parameters<AnonymousTransportReceiptOwner['expectDownstreamCommit']>[0], statusCode: number, headers: http.IncomingHttpHeaders, body?: string | Buffer): boolean => {
      let s = statusCode, h = headers, b = body, trailers: Record<string, string> | undefined;
      if (statusCode >= 400 || (headers['grpc-status'] !== undefined && String(headers['grpc-status']) !== '0')) {
        const f = formatTerminalDownstreamError(req, statusCode, headers, body);
        s = f.statusCode; h = f.headers; b = f.body; trailers = f.trailers;
      }
      writeDownstreamHeaders(classification, s, h);
      if (trailers && typeof (res as any).addTrailers === 'function') {
        try { (res as any).addTrailers(trailers); } catch (err) { rejectAndTerminateDownstream(err); return false; }
      }
      return endDownstream(b);
    };
    const writeDownstreamChunk = (chunk: Buffer): boolean => {
      try { return (res as any).write(chunk); } catch (err) { rejectAndTerminateDownstream(err); return false; }
    };
    let deadlineWriteFailure: GatewayReceiptTransferError | null = null;
    try {
    const rawUrl = req.url || '/';
    let urlPath = rawUrl;
    if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
      // Convert absolute-form to origin-form without URL's path normalization.
      const target = /^https?:\/\/[^/?#]+([^#]*)/.exec(urlPath)?.[1];
      if (target !== undefined) urlPath = target.startsWith('/') ? target : `/${target}`;
    }
    const method = req.method || 'POST';
    // Determine upstream target host strictly from :authority or host header
    const rawAuthority =
      (req.headers[':authority'] as string) ||
      (req.headers['host'] as string) ||
      this.defaultUpstreamHost;
    const parsedAuthority = parseTargetAuthority(rawAuthority);
    if (!parsedAuthority) {
      logger.warn(`[CloudCodeGateway] Destination authority not allowed for interception: ${rawAuthority}`);
      writeDownstream('invalid_authority', 403, { 'content-type': 'application/json' },
        JSON.stringify({
          error: {
            code: 403,
            message: `Authority '${rawAuthority}' is not authorized for transparent interception`,
          },
        }));
      return;
    }
    const targetHost = parsedAuthority.hostname;
    const requestAbortController = new AbortController(), LOGICAL_REQUEST_DEADLINE_MS = (getServerConfig()?.request_timeout ?? 120) * 1000, affinityOwnerTimeoutMs = LOGICAL_REQUEST_DEADLINE_MS + 5000;
    const deadlineAt = Date.now() + LOGICAL_REQUEST_DEADLINE_MS;
    let logicalDeadlineTimer: NodeJS.Timeout | null = null;
    const clearLogicalDeadline = () => { if (logicalDeadlineTimer) { clearTimeout(logicalDeadlineTimer); logicalDeadlineTimer = null; } };
    let clientAborted = false, affinityOwnerExpired = false;
    let activeReleaseReservation: (() => void) | undefined; let activeCompleteAffinityPlacement: ((outcome: 'aborted' | 'committed') => void) | undefined;
    let activeStopCandidateRenewal: (() => void) | undefined; let activeAbortMigration: (() => void) | undefined;
    let currentUpstreamReq: http.ClientRequest | null = null;
    let currentUpstreamRes: http.IncomingMessage | null = null;
    let upstreamResponseSelected = false; let exhaustedByUnavailable = false;
    const cleanupActiveAttempt = (completePlacement = true) => {
      if (activeStopCandidateRenewal) { activeStopCandidateRenewal(); activeStopCandidateRenewal = undefined; }
      if (activeReleaseReservation) { activeReleaseReservation(); activeReleaseReservation = undefined; }
      if (activeAbortMigration) { activeAbortMigration(); activeAbortMigration = undefined; }
      if (completePlacement) activeCompleteAffinityPlacement?.('aborted'); activeCompleteAffinityPlacement = undefined;
    };
    const destroyActiveUpstream = () => {
      if (currentUpstreamReq && !currentUpstreamReq.destroyed) currentUpstreamReq.destroy();
      if (currentUpstreamRes && !currentUpstreamRes.destroyed) currentUpstreamRes.destroy();
    };
    const abortAll = () => {
      clientAborted = true;
      requestAbortController.abort();
      clearLogicalDeadline();
      cleanupActiveAttempt();
      destroyActiveUpstream();
    };
    const abortExpiredAffinityOwner = () => {
      affinityOwnerExpired = true;
      requestAbortController.abort(); clearLogicalDeadline(); cleanupActiveAttempt(false); destroyActiveUpstream();
      if (!responseCommitted && !res.headersSent && !res.writableEnded && !res.destroyed) {
        writeDownstream('unavailable', 503, { 'content-type': 'application/json' }, JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Session affinity owner expired' } }));
      } else if (!res.writableEnded && !res.destroyed) res.destroy();
    };
    logicalDeadlineTimer = setTimeout(() => {
      clearLogicalDeadline();
      if (!responseCommitted && !res.headersSent && !res.writableEnded) {
        abortAll();
        const errorBody = encodeErrorBody({
          code: 504,
          status: 'DEADLINE_EXCEEDED',
          message: 'Gateway Timeout: Overall request deadline exceeded',
          category: 'deadline-exceeded',
        });
        try {
          writeDownstream('deadline_exceeded', 504, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(errorBody.length),
          }, errorBody);
        } catch (err) {
          deadlineWriteFailure = err instanceof GatewayReceiptTransferError ? err : new GatewayReceiptTransferError(receiptOwner, err);
        }
      } else {
        abortAll();
        if (!res.writableFinished) {
          try {
            res.destroy(new Error('Gateway Timeout: Logical request deadline exceeded'));
          } catch { /* empty */ }
        }
      }
    }, LOGICAL_REQUEST_DEADLINE_MS);
    logicalDeadlineTimer.unref?.();
    req.once?.('aborted', () => {
      receiptOwner.reject('client_aborted'); abortAll();
    });
    req.once?.('close', () => {
      if (!req.complete && (!responseCommitted || !res.writableEnded)) {
        receiptOwner.reject('client_aborted'); abortAll();
      }
    });
    res.once?.('close', () => {
      clearLogicalDeadline();
      if (!res.writableEnded) {
        receiptOwner.reject('client_aborted'); abortAll();
      }
    });
    res.once?.('finish', () => {
      clearLogicalDeadline();
    });
    const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
    let totalBodyBytes = 0;
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      if (clientAborted) return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBodyBytes += buf.length;
      if (totalBodyBytes > MAX_REQUEST_BODY_BYTES) {
        if (!res.headersSent) {
          writeDownstream('request_too_large', 413, { 'content-type': 'application/json' },
            JSON.stringify({ error: { code: 413, message: 'Payload Too Large: request body exceeds 64 MiB limit' } }));
        }
        return;
      }
      bodyChunks.push(buf);
    }
    const rawBody = Buffer.concat(bodyChunks);
    if (clientAborted || res.destroyed) {
      return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
    }
    const preflight = preflightValidateJsonRequest(rawBody, req.headers, urlPath);
    if (!preflight.valid) {
      if (!res.headersSent) {
        writeDownstream('bad_gateway', 400, { 'content-type': 'application/json' },
          JSON.stringify({ error: { code: 400, message: preflight.error || 'Invalid request body', status: 'INVALID_ARGUMENT' } }));
      }
      return;
    }
    const parsedBody = preflight.parsedBody || null;
    const modelName = extractModelName(urlPath, parsedBody);
    const requestedModel = modelName;
    const isReplaySafe = isReplaySafeOperation(method, urlPath, {
      hasAccountPinnedResources: preflight.hasAccountPinnedResources,
    });
    let ambiguityProbesUsed = 0;
    const quotaHeaderMode = 'with-quota-header' as const;
    let lastAmbiguousError: {
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      bufferedBody?: Buffer;
    } | null = null;
    const sessionKey = this.extractSessionKey(req, parsedBody);
    const requestId = crypto.randomUUID(); const attemptedAccountIds = new Set<string>();
    const anyLeaseService = this.accountLeaseService as any;
    const totalPoolAccounts = typeof anyLeaseService?.getAccountCount === 'function' ? anyLeaseService.getAccountCount() : (typeof anyLeaseService?.getUsableAccountCount === 'function' ? anyLeaseService.getUsableAccountCount() : (anyLeaseService?.getQuotaDiagnostics?.()?.accounts?.length ?? 5));
    const poolCapacity = Math.max(totalPoolAccounts || 0, 5); const maxAttempts = poolCapacity * 2 + 2; let transientRetriesUsed = 0;
    let migrationAuthorization: MigrationAuthorization | undefined;
    const issueMigrationAuthorization = (reason: MigrationAuthorizationReason, expectedGen?: number, expectedInc?: number): void => {
      const binding = this.accountLeaseService?.getSessionBinding?.(sessionKey);
      if ((expectedGen !== undefined && binding && binding.generation !== expectedGen) || (expectedInc !== undefined && binding?.tableIncarnation !== undefined && binding.tableIncarnation !== expectedInc)) {
        logger.warn(`[CloudCodeGateway] Stale generation/incarnation (${expectedGen}/${expectedInc}) vs binding; ignoring migration auth`);
        return;
      }
      migrationAuthorization = createMigrationAuthorization(reason, sessionKey, binding, requestId) ?? undefined;
    };
    migrationAuthorization = this.accountLeaseService?.authorizeBoundSessionMigration?.(sessionKey, modelName, requestId);
    let activeLease: {
      account: CloudAccount;
      sessionKey?: string;
      generation: number;
      tableIncarnation?: number;
      releaseReservation: () => void;
      completeAffinityPlacement?: (outcome: 'aborted' | 'committed') => void;
      affinityAbortSignal?: AbortSignal;
    } | null = null;
    let migrationCapability: MigrationCapability | null = null;
    let attemptGeneration = 1;
    let attemptTableIncarnation: number | undefined;
    let leaseRetainedForSameAccount = false, currentAttemptAccount: CloudAccount | null = null;

    const releaseActiveLease = () => {
      leaseRetainedForSameAccount = false;
      if (activeLease) {
        cleanupActiveAttempt();
        activeLease = null;
      }
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      currentUpstreamReq = null; currentUpstreamRes = null; currentAttemptAccount = null;
      if (clientAborted || affinityOwnerExpired || res.destroyed) {
        releaseActiveLease();
        return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
      }
      const remainingTimeMs = deadlineAt - Date.now();
      if (remainingTimeMs <= 0) {
        logger.warn(
          `[CloudCodeGateway] Logical request deadline exceeded (${LOGICAL_REQUEST_DEADLINE_MS}ms) before attempt ${attempt}`,
        );
        releaseActiveLease();
        if (!responseCommitted && !res.headersSent && !res.writableEnded) {
          const errorBody = encodeErrorBody({
            code: 504,
            status: 'DEADLINE_EXCEEDED',
            message: 'Gateway Timeout: Overall request deadline exceeded',
            category: 'deadline-exceeded',
          });
          writeDownstream('deadline_exceeded', 504, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(errorBody.length),
          }, errorBody);
        }
        return;
      }

      if (!activeLease) {
        if (this.accountLeaseService) {
          if (typeof this.accountLeaseService.acquireAttemptLease === 'function') {
            activeLease = await this.accountLeaseService.acquireAttemptLease({
              model: modelName, excludeAccountIds: Array.from(attemptedAccountIds), sessionKey,
              deferSessionBinding: true, migrationAuthorization, signal: requestAbortController.signal, requestId, affinityOwnerTimeoutMs,
            });
            if (!activeLease && migrationAuthorization) {
              migrationAuthorization = undefined;
              activeLease = await this.accountLeaseService.acquireAttemptLease({
                model: modelName, excludeAccountIds: Array.from(attemptedAccountIds), sessionKey,
                deferSessionBinding: true, migrationAuthorization: undefined, signal: requestAbortController.signal, requestId, affinityOwnerTimeoutMs,
              });
            }
            if (!activeLease && sessionKey) {
              activeLease = await this.accountLeaseService.acquireAttemptLease({
                model: modelName, excludeAccountIds: Array.from(attemptedAccountIds),
                signal: requestAbortController.signal, requestId,
              });
            }
          } else {
            const acc = await this.accountLeaseService.getNextToken({
              model: modelName, excludeAccountIds: Array.from(attemptedAccountIds), sessionKey, deferSessionBinding: true,
            });
            if (acc) {
              activeLease = { account: acc, sessionKey, generation: 1, tableIncarnation: this.accountLeaseService.getTableIncarnation?.(), releaseReservation: acc.releaseReservation ?? (() => {}) };
            }
          }
        }
        if (this.accountLeaseService && !activeLease) {
          logger.warn(`[CloudCodeGateway] No account lease available in managed pool on attempt ${attempt}. Disallowing unreserved passthrough.`);
          if (!responseCommitted && !res.writableEnded) {
            const ambiguous = lastAmbiguousError as { statusCode: number; headers: http.IncomingHttpHeaders; bufferedBody?: Buffer } | null;
            if (ambiguous) {
              writeDownstream('bad_gateway', ambiguous.statusCode, ambiguous.headers, ambiguous.bufferedBody);
              return;
            }
            const failure = requestedModel ? this.accountLeaseService.getPoolCapacityFailure?.(requestedModel) : undefined, terminal = formatPoolCapacityError(failure, requestedModel);
            writeDownstream(failure ? 'rate_limited' : 'unavailable', terminal.statusCode, terminal.headers, terminal.body);
          }
          return;
        }
      }
      try {
        currentAttemptAccount = activeLease?.account ?? null; activeReleaseReservation = activeLease?.releaseReservation;
        activeCompleteAffinityPlacement = activeLease?.completeAffinityPlacement;
        if (activeLease?.affinityAbortSignal?.aborted) { abortExpiredAffinityOwner(); return; }
        if (!leaseRetainedForSameAccount) {
          activeLease?.affinityAbortSignal?.addEventListener('abort', abortExpiredAffinityOwner, { once: true });
          const initialBinding = sessionKey && typeof this.accountLeaseService?.getSessionBinding === 'function' ? this.accountLeaseService.getSessionBinding(sessionKey) : null;
          attemptGeneration = activeLease?.generation ?? initialBinding?.generation ?? 1;
          attemptTableIncarnation = activeLease?.tableIncarnation ?? initialBinding?.tableIncarnation;
          migrationCapability = null;
          const needsMigration = Boolean(sessionKey && isVerifiedSessionKey(sessionKey) && activeLease?.account && initialBinding && initialBinding.accountId !== activeLease.account.id);
          const canAttemptMigration = authorizesMigration(migrationAuthorization, sessionKey, initialBinding, requestId) ||
            (!migrationAuthorization && typeof this.accountLeaseService?.startSessionMigration === 'function');
          if (canAttemptMigration && needsMigration && sessionKey && isVerifiedSessionKey(sessionKey) && activeLease?.account && typeof this.accountLeaseService?.startSessionMigration === 'function') {
            migrationCapability = this.accountLeaseService.startSessionMigration(sessionKey, attemptGeneration, activeLease.account.id, requestId, attemptTableIncarnation);
            if (migrationCapability) {
              attemptGeneration = migrationCapability.generation;
              const cap = migrationCapability;
              activeAbortMigration = () => { this.accountLeaseService?.abortSessionMigration?.(cap.sessionKey, cap.generation, cap.ownerRequestId, cap.tableIncarnation); };
            }
          }
          if (needsMigration && migrationAuthorization && !migrationCapability) {
            releaseActiveLease();
            if (!responseCommitted && !res.writableEnded) {
              writeDownstream('unavailable', 503, { 'content-type': 'application/json' },
                JSON.stringify({ error: { code: 503, message: 'Session affinity migration was denied', status: 'UNAVAILABLE' } }));
            }
            return;
          }
          let candidateRenewalTimer: NodeJS.Timeout | null = null;
          if (sessionKey && isVerifiedSessionKey(sessionKey) && migrationCapability) {
            const cap = migrationCapability;
            candidateRenewalTimer = setInterval(() => {
              try {
                const renewed = this.accountLeaseService?.renewSessionMigration?.(sessionKey, cap.generation, requestId, 30000, cap.tableIncarnation);
                if (renewed === false) logger.warn('[CloudCodeGateway] Candidate migration renewal rejected');
              } catch { /* empty */ }
            }, 15000);
            candidateRenewalTimer.unref?.();
          }
          activeStopCandidateRenewal = () => { if (candidateRenewalTimer) { clearInterval(candidateRenewalTimer); candidateRenewalTimer = null; } };
        }
        leaseRetainedForSameAccount = false;

        if (clientAborted || res.destroyed) {
          releaseActiveLease();
          return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
        }

        const account = activeLease?.account ?? null;
        const effectiveModel =
          account && requestedModel && typeof this.accountLeaseService?.resolveDynamicModelForAccount === 'function'
            ? this.accountLeaseService.resolveDynamicModelForAccount(account.id, requestedModel)
            : requestedModel;
        const { urlPath: attemptUrlPath, headers: upstreamHeaders, payloadToSend } = composeAttemptRequest({
          rawBody, reqHeaders: req.headers, targetHost, method, urlPath,
          accessToken: account?.token?.access_token,
        });
        logger.debug(
          `[CloudCodeGateway] Attempt ${attempt} model=${sanitizeLogString(effectiveModel) || 'default'} operation=upstream_attempt`,
        );

        const handleFailureOutcome = async (
          failureEvidence: FailureEvidence, status: number, responseHeaders: http.IncomingHttpHeaders, responseBody?: Buffer,
        ): Promise<'continue' | 'terminal'> => {
          const hasAlternatives = resolveHasAlternativeAccounts(this.accountLeaseService, account, attemptedAccountIds, attempt, maxAttempts);
          const decision = evaluateRetryDecision({
            evidence: failureEvidence, attempt, maxAttempts, downstreamCommitted: responseCommitted,
            isReplaySafe, ambiguityProbesUsed, maxAmbiguityProbes: 1,
            projectCorrectionsUsed: 0, maxProjectCorrections: 0,
            quotaHeaderMode,
            hasAlternativeAccounts: hasAlternatives,
            effectiveModel, transientRetriesUsed, maxTransientRetries: 1,
          });

          logUpstreamFailure({
            receiptId: receiptOwner?.receiptId, requestId, urlPath: attemptUrlPath, accountId: account?.id,
            attempt, maxAttempts, requestedModel, effectiveModel, quotaHeaderMode,
            evidence: failureEvidence, action: decision.action, downstreamCommitted: responseCommitted,
          });

          if (account && this.accountLeaseService) {
            try {
              if (decision.healthEffect.kind === 'rate-limited') {
                await this.accountLeaseService.markFromUpstreamError({
                  accountIdOrEmail: account.id, status: status >= 400 ? status : 429,
                  model: effectiveModel, body: failureEvidence.rawErrorText, headers: responseHeaders,
                  reason: decision.healthEffect.isQuota ? RateLimitReason.QuotaExhausted : RateLimitReason.RateLimitExceeded,
                }).catch(() => {
                  logger.warn('[CloudCodeGateway] Failed to record account error health effect: health_effect_failed');
                });
              } else if (decision.healthEffect.kind === 'credential-rejected') {
                this.accountLeaseService.markAsForbidden?.(account.id);
              } else if (decision.healthEffect.kind === 'model-unrequestable') {
                this.accountLeaseService.markModelUnrequestable?.(account.id, decision.healthEffect.effectiveModel);
              }
            } catch {
              logger.warn('[CloudCodeGateway] Failed to record account error health effect: health_effect_failed');
            }
          }

          if (decision.action.kind === 'retry-transient') {
            transientRetriesUsed++;
            exhaustedByUnavailable = true;
            logger.warn(
              `[CloudCodeGateway] Upstream returned transient ${status} (attempt ${attempt}/${maxAttempts}). Retrying on same account...`,
            );
            leaseRetainedForSameAccount = true;
            return 'continue';
          }

          if (decision.action.kind === 'migrate-account') {
            if (account) attemptedAccountIds.add(account.id);
            if (decision.action.reason === 'upstream-transient') {
              exhaustedByUnavailable = true;
            }
            if (decision.action.reason === 'ambiguity-probe') {
              ambiguityProbesUsed++;
              if (!lastAmbiguousError) lastAmbiguousError = { statusCode: status, headers: responseHeaders, bufferedBody: responseBody };
              logger.warn(
                `[CloudCodeGateway] Upstream returned ambiguous 400 INVALID_ARGUMENT (attempt ${attempt}/${maxAttempts}). Probing alternate account...`,
              );
            } else {
              logger.warn(
                `[CloudCodeGateway] Upstream returned ${status} (${decision.action.reason}) (attempt ${attempt}/${maxAttempts}). Rotating to next account...`,
              );
            }
            if (sessionKey && isVerifiedSessionKey(sessionKey) && account) {
              this.accountLeaseService?.failSessionMigrationCandidate?.(sessionKey, attemptGeneration, account.id, requestId);
            }
            releaseActiveLease();
            issueMigrationAuthorization(decision.action.reason, attemptGeneration, attemptTableIncarnation);
            return 'continue';
          }

          // Terminal failure
          releaseActiveLease();
          if (lastAmbiguousError && status === 400) {
            writeDownstream('bad_gateway', lastAmbiguousError.statusCode, lastAmbiguousError.headers, lastAmbiguousError.bufferedBody);
            return 'terminal';
          }
          const classification = (status === 503 || exhaustedByUnavailable) ? 'unavailable'
            : status === 413 ? 'request_too_large'
            : status === 429 ? 'rate_limited'
            : 'bad_gateway';
          writeDownstream(classification, status, responseHeaders, responseBody);
          return 'terminal';
        };

        const hasAlternatives = resolveHasAlternativeAccounts(this.accountLeaseService, account, attemptedAccountIds, attempt, maxAttempts);
        const upstreamResult = await this.executeUpstreamCall(
          method, attemptUrlPath, upstreamHeaders, payloadToSend, targetHost,
          (upReq) => { currentUpstreamReq = upReq; }, deadlineAt, hasAlternatives,
        );
        const { statusCode, headers, bodyStream, bufferedBody } = upstreamResult;
        currentUpstreamRes = bodyStream;
        if (clientAborted || res.destroyed) {
          releaseActiveLease();
          bodyStream.destroy();
          return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
        }
        if (statusCode >= 400) {
          const isGrpc = headers['grpc-status'] !== undefined || String(headers['content-type'] || '').includes('application/grpc');
          const isSse = String(headers['content-type'] || '').includes('text/event-stream');
          const isJson = String(headers['content-type'] || '').includes('application/json');
          const rawGrpcMsg = headers['grpc-message'];
          const grpcMsg = Array.isArray(rawGrpcMsg) ? rawGrpcMsg.map(safeDecodeGrpcMessage).join(', ') : rawGrpcMsg ? safeDecodeGrpcMessage(String(rawGrpcMsg)) : undefined;
          const evidence = classifyUpstreamFailure({
            statusCode,
            headers,
            bufferedBody,
            errorText: isGrpc && grpcMsg ? grpcMsg : undefined,
            modelName: effectiveModel,
            urlPath: attemptUrlPath,
            source: isGrpc ? 'grpc' : isSse ? 'sse' : isJson ? 'json' : 'http',
          });
          const outcome = await handleFailureOutcome(evidence, statusCode, headers, bufferedBody);
          if (outcome === 'continue') continue;
          return;
        }
        const grpcStatus = headers['grpc-status'];
        if (grpcStatus !== undefined && String(grpcStatus) !== '0') {
          bodyStream.destroy();
          const combinedHeaders = { ...headers, ...bodyStream.trailers };
          const rawGrpcMsg = combinedHeaders['grpc-message'];
          const grpcMsg = Array.isArray(rawGrpcMsg) ? rawGrpcMsg.map(safeDecodeGrpcMessage).join(', ') : rawGrpcMsg ? safeDecodeGrpcMessage(String(rawGrpcMsg)) : undefined;
          const evidence = classifyUpstreamFailure({
            statusCode,
            headers: combinedHeaders,
            errorText: grpcMsg,
            modelName: effectiveModel,
            urlPath: attemptUrlPath,
            source: 'grpc',
          });
          const terminalStatus = evidence.httpStatus && evidence.httpStatus >= 400 ? evidence.httpStatus : 502;
          const outcome = await handleFailureOutcome(evidence, terminalStatus, combinedHeaders);
          if (outcome === 'continue') continue;
          return;
        }
        const contentType = headers['content-type'] ? String(headers['content-type']) : undefined;
        const firstChunkResult = await new Promise<{ buffer: Buffer | null; decision: ProtocolFrameDecision }>(
          (resolve, reject) => {
            let settled = false;
            let firstChunkTimer: NodeJS.Timeout | null = null;
            const chunks: Buffer[] = [];
            let totalRawBytes = 0;
            let decompressedBytes = 0;
            const decompressedChunks: Buffer[] = [];
            const MAX_SPOOL_BUDGET = 10 * 1024 * 1024;
            const isJsonPayload = Boolean(contentType?.includes('application/json') || !contentType);
            const inspectionBudget = isJsonPayload ? MAX_SPOOL_BUDGET : 65536;
            const encoding = (headers['content-encoding'] as string | undefined)?.toLowerCase().trim();
            let streamDecompressor: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
            if (encoding === 'gzip' || encoding === 'x-gzip') {
              streamDecompressor = zlib.createGunzip();
            } else if (encoding === 'deflate') {
              streamDecompressor = zlib.createInflate();
            } else if (encoding === 'br') {
              streamDecompressor = zlib.createBrotliDecompress();
            }
            const cleanup = () => {
              if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }
              bodyStream.removeListener('data', onData);
              bodyStream.removeListener('end', onEnd);
              bodyStream.removeListener('close', onClose);
              bodyStream.removeListener('error', onError);
              req.removeListener?.('close', onClientClose);
              res.removeListener?.('close', onClientClose);
              if (streamDecompressor) {
                streamDecompressor.removeAllListeners();
                streamDecompressor.on('error', () => {});
                try {
                  streamDecompressor.destroy();
                } catch { /* empty */ }
              }
            };
            const handleDecompressorError = (err: unknown) => {
              if (settled) return;
              settled = true;
              cleanup();
              bodyStream.pause();
              resolve({
                buffer: Buffer.concat(chunks),
                decision: {
                  state: 'VALIDATED_ERROR',
                  category: 'unsupported-encoding',
                  isLocalValidationError: true,
                  errorText: `Failed to decompress ${encoding} response body: ${err instanceof Error ? err.message : String(err)}`,
                },
              });
            };
            let isFlushedAfterRawCap = false;
            const evaluateDecision = (streamEnded: boolean) => {
              if (settled) return;
              const inspectionBuffer = streamDecompressor
                ? (decompressedChunks.length > 0 ? Buffer.concat(decompressedChunks) : null)
                : (chunks.length > 0 ? Buffer.concat(chunks) : null);
              const decision = this.classifyProtocolFrame(
                contentType,
                inspectionBuffer,
                headers,
                bodyStream.trailers,
                streamEnded,
                statusCode,
                Boolean(streamDecompressor),
              );
              if (decision.state !== 'NEED_MORE_DATA') {
                settled = true;
                cleanup();
                bodyStream.pause();
                resolve({ buffer: Buffer.concat(chunks), decision });
                return;
              }
              const isBudgetExhausted = streamDecompressor
                ? (decompressedBytes >= inspectionBudget || (totalRawBytes >= inspectionBudget && isFlushedAfterRawCap))
                : (totalRawBytes >= inspectionBudget);
              if (isBudgetExhausted) {
                settled = true;
                cleanup();
                bodyStream.pause();
                resolve({
                  buffer: Buffer.concat(chunks),
                  decision: {
                    state: 'NEED_MORE_DATA',
                  },
                });
              }
            };
            if (streamDecompressor) {
              streamDecompressor.on('data', (dChunk: Buffer) => {
                if (settled) return;
                const buf = Buffer.isBuffer(dChunk) ? dChunk : Buffer.from(dChunk);
                if (decompressedBytes < inspectionBudget) {
                  const remaining = inspectionBudget - decompressedBytes;
                  const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
                  decompressedChunks.push(slice);
                  decompressedBytes += slice.length;
                }
                evaluateDecision(false);
              });
              streamDecompressor.on('error', (err) => {
                handleDecompressorError(err);
              });
            }
            const onData = (chunk: Buffer) => {
              if (settled) return;
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              // T16-F01: Preserve every consumed byte that may later be forwarded.
              // Never slice or drop suffix bytes of boundary-crossing transport chunks.
              chunks.push(buf);
              totalRawBytes += buf.length;
              if (totalRawBytes >= inspectionBudget) {
                bodyStream.pause();
              }
              if (streamDecompressor) {
                try {
                  const canAcceptMore = streamDecompressor.write(buf);
                  if (!canAcceptMore) {
                    bodyStream.pause();
                    const onDrain = () => {
                      streamDecompressor?.removeListener('drain', onDrain);
                      if (!settled && totalRawBytes < inspectionBudget) {
                        bodyStream.resume();
                      }
                    };
                    streamDecompressor.once('drain', onDrain);
                  }
                } catch (err) {
                  handleDecompressorError(err);
                  return;
                }
                if (totalRawBytes >= inspectionBudget) {
                  try {
                    streamDecompressor.flush(() => {
                      if (!settled) {
                        isFlushedAfterRawCap = true;
                        evaluateDecision(false);
                      }
                    });
                  } catch {
                    isFlushedAfterRawCap = true;
                    evaluateDecision(false);
                  }
                }
              } else {
                evaluateDecision(false);
              }
            };
            const settleAtEof = () => {
              if (settled) return;
              settled = true;
              cleanup();
              const inspectionBuffer = streamDecompressor
                ? (decompressedChunks.length > 0 ? Buffer.concat(decompressedChunks) : null)
                : (chunks.length > 0 ? Buffer.concat(chunks) : null);
              const decision = this.classifyProtocolFrame(
                contentType,
                inspectionBuffer,
                headers,
                bodyStream.trailers,
                true,
                statusCode,
                Boolean(streamDecompressor),
              );
              resolve({ buffer: chunks.length > 0 ? Buffer.concat(chunks) : null, decision });
            };
            const onEnd = () => {
              if (settled) return;
              if (streamDecompressor) {
                streamDecompressor.once('end', () => {
                  settleAtEof();
                });
                try {
                  streamDecompressor.end();
                } catch (err) {
                  handleDecompressorError(err);
                }
              } else {
                settleAtEof();
              }
            };
            const onClose = () => {
              if (settled) return;
              if (!bodyStream.readableEnded) {
                settled = true;
                cleanup();
                reject(new Error('Upstream stream closed prematurely before response completion'));
              } else {
                onEnd();
              }
            };
            const onError = (err: unknown) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            };
            const onClientClose = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve({ buffer: null, decision: { state: 'VALIDATED_ERROR', isTransient: true } });
            };
            bodyStream.on('data', onData);
            bodyStream.once('end', onEnd);
            bodyStream.once('close', onClose);
            bodyStream.once('error', onError);
            req.once?.('close', onClientClose);
            res.once?.('close', onClientClose);
            const firstChunkTimeoutMs = Math.min(20000, Math.max(2000, deadlineAt - Date.now()));
            firstChunkTimer = setTimeout(() => {
              if (!settled) { settled = true; cleanup(); reject(new Error(`Upstream first chunk timeout after ${firstChunkTimeoutMs}ms`)); }
            }, firstChunkTimeoutMs);
          },
        );
        if (clientAborted || res.destroyed) {
          cleanupActiveAttempt();
          bodyStream.destroy();
          return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
        }
        const firstChunk = firstChunkResult.buffer;
        const frameDecision = firstChunkResult.decision;
        switch (frameDecision.state) {
          case 'VALIDATED_ERROR': {
            bodyStream.destroy();
            if (frameDecision.isLocalValidationError) {
              releaseActiveLease();
              const errorBody = encodeErrorBody({
                code: 502,
                status: 'BAD_GATEWAY',
                message: `Bad Gateway: ${frameDecision.errorText || 'Upstream response validation failed'}`,
                category: frameDecision.category || 'malformed-upstream-message',
              });
              writeDownstream('bad_gateway', 502, {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(errorBody.length),
              }, errorBody);
              return;
            }
            const frameStatus = frameDecision.isQuota ? 429 : frameDecision.isTransient ? 503 : statusCode;
            const appHeaders = { ...headers, ...bodyStream.trailers };
            delete appHeaders['content-encoding'];
            delete appHeaders['content-length'];
            const evidence = classifyUpstreamFailure({
              statusCode: frameStatus, headers: appHeaders, errorText: frameDecision.errorText,
              modelName: effectiveModel, urlPath: attemptUrlPath,
              source: contentType?.includes('text/event-stream') ? 'sse' : 'json',
            });
            const terminalStatus = evidence.httpStatus && evidence.httpStatus >= 400 ? evidence.httpStatus : frameStatus >= 400 ? frameStatus : 400;
            const terminalBody = frameDecision.errorText ? Buffer.from(frameDecision.errorText, 'utf-8') : undefined;
            const outcome = await handleFailureOutcome(evidence, terminalStatus, appHeaders, terminalBody);
            if (outcome === 'continue') continue;
            return;
          }
          case 'NEED_MORE_DATA': {
            releaseActiveLease();
            bodyStream.destroy();
            logger.warn(
              `[CloudCodeGateway] Protocol frame inspection limit exceeded (NEED_MORE_DATA) (attempt ${attempt}/${maxAttempts})`,
            );
            const errorBody = encodeErrorBody({
              code: 502,
              status: 'BAD_GATEWAY',
              message: 'Bad Gateway: Protocol frame inspection limit exceeded without valid structure',
              category: 'inspection-limit',
            });
            writeDownstream('bad_gateway', 502, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(errorBody.length),
            }, errorBody);
            return;
          }
          case 'VALIDATED_RESPONSE': {
            if (sessionKey && account) {
              if (isHintSessionKey(sessionKey)) {
                if (typeof this.accountLeaseService?.recordCacheHint === 'function') {
                  this.accountLeaseService.recordCacheHint(sessionKey, account.id);
                }
              } else if (isVerifiedSessionKey(sessionKey)) {
                const expectedIncarnation = activeLease?.tableIncarnation ?? migrationCapability?.tableIncarnation;
                if (typeof this.accountLeaseService?.confirmOrBindSession === 'function') {
                  const commitResult =
                    expectedIncarnation !== undefined
                      ? this.accountLeaseService.confirmOrBindSession(
                          sessionKey,
                          account.id,
                          attemptGeneration,
                          requestId,
                          undefined,
                          expectedIncarnation,
                        )
                      : this.accountLeaseService.confirmOrBindSession(
                          sessionKey,
                          account.id,
                          attemptGeneration,
                          requestId,
                        );
                  const isRejected = (typeof commitResult === 'boolean' && !commitResult) ||
                    (typeof commitResult === 'object' && commitResult !== null && commitResult.kind === 'rejected');
                  if (isRejected) {
                    if (!isReplaySafe) {
                      releaseActiveLease(); bodyStream.destroy();
                      const errBody = encodeErrorBody({ code: 502, status: 'BAD_GATEWAY', message: 'Bad Gateway: Session confirmation rejected on non-replayable operation', category: 'session-confirmation-rejected' });
                      writeDownstream('bad_gateway', 502, { 'content-type': 'application/json' }, errBody);
                      return;
                    }
                    logger.warn(`[CloudCodeGateway] Session confirmation not committed (${safeAffinityCommitRejectionReason(commitResult)}); proceeding with valid upstream response`);
                    activeCompleteAffinityPlacement?.('aborted'); activeCompleteAffinityPlacement = undefined;
                  }
                } else if (typeof this.accountLeaseService?.bindSession === 'function') {
                  const bound = expectedIncarnation !== undefined
                    ? this.accountLeaseService.bindSession(sessionKey, account.id, undefined, attemptGeneration, expectedIncarnation)
                    : this.accountLeaseService.bindSession(sessionKey, account.id, undefined, attemptGeneration);
                  if (bound === false) {
                    if (!isReplaySafe) {
                      releaseActiveLease(); bodyStream.destroy();
                      const errBody = encodeErrorBody({ code: 502, status: 'BAD_GATEWAY', message: 'Bad Gateway: Session binding rejected on non-replayable operation', category: 'session-binding-rejected' });
                      writeDownstream('bad_gateway', 502, { 'content-type': 'application/json' }, errBody);
                      return;
                    }
                    logger.warn('[CloudCodeGateway] Session binding race not won; proceeding with valid upstream response');
                    activeCompleteAffinityPlacement?.('aborted'); activeCompleteAffinityPlacement = undefined;
                  }
                }
              }
            }
            activeCompleteAffinityPlacement?.('committed'); activeCompleteAffinityPlacement = undefined; upstreamResponseSelected = true;
            receiptOwner.expectDownstreamCommit('validated_response'); activeStopCandidateRenewal?.();
            writeDownstreamHeaders('validated_response', statusCode, headers);
            break;
          }
        }
        const onStreamEnd = () => {
          try {
            if (bodyStream.trailers && typeof (res as any).addTrailers === 'function' && !res.writableEnded) (res as any).addTrailers(bodyStream.trailers);
            if (!res.writableEnded) endDownstream();
          } catch (err) { rejectAndTerminateDownstream(err); }
        };
        bodyStream.once('end', onStreamEnd);
        let downstreamClosed = false;
        res.once('close', () => {
          downstreamClosed = true;
          clearLogicalDeadline();
          bodyStream.destroy();
        });
        res.once('error', (err) => {
          downstreamClosed = true;
          rejectAndTerminateDownstream(err);
        });
        bodyStream.once('error', (err) => {
          if (downstreamClosed || (res as any).destroyed || res.writableEnded) return;
          logger.warn(
            '[CloudCodeGateway] Upstream streaming error: operation=upstream_stream reason=stream_error',
          );
          if (!res.writableEnded) {
            res.destroy(err);
          }
        });
        let upstreamFinished = false;
        const releaseUpstreamReservation = () => {
          if (!upstreamFinished) {
            upstreamFinished = true;
            activeReleaseReservation?.();
            activeReleaseReservation = undefined;
          }
        };
        const relayCompletionPromise = this.createRelayCompletionPromise(
          req,
          res,
          bodyStream,
          releaseUpstreamReservation,
        );
        if (firstChunk && firstChunk.length > 0) {
          const drained = writeDownstreamChunk(firstChunk);
          if (downstreamFailed || (res as any).destroyed) return;
          if (!drained && !res.writableEnded) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const onDone = () => {
                if (!settled) {
                  settled = true;
                  cleanup();
                  resolve();
                }
              };
              const cleanup = () => {
                (res as any).removeListener?.('drain', onDone);
                (res as any).removeListener?.('close', onDone);
                (res as any).removeListener?.('error', onDone);
                req.removeListener?.('close', onDone);
                req.removeListener?.('aborted', onDone);
              };
              (res as any).once('drain', onDone);
              (res as any).once('close', onDone);
              (res as any).once('error', onDone);
              req.once?.('close', onDone);
              req.once?.('aborted', onDone);
            });
            if (res.writableEnded || (res as any).destroyed || clientAborted) {
              cleanupActiveAttempt();
              bodyStream.destroy();
              return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
            }
          }
        }
        if (bodyStream.readableEnded) {
          onStreamEnd();
        } else {
          bodyStream.on('data', (chunk: Buffer) => {
            const drained = writeDownstreamChunk(chunk);
            if (downstreamFailed || (res as any).destroyed) bodyStream.destroy();
            else if (!drained) { bodyStream.pause(); res.once('drain', () => bodyStream.resume()); }
          });
          bodyStream.resume();
        }
        await relayCompletionPromise;
        clearLogicalDeadline();
        releaseActiveLease();
        return;
      } catch (err) {
        if (currentAttemptAccount) { attemptedAccountIds.add(currentAttemptAccount.id); issueMigrationAuthorization('upstream-transient', attemptGeneration, attemptTableIncarnation); }
        releaseActiveLease(); activeStopCandidateRenewal?.();
        if (deadlineWriteFailure) throw deadlineWriteFailure;
        if (err instanceof GatewayReceiptTransferError) throw err;
        if (upstreamResponseSelected && !responseCommitted) throw new GatewayReceiptTransferError(receiptOwner, err);
        if (responseCommitted) { destroyActiveUpstream(); rejectAndTerminateDownstream(err); return; }
        if (!currentUpstreamReq) {
          logger.warn('[CloudCodeGateway] Preparation error before upstream dispatch: preparation_failed');
          writeDownstream('bad_gateway', 502, { 'content-type': 'application/json' },
            JSON.stringify({
              error: {
                code: 502,
                message: 'Gateway preparation error: preparation_failed',
                status: 'INTERNAL',
              },
            }));
          return;
        }
        if (!isReplaySafe) {
          writeDownstream('bad_gateway', 502, { 'content-type': 'application/json' },
            JSON.stringify({
              error: {
                code: 502,
                message: 'Failover gateway network error on non-idempotent operation',
                status: 'UNAVAILABLE',
              },
            }));
          return;
        }
        logger.warn(
          `[CloudCodeGateway] Upstream network error: operation=upstream_request reason=network_error attempt=${attempt}/${maxAttempts} error=${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt === maxAttempts) {
          const anyRes = res as any;
          if (!anyRes.headersSent) {
            writeDownstream('bad_gateway', 502, { 'content-type': 'application/json' },
              JSON.stringify({
                error: {
                  code: 502,
                  message: 'Failover gateway failed all attempts: network error',
                },
              }));
          }
          return;
        }
      }
    }
    const anyRes = res as any;
    if (!anyRes.headersSent) {
      const poolFailure = requestedModel ? this.accountLeaseService?.getPoolCapacityFailure?.(requestedModel) : undefined;
      if (poolFailure) { const terminal = formatPoolCapacityError(poolFailure, requestedModel); writeDownstream('rate_limited', terminal.statusCode, terminal.headers, terminal.body); return; }
      const exhaustedClassification = exhaustedByUnavailable ? 'unavailable' : 'rate_limited';
      writeDownstream(exhaustedClassification, exhaustedByUnavailable ? 503 : 429, { 'content-type': 'application/json' },
        JSON.stringify({
          error: {
            code: exhaustedByUnavailable ? 503 : 429,
            message: exhaustedByUnavailable ? 'All upstream attempts are unavailable.' : 'All accounts in the Antigravity account pool are exhausted or rate-limited.',
            status: exhaustedByUnavailable ? 'UNAVAILABLE' : 'RESOURCE_EXHAUSTED',
          },
        }));
    }
    } catch (err) { if (deadlineWriteFailure) throw deadlineWriteFailure; if (err instanceof GatewayReceiptTransferError) throw err; throw new GatewayReceiptTransferError(receiptOwner, err); }
  }
  private writeHeaders(
    res: http.ServerResponse | http2.Http2ServerResponse,
    statusCode: number, headers: http.IncomingHttpHeaders,
  ): void {
    const responseHeaders: Record<string, string | string[]> = {};
    const forbidden = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
    for (const [k, v] of Object.entries(headers)) {
      if (!k.startsWith(':') && !forbidden.has(k.toLowerCase()) && v !== undefined) {
        responseHeaders[k] = v;
      }
    }
    const anyRes = res as any;
    if (typeof anyRes.writeHead === 'function') {
      anyRes.writeHead(statusCode, responseHeaders);
    }
  }
  private isQuotaErrorText(text?: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (lower.includes('quota project') || lower.includes('serviceusage')) return false;
    return (
      lower.includes('quota') ||
      lower.includes('resource_exhausted') ||
      lower.includes('rate limit') ||
      lower.includes('credit') ||
      lower.includes('429')
    );
  }
  private classifyParsedEnvelope(
    parsed: any,
    statusCode?: number,
  ): ProtocolFrameDecision | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const hasUsableCandidates = Array.isArray(parsed.candidates) && parsed.candidates.length > 0;
    const hasUsableChoices = Array.isArray(parsed.choices) && parsed.choices.length > 0;
    const hasModelDeltas = parsed.type === 'content_block_delta' || parsed.delta !== undefined;
    if (hasUsableCandidates || hasUsableChoices || hasModelDeltas) {
      return { state: 'VALIDATED_RESPONSE' };
    }
    let errorText: string | undefined;
    let code: string | number | undefined;
    let msg = '';
    if (parsed.error && typeof parsed.error === 'object') {
      const err = parsed.error;
      code = err.code ?? err.status ?? statusCode;
      msg = String(err.message || '').toLowerCase();
      errorText = JSON.stringify({ error: err });
    } else if (typeof parsed.error === 'string') {
      code = statusCode;
      msg = parsed.error.toLowerCase();
      errorText = JSON.stringify({ error: { message: parsed.error, code: statusCode } });
    } else if (typeof parsed.message === 'string') {
      const lower = parsed.message.toLowerCase();
      if (
        lower.includes('quota') || lower.includes('resource_exhausted') ||
        lower.includes('rate limit') || lower.includes('unavailable') ||
        (statusCode !== undefined && statusCode >= 400)
      ) {
        code = statusCode;
        msg = lower;
        errorText = JSON.stringify({ error: { message: parsed.message, code: statusCode } });
      }
    }
    if (errorText !== undefined) {
      const isQuota =
        code === 429 || code === 'RESOURCE_EXHAUSTED' ||
        (!msg.includes('quota project') && (
          msg.includes('individual quota reached') ||
          msg.includes('exhausted your quota') ||
          msg.includes('quota exceeded') ||
          msg.includes('resource_exhausted') ||
          (msg.includes('rate limit') && !msg.includes('project'))
        ));
      const isTransient = code === 503 || msg.includes('unavailable');
      return {
        state: 'VALIDATED_ERROR',
        isQuota,
        isTransient,
        category: isQuota ? 'account-quota' : isTransient ? 'upstream-transient' : undefined,
        errorText,
      };
    }
    return null;
  }
  public classifyProtocolFrame(
    contentType: string | undefined,
    buffer: Buffer | null,
    headers?: http.IncomingHttpHeaders,
    trailers?: NodeJS.Dict<string | string[]>,
    streamEnded?: boolean,
    statusCode?: number,
    isAlreadyDecoded: boolean = false,
  ): ProtocolFrameDecision {
    const grpcStatus = trailers?.['grpc-status'] ?? headers?.['grpc-status'];
    if (grpcStatus !== undefined && String(grpcStatus) !== '0') {
      const code = String(grpcStatus);
      const isQuota = code === '8';
      const isTransient = code === '14';
      return {
        state: 'VALIDATED_ERROR',
        isQuota,
        isTransient,
        category: isQuota ? 'account-quota' : isTransient ? 'upstream-transient' : undefined,
        errorText: `gRPC status ${code}: ${trailers?.['grpc-message'] ?? headers?.['grpc-message'] ?? ''}`,
      };
    }
    // Binary gRPC and gRPC-Web framing validation (5-byte header: 1 byte compressed flag + 4 bytes length)
    if (contentType?.includes('application/grpc') || contentType?.includes('application/grpc-web')) {
      if (!buffer || buffer.length === 0) {
        if (streamEnded) {
          const terminalStatus = trailers?.['grpc-status'] ?? headers?.['grpc-status'];
          if (terminalStatus !== undefined && String(terminalStatus) === '0') {
            return { state: 'VALIDATED_RESPONSE' };
          }
          return {
            state: 'VALIDATED_ERROR',
            category: 'malformed-upstream-message',
            isLocalValidationError: true,
            errorText: 'Empty gRPC stream at EOF without grpc-status: 0',
          };
        }
        return { state: 'NEED_MORE_DATA' };
      }
      if (buffer.length < 5) {
        return streamEnded
          ? {
              state: 'VALIDATED_ERROR',
              category: 'malformed-upstream-message',
              isLocalValidationError: true,
              errorText: 'Truncated gRPC frame header at EOF',
            }
          : { state: 'NEED_MORE_DATA' };
      }
      const flag = buffer.readUInt8(0);
      const msgLen = buffer.readUInt32BE(1);
      // gRPC-Web trailers frame (flag 0x80)
      if ((flag & 0x80) !== 0) {
        if (buffer.length < 5 + msgLen) {
          return streamEnded
            ? {
                state: 'VALIDATED_ERROR',
                category: 'malformed-upstream-message',
                isLocalValidationError: true,
                errorText: 'Truncated gRPC-Web trailers frame at EOF',
              }
            : { state: 'NEED_MORE_DATA' };
        }
        const trailerText = buffer.subarray(5, 5 + msgLen).toString('utf-8');
        const lines = trailerText.split(/\r?\n/);
        let frameGrpcStatus: string | undefined;
        let frameGrpcMessage: string | undefined;
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim().toLowerCase();
            const val = line.slice(colonIdx + 1).trim();
            if (key === 'grpc-status') frameGrpcStatus = val;
            if (key === 'grpc-message') frameGrpcMessage = val;
          }
        }
        if (frameGrpcStatus !== undefined && frameGrpcStatus !== '0') {
          const code = frameGrpcStatus;
          const isQuota = code === '8';
          const isTransient = code === '14';
          return {
            state: 'VALIDATED_ERROR',
            isQuota,
            isTransient,
            category: isQuota ? 'account-quota' : isTransient ? 'upstream-transient' : undefined,
            errorText: `gRPC-Web trailer status ${code}: ${frameGrpcMessage || ''}`,
          };
        }
        return { state: 'VALIDATED_RESPONSE' };
      }
      // Ordinary data frame: validate flag (0 = uncompressed, 1 = compressed)
      if (flag !== 0 && flag !== 1) {
        return {
          state: 'VALIDATED_ERROR',
          category: 'malformed-upstream-message',
          isLocalValidationError: true,
          errorText: `Invalid gRPC frame compressed flag: 0x${flag.toString(16)}`,
        };
      }
      if (buffer.length < 5 + msgLen) {
        return streamEnded
          ? {
              state: 'VALIDATED_ERROR',
              category: 'malformed-upstream-message',
              isLocalValidationError: true,
              errorText: 'Truncated gRPC message body at EOF',
            }
          : { state: 'NEED_MORE_DATA' };
      }
      return { state: 'VALIDATED_RESPONSE' };
    }
    // Decompress payload if content-encoding is present (e.g. gzip, deflate, br) with bounded output
    let effectiveBuffer = buffer;
    const encoding = headers?.['content-encoding'];
    if (!isAlreadyDecoded && buffer && buffer.length > 0 && typeof encoding === 'string') {
      const enc = encoding.toLowerCase().trim();
      const decompressOptions = { maxOutputLength: 65536 };
      if (enc === 'gzip' || enc === 'x-gzip') {
        try {
          effectiveBuffer = zlib.gunzipSync(buffer, decompressOptions);
        } catch {
          if (!streamEnded) return { state: 'NEED_MORE_DATA' };
          return {
            state: 'VALIDATED_ERROR',
            category: 'unsupported-encoding',
            isLocalValidationError: true,
            errorText: 'Failed to decompress gzip response body (or exceeded maxOutputLength)',
          };
        }
      } else if (enc === 'deflate') {
        try {
          effectiveBuffer = zlib.inflateSync(buffer, decompressOptions);
        } catch {
          if (!streamEnded) return { state: 'NEED_MORE_DATA' };
          return {
            state: 'VALIDATED_ERROR',
            category: 'unsupported-encoding',
            isLocalValidationError: true,
            errorText: 'Failed to decompress deflate response body (or exceeded maxOutputLength)',
          };
        }
      } else if (enc === 'br') {
        try {
          effectiveBuffer = zlib.brotliDecompressSync(buffer, decompressOptions);
        } catch {
          if (!streamEnded) return { state: 'NEED_MORE_DATA' };
          return {
            state: 'VALIDATED_ERROR',
            category: 'unsupported-encoding',
            isLocalValidationError: true,
            errorText: 'Failed to decompress brotli response body (or exceeded maxOutputLength)',
          };
        }
      }
    }
    if (!effectiveBuffer || effectiveBuffer.length === 0) {
      if (streamEnded) {
        if (contentType?.includes('application/json')) {
          return {
            state: 'VALIDATED_ERROR',
            category: 'malformed-upstream-message',
            isLocalValidationError: true,
            errorText: 'Empty JSON response body at EOF',
          };
        }
        return { state: 'VALIDATED_RESPONSE' };
      }
      return { state: 'NEED_MORE_DATA' };
    }
    const text = effectiveBuffer.toString('utf-8');
    const isSse = Boolean(contentType?.includes('text/event-stream'));
    if (isSse) {
      // SSE Framing: An event must end with a blank line (\n\n or \r\n\r\n)
      if (!text.includes('\n\n') && !text.includes('\r\n\r\n')) {
        return streamEnded
          ? {
              state: 'VALIDATED_ERROR',
              category: 'malformed-upstream-message',
              isLocalValidationError: true,
              errorText: 'Truncated SSE event at EOF',
            }
          : { state: 'NEED_MORE_DATA' };
      }
      // Parse complete events
      const rawEvents = text.split(/\r?\n\r?\n/);
      const completeEvents =
        text.endsWith('\n\n') || text.endsWith('\r\n\r\n')
          ? rawEvents.filter(Boolean)
          : rawEvents.slice(0, -1).filter(Boolean);
      if (completeEvents.length === 0) {
        return streamEnded
          ? {
              state: 'VALIDATED_ERROR',
              category: 'malformed-upstream-message',
              isLocalValidationError: true,
              errorText: 'No complete SSE events at EOF',
            }
          : { state: 'NEED_MORE_DATA' };
      }
      for (const eventStr of completeEvents) {
        const lines = eventStr.split(/\r?\n/);
        const dataLines: string[] = [];
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith(':')) {
            // Ignore SSE keep-alive/comment lines (Probe C10)
            continue;
          }
          if (trimmedLine.startsWith('data:')) {
            dataLines.push(trimmedLine.slice(5).trim());
          }
        }
        if (dataLines.length === 0) {
          // Event consisted entirely of comments or empty lines
          continue;
        }
        const dataContent = dataLines.join('\n');
        if (dataContent === '[DONE]') {
          return { state: 'VALIDATED_RESPONSE' };
        }
        try {
          const parsed = JSON.parse(dataContent);
          if (parsed && typeof parsed === 'object') {
            const envelopeDecision = this.classifyParsedEnvelope(parsed, statusCode);
            if (envelopeDecision) {
              return envelopeDecision;
            }
            return { state: 'VALIDATED_RESPONSE' };
          }
        } catch {
          // Incomplete JSON inside data event
          if (streamEnded) {
            return {
              state: 'VALIDATED_ERROR',
              category: 'malformed-upstream-message',
              isLocalValidationError: true,
              errorText: 'Malformed JSON inside SSE data event at EOF',
            };
          }
          return { state: 'NEED_MORE_DATA' };
        }
      }
      return streamEnded
        ? {
            state: 'VALIDATED_ERROR',
            category: 'malformed-upstream-message',
            isLocalValidationError: true,
            errorText: 'Incomplete SSE stream at EOF',
          }
        : { state: 'NEED_MORE_DATA' };
    }
    // JSON response (application/json or unspecified)
    const trimmed = text.trim();
    const isExplicitJson = Boolean(contentType?.includes('application/json'));
    // Probe C14: Content-Type: application/json with "not valid json"
    if (isExplicitJson && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return {
        state: 'VALIDATED_ERROR',
        category: 'malformed-upstream-message',
        isLocalValidationError: true,
        errorText: `Invalid JSON response body for application/json: ${trimmed.slice(0, 100)}`,
      };
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          const envelopeDecision = this.classifyParsedEnvelope(parsed, statusCode);
          if (envelopeDecision) {
            return envelopeDecision;
          }
          return { state: 'VALIDATED_RESPONSE' };
        }
      } catch {
        // Probe C08: Incomplete JSON at EOF (e.g. {"error":)
        if (streamEnded) {
          return {
            state: 'VALIDATED_ERROR',
            category: 'malformed-upstream-message',
            isLocalValidationError: true,
            errorText: `Truncated JSON response body at EOF: ${trimmed.slice(0, 100)}`,
          };
        }
        return { state: 'NEED_MORE_DATA' };
      }
    }
    // Other non-JSON, non-SSE text/binary responses
    if (streamEnded) {
      return { state: 'VALIDATED_RESPONSE' };
    }
    return { state: buffer && buffer.length > 0 ? 'VALIDATED_RESPONSE' : 'NEED_MORE_DATA' };
  }
  private executeUpstreamCall(
    method: string,
    url: string,
    headers: Record<string, string | string[]>,
    payload: Buffer,
    upstreamHost: string,
    onReqCreated?: (req: http.ClientRequest) => void,
    deadlineAt?: number,
    hasAlternativeAccounts: boolean = false,
  ): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    bodyStream: http.IncomingMessage;
    bufferedBody?: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const remainingDeadlineMs = deadlineAt ? deadlineAt - now : 60000;
      if (remainingDeadlineMs <= 0) {
        reject(new Error('Upstream attempt deadline exceeded before start'));
        return;
      }
      // When alternative accounts are available in the pool, fail fast on hanging upstream (20s)
      // to allow attempting other accounts before logical request deadline (120s) expires.
      // If no alternatives, allow slightly longer (35s) but still bounded.
      const defaultAttemptTimeoutMs = hasAlternativeAccounts ? 20000 : 35000;
      const attemptTimeoutMs = Math.min(defaultAttemptTimeoutMs, remainingDeadlineMs);
      const options: https.RequestOptions = {
        hostname: upstreamHost,
        port: 443,
        path: url,
        method,
        headers,
        timeout: 60000, // Inactivity timeout on socket
      };
      let settled = false, deadlineTimer: NodeJS.Timeout | null = null, upstreamResRef: http.IncomingMessage | null = null;
      const cleanupCall = () => { if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; } };
      const upstreamReq = https.request(options, (upstreamRes) => {
        upstreamResRef = upstreamRes;
        const statusCode = upstreamRes.statusCode || 200;
        // If error status, buffer entire error body before deciding (bounded to 1 MiB)
        if (statusCode >= 400) {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let bodyTruncated = false;
          const MAX_ERROR_BODY_BYTES = 1024 * 1024;
          upstreamRes.on('data', (c) => {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            totalBytes += buf.length;
            if (totalBytes <= MAX_ERROR_BODY_BYTES) {
              chunks.push(buf);
            } else {
              bodyTruncated = true;
            }
          });
          upstreamRes.on('end', () => {
            if (settled) return;
            settled = true;
            cleanupCall();
            let finalBody = Buffer.concat(chunks);
            const resHeaders = { ...upstreamRes.headers };
            if (bodyTruncated) {
              delete resHeaders['content-encoding'];
              finalBody = encodeErrorBody({
                code: statusCode,
                message: 'Upstream error response exceeded 1 MiB budget and was truncated.',
              });
              resHeaders['content-type'] = 'application/json; charset=utf-8';
              resHeaders['content-length'] = String(finalBody.length);
            } else if (resHeaders['content-length'] !== undefined) {
              resHeaders['content-length'] = String(finalBody.length);
            }
            resolve({
              statusCode,
              headers: resHeaders,
              bodyStream: upstreamRes,
              bufferedBody: finalBody,
            });
          });
          upstreamRes.on('error', (err) => {
            if (settled) return;
            settled = true;
            cleanupCall();
            reject(err);
          });
        } else {
          // Success status: stream directly
          // Response headers arrived - clear attempt deadline timer so streaming is not aborted!
          if (settled) return;
          settled = true;
          cleanupCall();
          resolve({
            statusCode,
            headers: upstreamRes.headers,
            bodyStream: upstreamRes,
          });
        }
      });
      onReqCreated?.(upstreamReq);
      // Inactivity timeout
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('Upstream socket inactivity timeout after 60s'));
      });
      // Overall attempt absolute deadline timer
      deadlineTimer = setTimeout(() => {
        cleanupCall();
        const timeoutErr = new Error(`Upstream attempt deadline exceeded after ${attemptTimeoutMs}ms`);
        upstreamReq.destroy(timeoutErr);
        if (upstreamResRef && !(upstreamResRef as any).destroyed) {
          (upstreamResRef as any).destroy(timeoutErr);
        }
        if (!settled) {
          settled = true;
          reject(timeoutErr);
        }
      }, attemptTimeoutMs);
      upstreamReq.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanupCall();
        reject(err);
      });
      if (payload.length > 0) {
        upstreamReq.write(payload);
      }
      upstreamReq.end();
    });
  }
  private extractSessionKey(
    req: http.IncomingMessage | http2.Http2ServerRequest,
    parsedBody: Record<string, unknown> | null,
  ): string | undefined {
    return extractSessionKey(req, parsedBody);
  }
  public createRelayCompletionPromise(
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse,
    bodyStream: Readable,
    releaseUpstreamReservation: () => void = () => {},
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const onDone = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      // Downstream completion
      res.once('finish', () => {
        releaseUpstreamReservation();
        onDone();
      });
      res.once('close', () => {
        releaseUpstreamReservation();
        onDone();
      });
      res.once('error', () => {
        releaseUpstreamReservation();
        onDone();
      });
      // Upstream events release upstream reservation slot without settling downstream promise prematurely
      bodyStream.once('end', () => {
        releaseUpstreamReservation();
      });
      bodyStream.once('error', (err: unknown) => {
        releaseUpstreamReservation();
        if (!res.writableEnded) {
          res.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      });
      bodyStream.once('close', () => {
        releaseUpstreamReservation();
        if (!bodyStream.readableEnded && !res.writableEnded) {
          res.destroy(new Error('Upstream stream closed prematurely'));
        }
      });
      req.once?.('close', () => {
        releaseUpstreamReservation();
        onDone();
      });
      req.once?.('aborted', () => {
        releaseUpstreamReservation();
        onDone();
      });
    });
  }
}
