import { z } from 'zod';

export const UpstreamProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
});

export const ProxyExperimentalConfigSchema = z.object({
  enable_cloud_code_meta: z.boolean().default(false),
});

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8045),
  api_key: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  admin_api_key: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  auto_start: z.boolean().default(true),
  backend_canary_enabled: z.boolean().default(true),
  parity_enabled: z.boolean().default(true),
  parity_shadow_enabled: z.boolean().default(false),
  parity_kill_switch: z.boolean().default(false),
  parity_no_go_mismatch_rate: z.number().min(0).max(1).default(0.15),
  parity_no_go_error_rate: z.number().min(0).max(1).default(0.4),
  scheduling_mode: z.enum(['cache-first', 'balance', 'performance-first']).default('cache-first'),
  max_concurrency_per_account: z.number().int().positive().default(8),
  max_wait_seconds: z.number().nonnegative().default(2),
  preferred_account_id: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  circuit_breaker_enabled: z.boolean().default(true),
  circuit_breaker_backoff_steps: z.array(z.number().positive()).default([60, 300, 1800, 7200]),
  custom_mapping: z.record(z.string(), z.string()).nullable().optional().transform((val) => val ?? {}).default({}),
  anthropic_mapping: z.record(z.string(), z.string()).nullable().optional().transform((val) => val ?? {}).default({}),
  request_timeout: z.number().positive().default(120),
  upstream_proxy: UpstreamProxyConfigSchema.default({ enabled: false, url: '' }),
  experimental: ProxyExperimentalConfigSchema.default({ enable_cloud_code_meta: false }),
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export const DEFAULT_PROXY_CONFIG: ProxyConfig = ProxyConfigSchema.parse({});

export interface AppConfig {
  proxy: ProxyConfig;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  proxy: DEFAULT_PROXY_CONFIG,
};
