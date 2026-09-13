import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CloudCodeFailoverGateway } from '@/modules/proxy-gateway/server/cloudcode-failover-gateway';
import { logger } from '@/shared/logging/logger';

function request(): any {
  const req = new EventEmitter() as any;
  req.method = 'POST'; req.url = '/v1internal:streamGenerateContent';
  req.headers = { host: 'daily-cloudcode-pa.googleapis.com', 'x-session-id': 'raw-session-sentinel' };
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ model: 'gemini-2.5-pro' }));
  };
  return req;
}

function response(): any {
  const res = new EventEmitter() as any;
  res.headersSent = false; res.writableEnded = false; res.statusCode = 200;
  res.writeHead = vi.fn((statusCode) => { res.statusCode = statusCode; res.headersSent = true; });
  res.write = vi.fn(() => true);
  res.end = vi.fn(() => { res.writableEnded = true; });
  return res;
}

describe('Cache affinity diagnostics', () => {
  it('redacts untrusted commit rejection reasons in runtime diagnostics', async () => {
    const rawAccount = 'account:raw-account-sentinel';
    const releaseReservation = vi.fn();
    const leaseService: any = {
      acquireAttemptLease: vi.fn()
        .mockResolvedValueOnce({
          account: { id: rawAccount, token: { access_token: 'token', project_id: 'project' } },
          generation: 1, releaseReservation,
        })
        .mockResolvedValueOnce(null),
      confirmOrBindSession: vi.fn().mockReturnValue({
        kind: 'rejected', reason: `session:raw-session-sentinel:${rawAccount}`,
      }),
    };
    const gateway = new CloudCodeFailoverGateway(leaseService);
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: Object.assign(Readable.from([Buffer.from('{"candidates":[]}')]), { destroy: vi.fn() }),
    });
    const warnSpy = vi.spyOn(logger, 'warn');

    await gateway.handleRequest(request(), response());

    const diagnostics = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(diagnostics).toContain('Session confirmation rejected (unrecognized)');
    expect(diagnostics).not.toContain('raw-session-sentinel');
    expect(diagnostics).not.toContain(rawAccount);
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it('ends the downstream response when an affinity owner expires', async () => {
    const owner = new AbortController();
    const completeAffinityPlacement = vi.fn();
    const leaseService: any = {
      acquireAttemptLease: vi.fn().mockResolvedValue({
        account: { id: 'account', token: { access_token: 'token', project_id: 'project' } },
        generation: 1, releaseReservation: vi.fn(), completeAffinityPlacement, affinityAbortSignal: owner.signal,
      }),
    };
    const gateway = new CloudCodeFailoverGateway(leaseService);
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockReturnValue(new Promise(() => {}));
    const res = response();
    void gateway.handleRequest(request(), res);
    await vi.waitFor(() => expect(leaseService.acquireAttemptLease).toHaveBeenCalledOnce());

    owner.abort();

    expect(completeAffinityPlacement).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.writableEnded).toBe(true);
  });
});
