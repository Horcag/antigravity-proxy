import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import { isReplaySafeOperation, rewriteJsonPayloadLossless, validateAndExtractRequestModel } from '../../modules/proxy-gateway/server/cloudcode-request-adapter.js';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { CloudAccount } from '../../modules/cloud-account/types.js';

function createMockStream(chunks: Array<string | Buffer> = ['{"candidates":[]}']): any {
  const readable = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return Object.assign(readable, { destroy: vi.fn() });
}

function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): any {
  const req = new EventEmitter() as any;
  req.method = options.method || 'POST';
  req.url = options.url || '/v1internal:streamGenerateContent';
  req.headers = options.headers || {
    host: 'daily-cloudcode-pa.googleapis.com',
    'content-type': 'application/json',
  };

  const bodyBuffer = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body || '', 'utf-8');

  req[Symbol.asyncIterator] = async function* () {
    if (bodyBuffer.length > 0) {
      yield bodyBuffer;
    }
  };

  return req;
}

function createMockResponse(): any {
  const res = new EventEmitter() as any;
  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = vi.fn((statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
    res.headersSent = true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');
  });
  res.write = vi.fn(() => true);
  return res;
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

describe('Oracle R1-R8 Architectural Verification', () => {
  let mockLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockLeaseService = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
      markModelUnrequestable: vi.fn(),
      markAsForbidden: vi.fn(),
      resolveDynamicModelForAccount: vi.fn((_accId, model) => model),
    };
    gateway = new CloudCodeFailoverGateway(mockLeaseService);
  });

  // Native project rejection cannot be repaired by changing request context.
  it('R1 & R2: 1-account pool returns project rejection without altering context', async () => {
    const accountA = createMockAccount('acc-A', 'acca@test.com');
    mockLeaseService.getNextToken.mockResolvedValue(accountA);
    mockLeaseService.getUsableAccountCount = vi.fn(() => 1);

    const projectDeniedBody = Buffer.from(
      JSON.stringify({
        error: {
          code: 403,
          message: 'Permission denied on resource project-acc-A or serviceusage.services.use disabled.',
          status: 'PERMISSION_DENIED',
        },
      }),
    );

    const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(
      async (...args: any[]) => {
        const [, url, headers, body] = args;
        calls.push({ url, headers, body });
        if (calls.length === 1) {
          return {
            statusCode: 403,
            headers: { 'content-type': 'application/json' },
            bufferedBody: projectDeniedBody,
            bodyStream: createMockStream(),
          };
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from('{"candidates":[]}'),
          bodyStream: createMockStream(),
        };
      },
    );

    const req = createMockRequest({
      headers: { 'x-goog-user-project': 'project-acc-A', host: 'daily-cloudcode-pa.googleapis.com' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', project: 'project-acc-A', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(calls).toHaveLength(1);
    // Call 1: had header
    expect(calls[0].headers['x-goog-user-project']).toBe('project-acc-A');
    expect(JSON.parse(calls[0].body.toString('utf-8')).project).toBe('project-acc-A');
    expect(res.statusCode).toBe(403);
  });

  // R3: Error classification boundaries
  it('R3: Missing file 404 does NOT poison model; quota-project 403 does NOT mark quota exhausted', () => {
    // 404 missing cache/file
    const cacheNotFound = classifyUpstreamFailure({
      statusCode: 404,
      headers: {},
      errorText: 'CachedContent not found: projects/123/locations/us/cachedContents/abc',
      modelName: 'gemini-2.5-pro',
      urlPath: '/v1internal:streamGenerateContent',
    });
    expect(cacheNotFound.category).toBe('invalid-request');
    expect(cacheNotFound.category).not.toBe('model-capability');

    // 400 signature error mentioning model
    const signatureError = classifyUpstreamFailure({
      statusCode: 400,
      headers: {},
      errorText: 'thought_signature is missing for gemini-2.5-flash response validation',
      modelName: 'gemini-2.5-flash',
      urlPath: '/v1internal:streamGenerateContent',
    });
    expect(signatureError.category).toBe('invalid-request');
    expect(signatureError.category).not.toBe('model-capability');

    // 403 quota-project permission denied
    const quotaProjectDenied = classifyUpstreamFailure({
      statusCode: 403,
      headers: {},
      errorText: 'User project denied: serviceusage.services.use permission denied for project 123',
      modelName: 'gemini-2.5-pro',
      urlPath: '/v1internal:streamGenerateContent',
    });
    expect(quotaProjectDenied.category).toBe('project-context');
    expect(quotaProjectDenied.category).not.toBe('quota');
  });

  // R5: Strict pathname allowlist for replay safety
  it('R5: Non-allowlisted actions like deleteSession return isReplaySafe = false', () => {
    expect(isReplaySafeOperation('POST', '/v1internal:deleteSession')).toBe(false);
    expect(isReplaySafeOperation('POST', '/v1internal:createSession')).toBe(false);
    expect(isReplaySafeOperation('POST', '/v1internal:streamGenerateContent')).toBe(true);
    expect(isReplaySafeOperation('POST', '/v1internal/models/gemini-2.5-pro:generateContent')).toBe(true);
    expect(isReplaySafeOperation('DELETE', '/v1internal/files/123')).toBe(false);
  });

  // R6: Lossless integer rewriting
  it('R6: Lossless JSON rewriting preserves 64-bit integers beyond Number.MAX_SAFE_INTEGER', () => {
    const raw = '{"id":9007199254740993,"model":"gemini-2.5-pro","project":"old-p"}';
    const rewritten = rewriteJsonPayloadLossless(raw, { model: 'gemini-2.5-pro', routingProject: 'new-p' });
    expect(rewritten).toContain('9007199254740993');
    expect(rewritten).toContain('"project":"new-p"');
  });

  // B1: Equivalence of HTTP, JSON, SSE, and gRPC project denials and ambiguous gRPC 3 recovery
  it('B1: HTTP, JSON, SSE, and gRPC equivalence through handleRequest with project repair and gRPC 3', async () => {
    const accountA = createMockAccount('acc-A', 'acca@test.com');
    const accountB = createMockAccount('acc-B', 'accb@test.com');

    // Equivalence: JSON, SSE, and gRPC project permission denials all trigger same-account retry
    const protocols = [
      { name: 'JSON PERMISSION_DENIED', status: 403, headers: { 'content-type': 'application/json' }, bufferedBody: Buffer.from('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Permission denied on project-acc-A"}}') },
      { name: 'SSE PERMISSION_DENIED', status: 200, headers: { 'content-type': 'text/event-stream' }, bufferedBody: Buffer.from('data: {"error":{"code":403,"status":"PERMISSION_DENIED","message":"Permission denied on project-acc-A"}}\n\n') },
      { name: 'gRPC PERMISSION_DENIED (status 7)', status: 200, headers: { 'content-type': 'application/grpc', 'grpc-status': '7', 'grpc-message': 'Permission denied on project-acc-A' }, bufferedBody: Buffer.alloc(0) },
    ];

    for (const proto of protocols) {
      mockLeaseService.getNextToken.mockResolvedValue(accountA);
      let attempts = 0;
      vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          return { statusCode: proto.status, headers: proto.headers, bufferedBody: proto.bufferedBody, bodyStream: createMockStream([proto.bufferedBody]) };
        }
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, bufferedBody: Buffer.from('{"candidates":[]}'), bodyStream: createMockStream() };
      });

      const req = createMockRequest({
        headers: { 'x-goog-user-project': 'project-acc-A', host: 'daily-cloudcode-pa.googleapis.com' },
        body: JSON.stringify({ model: 'gemini-2.5-pro', contents: [] }),
      });
      const res = createMockResponse();

      await gateway.handleRequest(req, res);

      expect(attempts, `${proto.name} must trigger repair attempt`).toBe(2);
      expect(res.statusCode, `${proto.name} must return 200`).toBe(200);
    }

    // gRPC status 3 with ambiguous payload rotates account rather than terminating immediately
    let leaseIndex = 0;
    mockLeaseService.getNextToken.mockImplementation(async () => {
      leaseIndex++;
      return leaseIndex === 1 ? accountA : accountB;
    });

    let calls = 0;
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/grpc', 'grpc-status': '3', 'grpc-message': 'Invalid argument' },
          bufferedBody: Buffer.from('{"error":{"code":400,"message":"Invalid argument"}}'),
          bodyStream: createMockStream(),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[]}'),
        bodyStream: createMockStream(),
      };
    });

    const req = createMockRequest({
      headers: { host: 'daily-cloudcode-pa.googleapis.com' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', contents: [] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(calls).toBe(2);
    expect(res.statusCode).toBe(200);
  });

  // B4: Root-level envelope does NOT gain invented nested request.model or request.project, and model conflict detection
  it('B4: Root-level envelope does NOT gain invented nested request.model or request.project and detects conflicts', () => {
    // 1. Root-level envelope: no nested request object is created
    const rootJson = '{"contents":[],"model":"gemini-1.5-pro","project":"p1"}';
    const rewrittenRoot = rewriteJsonPayloadLossless(rootJson, {
      model: 'gemini-2.5-pro',
      routingProject: 'p2',
    });
    const parsedRoot = JSON.parse(rewrittenRoot);
    expect(parsedRoot.model).toBe('gemini-2.5-pro');
    expect(parsedRoot.project).toBe('p2');
    expect(parsedRoot.request).toBeUndefined();

    // 2. Nested envelope: preserves request structure without creating root model/project
    const nestedJson = '{"request":{"contents":[],"model":"gemini-1.5-pro","project":"p1"}}';
    const rewrittenNested = rewriteJsonPayloadLossless(nestedJson, {
      model: 'gemini-2.5-pro',
      routingProject: 'p2',
    });
    const parsedNested = JSON.parse(rewrittenNested);
    expect(parsedNested.request.model).toBe('gemini-2.5-pro');
    expect(parsedNested.request.project).toBe('p2');
    expect(parsedNested.model).toBeUndefined();
    expect(parsedNested.project).toBeUndefined();

    // 3. validateAndExtractRequestModel detects model conflicts
    const rootNestedConflict = validateAndExtractRequestModel('/v1internal:streamGenerateContent', {
      model: 'gemini-2.5-pro',
      request: { model: 'gemini-1.5-flash' },
    });
    expect(rootNestedConflict.valid).toBe(false);
    expect(rootNestedConflict.error).toContain('Conflicting model selectors');

    const urlBodyConflict = validateAndExtractRequestModel(
      '/v1internal/models/gemini-2.5-pro:streamGenerateContent',
      { model: 'gemini-1.5-flash' },
    );
    expect(urlBodyConflict.valid).toBe(false);
    expect(urlBodyConflict.error).toContain('Conflicting model selectors');

    const validExtract = validateAndExtractRequestModel(
      '/v1internal/models/gemini-2.5-pro:streamGenerateContent',
      { model: 'gemini-2.5-pro' },
    );
    expect(validExtract.valid).toBe(true);
    expect(validExtract.model).toBe('gemini-2.5-pro');
  });
});
