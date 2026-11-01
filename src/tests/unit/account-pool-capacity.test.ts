import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveAccountPoolCapacityFailure,
  type AccountPoolCapacityCandidate,
} from '@/modules/proxy-gateway/server/account-pool-capacity';

const now = Date.parse('2026-10-29T10:00:00.000Z');

function candidate(
  blocks: AccountPoolCapacityCandidate['blocks'],
  availability: AccountPoolCapacityCandidate['availability'] = 'available',
): AccountPoolCapacityCandidate {
  return { availability, blocks };
}

function block(reason: string, delayMs: number) {
  return { reason, unavailableUntil: now + delayMs };
}

describe('resolveAccountPoolCapacityFailure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a mixed quota and rate-limit pool as rate limited', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000)]),
      candidate([block('rate_limited', 20_000)]),
    ], now)).toEqual({
      reason: 'rate_limited',
      retryAfterSeconds: 10,
      retryAt: new Date(now + 10_000).toISOString(),
    });
  });

  it('reports quota exhaustion only when every candidate has an active quota block', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000), block('rate_limited', 15_000)]),
      candidate([block('quota_exhausted', 20_000)]),
    ], now)?.reason).toBe('quota_exhausted');
  });

  it('suppresses failure when any selected account is ready', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000)]),
      candidate([]),
    ], now)).toBeUndefined();
  });

  it('does not report exhaustion while an unknown catalog entry may be ready', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000)]),
      candidate([], 'unknown'),
    ], now)).toBeUndefined();
  });

  it('includes precisely blocked unknown fallback accounts in the pool retry deadline', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000)]),
      candidate([block('rate_limited', 5_000)], 'unknown'),
    ], now)).toEqual({
      reason: 'rate_limited',
      retryAfterSeconds: 5,
      retryAt: new Date(now + 5_000).toISOString(),
    });
  });

  it('uses unknown accounts when no available catalog entries exist', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('rate_limited', 12_000)], 'unknown'),
      candidate([], 'unavailable'),
    ], now)?.retryAfterSeconds).toBe(12);
  });

  it('does not infer exhausted capacity from missing catalog entries without blocks', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000)], 'unknown'),
      candidate([], 'unknown'),
    ], now)).toBeUndefined();
  });

  it('does not report capacity failure for an empty or entirely unavailable pool', () => {
    expect(resolveAccountPoolCapacityFailure([], now)).toBeUndefined();
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 10_000)], 'unavailable'),
    ], now)).toBeUndefined();
  });

  it.each([now - 1, now, NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    'ignores expired or invalid deadline %s',
    (unavailableUntil) => {
      expect(resolveAccountPoolCapacityFailure([
        candidate([{ reason: 'quota_exhausted', unavailableUntil }]),
      ], now)).toBeUndefined();
    },
  );

  it('ignores expired and invalid unrelated blocks alongside active capacity blocks', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([
        block('quota_exhausted', 10_000),
        block('server_error', -1),
        { reason: 'model_not_found', unavailableUntil: Infinity },
      ]),
    ], now)?.reason).toBe('quota_exhausted');
  });

  it.each(['server_error', 'model_not_found', 'account_cooldown'])(
    'suppresses capacity failure when an active %s blocker also exists',
    (reason) => {
      expect(resolveAccountPoolCapacityFailure([
        candidate([block('quota_exhausted', 10_000)]),
        candidate([block('rate_limited', 15_000), block(reason, 20_000)]),
      ], now)).toBeUndefined();
    },
  );

  it('uses the latest block per account and the earliest ready account across the pool', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('quota_exhausted', 5_000), block('rate_limited', 30_000)]),
      candidate([block('quota_exhausted', 20_000), block('rate_limited', 25_000)]),
    ], now)).toEqual({
      reason: 'quota_exhausted',
      retryAfterSeconds: 25,
      retryAt: new Date(now + 25_000).toISOString(),
    });
  });

  it('rounds retry seconds up without changing the retry timestamp', () => {
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('rate_limited', 1_001)]),
    ], now)).toEqual({
      reason: 'rate_limited',
      retryAfterSeconds: 2,
      retryAt: new Date(now + 1_001).toISOString(),
    });
  });

  it('defaults to the current time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(resolveAccountPoolCapacityFailure([
      candidate([block('rate_limited', 1)]),
    ])?.retryAfterSeconds).toBe(1);
  });

  it('does not mutate frozen candidates or blocks', () => {
    const blocks = Object.freeze([Object.freeze(block('rate_limited', 10_000))]);
    const candidates = Object.freeze([Object.freeze(candidate(blocks))]);
    const before = structuredClone(candidates);

    expect(resolveAccountPoolCapacityFailure(candidates, now)?.reason).toBe('rate_limited');
    expect(candidates).toEqual(before);
  });
});
