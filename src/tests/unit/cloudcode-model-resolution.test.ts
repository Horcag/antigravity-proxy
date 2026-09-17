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

describe('CloudCodeFailoverGateway Dynamic Model Resolution', () => {
  let mockAccountLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockAccountLeaseService = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
      resolveDynamicModelForAccount: vi.fn((accId, model) => {
        if (accId === 'acc-1' && model === 'gemini-3.8-flash-high') {
          return 'gemini-3.8-flash-tiered';
        }
        return model;
      }),
    };
    gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);
  });

  it('rewrites requested model in JSON payload to effective resolved model', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(),
    });

    const req = createMockRequest({
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        contents: [{ parts: [{ text: 'Hello' }] }],
      }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(mockAccountLeaseService.resolveDynamicModelForAccount).toHaveBeenCalledWith(
      'acc-1',
      'gemini-3.8-flash-high',
    );

    const sentPayloadBuffer = executeSpy.mock.calls[0][3] as Buffer;
    const sentPayload = JSON.parse(sentPayloadBuffer.toString('utf-8'));
    expect(sentPayload.model).toBe('gemini-3.8-flash-tiered');
    expect(sentPayload.contents[0].parts[0].text).toBe('Hello');
  });

  it('rewrites nested request.model and URL path consistently', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    const executeSpy = vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(),
    });

    const req = createMockRequest({
      url: '/v1/models/gemini-3.8-flash-high:streamGenerateContent',
      body: JSON.stringify({
        request: {
          model: 'gemini-3.8-flash-high',
          contents: [],
        },
      }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    const sentUrlPath = executeSpy.mock.calls[0][1] as string;
    expect(sentUrlPath).toBe('/v1/models/gemini-3.8-flash-tiered:streamGenerateContent');

    const sentPayloadBuffer = executeSpy.mock.calls[0][3] as Buffer;
    const sentPayload = JSON.parse(sentPayloadBuffer.toString('utf-8'));
    expect(sentPayload.request.model).toBe('gemini-3.8-flash-tiered');
  });
});
