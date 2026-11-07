import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import { evaluateRetryDecision } from '../../modules/proxy-gateway/server/upstream-retry-decision.js';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import type { CloudAccount } from '../../modules/cloud-account/types.js';

function createMockStream(chunks: Array<string | Buffer> = ['{"candidates":[]}']): any {
  const readable = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return Object.assign(readable, { destroy: vi.fn(), trailers: {} });
}

function createMockAccount(id: string, email: string): CloudAccount {
  return {
    id, provider: 'google', email,
    token: { access_token: `tok-${id}`, refresh_token: `ref-${id}`, token_type: 'Bearer', expires_in: 3600, expiry_timestamp: Math.floor(Date.now() / 1000) + 3600, project_id: `project-${id}` },
    created_at: Math.floor(Date.now() / 1000), last_used: Math.floor(Date.now() / 1000),
  };
}

function createMockRequest(headers: Record<string, string> = {}, body: string = '{"model":"gemini-2.5-pro","contents":[]}'): any {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = '/v1internal:streamGenerateContent';
  req.headers = { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': 'application/json', ...headers };
  const buf = Buffer.from(body, 'utf-8');
  req[Symbol.asyncIterator] = async function* () { yield buf; };
  return req;
}

function createMockResponse(): any {
  const res = new EventEmitter() as any;
  res.headers = {}; res.statusCode = 200; res.headersSent = false; res.writableEnded = false; res.body = '';
  res.setHeader = vi.fn((k: string, v: string) => { res.headers[k.toLowerCase()] = v; });
  res.writeHead = vi.fn((statusCode, headers) => { res.statusCode = statusCode; if (headers) Object.assign(res.headers, headers); res.headersSent = true; });
  res.end = vi.fn((chunk) => { if (chunk) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk; res.writableEnded = true; res.emit('finish'); res.emit('close'); });
  res.write = vi.fn((chunk) => { res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk; return true; });
  res.destroy = vi.fn(() => { res.destroyed = true; res.emit('close'); });
  return res;
}

describe('Terms of Service (TOS_VIOLATION) Recognition and Recovery', () => {
  it('classifies HTTP 403 TOS_VIOLATION error correctly', () => {
    const rawError = JSON.stringify({
      error: {
        code: 403,
        message: 'This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.',
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'TOS_VIOLATION',
            domain: 'cloudcode-pa.googleapis.com',
          },
        ],
      },
    });

    const evidence = classifyUpstreamFailure({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      errorText: rawError,
      source: 'json',
    });

    expect(evidence.category).toBe('permission-denied');
    expect(evidence.ruleId).toBe('google.tos.violation');
    expect(evidence.rpcStatus).toBe('PERMISSION_DENIED');
    expect(evidence.isQuota).toBe(false);
    expect(evidence.safeMessage).toContain('google.tos.violation');
  });

  it('classifies SSE 403 TOS_VIOLATION stream error correctly', () => {
    const sseError = 'data: {"error":{"code":403,"message":"This service has been disabled in this account for violation of Terms of Service.","status":"PERMISSION_DENIED"}}';
    const evidence = classifyUpstreamFailure({
      statusCode: 403,
      headers: { 'content-type': 'text/event-stream' },
      errorText: sseError,
      source: 'sse',
    });

    expect(evidence.category).toBe('permission-denied');
    expect(evidence.ruleId).toBe('google.tos.violation');
    expect(evidence.isQuota).toBe(false);
  });

  it('evaluates retry decision for TOS_VIOLATION to migrate account and mark as credential-rejected', () => {
    const evidence = classifyUpstreamFailure({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      errorText: '{"error":{"code":403,"message":"violation of Terms of Service","status":"PERMISSION_DENIED"}}',
      source: 'json',
    });

    const decision = evaluateRetryDecision({
      evidence,
      attempt: 1,
      maxAttempts: 5,
      downstreamCommitted: false,
      isReplaySafe: true,
      ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 0,
      hasAlternativeAccounts: true,
    });

    expect(decision.action.kind).toBe('migrate-account');
    expect(decision.action).toEqual({ kind: 'migrate-account', reason: 'permission-denied' });
    expect(decision.healthEffect.kind).toBe('credential-rejected');
  });

  it('gateway fails over from TOS-violated account to healthy account with markAsForbidden(tos_violation)', async () => {
    const accBanned = createMockAccount('acc-banned', 'banned@gmail.com');
    const accHealthy = createMockAccount('acc-healthy', 'healthy@gmail.com');

    const markAsForbidden = vi.fn();
    let leaseCallCount = 0;

    const mockAccountLeaseService: any = {
      acquireAttemptLease: vi.fn(async ({ excludeAccountIds }) => {
        leaseCallCount++;
        const acct = excludeAccountIds?.includes('acc-banned') ? accHealthy : accBanned;
        return {
          account: acct,
          sessionKey: 'session:test',
          generation: 1,
          releaseReservation: vi.fn(),
          completeAffinityPlacement: vi.fn(),
        };
      }),
      resolveDynamicModelForAccount: vi.fn((_accId, model) => model),
      authorizeBoundSessionMigration: vi.fn(),
      startSessionMigration: vi.fn(),
      completeSessionMigration: vi.fn(),
      failSessionMigrationCandidate: vi.fn(),
      markAsForbidden,
      recordPerformanceSuccess: vi.fn(),
    };

    const tosErrorBody = JSON.stringify({
      error: {
        code: 403,
        message: 'This service has been disabled in this account for violation of Terms of Service.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'TOS_VIOLATION' }],
      },
    });

    const gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);

    let upstreamCallCount = 0;
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      upstreamCallCount++;
      if (upstreamCallCount === 1) {
        return {
          statusCode: 403,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from(tosErrorBody),
          bodyStream: createMockStream([tosErrorBody]),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}'),
        bodyStream: createMockStream(['{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}']),
      };
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(markAsForbidden).toHaveBeenCalledWith('acc-banned', 'tos_violation');
    expect(leaseCallCount).toBe(2);
    expect(upstreamCallCount).toBe(2);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"parts":[{"text":"OK"}]');
  });
});
