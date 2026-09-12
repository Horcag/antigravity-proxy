import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import crypto from 'node:crypto';
import { logger } from '../../../shared/logging/logger';
import { AccountLeaseService } from './account-lease.service';
import { CloudAccount } from '../../cloud-account/types';
import { RateLimitReason } from './rate-limit-tracker';

export interface CloudCodeGatewayOptions {
  accountLeaseService?: AccountLeaseService;
  upstreamHost?: string;
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

    // 1. Buffer the full client request body
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(bodyChunks);

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

    // 3. Failover retry loop (ResponseCommitGate)
    const attemptedAccountIds = new Set<string>();
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let account: CloudAccount | null = null;
      if (this.accountLeaseService) {
        account = await this.accountLeaseService.getNextToken({
          model: modelName,
          excludeAccountIds: Array.from(attemptedAccountIds),
          sessionKey,
        });
      }

      if (account) {
        attemptedAccountIds.add(account.id);
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
        );

        const { statusCode, headers, bodyStream, bufferedBody } = upstreamResult;

        // Check for rate limit / quota exhaustion
        if (statusCode >= 400) {
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
                status: 429,
                model: modelName,
                reason: RateLimitReason.RateLimitExceeded,
              });
            }

            continue;
          }

          // Non-retriable error: commit to client
          this.writeHeaders(res, statusCode, headers);
          if (bufferedBody && bufferedBody.length > 0) {
            res.end(bufferedBody);
          } else {
            res.end();
          }
          return;
        }

        // --- COMMIT POINT ---
        // Success (200 OK): rebind session to successful account and stream response
        if (sessionKey && account && this.accountLeaseService) {
          this.accountLeaseService.bindSession(sessionKey, account.id);
        }

        this.writeHeaders(res, statusCode, headers);

        bodyStream.pipe(res);

        res.on('close', () => {
          bodyStream.destroy();
        });

        bodyStream.on('error', (err) => {
          logger.warn('[CloudCodeGateway] Upstream streaming error', err);
          if (!res.writableEnded) {
            res.destroy(err);
          }
        });

        return;
      } catch (err: unknown) {
        logger.warn(
          `[CloudCodeGateway] Attempt ${attempt} failed with network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (attempt === maxAttempts) {
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

  private executeUpstreamCall(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: Buffer,
    upstreamHost: string,
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
    // 1. Explicit headers
    const headers = req.headers;
    const headerCandidate =
      headers['x-ag-proxy-session-id'] ||
      headers['x-session-id'] ||
      headers['x-conversation-id'] ||
      headers['x-cloudcode-session-id'];
    if (typeof headerCandidate === 'string' && headerCandidate.trim()) {
      return `cloudcode:header:${headerCandidate.trim()}`;
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
        return `cloudcode:body:${candidate.trim()}`;
      }

      // 3. Multi-turn chat prefix fingerprinting: Google CloudCode contents
      const contents =
        (Array.isArray(parsedBody.contents) ? parsedBody.contents : null) ??
        (Array.isArray((parsedBody.request as Record<string, unknown> | undefined)?.contents)
          ? ((parsedBody.request as Record<string, unknown>).contents as unknown[])
          : null);

      if (contents && contents.length > 0) {
        const firstTurn = contents[0];
        const payload =
          typeof firstTurn === 'object' && firstTurn !== null
            ? JSON.stringify(firstTurn)
            : String(firstTurn);
        const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
        return `cloudcode:prefix:${hash}`;
      }

      // Anthropic / OpenAI format: messages
      const messages =
        (Array.isArray(parsedBody.messages) ? parsedBody.messages : null) ??
        (Array.isArray((parsedBody.request as Record<string, unknown> | undefined)?.messages)
          ? ((parsedBody.request as Record<string, unknown>).messages as unknown[])
          : null);

      if (messages && messages.length > 0) {
        const firstMsg = messages[0];
        const payload =
          typeof firstMsg === 'object' && firstMsg !== null
            ? JSON.stringify(firstMsg)
            : String(firstMsg);
        const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
        return `cloudcode:prefix:${hash}`;
      }
    }

    return undefined;
  }
}
