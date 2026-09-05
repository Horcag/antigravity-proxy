import 'reflect-metadata';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '@/admin/admin.controller';
import { AdminService } from '@/admin/admin.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { type CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';

const leaseService = {
  setPreferredAccount: vi.fn(),
  getQuotaDiagnostics: vi.fn(),
};
const environmentKeys = ['AG_PROXY_DATA_DIR', 'AG_PROXY_MASTER_KEY'] as const;

interface TestFastifyInstance {
  inject(options: Record<string, unknown>): Promise<{
    statusCode: number;
    body: string;
    json(): unknown;
  }>;
}

@Module({
  controllers: [AdminController],
  providers: [
    AdminGuard,
    AdminService,
    { provide: AccountLeaseService, useValue: leaseService },
  ],
})
class AdminPreferredAccountIntegrationModule {}

function createAccount(): CloudAccount {
  return {
    id: 'acc-1',
    provider: 'google',
    email: 'secret@example.test',
    name: 'Preferred User',
    token: {
      access_token: 'access-token-must-not-leak',
      refresh_token: 'refresh-token-must-not-leak',
      expires_in: 3600,
      expiry_timestamp: 4_000_000_000,
      token_type: 'Bearer',
    },
    created_at: 1,
    last_used: 1,
    status: 'active',
    is_active: true,
  };
}

describe('preferred account admin routes', () => {
  let app: NestFastifyApplication | undefined;
  let fastify: TestFastifyInstance;
  let dataDir: string | undefined;
  let originalEnvironment: Map<string, string | undefined>;
  let originalServerConfig: ReturnType<typeof getServerConfig>;

  beforeEach(async () => {
    originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    originalServerConfig = getServerConfig();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-proxy-admin-test-'));
    process.env.AG_PROXY_DATA_DIR = dataDir;
    process.env.AG_PROXY_MASTER_KEY = '22'.repeat(32);
    resetMasterKeyCacheForTesting();
    leaseService.setPreferredAccount.mockReset();
    leaseService.getQuotaDiagnostics.mockReset();
    setServerConfig({
      ...DEFAULT_PROXY_CONFIG,
      api_key: 'proxy-key',
      admin_api_key: 'admin-key',
    });
    await CloudAccountRepo.addAccount(createAccount());
    app = await NestFactory.create<NestFastifyApplication>(
      AdminPreferredAccountIntegrationModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    fastify = app.getHttpAdapter().getInstance() as TestFastifyInstance;
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      try {
        CloudAccountRepo.close();
      } finally {
        try {
          resetMasterKeyCacheForTesting();
        } finally {
          try {
            for (const [key, value] of originalEnvironment) {
              if (value === undefined) {
                delete process.env[key];
              } else {
                process.env[key] = value;
              }
            }
          } finally {
            try {
              setServerConfig(originalServerConfig);
            } finally {
              if (dataDir) {
                fs.rmSync(dataDir, { recursive: true, force: true });
              }
            }
          }
        }
      }
    }
  });

  it('uses protected static GET/PUT/DELETE routes and never returns account credentials', async () => {
    const unauthorized = await fastify.inject({ method: 'GET', url: '/admin/accounts/preferred' });
    const proxyKey = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/preferred',
      headers: { authorization: 'Bearer proxy-key' },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(proxyKey.statusCode).toBe(401);

    const set = await fastify.inject({
      method: 'PUT',
      url: '/admin/accounts/preferred',
      headers: { authorization: 'Bearer admin-key' },
      payload: { account_id: 'acc-1' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({
      preferred_account_id: 'acc-1',
      account: {
        id: 'acc-1',
        provider: 'google',
        name: 'Preferred User',
        avatar_url: null,
        status: 'active',
        is_active: true,
      },
    });
    expect(set.body).not.toContain('secret@example.test');
    expect(set.body).not.toContain('access-token-must-not-leak');
    expect(set.body).not.toContain('refresh-token-must-not-leak');

    const get = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/preferred',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(set.json());

    const clear = await fastify.inject({
      method: 'DELETE',
      url: '/admin/accounts/preferred',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual({ preferred_account_id: null, account: null });
    expect(leaseService.setPreferredAccount).toHaveBeenCalledWith('acc-1');
    expect(leaseService.setPreferredAccount).toHaveBeenLastCalledWith();
  });

  it('keeps the default account export admin-key protected and proxy-safe', async () => {
    const rawProxyUrl =
      'https://proxy-user:proxy-password@proxy.example.test:8443/tunnel?proxy-query=secret#proxy-fragment';
    const rawValues = [
      rawProxyUrl,
      'proxy-user',
      'proxy-password',
      '/tunnel',
      'proxy-query=secret',
      'proxy-fragment',
    ];
    const canaries = rawValues.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    await CloudAccountRepo.addAccount({ ...createAccount(), proxy_url: rawProxyUrl });

    const unauthorized = await fastify.inject({ method: 'GET', url: '/admin/accounts/export' });
    const proxyKey = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/export',
      headers: { authorization: 'Bearer proxy-key' },
    });
    const exported = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/export',
      headers: { authorization: 'Bearer admin-key' },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(proxyKey.statusCode).toBe(401);
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      version: '1.0',
      accounts: [{ email: 'secret@example.test', proxy_url: 'https://proxy.example.test:8443' }],
    });
    for (const canary of canaries) {
      expect(exported.body).not.toContain(canary);
    }
  });

  it('synchronizes the runtime lease after a committed persistence failure', async () => {
    const originalFsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        throw new Error('simulated directory fsync failure');
      }
      originalFsync(descriptor);
    });

    const response = await fastify.inject({
      method: 'PUT',
      url: '/admin/accounts/preferred',
      headers: { authorization: 'Bearer admin-key' },
      payload: { account_id: 'acc-1' },
    });

    expect(response.statusCode).toBe(500);
    expect(leaseService.setPreferredAccount).toHaveBeenCalledWith('acc-1');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir as string, 'config.json'), 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-1' },
    });
  });

  it('protects quota diagnostics with the admin key instead of the proxy key', async () => {
    leaseService.getQuotaDiagnostics.mockReturnValue({
      refresh_interval_seconds: 600,
      accounts: [{ account_label: 'account-1', refresh_state: 'unknown', models: [] }],
    });

    const unauthorized = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/quota-diagnostics',
    });
    const proxyKey = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/quota-diagnostics',
      headers: { authorization: 'Bearer proxy-key' },
    });
    const adminKey = await fastify.inject({
      method: 'GET',
      url: '/admin/accounts/quota-diagnostics',
      headers: { authorization: 'Bearer admin-key' },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(proxyKey.statusCode).toBe(401);
    expect(adminKey.statusCode).toBe(200);
    expect(adminKey.json()).toEqual({
      refresh_interval_seconds: 600,
      accounts: [{ account_label: 'account-1', refresh_state: 'unknown', models: [] }],
    });
    for (const sensitiveValue of [
      'acc-1',
      'secret@example.test',
      'access-token-must-not-leak',
      'project-must-not-leak',
    ]) {
      expect(adminKey.body).not.toContain(sensitiveValue);
      expect(adminKey.body).not.toContain(Buffer.from(sensitiveValue).toString('base64'));
      expect(adminKey.body).not.toContain(createHash('sha256').update(sensitiveValue).digest('hex'));
    }
  });
});
