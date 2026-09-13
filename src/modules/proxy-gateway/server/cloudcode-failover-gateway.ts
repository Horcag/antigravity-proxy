import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { logger } from '../../../shared/logging/logger';
import { AccountLeaseService } from './account-lease.service';
import { CloudAccount } from '../../cloud-account/types';
import { RateLimitReason } from './rate-limit-tracker';
import { parseTargetAuthority } from './cert/ca-manager';
import {
  type MigrationCapability,
  isVerifiedSessionKey,
  isHintSessionKey,
} from './account-lease-selection-policy';
import { AnonymousTransportReceiptOwner } from './anonymous-transport-receipt';
export { isVerifiedSessionKey, isHintSessionKey };
export type ProtocolFailureCategory =
  | 'inspection-limit'
  | 'unsupported-encoding'
  | 'malformed-upstream-message'
  | 'deadline-exceeded'
  | 'account-quota'
  | 'upstream-transient';
export interface ProtocolFrameDecision {
  state: 'NEED_MORE_DATA' | 'VALIDATED_RESPONSE' | 'VALIDATED_ERROR';
  isQuota?: boolean;
  isTransient?: boolean;
  errorText?: string;
  category?: ProtocolFailureCategory;
  isLocalValidationError?: boolean;
}
export interface CloudCodeGatewayOptions {
  accountLeaseService?: AccountLeaseService;
  upstreamHost?: string;
}
export class GatewayReceiptTransferError extends Error { constructor(readonly receiptOwner: AnonymousTransportReceiptOwner, readonly originalCause: unknown) { super('Gateway receipt ownership transferred to ingress', { cause: originalCause }); this.name = 'GatewayReceiptTransferError'; } }

