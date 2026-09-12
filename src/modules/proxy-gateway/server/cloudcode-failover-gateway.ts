import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import crypto from 'node:crypto';
import { logger } from '../../../shared/logging/logger';
import { AccountLeaseService } from './account-lease.service';
import { CloudAccount } from '../../cloud-account/types';
import { RateLimitReason } from './rate-limit-tracker';
import { CaManager } from './cert/ca-manager';

export interface CloudCodeGatewayOptions {
  accountLeaseService?: AccountLeaseService;
  upstreamHost?: string;
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

    // Determine upstream target host from :authority or host header
    const targetHost =
      (req.headers[':authority'] as string) ||
      (req.headers['host'] as string)?.split(':')[0]?.trim() ||
      this.defaultUpstreamHost;

    if (!CaManager.isTargetHost(`${targetHost}:443`)) {
      logger.warn(`[CloudCodeGateway] Destination host not allowed for interception: ${targetHost}`);
      const anyRes = res as any;
      if (typeof anyRes.writeHead === 'function') {
        anyRes.writeHead(403, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          error: {
            code: 403,
            message: `Host ${targetHost} is not authorized for transparent interception`,
          },
        }),
      );
      return;
    }

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
        account &&
        typeof this.accountLeaseService?.startSessionMigration === 'function'
      ) {
        this.accountLeaseService.startSessionMigration(
          sessionKey,
          initialBinding?.generation ?? 1,
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

      if (
        payloadToSend.length > 0 ||
        method === 'POST' ||
        method === 'PUT' ||
        method === 'PATCH'
      ) {
        upstreamHeaders['content-length'] = String(payloadToSend.length);
      }

      logger.debug(
        `[CloudCodeGateway] Attempt ${attempt} account=${account?.email} headers: ${JSON.stringify(
          req.headers,
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
        const firstChunk = await new Promise<Buffer | null>((resolve, reject) => {
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
            const text = Buffer.concat(chunks).toString('utf-8');
            if (text.includes('\n') || totalBytes >= 512) {
              settled = true;
              cleanup();
              bodyStream.pause();
              resolve(Buffer.concat(chunks));
            }
          };
          const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
          };
          const onClose = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
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
            resolve(null);
          };
          bodyStream.on('data', onData);
          bodyStream.once('end', onEnd);
          bodyStream.once('close', onClose);
          bodyStream.once('error', onError);
          req.once?.('close', onClientClose);
          res.once?.('close', onClientClose);
        });

        if (clientAborted || res.destroyed) {
          cleanupActiveAttempt();
          bodyStream.destroy();
          return;
        }

        // Check terminal gRPC error when stream ends without data (Probe C14)
        const terminalGrpcStatus = bodyStream.trailers?.['grpc-status'] ?? headers['grpc-status'];
        if (firstChunk === null && terminalGrpcStatus !== undefined && String(terminalGrpcStatus) !== '0') {
          const statusStr = String(terminalGrpcStatus);
          cleanupActiveAttempt();
          bodyStream.destroy();
          if (statusStr === '8') {
            logger.warn(
              `[CloudCodeGateway] Terminal gRPC status 8 (RESOURCE_EXHAUSTED) in trailers for account ${
                account?.email || 'unknown'
              }. Rotating to next account...`,
            );
            if (this.accountLeaseService && account) {
              await this.accountLeaseService.markFromUpstreamError({
                accountIdOrEmail: account.id,
                status: 429,
                model: modelName,
                headers: { ...headers, ...bodyStream.trailers },
                reason: RateLimitReason.QuotaExhausted,
              });
            }
            continue;
          }
          if (statusStr === '14') {
            logger.warn(
              `[CloudCodeGateway] Terminal gRPC status 14 (UNAVAILABLE) in trailers for account ${
                account?.email || 'unknown'
              }. Retrying without penalty...`,
            );
            continue;
          }
          // Non-retriable terminal gRPC error
          responseCommitted = true;
          this.writeHeaders(res, statusCode, { ...headers, ...bodyStream.trailers });
          res.end();
          return;
        }

        // Validate first chunk using protocol-level error classifier (Probe C11, C12)
        const protocolError = this.parseProtocolQuotaError(contentType, firstChunk, headers, bodyStream.trailers);
        if (protocolError.isQuotaError) {
          logger.warn(
            `[CloudCodeGateway] Protocol quota error for account ${
              account?.email || 'unknown'
            }: ${protocolError.errorText}. Rotating to next account...`,
          );
          cleanupActiveAttempt();
          bodyStream.destroy();
          if (this.accountLeaseService && account) {
            await this.accountLeaseService.markFromUpstreamError({
              accountIdOrEmail: account.id,
              status: 429,
              model: modelName,
              body: protocolError.errorText,
              headers,
              reason: RateLimitReason.QuotaExhausted,
            });
          }
          continue;
        }

        // --- COMMIT POINT ---
        // Verify session binding or migration confirmation BEFORE committing response (Probe C22)
        if (sessionKey && account) {
          const currentBinding = this.accountLeaseService?.getSessionBinding?.(sessionKey);
          if (currentBinding && currentBinding.state === 'migrating') {
            if (typeof this.accountLeaseService?.confirmSessionMigration === 'function') {
              const confirmed = this.accountLeaseService.confirmSessionMigration(
                sessionKey,
                currentBinding.generation,
                account.id,
                requestId,
              );
              if (!confirmed) {
                logger.warn(
                  `[CloudCodeGateway] Migration confirmation rejected for session ${sessionKey} (lost race or mismatched owner); suppressing output`,
                );
                cleanupActiveAttempt();
                bodyStream.destroy();
                continue;
              }
            }
          } else if (typeof this.accountLeaseService?.bindSession === 'function') {
            const bound = this.accountLeaseService.bindSession(
              sessionKey,
              account.id,
              undefined,
              currentBinding?.generation ?? 1,
            );
            if (!bound && currentBinding && currentBinding.accountId !== account.id) {
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
          });
        });

        if (firstChunk && firstChunk.length > 0) {
          const drained = (res as any).write(firstChunk);
          if (!drained && !res.writableEnded) {
            await new Promise<void>((r) => (res as any).once('drain', r));
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

  private parseProtocolQuotaError(
    contentType: string | undefined,
    firstChunk: Buffer | null,
    headers: http.IncomingHttpHeaders,
    trailers?: http.IncomingHttpHeaders,
  ): { isQuotaError: boolean; isTransientError: boolean; errorText: string } {
    const grpcStatus = trailers?.['grpc-status'] ?? headers['grpc-status'];
    if (grpcStatus !== undefined && String(grpcStatus) !== '0') {
      const statusStr = String(grpcStatus);
      if (statusStr === '8') {
        return { isQuotaError: true, isTransientError: false, errorText: 'gRPC status 8: RESOURCE_EXHAUSTED' };
      }
      if (statusStr === '14') {
        return { isQuotaError: false, isTransientError: true, errorText: 'gRPC status 14: UNAVAILABLE' };
      }
      return { isQuotaError: false, isTransientError: false, errorText: `gRPC status ${statusStr}` };
    }

    if (!firstChunk || firstChunk.length === 0) {
      return { isQuotaError: false, isTransientError: false, errorText: '' };
    }

    const chunkStr = firstChunk.toString('utf-8');

    // SSE event-stream: check data lines
    if (contentType && contentType.includes('text/event-stream')) {
      const lines = chunkStr.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          const jsonPayload = trimmed.slice(5).trim();
          if (jsonPayload && jsonPayload !== '[DONE]') {
            try {
              const parsed = JSON.parse(jsonPayload);
              if (parsed && typeof parsed === 'object') {
                if (parsed.candidates || parsed.choices || parsed.functionCall || (parsed as any).parts) {
                  return { isQuotaError: false, isTransientError: false, errorText: '' };
                }
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
                  if (isQuota) {
                    return { isQuotaError: true, isTransientError: false, errorText: JSON.stringify(err) };
                  }
                }
              }
            } catch {
              // Fragmented chunk; ignore non-error frames
            }
          }
        }
      }
      return { isQuotaError: false, isTransientError: false, errorText: '' };
    }

    // JSON response
    try {
      const parsed = JSON.parse(chunkStr);
      if (parsed && typeof parsed === 'object') {
        if (parsed.candidates || parsed.choices || parsed.functionCall || (parsed as any).parts) {
          return { isQuotaError: false, isTransientError: false, errorText: '' };
        }
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
          if (isQuota) {
            return { isQuotaError: true, isTransientError: false, errorText: JSON.stringify(err) };
          }
        }
      }
    } catch {
      // Non-JSON or fragmented; inspect only if starts with error envelope and does not have candidates
      const trimmed = chunkStr.trim();
      if (
        trimmed.startsWith('{"error"') &&
        !trimmed.includes('"candidates"') &&
        !trimmed.includes('"choices"') &&
        !trimmed.includes('"functionCall"') &&
        (trimmed.includes('RESOURCE_EXHAUSTED') || trimmed.includes('429'))
      ) {
        return { isQuotaError: true, isTransientError: false, errorText: trimmed.slice(0, 512) };
      }
    }

    return { isQuotaError: false, isTransientError: false, errorText: '' };
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
