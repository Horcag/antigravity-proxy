import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const scripts = ['autonomous-update-launcher.sh', 'autonomous-update-root.sh', 'install-autonomous-updater.sh', 'update-systemd.sh'];

describe('autonomous system updater', () => {
  it('keeps every shell entrypoint syntactically valid', () => {
    for (const script of scripts) execFileSync('bash', ['-n', join(root, 'scripts', script)]);
  });

  it('exposes only a no-argument passwordless root-owned command', () => {
    const installer = readFileSync(join(root, 'scripts/install-autonomous-updater.sh'), 'utf8');
    const client = readFileSync(join(root, 'scripts/update-systemd.sh'), 'utf8');
    expect(installer).toContain('NOPASSWD:NOSETENV: /usr/local/sbin/antigravity-proxy-update ""');
    expect(client).toContain('sudo -n /usr/local/sbin/antigravity-proxy-update');
    expect(client).not.toContain('install-systemd.sh');
  });

  it('serializes the entire snapshot, build, and publication transaction', () => {
    const launcher = readFileSync(join(root, 'scripts/autonomous-update-launcher.sh'), 'utf8');
    expect(launcher).toContain('/usr/bin/flock -n -o /run/lock/antigravity-proxy-autonomous-update.lock');
    expect(launcher).toContain('/usr/local/libexec/antigravity-proxy-updater/update');
  });

  it('keeps the transaction lock descriptor out of the unprivileged child', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'agp-flock-'));
    const result = spawnSync('flock', ['-n', '-o', join(temporary, 'lock'), 'bash', '-c', 'test ! -e /proc/self/fd/9'], { encoding: 'utf8' });
    rmSync(temporary, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a second transaction while the first lock holder is active', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'agp-flock-race-')); const lock = join(temporary, 'lock');
    const script = 'flock -n -o "$1" sleep 1 & holder=$!; sleep 0.1; ! flock -n "$1" true; result=$?; wait "$holder"; exit "$result"';
    const result = spawnSync('bash', ['-c', script, 'flock-test', lock], { encoding: 'utf8' });
    rmSync(temporary, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not let preserved proxy variables reach npm staging', () => {
    const runtime = readFileSync(join(root, 'scripts/autonomous-update-root.sh'), 'utf8');
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      expect(runtime).toContain(`-u ${name}`);
    }
  });

  it('rejects arguments before touching privileged state', () => {
    const result = spawnSync('bash', [join(root, 'scripts/autonomous-update-root.sh'), 'unexpected'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('accepts no arguments');
  });

  it('extracts a sealed prebuilt release without reading project artifacts as root', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'agp-prebuilt-'));
    const tree = join(temporary, 'tree'); const archive = join(temporary, 'release.tar');
    mkdirSync(join(tree, 'dist'), { recursive: true }); mkdirSync(join(tree, 'node_modules')); mkdirSync(join(tree, 'bin'));
    writeFileSync(join(tree, 'dist/cli.js'), 'ok\n'); writeFileSync(join(tree, 'package.json'), '{}\n');
    writeFileSync(join(tree, 'package-lock.json'), '{"lockfileVersion":3}\n'); copyFileSync('/usr/bin/true', join(tree, 'bin/node'));
    execFileSync('tar', ['-C', tree, '-cf', archive, 'dist', 'node_modules', 'package.json', 'package-lock.json', 'bin/node']);
    const program = 'source "$1"; release_init; mkdir -p "$(root_path "$releases_dir")"; create_release; test -x "$candidate_staging_fs/bin/node"; test -f "$candidate_staging_fs/dist/cli.js"';
    const result = spawnSync('bash', ['-c', program, 'prebuilt-test', join(root, 'scripts/release-lib.sh')], { encoding: 'utf8', env: {
      ...process.env, ROOT_PREFIX: join(temporary, 'root'), RELEASE_TEST_MODE: '1', RELEASE_ID: 'prebuilt-test',
      PROJECT_DIR: root, PREBUILT_RELEASE_ARCHIVE: archive, NODE_BINARY: process.execPath,
      RELEASE_OPERATOR: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(),
    } });
    rmSync(temporary, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
  });
});
