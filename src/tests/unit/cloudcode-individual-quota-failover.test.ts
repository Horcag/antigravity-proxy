import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { RateLimitTracker, RateLimitReason, parseRetryDelayMilliseconds } from '../../modules/proxy-gateway/server/rate-limit-tracker';
import { logger } from '../../shared/logging/logger';
import type { CloudAccount } from '../../modules/cloud-account/types';

function createMockStream(chunks: Array<string | Buffer>): any {
  const readable = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  return Object.assign(readable, { destroy: vi.fn(), trailers: {} });
}

function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
} = {}): any {
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
  res.destroyed = false;
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
  res.destroy = vi.fn(() => {
    res.destroyed = true;
    res.emit('close');
  });
  res.write = vi.fn(() => true);
  return res;
}

function createMockAccount(id: string, email: string): CloudAccount {
  return {
    id, provider: 'google', email,
    token: {
      access_token: `secret-token-${id}`, refresh_token: `refresh-${id}`,
      token_type: 'Bearer', expires_in: 3600, expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: `project-${id}`,
    },
    created_at: Math.floor(Date.now() / 1000), last_used: Math.floor(Date.now() / 1000),
  };
}

describe('CloudCode Individual Quota Failover and RateLimitTracker', () => {
  describe('RateLimitTracker duration parsing and 403 quota handling', () => {
    it('parses exact Resets in 2h52m1s duration format', () => {
      const text = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m1s';
      const delayMs = parseRetryDelayMilliseconds(text);
      expect(delayMs).toBe(10321000); // 2*3600 + 52*60 + 1 = 10321 seconds = 10,321,000 ms

      const text2 = 'Individual quota reached. Resets in 45s.';
      expect(parseRetryDelayMilliseconds(text2)).toBe(45000);

      const text3 = 'Quota exceeded. Resets in 1h30m';
      expect(parseRetryDelayMilliseconds(text3)).toBe(5400000);
    });

    it('handles HTTP 403 with quota evidence as QuotaExhausted', () => {
      const tracker = new RateLimitTracker();
      const body = '{"error":{"code":403,"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m1s"}}';

      const info = tracker.trackFromUpstreamError({
        accountId: 'acc-quota',
        status: 403,
        body,
        model: 'gemini-3.8-flash-high',
        backoffSteps: [60, 300],
      });

      expect(info).not.toBeNull();
      expect(info?.reason).toBe(RateLimitReason.QuotaExhausted);
      expect(info?.retryAfterSec).toBeGreaterThanOrEqual(10321);
      expect(tracker.getRemainingWaitSeconds('acc-quota', 'gemini-3.8-flash-high')).toBeGreaterThan(0);
    });

    it('rejects HTTP 403 without quota evidence preserving non-quota 403 behavior', () => {
      const tracker = new RateLimitTracker();
      const body = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}';

      const info = tracker.trackFromUpstreamError({
        accountId: 'acc-perm',
        status: 403,
        body,
        model: 'gemini-3.8-flash-high',
        backoffSteps: [60, 300],
      });

      expect(info).toBeNull();
      expect(tracker.getRemainingWaitSeconds('acc-perm', 'gemini-3.8-flash-high')).toBe(0);
    });
  });

  describe('classifyProtocolFrame structural quota classification', () => {
    let gateway: CloudCodeFailoverGateway;

    beforeEach(() => {
      gateway = new CloudCodeFailoverGateway({} as any);
    });

    it('recognizes SSE error envelope with individual quota reached', () => {
      const ssePayload = Buffer.from(
        'data: {"error":{"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m1s"}}\n\n',
      );
      const decision = gateway.classifyProtocolFrame('text/event-stream', ssePayload);
      expect(decision.state).toBe('VALIDATED_ERROR');
      expect(decision.isQuota).toBe(true);
      expect(decision.category).toBe('account-quota');
    });

    it('recognizes JSON error envelope with individual quota reached and 403 status', () => {
      const jsonPayload = Buffer.from(
        '{"error":{"code":403,"message":"Individual quota reached. Resets in 2h52m1s"}}',
      );
      const decision = gateway.classifyProtocolFrame('application/json', jsonPayload, undefined, undefined, true, 403);
      expect(decision.state).toBe('VALIDATED_ERROR');
      expect(decision.isQuota).toBe(true);
      expect(decision.category).toBe('account-quota');
    });

    it('recognizes plain message envelope without candidates', () => {
      const jsonPayload = Buffer.from(
        '{"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m1s"}',
      );
      const decision = gateway.classifyProtocolFrame('application/json', jsonPayload, undefined, undefined, true);
      expect(decision.state).toBe('VALIDATED_ERROR');
      expect(decision.isQuota).toBe(true);
    });

    it('structural resistance: does not classify model candidate text as quota error', () => {
      const modelTextSse = Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"text":"Notice: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m1s"}]}}]}\n\n',
      );
      const decision = gateway.classifyProtocolFrame('text/event-stream', modelTextSse);
      expect(decision.state).toBe('VALIDATED_RESPONSE');
      expect(decision.isQuota).toBeFalsy();
    });

    it('structural resistance: does not classify choices delta text as quota error', () => {
      const modelChoicesSse = Buffer.from(
        'data: {"choices":[{"delta":{"content":"Individual quota reached."}}]}\n\n',
      );
      const decision = gateway.classifyProtocolFrame('text/event-stream', modelChoicesSse);
      expect(decision.state).toBe('VALIDATED_RESPONSE');
      expect(decision.isQuota).toBeFalsy();
    });
  });

  describe('CloudCodeFailoverGateway request failover and lifecycle invariants', () => {
    let mockLeaseService: any;
    let gateway: CloudCodeFailoverGateway;
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');

    beforeEach(() => {
      mockLeaseService = {
        getNextToken: vi.fn(),
        bindSession: vi.fn(),
        failSessionMigrationCandidate: vi.fn(),
        markFromUpstreamError: vi.fn(),
      };
      gateway = new CloudCodeFailoverGateway(mockLeaseService);
    });

    it('fails over on pre-commit envelope quota error before headers are committed', async () => {
      let callCount = 0;
      mockLeaseService.getNextToken.mockImplementation(async (opts: any) => {
        callCount++;
        const excluded = new Set(opts?.excludeAccountIds ?? []);
        if (callCount === 1 && !excluded.has(account1.id)) return account1;
        if (!excluded.has(account2.id)) return account2;
        return null;
      });

      let upstreamCalls = 0;
      vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
        upstreamCalls++;
        if (upstreamCalls === 1) {
          return {
            statusCode: 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: createMockStream([
              'data: {"error":{"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m1s"}}\n\n',
            ]),
          };
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          bodyStream: createMockStream([
            'data: {"candidates":[{"content":{"parts":[{"text":"Model response success"}]}}]}\n\n',
          ]),
        };
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await gateway.handleRequest(req, res);

      expect(mockLeaseService.getNextToken).toHaveBeenCalledTimes(2);
      expect(mockLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
        expect.objectContaining({
          accountIdOrEmail: account1.id,
          reason: RateLimitReason.QuotaExhausted,
        }),
      );
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    });

    it('no retry after usable output is committed to client', async () => {
      mockLeaseService.getNextToken.mockResolvedValue(account1);

      const usableStream = createMockStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Part 1"}]}}]}\n\n',
      ]);

      vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        bodyStream: usableStream,
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await gateway.handleRequest(req, res);

      // Must have committed headers on first usable chunk and never rotated to account2
      expect(mockLeaseService.getNextToken).toHaveBeenCalledTimes(1);
      expect(mockLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    });

    it('bounded retry terminates when all accounts are exhausted', async () => {
      let leaseCalls = 0;
      mockLeaseService.getNextToken.mockImplementation(async () => {
        leaseCalls++;
        if (leaseCalls === 1) return account1;
        if (leaseCalls === 2) return account2;
        return null;
      });

      vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream([
          '{"error":{"code":429,"message":"Individual quota reached. Resets in 2h."}}',
        ]),
        bufferedBody: Buffer.from('{"error":{"code":429,"message":"Individual quota reached. Resets in 2h."}}'),
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await gateway.handleRequest(req, res);

      expect(mockLeaseService.getNextToken).toHaveBeenCalledTimes(3); // acc1, acc2, then null
      expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
    });

    it('scrubs sensitive telemetry and logs only bounded anonymous fields', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const warnSpy = vi.spyOn(logger, 'warn');

      let attempt = 0;
      mockLeaseService.getNextToken.mockImplementation(async () => {
        attempt++;
        return attempt === 1 ? account1 : account2;
      });

      let upstreamCalls = 0;
      vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
        upstreamCalls++;
        if (upstreamCalls === 1) {
          return {
            statusCode: 200,
            headers: { 'content-type': 'text/event-stream' },
            bodyStream: createMockStream([
              'data: {"error":{"message":"Individual quota reached. secret-leak-value-xyz"}}\n\n',
            ]),
          };
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          bodyStream: createMockStream([
            'data: {"candidates":[{"content":{"parts":[{"text":"Clean"}]}}]}\n\n',
          ]),
        };
      });

      const req = createMockRequest({
        headers: {
          host: 'daily-cloudcode-pa.googleapis.com',
          authorization: 'Bearer super-sensitive-client-token',
          cookie: 'session_token=secret-cookie-12345',
        },
      });
      const res = createMockResponse();

      await gateway.handleRequest(req, res);

      const allLogs = [
        ...debugSpy.mock.calls.map((c) => c.join(' ')),
        ...warnSpy.mock.calls.map((c) => c.join(' ')),
      ].join('\n');

      expect(allLogs).not.toContain(account1.email);
      expect(allLogs).not.toContain(account2.email);
      expect(allLogs).not.toContain('super-sensitive-client-token');
      expect(allLogs).not.toContain('secret-cookie-12345');
      expect(allLogs).not.toContain('secret-token-acc-1');
      expect(allLogs).not.toContain('secret-leak-value-xyz');
    });
  });
});
