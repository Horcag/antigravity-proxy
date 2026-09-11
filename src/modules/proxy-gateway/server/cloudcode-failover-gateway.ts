import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { logger } from '../../../shared/logging/logger';
import { AccountLeaseService } from './account-lease.service';
import { CloudAccount } from '../../cloud-account/types';
import { RateLimitReason } from './rate-limit-tracker';

export interface CloudCodeGatewayOptions {
  accountLeaseService?: AccountLeaseService;
  upstreamHost?: string;
}

export class CloudCodeFailoverGateway {
  private upstreamHost: string;

  constructor(
    private readonly accountLeaseService?: AccountLeaseService,
    options: CloudCodeGatewayOptions = {},
  ) {
    this.upstreamHost = options.upstreamHost || 'daily-cloudcode-pa.googleapis.com';
  }

  async handleRequest(
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse,
  ): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'POST';

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
        if (parsedBody && typeof parsedBody.model === 'string') {
          modelName = parsedBody.model;
        }
      }
    } catch {
      // not JSON or stream; proceed with raw bytes
    }

    // 3. Failover retry loop (ResponseCommitGate)
    const attemptedAccountIds = new Set<string>();
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let account: CloudAccount | null = null;
      if (this.accountLeaseService) {
        account = await this.accountLeaseService.getNextToken({
          model: modelName,
          excludeAccountIds: Array.from(attemptedAccountIds),
        });
      }

      if (account) {
        attemptedAccountIds.add(account.id);
      }

      // Prepare payload with account-specific project if applicable
      let payloadToSend = rawBody;
      const projectId = account?.token?.project_id;
      if (parsedBody && projectId) {
        const cloned = { ...parsedBody, project: projectId };
        payloadToSend = Buffer.from(JSON.stringify(cloned), 'utf-8');
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

      upstreamHeaders['host'] = this.upstreamHost;
      upstreamHeaders['content-length'] = String(payloadToSend.length);

      if (account?.token?.access_token) {
        upstreamHeaders['authorization'] = `Bearer ${account.token.access_token}`;
      }
      if (projectId) {
        upstreamHeaders['x-goog-user-project'] = projectId;
      }

      try {
        const upstreamResult = await this.executeUpstreamCall(
          method,
          url,
          upstreamHeaders,
          payloadToSend,
        );

        const { statusCode, headers, bodyStream, initialChunk } = upstreamResult;

        // Check for rate limit / quota exhaustion
        const isRateLimited =
          statusCode === 429 ||
          (statusCode === 403 && this.isQuotaErrorText(initialChunk?.toString('utf-8')));

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

          // Destroy unused upstream stream and retry with next account
          bodyStream.destroy();
          continue;
        }

        // --- COMMIT POINT ---
        // Success or non-retriable response: commit to client!
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(headers)) {
          if (
            !k.startsWith(':') &&
            k.toLowerCase() !== 'transfer-encoding' &&
            k.toLowerCase() !== 'connection'
          ) {
            if (v !== undefined) {
              responseHeaders[k] = v;
            }
          }
        }

        const anyRes = res as any;
        if (typeof anyRes.writeHead === 'function') {
          anyRes.writeHead(statusCode, responseHeaders);
        }

        if (initialChunk && initialChunk.length > 0) {
          anyRes.write(initialChunk);
        }

        bodyStream.pipe(res);
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
            anyRes.writeHead(502, { 'content-type': 'application/json' });
            anyRes.end(
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
      anyRes.writeHead(429, { 'content-type': 'application/json' });
      anyRes.end(
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
  ): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    bodyStream: http.IncomingMessage;
    initialChunk?: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: this.upstreamHost,
        port: 443,
        path: url,
        method,
        headers,
      };

      const upstreamReq = https.request(options, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 200;

        // If error status, buffer the first chunk to inspect before committing
        if (statusCode >= 400) {
          upstreamRes.once('data', (firstChunk: Buffer) => {
            resolve({
              statusCode,
              headers: upstreamRes.headers,
              bodyStream: upstreamRes,
              initialChunk: Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk),
            });
          });

          upstreamRes.once('end', () => {
            resolve({
              statusCode,
              headers: upstreamRes.headers,
              bodyStream: upstreamRes,
            });
          });
        } else {
          // Success status: immediate resolve
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
}
