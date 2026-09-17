import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import { evaluateRetryDecision } from '../../modules/proxy-gateway/server/upstream-retry-decision.js';
import { formatTerminalDownstreamError } from '../../modules/proxy-gateway/server/cloudcode-terminal-response.js';
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
  res.writeHead = vi.fn((statusCode, headers) => { res.statusCode = statusCode; res.headers = headers; res.headersSent = true; });
  res.end = vi.fn((chunk) => { if (chunk) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk; res.writableEnded = true; res.emit('finish'); res.emit('close'); });
  res.write = vi.fn((chunk) => { res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk; return true; });
  return res;
}

describe('Oracle Round 3 Recovery Acceptance Tests', () => {
  let mockLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockLeaseService = {
      getNextToken: vi.fn(),
      acquireAttemptLease: vi.fn(),
      getSessionBinding: vi.fn(),
      startSessionMigration: vi.fn(),
      renewSessionMigration: vi.fn(),
      failSessionMigrationCandidate: vi.fn(),
      confirmOrBindSession: vi.fn(),
      markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
      markModelUnrequestable: vi.fn(),
      markAsForbidden: vi.fn(),
      resolveDynamicModelForAccount: vi.fn((_id, model) => model),
      getTableIncarnation: vi.fn(() => 1),
    };
    gateway = new CloudCodeFailoverGateway(mockLeaseService);
  });

  // Requirement 1 / B2: Compressed HTTP error pass-through
  it('B2: Real zlib.gzipSync compressed error body is decompressed into uncompressed JSON with stripped content-encoding', () => {
    const errorJson = JSON.stringify({ error: { code: 429, message: 'Resource exhausted by user limit' } });
    const realGzipBuffer = zlib.gzipSync(Buffer.from(errorJson, 'utf-8'));
    const req = { headers: { accept: 'application/json' } };
    const formatted = formatTerminalDownstreamError(req as any, 429, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(realGzipBuffer.length),
    }, realGzipBuffer);

    expect(formatted.statusCode).toBe(429);
    expect(formatted.headers['content-encoding']).toBeUndefined();
    expect(typeof formatted.body).toBe('string');
    expect(JSON.parse(formatted.body as string)).toEqual({
      error: { code: 429, message: 'Resource exhausted by user limit' },
    });
    expect(formatted.headers['content-length']).toBe(String(Buffer.byteLength(formatted.body as string, 'utf-8')));
  });

  // Requirement 1 / B2: Already-framed SSE error bodies
  it('B2: Already-framed SSE stream error is not double-wrapped', () => {
    const existingSse = 'data: {"error":{"code":429,"message":"Quota exhausted"}}\n\n';
    const req = { headers: { accept: 'text/event-stream' } };
    const formatted = formatTerminalDownstreamError(req as any, 429, {
      'content-type': 'text/event-stream',
    }, existingSse);

    expect(formatted.statusCode).toBe(429);
    expect(formatted.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(formatted.body).toBe('data: {"error":{"code":429,"message":"Quota exhausted"}}\n\n');
    expect(formatted.body).not.toContain('{"error":{"message":"data:');
  });

  // Requirement 1 / B2: Native gRPC terminal error framing
  it('B2: Native gRPC terminal error returns HTTP 200 with grpc-status, grpc-message, and zero body', () => {
    const req = { headers: { 'content-type': 'application/grpc' } };
    const formatted = formatTerminalDownstreamError(req as any, 403, {
      'content-type': 'application/grpc',
      'grpc-status': '7',
      'grpc-message': 'Permission denied on project',
    }, Buffer.from('raw error text'));

    expect(formatted.statusCode).toBe(200);
    expect(formatted.headers['content-type']).toBe('application/grpc');
    expect(formatted.headers['grpc-status']).toBe('7');
    expect(formatted.headers['grpc-message']).toBe('Permission denied on project');
    expect((formatted.body as Buffer).length).toBe(0);
    expect(formatted.headers['content-length']).toBe('0');
  });

  // Requirement 2 / B1: gRPC status classification safeguards
  it('B1: gRPC status 5 for file resource does not poison model-capability', () => {
    const fileNotFound = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '5', 'grpc-message': 'File resource files/cache-123 not found' },
      modelName: 'gemini-2.5-pro',
      source: 'grpc',
    });
    expect(fileNotFound.category).toBe('invalid-request');
    expect(fileNotFound.category).not.toBe('model-capability');

    const modelNotFound = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '5', 'grpc-message': 'models/gemini-2.5-pro is not found for project' },
      modelName: 'gemini-2.5-pro',
      source: 'grpc',
    });
    expect(modelNotFound.category).toBe('model-capability');
  });

  it('B1: gRPC status 7 classifies generic denial as authentication and quota project as project-context', () => {
    const genericDenied = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '7', 'grpc-message': 'The caller does not have permission' },
      source: 'grpc',
    });
    expect(genericDenied.category).toBe('authentication');
    expect(genericDenied.category).not.toBe('project-context');

    const projectDenied = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '7', 'grpc-message': 'User project denied: serviceusage.services.use permission denied' },
      source: 'grpc',
    });
    expect(projectDenied.category).toBe('project-context');
  });

  it('B1: gRPC status 3 with explicit signature or corrupt image classifies as invalid-request', () => {
    const sigError = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '3', 'grpc-message': 'thought_signature is required for gemini-2.5-flash' },
      source: 'grpc',
    });
    expect(sigError.category).toBe('invalid-request');
    expect(sigError.category).not.toBe('ambiguous-invalid-argument');

    const ambiguousError = classifyUpstreamFailure({
      statusCode: 200,
      headers: { 'grpc-status': '3', 'grpc-message': 'Invalid argument in request' },
      source: 'grpc',
    });
    expect(ambiguousError.category).toBe('ambiguous-invalid-argument');
  });

  // Requirement 3 / R1/R7: Bound A -> quota failure -> migrate to B -> project rejection on B -> repair on B -> fenced confirmation on B
  it('R1/R7: Migration from A to B followed by same-account repair on B retains migration capability, generation, and reservation', async () => {
    const sessionKey = 'session:r1-r7-acceptance-test';
    const accA = createMockAccount('acc-A', 'a@test.com');
    const accB = createMockAccount('acc-B', 'b@test.com');
    const releaseReservationA = vi.fn();
    const releaseReservationB = vi.fn();

    mockLeaseService.getSessionBinding.mockReturnValue({ accountId: 'acc-A', generation: 1, tableIncarnation: 1 });

    let leaseCall = 0;
    mockLeaseService.acquireAttemptLease.mockImplementation(async () => {
      leaseCall++;
      if (leaseCall === 1) return { account: accA, generation: 1, tableIncarnation: 1, releaseReservation: releaseReservationA };
      return { account: accB, generation: 1, tableIncarnation: 1, releaseReservation: releaseReservationB };
    });

    mockLeaseService.startSessionMigration.mockReturnValue({ sessionKey, generation: 2, ownerRequestId: 'test-req', tableIncarnation: 1 });
    mockLeaseService.confirmOrBindSession.mockReturnValue(true);

    let upstreamCalls = 0;
    const executedProjects: Array<string | undefined> = [];

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async (...args: any[]) => {
      const headers = (args[2] || {}) as Record<string, string>;
      upstreamCalls++;
      executedProjects.push(headers['x-goog-user-project']);

      if (upstreamCalls === 1) {
        return {
          statusCode: 429,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded on A"}}'),
          bodyStream: createMockStream(),
        };
      }
      if (upstreamCalls === 2) {
        return {
          statusCode: 403,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"serviceusage.services.use permission denied on project-acc-B"}}'),
          bodyStream: createMockStream(),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Success on B"}]}}]}'),
        bodyStream: createMockStream(['{"candidates":[{"content":{"parts":[{"text":"Success on B"}]}}]}']),
      };
    });

    const req = createMockRequest({ 'x-goog-user-project': 'project-acc-A', 'x-session-id': sessionKey });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(upstreamCalls).toBe(3);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Success on B');
    expect(releaseReservationA).toHaveBeenCalledTimes(1);
    expect(releaseReservationB).toHaveBeenCalledTimes(1);
    expect(mockLeaseService.startSessionMigration).toHaveBeenCalledTimes(1);
    expect(mockLeaseService.confirmOrBindSession).toHaveBeenCalledWith(sessionKey, 'acc-B', 2, expect.any(String), undefined, 1);
    expect(executedProjects[0]).toBe('project-acc-A');
    expect(executedProjects[1]).toBe('project-acc-B');
    expect(executedProjects[2]).toBeUndefined();
  });

  // Requirement 4 / B3 & Requirement 5 / P2: Gateway sanitization and transient retry reachability
  it('B3 & P2: evaluateRetryDecision enables transient retry when maxTransientRetries is default 1', () => {
    const retryDecision = evaluateRetryDecision({
      evidence: {
        category: 'transient', confidence: 'explicit', source: 'http', httpStatus: 503,
        rpcStatus: 'UNAVAILABLE', ruleId: 'google.transient.unavailable', safeMessage: '[google.transient.unavailable] TRANSIENT (UNAVAILABLE)', isQuota: false,
      },
      attempt: 1, maxAttempts: 3, downstreamCommitted: false, isReplaySafe: true, ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 0, hasAlternativeAccounts: false, transientRetriesUsed: 0,
    });
    expect(retryDecision.action.kind).toBe('retry-transient');

    const exhaustedDecision = evaluateRetryDecision({
      evidence: {
        category: 'transient', confidence: 'explicit', source: 'http', httpStatus: 503,
        rpcStatus: 'UNAVAILABLE', ruleId: 'google.transient.unavailable', safeMessage: '[google.transient.unavailable] TRANSIENT (UNAVAILABLE)', isQuota: false,
      },
      attempt: 2, maxAttempts: 3, downstreamCommitted: false, isReplaySafe: true, ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 0, hasAlternativeAccounts: false, transientRetriesUsed: 1,
    });
    expect(exhaustedDecision.action.kind).toBe('commit-error');

    const migrateDecision = evaluateRetryDecision({
      evidence: {
        category: 'transient', confidence: 'explicit', source: 'http', httpStatus: 503,
        rpcStatus: 'UNAVAILABLE', ruleId: 'google.transient.unavailable', safeMessage: '[google.transient.unavailable] TRANSIENT (UNAVAILABLE)', isQuota: false,
      },
      attempt: 1, maxAttempts: 3, downstreamCommitted: false, isReplaySafe: true, ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 0, hasAlternativeAccounts: true, transientRetriesUsed: 0,
    });
    expect(migrateDecision.action.kind).toBe('migrate-account');
  });

  // Requirement 4 / B3 & Requirement 5 / P2: Dispatch State Reset on Attempt > 1
  it('B3 & P2: Preparation failure on attempt 2 is not misclassified as network failure and returns preparation_failed 502', async () => {
    const accA = createMockAccount('acc-A', 'a@test.com');
    const accB = createMockAccount('acc-B', 'b@test.com');
    let attemptNum = 0;

    mockLeaseService.acquireAttemptLease.mockImplementation(async () => {
      attemptNum++;
      if (attemptNum === 1) return { account: accA, generation: 1, releaseReservation: vi.fn() };
      return { account: accB, generation: 1, releaseReservation: vi.fn() };
    });

    // Attempt 1 dispatches to upstream and fails with 429
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      return {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}'),
        bodyStream: createMockStream(),
      };
    });

    // On attempt 2, resolveDynamicModelForAccount throws during preparation before dispatch
    mockLeaseService.resolveDynamicModelForAccount.mockImplementation((_accId: string, _model: string) => {
      if (attemptNum === 2) {
        throw new Error('Secret internal DB preparation connection string details');
      }
      return 'gemini-2.5-pro';
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(502);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.message).toBe('Gateway preparation error: preparation_failed');
    expect(parsed.error.status).toBe('INTERNAL');
    // Secret internal exception message must never be exposed downstream!
    expect(res.body).not.toContain('Secret internal DB preparation');
  });
});
