import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../shared/logging/logger';
import { formatSafeEvent } from '../../shared/logging/safe-event';
import { AnonymousTransportReceiptOwner } from '../../modules/proxy-gateway/server/anonymous-transport-receipt';

function response(): any {
  return new EventEmitter();
}

describe('anonymous transport receipt terminal matrix', () => {
  afterEach(() => vi.restoreAllMocks());

  it('commits only after the asynchronous downstream finish event', () => {
    const owner = new AnonymousTransportReceiptOwner('normal');
    const res = response();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    owner.observeResponse(res);
    owner.expectDownstreamCommit('validated_response');
    expect(info).not.toHaveBeenCalled();
    res.emit('finish');
    owner.emit();
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      classification: 'validated_response', result: 'committed', downstreamCommitCount: 1,
    });
    owner.emit();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'error'] as const)('rejects when %s occurs before finish', (terminalEvent) => {
    const owner = new AnonymousTransportReceiptOwner(`before-${terminalEvent}`);
    const res = response();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    owner.observeResponse(res);
    owner.expectDownstreamCommit('validated_response');

    res.emit(terminalEvent);

    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      receiptId: `before-${terminalEvent}`,
      classification: terminalEvent === 'error' ? 'internal_error' : 'validated_response',
      result: 'rejected',
      downstreamCommitCount: 0,
    });
    res.emit('finish');
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('waits for a response terminal event before emitting a rejected receipt', () => {
    const owner = new AnonymousTransportReceiptOwner('rejected-before-terminal');
    const res = response();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    owner.observeResponse(res);
    owner.reject('internal_error');

    expect(info).not.toHaveBeenCalled();
    res.emit('finish');
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      result: 'rejected', downstreamCommitCount: 0, classification: 'internal_error',
    });
  });

  it.each([
    'unavailable', 'invalid_authority', 'request_too_large', 'rate_limited',
    'bad_gateway', 'deadline_exceeded', 'client_aborted', 'internal_error',
  ] as const)('records %s without inventing a downstream commit', (classification) => {
    const owner = new AnonymousTransportReceiptOwner(classification);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    owner.reject(classification);
    owner.emit();
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toMatchObject({
      receiptId: classification, classification, result: 'rejected', downstreamCommitCount: 0,
    });
  });

  it('does not duplicate receipts when the sink throws after partial handling', () => {
    const owner = new AnonymousTransportReceiptOwner('sink');
    const res = response();
    owner.observeResponse(res);
    owner.expectDownstreamCommit('bad_gateway');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => { throw new Error('sink failure'); });
    res.emit('finish');
    owner.emit();
    owner.emit();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('rejects accessors and extra secret fields before serializing an event', () => {
    const fields: Record<string, unknown> = { receiptId: 'safe' };
    Object.defineProperty(fields, 'classification', { enumerable: true, get: () => 'secret' });
    expect(() => formatSafeEvent('receipt', fields as any, ['receiptId', 'classification'])).toThrow('Unsafe event field');
    expect(() => formatSafeEvent('receipt', { receiptId: 'safe', secret: 'leak' }, ['receiptId'])).toThrow('Unexpected event field');
  });
});
