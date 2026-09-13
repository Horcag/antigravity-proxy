import { describe, expect, it, vi } from 'vitest';
import { ProxyRetryPolicy } from '@/modules/proxy-gateway/server/proxy-retry-policy';
import type { CloudAccount } from '@/modules/cloud-account/types';

const account = (id: string): CloudAccount => ({
  id, provider: 'google', email: `${id}@example.test`, created_at: 1, last_used: 1,
  token: { access_token: id, refresh_token: id, token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 9999999999 },
});

describe('ProxyRetryPolicy concurrent affinity', () => {
  it('clears stale authorization after an awaited lease observes a newer binding', async () => {
    let resolveLease!: (lease: any) => void;
    const leases: any = {
      acquireAttemptLease: vi.fn(() => new Promise((resolve) => { resolveLease = resolve; })),
      getSessionBinding: vi.fn().mockReturnValueOnce({ accountId: 'acc-1', generation: 1, tableIncarnation: 1 }).mockReturnValue({ accountId: 'acc-2', generation: 2, tableIncarnation: 1 }),
      startSessionMigration: vi.fn(), recordParityError: vi.fn(), markAsForbidden: vi.fn(), markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn(),
    };
    const policy = new ProxyRetryPolicy(leases, { log: vi.fn(), warn: vi.fn() });
    const state = policy.createTokenRetryState();
    state.migrationAuthorization = { reason: 'quota-exhausted', sessionKey: 'session-1', expectedGeneration: 1, expectedTableIncarnation: 1, ownerRequestId: state.requestId };
    const selecting = policy.selectRetryToken(state, 'gemini-3-flash', 'session-1');
    resolveLease({ account: account('acc-2'), generation: 1, tableIncarnation: 1, releaseReservation: vi.fn() });
    await expect(selecting).resolves.toEqual(expect.objectContaining({ id: 'acc-2' }));
    expect(state.migrationAuthorization).toBeUndefined();
    expect(leases.startSessionMigration).not.toHaveBeenCalled();
  });
});
