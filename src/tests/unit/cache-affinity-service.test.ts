import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '@/admin/admin.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { createMigrationAuthorization } from '@/modules/proxy-gateway/server/cache-affinity-coordinator';
import { RateLimitReason, type RateLimitTracker } from '@/modules/proxy-gateway/server/rate-limit-tracker';

describe('AccountLeaseService cache affinity fences', () => {
  let service: AccountLeaseService;

  beforeEach(() => {
    service = new AccountLeaseService();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    (service as any).tokens = new Map(['acc-1', 'acc-2'].map((id) => [id, {
      account_id: id,
      email: `${id}@test.dev`,
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: expiresAt,
      project_id: `project-${id}`,
      session_id: `session-${id}`,
    }]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['removed', 'disabled'] as const)(
    'preserves live affinity and limits while invalidating a %s account on snapshot reload',
    async (unavailable) => {
      const accounts: CloudAccount[] = [...(service as any).tokens.values()].map((token) => ({
        id: token.account_id,
        provider: 'google',
        email: token.email,
        token: { ...token, session_id: undefined },
        created_at: 1,
        last_used: 1,
        status: 'active',
        is_active: false,
      }));
      vi.spyOn(CloudAccountRepo, 'getAccounts').mockImplementation(async () => accounts);
      await service.loadAccounts();
      service.bindSession('session:unavailable', 'acc-1');
      service.bindSession('session:healthy', 'acc-2');
      const healthyBinding = service.getSessionBinding('session:healthy');
      expect(healthyBinding).toMatchObject({ accountId: 'acc-2' });
      expect(service.getSessionBinding('session:unavailable')).toMatchObject({ accountId: 'acc-1' });
      const cooldownUntil = Date.now() + 60_000;
      (service as any).accountCooldowns.set('acc-2', cooldownUntil);
      const tracker = (service as any).rateLimitTracker as RateLimitTracker;
      tracker.setLockoutUntilIso(
        'acc-2', new Date(cooldownUntil).toISOString(), RateLimitReason.RateLimitExceeded,
        'gemini-2.5-pro',
      );
      const rateLimitBefore = tracker.getRemainingWaitSeconds('acc-2', 'gemini-2.5-pro');
      expect(rateLimitBefore).toBeGreaterThan(0);
      accounts[1].token.access_token = 'updated-access';
      if (unavailable === 'removed') accounts.splice(0, 1);
      else accounts[0].status = 'expired';

      await expect(service.loadAccounts()).resolves.toBe(1);

      expect(service.getSessionBinding('session:healthy')).toEqual(healthyBinding);
      expect(service.getSessionBinding('session:unavailable')).toBeNull();
      expect((service as any).tokens.get('acc-2').access_token).toBe('updated-access');
      expect((service as any).tokens.get('acc-2').session_id).toBe('session-acc-2');
      expect((service as any).accountCooldowns.get('acc-2')).toBe(cooldownUntil);
      expect(tracker.getRemainingWaitSeconds('acc-2', 'gemini-2.5-pro')).toBeGreaterThan(0);
    },
  );

  it.each([undefined, '-1234567890123456789'])(
    'keeps runtime session IDs across import unless the import supplies %s',
    async (persistedSessionId) => {
      const accounts: CloudAccount[] = [...(service as any).tokens.values()].map((token) => ({
        id: token.account_id,
        provider: 'google',
        email: token.email,
        token: { ...token, session_id: undefined },
        created_at: 1,
        last_used: 1,
        status: 'active',
      }));
      vi.spyOn(CloudAccountRepo, 'getAccounts').mockImplementation(async () => accounts);
      vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockImplementation(async (email) =>
        accounts.find((account) => account.email === email));
      vi.spyOn(CloudAccountRepo, 'importAccount').mockImplementation(async (account) => {
        const index = accounts.findIndex((existing) => existing.id === account.id);
        if (index === -1) accounts.push(account);
        else accounts[index] = account;
        return account;
      });
      await service.loadAccounts();
      service.bindSession('session:import', 'acc-1');
      const binding = service.getSessionBinding('session:import');

      const result = await new AdminService(service).importAccounts({
        accounts: [{
          provider: 'google',
          email: accounts[0].email,
          token: { ...accounts[0].token, access_token: 'imported-access', session_id: persistedSessionId },
        }],
      });

      expect(result.imported).toBe(1);
      expect((service as any).tokens.get('acc-1')).toMatchObject({
        access_token: 'imported-access',
        session_id: persistedSessionId ?? 'session-acc-1',
      });
      expect((service as any).tokens.get('acc-2').session_id).toBe('session-acc-2');
      expect(service.getSessionBinding('session:import')).toEqual(binding);
      await service.loadAccounts();
      expect((service as any).tokens.get('acc-1').session_id)
        .toBe(persistedSessionId ?? 'session-acc-1');
    },
  );

  it('generates separate valid IDs for new accounts and reuses them on later snapshots', async () => {
    const accounts: CloudAccount[] = ['new-1', 'new-2'].map((id) => ({
      id,
      provider: 'google',
      email: 'acc-1@test.dev',
      token: { ...(service as any).tokens.get('acc-1'), session_id: undefined },
      created_at: 1,
      last_used: 1,
      status: 'active',
    }));
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockImplementation(async () => accounts);

    await expect(service.loadAccounts()).resolves.toBe(2);
    const sessionIds = accounts.map(({ id }) => (service as any).tokens.get(id).session_id);
    for (const sessionId of sessionIds) {
      expect(sessionId).toMatch(/^-[1-8]\d{18}$/);
      expect(sessionId).not.toBe('session-acc-1');
    }
    expect(new Set(sessionIds).size).toBe(2);

    await service.loadAccounts();
    expect(accounts.map(({ id }) => (service as any).tokens.get(id).session_id)).toEqual(sessionIds);
  });

  it('rejects a stale migration authorization before reserving or dispatching', async () => {
    const sessionKey = 'session:stale-authorization-canary';
    service.bindSession(sessionKey, 'acc-1');
    const authorization = createMigrationAuthorization(
      'quota-exhausted', sessionKey, service.getSessionBinding(sessionKey), 'req-stale',
    );
    const competingMigration = service.startSessionMigration(sessionKey, 1, 'acc-2', 'req-new');
    expect(competingMigration).not.toBeNull();
    expect(service.confirmOrBindSession(
      sessionKey, 'acc-2', competingMigration!.generation, 'req-new', undefined,
      competingMigration!.tableIncarnation,
    )).toEqual({ kind: 'confirmed' });

    const reserve = vi.spyOn(service, 'acquireWorkReservation');
    await expect(service.acquireAttemptLease({
      sessionKey, deferSessionBinding: true, migrationAuthorization: authorization!, requestId: 'req-stale',
    })).resolves.toBeNull();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('returns fixed affinity rejection reasons without session or account identities', () => {
    const sessionKey = 'session:raw-identity-sentinel';
    service.bindSession(sessionKey, 'account-sentinel-a');
    const rejected = service.confirmOrBindSession(sessionKey, 'account-sentinel-b');
    expect(rejected).toEqual({ kind: 'rejected', reason: 'active-binding-conflict' });
    expect(JSON.stringify(rejected)).not.toContain('sentinel');
  });

  it.each([
    ['account-deleted', (tokens: Map<string, any>) => tokens.delete('acc-1')],
    ['account-disabled', (tokens: Map<string, any>) => { tokens.get('acc-1').status = 'expired'; }],
  ] as const)('authorizes pre-dispatch migration when the binding is %s', (reason, mutate) => {
    const sessionKey = `session:${reason}`;
    service.bindSession(sessionKey, 'acc-1');
    mutate((service as any).tokens);

    expect(service.authorizeBoundSessionMigration(sessionKey, 'gemini-2.5-pro', 'req-owner')).toMatchObject({
      reason, sessionKey, ownerRequestId: 'req-owner', expectedGeneration: 1,
    });
  });

  it('authorizes pre-dispatch migration for an incompatible bound model and does not authorize healthy failback', async () => {
    const sessionKey = 'session:pre-dispatch-model';
    service.bindSession(sessionKey, 'acc-1');
    const tokens = (service as any).tokens as Map<string, any>;
    tokens.get('acc-1').model_quotas = { 'gemini-2.0-flash': 100 };
    tokens.get('acc-2').model_quotas = { 'gemini-2.5-pro': 100 };

    const authorization = service.authorizeBoundSessionMigration(sessionKey, 'gemini-2.5-pro', 'req-owner');
    expect(authorization).toMatchObject({ reason: 'model-incompatible', ownerRequestId: 'req-owner' });
    const lease = await service.acquireAttemptLease({
      sessionKey, model: 'gemini-2.5-pro', deferSessionBinding: true,
      migrationAuthorization: authorization, requestId: 'req-owner',
    });
    expect(lease?.account.id).toBe('acc-2');
    lease?.releaseReservation();
    expect(service.authorizeBoundSessionMigration(sessionKey, undefined, 'req-other')).toBeUndefined();
  });

  it('migrates from a bound account whose forwarded physical model is locked out', async () => {
    const sessionKey = 'session:forwarded-lockout';
    service.bindSession(sessionKey, 'acc-1');
    const tokens = (service as any).tokens as Map<string, any>;
    tokens.get('acc-1').model_forwarding_rules = { public: 'physical-a' };
    tokens.get('acc-2').model_forwarding_rules = { public: 'physical-b' };
    tokens.get('acc-1').model_quotas = { 'physical-a': 100 };
    tokens.get('acc-2').model_quotas = { 'physical-b': 100 };
    (service as any).rateLimitTracker.setLockoutUntilIso('acc-1', new Date(Date.now() + 60_000).toISOString(), RateLimitReason.RateLimitExceeded, 'physical-a');
    const authorization = service.authorizeBoundSessionMigration(sessionKey, 'public', 'req-owner');
    expect(authorization?.reason).toBe('account-cooldown');
    const lease = await service.acquireAttemptLease({ sessionKey, model: 'public', deferSessionBinding: true, excludeAccountIds: ['acc-1'], migrationAuthorization: authorization, requestId: 'req-owner' });
    expect(lease?.account.id).toBe('acc-2');
    lease?.releaseReservation();
  });

  it('re-admits a committed migration follower on its new binding without stale admission state', async () => {
    const sessionKey = 'session:committed-follower';
    service.bindSession(sessionKey, 'acc-1');
    const ownerAuthorization = createMigrationAuthorization(
      'quota-exhausted', sessionKey, service.getSessionBinding(sessionKey), 'req-owner',
    );
    const followerAuthorization = createMigrationAuthorization(
      'quota-exhausted', sessionKey, service.getSessionBinding(sessionKey), 'req-follower',
    );
    const acquireReservation = vi.spyOn(service, 'acquireWorkReservation');

    const ownerLease = await service.acquireAttemptLease({
      sessionKey,
      deferSessionBinding: true,
      excludeAccountIds: ['acc-1'],
      migrationAuthorization: ownerAuthorization!,
      requestId: 'req-owner',
    });
    expect(ownerLease?.account.id).toBe('acc-2');

    const followerLeasePromise = service.acquireAttemptLease({
      sessionKey,
      deferSessionBinding: true,
      excludeAccountIds: ['acc-1'],
      migrationAuthorization: followerAuthorization!,
      requestId: 'req-follower',
    });
    await Promise.resolve();
    expect((service as any).affinityCoordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 1 });

    const migration = service.startSessionMigration(
      sessionKey, ownerLease!.generation, 'acc-2', 'req-owner', ownerLease!.tableIncarnation,
    );
    expect(migration).not.toBeNull();
    expect(service.confirmOrBindSession(
      sessionKey, 'acc-2', migration!.generation, 'req-owner', undefined, migration!.tableIncarnation,
    )).toEqual({ kind: 'confirmed' });

    ownerLease!.completeAffinityPlacement?.('committed');
    const followerLease = await followerLeasePromise;

    expect(followerLease?.account.id).toBe('acc-2');
    expect(followerLease?.generation).toBe(migration!.generation);
    expect(service.getSessionBinding(sessionKey)).toMatchObject({
      accountId: 'acc-2', generation: migration!.generation, state: 'active',
    });
    expect(acquireReservation).toHaveBeenCalledTimes(2);

    ownerLease!.releaseReservation();
    followerLease!.releaseReservation();
    expect(service.getInFlightWork('acc-1')).toBe(0);
    expect(service.getInFlightWork('acc-2')).toBe(0);
    expect((service as any).affinityCoordinator.getStateForTesting()).toEqual({ owners: 0, waiters: 0 });
  });

  it('coordinates concurrent non-migrating session requests behind an active migration owner', async () => {
    const sessionKey = 'session:migrating-follower-wait';
    service.bindSession(sessionKey, 'acc-1');
    const auth = createMigrationAuthorization(
      'upstream-transient', sessionKey, service.getSessionBinding(sessionKey), 'req-owner',
    );
    const ownerLease = await service.acquireAttemptLease({
      sessionKey, deferSessionBinding: true, excludeAccountIds: ['acc-1'],
      migrationAuthorization: auth!, requestId: 'req-owner',
    });
    expect(ownerLease?.account.id).toBe('acc-2');

    const migration = service.startSessionMigration(
      sessionKey, ownerLease!.generation, 'acc-2', 'req-owner', ownerLease!.tableIncarnation,
    );
    expect(migration).not.toBeNull();

    // Concurrent request in the same session arrives without migrationAuthorization while state==='migrating'
    const concurrentPromise = service.acquireAttemptLease({
      sessionKey, deferSessionBinding: true, requestId: 'req-concurrent',
    });
    await Promise.resolve();
    expect((service as any).affinityCoordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 1 });

    expect(service.confirmOrBindSession(
      sessionKey, 'acc-2', migration!.generation, 'req-owner', undefined, migration!.tableIncarnation,
    )).toEqual({ kind: 'confirmed' });
    ownerLease!.completeAffinityPlacement?.('committed');

    const concurrentLease = await concurrentPromise;
    expect(concurrentLease?.account.id).toBe('acc-2');
    expect(concurrentLease?.generation).toBe(migration!.generation);
    ownerLease!.releaseReservation();
    concurrentLease!.releaseReservation();
  });

  it('preserves hint:prefix cache affinity across a 6-minute idle gap (1h default TTL)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-18T08:00:00Z'));
      service.recordCacheHint('hint:prefix:deadbeef01234567', 'acc-2');
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect((service as any).selectionPolicy.getCacheHint('hint:prefix:deadbeef01234567')).toBe('acc-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the requested model resetTime instead of an earlier unrelated model resetTime', () => {
    const tokens = (service as any).tokens as Map<string, any>;
    tokens.get('acc-1').model_reset_times = {
      'gemini-4-hydrogen-medium': '2026-11-18T10:00:00Z',
      'gemini-4-argon-high': '2026-11-25T04:00:00Z',
    };
    const applied = (service as any).quotaRefreshPolicy.setPreciseLockoutFromCachedQuota(
      'acc-1', RateLimitReason.QuotaExhausted, 'gemini-4-argon-high',
    );
    expect(applied).toBe(true);
    const lockouts = (service as any).rateLimitTracker.peekActiveLockouts(new Date('2026-11-18T08:00:00Z').getTime());
    expect(lockouts).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        modelId: 'gemini-4-argon-high',
        unavailableUntil: new Date('2026-11-25T04:00:00Z').getTime(),
      }),
    ]);
  });
});
