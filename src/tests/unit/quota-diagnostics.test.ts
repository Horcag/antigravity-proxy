import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CloudAccount, type CloudQuotaData } from '@/modules/cloud-account/types';
import {
  type AccountLeaseAccountStore,
  type AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/account-lease-adapters';
import {
  AccountLeaseQuotaRefreshPolicy,
  QUOTA_REFRESH_INTERVAL_MS,
} from '@/modules/proxy-gateway/server/account-lease-quota-refresh-policy';
import {
  AccountLeaseService,
  shuffleForQuotaDiagnostics,
} from '@/modules/proxy-gateway/server/account-lease.service';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/proxy-model-availability-store';
import { RateLimitReason } from '@/modules/proxy-gateway/server/rate-limit-tracker';

function quota(
  models: Record<string, number>,
  lastSuccessfulRefreshAt?: number,
): CloudQuotaData {
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, percentage]) => [
        modelId,
        { percentage, resetTime: '2030-01-01T00:00:00.000Z' },
      ]),
    ),
    ...(lastSuccessfulRefreshAt
      ? { last_successful_refresh_at: lastSuccessfulRefreshAt }
      : {}),
  };
}

function account(id: string, accountQuota: CloudQuotaData): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.test`,
    token: {
      access_token: `access-token-${id}`,
      refresh_token: `refresh-token-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: 4_000_000_000,
      project_id: `project-${id}`,
      session_id: `session-${id}`,
      upstream_proxy_url: `https://proxy.example/${id}`,
    },
    quota: accountQuota,
    created_at: 1,
    last_used: 1,
    status: 'active',
  };
}

function createStore(accounts: CloudAccount[]): AccountLeaseAccountStore {
  const store = {
    getAccounts: vi.fn().mockResolvedValue(accounts),
    getAccount: vi.fn(async (accountId: string) => accounts.find((item) => item.id === accountId)),
    updateToken: vi.fn(async () => undefined),
    updateTokenIfCurrent: vi.fn(() => true),
    updateQuota: vi.fn(async (accountId: string, refreshedQuota: CloudQuotaData) => {
      const target = accounts.find((item) => item.id === accountId);
      if (target) {
        target.quota = refreshedQuota;
      }
    }),
    updateQuotaIfCurrent: vi.fn(
      (accountId: string, refreshedQuota: CloudQuotaData, isCurrent: () => boolean) => {
        if (!isCurrent()) {
          return false;
        }
        void store.updateQuota(accountId, refreshedQuota);
        return true;
      },
    ),
    updateLastUsed: vi.fn(async () => undefined),
    updateLastUsedIfCurrent: vi.fn(() => true),
  } as AccountLeaseAccountStore;
  return store;
}

function createUpstream(fetchQuota: AccountLeaseUpstream['fetchQuota']): AccountLeaseUpstream {
  return {
    fetchQuota,
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn((currentToken, refreshedClientKey) =>
      refreshedClientKey ?? currentToken.oauth_client_key,
    ),
  };
}

function quotaRefreshPolicy(service: AccountLeaseService): AccountLeaseQuotaRefreshPolicy {
  return (service as unknown as { quotaRefreshPolicy: AccountLeaseQuotaRefreshPolicy })
    .quotaRefreshPolicy;
}

function expectNoStableAccountValues(serialized: string, values: string[]): void {
  for (const value of values) {
    expect(serialized).not.toContain(value);
    expect(serialized).not.toContain(Buffer.from(value).toString('base64'));
    expect(serialized).not.toContain(createHash('sha256').update(value).digest('hex'));
  }
}

