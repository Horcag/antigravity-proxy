import fs from 'node:fs';
import { AppConfig, DEFAULT_PROXY_CONFIG, ProxyConfigSchema } from '@/modules/config/types';
import { getConfigPath } from '@/shared/paths';

interface PartialProxyConfig {
  host?: string;
  port?: number;
  api_key?: string;
  admin_api_key?: string;
}

export class ConfigManager {
  static loadConfig(): AppConfig {
    const configPath = getConfigPath();
    const fromFile = fs.existsSync(configPath)
      ? (JSON.parse(fs.readFileSync(configPath, 'utf8')) as { proxy?: PartialProxyConfig })
      : {};
    const fileProxy = fromFile.proxy ?? {};
    const proxy = ProxyConfigSchema.parse({
      ...DEFAULT_PROXY_CONFIG,
      ...fileProxy,
      host: process.env.AG_PROXY_HOST ?? fileProxy.host,
      port: process.env.AG_PROXY_PORT ? Number(process.env.AG_PROXY_PORT) : fileProxy.port,
      api_key: process.env.AG_PROXY_API_KEY ?? fileProxy.api_key,
      admin_api_key: process.env.AG_PROXY_ADMIN_API_KEY ?? fileProxy.admin_api_key,
    });
    return { proxy };
  }

  static saveConfig(config: AppConfig): void {
    const validated = { proxy: ProxyConfigSchema.parse(config.proxy) };
    fs.writeFileSync(getConfigPath(), `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
