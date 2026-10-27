import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { CloudAccount } from '../../modules/cloud-account/types';

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

describe('CloudCodeFailoverGateway affinity recovery', () => {
  let mockAccountLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockAccountLeaseService = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
    };
    gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);
  });

  it('delivers valid upstream response even if session affinity confirmation is rejected', async () => {
    const account1 = createMockAccount('acc-2', 'acc2@test.com');
    mockAccountLeaseService.acquireAttemptLease = vi.fn().mockResolvedValue({
      account: account1,
      generation: 1,
      releaseReservation: vi.fn(),
      completeAffinityPlacement: vi.fn(),
    });
    mockAccountLeaseService.confirmOrBindSession = vi.fn().mockReturnValue({
      kind: 'rejected',
      reason: 'migration-confirmation-rejected',
    });

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(['{"candidates": [{"content": {"parts": [{"text": "Hello world"}]}}]}']),
    });

    const req = createMockRequest({
      headers: {
        'x-session-id': 'session-rejection-test',
        host: 'daily-cloudcode-pa.googleapis.com',
      },
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const writtenChunk = Buffer.isBuffer(res.write.mock.calls[0][0])
      ? res.write.mock.calls[0][0].toString('utf-8')
      : String(res.write.mock.calls[0][0]);
    expect(writtenChunk).toContain('Hello world');
    expect(res.writableEnded).toBe(true);
  });

  it('falls back to pool-wide lease acquisition if affinity lease returns null', async () => {
    const account2 = createMockAccount('acc-fallback', 'fallback@test.com');
    // First call with sessionKey returns null; second call without sessionKey returns fallback lease
    mockAccountLeaseService.acquireAttemptLease = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        account: account2,
        generation: 1,
        releaseReservation: vi.fn(),
      });

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(['{"candidates": [{"content": {"parts": [{"text": "Fallback success"}]}}]}']),
    });

    const req = createMockRequest({
      headers: {
        'x-session-id': 'session-fallback-test',
        host: 'daily-cloudcode-pa.googleapis.com',
      },
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(mockAccountLeaseService.acquireAttemptLease).toHaveBeenCalledTimes(2);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const writtenChunk = Buffer.isBuffer(res.write.mock.calls[0][0])
      ? res.write.mock.calls[0][0].toString('utf-8')
      : String(res.write.mock.calls[0][0]);
    expect(writtenChunk).toContain('Fallback success');
    expect(res.writableEnded).toBe(true);
  });
});
