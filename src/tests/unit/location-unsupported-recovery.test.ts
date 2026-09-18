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

describe('Location Unsupported and Precondition Failover', () => {
  it('classifies 400 FAILED_PRECONDITION location error as permission-denied', () => {
    const rawError = 'data: {"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}';
    const evidence = classifyUpstreamFailure({
      statusCode: 400,
      headers: { 'content-type': 'text/event-stream' },
      errorText: rawError,
      source: 'sse',
    });

    expect(evidence.category).toBe('permission-denied');
    expect(evidence.ruleId).toBe('google.location.unsupported-location');
    expect(evidence.rpcStatus).toBe('FAILED_PRECONDITION');
    expect(evidence.isQuota).toBe(false);
  });

  it('classifies HTTP 403 without project/auth as permission-denied', () => {
    const evidence = classifyUpstreamFailure({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      errorText: '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}',
      source: 'json',
    });

    expect(evidence.category).toBe('permission-denied');
    expect(evidence.ruleId).toBe('google.permission.denied');
    expect(evidence.rpcStatus).toBe('PERMISSION_DENIED');
  });

  it('classifies gRPC code 9 location error as permission-denied with unsupported-location rule', () => {
    const evidence = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '9', 'grpc-message': 'User location is not supported for the API use.' },
      source: 'grpc',
    });

    expect(evidence.category).toBe('permission-denied');
    expect(evidence.ruleId).toBe('google.location.unsupported-location');
    expect(evidence.rpcStatus).toBe('FAILED_PRECONDITION');
  });

  it('evaluates retry decision for unsupported location to migrate account and mark credential rejected', () => {
    const evidence = classifyUpstreamFailure({
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      errorText: '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
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

  it('gateway fails over from location-rejected account to healthy account and calls markAsForbidden', async () => {
    const accA = createMockAccount('acc-A', 'spanish-user@gmail.com');
    const accB = createMockAccount('acc-B', 'healthy-user@gmail.com');

    const markAsForbidden = vi.fn();
    let leaseCallCount = 0;
    const mockLeaseService: any = {
      acquireAttemptLease: vi.fn(async ({ excludeAccountIds }) => {
        leaseCallCount++;
        const acc = excludeAccountIds?.includes('acc-A') ? accB : accA;
        return {
          account: acc,
          sessionKey: 'session:test',
          generation: 1,
          releaseReservation: vi.fn(),
          completeAffinityPlacement: vi.fn(),
        };
      }),
      resolveDynamicModelForAccount: vi.fn((accId, model) => model),
      authorizeBoundSessionMigration: vi.fn(),
      startSessionMigration: vi.fn(),
      completeSessionMigration: vi.fn(),
      failSessionMigrationCandidate: vi.fn(),
      markAsForbidden,
    };

    const gateway = new CloudCodeFailoverGateway(mockLeaseService);
    let upstreamCallCount = 0;
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      upstreamCallCount++;
      if (upstreamCallCount === 1) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from('{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'),
          bodyStream: createMockStream(['{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}']),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Hello from healthy account"}]}}]}'),
        bodyStream: createMockStream(['{"candidates":[{"content":{"parts":[{"text":"Hello from healthy account"}]}}]}']),
      };
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(leaseCallCount).toBe(2);
    expect(upstreamCallCount).toBe(2);
    expect(markAsForbidden).toHaveBeenCalledWith('acc-A');
    expect(res.statusCode).toBe(200);
    expect(res.writableEnded).toBe(true);
  });
});
