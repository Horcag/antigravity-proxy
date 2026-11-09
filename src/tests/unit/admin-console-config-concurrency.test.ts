import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleConfigService } from '@/admin-console/console-config.service';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';

describe('console configuration updates under the existing persistence lock', () => {
  let directory: string;
  let originalDirectory: string | undefined;
  let originalConfig: ReturnType<typeof getServerConfig>;
  beforeEach(async () => {
    originalDirectory = process.env.AG_PROXY_DATA_DIR;
    originalConfig = getServerConfig();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-config-race-'));
    process.env.AG_PROXY_DATA_DIR = directory;
    const initial = { ...DEFAULT_PROXY_CONFIG, port: 8317, preferred_account_id: 'account-a', projects: [{id: 'existing', name: 'Existing', enabled: true, api_key: 'fixture-project-secret'}] };
    await ConfigManager.saveConfig({ proxy: initial });
    setServerConfig(initial);
  });
  afterEach(() => {
    vi.restoreAllMocks(); setServerConfig(originalConfig);
    if (originalDirectory === undefined) delete process.env.AG_PROXY_DATA_DIR;
    else process.env.AG_PROXY_DATA_DIR = originalDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
    expect(fs.existsSync(directory)).toBe(false);
  });
  it('retains a legacy preferred-account commit made while console settings wait before locking', async () => {
    const atomicUpdate = ConfigManager.updateProxyConfig.bind(ConfigManager);
    let entered!: () => void;
    let proceed!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { proceed = resolve; });
    vi.spyOn(ConfigManager, 'updateProxyConfig').mockImplementation(async (change) => {
      entered(); await resume; await atomicUpdate(change);
    });
    const writing = new ConsoleConfigService().patchSettings({max_wait_seconds: 14});
    await paused;
    await ConfigManager.setPreferredAccount('account-b');
    expect(getServerConfig()?.preferred_account_id).toBe('account-a');
    proceed(); await writing;
    expect(ConfigManager.loadConfig().proxy).toMatchObject({ preferred_account_id: 'account-b', max_wait_seconds: 14, port: 8317 });
    expect(getServerConfig()).toMatchObject({ preferred_account_id: 'account-b', max_wait_seconds: 14, port: 8317 });
    expect(ConfigManager.loadConfig().proxy.projects?.[0].api_key).toBe('fixture-project-secret');
  });
  it('applies environment overrides to validation/runtime without persisting them as unrelated edits', async () => {
    const originalHost = process.env.AG_PROXY_HOST;
    process.env.AG_PROXY_HOST = '127.0.0.2';
    try {
      await new ConsoleConfigService().patchSettings({ request_timeout: 90 });
      expect(getServerConfig()?.host).toBe('127.0.0.2');
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).proxy.host).toBe(DEFAULT_PROXY_CONFIG.host);
    } finally { if (originalHost === undefined) delete process.env.AG_PROXY_HOST; else process.env.AG_PROXY_HOST = originalHost; }
  });
});
