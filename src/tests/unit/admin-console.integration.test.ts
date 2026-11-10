import { ConsoleOAuthService } from '@/admin-console/console-oauth.service';
import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSessionController, ConsoleSessionService, ConsoleGuard } from '@/admin-console/session.service';
import { ConsoleObservationController } from '@/admin-console/console-observation.controller';
import { closeRequestHistory, configureRequestHistory, getRequestHistoryStore } from '@/observability/request-history';
import { ConsoleController } from '@/admin-console/console.controller';
import { ConsoleAccountsService } from '@/admin-console/console-accounts.service';
import { ConsoleConfigService } from '@/admin-console/console-config.service';
import { AdminService } from '@/admin/admin.service';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';
import { ConfigManager } from '@/modules/config/ipc/manager';
const leases = { loadAccounts: vi.fn(), reloadAllAccounts: vi.fn(), refreshQuotaCatalog: vi.fn().mockResolvedValue({ refreshed: 1 }), getRefreshedAllCollectedModels: vi.fn().mockResolvedValue(new Set(['model-a'])) };
@Module({ controllers: [ConsoleSessionController, ConsoleController, ConsoleObservationController], providers: [ConsoleSessionService, ConsoleGuard, ConsoleAccountsService, ConsoleConfigService, ConsoleOAuthService, AdminService, { provide: AccountLeaseService, useValue: leases }] })
class TestConsoleModule {}

