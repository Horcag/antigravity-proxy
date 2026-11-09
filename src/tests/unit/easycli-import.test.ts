import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importEasyCliPayload } from '../../migration/easycli-import';
import { ConfigManager } from '../../modules/config/ipc/manager';
import { CloudAccountRepo } from '../../modules/cloud-account/persistence/cloudHandler';
import { resetMasterKeyCacheForTesting } from '../../shared/security/encryption';

const account = {
  type: 'antigravity', email: 'user@example.com', access_token: 'access-secret',
  refresh_token: 'refresh-secret', project_id: 'gcp-project', expired: '2026-11-10T00:00:00Z',
  migration_status: 'active', disabled: true,
};
const project = { id: 'editor', name: 'Editor', api_key: 'project-secret', enabled: true };
const payload = { version: 1, projects: [project], accounts: [account], model_mapping: { alias: 'gemini' } };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'easycli-import-'));
  vi.stubEnv('AG_PROXY_DATA_DIR', directory);
  vi.stubEnv('AG_PROXY_API_KEY', 'legacy-secret');
  vi.stubEnv('AG_PROXY_ADMIN_API_KEY', 'admin-secret');
  vi.stubEnv('AG_PROXY_MASTER_KEY', 'a'.repeat(64));
  resetMasterKeyCacheForTesting();
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    proxy: { request_timeout: 47, custom_mapping: { old: 'old-model' } },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  CloudAccountRepo.close();
  resetMasterKeyCacheForTesting();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function seedOriginalState() {
  await CloudAccountRepo.addAccount({
    id: 'original-account', provider: 'google', email: account.email, name: 'Original',
    token: { access_token: 'original-access', refresh_token: 'original-refresh', project_id: 'original-project',
      token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 12345 },
    created_at: 123, last_used: 456, status: 'expired', status_reason: 'ORIGINAL_REASON',
    quota: { models: {}, is_forbidden: true }, is_active: false,
  });
  return { config: ConfigManager.loadConfig(), accounts: await CloudAccountRepo.getAccounts() };
}

const rollbackPayload = { ...payload, accounts: [
  account, { ...account, email: 'new@example.com' }, { ...account, email: 'not-yet-written@example.com' },
] };

describe('EasyCLI migration compensation on real temporary storage', () => {
  it.each([
    { write: 1, afterCommit: false }, { write: 1, afterCommit: true },
    { write: 2, afterCommit: false }, { write: 2, afterCommit: true },
  ])('restores config and all account snapshots when upsert $write fails (afterCommit=$afterCommit)', async ({ write, afterCommit }) => {
    const original = await seedOriginalState();
    const addAccount = CloudAccountRepo.addAccount.bind(CloudAccountRepo);
    let calls = 0;
    vi.spyOn(CloudAccountRepo, 'addAccount').mockImplementation(async (value) => {
      calls += 1;
      if (calls === write) {
        if (afterCommit) await addAccount(value);
        throw new Error('sensitive injected DB failure access-secret');
      }
      await addAccount(value);
    });
    await expect(importEasyCliPayload(rollbackPayload)).rejects.toThrow('EasyCLI migration failed; previous state restored');
    expect(await CloudAccountRepo.getAccounts()).toEqual(original.accounts);
    expect(ConfigManager.loadConfig()).toEqual(original.config);
  });

  it.each([false, true])('restores state when config save fails (afterCommit=%s)', async (afterCommit) => {
    const original = await seedOriginalState();
    const saveConfig = ConfigManager.saveConfig.bind(ConfigManager);
    let calls = 0;
    vi.spyOn(ConfigManager, 'saveConfig').mockImplementation(async (value) => {
      calls += 1;
      if (calls === 1) {
        if (afterCommit) await saveConfig(value);
        throw new Error('sensitive injected config failure project-secret');
      }
      await saveConfig(value);
    });
    await expect(importEasyCliPayload(rollbackPayload)).rejects.toThrow('EasyCLI migration failed; previous state restored');
    expect(await CloudAccountRepo.getAccounts()).toEqual(original.accounts);
    expect(ConfigManager.loadConfig()).toEqual(original.config);
  });

  it('reports a redacted partial migration when an account rollback fails and continues other restorations', async () => {
    const original = await seedOriginalState();
    const addAccount = CloudAccountRepo.addAccount.bind(CloudAccountRepo);
    let calls = 0;
    vi.spyOn(CloudAccountRepo, 'addAccount').mockImplementation(async (value) => {
      calls += 1;
      if (calls === 3) throw new Error('sensitive rollback failure refresh-secret');
      await addAccount(value);
      if (calls === 2) throw new Error('sensitive commit failure access-secret');
    });
    await expect(importEasyCliPayload(rollbackPayload)).rejects.toThrow(
      'EasyCLI partial migration; restore destination backup before retry (phase=accounts, rollbackFailures=1)',
    );
    expect(ConfigManager.loadConfig()).toEqual(original.config);
    const remaining = await CloudAccountRepo.getAccounts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('original-account');
    expect(remaining[0].token.access_token).toBe('access-secret');
  });

  it('reports a redacted partial migration when config rollback fails', async () => {
    const original = await seedOriginalState();
    const saveConfig = ConfigManager.saveConfig.bind(ConfigManager);
    let saves = 0;
    vi.spyOn(ConfigManager, 'saveConfig').mockImplementation(async (value) => {
      saves += 1;
      if (saves === 2) throw new Error('sensitive config rollback project-secret');
      await saveConfig(value);
    });
    vi.spyOn(CloudAccountRepo, 'addAccount').mockRejectedValueOnce(new Error('sensitive DB error refresh-secret'));
    await expect(importEasyCliPayload(rollbackPayload)).rejects.toThrow(
      'EasyCLI partial migration; restore destination backup before retry (phase=accounts, rollbackFailures=1)',
    );
    expect(await CloudAccountRepo.getAccounts()).toEqual(original.accounts);
    expect(ConfigManager.loadConfig().proxy.projects).toEqual([project]);
  });
});

