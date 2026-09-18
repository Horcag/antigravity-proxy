import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import { isReplaySafeOperation } from '../../modules/proxy-gateway/server/cloudcode-request-adapter.js';
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

function createMockRequest(url: string = '/v1internal:streamGenerateContent', headers: Record<string, string> = {}, body: string = '{"model":"gemini-2.5-pro","contents":[]}'): any {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = url;
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

describe('Oracle Conceptual Failover Guarantees', () => {
  it('covers entire 9-account pool without premature budget termination when earlier accounts fail', async () => {
    const accounts = Array.from({ length: 9 }, (_, i) => createMockAccount(`acc-${i + 1}`, `user-${i + 1}@gmail.com`));

    const leasedAccountIds: string[] = [];
    const mockLeaseService: any = {
      getUsableAccountCount: vi.fn(() => 9),
      getQuotaDiagnostics: vi.fn(() => ({ accounts })),
      acquireAttemptLease: vi.fn(async ({ excludeAccountIds }) => {
        const nextAcc = accounts.find((a) => !excludeAccountIds?.includes(a.id));
        if (!nextAcc) return null;
        leasedAccountIds.push(nextAcc.id);
        return {
          account: nextAcc,
          sessionKey: 'session:pool-test',
          generation: leasedAccountIds.length,
          releaseReservation: vi.fn(),
          completeAffinityPlacement: vi.fn(),
        };
      }),
      resolveDynamicModelForAccount: vi.fn((accId, model) => model),
      authorizeBoundSessionMigration: vi.fn(),
      startSessionMigration: vi.fn(),
      completeSessionMigration: vi.fn(),
      failSessionMigrationCandidate: vi.fn(),
      markAsForbidden: vi.fn(),
      markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    };

    const gateway = new CloudCodeFailoverGateway(mockLeaseService);
    let upstreamCallCount = 0;
    const calledAccounts: string[] = [];

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async (_options: any) => {
      upstreamCallCount++;
      const currentAcc = leasedAccountIds[leasedAccountIds.length - 1];
      calledAccounts.push(currentAcc);

      // Accounts 1-8 fail with location unsupported or quota error
      if (currentAcc !== 'acc-9') {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from('{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'),
          bodyStream: createMockStream(['{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}']),
        };
      }

      // Account 9 succeeds
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Success from Account 9"}]}}]}'),
        bodyStream: createMockStream(['{"candidates":[{"content":{"parts":[{"text":"Success from Account 9"}]}}]}']),
      };
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Success from Account 9');
    // Account 9 must have been reached!
    expect(calledAccounts).toContain('acc-9');
    expect(leasedAccountIds).toHaveLength(9);
    expect(upstreamCallCount).toBe(9);
  });

  it('rotates away from an account that threw a network transport exception (EOF) to the next account', async () => {
    const accA = createMockAccount('acc-A', 'faulty-transport@gmail.com');
    const accB = createMockAccount('acc-B', 'healthy-transport@gmail.com');

    const leasedIds: string[] = [];
    const mockLeaseService: any = {
      getUsableAccountCount: vi.fn(() => 2),
      acquireAttemptLease: vi.fn(async ({ excludeAccountIds }) => {
        const nextAcc = [accA, accB].find((a) => !excludeAccountIds?.includes(a.id));
        if (!nextAcc) return null;
        leasedIds.push(nextAcc.id);
        return {
          account: nextAcc,
          sessionKey: 'session:transport-test',
          generation: leasedIds.length,
          releaseReservation: vi.fn(),
          completeAffinityPlacement: vi.fn(),
        };
      }),
      resolveDynamicModelForAccount: vi.fn((accId, model) => model),
      authorizeBoundSessionMigration: vi.fn(),
      startSessionMigration: vi.fn(),
      completeSessionMigration: vi.fn(),
      failSessionMigrationCandidate: vi.fn(),
    };

    const gateway = new CloudCodeFailoverGateway(mockLeaseService);
    let attempts = 0;

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async (...args: any[]) => {
      args[5]?.({ destroy: vi.fn() });
      attempts++;
      if (attempts === 1) {
        // First attempt throws EOF transport exception
        const err = new Error('loadCodeAssist: EOF');
        (err as any).code = 'ECONNRESET';
        throw err;
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"success":true}'),
        bodyStream: createMockStream(['{"success":true}']),
      };
    });

    const req = createMockRequest();
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('{"success":true}');
    expect(leasedIds[0]).toBe('acc-A');
    expect(leasedIds[1]).toBe('acc-B');
    // Crucial: did not loop on acc-A
    expect(leasedIds).toEqual(['acc-A', 'acc-B']);
  });

  it('recognizes agy telemetry and query RPCs as replay-safe and allows repair failover', () => {
    expect(isReplaySafeOperation('POST', '/v1internal:recordTrajectoryAnalytics')).toBe(true);
    expect(isReplaySafeOperation('POST', '/v1internal:writeTrajectoryAcls')).toBe(true);
    expect(isReplaySafeOperation('POST', '/v1internal:recordCodeAssistMetrics')).toBe(true);
    expect(isReplaySafeOperation('POST', '/v1internal:rewriteUri')).toBe(true);
    expect(isReplaySafeOperation('POST', '/v1internal:completeCode')).toBe(true);
    expect(isReplaySafeOperation('POST', '/v1internal:deleteSession')).toBe(false);
  });
});