describe('console session and real temporary store management', () => {
  let app: NestFastifyApplication;
  let fastify: FastifyInstance;
  let dir: string;
  let originalEnv: Record<string, string | undefined>;
  let originalConfig: ReturnType<typeof getServerConfig>;
  const origin = 'http://localhost:8317';
  const headers = { host: 'localhost:8317', origin };
  const bearer = { ...headers, authorization: 'Bearer admin-fixture' };
  beforeEach(async () => {
    originalConfig = getServerConfig();
    originalEnv = { AG_PROXY_DATA_DIR: process.env.AG_PROXY_DATA_DIR, AG_PROXY_MASTER_KEY: process.env.AG_PROXY_MASTER_KEY };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-test-'));
    process.env.AG_PROXY_DATA_DIR = dir;
    process.env.AG_PROXY_MASTER_KEY = '12'.repeat(32);
    resetMasterKeyCacheForTesting();
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, port: 8317, compatibility_ports: [8045], api_key: 'inference-fixture', admin_api_key: 'admin-fixture', projects: [{ id: 'existing', name: 'Existing', api_key: 'existing-project-key', enabled: true }] });
    app = await NestFactory.create<NestFastifyApplication>(TestConsoleModule, new FastifyAdapter(), { logger: false });
    await ConfigManager.saveConfig({ proxy: getServerConfig()! });
    configureRequestHistory(path.join(dir, 'history.db'));
    await app.init(); fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  });
  afterEach(async () => {
    await app?.close(); closeRequestHistory(); CloudAccountRepo.close(); resetMasterKeyCacheForTesting(); setServerConfig(originalConfig);
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
  async function login(remember = true) {
    const response = await fastify.inject({ method: 'POST', url: '/admin/session', headers, payload: { key: 'admin-fixture', remember } });
    expect(response.statusCode).toBe(201);
    return { ...headers, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
  }
  it('enforces login origin, signed cookies, CSRF, logout and key rotation independently of Bearer', async () => {
    expect((await fastify.inject({ method: 'POST', url: '/admin/session', headers: { ...headers, origin: 'https://evil.test' }, payload: { key: 'admin-fixture' } })).statusCode).toBe(403);
    expect((await fastify.inject({ method: 'POST', url: '/admin/session', headers, payload: { key: 'inference-fixture' } })).statusCode).toBe(401);
    const auth = await login();
    const status = await fastify.inject({ url: '/admin/session', headers: auth });
    expect(status.json()).toEqual({ loggedIn: true, csrfToken: auth['x-csrf-token'] });
    expect(status.body).not.toContain('admin-fixture');
    expect((await fastify.inject({ url: '/admin/console/settings', headers: { ...auth, cookie: `${auth.cookie}x` } })).statusCode).toBe(401);
    for (const invalid of [{ ...auth, 'x-csrf-token': '' }, { ...auth, origin: 'https://evil.test' }]) {
      expect((await fastify.inject({ method: 'PATCH', url: '/admin/console/settings', headers: invalid, payload: { max_wait_seconds: 3 } })).statusCode).toBe(403);
    }
    expect((await fastify.inject({ method: 'PATCH', url: '/admin/console/settings', headers: bearer, payload: { max_wait_seconds: 3 } })).statusCode).toBe(200);
    expect((await fastify.inject({ method: 'DELETE', url: '/admin/session', headers: auth })).headers['set-cookie']).toContain('Max-Age=0');
    setServerConfig({ ...getServerConfig()!, admin_api_key: 'rotated' });
    expect((await fastify.inject({ url: '/admin/console/settings', headers: auth })).statusCode).toBe(401);
  });
  it('persists supported settings and project keys while preserving existing ports and credentials', async () => {
    const auth = await login();
    expect((await fastify.inject({ method: 'PATCH', url: '/admin/console/settings', headers: auth, payload: { port: 9999 } })).statusCode).toBe(400);
    expect((await fastify.inject({ method: 'PATCH', url: '/admin/console/settings', headers: auth, payload: { scheduling_mode: 'balance', request_timeout: 180 } })).statusCode).toBe(200);
    const created = await fastify.inject({ method: 'POST', url: '/admin/console/projects', headers: auth, payload: { name: 'New' } });
    expect(created.statusCode).toBe(201);
    const project = created.json(); expect(project.api_key).toMatch(/^agp_/);
    const listed = await fastify.inject({ url: '/admin/console/projects', headers: auth });
    expect(listed.body).not.toContain(project.api_key); expect(listed.body).not.toContain('existing-project-key');
    const saved = ConfigManager.loadConfig().proxy;
    expect(saved).toMatchObject({ port: 8317, compatibility_ports: [8045], api_key: 'inference-fixture', scheduling_mode: 'balance', request_timeout: 180 });
    expect(saved.projects?.find((p) => p.id === 'existing')?.api_key).toBe('existing-project-key');
    const rotated = await fastify.inject({ method: 'POST', url: `/admin/console/projects/${project.id}/rotate`, headers: auth });
    expect(rotated.json().api_key).not.toBe(project.api_key);
    expect((await fastify.inject({ method: 'PATCH', url: `/admin/console/projects/${project.id}`, headers: auth, payload: { enabled: false } })).json().enabled).toBe(false);
  });
  it('validates complete import, protects known TOS records, and persists disable/enable with real reload', async () => {
    const auth = await login();
    const cpa = { type: 'antigravity', email: 'fixture@example.test', refresh_token: 'secret-refresh', access_token: 'secret-access' };
    const imported = await fastify.inject({ method: 'POST', url: '/admin/console/accounts/import', headers: auth, payload: cpa });
    expect(imported.statusCode).toBe(201); expect(imported.body).not.toContain('secret-refresh');
    const id = imported.json().accounts[0].id;
    await CloudAccountRepo.updateStatus(id, 'expired', 'GCP_TOS_VIOLATION');
    expect((await fastify.inject({ method: 'POST', url: '/admin/console/accounts/import', headers: auth, payload: cpa })).statusCode).toBe(201);
    expect((await CloudAccountRepo.getAccount(id))?.status_reason).toBe('GCP_TOS_VIOLATION');
    expect((await fastify.inject({ method: 'PATCH', url: `/admin/console/accounts/${id}`, headers: auth, payload: { disabled: false } })).statusCode).toBe(409);
    expect((await fastify.inject({ method: 'PATCH', url: `/admin/console/accounts/${id}`, headers: auth, payload: { disabled: false, confirmReview: true } })).statusCode).toBe(200);
    expect((await CloudAccountRepo.getAccount(id))?.status).toBe('active');
    const exported = await new AdminService(leases as unknown as AccountLeaseService).exportAccounts(true);
    exported.accounts.push({ ...exported.accounts[0], email: 'bad@example.test', token: { ...exported.accounts[0].token!, refresh_token: '' } });
    expect((await fastify.inject({ method: 'POST', url: '/admin/console/accounts/import', headers: auth, payload: exported })).statusCode).toBe(400);
    expect(await CloudAccountRepo.getAccountByEmail('bad@example.test')).toBeUndefined();
    expect(leases.reloadAllAccounts).toHaveBeenCalled();
    expect((await fastify.inject({ method: 'POST', url: '/admin/console/accounts/refresh-quota', headers: auth })).statusCode).toBe(201);
    expect(leases.refreshQuotaCatalog).toHaveBeenCalledWith({ force: true });
  });
  it('preserves a known TOS block when OAuth credentials are renewed', async () => {
    const auth = await login();
    await fastify.inject({ method: 'POST', url: '/admin/console/accounts/import', headers: auth, payload: {email: 'blocked@example.test', refresh_token: 'fixture-refresh'} });
    const original = (await CloudAccountRepo.getAccountByEmail('blocked@example.test'))!;
    await CloudAccountRepo.updateStatus(original.id, 'expired', 'GCP_TOS_VIOLATION');
    vi.spyOn(GoogleAPIService, 'exchangeCode').mockResolvedValue({ access_token: 'new-fixture-access', refresh_token: 'new-fixture-refresh', expires_in: 3600, token_type: 'Bearer', oauth_client_key: 'fixture' });
    vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({ id: 'fixture-user', verified_email: true, email: original.email, name: 'Fixture', picture: '' });
    try {
      await new AdminService(leases as unknown as AccountLeaseService).exchangeOAuthCode({code: 'fixture-code', fetch_quota: false});
      expect(await CloudAccountRepo.getAccount(original.id)).toMatchObject({status: 'expired', status_reason: 'GCP_TOS_VIOLATION'});
    } finally { vi.restoreAllMocks(); }
  });
  it('returns persisted request metadata and null counters for unavailable usage', async () => {
    const auth = await login();
    getRequestHistoryStore().record({ protocol: 'http', route: '/v1/messages', status: 200, duration_ms: 15, model: 'model-a', project_id: 'existing', attempts: [{account_id: 'account-one', outcome: 'success'}] });
    expect((await fastify.inject({ url: '/admin/console/requests?projectId=existing', headers: auth })).json().total).toBe(1);
    const summary = (await fastify.inject({ url: '/admin/console/statistics', headers: auth })).json();
    expect(summary).toMatchObject({total_requests: 1, input_tokens: null, token_metrics_available: false});
    expect((await fastify.inject({ url: '/admin/console/account-stats', headers: auth })).json()[0]).toMatchObject({account_id: 'account-one', success_attempts: 1});
    expect((await fastify.inject({ url: '/admin/console/requests?limit=NaN', headers: auth })).statusCode).toBe(400);
    expect((await fastify.inject({ url: '/admin/console/statistics?granularity=five_minutes', headers: auth })).json()).toMatchObject({ granularity: 'five_minutes', time_zone: 'Europe/Samara', total_requests: 1 });
    for (const query of ['granularity=week', 'metric=bad', 'missingModel=1', 'attemptOutcome=bad', 'toExclusive=bad', 'result=bad']) {
      expect((await fastify.inject({ url: `/admin/console/statistics?${query}`, headers: auth })).statusCode).toBe(400);
    }
    expect((await fastify.inject({ url: '/admin/console/requests?granularity=minute', headers: auth })).statusCode).toBe(400);
    expect((await fastify.inject({ url: '/admin/console/statistics?status=failure&result=success', headers: auth })).json().total_requests).toBe(0);
    const time = getRequestHistoryStore().getRequestHistory().items[0].time;
    for (const route of ['requests', 'statistics', 'account-stats']) {
      const response = await fastify.inject({ url: `/admin/console/${route}?toExclusive=${encodeURIComponent(time)}`, headers: auth });
      expect(response.statusCode).toBe(200);
      if (route === 'account-stats') expect(response.json()).toEqual([]);
      else expect(response.json()[route === 'requests' ? 'total' : 'total_requests']).toBe(0);
    }
    expect((await fastify.inject({ url: '/admin/console/requests?metric=input_tokens&missingModel=true&attemptOutcome=success&finalAccountId=account-one', headers: auth })).json().total).toBe(0);
  });
  it('provides real model discovery and rejects expired or mismatching OAuth state before upstream calls', async () => {
    const auth = await login();
    expect((await fastify.inject({ url: '/admin/console/models', headers: auth })).json()).toEqual({ models: ['model-a'] });
    expect((await fastify.inject({ method: 'POST', url: '/admin/console/oauth/exchange', headers: auth, payload: { state: 'unknown', code: 'code' } })).statusCode).toBe(400);
  });
});
