import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyUpstreamFailure } from '@/modules/proxy-gateway/server/upstream-failure';
import { evaluateRetryDecision } from '@/modules/proxy-gateway/server/upstream-retry-decision';
import { CloudCodeFailoverGateway } from '@/modules/proxy-gateway/server/cloudcode-failover-gateway';

const message = 'This service has been disabled in this account for violation of Terms of Service.';
function decision(evidence: ReturnType<typeof classifyUpstreamFailure>) {
  return evaluateRetryDecision({ evidence, attempt: 1, maxAttempts: 3, downstreamCommitted: false, isReplaySafe: true,
    ambiguityProbesUsed: 0, projectCorrectionsUsed: 0, hasAlternativeAccounts: true });
}
afterEach(() => vi.restoreAllMocks());

describe('gRPC precise ToS terminal classification', () => {
  it.each(['grpc-header', 'embedded-rpc-code'] as const)('canonicalizes %s ToS evidence to HTTP 403 without migration', (source) => {
    const evidence = classifyUpstreamFailure({ statusCode: 200, source: 'grpc',
      headers: source === 'grpc-header' ? { 'grpc-status': '7', 'grpc-message': encodeURIComponent(message) } : {},
      ...(source === 'embedded-rpc-code' ? { errorText: JSON.stringify({ error: { code: 7, status: 'PERMISSION_DENIED', message } }) } : {}),
    });
    expect(evidence).toMatchObject({ ruleId: 'google.tos.violation', httpStatus: 403, rpcStatus: 'PERMISSION_DENIED', isQuota: false });
    expect(decision(evidence)).toMatchObject({ action: { kind: 'commit-error' }, healthEffect: { kind: 'credential-rejected' } });
  });

  it('preserves ordinary gRPC permission-denied migration without credential penalty', () => {
    const evidence = classifyUpstreamFailure({ statusCode: 200, headers: { 'grpc-status': '7', 'grpc-message': encodeURIComponent('Permission denied; consult Terms of Service') }, source: 'grpc' });
    expect(evidence).toMatchObject({ ruleId: 'google.grpc.permission-denied', httpStatus: 403 });
    expect(decision(evidence)).toMatchObject({ action: { kind: 'migrate-account', reason: 'permission-denied' }, healthEffect: { kind: 'none' } });
  });

  it('stops the native gateway on gRPC header ToS evidence with no alternate account or upstream call', async () => {
    const account = { id: 'rejected', provider: 'google', email: 'rejected@example.test', created_at: 1, last_used: 1,
      token: { access_token: 'fixture', refresh_token: 'fixture', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 9999999999, project_id: 'fixture' } };
    const leases = { getNextToken: vi.fn().mockResolvedValue(account), getModelCapableAccountCount: vi.fn().mockReturnValue(2),
      resolveDynamicModelForAccount: vi.fn((_id: string, model: string) => model), markAsForbidden: vi.fn(), recordPerformanceSuccess: vi.fn() };
    const gateway = new CloudCodeFailoverGateway(leases as never);
    const upstream = vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({ statusCode: 200,
      headers: { 'content-type': 'application/grpc', 'grpc-status': '7', 'grpc-message': encodeURIComponent(message) }, bodyStream: Readable.from([]) });
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1internal:streamGenerateContent', complete: true,
      headers: { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"model":"gemini-3-flash"}'); } });
    const events = new EventEmitter();
    const res = Object.assign(events, { statusCode: 200, headersSent: false, writableEnded: false, writableFinished: false,
      writeHead(status: number) { this.statusCode = status; this.headersSent = true; },
      end() { this.writableEnded = true; this.writableFinished = true; events.emit('finish'); events.emit('close'); } });
    await gateway.handleRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(leases.getNextToken).toHaveBeenCalledTimes(1);
    expect(leases.markAsForbidden).toHaveBeenCalledWith('rejected', 'tos_violation');
  });
});
