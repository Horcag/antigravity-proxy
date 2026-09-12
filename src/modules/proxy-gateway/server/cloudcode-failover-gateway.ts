import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import crypto from 'node:crypto';
import { logger } from '../../../shared/logging/logger';
import { AccountLeaseService } from './account-lease.service';
import { CloudAccount } from '../../cloud-account/types';
import { RateLimitReason } from './rate-limit-tracker';
import { CaManager, parseTargetAuthority } from './cert/ca-manager';

export interface ProtocolFrameDecision {
  state: 'NEED_MORE_DATA' | 'VALIDATED_RESPONSE' | 'VALIDATED_ERROR';
  isQuota?: boolean;
  isTransient?: boolean;
  errorText?: string;
}

export interface CloudCodeGatewayOptions {
  accountLeaseService?: AccountLeaseService;
  upstreamHost?: string;
}

export function isVerifiedSessionKey(key: string | undefined): boolean {
  return typeof key === 'string' && key.startsWith('session:');
}

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
      res.end(
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

    // F6: Early disconnect cleanup handlers attached immediately before any async wait
    let clientAborted = false;
    let activeReleaseReservation: (() => void) | undefined;
    let currentUpstreamReq: http.ClientRequest | undefined;
    let currentUpstreamRes: http.IncomingMessage | undefined;
    let responseCommitted = false;

    const cleanupActiveAttempt = () => {
      if (activeReleaseReservation) {
        activeReleaseReservation();
        activeReleaseReservation = undefined;
      }
    };

    const abortAll = () => {
      clientAborted = true;
      cleanupActiveAttempt();
      if (currentUpstreamReq && !currentUpstreamReq.destroyed) {
        currentUpstreamReq.destroy();
      }
      if (currentUpstreamRes && !currentUpstreamRes.destroyed) {
        currentUpstreamRes.destroy();
      }
    };

    req.once?.('aborted', () => {
      abortAll();
    });
    req.once?.('close', () => {
      if (!req.complete && (!responseCommitted || !res.writableEnded)) {
        abortAll();
      }
    });
    res.once?.('close', () => {
      if (!res.writableEnded) {
        abortAll();
      }
    });

    // 1. Buffer the full client request body
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      if (clientAborted) return;
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(bodyChunks);

    if (clientAborted || res.destroyed) {
      return;
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
        return;
      }

      let lease: {
        account: CloudAccount;
        sessionKey?: string;
        generation: number;
        releaseReservation: () => void;
      } | null = null;

      if (this.accountLeaseService) {
        if (typeof this.accountLeaseService.acquireAttemptLease === 'function') {
          lease = await this.accountLeaseService.acquireAttemptLease({
            model: modelName,
            excludeAccountIds: Array.from(attemptedAccountIds),
            sessionKey,
            deferSessionBinding: true,
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
          this.writeHeaders(res, 503, { 'content-type': 'application/json' });
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
        return;
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
      const attemptGeneration = lease?.generation ?? initialBinding?.generation ?? 1;

      if (
        attempt > 1 &&
        sessionKey &&
        isVerifiedSessionKey(sessionKey) &&
        account &&
        typeof this.accountLeaseService?.startSessionMigration === 'function'
      ) {
        this.accountLeaseService.startSessionMigration(
          sessionKey,
          attemptGeneration,
          account.id,
          requestId,
        );
      }

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

      if (
        payloadToSend.length > 0 ||
        method === 'POST' ||
        method === 'PUT' ||
        method === 'PATCH'
      ) {
        upstreamHeaders['content-length'] = String(payloadToSend.length);
      }

      // Redact sensitive headers before logging
      const redactedHeaders: Record<string, unknown> = { ...req.headers };
      for (const k of Object.keys(redactedHeaders)) {
        const lk = k.toLowerCase();
        if (
          lk.includes('auth') ||
          lk.includes('token') ||
          lk.includes('key') ||
          lk.includes('cookie') ||
          lk.includes('secret')
        ) {
          redactedHeaders[k] = '[REDACTED]';
        }
      }

      logger.debug(
        `[CloudCodeGateway] Attempt ${attempt} account=${account?.email} headers: ${JSON.stringify(
          redactedHeaders,
        )}`,
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
        );

        const { statusCode, headers, bodyStream, bufferedBody } = upstreamResult;
        currentUpstreamRes = bodyStream;

        if (clientAborted || res.destroyed) {
          cleanupActiveAttempt();
          bodyStream.destroy();
          return;
        }

        // Check for rate limit / quota exhaustion
        if (statusCode >= 400) {
          cleanupActiveAttempt();
          const errorText = bufferedBody ? bufferedBody.toString('utf-8') : '';
          const isRateLimited =
            statusCode === 429 ||
            (statusCode === 403 && this.isQuotaErrorText(errorText));

          if (isRateLimited) {
            logger.warn(
              `[CloudCodeGateway] Upstream returned ${statusCode} for account ${
                account?.email || 'unknown'
              } (attempt ${attempt}/${maxAttempts}). Rotating to next account...`,
            );

            if (this.accountLeaseService && account) {
              await this.accountLeaseService.markFromUpstreamError({
                accountIdOrEmail: account.id,
                status: statusCode,
                model: modelName,
                body: errorText,
                headers,
                reason: RateLimitReason.RateLimitExceeded,
              });
            }

            continue;
          }

          // Non-retriable error: commit to client
          responseCommitted = true;
          this.writeHeaders(res, statusCode, headers);
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
          const isQuotaExhausted = String(grpcStatus) === '8';
          if (isQuotaExhausted) {
            logger.warn(
              `[CloudCodeGateway] Upstream returned gRPC status 8 (RESOURCE_EXHAUSTED) for account ${
                account?.email || 'unknown'
              } (attempt ${attempt}/${maxAttempts}). Rotating to next account...`,
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

          responseCommitted = true;
          this.writeHeaders(res, statusCode, headers);
          res.end();
          return;
        }

        // F5 Pre-commit response validation: inspect first chunk of stream before writing headers
        // F5 Pre-commit response validation: inspect complete protocol frame before writing headers
        const firstChunkResult = await new Promise<{ buffer: Buffer | null; decision: ProtocolFrameDecision }>(
          (resolve, reject) => {
            let settled = false;
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            const cleanup = () => {
              bodyStream.removeListener('data', onData);
              bodyStream.removeListener('end', onEnd);
              bodyStream.removeListener('close', onClose);
              bodyStream.removeListener('error', onError);
              req.removeListener?.('close', onClientClose);
              res.removeListener?.('close', onClientClose);
            };
            const onData = (chunk: Buffer) => {
              if (settled) return;
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              chunks.push(buf);
              totalBytes += buf.length;
              const combined = Buffer.concat(chunks);
              const decision = this.classifyProtocolFrame(
                contentType,
                combined,
                headers,
                bodyStream.trailers,
              );
              if (decision.state !== 'NEED_MORE_DATA' || totalBytes >= 65536) {
                settled = true;
                cleanup();
                bodyStream.pause();
                resolve({ buffer: combined, decision });
              }
            };
            const onEnd = () => {
              if (settled) return;
              settled = true;
              cleanup();
              const combined = chunks.length > 0 ? Buffer.concat(chunks) : null;
              const decision = this.classifyProtocolFrame(
                contentType,
                combined,
                headers,
                bodyStream.trailers,
                true,
              );
              resolve({ buffer: combined, decision });
            };
            const onClose = () => {
              if (settled) return;
              settled = true;
              cleanup();
              if (!bodyStream.readableEnded) {
                reject(new Error('Upstream stream closed prematurely before response completion'));
              } else {
                const combined = chunks.length > 0 ? Buffer.concat(chunks) : null;
                const decision = this.classifyProtocolFrame(
                  contentType,
                  combined,
                  headers,
                  bodyStream.trailers,
                  true,
                );
                resolve({ buffer: combined, decision });
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
          return;
        }

        const firstChunk = firstChunkResult.buffer;
        const frameDecision = firstChunkResult.decision;

        // Terminal gRPC error or protocol error
        if (frameDecision.state === 'VALIDATED_ERROR') {
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
              `[CloudCodeGateway] Quota error for account ${
                account?.email || 'unknown'
              }: ${frameDecision.errorText}. Rotating to next account...`,
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
              `[CloudCodeGateway] Transient upstream error for account ${
                account?.email || 'unknown'
              }: ${frameDecision.errorText}. Retrying without quota penalty...`,
            );
            continue;
          }

          // Non-retriable protocol error
          responseCommitted = true;
          this.writeHeaders(res, statusCode, { ...headers, ...bodyStream.trailers });
          if (firstChunk && firstChunk.length > 0) {
            res.end(firstChunk);
          } else {
            res.end();
          }
          return;
        }

        // --- COMMIT POINT ---
        // Verify session binding or migration confirmation BEFORE committing response (Probe C22)
        if (sessionKey && account && isVerifiedSessionKey(sessionKey)) {
          if (typeof this.accountLeaseService?.confirmOrBindSession === 'function') {
            const confirmed = this.accountLeaseService.confirmOrBindSession(
              sessionKey,
              account.id,
              attemptGeneration,
              requestId,
            );
            if (confirmed === false) {
              logger.warn(
                `[CloudCodeGateway] Session confirmation rejected for session ${sessionKey} (lost race or mismatched owner); suppressing output`,
              );
              cleanupActiveAttempt();
              bodyStream.destroy();
              continue;
            }
          } else if (typeof this.accountLeaseService?.bindSession === 'function') {
            const bound = this.accountLeaseService.bindSession(
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

        responseCommitted = true;
        this.writeHeaders(res, statusCode, headers);

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
          bodyStream.destroy();
        });

        bodyStream.once('error', (err) => {
          logger.warn('[CloudCodeGateway] Upstream streaming error', err);
          if (!res.writableEnded) {
            res.destroy(err);
          }
        });

        // Set up relay completion waiter before starting stream flow (F5, F6)
        const relayCompletionPromise = new Promise<void>((resolve) => {
          let resolved = false;
          const onDone = () => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          };
          res.once('finish', onDone);
          res.once('close', onDone);
          bodyStream.once('error', (err) => {
            if (!res.writableEnded) {
              res.destroy(err);
            }
            onDone();
          });
          bodyStream.once('close', () => {
            if (!bodyStream.readableEnded && !res.writableEnded) {
              res.destroy(new Error('Upstream stream closed prematurely'));
            }
            onDone();
          });
        });

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
              return;
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

        cleanupActiveAttempt();
        return;
      } catch (err: unknown) {
        cleanupActiveAttempt();
        if (responseCommitted) {
          return;
        }
        logger.warn(
          `[CloudCodeGateway] Attempt ${attempt} failed with network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (attempt === maxAttempts) {
          responseCommitted = true;
          const anyRes = res as any;
          if (!anyRes.headersSent) {
            this.writeHeaders(res, 502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: 502,
                  message: `Failover gateway failed all attempts: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
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
      this.writeHeaders(res, 429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 429,
            message: 'All accounts in the Antigravity account pool are exhausted or rate-limited.',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
      );
    }
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

  public classifyProtocolFrame(
    contentType: string | undefined,
    buffer: Buffer | null,
    headers?: http.IncomingHttpHeaders,
    trailers?: NodeJS.Dict<string | string[]>,
    streamEnded?: boolean,
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
        errorText: `gRPC status ${code}: ${trailers?.['grpc-message'] ?? headers?.['grpc-message'] ?? ''}`,
      };
    }

    if (!buffer || buffer.length === 0) {
      return streamEnded ? { state: 'VALIDATED_RESPONSE' } : { state: 'NEED_MORE_DATA' };
    }

    const text = buffer.toString('utf-8');
    const isSse = Boolean(contentType?.includes('text/event-stream'));

    if (isSse) {
      // SSE Framing: An event must end with a blank line (\n\n or \r\n\r\n)
      if (!text.includes('\n\n') && !text.includes('\r\n\r\n')) {
        return { state: 'NEED_MORE_DATA' };
      }

      // Parse complete events
      const rawEvents = text.split(/\r?\n\r?\n/);
      const completeEvents =
        text.endsWith('\n\n') || text.endsWith('\r\n\r\n')
          ? rawEvents.filter(Boolean)
          : rawEvents.slice(0, -1).filter(Boolean);

      if (completeEvents.length === 0) {
        return { state: 'NEED_MORE_DATA' };
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
            if (parsed.error && typeof parsed.error === 'object') {
              const err = parsed.error;
              const code = err.code ?? err.status;
              const msg = String(err.message || '').toLowerCase();
              const isQuota =
                code === 429 ||
                code === 'RESOURCE_EXHAUSTED' ||
                msg.includes('quota') ||
                msg.includes('resource_exhausted') ||
                msg.includes('rate limit');
              return {
                state: 'VALIDATED_ERROR',
                isQuota,
                isTransient: code === 503 || msg.includes('unavailable'),
                errorText: JSON.stringify(err),
              };
            }
            if (
              parsed.candidates ||
              parsed.choices ||
              parsed.functionCall ||
              (parsed as any).parts ||
              (parsed as any).content
            ) {
              return { state: 'VALIDATED_RESPONSE' };
            }
            return { state: 'VALIDATED_RESPONSE' };
          }
        } catch {
          // Incomplete JSON inside data event
          return { state: 'NEED_MORE_DATA' };
        }
      }

      return { state: 'NEED_MORE_DATA' };
    }

    // JSON response (application/json or unspecified)
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return { state: buffer.length > 0 ? 'VALIDATED_RESPONSE' : 'NEED_MORE_DATA' };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if (parsed.error && typeof parsed.error === 'object') {
          const err = parsed.error;
          const code = err.code ?? err.status;
          const msg = String(err.message || '').toLowerCase();
          const isQuota =
            code === 429 ||
            code === 'RESOURCE_EXHAUSTED' ||
            msg.includes('quota') ||
            msg.includes('resource_exhausted') ||
            msg.includes('rate limit');
          return {
            state: 'VALIDATED_ERROR',
            isQuota,
            isTransient: code === 503 || msg.includes('unavailable'),
            errorText: JSON.stringify(err),
          };
        }
        if (
          parsed.candidates ||
          parsed.choices ||
          parsed.functionCall ||
          (parsed as any).parts ||
          (parsed as any).content
        ) {
          return { state: 'VALIDATED_RESPONSE' };
        }
        return { state: 'VALIDATED_RESPONSE' };
      }
    } catch {
      // Incomplete JSON (e.g. {\n or partial error envelope across chunks, Probe C11, C12)
      return { state: 'NEED_MORE_DATA' };
    }

    return { state: 'NEED_MORE_DATA' };
  }

  private executeUpstreamCall(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: Buffer,
    upstreamHost: string,
    onReqCreated?: (req: http.ClientRequest) => void,
  ): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    bodyStream: http.IncomingMessage;
    bufferedBody?: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: upstreamHost,
        port: 443,
        path: url,
        method,
        headers,
      };

      const upstreamReq = https.request(options, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 200;

        // If error status, buffer entire error body before deciding
        if (statusCode >= 400) {
          const chunks: Buffer[] = [];
          upstreamRes.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          upstreamRes.on('end', () => {
            resolve({
              statusCode,
              headers: upstreamRes.headers,
              bodyStream: upstreamRes,
              bufferedBody: Buffer.concat(chunks),
            });
          });
          upstreamRes.on('error', reject);
        } else {
          // Success status: stream directly
          resolve({
            statusCode,
            headers: upstreamRes.headers,
            bodyStream: upstreamRes,
          });
        }
      });

      onReqCreated?.(upstreamReq);
      upstreamReq.on('error', reject);

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
      return `session:${headerCandidate.trim()}`;
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
        return `session:${candidate.trim()}`;
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
}
