import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleAccountsService } from '@/admin-console/console-accounts.service';
import { ConsoleConfigService } from '@/admin-console/console-config.service';
import { ConsoleOAuthService } from '@/admin-console/console-oauth.service';
import { ConsoleObservationController } from '@/admin-console/console-observation.controller';
import { ConsoleQuotaController } from '@/admin-console/console-quota.controller';
import { ConsoleQuotaService } from '@/admin-console/console-quota.service';
import { ConsoleController } from '@/admin-console/console.controller';
import { ConsoleGuard, ConsoleSessionController, ConsoleSessionService } from '@/admin-console/session.service';
import { AdminService } from '@/admin/admin.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { closeRequestHistory, configureRequestHistory, getRequestHistoryStore } from '@/observability/request-history';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';

const leases = {
  loadAccounts: vi.fn(),
  reloadAllAccounts: vi.fn(),
  refreshQuotaCatalog: vi.fn().mockResolvedValue({ refreshed: 1 }),
  getRefreshedAllCollectedModels: vi.fn().mockResolvedValue(new Set(['gemini-4-neon-high'])),
};

@Module({
  controllers: [ConsoleSessionController, ConsoleController, ConsoleObservationController, ConsoleQuotaController],
  providers: [
    ConsoleSessionService,
    ConsoleGuard,
    ConsoleAccountsService,
    ConsoleConfigService,
    ConsoleOAuthService,
    ConsoleQuotaService,
    AdminService,
    { provide: AccountLeaseService, useValue: leases },
  ],
})
class TestQuotaConsoleModule {}

describe('quota analytics & pricing console API integration', () => {
  let app: NestFastifyApplication;
  let fastify: FastifyInstance;
  let dir: string;
  let originalEnv: Record<string, string | undefined>;
  let originalConfig: ReturnType<typeof getServerConfig>;
  const origin = 'http://localhost:8317';
  const headers = { host: 'localhost:8317', origin };

  beforeEach(async () => {
    originalConfig = getServerConfig();
    originalEnv = { AG_PROXY_DATA_DIR: process.env.AG_PROXY_DATA_DIR, AG_PROXY_MASTER_KEY: process.env.AG_PROXY_MASTER_KEY };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-console-test-'));
    process.env.AG_PROXY_DATA_DIR = dir;
    process.env.AG_PROXY_MASTER_KEY = '34'.repeat(32);
    resetMasterKeyCacheForTesting();
    setServerConfig({
      ...DEFAULT_PROXY_CONFIG,
      port: 8317,
      api_key: 'inference-secret',
      admin_api_key: 'admin-secret',
      projects: [{ id: 'proj-1', name: 'Test Project', api_key: 'proj-secret', enabled: true }],
    });
    app = await NestFactory.create<NestFastifyApplication>(TestQuotaConsoleModule, new FastifyAdapter(), { logger: false });
    await ConfigManager.saveConfig({ proxy: getServerConfig()! });
    configureRequestHistory(path.join(dir, 'history.db'));
    await app.init();
    fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  });

  afterEach(async () => {
    await app?.close();
    closeRequestHistory();
    CloudAccountRepo.close();
    resetMasterKeyCacheForTesting();
    setServerConfig(originalConfig);
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function login() {
    const res = await fastify.inject({ method: 'POST', url: '/admin/session', headers, payload: { key: 'admin-secret', remember: false } });
    expect(res.statusCode).toBe(201);
    return { ...headers, cookie: String(res.headers['set-cookie']).split(';')[0], 'x-csrf-token': res.json().csrfToken as string };
  }

  it('enforces auth/CSRF/validation and returns analytics, pricing overrides, session filters, and clean exports', async () => {
    expect((await fastify.inject({ url: '/admin/console/quota-analytics', headers })).statusCode).toBe(401);
    const auth = await login();

    await fastify.inject({
      method: 'POST',
      url: '/admin/console/accounts/import',
      headers: auth,
      payload: { email: 'pro-user@example.test', refresh_token: 'secret-refresh-token', access_token: 'secret-access-token' },
    });
    const accountId = (await fastify.inject({ url: '/admin/console/accounts', headers: auth })).json()[0].id as string;

    const store = getRequestHistoryStore();
    const now = Date.now();
    store.quotaHistory.recordQuotaSnapshot(
      accountId,
      {
        subscription_tier: 'Google AI Pro',
        models: {},
        quota_groups: [
          {
            display_name: 'Gemini Models',
            buckets: [{ bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: new Date(now + 5 * 86_400_000).toISOString() }],
          },
        ],
      },
      now - 3600_000,
    );
    store.record({
      time: new Date(now - 1800_000).toISOString(),
      protocol: 'http',
      route: '/v1/messages',
      model: 'claude-opus-5-5',
      effective_model: 'claude-opus-5-5-high',
      project_id: 'proj-1',
      project_name: 'Test Project',
      account_id: accountId,
      session_key: 'session:chat-42',
      status: 200,
      duration_ms: 400,
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_tokens: 500_000,
      cache_write_tokens: 0,
      usage_schema: 'anthropic',
    });

    const analytics = await fastify.inject({ url: '/admin/console/quota-analytics?preset=7d&pool=all&window=weekly', headers: auth });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.body).not.toMatch(/secret-refresh-token|secret-access-token|admin-secret|proj-secret/);
    const json = analytics.json();
    expect(json.summary.api_usd).toBeCloseTo(6.1, 4);
    expect(json.sessions[0]).toMatchObject({ session_key: 'session:chat-42', requests: 1 });

    // Session filter on requests endpoint
    const reqs = await fastify.inject({ url: '/admin/console/requests?sessionKey=session:chat-42', headers: auth });
    expect(reqs.statusCode).toBe(200);
    expect(reqs.json().total).toBe(1);

    // Negative controls: bad query & missing CSRF on PUT
    expect((await fastify.inject({ url: '/admin/console/quota-analytics?preset=century', headers: auth })).statusCode).toBe(400);
    expect((await fastify.inject({
      method: 'PUT',
      url: '/admin/console/quota-pricing',
      headers: { ...auth, 'x-csrf-token': '' },
      payload: { api_multiplier: 0.5, tier_monthly_usd: {}, account_monthly_usd: {}, model_overrides: {} },
    })).statusCode).toBe(403);

    // Valid pricing update halves USD
    const putPricing = await fastify.inject({
      method: 'PUT',
      url: '/admin/console/quota-pricing',
      headers: auth,
      payload: { api_multiplier: 0.5, tier_monthly_usd: { 'Google AI Pro': 30 }, account_monthly_usd: {}, model_overrides: {} },
    });
    expect(putPricing.statusCode).toBe(200);
    const updated = (await fastify.inject({ url: '/admin/console/quota-analytics?preset=7d', headers: auth })).json();
    expect(updated.summary.api_usd).toBeCloseTo(3.05, 4);
    expect(updated.summary.subscription_monthly_usd).toBe(30);

    // CSV & JSON exports
    const csvRes = await fastify.inject({ url: '/admin/console/quota-analytics/export?preset=7d&format=csv', headers: auth });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('claude-opus-5-5-high');
  });
});