describe('offline EasyCLI migration', () => {
  it('imports encrypted credentials and project keys while preserving config options', async () => {
    expect(await importEasyCliPayload(payload)).toEqual({
      projectsImported: 1, projectsExisting: 0, accountsImported: 1, accountsUpdated: 0,
      accountsSkipped: 0, accountsActive: 1, accountsBlocked: 0, accountsDisabled: 0, modelMappingsImported: 1,
    });
    const saved = (await CloudAccountRepo.getAccounts())[0]!;
    expect(saved.provider).toBe('google');
    expect(saved.token).toMatchObject({ refresh_token: 'refresh-secret', project_id: 'gcp-project', expiry_timestamp: Date.parse(account.expired) / 1000 });
    expect(saved.status).toBe('active');
    expect(saved.is_active).toBe(true);
    expect(ConfigManager.loadConfig().proxy).toMatchObject({
      request_timeout: 47, projects: [project], custom_mapping: { old: 'old-model', alias: 'gemini' },
    });
    const database = new Database(path.join(directory, 'accounts.db'), { readonly: true });
    try {
      const row = database.prepare('SELECT token_json FROM accounts').get() as { token_json: string };
      expect(row.token_json).toMatch(/^agp1:/);
      expect(row.token_json).not.toContain('secret');
    } finally {
      database.close();
    }
  });

  it('upserts by case-insensitive email and clears only forbidden flags on active accounts', async () => {
    await importEasyCliPayload(payload);
    const existing = (await CloudAccountRepo.getAccounts())[0]!;
    await CloudAccountRepo.addAccount({
      ...existing, created_at: 123, last_used: 456, status: 'expired', status_reason: 'TOS_VIOLATION',
      quota: { models: { gemini: { percentage: 77, resetTime: 'later' } }, is_forbidden: true, isForbidden: true },
    });
    const result = await importEasyCliPayload({ ...payload, accounts: [{ ...account, email: 'USER@example.com' }] });
    expect(result).toMatchObject({ accountsUpdated: 1, accountsImported: 0, projectsExisting: 1 });
    const updated = (await CloudAccountRepo.getAccounts())[0]!;
    expect(updated).toMatchObject({ id: existing.id, created_at: existing.created_at, last_used: 456, status: 'active' });
    expect(updated.status_reason).toBeUndefined();
    expect(updated.quota).toEqual({ models: { gemini: { percentage: 77, resetTime: 'later' } }, is_forbidden: false, isForbidden: false });
  });

  it('applies explicit blocked and disabled statuses and skips Codex credentials', async () => {
    const result = await importEasyCliPayload({ ...payload, accounts: [
      { ...account, migration_status: 'blocked' },
      { ...account, email: 'disabled@example.com', migration_status: 'disabled' },
      { type: 'codex', migration_status: 'active' },
    ] });
    expect(result).toMatchObject({ accountsImported: 2, accountsSkipped: 1, accountsBlocked: 1, accountsDisabled: 1 });
    expect(await CloudAccountRepo.getAccountByEmail(account.email)).toMatchObject({
      status: 'expired', status_reason: 'TOS_VIOLATION', is_active: false, quota: { is_forbidden: true },
    });
    expect(await CloudAccountRepo.getAccountByEmail('disabled@example.com')).toMatchObject({ status: 'expired', is_active: false });
  });

  it('uses timestamp plus expires_in when expired is absent', async () => {
    await importEasyCliPayload({ ...payload, accounts: [{ ...account, expired: undefined, timestamp: 1_700_000_000, expires_in: 1800 }] });
    expect((await CloudAccountRepo.getAccountByEmail(account.email))?.token.expiry_timestamp).toBe(1_700_001_800);
  });

  it.each([
    { ...account, refresh_token: '' },
    { ...account, project_id: '' },
    { ...account, migration_status: 'unknown' },
    { ...account, expired: 'invalid-date' },
  ])('validates the entire batch before writing, with redacted errors', async (invalid) => {
    const before = readFileSync(path.join(directory, 'config.json'), 'utf8');
    await expect(importEasyCliPayload({ ...payload, accounts: [account, invalid] })).rejects.toThrow('EasyCLI migration failed');
    expect(readFileSync(path.join(directory, 'config.json'), 'utf8')).toBe(before);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });

  it('rejects project conflicts without replacing the existing key', async () => {
    await importEasyCliPayload(payload);
    await expect(importEasyCliPayload({ ...payload, projects: [{ ...project, api_key: 'replacement-secret' }] })).rejects.toThrow('EasyCLI migration failed');
    expect(ConfigManager.loadConfig().proxy.projects).toEqual([project]);
  });

  it('preserves an existing project identity when importing the same key under a different ID', async () => {
    await importEasyCliPayload(payload);
    const result = await importEasyCliPayload({ ...payload, projects: [{ ...project, id: 'source-id' }] });
    expect(result.projectsExisting).toBe(1);
    expect(ConfigManager.loadConfig().proxy.projects).toEqual([project]);
  });

  it('runs the CLI offline from stdin and reports counts only', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'migration', 'import-easycli', '--stdin'], {
        cwd: process.cwd(), env: { ...process.env }, timeout: 15000,
      }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
      child.stdin?.end(JSON.stringify(payload));
    });
    expect(JSON.parse(output)).toMatchObject({ accountsImported: 1, projectsImported: 1 });
    expect(output).not.toContain('secret');
    expect(output).not.toContain(account.email);
  }, 20000);
});
