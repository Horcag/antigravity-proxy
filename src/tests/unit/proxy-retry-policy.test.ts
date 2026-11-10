import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProxyRetryPolicy } from '@/modules/proxy-gateway/server/proxy-retry-policy';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/proxy-model-availability-store';
import { AccountLeaseLimitPolicy } from '@/modules/proxy-gateway/server/account-lease-limit-policy';
import { isStrictAuthenticationFailure } from '@/modules/cloud-account/services/strict-authentication-classifier';
import type { CloudAccount } from '@/modules/cloud-account/types';

function createToken(id: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    },
    created_at: 1,
    last_used: 1,
  };
}

function createPolicy() {
  const accountLeaseService = {
    getNextToken: vi.fn(),
    recordParityError: vi.fn(),
    markAsForbidden: vi.fn(),
    markAsRateLimited: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
  };
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
  };
  const policy = new ProxyRetryPolicy(accountLeaseService, logger);

  return {
    logger,
    policy,
    accountLeaseService,
  };
}

describe('ProxyRetryPolicy', () => {
  it.each([{ status: 401 }, { statusCode: 403 }, { response: { status: 401 } }])(
    'accepts supported structured authentication statuses: %j',
    (error) => {
      expect(isStrictAuthenticationFailure(error)).toBe(true);
    },
  );

  it.each([
    { status: 400 },
    { status: 4012 },
    { status: '401' },
    { response: { status: 4032 } },
  ])('rejects unsupported structured authentication statuses: %j', (error) => {
    expect(isStrictAuthenticationFailure(error)).toBe(false);
  });

  it('classifies retryable upstream failures consistently', () => {
    const { policy } = createPolicy();

    expect(policy.classifyUpstreamFailure('403 permission_denied')).toEqual({
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
    expect(policy.classifyUpstreamFailure('429 quota exceeded')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: true,
    });
    expect(policy.classifyUpstreamFailure('socket hang up')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
    expect(policy.classifyUpstreamFailure('bad user request')).toEqual({
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
  });

  it.each([
    'HTTP 4012',
    '401',
    '403',
    'INVALID_GRANT',
    'PERMISSION_DENIED',
    '403 PERMISSION_DENIED',
    'HTTP 401 UNAUTHORIZED',
    'HTTP  401',
    'HTTP\t403',
    'HTTP401',
    'not unauthorized',
    'authorization succeeded',
    'unrelated message containing 401, unauthorized, and forbidden',
  ])('does not treat arbitrary prose as an authentication failure: %s', async (message) => {
    const { policy, accountLeaseService } = createPolicy();

    expect(policy.classifyUpstreamFailure(message)).toEqual({
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
    await expect(
      policy.applyUpstreamPenalty('acc-1', 'gemini-3-flash', new Error(message)),
    ).resolves.toBe(false);

    expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(accountLeaseService.markAsRateLimited).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it.each(['HTTP 401', 'HTTP 403', 'UNAUTHORIZED', 'FORBIDDEN'])(
    'marks exact normalized authentication failures as forbidden: %s',
    async (message) => {
      const { policy, accountLeaseService } = createPolicy();

      await expect(
        policy.applyUpstreamPenalty('acc-1', 'gemini-3-flash', new Error(message)),
      ).resolves.toBe(true);

      expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-1');
      expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    },
  );

  it('redacts raw and derived account data from generic retry diagnostics', async () => {
    const { policy, logger } = createPolicy();
    const rawCanary = 'raw-retry-canary-account-token-project';
    const base64Canary = Buffer.from(rawCanary).toString('base64');
    const sha256Canary = createHash('sha256').update(rawCanary).digest('hex');
    const upstreamPayload = [rawCanary, base64Canary, sha256Canary].join('|');

    await expect(
      policy.applyUpstreamPenalty('canary-account', 'gemini-3-flash', new Error(upstreamPayload)),
    ).resolves.toBe(false);
    await expect(
      policy.applyUpstreamPenalty(
        'canary-account',
        'gemini-3-flash',
        new UpstreamRequestError({ status: 503 }),
      ),
    ).resolves.toBe(true);

    const diagnostics = [...logger.log.mock.calls, ...logger.warn.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(logger.warn).toHaveBeenCalledWith(
      'Upstream request failed: operation=proxy_request reason=generic_failure',
    );
    for (const canary of [rawCanary, base64Canary, sha256Canary, 'canary-account']) {
      expect(diagnostics).not.toContain(canary);
    }
  });

  it('redacts all identity and secret canaries across the retry-to-limit penalty path', async () => {
    const accountSource = 'canary-account-source@example.test';
    const accountId = 'canary-account-id';
    const rawCanaries = [
      accountSource,
      accountId,
      'canary-email@example.test',
      'canary-project-id',
      'canary-access-token',
      'canary-refresh-token',
      'canary-client-secret',
      'http://canary-proxy.example.test',
    ];
    const canaries = rawCanaries.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    const limitLogger = { warn: vi.fn() };
    const limitPolicy = new AccountLeaseLimitPolicy({
      rateLimitCooldownMs: 5_000,
      forbiddenCooldownMs: 10_000,
      resolveAccountId: (source) => (source === accountSource ? accountId : source),
      getCircuitBreakerBackoffSteps: () => [1],
      refreshRealtimeQuotaAndSetPreciseLockout: vi.fn().mockResolvedValue(false),
      setPreciseLockoutFromCachedQuota: vi.fn().mockReturnValue(false),
      logger: limitLogger,
    });
    const accountLeaseService = {
      getNextToken: vi.fn(),
      recordParityError: vi.fn(),
      markAsForbidden: vi.fn((source: string) => limitPolicy.markAsForbidden(source)),
      markAsRateLimited: vi.fn((source: string) => limitPolicy.markAsRateLimited(source)),
      markFromUpstreamError: vi.fn((params) => limitPolicy.markFromUpstreamError(params)),
    };
    const retryLogger = { log: vi.fn(), warn: vi.fn() };
    const policy = new ProxyRetryPolicy(accountLeaseService, retryLogger);

    await expect(
      policy.applyUpstreamPenalty(
        accountSource,
        'gemini-3-flash',
        new UpstreamRequestError({
          status: 429,
          reason: 'rate_limited',
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      policy.applyUpstreamPenalty(accountSource, 'gemini-3-flash', new Error('429 quota exhausted')),
    ).resolves.toBe(true);
    await expect(
      policy.applyUpstreamPenalty(accountSource, 'gemini-3-flash', new Error('FORBIDDEN')),
    ).resolves.toBe(true);

    const diagnostics = [
      ...limitLogger.warn.mock.calls,
      ...retryLogger.log.mock.calls,
      ...retryLogger.warn.mock.calls,
    ]
      .flat()
      .map(String)
      .join('\n');
    for (const canary of canaries) {
      expect(diagnostics).not.toContain(canary);
    }
    expect(diagnostics).toContain('operation=account_lease');
    expect(diagnostics).toContain('reason=rate_limit_exceeded');
    expect(diagnostics).toContain('cooldown_seconds=');
  });

  it('selects retry tokens while excluding already attempted accounts', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const retryState = policy.createTokenRetryState();

    accountLeaseService.getNextToken.mockResolvedValueOnce(createToken('acc-1'));
    accountLeaseService.getNextToken.mockResolvedValueOnce(createToken('acc-2'));

    await expect(
      policy.selectRetryToken(retryState, 'gemini-3-flash', 'session-1'),
    ).resolves.toEqual(expect.objectContaining({ id: 'acc-1' }));
    await expect(
      policy.selectRetryToken(retryState, 'gemini-3-flash', 'session-1'),
    ).resolves.toEqual(expect.objectContaining({ id: 'acc-2' }));

    expect(accountLeaseService.getNextToken).toHaveBeenNthCalledWith(1, {
      sessionKey: 'session-1',
      excludeAccountIds: [],
      model: 'gemini-3-flash',
      deferSessionBinding: true,
    });
    expect(accountLeaseService.getNextToken).toHaveBeenNthCalledWith(2, {
      sessionKey: 'session-1',
      excludeAccountIds: ['acc-1'],
      model: 'gemini-3-flash',
      deferSessionBinding: true,
    });
  });

  it('routes structured upstream errors to account lease upstream error handling', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await expect(
      policy.applyUpstreamPenalty(
      'acc-1',
      'gemini-3-flash',
      new UpstreamRequestError({
        status: 429,
        headers: { retryAfter: '30' },
        reason: 'quota_exhausted',
      }),
      ),
    ).resolves.toBe(true);

    expect(accountLeaseService.recordParityError).toHaveBeenCalledOnce();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '30',
      reason: 'quota_exhausted',
      model: 'gemini-3-flash',
    });
  });

  it.each([
    ['30', '30'],
    ['Wed, 21 Oct 2037 07:28:00 GMT', 'Wed, 21 Oct 2037 07:28:00 GMT'],
  ])('preserves safe Retry-After values: %s', async (retryAfter, expectedRetryAfter) => {
    const { policy, accountLeaseService } = createPolicy();

    await expect(
      policy.applyUpstreamPenalty(
        'acc-1',
        'gemini-3-flash',
        new UpstreamRequestError({
          status: 429,
          headers: { retryAfter },
          reason: 'rate_limited',
        }),
      ),
    ).resolves.toBe(true);

    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({ retryAfter: expectedRetryAfter }),
    );
  });

  it.each(['-1', '0', '1.5', 'Wed, 99 Oct 2037 07:28:00 GMT', 'canary\r\nheader: value'])(
    'rejects unsafe Retry-After values: %s',
    async (retryAfter) => {
      const { policy, accountLeaseService } = createPolicy();

      await expect(
        policy.applyUpstreamPenalty(
          'acc-1',
          'gemini-3-flash',
          new UpstreamRequestError({
            status: 429,
            headers: { retryAfter },
            reason: 'rate_limited',
          }),
        ),
      ).resolves.toBe(true);

      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
        expect.objectContaining({ retryAfter: undefined }),
      );
    },
  );

  it.each([
    [404, 'model_not_supported'],
    [403, 'model_forbidden'],
  ] as const)(
    'keeps image-model %i failures scoped to the affected model',
    async (status, reason) => {
      proxyModelAvailabilityStore.clearAccount('acc-image');
      const { policy, accountLeaseService } = createPolicy();

      await policy.applyUpstreamPenalty(
        'acc-image',
        'gemini-3-pro-image',
        new UpstreamRequestError({
          status,
        }),
      );

      expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
      expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
      expect(proxyModelAvailabilityStore.getSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: 'acc-image',
            modelId: 'gemini-3-pro-image',
            reason,
          }),
        ]),
      );
      expect(proxyModelAvailabilityStore.isAvailable('acc-image', 'gemini-3-pro-image')).toBe(
        false,
      );
      proxyModelAvailabilityStore.clearAccount('acc-image');
    },
  );

  it('marks string-classified rate limits on generic errors', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty('acc-1', 'gemini-3-flash', new Error('429 quota exceeded'));

    expect(accountLeaseService.recordParityError).toHaveBeenCalledOnce();
    expect(accountLeaseService.markAsRateLimited).toHaveBeenCalledWith('acc-1');
  });

  it('does not rotate accounts for a non-retryable upstream client error', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await expect(
      policy.applyUpstreamPenalty(
        'acc-1',
        'gemini-3-flash',
        new UpstreamRequestError({ status: 400 }),
      ),
    ).resolves.toBe(false);
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it.each([
    ...[401, 403, 408, 429, 499, 500, 502, 503, 504].map((status) => ({ status })), { reason: 'transport' as const },
  ])('switches accounts instead of replaying a failed stream as nonstream: %j', (failure) => {
    const { policy } = createPolicy();
    expect(policy.shouldFailoverImmediately(new UpstreamRequestError(failure))).toBe(true);
    expect(policy.shouldFailoverImmediately(new UpstreamRequestError({ status: 400 }))).toBe(false);
    for (const status of [501, 507, 520]) expect(policy.shouldFailoverImmediately(new UpstreamRequestError({ status }))).toBe(false);
    expect(policy.shouldFailoverImmediately(new UpstreamRequestError({ status: 403, reason: 'tos_violation' }))).toBe(false);
  });

  it('does not dispatch a migration candidate when ownership is denied', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const leaseService = accountLeaseService as any;
    const releaseReservation = vi.fn();
    leaseService.acquireAttemptLease = vi.fn().mockResolvedValue({
      account: createToken('acc-2'),
      generation: 1,
      tableIncarnation: 1,
      releaseReservation,
    });
    leaseService.getSessionBinding = vi.fn().mockReturnValue({
      accountId: 'acc-1',
      generation: 1,
    });
    leaseService.startSessionMigration = vi.fn().mockReturnValue(null);

    const retryState = policy.createTokenRetryState();
    retryState.attemptedAccountIds.add('acc-1');
    retryState.migrationAuthorization = {
      reason: 'quota-exhausted',
      sessionKey: 'session-1',
      expectedGeneration: 1,
      expectedTableIncarnation: 1,
      ownerRequestId: retryState.requestId,
    };

    await expect(policy.selectRetryToken(retryState, 'gemini-3-flash', 'session-1')).resolves.toBeNull();
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it('does not migrate a committed session after a transient upstream failure', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const leaseService = accountLeaseService as any;
    const retryState = policy.createTokenRetryState();

    await expect(
      policy.applyUpstreamPenalty(
        'acc-1',
        'gemini-3-flash',
        new UpstreamRequestError({ status: 503, reason: 'upstream_error' }),
        retryState,
      ),
    ).resolves.toBe(true);
    expect(retryState.migrationAuthorization).toBeUndefined();

    const releaseReservation = vi.fn();
    leaseService.acquireAttemptLease = vi.fn().mockResolvedValue({
      account: createToken('acc-2'),
      generation: 1,
      tableIncarnation: 1,
      releaseReservation,
    });
    leaseService.getSessionBinding = vi.fn().mockReturnValue({
      accountId: 'acc-1',
      generation: 1,
    });
    retryState.attemptedAccountIds.add('acc-1');

    await expect(policy.selectRetryToken(retryState, 'gemini-3-flash', 'session-1')).resolves.toBeNull();
    expect(leaseService.startSessionMigration).toBeUndefined();
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 408, 429, 499, 500, 502, 503, 504])(
    'keeps retry eligibility for upstream status %i',
    async (status) => {
      const { policy, accountLeaseService } = createPolicy();

      await expect(
        policy.applyUpstreamPenalty(
          'acc-1',
          'gemini-3-flash',
          new UpstreamRequestError({ status }),
        ),
      ).resolves.toBe(true);

      if (status === 401 || status === 403) {
        expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-1');
        expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
        return;
      }

      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
        expect.objectContaining({ accountIdOrEmail: 'acc-1', status }),
      );
    },
  );
});
