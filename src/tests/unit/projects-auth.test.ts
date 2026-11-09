import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../../modules/config/ipc/manager';
import { ProxyConfigSchema } from '../../modules/config/types';
import { AdminGuard } from '../../modules/proxy-gateway/server/guards/admin.guard';
import {
  hasMatchingProxyApiKey,
  isProxyApiKeyConfigured,
  resolveApiProject,
} from '../../modules/proxy-gateway/server/guards/api-key-auth.util';
import { ProxyGuard } from '../../modules/proxy-gateway/server/proxy.guard';
import { setServerConfig } from '../../server/server-config';

const projects = [
  { id: 'editor', name: 'Editor', api_key: 'editor-secret', enabled: true, model_mapping: { default: 'gemini' } },
  { id: 'paused', name: 'Paused', api_key: 'paused-secret', enabled: false },
];

function context(headers: Record<string, string> = {}): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers, ip: '127.0.0.1' }) }) } as ExecutionContext;
}

afterEach(() => {
  setServerConfig(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('project API key configuration', () => {
  it('keeps legacy configurations compatible and validates project mapping', () => {
    expect(ProxyConfigSchema.parse({}).projects).toBeUndefined();
    expect(ProxyConfigSchema.parse({ projects }).projects).toEqual(projects);
    expect(ProxyConfigSchema.parse({ projects: [{ id: 'x', name: 'X', api_key: 'key' }] }).projects?.[0]?.enabled).toBe(true);
    expect(ProxyConfigSchema.safeParse({ projects: [{ ...projects[0], model_mapping: { alias: 4 } }] }).success).toBe(false);
  });

  it.each(['id', 'name', 'api_key'] as const)('rejects empty project %s', (field) => {
    expect(ProxyConfigSchema.safeParse({ projects: [{ ...projects[0], [field]: ' ' }] }).success).toBe(false);
  });

  it.each([
    { projects: [projects[0], { ...projects[1], id: 'editor' }] },
    { projects: [projects[0], { ...projects[1], api_key: 'editor-secret' }] },
    { projects, api_key: 'editor-secret' },
    { projects, admin_api_key: 'paused-secret' },
  ])('rejects ambiguous identifiers and keys without disclosing keys', (input) => {
    const result = ProxyConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain('editor-secret');
      expect(JSON.stringify(result.error.issues)).not.toContain('paused-secret');
    }
  });

  it('preserves projects across file loading, saving and preferred-account updates', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'projects-auth-'));
    try {
      vi.stubEnv('AG_PROXY_DATA_DIR', directory);
      vi.stubEnv('AG_PROXY_API_KEY', 'legacy-secret');
      vi.stubEnv('AG_PROXY_ADMIN_API_KEY', 'admin-secret');
      writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ proxy: { projects } }));
      const loaded = ConfigManager.loadConfig();
      expect(loaded.proxy.projects).toEqual(projects);
      await ConfigManager.saveConfig(loaded);
      await ConfigManager.setPreferredAccount('account-1');
      const saved = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));
      expect(saved.proxy.projects).toEqual(projects);
      expect(saved.proxy.preferred_account_id).toBe('account-1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('project API key authentication', () => {
  const config = ProxyConfigSchema.parse({ api_key: 'legacy-secret', admin_api_key: 'admin-secret', projects });

  it('resolves enabled project identity without exposing its key or model mapping', () => {
    expect(resolveApiProject(config, 'editor-secret')).toEqual({ id: 'editor', name: 'Editor' });
    for (const token of ['paused-secret', 'legacy-secret', 'admin-secret', 'unknown', null]) {
      expect(resolveApiProject(config, token)).toBeNull();
    }
    expect(hasMatchingProxyApiKey(config, 'legacy-secret')).toBe(true);
    expect(hasMatchingProxyApiKey(config, 'editor-secret')).toBe(true);
    expect(hasMatchingProxyApiKey(config, 'paused-secret')).toBe(false);
  });

  it('rejects collisions even when callers supply an unvalidated configuration', () => {
    const ambiguous = { ...config, projects: [projects[0]!, { ...projects[1]!, api_key: 'editor-secret' }] };
    expect(resolveApiProject(ambiguous, 'editor-secret')).toBeNull();
    expect(hasMatchingProxyApiKey(ambiguous, 'editor-secret')).toBe(false);
    expect(hasMatchingProxyApiKey({ ...config, api_key: 'paused-secret' }, 'paused-secret')).toBe(false);
  });

  it.each(['authorization', 'x-api-key', 'x-goog-api-key'])('accepts a project key through %s', (header) => {
    setServerConfig(config);
    expect(new ProxyGuard().canActivate(context({ [header]: header === 'authorization' ? 'Bearer editor-secret' : 'editor-secret' }))).toBe(true);
  });

  it('keeps project keys separate from admin authentication', () => {
    setServerConfig(config);
    const guard = new AdminGuard();
    expect(guard.canActivate(context({ authorization: 'Bearer admin-secret' }))).toBe(true);
    expect(() => guard.canActivate(context({ 'x-api-key': 'editor-secret' }))).toThrow(UnauthorizedException);
    expect(() => new ProxyGuard().canActivate(context({ 'x-api-key': 'admin-secret' }))).toThrow(UnauthorizedException);
  });

  it('closes open mode for project-only configurations including disabled projects', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const projectList of [projects, [projects[1]!]]) {
      const projectOnly = ProxyConfigSchema.parse({ projects: projectList });
      expect(isProxyApiKeyConfigured(projectOnly)).toBe(true);
      setServerConfig(projectOnly);
      for (const token of [undefined, 'paused-secret', 'unknown']) {
        expect(() => new ProxyGuard().canActivate(context(token ? { 'x-api-key': token } : {}))).toThrow(UnauthorizedException);
      }
    }
    setServerConfig(ProxyConfigSchema.parse({}));
    expect(isProxyApiKeyConfigured(ProxyConfigSchema.parse({}))).toBe(false);
    expect(new ProxyGuard().canActivate(context())).toBe(true);
  });
});
