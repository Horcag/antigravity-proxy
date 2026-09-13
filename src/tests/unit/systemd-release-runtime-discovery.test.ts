import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const releaseLibrary = join(repositoryRoot, 'scripts/release-lib.sh');
const installScript = join(repositoryRoot, 'scripts/install-systemd.sh');
const temporaryRoots: string[] = [];

function createRoot() { const root = mkdtempSync(join(tmpdir(), 'antigravity-proxy-runtime-test-')); temporaryRoots.push(root); return root; }
function createFnmRuntime(root: string, version: string, npmLog = '') {
  const fnmDir = join(root, 'fnm'); const binDir = join(fnmDir, 'node-versions', version, 'installation', 'bin');
  mkdirSync(binDir, { recursive: true }); copyFileSync(process.execPath, join(binDir, 'node')); writeFileSync(join(binDir, 'npm'), npmLog ? `#!/bin/sh\nprintf '%s\\n' "$PATH" > "${npmLog}"\n` : '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'node'), 0o755); chmodSync(join(binDir, 'npm'), 0o755); mkdirSync(join(fnmDir, 'aliases', 'default'), { recursive: true });
  const defaultBin = join(fnmDir, 'aliases', 'default', 'bin'); if (!existsSync(defaultBin)) symlinkSync(binDir, defaultBin);
  return { binDir, fnmDir };
}
function writeFakeSudoTools(root: string, operator: string, home: string, runuserLog: string) {
  const tools = join(root, 'tools'); mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'getent'), `#!/bin/sh\nprintf '%s\\n' '${operator}:x:1000:1000::${home}:/bin/sh'\n`);
  writeFileSync(join(tools, 'runuser'), `#!/bin/sh\nprintf '%s\\n' "$*" > "${runuserLog}"\nshift 2\n[ "$1" = -- ] || exit 1\nshift\nexec "$@"\n`);
  chmodSync(join(tools, 'getent'), 0o755); chmodSync(join(tools, 'runuser'), 0o755);
  return tools;
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
  it('prefers the operator home fnm runtime over a sudo secure-path system Node when FNM_DIR is absent', () => {
    const root = createRoot(); const operator = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(); const home = join(root, 'operator home');
    const runtime = createFnmRuntime(join(home, '.local/share'), 'v-derived'); const tools = writeFakeSudoTools(root, operator, home, join(root, 'runuser.log'));
    const result = resolveRuntime(root, { FNM_DIR: '', RELEASE_OPERATOR: '', SUDO_USER: operator, PATH: `${tools}:/usr/bin:/bin` });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toEqual([join(runtime.binDir, 'node'), join(runtime.binDir, 'npm')]);
  });
  it('falls back to a root-owned trusted system Node when no operator fnm runtime exists', () => {
    const root = createRoot(); const tools = join(root, 'trusted-system-tools'); mkdirSync(tools); symlinkSync('/usr/bin/bash', join(tools, 'node'));
    const result = resolveRuntime(root, { FNM_DIR: '', NPM_BINARY: '/usr/bin/bash', RELEASE_OPERATOR: '', SUDO_USER: '', PATH: `${tools}:/usr/bin:/bin` });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toEqual(['/usr/bin/bash', '/usr/bin/bash']);
  });
  it('prefers explicit matching Node and npm overrides over fnm discovery', () => {
    const root = createRoot(); const fnmRuntime = createFnmRuntime(root, 'v-fnm'); const explicitRuntime = createFnmRuntime(root, 'v-explicit');
    const result = resolveRuntime(root, { FNM_DIR: fnmRuntime.fnmDir, NODE_BINARY: join(explicitRuntime.binDir, 'node'), NPM_BINARY: join(explicitRuntime.binDir, 'npm') });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toEqual([join(explicitRuntime.binDir, 'node'), join(explicitRuntime.binDir, 'npm')]);
  });
  it('rejects missing, mismatched, escaping, and unsafe operator runtime binaries', () => {
    const missingRoot = createRoot(); const missing = resolveRuntime(missingRoot, { FNM_DIR: createFnmRuntime(missingRoot, 'v-missing').fnmDir, NPM_BINARY: join(missingRoot, 'missing-npm') });
    expect(missing.status).toBe(1); expect(missing.stderr).toMatch(/NPM_BINARY is not an executable regular file/);
    const mismatchRoot = createRoot(); const nodeRuntime = createFnmRuntime(mismatchRoot, 'v-node'); const npmRuntime = createFnmRuntime(mismatchRoot, 'v-npm'); const mismatch = resolveRuntime(mismatchRoot, { NODE_BINARY: join(nodeRuntime.binDir, 'node'), NPM_BINARY: join(npmRuntime.binDir, 'npm') });
    expect(mismatch.status).toBe(1); expect(mismatch.stderr).toMatch(/NPM_BINARY must be in the same runtime installation as NODE_BINARY/);
    const root = createRoot(); const runtime = createFnmRuntime(root, 'v-safe'); const escapedRuntime = createFnmRuntime(createRoot(), 'v-escaped'); rmSync(join(runtime.fnmDir, 'aliases', 'default', 'bin')); symlinkSync(escapedRuntime.binDir, join(runtime.fnmDir, 'aliases', 'default', 'bin'));
    const escaped = resolveRuntime(root, { FNM_DIR: runtime.fnmDir }); expect(escaped.status).toBe(1); expect(escaped.stderr).toContain('NODE_BINARY is not in the default fnm runtime');
    const unsafeRoot = createRoot(); const unsafe = createFnmRuntime(unsafeRoot, 'v-unsafe'); chmodSync(unsafe.fnmDir, 0o777);
    const unsafeResult = resolveRuntime(unsafeRoot, { FNM_DIR: unsafe.fnmDir }); expect(unsafeResult.status).toBe(1); expect(unsafeResult.stderr).toContain('must not be group- or world-writable');
  });
  it('uses the matching derived fnm runtime through the install staging path under sudo-like conditions', () => {
    const root = createRoot(); const operator = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(); const home = join(root, 'operator home'); const npmLog = join(root, 'npm.log'); const runuserLog = join(root, 'runuser.log');
    const runtime = createFnmRuntime(join(home, '.local/share'), 'v-stage', npmLog); const tools = writeFakeSudoTools(root, operator, home, runuserLog);
    const result = spawnSync('bash', [installScript, 'install'], { cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, ROOT_PREFIX: root, RELEASE_ID: 'derived-stage', RELEASE_TEST_MODE: '1', RELEASE_TEST_EXERCISE_OPERATOR_NPM: '1', NODE_BINARY: '', NPM_BINARY: '', FNM_DIR: '', RELEASE_OPERATOR: '', SUDO_USER: operator, PATH: `${tools}:/usr/bin:/bin` } });
    expect(result.status, result.stderr).toBe(0); expect(readFileSync(runuserLog, 'utf8')).toContain(join(runtime.binDir, 'npm')); expect(readFileSync(npmLog, 'utf8').trim()).toBe(`${runtime.binDir}:/usr/local/bin:/usr/bin:/bin`);
  }, 30_000);
});
