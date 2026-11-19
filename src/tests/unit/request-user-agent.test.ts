import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: { get } }));
vi.mock('../../shared/logging/logger', () => ({ logger: { info: vi.fn() } }));

async function loadResolver() {
  return await import('../../modules/proxy-gateway/server/request-user-agent');
}

beforeEach(() => {
  vi.resetModules();
  get.mockReset();
  get.mockRejectedValue(new Error('Version discovery unavailable'));
  vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', '');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITEST', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('request User-Agent version resolution', () => {
  it.each(['1.2.3', '2.29.0', '99.0.0'])('pins %s exactly without remote discovery', async (version) => {
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', ` ${version} `);
    get.mockResolvedValue({ data: '999.0.0' });
    const resolver = await loadResolver();
    expect(resolver.resolveLocalInstalledVersion()).toBe(version);
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent(version));
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['v1.2.3', 'client/1.2.3', '1.2.3 4.5.6', '1.2', '1.2.3-beta', '1.2.3.4', '01.2.3'])('rejects malformed pin %s without discovery', async (version) => {
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', version);
    const resolver = await loadResolver();
    expect(() => resolver.resolveLocalInstalledVersion()).toThrow('exact major.minor.patch');
    await expect(resolver.resolveRequestUserAgent()).rejects.toThrow('exact major.minor.patch');
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['NODE_ENV', 'VITEST'])('uses the fallback without network under %s test policy', async (flag) => {
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', '  ');
    vi.stubEnv(flag, flag === 'NODE_ENV' ? 'test' : 'true');
    const resolver = await loadResolver();
    expect(resolver.resolveLocalInstalledVersion()).toBeNull();
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent(resolver.FALLBACK_VERSION));
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves highest-version extraction for unconfigured remote discovery', async () => {
    get.mockResolvedValueOnce({ data: 'old 1.2.3; current 99.0.0' });
    const resolver = await loadResolver();
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent('99.0.0'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('preserves fallback when a remote version is older', async () => {
    get.mockResolvedValueOnce({ data: '1.2.3' });
    const resolver = await loadResolver();
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent(resolver.FALLBACK_VERSION));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('uses changelog discovery after an unavailable updater', async () => {
    get.mockRejectedValueOnce(new Error('Updater unavailable')).mockResolvedValueOnce({ data: 'Release 99.0.0' });
    const resolver = await loadResolver();
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent('99.0.0'));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('uses the fallback when both discovery sources fail', async () => {
    const resolver = await loadResolver();
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent(resolver.FALLBACK_VERSION));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent discovery and caches the resolved version for the process', async () => {
    let finishDiscovery!: (value: { data: string }) => void;
    get.mockImplementationOnce(() => new Promise<{ data: string }>((resolve) => { finishDiscovery = resolve; }));
    const resolver = await loadResolver();
    const first = resolver.resolveRequestUserAgent();
    const second = resolver.resolveRequestUserAgent();
    expect(get).toHaveBeenCalledTimes(1);
    finishDiscovery({ data: '99.0.0' });
    expect(await Promise.all([first, second])).toEqual([resolver.buildUserAgent('99.0.0'), resolver.buildUserAgent('99.0.0')]);
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', '1.2.3');
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent('99.0.0'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected malformed pin', async () => {
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', 'not-a-version');
    const resolver = await loadResolver();
    await expect(resolver.resolveRequestUserAgent()).rejects.toThrow('exact major.minor.patch');
    vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', '1.2.3');
    expect(await resolver.resolveRequestUserAgent()).toBe(resolver.buildUserAgent('1.2.3'));
    expect(get).not.toHaveBeenCalled();
  });

  it('formats hub User-Agent required for Argon, Hydrogen, and quota group discovery', async () => {
    const resolver = await loadResolver();
    expect(resolver.FALLBACK_VERSION).toBe('2.33.0');
    expect(resolver.buildUserAgent('2.33.0')).toMatch(
      /^antigravity\/hub\/2\.33\.0 \(aidev_client; os_type=(linux|windows|darwin); arch=(amd64|arm64|[a-z0-9]+)\)$/,
    );
  });

  it('advances resolveEffectiveUpstreamVersion from observed client User-Agent while respecting explicit env pins', async () => {
    const resolver = await loadResolver();
    resolver.resetObservedClientUserAgentForTesting();
    try {
      expect(resolver.resolveEffectiveUpstreamVersion()).toBe(resolver.FALLBACK_VERSION);
      resolver.observeClientUserAgent('antigravity/hub/2.34.0 (aidev_client; os_type=windows; arch=amd64)');
      expect(resolver.resolveEffectiveUpstreamVersion()).toBe('2.34.0');
      vi.stubEnv('AG_PROXY_UPSTREAM_VERSION', '1.2.3');
      expect(resolver.resolveEffectiveUpstreamVersion()).toBe('1.2.3');
    } finally {
      resolver.resetObservedClientUserAgentForTesting();
    }
  });
});

describe('Argon / Hydrogen routing isolation and quota group floors', () => {
  it('routes Argon and Hydrogen only to capable accounts and ignores gemini-4-hydrogen-sonar for chat tiers', async () => {
    const { AccountLeaseModelPolicy } = await import('../../modules/proxy-gateway/server/account-lease-model-policy');
    const { isNonChatCatalogModelId } = await import('../../modules/proxy-gateway/antigravity/ModelMapping');

    expect(isNonChatCatalogModelId('gemini-4-hydrogen-sonar')).toBe(true);

    const tokenCache = new Map<string, any>([
      [
        'pro-account',
        {
          account_id: 'pro-account',
          email: 'inetiki422@gmail.com',
          access_token: 'tok-pro',
          refresh_token: 'ref-pro',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: 9999999999,
          model_quotas: {
            'gemini-4-argon-low': 70,
            'gemini-4-argon-medium': 70,
            'gemini-4-argon-high': 70,
            'gemini-4-hydrogen-low': 94,
            'gemini-4-hydrogen-medium': 94,
            'gemini-4-hydrogen-high': 94,
            'gemini-4-hydrogen-xhigh': 94,
            'gemini-4-hydrogen-tiered-high': 94,
            'gemini-4-hydrogen-tiered-xhigh': 94,
            'gemini-4-hydrogen-sonar': 94,
          },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
      [
        'free-account',
        {
          account_id: 'free-account',
          email: 'free@gmail.com',
          access_token: 'tok-free',
          refresh_token: 'ref-free',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: 9999999999,
          model_quotas: {
            'gemini-3.8-flash-high': 100,
            'gemini-3.8-flash-medium': 100,
            'gemini-4-hydrogen-sonar': 100,
          },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const policy = new AccountLeaseModelPolicy({
      getTokenCache: () => tokenCache,
      logger: { log: vi.fn() },
    });

    expect(policy.isModelRequestableForAccount('pro-account', 'gemini-4-argon-medium')).toBe(true);
    expect(policy.isModelRequestableForAccount('pro-account', 'gemini-4-hydrogen-medium')).toBe(true);
    expect(policy.isModelRequestableForAccount('pro-account', 'gemini-4-hydrogen-xhigh')).toBe(true);

    expect(policy.isModelRequestableForAccount('free-account', 'gemini-4-argon-medium')).toBe(false);
    expect(policy.isModelRequestableForAccount('free-account', 'gemini-4-hydrogen-medium')).toBe(false);
    expect(policy.isModelRequestableForAccount('free-account', 'gemini-4-hydrogen-high')).toBe(false);
  });

  it('applies 5h and weekly quota_groups floor to Gemini, Argon, and Claude/GPT models', async () => {
    const { buildAccountLeaseQuotaSnapshot } = await import('../../modules/proxy-gateway/server/account-lease-quota-policy');
    const snapshot = buildAccountLeaseQuotaSnapshot({
      models: {
        'gemini-4-hydrogen-medium': { percentage: 94, resetTime: '2026-11-18T08:40:53Z' },
        'gemini-4-argon-medium': { percentage: 70, resetTime: '2026-11-23T16:40:10Z' },
        'claude-opus-5-5-high': { percentage: 100, resetTime: '2026-11-18T09:00:00Z' },
      },
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.94, reset_time: '2026-11-18T08:40:53Z' },
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.40, reset_time: '2026-11-20T05:13:20Z' },
          ],
        },
        {
          display_name: 'Gemini 4 Argon',
          buckets: [
            { bucket_id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-11-23T16:40:10Z' },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 0.80, reset_time: '2026-11-18T09:15:36Z' },
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 0.50, reset_time: '2026-11-25T04:15:36Z' },
          ],
        },
      ],
    });

    expect(snapshot.modelQuotas['gemini-4-hydrogen-medium']).toBe(40);
    expect(snapshot.modelResetTimes['gemini-4-hydrogen-medium']).toBe('2026-11-20T05:13:20Z');
    expect(snapshot.modelQuotas['gemini-4-argon-medium']).toBe(25);
    expect(snapshot.modelQuotas['claude-opus-5-5-high']).toBe(50);
  });
});
