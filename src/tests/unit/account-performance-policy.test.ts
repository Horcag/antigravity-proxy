import { describe, expect, it } from 'vitest';
import {
  AccountPerformancePolicy,
  normalizeRemainingQuota,
} from '@/modules/proxy-gateway/server/account-performance-policy';

describe('AccountPerformancePolicy', () => {
  it('normalizes quota and applies the documented score weights with neutral missing TTFT', () => {
    let now = 1_000;
    const policy = new AccountPerformancePolicy({ now: () => now });

    expect(normalizeRemainingQuota(undefined)).toBe(0);
    expect(normalizeRemainingQuota(-20)).toBe(0);
    expect(normalizeRemainingQuota(50)).toBe(0.5);
    expect(normalizeRemainingQuota(500)).toBe(1);
    expect(
      policy.score({ accountId: 'one', effectiveModel: 'physical', remainingQuotaPercent: 50 }),
    ).toBeCloseTo(0.6);

    policy.recordSuccess('one', 'physical', 15_000);
    now += 1;
    expect(
      policy.score({ accountId: 'one', effectiveModel: 'physical', remainingQuotaPercent: 50 }),
    ).toBeCloseTo(0.6);
  });

  it('updates bounded failure EWMA without cross-contaminating physical models', () => {
    const policy = new AccountPerformancePolicy({ now: () => 1_000 });
    policy.recordFailure('account', 'physical-a');
    policy.recordFailure('account', 'physical-a');

    expect(
      policy.score({ accountId: 'account', effectiveModel: 'physical-a', remainingQuotaPercent: 0 }),
    ).toBeCloseTo(0.375 - 0.2 * 0.36);
    expect(
      policy.score({ accountId: 'account', effectiveModel: 'physical-b', remainingQuotaPercent: 0 }),
    ).toBeCloseTo(0.375);
  });

  it('uses injected monotonic time for cooldown, bounded size, reload reset, and expiry on writes', () => {
    let now = 0;
    const policy = new AccountPerformancePolicy({ now: () => now, maxEntries: 2 });
    policy.recordSuccess('b', 'model', 0);
    now = 1;
    policy.recordSuccess('a', 'model', 0);
    now = 2;
    policy.recordSuccess('c', 'model', 0);

    expect(policy.size).toBe(2);
    expect(
      policy.score({ accountId: 'b', effectiveModel: 'model', remainingQuotaPercent: 0 }),
    ).toBeCloseTo(0.375);
    expect(
      policy.score({
        accountId: 'a',
        effectiveModel: 'model',
        remainingQuotaPercent: 0,
        remainingCooldownMs: 150_000,
      }),
    ).toBeCloseTo(0.55 - 0.025);

    policy.resetAccounts(new Set(['a']));
    expect(policy.size).toBe(1);
    now = 3;
    policy.recordFailure('a', 'model');
    now = 1_800_004;
    expect(policy.score({ accountId: 'a', effectiveModel: 'model' })).toBeCloseTo(0.375);
    expect(policy.size).toBe(1);

    policy.recordSuccess('a', 'model');
    expect(policy.size).toBe(1);
    expect(policy.score({ accountId: 'a', effectiveModel: 'model' })).toBeCloseTo(0.375);
  });

  it('keeps concurrent observations isolated by account and physical model', async () => {
    const policy = new AccountPerformancePolicy({ now: () => 10 });
    await Promise.all([
      Promise.resolve().then(() => policy.recordSuccess('account-a', 'physical-a', 100)),
      Promise.resolve().then(() => policy.recordFailure('account-b', 'physical-b')),
    ]);

    expect(
      policy.score({ accountId: 'account-a', effectiveModel: 'physical-a', remainingQuotaPercent: 100 }),
    ).toBeGreaterThan(
      policy.score({ accountId: 'account-b', effectiveModel: 'physical-b', remainingQuotaPercent: 100 }),
    );
  });
});
