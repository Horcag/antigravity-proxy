import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('systemd rollback runtime discovery', () => {
  it('does not require npm for an emergency rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'antigravity-proxy-rollback-'));
    const result = spawnSync('bash', ['scripts/rollback-systemd.sh', 'previous-release'], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env, ROOT_PREFIX: root, RELEASE_TEST_MODE: '1', DRY_RUN: '1',
        NODE_BINARY: process.execPath, NPM_BINARY: join(root, 'missing-npm'),
      },
    });
    rmSync(root, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Would roll back to immutable release previous-release');
  });
});