export function extractCanonicalUserTurnText(turn: unknown): string | null {
  if (!turn || typeof turn !== 'object') return null;
  const anyTurn = turn as any;
  if (typeof anyTurn.content === 'string' && anyTurn.content.trim()) {
    return anyTurn.content.trim();
  }
  if (Array.isArray(anyTurn.content)) {
    const texts = anyTurn.content
      .map((c: any) => {
        if (typeof c?.text === 'string') return c.text.trim();
        if (c?.type === 'image' && c?.source?.data) {
          const hash = crypto.createHash('sha256').update(c.source.data).digest('hex').slice(0, 16);
          return `image:${c.source.media_type || 'unknown'}:${hash}`;
        }
        if (c?.image_url?.url) return `image:${crypto.createHash('sha256').update(c.image_url.url).digest('hex').slice(0, 16)}`;
        if (c?.type) return `type:${c.type}`;
        return '';
      })
      .filter((t: string) => Boolean(t && t.trim()));
    if (texts.length > 0) return texts.join('\n');
  }
  if (Array.isArray(anyTurn.parts)) {
    const texts = anyTurn.parts
      .map((p: any) => {
        if (typeof p?.text === 'string') return p.text.trim();
        if (p?.inlineData?.data) {
          const hash = crypto.createHash('sha256').update(p.inlineData.data).digest('hex').slice(0, 16);
          return `inlineData:${p.inlineData.mimeType || 'unknown'}:${hash}`;
        }
        if (p?.functionCall) return `call:${JSON.stringify(p.functionCall)}`;
        return '';
      })
      .filter((t: string) => Boolean(t && t.trim()));
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}
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
    let deadlineWriteFailure: GatewayReceiptTransferError | null = null;
    try {
    const rawUrl = req.url || '/';
    let urlPath = rawUrl;
    if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
      try {
        const parsed = new URL(urlPath);
        urlPath = parsed.pathname + parsed.search;
      } catch {
        // preserve urlPath
      }
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
      const anyRes = res as any;
      if (typeof anyRes.writeHead === 'function') {
        anyRes.writeHead(403, { 'content-type': 'application/json' });
      }
      receiptOwner.expectDownstreamCommit('invalid_authority'); res.end(
        JSON.stringify({
          error: {
            code: 403,
            message: `Authority '${rawAuthority}' is not authorized for transparent interception`,
          },
        }),
      );
      return;
    }
    const targetHost = parsedAuthority.hostname;
    const requestAbortController = new AbortController();

    const LOGICAL_REQUEST_DEADLINE_MS = 120000;
    const requestStartTime = Date.now();
    const deadlineAt = requestStartTime + LOGICAL_REQUEST_DEADLINE_MS;
    let logicalDeadlineTimer: NodeJS.Timeout | null = null;

    const clearLogicalDeadline = () => {
      if (logicalDeadlineTimer) {
        clearTimeout(logicalDeadlineTimer);
        logicalDeadlineTimer = null;
      }
    };

    // F6: Early disconnect cleanup handlers attached immediately before any async wait
    let clientAborted = false;
    let activeReleaseReservation: (() => void) | undefined;
    let activeStopCandidateRenewal: (() => void) | undefined;
    let currentUpstreamReq: http.ClientRequest | undefined;
    let currentUpstreamRes: http.IncomingMessage | undefined;
    let responseCommitted = false; let exhaustedByUnavailable = false;
    const cleanupActiveAttempt = () => {
      if (activeStopCandidateRenewal) {
        activeStopCandidateRenewal();
        activeStopCandidateRenewal = undefined;
      }
      if (activeReleaseReservation) {
        activeReleaseReservation();
        activeReleaseReservation = undefined;
      }
    };
    const abortAll = () => {
      clientAborted = true;
      requestAbortController.abort();
      clearLogicalDeadline();
      cleanupActiveAttempt();
      if (currentUpstreamReq && !currentUpstreamReq.destroyed) {
        currentUpstreamReq.destroy();
      }
      if (currentUpstreamRes && !currentUpstreamRes.destroyed) {
        currentUpstreamRes.destroy();
      }
    };

    logicalDeadlineTimer = setTimeout(() => {
      clearLogicalDeadline();
      if (!responseCommitted && !res.headersSent && !res.writableEnded) {
        responseCommitted = true;
        abortAll();
        const errorBody = Buffer.from(
          JSON.stringify({
            error: {
              code: 504,
              status: 'DEADLINE_EXCEEDED',
              message: 'Gateway Timeout: Overall request deadline exceeded',
              category: 'deadline-exceeded',
            },
          }),
          'utf-8',
        );
        try {
          receiptOwner.expectDownstreamCommit('deadline_exceeded'); this.writeHeaders(res, 504, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(errorBody.length),
          });
          res.end(errorBody);
        } catch (err) {
          receiptOwner.reject('deadline_exceeded');
          deadlineWriteFailure = new GatewayReceiptTransferError(receiptOwner, err);
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

    // 1. Buffer the full client request body with explicit byte limit (64 MiB)
    const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
    let totalBodyBytes = 0;
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      if (clientAborted) return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBodyBytes += buf.length;
      if (totalBodyBytes > MAX_REQUEST_BODY_BYTES) {
        if (!res.headersSent) {
          receiptOwner.expectDownstreamCommit('request_too_large'); this.writeHeaders(res, 413, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 413,
                message: 'Payload Too Large: request body exceeds 64 MiB limit',
              },
            }),
          );
        }
        return;
      }
      bodyChunks.push(buf);
    }
    const rawBody = Buffer.concat(bodyChunks);

    if (clientAborted || res.destroyed) {
      return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
    }

    // 2. Parse payload if JSON to extract model and project
    let parsedBody: Record<string, unknown> | null = null;
    let modelName: string | undefined;
    try {
      if (rawBody.length > 0) {
        parsedBody = JSON.parse(rawBody.toString('utf-8'));
        if (parsedBody && typeof parsedBody === 'object') {
          if (typeof parsedBody.model === 'string' && parsedBody.model) {
            modelName = parsedBody.model;
          } else if (
            typeof (parsedBody.request as Record<string, unknown> | undefined)?.model === 'string'
          ) {
            modelName = (parsedBody.request as Record<string, unknown>).model as string;
          }
        }
      }
    } catch {
      // not JSON or stream; proceed with raw bytes
    }

    if (!modelName) {
      const urlMatch = urlPath.match(/\/models\/([^/:]+)/);
      if (urlMatch && urlMatch[1]) {
        modelName = urlMatch[1];
      }
    }

    const sessionKey = this.extractSessionKey(req, parsedBody);
    const requestId = crypto.randomUUID();

    // 3. Failover retry loop (ResponseCommitGate)
    const attemptedAccountIds = new Set<string>();
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (clientAborted || res.destroyed) {
        return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
      }

      const remainingTimeMs = deadlineAt - Date.now();
      if (remainingTimeMs <= 0) {
        logger.warn(
          `[CloudCodeGateway] Logical request deadline exceeded (${LOGICAL_REQUEST_DEADLINE_MS}ms) before attempt ${attempt}`,
        );
        if (!responseCommitted && !res.headersSent && !res.writableEnded) {
          responseCommitted = true;
          const errorBody = Buffer.from(
            JSON.stringify({
              error: {
                code: 504,
                status: 'DEADLINE_EXCEEDED',
                message: 'Gateway Timeout: Overall request deadline exceeded',
                category: 'deadline-exceeded',
              },
            }),
            'utf-8',
          );
          receiptOwner.expectDownstreamCommit('deadline_exceeded'); this.writeHeaders(res, 504, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(errorBody.length),
          });
          res.end(errorBody);
        }
        return;
      }

      let lease: {
        account: CloudAccount;
        sessionKey?: string;
        generation: number;
        tableIncarnation?: number;
        releaseReservation: () => void;
      } | null = null;

      if (this.accountLeaseService) {
        if (typeof this.accountLeaseService.acquireAttemptLease === 'function') {
          lease = await this.accountLeaseService.acquireAttemptLease({
            model: modelName,
            excludeAccountIds: Array.from(attemptedAccountIds),
            sessionKey,
            deferSessionBinding: true,
            signal: requestAbortController.signal,
          });
        } else {
          const acc = await this.accountLeaseService.getNextToken({
            model: modelName,
            excludeAccountIds: Array.from(attemptedAccountIds),
            sessionKey,
            deferSessionBinding: true,
          });
          if (acc) {
            lease = {
              account: acc,
              sessionKey,
              generation: 1,
              tableIncarnation: this.accountLeaseService.getTableIncarnation?.(),
              releaseReservation: acc.releaseReservation ?? (() => {}),
            };
          }
        }
      }

      if (this.accountLeaseService && !lease) {
        logger.warn(
          `[CloudCodeGateway] No account lease available in managed pool on attempt ${attempt}. Disallowing unreserved passthrough.`,
        );
        if (!responseCommitted && !res.writableEnded) {
          responseCommitted = true;
          receiptOwner.expectDownstreamCommit('unavailable'); this.writeHeaders(res, 503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 503,
                message: 'No available upstream account capacity in managed pool',
                status: 'UNAVAILABLE',
              },
            }),
          );
        }
        return;
      }

      if (clientAborted || res.destroyed) {
        lease?.releaseReservation?.();
        return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
      }

      const account = lease?.account ?? null;
      if (account) {
        attemptedAccountIds.add(account.id);
      }

      activeReleaseReservation = lease?.releaseReservation;

      const initialBinding =
        sessionKey && typeof this.accountLeaseService?.getSessionBinding === 'function'
          ? this.accountLeaseService.getSessionBinding(sessionKey)
          : null;
      let attemptGeneration = lease?.generation ?? initialBinding?.generation ?? 1;
      const attemptTableIncarnation = lease?.tableIncarnation ?? initialBinding?.tableIncarnation;
      let migrationCapability: MigrationCapability | null = null;

      const needsMigration = Boolean(
        sessionKey &&
        isVerifiedSessionKey(sessionKey) &&
        account &&
        initialBinding &&
        initialBinding.accountId !== account.id,
      );

      if (
        (attempt > 1 || needsMigration) &&
        sessionKey &&
        isVerifiedSessionKey(sessionKey) &&
        account &&
        typeof this.accountLeaseService?.startSessionMigration === 'function'
      ) {
        migrationCapability = this.accountLeaseService.startSessionMigration(
          sessionKey,
          attemptGeneration,
          account.id,
          requestId,
          attemptTableIncarnation,
        );
        if (migrationCapability) {
          attemptGeneration = migrationCapability.generation;
        }
      }

      let candidateRenewalTimer: NodeJS.Timeout | null = null;
      if (sessionKey && isVerifiedSessionKey(sessionKey) && migrationCapability) {
        const cap = migrationCapability;
        candidateRenewalTimer = setInterval(() => {
          try {
            const renewed = this.accountLeaseService?.renewSessionMigration?.(
              sessionKey,
              cap.generation,
              requestId,
              30000,
              cap.tableIncarnation,
            );
            if (renewed === false) {
              logger.warn(
                `[CloudCodeGateway] Candidate migration renewal rejected for session ${sessionKey}`,
              );
            }
          } catch { /* empty */ }
        }, 15000);
        candidateRenewalTimer.unref?.();
      }

      const stopCandidateRenewal = () => {
        if (candidateRenewalTimer) {
          clearInterval(candidateRenewalTimer);
          candidateRenewalTimer = null;
        }
      };
      activeStopCandidateRenewal = stopCandidateRenewal;

      // Prepare payload with account-specific project if applicable
      let payloadToSend = rawBody;
      const projectId = account?.token?.project_id;
      if (parsedBody && projectId) {
        if ('project' in parsedBody && parsedBody.project !== undefined) {
          const cloned = { ...parsedBody, project: projectId };
          payloadToSend = Buffer.from(JSON.stringify(cloned), 'utf-8');
        } else if (
          parsedBody.request &&
          typeof parsedBody.request === 'object' &&
          'project' in (parsedBody.request as Record<string, unknown>)
        ) {
          const cloned = {
            ...parsedBody,
            request: { ...(parsedBody.request as Record<string, unknown>), project: projectId },
          };
          payloadToSend = Buffer.from(JSON.stringify(cloned), 'utf-8');
        }
      }

      // Build upstream request headers
      const upstreamHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!key.startsWith(':') && key.toLowerCase() !== 'host') {
          if (Array.isArray(value)) {
            upstreamHeaders[key] = value.join(', ');
          } else if (value !== undefined) {
            upstreamHeaders[key] = String(value);
          }
        }
      }

      upstreamHeaders['host'] = targetHost;

      // Strip hop-by-hop and incoming transfer framing so outbound is valid HTTP
      delete upstreamHeaders['transfer-encoding'];
      delete upstreamHeaders['connection'];
      delete upstreamHeaders['proxy-connection'];
      delete upstreamHeaders['proxy-authorization'];
      delete upstreamHeaders['te'];
      delete upstreamHeaders['keep-alive'];
      delete upstreamHeaders['upgrade'];
      delete upstreamHeaders['x-ag-proxy-session-id'];
      delete upstreamHeaders['x-goog-session-id'];

      // Also strip any connection-nominated headers
      const connHeader = req.headers['connection'];
      if (typeof connHeader === 'string') {
        const nominated = connHeader.split(',').map((s) => s.trim().toLowerCase());
        for (const h of nominated) {
          delete upstreamHeaders[h];
        }
      }

      if (
        payloadToSend.length > 0 ||
        method === 'POST' ||
        method === 'PUT' ||
        method === 'PATCH'
      ) {
        upstreamHeaders['content-length'] = String(payloadToSend.length);
      }

      logger.debug(
        `[CloudCodeGateway] Attempt ${attempt} model=${modelName || 'default'} operation=upstream_attempt`,
      );

      if (account?.token?.access_token) {
        upstreamHeaders['authorization'] = `Bearer ${account.token.access_token}`;
      } else if (!account && attempt === 1 && req.headers['authorization']) {
        upstreamHeaders['authorization'] = String(req.headers['authorization']);
      }

      if (projectId && req.headers['x-goog-user-project']) {
        upstreamHeaders['x-goog-user-project'] = projectId;
      }

      try {
        const upstreamResult = await this.executeUpstreamCall(
          method,
          urlPath,
          upstreamHeaders,
          payloadToSend,
          targetHost,
          (upReq) => {
            currentUpstreamReq = upReq;
          },
          deadlineAt,
        );

        const { statusCode, headers, bodyStream, bufferedBody } = upstreamResult;
        currentUpstreamRes = bodyStream;

        if (clientAborted || res.destroyed) {
          cleanupActiveAttempt();
          bodyStream.destroy();
          return deadlineWriteFailure ? Promise.reject(deadlineWriteFailure) : undefined;
        }

        // Check for rate limit / quota exhaustion
        if (statusCode >= 400) {
          cleanupActiveAttempt();
          const errorText = bufferedBody ? bufferedBody.toString('utf-8') : '';
          const isRateLimited =
            statusCode === 429 ||
            (statusCode === 403 && this.isQuotaErrorText(errorText));

          if (isRateLimited) {
            const isQuota = this.isQuotaErrorText(errorText);
            logger.warn(
              `[CloudCodeGateway] Upstream returned ${statusCode} (attempt ${attempt}/${maxAttempts}). Rotating to next account...`,
            );

            if (
              sessionKey &&
              isVerifiedSessionKey(sessionKey) &&
              account &&
              typeof this.accountLeaseService?.failSessionMigrationCandidate === 'function'
            ) {
              this.accountLeaseService.failSessionMigrationCandidate(
                sessionKey,
                attemptGeneration,
                account.id,
                requestId,
              );
            }

            if (this.accountLeaseService && account) {
              await this.accountLeaseService.markFromUpstreamError({
                accountIdOrEmail: account.id,
                status: statusCode,
                model: modelName,
                body: errorText,
                headers,
                reason: isQuota ? RateLimitReason.QuotaExhausted : RateLimitReason.RateLimitExceeded,
              });
            }

            continue;
          }

          // Non-retriable error: commit to client
          responseCommitted = true;
          receiptOwner.expectDownstreamCommit(statusCode === 413 ? 'request_too_large' : 'bad_gateway'); this.writeHeaders(res, statusCode, headers);
          if (bufferedBody && bufferedBody.length > 0) {
            res.end(bufferedBody);
          } else {
            res.end();
          }
          return;
        }

        // F5 gRPC status header check on 200 OK
        const contentType = headers['content-type'] ? String(headers['content-type']) : undefined;
        const grpcStatus = headers['grpc-status'];
        if (grpcStatus !== undefined && String(grpcStatus) !== '0') {
          cleanupActiveAttempt();
          bodyStream.destroy();
          if (
            sessionKey &&
            isVerifiedSessionKey(sessionKey) &&
            account &&
            typeof this.accountLeaseService?.failSessionMigrationCandidate === 'function'
          ) {
            this.accountLeaseService.failSessionMigrationCandidate(
              sessionKey,
              attemptGeneration,
              account.id,
              requestId,
            );
          }

          const code = String(grpcStatus);
          const isQuotaExhausted = code === '8';
          const isTransient = code === '14';
          if (isQuotaExhausted) {
            logger.warn(
              `[CloudCodeGateway] Upstream returned gRPC status 8 (RESOURCE_EXHAUSTED) (attempt ${attempt}/${maxAttempts}). Rotating to next account...`,
            );
            if (this.accountLeaseService && account) {
              await this.accountLeaseService.markFromUpstreamError({
                accountIdOrEmail: account.id,
                status: 429,
                model: modelName,
                headers,
                reason: RateLimitReason.QuotaExhausted,
              });
            }
            continue;
          }

          if (isTransient) {
            exhaustedByUnavailable = true;
            logger.warn(
              `[CloudCodeGateway] Upstream returned transient gRPC status 14 (UNAVAILABLE) (attempt ${attempt}/${maxAttempts}). Retrying without quota penalty...`,
            );
            continue;
          }

          responseCommitted = true;
          receiptOwner.expectDownstreamCommit('bad_gateway'); this.writeHeaders(res, statusCode, headers);
          res.end();
          return;
        }

        // F5 Pre-commit response validation: inspect first chunk of stream before writing headers
        // F5 Pre-commit response validation: inspect complete protocol frame before writing headers
        const firstChunkResult = await new Promise<{ buffer: Buffer | null; decision: ProtocolFrameDecision }>(
          (resolve, reject) => {
            let settled = false;
            const chunks: Buffer[] = [];
            let totalRawBytes = 0;
            let decompressedBytes = 0;
            const decompressedChunks: Buffer[] = [];

            // Bounded spool budget: allow non-streaming payloads (e.g. JSON model lists, code assist) up to 10 MiB to be fully spooled and verified
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

              // Local inspection budget exhausted without qualifying frame:
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
                  // Give asynchronous decompressor an opportunity to process already-admitted input
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
            cleanupActiveAttempt();
            bodyStream.destroy();
            if (
              sessionKey &&
              isVerifiedSessionKey(sessionKey) &&
              account &&
              typeof this.accountLeaseService?.failSessionMigrationCandidate === 'function'
            ) {
              this.accountLeaseService.failSessionMigrationCandidate(
                sessionKey,
                attemptGeneration,
                account.id,
                requestId,
              );
            }

            if (frameDecision.isQuota) {
              logger.warn(
                `[CloudCodeGateway] Quota exhausted (attempt ${attempt}/${maxAttempts}) model=${modelName || 'default'}. Rotating to next account...`,
              );
              if (this.accountLeaseService && account) {
                await this.accountLeaseService.markFromUpstreamError({
                  accountIdOrEmail: account.id,
                  status: 429,
                  model: modelName,
                  body: frameDecision.errorText,
                  headers: { ...headers, ...bodyStream.trailers },
                  reason: RateLimitReason.QuotaExhausted,
                });
              }
              continue;
            }

            if (frameDecision.isTransient) {
              logger.warn(
                `[CloudCodeGateway] Transient upstream error (attempt ${attempt}/${maxAttempts}) model=${modelName || 'default'}. Retrying without quota penalty...`,
              );
              continue;
            }

            // Locally detected protocol violation or validation error on HTTP 2xx:
            // Synthesize 502 Bad Gateway rather than forwarding malformed data under HTTP 200 (Probe C10 / T13-F03)
            if (frameDecision.isLocalValidationError || (statusCode >= 200 && statusCode < 300)) {
              responseCommitted = true;
              receiptOwner.expectDownstreamCommit('bad_gateway'); const errorBody = Buffer.from(
                JSON.stringify({
                  error: {
                    code: 502,
                    status: 'BAD_GATEWAY',
                    message: `Bad Gateway: ${frameDecision.errorText || 'Upstream response validation failed'}`,
                    category: frameDecision.category || 'malformed-upstream-message',
                  },
                }),
                'utf-8',
              );
              this.writeHeaders(res, 502, {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(errorBody.length),
              });
              res.end(errorBody);
              return;
            }

            // Authentic non-retriable provider error: commit to client with original status
            responseCommitted = true;
            receiptOwner.expectDownstreamCommit('bad_gateway'); this.writeHeaders(res, statusCode, { ...headers, ...bodyStream.trailers });
            if (firstChunk && firstChunk.length > 0) {
              res.end(firstChunk);
            } else {
              res.end();
            }
            return;
          }

          case 'NEED_MORE_DATA': {
            // Buffer threshold exceeded (64KiB) without qualifying frame:
            // A local inspection limit is not an account failure and should not rotate accounts (T13-F03 / Probe C09)
            cleanupActiveAttempt();
            bodyStream.destroy();
            logger.warn(
              `[CloudCodeGateway] Protocol frame inspection limit exceeded (NEED_MORE_DATA) (attempt ${attempt}/${maxAttempts})`,
            );
            responseCommitted = true;
            receiptOwner.expectDownstreamCommit('bad_gateway'); const errorBody = Buffer.from(
              JSON.stringify({
                error: {
                  code: 502,
                  status: 'BAD_GATEWAY',
                  message: 'Bad Gateway: Protocol frame inspection limit exceeded without valid structure',
                  category: 'inspection-limit',
                },
              }),
              'utf-8',
            );
            this.writeHeaders(res, 502, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(errorBody.length),
            });
            res.end(errorBody);
            return;
          }

          case 'VALIDATED_RESPONSE': {
            // --- COMMIT POINT ---
            // T13-F06: Populating hint store on native success
            if (sessionKey && account) {
              if (isHintSessionKey(sessionKey)) {
                if (typeof this.accountLeaseService?.recordCacheHint === 'function') {
                  this.accountLeaseService.recordCacheHint(sessionKey, account.id);
                }
              } else if (isVerifiedSessionKey(sessionKey)) {
                const expectedIncarnation = lease?.tableIncarnation ?? migrationCapability?.tableIncarnation;
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
                  const isRejected =
                    (typeof commitResult === 'boolean' && !commitResult) ||
                    (typeof commitResult === 'object' &&
                      commitResult !== null &&
                      commitResult.kind === 'rejected');
                  if (isRejected) {
                    logger.warn(
                      `[CloudCodeGateway] Session confirmation rejected for session ${sessionKey} (${(commitResult as any)?.reason ?? 'rejected'}); suppressing output`,
                    );
                    cleanupActiveAttempt();
                    bodyStream.destroy();
                    continue;
                  }
                } else if (typeof this.accountLeaseService?.bindSession === 'function') {
                  const bound =
                    expectedIncarnation !== undefined
                      ? this.accountLeaseService.bindSession(
                          sessionKey,
                          account.id,
                          undefined,
                          attemptGeneration,
                          expectedIncarnation,
                        )
                      : this.accountLeaseService.bindSession(
                          sessionKey,
                          account.id,
                          undefined,
                          attemptGeneration,
                        );
                  if (bound === false) {
                    logger.warn(
                      `[CloudCodeGateway] Session binding rejected for session ${sessionKey} (lost race); suppressing output`,
                    );
                    cleanupActiveAttempt();
                    bodyStream.destroy();
                    continue;
                  }
                }
              }
            }

            responseCommitted = true;
            receiptOwner.expectDownstreamCommit('validated_response'); stopCandidateRenewal();
            this.writeHeaders(res, statusCode, headers);
            break;
          }
        }

        const onStreamEnd = () => {
          if (bodyStream.trailers && typeof (res as any).addTrailers === 'function' && !res.writableEnded) {
            (res as any).addTrailers(bodyStream.trailers);
          }
          if (!res.writableEnded) {
            res.end();
          }
        };

        bodyStream.once('end', onStreamEnd);

        res.once('close', () => {
          clearLogicalDeadline();
          bodyStream.destroy();
        });

        bodyStream.once('error', (err) => {
          logger.warn(
            '[CloudCodeGateway] Upstream streaming error: operation=upstream_stream reason=stream_error',
          );
          if (!res.writableEnded) {
            res.destroy(err);
          }
        });

        // T12-F06: Differentiate upstream attempt slot release from downstream relay completion
        let upstreamFinished = false;
        const releaseUpstreamReservation = () => {
          if (!upstreamFinished) {
            upstreamFinished = true;
            activeReleaseReservation?.();
            activeReleaseReservation = undefined;
          }
        };

        // Set up relay completion waiter before starting stream flow (F5, F6)
        const relayCompletionPromise = this.createRelayCompletionPromise(
          req,
          res,
          bodyStream,
          releaseUpstreamReservation,
        );

        if (firstChunk && firstChunk.length > 0) {
          const drained = (res as any).write(firstChunk);
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
          bodyStream.resume();
          bodyStream.pipe(res, { end: false });
        }

        await relayCompletionPromise;

        clearLogicalDeadline();
        cleanupActiveAttempt();
        return;
      } catch {
        cleanupActiveAttempt();
        if (deadlineWriteFailure) throw deadlineWriteFailure;
        if (responseCommitted) {
          return;
        }
        logger.warn(
          `[CloudCodeGateway] Upstream network error: operation=upstream_request reason=network_error attempt=${attempt}/${maxAttempts}`,
        );
        if (attempt === maxAttempts) {
          responseCommitted = true;
          const anyRes = res as any;
          if (!anyRes.headersSent) {
            receiptOwner.expectDownstreamCommit('bad_gateway'); this.writeHeaders(res, 502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: 502,
                  message: 'Failover gateway failed all attempts: network error',
                },
              }),
            );
          }
          return;
        }
      }
    }

    // All accounts exhausted
    const anyRes = res as any;
    if (!anyRes.headersSent) {
      const exhaustedClassification = exhaustedByUnavailable ? 'unavailable' : 'rate_limited';
      receiptOwner.expectDownstreamCommit(exhaustedClassification); this.writeHeaders(res, exhaustedByUnavailable ? 503 : 429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: exhaustedByUnavailable ? 503 : 429,
            message: exhaustedByUnavailable ? 'All upstream attempts are unavailable.' : 'All accounts in the Antigravity account pool are exhausted or rate-limited.',
            status: exhaustedByUnavailable ? 'UNAVAILABLE' : 'RESOURCE_EXHAUSTED',
          },
        }),
      );
    }
    } catch (err) { if (deadlineWriteFailure) throw deadlineWriteFailure; if (err instanceof GatewayReceiptTransferError) throw err; throw new GatewayReceiptTransferError(receiptOwner, err); }
  }

  private writeHeaders(
    res: http.ServerResponse | http2.Http2ServerResponse,
    statusCode: number,
    headers: http.IncomingHttpHeaders,
  ): void {
    const responseHeaders: Record<string, string | string[]> = {};
    const forbidden = new Set([
      'connection',
      'keep-alive',
      'proxy-connection',
      'transfer-encoding',
      'upgrade',
    ]);

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
    return (
      lower.includes('quota') ||
      lower.includes('resource_exhausted') ||
      lower.includes('rate limit') ||
      lower.includes('credit')
    );
  }

  private classifyParsedEnvelope(
    parsed: any,
    statusCode?: number,
  ): ProtocolFrameDecision | null {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

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
      errorText = JSON.stringify(err);
    } else if (typeof parsed.error === 'string') {
      code = statusCode;
      msg = parsed.error.toLowerCase();
      errorText = parsed.error;
    } else if (typeof parsed.message === 'string') {
      const lower = parsed.message.toLowerCase();
      if (
        lower.includes('quota') || lower.includes('resource_exhausted') ||
        lower.includes('rate limit') || lower.includes('unavailable') ||
        (statusCode !== undefined && statusCode >= 400)
      ) {
        code = statusCode;
        msg = lower;
        errorText = parsed.message;
      }
    }

    if (errorText !== undefined) {
      const isQuota =
        code === 429 || code === 'RESOURCE_EXHAUSTED' ||
        msg.includes('individual quota reached') || msg.includes('quota') ||
        msg.includes('resource_exhausted') || msg.includes('rate limit');
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
    headers: Record<string, string>,
    payload: Buffer,
    upstreamHost: string,
    onReqCreated?: (req: http.ClientRequest) => void,
    deadlineAt?: number,
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
      const attemptTimeoutMs = Math.min(60000, remainingDeadlineMs);

      const options: https.RequestOptions = {
        hostname: upstreamHost,
        port: 443,
        path: url,
        method,
        headers,
        timeout: 60000, // Inactivity timeout on socket
      };

      let settled = false;
      let deadlineTimer: NodeJS.Timeout | null = null;
      let upstreamResRef: http.IncomingMessage | null = null;

      const cleanupCall = () => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
      };

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
              finalBody = Buffer.from(
                JSON.stringify({
                  error: {
                    code: statusCode,
                    message: 'Upstream error response exceeded 1 MiB budget and was truncated.',
                  },
                }),
                'utf-8',
              );
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
          // Do not clear deadlineTimer here: allow it to protect body stream trickling!
          if (settled) return;
          settled = true;
          upstreamRes.once('end', cleanupCall);
          upstreamRes.once('close', cleanupCall);
          upstreamRes.once('error', cleanupCall);
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
    // 1. Explicit headers (session-id, conversation-id, etc.)
    const headers = req.headers;
    const headerCandidate =
      headers['x-ag-proxy-session-id'] ||
      headers['x-session-id'] ||
      headers['x-conversation-id'] ||
      headers['x-cloudcode-session-id'] ||
      headers['session-id'] ||
      headers['conversation-id'];
    if (typeof headerCandidate === 'string' && headerCandidate.trim()) {
      const trimmed = headerCandidate.trim();
      return trimmed.startsWith('hint:') || trimmed.startsWith('session:')
        ? trimmed
        : `session:${trimmed}`;
    }

    if (parsedBody && typeof parsedBody === 'object') {
      // 2. Explicit body fields
      const candidate =
        parsedBody.sessionId ??
        parsedBody.session_id ??
        parsedBody.conversationId ??
        parsedBody.conversation_id ??
        (parsedBody.metadata as Record<string, unknown> | undefined)?.sessionId ??
        (parsedBody.metadata as Record<string, unknown> | undefined)?.session_id ??
        (parsedBody.metadata as Record<string, unknown> | undefined)?.conversationId ??
        (parsedBody.metadata as Record<string, unknown> | undefined)?.conversation_id ??
        (parsedBody.request as Record<string, unknown> | undefined)?.sessionId ??
        (parsedBody.request as Record<string, unknown> | undefined)?.session_id ??
        (parsedBody.request as Record<string, unknown> | undefined)?.conversationId ??
        (parsedBody.request as Record<string, unknown> | undefined)?.conversation_id;

      if (typeof candidate === 'string' && candidate.trim()) {
        const trimmed = candidate.trim();
        return trimmed.startsWith('hint:') || trimmed.startsWith('session:')
          ? trimmed
          : `session:${trimmed}`;
      }

      // 3. Multi-turn chat prefix fingerprinting: Google CloudCode contents
      const contents =
        (Array.isArray(parsedBody.contents) ? parsedBody.contents : null) ??
        (Array.isArray((parsedBody.request as Record<string, unknown> | undefined)?.contents)
          ? ((parsedBody.request as Record<string, unknown>).contents as unknown[])
          : null);

      if (contents && contents.length > 0) {
        const userTurn = contents.find((c: any) => c?.role === 'user' || !c?.role);
        const text = extractCanonicalUserTurnText(userTurn);
        if (text) {
          const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
          return `hint:prefix:${hash}`;
        }
      }

      // Anthropic / OpenAI format: messages
      const messages =
        (Array.isArray(parsedBody.messages) ? parsedBody.messages : null) ??
        (Array.isArray((parsedBody.request as Record<string, unknown> | undefined)?.messages)
          ? ((parsedBody.request as Record<string, unknown>).messages as unknown[])
          : null);

      if (messages && messages.length > 0) {
        const userMsg = messages.find((m: any) => m?.role === 'user');
        const text = extractCanonicalUserTurnText(userMsg);
        if (text) {
          const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
          return `hint:prefix:${hash}`;
        }
      }
    }

    return undefined;
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
