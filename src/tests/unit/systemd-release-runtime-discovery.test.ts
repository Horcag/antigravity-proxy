import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const releaseLibrary = join(repositoryRoot, 'scripts/release-lib.sh');
const temporaryRoots: string[] = [];

function createRoot() { const root = mkdtempSync(join(tmpdir(), 'antigravity-proxy-runtime-test-')); temporaryRoots.push(root); return root; }
function createFnmRuntime(root: string, version: string) {
  const fnmDir = join(root, 'fnm'); const binDir = join(fnmDir, 'node-versions', version, 'installation', 'bin');
  mkdirSync(binDir, { recursive: true }); copyFileSync(process.execPath, join(binDir, 'node')); writeFileSync(join(binDir, 'npm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'node'), 0o755); chmodSync(join(binDir, 'npm'), 0o755); mkdirSync(join(fnmDir, 'aliases', 'default'), { recursive: true });
  const defaultBin = join(fnmDir, 'aliases', 'default', 'bin'); if (!existsSync(defaultBin)) symlinkSync(binDir, defaultBin);
  return { binDir, fnmDir };
}
function resolveRuntime(root: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', 'source "$1"; release_init; printf "%s\\n%s\\n" "$node_binary" "$npm_binary"', 'release-runtime-test', releaseLibrary], {
    cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, ROOT_PREFIX: root, RELEASE_ID: 'runtime-resolution', RELEASE_TEST_MODE: '1', NODE_BINARY: '', NPM_BINARY: '', PATH: '/usr/bin:/bin', RELEASE_OPERATOR: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), ...extraEnv },
  });
}
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('systemd release runtime discovery', () => {
  it('discovers a matching operator-owned fnm runtime when sudo-like PATH has no node or npm', () => {
    const root = createRoot(); const runtime = createFnmRuntime(root, 'v-test'); const result = resolveRuntime(root, { FNM_DIR: runtime.fnmDir });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toEqual([join(runtime.binDir, 'node'), join(runtime.binDir, 'npm')]);
  });
  it('prefers explicit matching Node and npm overrides over fnm discovery', () => {
    const root = createRoot(); const fnmRuntime = createFnmRuntime(root, 'v-fnm'); const explicitRuntime = createFnmRuntime(root, 'v-explicit');
    const result = resolveRuntime(root, { FNM_DIR: fnmRuntime.fnmDir, NODE_BINARY: join(explicitRuntime.binDir, 'node'), NPM_BINARY: join(explicitRuntime.binDir, 'npm') });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toEqual([join(explicitRuntime.binDir, 'node'), join(explicitRuntime.binDir, 'npm')]);
  });
  it('rejects missing, mismatched, and escaping runtime binaries', () => {
    const missingRoot = createRoot(); const missing = resolveRuntime(missingRoot, { FNM_DIR: createFnmRuntime(missingRoot, 'v-missing').fnmDir, NPM_BINARY: join(missingRoot, 'missing-npm') });
    expect(missing.status).toBe(1); expect(missing.stderr).toMatch(/NPM_BINARY is not an executable regular file/);
    const mismatchRoot = createRoot(); const nodeRuntime = createFnmRuntime(mismatchRoot, 'v-node'); const npmRuntime = createFnmRuntime(mismatchRoot, 'v-npm'); const mismatch = resolveRuntime(mismatchRoot, { NODE_BINARY: join(nodeRuntime.binDir, 'node'), NPM_BINARY: join(npmRuntime.binDir, 'npm') });
    expect(mismatch.status).toBe(1); expect(mismatch.stderr).toMatch(/NPM_BINARY must be in the same runtime installation as NODE_BINARY/);
    const root = createRoot(); const runtime = createFnmRuntime(root, 'v-safe'); const escapedRuntime = createFnmRuntime(createRoot(), 'v-escaped'); rmSync(join(runtime.fnmDir, 'aliases', 'default', 'bin')); symlinkSync(escapedRuntime.binDir, join(runtime.fnmDir, 'aliases', 'default', 'bin'));
    const escaped = resolveRuntime(root, { FNM_DIR: runtime.fnmDir }); expect(escaped.status).toBe(1); expect(escaped.stderr).toContain('NODE_BINARY escapes its validated runtime root');
  });
});
