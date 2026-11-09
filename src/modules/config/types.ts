import { z } from 'zod';

export const UpstreamProxyConfigSchema = z.object({
  enabled: z.boolean().nullable().optional().transform((val) => val ?? false).default(false),
  url: z.string().nullable().optional().transform((val) => val ?? '').default(''),
});

export const ProxyExperimentalConfigSchema = z.object({
  enable_cloud_code_meta: z.boolean().nullable().optional().transform((val) => val ?? false).default(false),
});

export const ProxyApiProjectSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  api_key: z.string().min(1).refine((value) => value.trim() === value && value.trim().length > 0, 'Project API key must not contain surrounding whitespace'),
  enabled: z.boolean().default(true),
  model_mapping: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type ProxyApiProject = z.infer<typeof ProxyApiProjectSchema>;

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().nullable().optional().transform((val) => val ?? true).default(true),
  host: z.string().nullable().optional().transform((val) => val ?? '127.0.0.1').default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).nullable().optional().transform((val) => val ?? 8045).default(8045),
  api_key: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  admin_api_key: z.string().nullable().optional().transform((val) => val ?? '').default(''),
  projects: z.array(ProxyApiProjectSchema).optional(),
  compatibility_ports: z.array(z.number().int().min(1).max(65535)).max(8).optional(),
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
}).superRefine((config, context) => {
  if (config.compatibility_ports?.some((port, index, ports) => port === config.port || ports.indexOf(port) !== index)) {
    context.addIssue({ code: 'custom', path: ['compatibility_ports'], message: 'Compatibility ports must be unique and different from the primary port' });
  }
  const ids = new Set<string>();
  const keys = new Set([config.api_key, config.admin_api_key].filter(Boolean));
  for (const [index, project] of (config.projects ?? []).entries()) {
    if (ids.has(project.id)) {
      context.addIssue({ code: 'custom', path: ['projects', index, 'id'], message: 'Project IDs must be unique' });
    }
    if (keys.has(project.api_key)) {
      context.addIssue({ code: 'custom', path: ['projects', index, 'api_key'], message: 'Project API keys must be unique and separate from proxy and admin keys' });
    }
    ids.add(project.id);
    keys.add(project.api_key);
  }
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export const DEFAULT_PROXY_CONFIG: ProxyConfig = ProxyConfigSchema.parse({});

export interface AppConfig {
  proxy: ProxyConfig;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  proxy: DEFAULT_PROXY_CONFIG,
};
