import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { createMigrationAuthorization } from '@/modules/proxy-gateway/server/cache-affinity-coordinator';
import { RateLimitReason } from '@/modules/proxy-gateway/server/rate-limit-tracker';

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
});
