import { DEFAULT_PROXY_CONFIG, ProxyConfigSchema, type ProxyConfig } from '../types';

function fileProxy(config: Record<string, unknown>): Record<string, unknown> {
  return config.proxy !== null && typeof config.proxy === 'object' && !Array.isArray(config.proxy)
    ? config.proxy as Record<string, unknown> : {};
}
/** Environment overrides affect effective configuration, without becoming persisted edits. */
export function effectiveProxyConfig(config: Record<string, unknown>): ProxyConfig {
  const proxy = fileProxy(config);
  return ProxyConfigSchema.parse({
    ...DEFAULT_PROXY_CONFIG,
    ...proxy,
    host: process.env.AG_PROXY_HOST ?? proxy.host,
    port: process.env.AG_PROXY_PORT ? Number(process.env.AG_PROXY_PORT) : proxy.port,
    api_key: process.env.AG_PROXY_API_KEY ?? proxy.api_key,
    admin_api_key: process.env.AG_PROXY_ADMIN_API_KEY ?? proxy.admin_api_key,
  });
}
export function transformProxyConfig(config: Record<string, unknown>, update: (current: ProxyConfig) => Partial<ProxyConfig>): Record<string, unknown> {
  const current = effectiveProxyConfig(config);
  const patch = update(current);
  ProxyConfigSchema.parse({ ...current, ...patch });
  return { ...config, proxy: { ...fileProxy(config), ...patch } };
}
