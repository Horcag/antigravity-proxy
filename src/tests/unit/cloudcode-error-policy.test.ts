import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
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

describe('CloudCodeFailoverGateway Error Policy and Ambiguity Probe', () => {
  let mockAccountLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockAccountLeaseService = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
      markModelUnrequestable: vi.fn(),
      markAsForbidden: vi.fn(),
      resolveDynamicModelForAccount: vi.fn((_accId, model) => model),
    };
    gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);
  });

  it('Scenario 1: Generic 400 -> alternate account probe succeeds with zero penalties', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(account2);

    const generic400Body = Buffer.from(
      JSON.stringify({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
        },
      }),
      'utf-8',
    );

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        bufferedBody: generic400Body,
        bodyStream: createMockStream(),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Success"}]}}]}'),
        bodyStream: createMockStream(['{"candidates":[{"content":{"parts":[{"text":"Success"}]}}]}']),
      });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-3.8-flash-high', contents: [{ parts: [{ text: 'Hello' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(executeSpy).toHaveBeenCalledTimes(2);
    // Crucial: No health penalties applied to either account
    expect(mockAccountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markModelUnrequestable).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('Scenario 2: Generic 400 -> alternate account also returns generic 400 -> terminates without poisoning', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(account2);

    const generic400Body = Buffer.from(
      JSON.stringify({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
        },
      }),
      'utf-8',
    );

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValue({
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        bufferedBody: generic400Body,
        bodyStream: createMockStream(),
      });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-3.8-flash-high', contents: [{ parts: [{ text: 'Hello' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(executeSpy).toHaveBeenCalledTimes(2); // exactly 1 probe
    // Zero capabilities poisoned
    expect(mockAccountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markModelUnrequestable).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('Scenario 3: Ambiguous 400 with no alternate account available returns original 400', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(null); // No more accounts in pool

    const generic400Body = Buffer.from(
      JSON.stringify({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
        },
      }),
      'utf-8',
    );

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValueOnce({
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      bufferedBody: generic400Body,
      bodyStream: createMockStream(),
    });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-3.8-flash-high', contents: [{ parts: [{ text: 'Hello' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    // Must return the original 400, not 503
    expect(res.statusCode).toBe(400);
  });

  it('Scenario 4: Explicit invalid signature error never rotates accounts', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    const signatureErrorBody = Buffer.from(
      JSON.stringify({
        error: {
          code: 400,
          message: 'thought_signature is required for previous tool response.',
          status: 'INVALID_ARGUMENT',
        },
      }),
      'utf-8',
    );

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValueOnce({
      statusCode: 400,
      headers: { 'content-type': 'application/json' },
      bufferedBody: signatureErrorBody,
      bodyStream: createMockStream(),
    });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-3.8-flash-high', contents: [{ parts: [{ text: 'Tool call' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(executeSpy).toHaveBeenCalledTimes(1); // Never rotates
    expect(res.statusCode).toBe(400);
  });

  it('Scenario 5: Explicit model unsupported rotates account and marks model unrequestable', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(account2);

    const modelErrorBody = Buffer.from(
      JSON.stringify({
        error: {
          code: 404,
          message: 'models/gemini-unsupported is not found for this project.',
          status: 'NOT_FOUND',
        },
      }),
      'utf-8',
    );

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValueOnce({
        statusCode: 404,
        headers: { 'content-type': 'application/json' },
        bufferedBody: modelErrorBody,
        bodyStream: createMockStream(),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[]}'),
        bodyStream: createMockStream(),
      });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-unsupported', contents: [{ parts: [{ text: 'Hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markModelUnrequestable).toHaveBeenCalledWith('acc-1', 'gemini-unsupported');
    expect(res.statusCode).toBe(200);
  });

  it('Scenario 6: Project context rejected retries on same account without quota header', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    const projectErrorBody = Buffer.from(
      JSON.stringify({
        error: {
          code: 400,
          message: 'x-goog-user-project is invalid or disabled for serviceusage.',
          status: 'INVALID_ARGUMENT',
        },
      }),
      'utf-8',
    );

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValueOnce({
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        bufferedBody: projectErrorBody,
        bodyStream: createMockStream(),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[]}'),
        bodyStream: createMockStream(),
      });

    const req = createMockRequest({
      headers: { 'x-goog-user-project': 'old-proj', host: 'daily-cloudcode-pa.googleapis.com' },
      body: JSON.stringify({ model: 'gemini-2.5-pro', project: 'old-proj', contents: [] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(executeSpy).toHaveBeenCalledTimes(2);
    // Second attempt upstreamHeaders must NOT contain x-goog-user-project
    const secondCallHeaders = executeSpy.mock.calls[1][2] as Record<string, string>;
    expect(secondCallHeaders['x-goog-user-project']).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });
});
