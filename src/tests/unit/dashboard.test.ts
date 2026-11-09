import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardController } from '@/dashboard/dashboard.controller';
import { DashboardService } from '@/dashboard/dashboard.service';
import { RequestJournal, installDashboardHooks, requestJournal } from '@/dashboard/request-journal';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';

@Module({ controllers: [DashboardController], providers: [AdminGuard, { provide: DashboardService, useValue: { snapshot: () => ({ private: true }) } }] })
class TestModule {}

const originalConfig = getServerConfig();
afterEach(() => { setServerConfig(originalConfig); vi.restoreAllMocks(); });

describe('private dashboard', () => {
  it('serves a public empty shell but requires the separate admin key for data', async () => {
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, api_key: 'proxy-secret', admin_api_key: 'admin-secret' });
    const app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
    try {
      await app.init();
      const server = app.getHttpAdapter().getInstance();
      const page = await server.inject({ url: '/dashboard' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toMatch(/id=["']?root/);
      expect(page.body).toContain('<script type="module"');
      expect(page.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(page.body).not.toMatch(/proxy-secret|admin-secret/);
      expect((await server.inject({ url: '/admin/dashboard' })).statusCode).toBe(401);
      expect((await server.inject({ url: '/admin/dashboard', headers: { authorization: 'Bearer proxy-secret' } })).statusCode).toBe(401);
      const result = await server.inject({ url: '/admin/dashboard', headers: { authorization: 'Bearer admin-secret' } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ private: true });
    } finally { await app.close(); }
  });

  it('bounds and copies journal records, redacts arbitrary routes and configured secrets', () => {
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, admin_api_key: 'admin-secret' });
    const journal = new RequestJournal();
    for (let i = 0; i < 505; i++) journal.record({ protocol: 'connect', route: '/private/admin-secret?key=admin-secret', model: 'admin-secret', project_name: '<script>prompt</script>', status: i % 2 ? 200 : 502, duration_ms: 12.6 });
    const snapshot = journal.snapshot();
    expect(snapshot.entries).toHaveLength(500);
    expect(snapshot.total).toBe(505);
    expect(snapshot.errors).toBe(253);
    expect(snapshot.entries[0]).toMatchObject({ route: 'other', model: '—', project_name: 'Общий ключ', duration_ms: 13 });
    expect(JSON.stringify(snapshot)).not.toMatch(/admin-secret|script|prompt/);
    snapshot.entries[0].model = 'changed';
    expect(journal.snapshot().entries[0].model).toBe('—');
  });

  it('records completed failed HTTP requests exactly once without bodies or query strings', async () => {
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, projects: [{ id: 'dev', name: 'Development', enabled: true, api_key: 'project-secret', model_mapping: {} }] });
    const server = Fastify();
    installDashboardHooks(server);
    installDashboardHooks(server);
    server.post('/v1/chat/completions', async () => { throw new Error('secret-error-body'); });
    const before = requestJournal.snapshot().total;
    try {
      await server.inject({ method: 'POST', url: '/v1/chat/completions?key=secret-query', headers: { authorization: 'Bearer project-secret' }, payload: { model: 'gemini-3-pro', messages: ['secret-prompt'] } });
      const snapshot = requestJournal.snapshot();
      expect(snapshot.total).toBe(before + 1);
      expect(snapshot.entries[0]).toMatchObject({ status: 500, route: '/v1/chat/completions', model: 'gemini-3-pro', project_id: 'dev', project_name: 'Development' });
      expect(JSON.stringify(snapshot)).not.toMatch(/secret-query|secret-prompt|secret-error-body|project-secret/);
    } finally { await server.close(); }
  });

  it('whitelists account and runtime snapshot data', async () => {
    const account = { id: 'account-id', name: 'Owner', email: 'owner@example.test', provider: 'google', status: 'expired', status_reason: 'secret-error', created_at: 1, last_used: 1, token: { access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, expiry_timestamp: 4000000000, token_type: 'Bearer' }, quota: { models: { 'gemini-3-pro': { percentage: 0, resetTime: 'https://secret-url' } } } } as CloudAccount;
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([account]);
    const leases = { getQuotaDiagnostics: () => ({ accounts: [{ account_label: 'account-1', status: 'active', refresh_state: 'fresh', models: [{ public_model_id: 'gemini-3-pro', requestable: false, remaining_percentage: 0, temporary_block: { reason: 'secret-runtime', remaining_seconds: 60, unavailable_until: '2026-11-10T00:00:00.000Z' } }] }] }) } as unknown as AccountLeaseService;
    const snapshot = await new DashboardService(leases).snapshot();
    expect(snapshot.accounts[0]).toMatchObject({ status: 'expired', availability: 'unavailable', reason: 'Требуется авторизация' });
    expect(snapshot.runtime[0].models[0].cooldown?.remaining_seconds).toBe(60);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-|access_token|refresh_token|status_reason/);
  });
});