function deterministicQuotaDiagnosticsRandom(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

afterEach(() => {
  for (const { accountId } of proxyModelAvailabilityStore.getSnapshot()) {
    proxyModelAvailabilityStore.clearAccount(accountId);
  }
});

describe('quota diagnostics', () => {
  it('persists a successful refresh timestamp and treats old snapshots as unknown after reload', async () => {
    const accounts = [account('acc-1', quota({ 'physical-flash': 12 }))];
    const service = new AccountLeaseService(
      createStore(accounts),
      createUpstream(vi.fn().mockResolvedValue(quota({ 'physical-flash': 80 }))),
    );
    await service.loadAccounts();

    await expect(
      quotaRefreshPolicy(service).refreshQuotaCatalog({ force: true, nowMs: 1_000_000 }),
    ).resolves.toMatchObject({ refreshed: 1, failed: 0 });
    expect(accounts[0].quota?.last_successful_refresh_at).toBe(1_000_000);

    const restarted = new AccountLeaseService(createStore(accounts), createUpstream(vi.fn()));
    await restarted.loadAccounts();
    expect(restarted.getQuotaDiagnostics(1_000_000).accounts[0]).toMatchObject({
      last_successful_refresh_at: '1970-01-01T00:16:40.000Z',
      refresh_state: 'fresh',
    });

    delete accounts[0].quota?.last_successful_refresh_at;
    const oldSnapshot = new AccountLeaseService(createStore(accounts), createUpstream(vi.fn()));
    await oldSnapshot.loadAccounts();
    expect(oldSnapshot.getQuotaDiagnostics(1_000_000).accounts[0]).toMatchObject({
      last_successful_refresh_at: null,
      refresh_age_seconds: null,
      refresh_state: 'unknown',
    });
  });

  it('keeps last-good timestamp and quota when a refresh fails or loses its generation', async () => {
    const accounts = [account('acc-1', quota({ 'physical-flash': 41 }, 10_000))];
    const store = createStore(accounts);
    const service = new AccountLeaseService(
      store,
      createUpstream(vi.fn().mockRejectedValue(new Error('quota endpoint down'))),
    );
    await service.loadAccounts();

    await expect(
      quotaRefreshPolicy(service).refreshQuotaCatalog({ force: true, nowMs: 20_000 }),
    ).resolves.toMatchObject({ refreshed: 0, failed: 1 });
    expect(accounts[0].quota).toMatchObject({
      last_successful_refresh_at: 10_000,
      models: { 'physical-flash': { percentage: 41 } },
    });

    vi.mocked(store.updateQuotaIfCurrent).mockReturnValue(false);
    const stale = new AccountLeaseService(
      store,
      createUpstream(vi.fn().mockResolvedValue(quota({ 'physical-flash': 99 }))),
    );
    await stale.loadAccounts();
    await expect(
      quotaRefreshPolicy(stale).refreshQuotaCatalog({ force: true, nowMs: 30_000 }),
    ).resolves.toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    expect(accounts[0].quota?.last_successful_refresh_at).toBe(10_000);
  });

  it('does not publish a timestamp when a reload invalidates an in-flight refresh', async () => {
    const accounts = [account('acc-1', quota({ 'physical-flash': 41 }, 10_000))];
    const store = createStore(accounts);
    let resolveQuota: ((value: CloudQuotaData) => void) | undefined;
    const service = new AccountLeaseService(
      store,
      createUpstream(
        vi.fn(
          () =>
            new Promise<CloudQuotaData>((resolve) => {
              resolveQuota = resolve;
            }),
        ),
      ),
    );
    await service.loadAccounts();

    const refresh = quotaRefreshPolicy(service).refreshQuotaCatalog({ force: true, nowMs: 20_000 });
    await Promise.resolve();
    await service.reloadAllAccounts();
    resolveQuota?.(quota({ 'physical-flash': 99 }));

    await expect(refresh).resolves.toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    expect(accounts[0].quota).toMatchObject({
      last_successful_refresh_at: 10_000,
      models: { 'physical-flash': { percentage: 41 } },
    });
    expect(store.updateQuotaIfCurrent).not.toHaveBeenCalled();
  });

  it('reports the refresh interval boundary as stale', async () => {
    const service = new AccountLeaseService(
      createStore([account('acc-1', quota({ 'physical-flash': 70 }, 1_000))]),
      createUpstream(vi.fn()),
    );
    await service.loadAccounts();

    expect(service.getQuotaDiagnostics(1_000 + QUOTA_REFRESH_INTERVAL_MS).accounts[0]).toMatchObject({
      refresh_age_seconds: QUOTA_REFRESH_INTERVAL_MS / 1000,
      refresh_state: 'stale',
    });
  });

  it('reports sanitized per-model availability, forwarding, conflicts, and expired block pruning', async () => {
    const now = Date.now();
    const accounts = [
      account('acc-1', {
        ...quota({ 'physical-flash': 25 }, now),
        model_forwarding_rules: { 'public-flash': 'physical-flash' },
      }),
      account('acc-2', quota({ 'physical-flash': 90 }, now)),
    ];
    accounts[1].status = 'rate_limited';
    const service = new AccountLeaseService(createStore(accounts), createUpstream(vi.fn()));
    await service.loadAccounts();
    service.markAsForbidden('acc-1');
    proxyModelAvailabilityStore.mark('acc-1', 'physical-flash', 'quota_exhausted', now + 30_000);
    proxyModelAvailabilityStore.mark('acc-2', 'expired-model', 'rate_limited', now - 1);

    const diagnostics = service.getQuotaDiagnostics(now);
    const first = diagnostics.accounts.find((entry) =>
      entry.models.some((model) => model.remaining_percentage === 25),
    );
    const second = diagnostics.accounts.find((entry) =>
      entry.models.some((model) => model.remaining_percentage === 90),
    );
    const forwarded = first?.models.find((entry) => entry.public_model_id === 'public-flash');

    expect(first).toMatchObject({
      status: 'active',
      account_cooldown: expect.objectContaining({ reason: 'forbidden' }),
    });
    expect(forwarded).toMatchObject({
      physical_model_id: 'physical-flash',
      remaining_percentage: 25,
      reset_time: '2030-01-01T00:00:00.000Z',
      availability: 'unavailable',
      requestable: false,
      temporary_block: expect.objectContaining({ reason: 'quota_exhausted' }),
    });
    expect(second?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestable: true })]),
    );
    expect(second?.status).toBe('rate_limited');
    expect(proxyModelAvailabilityStore.getSnapshot(now)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ modelId: 'expired-model' })]),
    );

    expectNoStableAccountValues(JSON.stringify(diagnostics), [
      ...accounts.flatMap((item) => [
        item.id,
        item.email,
        item.token.access_token,
        item.token.refresh_token,
        item.token.project_id ?? '',
      ]),
    ]);
  });

  it('keeps model lockouts separate from account-wide lockouts', async () => {
    const now = Date.now();
    const service = new AccountLeaseService(
      createStore([
        account('model-locked', quota({ 'physical-flash': 80 }, now)),
        account('account-locked', quota({ 'physical-flash': 80 }, now)),
      ]),
      createUpstream(vi.fn()),
    );
    await service.loadAccounts();
    const tracker = (service as unknown as { rateLimitTracker: any }).rateLimitTracker;
    tracker.trackFromUpstreamError({
      accountId: 'model-locked',
      status: 429,
      retryAfter: '30',
      body: 'rate limit exceeded',
      model: 'physical-flash',
      backoffSteps: [],
    });
    tracker.trackFromUpstreamError({
      accountId: 'account-locked',
      status: 500,
      retryAfter: '30',
      body: 'server error',
      model: 'physical-flash',
      backoffSteps: [],
    });
    tracker.setLockoutUntilIso(
      'account-locked',
      new Date(now - 1).toISOString(),
      RateLimitReason.ServerError,
      'expired-model',
    );

    const diagnostics = service.getQuotaDiagnostics(now);
    const modelLocked = diagnostics.accounts.find((entry) =>
      entry.models.some((model) => model.temporary_block?.reason === 'rate_limit_exceeded'),
    );
    const accountLocked = diagnostics.accounts.find(
      (entry) => entry.account_cooldown?.reason === 'server_error',
    );

    expect(modelLocked?.account_cooldown).toBeUndefined();
    expect(modelLocked?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          public_model_id: 'physical-flash',
          requestable: false,
          temporary_block: expect.objectContaining({ reason: 'rate_limit_exceeded' }),
        }),
      ]),
    );
    expect(accountLocked?.account_cooldown).toEqual(
      expect.objectContaining({ reason: 'server_error' }),
    );
    expect(accountLocked?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestable: false })]),
    );
    expect(tracker.getActiveLockouts(now)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ modelId: 'expired-model' })]),
    );
  });

  it('uses request-local randomized labels independent of source cache order', async () => {
    const accountLabels = (source: string[], random: () => number) =>
      new Map(
        shuffleForQuotaDiagnostics(source, random).map((accountId, index) => [
          accountId,
          `account-${index + 1}`,
        ]),
      );
    const sourceCacheOrder = ['acc-a', 'acc-b', 'acc-c'];
    const reversedCacheOrder = [...sourceCacheOrder].reverse();
    const orderedLabels = accountLabels(
      sourceCacheOrder,
      deterministicQuotaDiagnosticsRandom([0.4, 0.1]),
    );
    const reversedLabels = accountLabels(
      reversedCacheOrder,
      deterministicQuotaDiagnosticsRandom([0.9, 0.1]),
    );

    expect([...orderedLabels.keys()]).toEqual(['acc-c', 'acc-a', 'acc-b']);
    expect([...reversedLabels.keys()]).toEqual(['acc-b', 'acc-c', 'acc-a']);
    expect([...orderedLabels.keys()]).not.toEqual(sourceCacheOrder);
    expect([...reversedLabels.keys()]).not.toEqual(reversedCacheOrder);
    expect(orderedLabels).toEqual(
      new Map([
        ['acc-a', 'account-2'],
        ['acc-b', 'account-3'],
        ['acc-c', 'account-1'],
      ]),
    );
    expect(reversedLabels).toEqual(
      new Map([
        ['acc-a', 'account-3'],
        ['acc-b', 'account-1'],
        ['acc-c', 'account-2'],
      ]),
    );
  });

  it.each([
    ['one', 1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['negative', -0.1],
    ['out-of-range positive', 2],
  ])('falls back safely when an injected random source returns %s', (_name, sample) => {
    const repeated = { id: 'repeated' };
    const distinct = { id: 'distinct' };
    const input = [repeated, repeated, distinct, 'value'];
    const inputBefore = [...input];

    expect(() => shuffleForQuotaDiagnostics(input, () => sample)).not.toThrow();
    const shuffled = shuffleForQuotaDiagnostics(input, () => sample);

    expect(shuffled).toHaveLength(input.length);
    expect(shuffled.filter((entry) => entry === repeated)).toHaveLength(2);
    expect(shuffled.filter((entry) => entry === distinct)).toHaveLength(1);
    expect(shuffled.filter((entry) => entry === 'value')).toHaveLength(1);
    expect(input).toEqual(inputBefore);
  });

  it('handles empty and singleton input without consulting the injected source', () => {
    const random = vi.fn(() => {
      throw new Error('must not be called');
    });
    const singleton = { id: 'only' };

    expect(shuffleForQuotaDiagnostics([], random)).toEqual([]);
    expect(shuffleForQuotaDiagnostics([singleton], random)).toEqual([singleton]);
    expect(random).not.toHaveBeenCalled();
  });

  it('accepts valid boundary samples while preserving the input', () => {
    const input = ['first', 'second', 'third'];

    expect(
      shuffleForQuotaDiagnostics(
        input,
        deterministicQuotaDiagnosticsRandom([0, 1 - Number.EPSILON]),
      ),
    ).toEqual(['third', 'second', 'first']);
    expect(input).toEqual(['first', 'second', 'third']);
  });

  it('omits expired routing state without pruning diagnostics sources', async () => {
    const now = 1_000_000;
    const accounts = [account('observed', quota({ 'physical-flash': 55 }, now))];
    const store = createStore(accounts);
    const service = new AccountLeaseService(store, createUpstream(vi.fn()));
    await service.loadAccounts();
    const tracker = (service as unknown as { rateLimitTracker: any }).rateLimitTracker;
    const limitPolicy = (service as unknown as { limitPolicy: any }).limitPolicy;
    const availabilityEntries = (
      proxyModelAvailabilityStore as unknown as { entries: Map<string, unknown> }
    ).entries;

    proxyModelAvailabilityStore.mark('observed', 'expired-model', 'rate_limited', now - 1);
    tracker.setLockoutUntilIso(
      'observed',
      new Date(now - 1).toISOString(),
      RateLimitReason.RateLimitExceeded,
      'expired-lockout',
    );
    limitPolicy.getAccountCooldowns().set('observed', now - 1);
    limitPolicy.accountCooldownReasons.set('observed', 'rate_limited');
    const routingStateBefore = {
      availability: JSON.stringify([...availabilityEntries.entries()]),
      lockouts: JSON.stringify([...tracker.lockoutByKey.entries()]),
      cooldowns: JSON.stringify([...limitPolicy.getAccountCooldowns().entries()]),
      cooldownReasons: JSON.stringify([...limitPolicy.accountCooldownReasons.entries()]),
      tokens: JSON.stringify([
        ...(service as unknown as { tokens: Map<string, unknown> }).tokens.entries(),
      ]),
    };

    const diagnostics = service.getQuotaDiagnostics(now);

    expect(diagnostics.accounts[0]).not.toHaveProperty('account_cooldown');
    expect(JSON.stringify(diagnostics)).not.toContain('expired-model');
    expect(JSON.stringify(diagnostics)).not.toContain('expired-lockout');
    expect(JSON.stringify([...availabilityEntries.entries()])).toBe(routingStateBefore.availability);
    expect(JSON.stringify([...tracker.lockoutByKey.entries()])).toBe(routingStateBefore.lockouts);
    expect(JSON.stringify([...limitPolicy.getAccountCooldowns().entries()])).toBe(
      routingStateBefore.cooldowns,
    );
    expect(JSON.stringify([...limitPolicy.accountCooldownReasons.entries()])).toBe(
      routingStateBefore.cooldownReasons,
    );
    expect(
      JSON.stringify([...(service as unknown as { tokens: Map<string, unknown> }).tokens.entries()]),
    ).toBe(routingStateBefore.tokens);
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(store.updateQuota).not.toHaveBeenCalled();
    expect(store.updateLastUsed).not.toHaveBeenCalled();
  });
});
