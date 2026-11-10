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
});
