import { ProxyConfig } from '@/modules/config/types';

let serverConfig: ProxyConfig | null = null;

export function setServerConfig(config: ProxyConfig | null) {
  serverConfig = config;
}

export function getServerConfig(): ProxyConfig | null {
  return serverConfig;
}
