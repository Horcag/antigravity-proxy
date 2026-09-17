import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import { evaluateRetryDecision } from '../../modules/proxy-gateway/server/upstream-retry-decision.js';
import { logUpstreamFailure } from '../../modules/proxy-gateway/server/cloudcode-diagnostics.js';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { CloudAccount } from '../../modules/cloud-account/types.js';

function createMockStream(chunks: Array<string | Buffer> = ['{"candidates":[]}']): any {
  const readable = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return Object.assign(readable, { destroy: vi.fn() });
}

function createMockAccount(id: string, email: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email,
    token: {
      access_token: `token-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: `project-${id}`,
    },
    created_at: Math.floor(Date.now() / 1000),
    last_used: Math.floor(Date.now() / 1000),
  };
}

function createMockRequest(body: string = '{"model":"gemini-2.5-pro","contents":[]}'): any {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = '/v1internal:streamGenerateContent';
  req.headers = { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': 'application/json' };
  const buf = Buffer.from(body, 'utf-8');
  req[Symbol.asyncIterator] = async function* () { yield buf; };
  return req;
}

function createMockResponse(): any {
  const res = new EventEmitter() as any;
  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.body = '';
  res.writeHead = vi.fn((statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
    res.headersSent = true;
  });
  res.end = vi.fn((chunk) => {
    if (chunk) res.body += chunk.toString();
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');
  });
  res.write = vi.fn((chunk) => { res.body += chunk.toString(); return true; });
  return res;
}

describe('Oracle R1-R8 Acceptance Verification', () => {
  let mockLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockLeaseService = {
      getNextToken: vi.fn(),
      acquireAttemptLease: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
      markModelUnrequestable: vi.fn(),
      markAsForbidden: vi.fn(),
      resolveDynamicModelForAccount: vi.fn((_accId, model) => model),
    };
    gateway = new CloudCodeFailoverGateway(mockLeaseService);
  });

  it('Terminal selection: distinct original and alternate 400 returns original response exactly', async () => {
    const accA = createMockAccount('acc-A', 'a@test.com');
    const accB = createMockAccount('acc-B', 'b@test.com');
    let callCount = 0;

    mockLeaseService.acquireAttemptLease = vi.fn().mockImplementation(async () => {
      callCount++;
      const acc = callCount === 1 ? accA : accB;
      return {
        account: acc,
        generation: 1,
        releaseReservation: vi.fn(),
        completeAffinityPlacement: vi.fn(),
      };
    });

    const originalBody = Buffer.from(JSON.stringify({ error: { code: 400, message: 'ORIGINAL_A_SENTINEL' } }));
    const alternateBody = Buffer.from(JSON.stringify({ error: { code: 400, message: 'ALTERNATE_B_SENTINEL' } }));

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      if (callCount === 1) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json', 'x-trace-sentinel': 'ORIGINAL_A_TRACE' },
          bufferedBody: originalBody,
          bodyStream: createMockStream(),
        };
      }
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json', 'x-trace-sentinel': 'ALTERNATE_B_TRACE' },
        bufferedBody: alternateBody,
        bodyStream: createMockStream(),
      };
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.headers['x-trace-sentinel']).toBe('ORIGINAL_A_TRACE');
    expect(res.body).toContain('ORIGINAL_A_SENTINEL');
    expect(res.body).not.toContain('ALTERNATE_B_SENTINEL');
  });

  it('Cleanup and fencing: resolver exception guarantees lease reservation cleanup', async () => {
    const releaseReservation = vi.fn();
    const completeAffinityPlacement = vi.fn();
    mockLeaseService.acquireAttemptLease = vi.fn().mockResolvedValue({
      account: createMockAccount('acc-A', 'a@test.com'),
      generation: 1,
      releaseReservation,
      completeAffinityPlacement,
    });
    mockLeaseService.resolveDynamicModelForAccount = vi.fn().mockImplementation(() => {
      throw new Error('Resolver exploded');
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(releaseReservation).toHaveBeenCalled();
    expect(completeAffinityPlacement).toHaveBeenCalledWith('aborted');
  });

  it('Protocol parity: equivalent HTTP, JSON, SSE, and gRPC quota failures yield identical decision', () => {
    const httpEv = classifyUpstreamFailure({
      statusCode: 429, headers: {}, modelName: 'gemini-2.5-pro',
      errorText: 'Resource has been exhausted (e.g. check quota).', source: 'http',
    });
    const grpcEv = classifyUpstreamFailure({
      statusCode: 200, headers: { 'grpc-status': '8' }, modelName: 'gemini-2.5-pro', source: 'grpc',
    });
    const sseEv = classifyUpstreamFailure({
      statusCode: 200, headers: {}, modelName: 'gemini-2.5-pro',
      errorText: 'data: {"error":{"status":"RESOURCE_EXHAUSTED","code":429}}', source: 'sse',
    });

    expect(httpEv.category).toBe('quota');
    expect(grpcEv.category).toBe('quota');
    expect(sseEv.category).toBe('quota');
    expect(httpEv.isQuota).toBe(true);
    expect(grpcEv.isQuota).toBe(true);
    expect(sseEv.isQuota).toBe(true);

    const decisionHttp = evaluateRetryDecision({
      evidence: httpEv, attempt: 1, maxAttempts: 5, downstreamCommitted: false,
      isReplaySafe: true, ambiguityProbesUsed: 0, projectCorrectionsUsed: 0, hasAlternativeAccounts: true,
    });
    const decisionGrpc = evaluateRetryDecision({
      evidence: grpcEv, attempt: 1, maxAttempts: 5, downstreamCommitted: false,
      isReplaySafe: true, ambiguityProbesUsed: 0, projectCorrectionsUsed: 0, hasAlternativeAccounts: true,
    });

    expect(decisionHttp.action.kind).toBe('migrate-account');
    expect(decisionGrpc.action.kind).toBe('migrate-account');
  });

  it('Diagnostics: emitted log sanitization strips bearer tokens and credentials', () => {
    const nestWarnSpy = vi.spyOn(Logger.prototype, 'warn');
    const secret = 'ya29.SYNTHETIC_SECRET_TOKEN_DO_NOT_LOG';

    logUpstreamFailure({
      receiptId: 'receipt-1',
      requestId: 'req-1',
      urlPath: '/v1internal:streamGenerateContent',
      accountId: 'account-1',
      attempt: 1,
      maxAttempts: 5,
      evidence: {
        category: 'authentication',
        confidence: 'explicit',
        source: 'http',
        ruleId: 'google.auth.test',
        safeMessage: `Rejected credentials with ${secret}`,
        isQuota: false,
      },
      action: { kind: 'commit-error' },
      downstreamCommitted: false,
    });

    const emitted = nestWarnSpy.mock.calls.flat().map(String).join(' ');
    expect(emitted).not.toContain(secret);
    expect(emitted).toContain('[REDACTED_SENTINEL]');
  });
});
