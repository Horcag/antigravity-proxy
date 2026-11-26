import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';

const scratch = process.env.AGENT_STORAGE_SCRATCH;
if (!scratch) throw new Error('Run the isolated browser fixture through agent-storage');
process.env.AG_PROXY_DATA_DIR = path.join(scratch, 'console-fixture');
fs.mkdirSync(process.env.AG_PROXY_DATA_DIR, { recursive: true, mode: 0o700 });
const load = (name) => import(new URL(`../../../dist/${name}.js`, import.meta.url));
const [{ CloudAccountRepo }, { ConfigManager }, { ProxyConfigSchema }, { setServerConfig }, history,
  { ConsoleController }, { ConsoleObservationController }, { ConsoleQuotaController }, sessions, { ConsoleAccountsService },
  { ConsoleConfigService }, { ConsoleOAuthService }, { ConsoleQuotaService }, { DashboardController }, { DashboardService },
  { AdminService }, { AdminGuard }, { AccountLeaseService }] = await Promise.all([
  load('modules/cloud-account/persistence/cloudHandler'), load('modules/config/ipc/manager'),
  load('modules/config/types'), load('server/server-config'), load('observability/request-history'),
  load('admin-console/console.controller'), load('admin-console/console-observation.controller'),
  load('admin-console/console-quota.controller'), load('admin-console/session.service'),
  load('admin-console/console-accounts.service'), load('admin-console/console-config.service'),
  load('admin-console/console-oauth.service'), load('admin-console/console-quota.service'),
  load('dashboard/dashboard.controller'), load('dashboard/dashboard.service'), load('admin/admin.service'),
  load('modules/proxy-gateway/server/guards/admin.guard'), load('modules/proxy-gateway/server/account-lease.service'),
]);
const proxy = ProxyConfigSchema.parse({ api_key: 'fixture-api', admin_api_key: 'fixture-admin',
  projects: [{ id: 'fixture-project', name: 'Тестовый проект', api_key: 'fixture-project-key', enabled: true }] });
await ConfigManager.saveConfig({ proxy });
setServerConfig(proxy);
for (const [id, name, status] of [['fixture-alice', 'Alice Fixture', 'active'], ['fixture-bob', 'Bob Fixture', 'expired']]) {
  await CloudAccountRepo.addAccount({ id, email: `${id}@example.test`, name, provider: 'google', status,
    status_reason: status === 'expired' ? 'TOS_VIOLATION' : undefined, created_at: 1, last_used: 1,
    token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer',
      expires_in: 3600, expiry_timestamp: 4_000_000_000 },
    quota: { models: { 'gemini-3.8-flash-high': { percentage: 80, resetTime: '2030-01-01T00:00:00.000Z' } } },
  });
}
history.configureRequestHistory(path.join(process.env.AG_PROXY_DATA_DIR, 'request-history.db'));
for (let index = 0; index < 12; index++) history.getRequestHistoryStore().record({ protocol: 'http',
  route: '/v1/chat/completions', model: 'gemini-3.8-flash-high', effective_model: 'gemini-3.8-flash-high',
  project_id: 'fixture-project', project_name: 'Тестовый проект', account_id: 'fixture-alice',
  status: index % 4 === 0 ? 502 : 200, duration_ms: 120 + index, input_tokens: 100, output_tokens: 20,
  attempts: [{ account_id: 'fixture-alice', outcome: index % 4 === 0 ? 'failure' : 'success' }] });
const leases = {
  loadAccounts: async () => (await CloudAccountRepo.getAccounts()).length,
  reloadAllAccounts: async () => (await CloudAccountRepo.getAccounts()).length,
  refreshQuotaCatalog: async () => ({ refreshed: true }),
  getRefreshedAllCollectedModels: async () => new Set(['gemini-3.8-flash-high', 'claude-sonnet-4-6']),
  getQuotaDiagnostics: () => ({ refresh_interval_seconds: 600, accounts: [{ account_label: 'account-1',
    status: 'active', refresh_state: 'fresh', last_successful_refresh_at: new Date().toISOString(),
    models: [{ public_model_id: 'gemini-3.8-flash-high', physical_model_id: 'gemini-3.8-flash-high',
      requestable: true, remaining_percentage: 80 }] }] }),
};
class PreviewModule {}
Module({ controllers: [ConsoleController, ConsoleObservationController, ConsoleQuotaController, sessions.ConsoleSessionController, DashboardController],
  providers: [sessions.ConsoleSessionService, sessions.ConsoleGuard, ConsoleAccountsService, ConsoleConfigService,
    ConsoleOAuthService, ConsoleQuotaService, DashboardService, AdminService, AdminGuard, { provide: AccountLeaseService, useValue: leases }] })(PreviewModule);
const app = await NestFactory.create(PreviewModule, new FastifyAdapter(), { logger: false });
await app.listen(0, '127.0.0.1');
const port = app.getHttpServer().address().port;
process.stdout.write(JSON.stringify({ preview: `http://127.0.0.1:${port}/dashboard`, key: 'fixture-admin', synthetic: true }) + '\n');
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close(); history.closeRequestHistory(); CloudAccountRepo.close();
};
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
