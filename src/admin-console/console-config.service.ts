import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ConfigManager, ConfigPersistenceError } from '@/modules/config/ipc/manager';
import { type ProxyConfig } from '@/modules/config/types';
import { QuotaPricingConfigSchema } from '@/observability/quota-analytics-types';
import { BUILTIN_MODEL_RATES, DEFAULT_TIER_MONTHLY_USD, normalizePricingConfig } from '@/observability/pricing-catalog';
import { getServerConfig, setServerConfig } from '@/server/server-config';

const mapping = z.record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(200));
const settings = z.object({
  scheduling_mode: z.enum(['cache-first', 'balance', 'performance-first']).optional(),
  max_wait_seconds: z.number().min(0).max(300).optional(),
  max_concurrency_per_account: z.number().int().min(1).max(128).optional(),
  request_timeout: z.number().min(1).max(3600).optional(),
  custom_mapping: mapping.optional(), anthropic_mapping: mapping.optional(),
}).strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('Invalid console configuration payload');
  return result.data;
}
@Injectable()
export class ConsoleConfigService {
  // Serialize console writes so simultaneous settings/project requests do not lose each other.
  private pending: Promise<unknown> = Promise.resolve();
  current(): ProxyConfig { return getServerConfig() ?? ConfigManager.loadConfig().proxy; }
  getSettings() {
    const c = this.current();
    return { scheduling_mode: c.scheduling_mode, max_wait_seconds: c.max_wait_seconds,
      max_concurrency_per_account: c.max_concurrency_per_account, request_timeout: c.request_timeout,
      custom_mapping: c.custom_mapping, anthropic_mapping: c.anthropic_mapping };
  }
  getQuotaPricing() {
    const c = this.current();
    return {
      config: normalizePricingConfig(c.quota_pricing),
      defaults: {
        tier_monthly_usd: DEFAULT_TIER_MONTHLY_USD,
        models: BUILTIN_MODEL_RATES,
      },
    };
  }
  async updateQuotaPricing(body: unknown) {
    const next = parse(QuotaPricingConfigSchema, body);
    await this.update(() => ({ quota_pricing: next }));
    return this.getQuotaPricing();
  }
  private update(change: (current: ProxyConfig) => Partial<ProxyConfig>): Promise<void> {
    const operation = this.pending.catch(() => {}).then(async () => {
      try { await ConfigManager.updateProxyConfig(change); }
      catch (error) {
        if (error instanceof ConfigPersistenceError && error.committed) setServerConfig(ConfigManager.loadConfig().proxy);
        throw error;
      }
      setServerConfig(ConfigManager.loadConfig().proxy);
    });
    this.pending = operation;
    return operation;
  }
  async patchSettings(body: unknown) {
    const patch = parse(settings, body);
    await this.update(() => patch);
    return this.getSettings();
  }
  listProjects() {
    return (this.current().projects ?? []).map(({ api_key: _key, ...project }) => project);
  }
  async createProject(body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(100), model_mapping: mapping.optional() }).strict(), body);
    const project = { id: randomUUID(), ...input, enabled: true, api_key: `agp_${randomBytes(32).toString('base64url')}` };
    await this.update((current) => ({ projects: [...(current.projects ?? []), project] }));
    return project;
  }
  async patchProject(id: string, body: unknown, rotate = false) {
    const patch = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional(), model_mapping: mapping.optional() }).strict(), body);
    let replacementKey: string | undefined;
    await this.update((current) => {
      if (!(current.projects ?? []).some((p) => p.id === id)) throw new NotFoundException('Project not found');
      replacementKey = rotate ? `agp_${randomBytes(32).toString('base64url')}` : undefined;
      return { projects: current.projects!.map((p) => p.id === id ? { ...p, ...patch, ...(replacementKey ? { api_key: replacementKey } : {}) } : p) };
    });
    return { ...this.listProjects().find((p) => p.id === id), ...(replacementKey ? { api_key: replacementKey } : {}) };
  }
  async deleteProject(id: string) {
    await this.update((current) => {
      if (!(current.projects ?? []).some((p) => p.id === id)) throw new NotFoundException('Project not found');
      return { projects: current.projects!.filter((p) => p.id !== id) };
    });
    return { removed: true };
  }
}
