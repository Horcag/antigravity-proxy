import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { proxyModelAvailabilityStore } from '../../modules/proxy-gateway/server/proxy-model-availability-store';
import { RateLimitReason, type RateLimitTracker } from '../../modules/proxy-gateway/server/rate-limit-tracker';
import type { AccountLeaseTokenData } from '../../modules/proxy-gateway/server/account-lease-token-types';

const physicalModel = 'gemini-3.8-flash-tiered';
const publicModel = 'gemini-3.8-flash-high';
const now = Date.parse('2026-10-29T12:00:00Z');

function serviceWithAccounts() {
  const service = new AccountLeaseService();
  const internals = service as unknown as { tokens: Map<string, AccountLeaseTokenData> };
  for (const id of ['first', 'second']) {
    internals.tokens.set(id, {
      account_id: id, email: `${id}@example.test`, access_token: 'test', refresh_token: 'test',
      token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 4_000_000_000,
      model_quotas: { [physicalModel]: 19 }, model_limits: {}, model_reset_times: {}, model_forwarding_rules: {},
    });
  }
  return service;
}

function request(contentType = 'application/json', accept = 'application/json') {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = '/v1internal:streamGenerateContent?alt=sse';
  req.headers = { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': contentType, accept };
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify({ model: publicModel })); };
  return req;
}

function response() {
  const res = new EventEmitter() as any;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = vi.fn((status: number, headers: unknown) => { res.statusCode = status; res.headers = headers; res.headersSent = true; });
  res.addTrailers = vi.fn();
  res.end = vi.fn((body?: string) => { res.body = body; res.writableEnded = true; res.emit('finish'); });
  return res;
}

describe('managed pool exhaustion at the native gateway boundary', () => {
  afterEach(() => { proxyModelAvailabilityStore.clearAccount('first'); proxyModelAvailabilityStore.clearAccount('second'); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('reports physical-model lockouts for public presets despite a positive quota catalog', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const service = serviceWithAccounts();
    (service as unknown as { rateLimitTracker: RateLimitTracker }).rateLimitTracker.setLockoutUntilIso('first', new Date(now + 90_001).toISOString(), RateLimitReason.QuotaExhausted, physicalModel);
    (service as unknown as { rateLimitTracker: RateLimitTracker }).rateLimitTracker.setLockoutUntilIso('second', new Date(now + 120_000).toISOString(), RateLimitReason.QuotaExhausted, physicalModel);
    expect(service.getPoolCapacityFailure(publicModel, now)).toEqual({ reason: 'quota_exhausted', retryAfterSeconds: 91, retryAt: new Date(now + 90_001).toISOString() });
    expect(service.getPoolCapacityFailure(physicalModel, now)).toEqual(service.getPoolCapacityFailure(publicModel, now));
  });

  it('does not claim exhaustion when a compatible account remains usable or the model is absent', () => {
    const service = serviceWithAccounts();
    proxyModelAvailabilityStore.mark('first', physicalModel, 'quota_exhausted', now + 60_000);
    expect(service.getPoolCapacityFailure(publicModel, now)).toBeUndefined();
    expect(service.getPoolCapacityFailure('unrelated-model', now)).toBeUndefined();
  });

  it.each(['application/json', 'text/event-stream'])('returns 429, reason and exact retry deadline for %s without an upstream call', async (accept) => {
    const service = serviceWithAccounts();
    vi.spyOn(service, 'acquireAttemptLease').mockResolvedValue(null);
    proxyModelAvailabilityStore.mark('first', physicalModel, 'quota_exhausted', Date.now() + 90_000);
    proxyModelAvailabilityStore.mark('second', physicalModel, 'quota_exhausted', Date.now() + 120_000);
    const gateway = new CloudCodeFailoverGateway(service);
    const upstream = vi.spyOn(gateway as any, 'executeUpstreamCall');
    const res = response();
    await gateway.handleRequest(request('application/json', accept), res);
    expect(upstream).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(89);
    const body = String(res.body).replace(/^data: /, '').trim();
    expect(JSON.parse(body).error).toMatchObject({ code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'quota_exhausted', retry_at: expect.any(String) });
    expect(body).not.toContain('example.test');
  });

  it('keeps an advertised sibling usable when only the preferred physical route is blocked', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const service = serviceWithAccounts();
    const tokens = (service as unknown as { tokens: Map<string, AccountLeaseTokenData> }).tokens;
    tokens.delete('second');
    tokens.get('first')!.model_quotas[publicModel] = 19;
    proxyModelAvailabilityStore.mark('first', physicalModel, 'quota_exhausted', now + 60_000);
    (service as unknown as { rateLimitTracker: RateLimitTracker }).rateLimitTracker.setLockoutUntilIso('first', new Date(now + 60_000).toISOString(), RateLimitReason.QuotaExhausted, physicalModel);
    expect(service.getPoolCapacityFailure(physicalModel, now)).toBeUndefined();
    const pool = await (service as any).buildCurrentCandidatePool(physicalModel, new Set());
    expect(pool.map(([id]: [string, unknown]) => id)).toEqual(['first']);
  });

  it('preserves quota reason and deadline in native gRPC trailers', async () => {
    const service = serviceWithAccounts();
    vi.spyOn(service, 'acquireAttemptLease').mockResolvedValue(null);
    proxyModelAvailabilityStore.mark('first', physicalModel, 'quota_exhausted', Date.now() + 90_000);
    proxyModelAvailabilityStore.mark('second', physicalModel, 'quota_exhausted', Date.now() + 120_000);
    const gateway = new CloudCodeFailoverGateway(service);
    const res = response();
    await gateway.handleRequest(request('application/grpc'), res);
    expect(res.statusCode).toBe(200);
    expect(res.addTrailers).toHaveBeenCalledWith(expect.objectContaining({ 'grpc-status': '8', 'grpc-message': expect.stringContaining('Quota%20exhausted') }));
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(89);
  });

  it('preserves UNAVAILABLE for absent accounts and unknown capacity failures', async () => {
    const service = new AccountLeaseService();
    vi.spyOn(service, 'acquireAttemptLease').mockResolvedValue(null);
    const gateway = new CloudCodeFailoverGateway(service);
    const res = response();
    await gateway.handleRequest(request(), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(JSON.parse(res.body).error.status).toBe('UNAVAILABLE');
  });
});
