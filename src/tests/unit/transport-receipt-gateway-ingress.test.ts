import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../shared/logging/logger';
import {
  CloudCodeFailoverGateway,
  GatewayReceiptTransferError,
} from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import { AnonymousTransportReceiptOwner } from '../../modules/proxy-gateway/server/anonymous-transport-receipt';

function response(): any {
  const res = new EventEmitter() as any;
  res.headersSent = false;
  res.writableEnded = false;
  res.writableFinished = false;
  res.writeHead = vi.fn(() => { res.headersSent = true; });
  res.end = vi.fn(() => { res.writableEnded = true; });
  res.write = vi.fn(() => true);
  res.destroy = vi.fn(() => { res.emit('close'); });
  return res;
}

function request(host: string): any {
  const req = new EventEmitter() as any;
  req.url = '/v1internal:streamGenerateContent';
  req.method = 'POST';
  req.headers = { host };
  req.complete = true;
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ model: 'gemini-2.5-pro' }));
  };
  return req;
}

function pendingRequest(host: string): { req: any; release: () => void } {
  const req = request(host);
  let releaseBody!: () => void;
  req[Symbol.asyncIterator] = async function* () {
    await new Promise<void>((resolve) => { releaseBody = resolve; });
    yield Buffer.from(JSON.stringify({ model: 'gemini-2.5-pro' }));
  };
  return { req, release: () => releaseBody() };
}

describe('transport receipt gateway and ingress terminal ownership', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits one committed invalid-authority receipt only after gateway response finish', async () => {
    const gateway = new CloudCodeFailoverGateway();
    const res = response();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await gateway.handleRequest(request('attacker.invalid'), res);
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(info).not.toHaveBeenCalled();

    res.emit('finish');
    res.emit('close');
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      classification: 'invalid_authority', result: 'committed', downstreamCommitCount: 1,
    });
    expect(JSON.parse(String(info.mock.calls[0][0])).receiptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('classifies exhausted gRPC 14 retries as unavailable, never rate_limited', async () => {
    const account = { id: 'account', provider: 'google', email: 'account@example.test', is_active: true,
      created_at: Date.now(), last_used: Date.now(), token: { access_token: 'token', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: Date.now() + 3600, project_id: 'project' } };
    const leases = { getNextToken: vi.fn(async () => account) };
    const gateway = new CloudCodeFailoverGateway(leases as any);
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/grpc', 'grpc-status': '14' },
      bodyStream: new PassThrough(),
    });
    const res = response();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await gateway.handleRequest(request('daily-cloudcode-pa.googleapis.com'), res);
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(info).not.toHaveBeenCalled();
    res.emit('finish');

    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      classification: 'unavailable', result: 'committed', downstreamCommitCount: 1,
    });
  });

  it('ingress logs the original gateway cause and waits for its own error response finish', async () => {
    const ingress = new ConnectIngressService();
    const server = new EventEmitter() as any;
    server.on = vi.fn(EventEmitter.prototype.on.bind(server));
    ingress.attach(server);
    const cause = new Error('write failure');
    const owner = new AnonymousTransportReceiptOwner('transferred');
    (ingress as any).failoverGateway.handleRequest = vi.fn().mockRejectedValue(
      new GatewayReceiptTransferError(owner, cause),
    );
    const res = response();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const listener = (ingress as any).h2Server.listeners('request')[0];

    listener(request('daily-cloudcode-pa.googleapis.com'), res);
    await new Promise(resolve => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith(expect.any(String), cause);
    expect(info).not.toHaveBeenCalled();
    res.emit('finish');

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      receiptId: 'transferred', classification: 'internal_error', result: 'committed', downstreamCommitCount: 1,
    });
    ingress.close();
  });

  it('propagates a deadline response write failure after body buffering exits through client abort', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new CloudCodeFailoverGateway();
      const { req, release } = pendingRequest('daily-cloudcode-pa.googleapis.com');
      const res = response();
      const writeFailure = new Error('deadline write failed');
      res.writeHead.mockImplementation(() => { throw writeFailure; });

      const handling = gateway.handleRequest(req, res);
      await vi.advanceTimersByTimeAsync(120000);
      release();

      await expect(handling).rejects.toMatchObject({
        name: 'GatewayReceiptTransferError',
        originalCause: writeFailure,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not nest an existing receipt transfer error around another owner', async () => {
    const originalCause = new Error('original write failure');
    const transferred = new GatewayReceiptTransferError(
      new AnonymousTransportReceiptOwner('existing-transfer'),
      originalCause,
    );
    const leases = { getNextToken: vi.fn(async () => { throw transferred; }) };
    const gateway = new CloudCodeFailoverGateway(leases as any);

    await expect(gateway.handleRequest(request('daily-cloudcode-pa.googleapis.com'), response()))
      .rejects.toBe(transferred);
    expect(transferred.originalCause).toBe(originalCause);
  });

  it('emits one rejected receipt when the ingress fallback response write fails', async () => {
    const ingress = new ConnectIngressService();
    const server = new EventEmitter() as any;
    server.on = vi.fn(EventEmitter.prototype.on.bind(server));
    ingress.attach(server);
    const owner = new AnonymousTransportReceiptOwner('fallback-write-failure');
    (ingress as any).failoverGateway.handleRequest = vi.fn().mockRejectedValue(
      new GatewayReceiptTransferError(owner, new Error('upstream write failure')),
    );
    const res = response();
    res.end.mockImplementation(() => { throw new Error('fallback end failed'); });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const listener = (ingress as any).h2Server.listeners('request')[0];

    listener(request('daily-cloudcode-pa.googleapis.com'), res);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      receiptId: 'fallback-write-failure', classification: 'internal_error', result: 'rejected', downstreamCommitCount: 0,
    });
    ingress.close();
  });

  it('terminates and rejects a transferred owner when headers are already sent', async () => {
    const ingress = new ConnectIngressService();
    const server = new EventEmitter() as any;
    server.on = vi.fn(EventEmitter.prototype.on.bind(server));
    ingress.attach(server);
    const owner = new AnonymousTransportReceiptOwner('headers-sent-transfer');
    (ingress as any).failoverGateway.handleRequest = vi.fn().mockRejectedValue(
      new GatewayReceiptTransferError(owner, new Error('headers already sent')),
    );
    const res = response();
    res.headersSent = true;
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const listener = (ingress as any).h2Server.listeners('request')[0];

    listener(request('daily-cloudcode-pa.googleapis.com'), res);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      receiptId: 'headers-sent-transfer', classification: 'internal_error', result: 'rejected', downstreamCommitCount: 0,
    });
    ingress.close();
  });
});
