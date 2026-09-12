import { z } from 'zod';

export const UpstreamProxyConfigSchema = z.object({
  enabled: z.boolean().nullable().optional().transform((val) => val ?? false).default(false),
  url: z.string().nullable().optional().transform((val) => val ?? '').default(''),
});

export const ProxyExperimentalConfigSchema = z.object({
  enable_cloud_code_meta: z.boolean().nullable().optional().transform((val) => val ?? false).default(false),
});

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().nullable().optional().transform((val) => val ?? true).default(true),
  host: z.string().nullable().optional().transform((val) => val ?? '127.0.0.1').default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).nullable().optional().transform((val) => val ?? 8045).default(8045),
  api_key: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  admin_api_key: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  auto_start: z.boolean().nullable().optional().transform((val) => val ?? true).default(true),
  backend_canary_enabled: z.boolean().nullable().optional().transform((val) => val ?? true).default(true),
  parity_enabled: z.boolean().nullable().optional().transform((val) => val ?? true).default(true),
  parity_shadow_enabled: z.boolean().nullable().optional().transform((val) => val ?? false).default(false),
  parity_kill_switch: z.boolean().nullable().optional().transform((val) => val ?? false).default(false),
  parity_no_go_mismatch_rate: z.number().min(0).max(1).nullable().optional().transform((val) => val ?? 0.15).default(0.15),
  parity_no_go_error_rate: z.number().min(0).max(1).nullable().optional().transform((val) => val ?? 0.4).default(0.4),
  scheduling_mode: z.enum(['cache-first', 'balance', 'performance-first']).nullable().optional().transform((val) => val ?? 'cache-first').default('cache-first'),
  max_concurrency_per_account: z.number().int().positive().nullable().optional().transform((val) => val ?? 8).default(8),
  max_wait_seconds: z.number().nonnegative().nullable().optional().transform((val) => val ?? 2).default(2),
  preferred_account_id: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  circuit_breaker_enabled: z.boolean().nullable().optional().transform((val) => val ?? true).default(true),
  circuit_breaker_backoff_steps: z.array(z.number().positive()).nullable().optional().transform((val) => val ?? [60, 300, 1800, 7200]).default([60, 300, 1800, 7200]),
  custom_mapping: z.record(z.string(), z.string()).nullable().optional().transform((val) => val ?? {}).default({}),
  anthropic_mapping: z.record(z.string(), z.string()).nullable().optional().transform((val) => val ?? {}).default({}),
  request_timeout: z.number().positive().nullable().optional().transform((val) => val ?? 120).default(120),
  upstream_proxy: UpstreamProxyConfigSchema.nullable().optional().transform((val) => val ?? { enabled: false, url: '' }).default({ enabled: false, url: '' }),
  experimental: ProxyExperimentalConfigSchema.nullable().optional().transform((val) => val ?? { enable_cloud_code_meta: false }).default({ enable_cloud_code_meta: false }),
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export const DEFAULT_PROXY_CONFIG: ProxyConfig = ProxyConfigSchema.parse({});

export interface AppConfig {
  proxy: ProxyConfig;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  proxy: DEFAULT_PROXY_CONFIG,
};
