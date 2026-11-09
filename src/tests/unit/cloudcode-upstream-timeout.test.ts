import { describe, it, expect, vi } from 'vitest';
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
    email,
    token: { access_token: `token-${id}`, expiry_date: Date.now() + 3600 * 1000 },
  } as any;
}

describe('CloudCodeFailoverGateway timeout and upstream failover', () => {
  it('rotates to next account and succeeds when attempt 1 fails with upstream network/timeout error', async () => {
    const mockAccountLeaseService: any = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
    };
    const gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);

    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(account2);

    let callCount = 0;
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async (
      _method: any, _path: any, _headers: any, _payload: any, _host: any,
      onReqCreated: any,
    ) => {
      onReqCreated?.({ destroy: vi.fn(), destroyed: false });
      callCount++;
      if (callCount === 1) {
        throw new Error('Upstream attempt deadline exceeded after 20000ms');
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream(['{"candidates": [{"content": {"parts": [{"text": "success"}]}}]}']),
      };
    });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(callCount).toBe(2);
    expect(res.statusCode).toBe(200);
    expect(res.end).toHaveBeenCalled();
  });
});
