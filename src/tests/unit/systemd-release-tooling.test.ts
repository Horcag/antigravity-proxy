import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const repositoryRoot = process.cwd();
const installScript = join(repositoryRoot, 'scripts/install-systemd.sh');
const rollbackScript = join(repositoryRoot, 'scripts/rollback-systemd.sh');
const releaseLibrary = join(repositoryRoot, 'scripts/release-lib.sh');
const releaseRuntimeLibrary = join(repositoryRoot, 'scripts/release-runtime-lib.sh');
const temporaryRoots: string[] = [];
const migrationStateEntries = ['accounts.db', 'accounts.db-wal', 'accounts.db-shm', '.master-key', 'config.json'];

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), 'antigravity-proxy-release-test-'));
  temporaryRoots.push(root);
  return root;
}

function runInstall(root: string, releaseId: string, mode = 'install', extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [installScript, mode], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_PREFIX: root,
      RELEASE_ID: releaseId,
      RELEASE_TEST_MODE: '1',
      NODE_BINARY: process.execPath,
      ...extraEnv,
    },
  });
}

function runRollback(root: string, targetId = '', extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', targetId ? [rollbackScript, targetId] : [rollbackScript], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_PREFIX: root,
      RELEASE_TEST_MODE: '1',
      NODE_BINARY: process.execPath,
      ...extraEnv,
    },
  });
}

function convertReleaseToLegacyRuntime(root: string, releaseId: string) {
  const releasePath = join(root, 'opt/antigravity-proxy/releases', releaseId);
  execFileSync('mkdir', ['-p', join(releasePath, 'runtime')]);
  execFileSync('mv', [join(releasePath, 'bin/node'), join(releasePath, 'runtime/node')]);
  execFileSync('rmdir', [join(releasePath, 'bin')]);
}

function setUnitRuntimeLayout(root: string, runtimePath: 'bin/node' | 'runtime/node') {
  const unitPath = join(root, 'etc/systemd/system/antigravity-proxy.service');
  writeFileSync(
    unitPath,
    readFileSync(unitPath, 'utf8').replace('/current/bin/node ', `/current/${runtimePath} `),
  );
}

function expectCurrentUnitRuntime(root: string, runtimePath: 'bin/node' | 'runtime/node') {
  const current = join(root, 'opt/antigravity-proxy/current');
  const unit = readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8');
  expect(unit).toContain('Restart=always');
  expect(unit).toContain(`ExecStart=/opt/antigravity-proxy/current/${runtimePath} /opt/antigravity-proxy/current/dist/cli.js serve`);
  expect(existsSync(join(current, runtimePath))).toBe(true);
}
function runReleaseLibrary(root: string, releaseId: string, program: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', program, 'release-library-test', releaseLibrary], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_PREFIX: root,
      RELEASE_ID: releaseId,
      RELEASE_TEST_MODE: '1',
      NODE_BINARY: process.execPath,
      ...extraEnv,
    },
  });
}

function recordedActions(path: string) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function writeLegacyMigrationSource(root: string) {
  const dataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
  const environmentPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
  execFileSync('mkdir', ['-p', dataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
  writeFileSync(
    environmentPath,
    'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
  );
  for (const entry of migrationStateEntries) {
    writeFileSync(join(dataPath, entry), `legacy-${entry}`);
  }
  return {
    dataDir: '/home/legacy/.local/share/antigravity-proxy',
    environmentFile: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
  };
}

function expectMigrationPublicationRolledBack(root: string) {
  expect(existsSync(join(root, 'etc/antigravity-proxy/antigravity-proxy.env'))).toBe(false);
  expect(existsSync(join(root, 'etc/systemd/system/antigravity-proxy.service'))).toBe(false);
  expect(existsSync(join(root, 'opt/antigravity-proxy/current'))).toBe(false);
  const dataPath = join(root, 'var/lib/antigravity-proxy');
  const entries = existsSync(dataPath) ? readdirSync(dataPath).filter((entry) => !entry.startsWith('.migration-staging-')) : [];
  expect(entries).toEqual([]); expect(readdirSync(join(root, 'var/lib')).filter((entry) => entry.startsWith('.migration-staging-'))).toEqual([]);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('systemd release tooling', { timeout: 60_000 }, () => {
  it('prints a fresh-install plan without generating or disclosing environment values', () => {
    const result = spawnSync('bash', [installScript, 'install'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DRY_RUN: '1',
        RELEASE_ID: 'planned-release',
        NODE_BINARY: process.execPath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Would install Antigravity Proxy release planned-release');
    expect(result.stdout).toContain('owner root:antigravity-proxy mode 0750');
    expect(result.stdout).toContain('owner root:antigravity-proxy mode 0640');
    expect(result.stdout).toContain('stage production dependencies as the configured non-root release operator');
    expect(result.stdout).toContain('without printing environment contents');
    expect(result.stdout).not.toContain('AG_PROXY_API_KEY=');
    expect(result.stdout).not.toContain('AG_PROXY_ADMIN_API_KEY=');
  });

  it('rejects unsafe RELEASE_TEST_MODE roots before it creates any target path', () => {
    const root = createRoot();
    const isolatedInstall = join(root, 'isolated-install');
    for (const rootPrefix of ['', 'relative-root', '/']) {
      const result = spawnSync('bash', [installScript, 'install'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ROOT_PREFIX: rootPrefix,
          RELEASE_TEST_MODE: '1',
          INSTALL_ROOT: isolatedInstall,
          DATA_DIR: join(root, 'isolated-data'),
          ENV_FILE: join(root, 'isolated-env'),
          NODE_BINARY: process.execPath,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ROOT_PREFIX must be an absolute path|RELEASE_TEST_MODE requires a non-root absolute ROOT_PREFIX/);
      expect(existsSync(isolatedInstall)).toBe(false);
    }
    const rootResolvingPrefix = join(root, 'root-resolving-prefix');
    symlinkSync('/', rootResolvingPrefix);
    const rootResolvingResult = spawnSync('bash', [installScript, 'install'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ROOT_PREFIX: rootResolvingPrefix,
        RELEASE_TEST_MODE: '1',
        INSTALL_ROOT: isolatedInstall,
        DATA_DIR: join(root, 'isolated-data'),
        ENV_FILE: join(root, 'isolated-env'),
        NODE_BINARY: process.execPath,
      },
    });
    expect(rootResolvingResult.status).toBe(1);
    expect(rootResolvingResult.stderr).toContain('RELEASE_TEST_MODE requires a non-root absolute ROOT_PREFIX');
    expect(existsSync(isolatedInstall)).toBe(false);
  });

  it('creates a bundled-runtime release with a native-addon probe and hardened root-owned environment plan', () => {
    const root = createRoot();
    const probeLog = join(root, 'probe.log');
    const result = runInstall(root, 'fresh', 'install', { RELEASE_TEST_PROBE_LOG: probeLog });

    expect(result.status).toBe(0);
    expect(execFileSync('readlink', [join(root, 'opt/antigravity-proxy/current')], { encoding: 'utf8' }).trim()).toBe(
      'releases/fresh',
    );
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(join(root, 'opt/antigravity-proxy/releases/fresh'));
    expect(existsSync(join(root, 'opt/antigravity-proxy/previous'))).toBe(false);
    expect(execFileSync('readlink', [join(root, 'opt/antigravity-proxy/releases/fresh/node_modules')], { encoding: 'utf8' }).trim()).toBe(
      join(repositoryRoot, 'node_modules'),
    );
    expect(readFileSync(join(root, 'etc/antigravity-proxy/antigravity-proxy.env'), 'utf8')).toContain(
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045',
    );
    const unit = readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8');
    expect(unit).toContain('ExecStart=/opt/antigravity-proxy/current/bin/node /opt/antigravity-proxy/current/dist/cli.js serve');
    expect(unit).toContain('ReadWritePaths=/var/lib/antigravity-proxy');
    expect(unit).toContain('CapabilityBoundingSet=');
    expect(unit).toContain('AmbientCapabilities=');
    expect(unit).toContain('Group=antigravity-proxy');
    expect(unit).not.toContain('/usr/bin/node');
    const library = readFileSync(releaseRuntimeLibrary, 'utf8');
    expect(library).toContain('"$npm_binary" ci --prefix "$staging_fs" --omit=dev');
    expect(library).not.toContain('npm ci --prefix "$staging_fs" --omit=dev --ignore-scripts');
    expect(readFileSync(releaseLibrary, 'utf8')).toContain('release_runtime_probe');
    expect(readFileSync(probeLog, 'utf8')).toContain(`uid=${process.getuid?.()} command=`);
    expect(readFileSync(probeLog, 'utf8')).toContain('/bin/node ');
  }, 30_000);

  it('preserves existing environment, key, database, and WAL state during update', () => {
    const root = createRoot();
    const envPath = join(root, 'etc/antigravity-proxy/antigravity-proxy.env');
    const statePath = join(root, 'var/lib/antigravity-proxy');
    execFileSync('mkdir', ['-p', statePath, join(root, 'etc/antigravity-proxy')]);
    writeFileSync(
      envPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=preserved-proxy\nAG_PROXY_ADMIN_API_KEY=preserved-admin\n',
    );
    writeFileSync(join(statePath, 'accounts.db'), 'database');
    writeFileSync(join(statePath, 'accounts.db-wal'), 'wal');
    writeFileSync(join(statePath, '.master-key'), 'master-key');

    const result = runInstall(root, 'update-one', 'update');

    expect(result.status).toBe(0);
    expect(readFileSync(envPath, 'utf8')).toContain('AG_PROXY_API_KEY=preserved-proxy\nAG_PROXY_ADMIN_API_KEY=preserved-admin\n');
    expect(readFileSync(join(statePath, 'accounts.db'), 'utf8')).toBe('database');
    expect(readFileSync(join(statePath, 'accounts.db-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(statePath, '.master-key'), 'utf8')).toBe('master-key');
    expect(result.stdout).not.toContain('preserved-proxy');
    expect(result.stdout).not.toContain('preserved-admin');
  }, 30_000);

  it('copies legacy environment and SQLite state without regenerating keys during migration', () => {
    const root = createRoot();
    const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
    const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
    execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
    writeFileSync(
      legacyEnvPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
    );
    writeFileSync(join(legacyDataPath, 'accounts.db'), 'legacy-database');
    writeFileSync(join(legacyDataPath, 'accounts.db-wal'), 'legacy-wal');
    writeFileSync(join(legacyDataPath, 'accounts.db-shm'), 'legacy-shm');
    writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
    writeFileSync(join(legacyDataPath, 'config.json'), '{"legacy":true}\n');

    const result = runInstall(root, 'migrated', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
    });

    const statePath = join(root, 'var/lib/antigravity-proxy');
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'etc/antigravity-proxy/antigravity-proxy.env'), 'utf8')).toContain(
      'AG_PROXY_API_KEY=legacy-proxy',
    );
    expect(readFileSync(join(statePath, 'accounts.db'), 'utf8')).toBe('legacy-database');
    expect(readFileSync(join(statePath, 'accounts.db-wal'), 'utf8')).toBe('legacy-wal');
    expect(readFileSync(join(statePath, 'accounts.db-shm'), 'utf8')).toBe('legacy-shm');
    expect(readFileSync(join(statePath, '.master-key'), 'utf8')).toBe('legacy-master-key');
    expect(readFileSync(join(statePath, 'config.json'), 'utf8')).toBe('{"legacy":true}\n');
    expect(result.stdout).not.toContain('legacy-proxy');
    expect(result.stdout).not.toContain('legacy-admin');
  }, 30_000);

  it('rolls back every newly published environment and state entry after each individual publication failure', () => {
    for (const checkpoint of ['environment', ...migrationStateEntries.map((entry) => `state-${entry}`)]) {
      const root = createRoot();
      const source = writeLegacyMigrationSource(root);
      const systemLog = join(root, 'systemd.log');
      const legacyLog = join(root, 'legacy.log');

      const result = runInstall(root, `publish-failure-${checkpoint.replaceAll('.', '-')}`, 'migrate', {
        LEGACY_DATA_DIR: source.dataDir,
        LEGACY_ENV_FILE: source.environmentFile,
        RELEASE_TEST_MIGRATION_FAIL_AFTER: checkpoint,
        RELEASE_TEST_SYSTEMD_LOG: systemLog,
        RELEASE_TEST_LEGACY_LOG: legacyLog,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Migration failure was forced after ${checkpoint}`);
      expect(result.stderr).not.toContain("cleanup was incomplete"); expectMigrationPublicationRolledBack(root);
      expect(recordedActions(systemLog)).toEqual([]);
      expect(recordedActions(legacyLog)).toEqual(['stop antigravity-proxy.service', 'start antigravity-proxy.service']);
    }
  }, 120_000);

  it('refuses to delete a substituted publication during migration rollback', () => {
    const root = createRoot();
    const source = writeLegacyMigrationSource(root);
    const result = runInstall(root, 'substituted-publication', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_SUBSTITUTE_AFTER: 'environment',
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'environment',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to remove substituted migration rollback entry');
    expect(readFileSync(join(root, 'etc/antigravity-proxy/antigravity-proxy.env'), 'utf8')).toBe('substituted\n');
    const statePath = join(root, 'var/lib/antigravity-proxy');
    expect(readdirSync(statePath).filter((entry) => !entry.startsWith('.migration-staging-'))).toEqual([]);
  }, 30_000);

  it('never overwrites or deletes substituted migration links, unit, wants entry, or committed release', () => {
    const targets: Array<[string, string, string]> = [
      ['current', 'release-switch', 'opt/antigravity-proxy/current'],
      ['previous', 'release-switch', 'opt/antigravity-proxy/previous'],
      ['unit', 'unit-write', 'etc/systemd/system/antigravity-proxy.service'],
      ['wants', 'wants', 'etc/systemd/system/multi-user.target.wants/antigravity-proxy.service'],
      ['release', 'release', 'opt/antigravity-proxy/releases/substituted-release'],
    ];
    for (const [checkpoint, failure, target] of targets) {
      const root = createRoot();
      if (checkpoint !== 'wants') {
        expect(runInstall(root, 'before').status).toBe(0);
      }
      const source = writeLegacyMigrationSource(root);
      const result = runInstall(root, 'substituted-release', 'migrate', {
        LEGACY_DATA_DIR: source.dataDir,
        LEGACY_ENV_FILE: source.environmentFile,
        RELEASE_TEST_MIGRATION_SUBSTITUTE_AFTER: checkpoint,
        RELEASE_TEST_MIGRATION_FAIL_AFTER: failure,
      });

      expect(result.status, `${checkpoint}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('Refusing to');
      const targetPath = join(root, target);
      if (checkpoint === 'release') {
        expect(readFileSync(join(targetPath, 'replacement'), 'utf8')).toBe('substituted\n');
      } else {
        expect(readFileSync(targetPath, 'utf8')).toBe('substituted\n');
      }
    }
  }, 60_000);

  it('removes an exact failed committed release and permits an identical migration retry', () => {
    const root = createRoot();
    expect(runInstall(root, 'before').status).toBe(0);
    const source = writeLegacyMigrationSource(root);
    const failed = runInstall(root, 'retryable-release', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'release-switch',
    });

    expect(failed.status).toBe(1);
    const installPath = join(root, 'opt/antigravity-proxy');
    expect(existsSync(join(installPath, 'releases/retryable-release')), failed.stderr).toBe(false);
    expect(realpathSync(join(installPath, 'current'))).toBe(join(installPath, 'releases/before'));
    expect(existsSync(join(installPath, 'previous'))).toBe(false);

    const retried = runInstall(root, 'retryable-release', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
    });
    expect(retried.status).toBe(0);
    expect(realpathSync(join(installPath, 'current'))).toBe(join(installPath, 'releases/retryable-release'));
  }, 30_000);

  it('restores existing environment content and metadata, while refusing a substituted environment path', () => {
    const root = createRoot();
    const source = writeLegacyMigrationSource(root);
    const environmentPath = join(root, 'etc/antigravity-proxy/antigravity-proxy.env');
    const original = 'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=existing-proxy\nAG_PROXY_ADMIN_API_KEY=existing-admin\n';
    execFileSync('mkdir', ['-p', join(root, 'etc/antigravity-proxy')]);
    writeFileSync(environmentPath, original);
    chmodSync(environmentPath, 0o604);
    const originalMetadata = statSync(environmentPath);

    const failed = runInstall(root, 'environment-metadata', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'unit-write',
    });
    expect(failed.status).toBe(1);
    expect(readFileSync(environmentPath, 'utf8')).toBe(original);
    const restoredMetadata = statSync(environmentPath);
    expect(restoredMetadata.uid).toBe(originalMetadata.uid);
    expect(restoredMetadata.gid).toBe(originalMetadata.gid);
    expect(restoredMetadata.mode & 0o777).toBe(0o604);

    const substituted = runInstall(root, 'substituted-environment', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_SUBSTITUTE_AFTER: 'environment',
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'environment-metadata',
    });
    expect(substituted.status).toBe(1);
    expect(substituted.stderr).toContain('Refusing to restore metadata on substituted migration environment file');
    expect(readFileSync(environmentPath, 'utf8')).toBe('substituted\n');
  }, 30_000);

  it('preserves a pre-existing environment when a later migration publication fails', () => {
    const root = createRoot();
    const source = writeLegacyMigrationSource(root);
    const environmentPath = join(root, 'etc/antigravity-proxy/antigravity-proxy.env');
    execFileSync('mkdir', ['-p', join(root, 'etc/antigravity-proxy')]);
    writeFileSync(
      environmentPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=existing-proxy\nAG_PROXY_ADMIN_API_KEY=existing-admin\n',
    );

    const result = runInstall(root, 'existing-environment', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'state-accounts.db',
    });

    expect(result.status).toBe(1);
    expect(readFileSync(environmentPath, 'utf8')).toContain('AG_PROXY_API_KEY=existing-proxy');
    const statePath = join(root, 'var/lib/antigravity-proxy');
    expect(readdirSync(statePath).filter((entry) => !entry.startsWith('.migration-staging-'))).toEqual([]);
  });

  it('restores publication, unit state, release links, and legacy topology after unit, switch, and first-smoke failures', () => {
    for (const checkpoint of ['unit-write', 'release-switch', 'first-smoke']) {
      const root = createRoot();
      const source = writeLegacyMigrationSource(root);
      const systemLog = join(root, 'systemd.log');
      const legacyLog = join(root, 'legacy.log');
      const result = runInstall(root, `cutover-failure-${checkpoint}`, 'migrate', {
        LEGACY_DATA_DIR: source.dataDir,
        LEGACY_ENV_FILE: source.environmentFile,
        RELEASE_TEST_MIGRATION_FAIL_AFTER: checkpoint,
        RELEASE_TEST_SYSTEMD_LOG: systemLog,
        RELEASE_TEST_LEGACY_LOG: legacyLog,
      });

      expect(result.status).toBe(1);
      expectMigrationPublicationRolledBack(root);
      expect(recordedActions(legacyLog)).toEqual(['stop antigravity-proxy.service', 'start antigravity-proxy.service']);
      if (checkpoint === 'unit-write') {
        expect(recordedActions(systemLog)).toEqual([]);
      } else if (checkpoint === 'release-switch') {
        expect(recordedActions(systemLog)).toEqual(['disable --now antigravity-proxy.service']);
      } else {
        expect(recordedActions(systemLog)).toEqual([
          'daemon-reload',
          'enable --now antigravity-proxy.service',
          'disable --now antigravity-proxy.service',
        ]);
      }
    }
  }, 30_000);

  it('rolls publication back when the restored system release fails its recovery smoke check', () => {
    const root = createRoot();
    expect(runInstall(root, 'system-before').status).toBe(0);
    const source = writeLegacyMigrationSource(root);
    const environmentPath = join(root, 'etc/antigravity-proxy/antigravity-proxy.env');
    const originalUnit = readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8');
    const systemLog = join(root, 'systemd.log');
    const result = runInstall(root, 'restored-smoke-failure', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_SYSTEM_ACTIVE: '1',
      RELEASE_TEST_LEGACY_ACTIVE: '0',
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'first-smoke',
      RELEASE_TEST_SMOKE: 'fail-restored',
      RELEASE_TEST_SYSTEMD_LOG: systemLog,
    });

    expect(result.status).toBe(1);
    expect(readFileSync(environmentPath, 'utf8')).toContain('AG_PROXY_API_KEY=');
    expect(readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8')).toBe(originalUnit);
    const statePath = join(root, 'var/lib/antigravity-proxy');
    expect(readdirSync(statePath).filter((entry) => !entry.startsWith('.migration-staging-'))).toEqual([]);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(join(root, 'opt/antigravity-proxy/releases/system-before'));
    expect(recordedActions(systemLog)).toEqual([
      'daemon-reload',
      'restart antigravity-proxy.service',
      'daemon-reload',
      'restart antigravity-proxy.service',
    ]);
  }, 30_000);

  it('fails closed before migration copying for every target migration-state entry and mixed partial state', () => {
    const cases = [
      ['accounts.db'],
      ['accounts.db-wal'],
      ['accounts.db-shm'],
      ['.master-key'],
      ['config.json'],
      ['accounts.db-wal', 'config.json'],
    ];
    for (const entries of cases) {
      const root = createRoot();
      const targetDataPath = join(root, 'var/lib/antigravity-proxy');
      const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
      const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
      execFileSync('mkdir', ['-p', targetDataPath, legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
      for (const entry of entries) {
        writeFileSync(join(targetDataPath, entry), `target-${entry}`);
      }
      writeFileSync(join(legacyDataPath, 'accounts.db'), 'legacy-database');
      writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
      writeFileSync(
        legacyEnvPath,
        'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
      );

      const result = runInstall(root, `partial-target-${entries.join('-')}`, 'migrate', {
        LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
        LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Target migration state is not empty');
      for (const entry of entries) {
        expect(readFileSync(join(targetDataPath, entry), 'utf8')).toBe(`target-${entry}`);
      }
      expect(existsSync(join(root, 'etc/antigravity-proxy/antigravity-proxy.env'))).toBe(false);
      expect(existsSync(join(root, 'opt/antigravity-proxy/current'))).toBe(false);
    }
  });

  it('rejects symlinked persistent or legacy state without copying it', () => {
    const root = createRoot();
    const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
    const outside = join(root, 'outside.db');
    execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(legacyDataPath, 'accounts.db'));
    writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
    writeFileSync(
      join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env'),
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
    );

    const result = runInstall(root, 'unsafe-state', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('legacy migration state accounts.db must be a regular non-symlink file');
    expect(existsSync(join(root, 'var/lib/antigravity-proxy/accounts.db'))).toBe(false);
  });

  it('rejects unreadable legacy state before stopping legacy or writing the target', () => {
    const root = createRoot();
    const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
    const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
    const systemLog = join(root, 'systemd.log');
    const legacyLog = join(root, 'legacy.log');
    execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
    const unreadableDatabase = join(legacyDataPath, 'accounts.db');
    writeFileSync(unreadableDatabase, 'legacy-database');
    chmodSync(unreadableDatabase, 0o000);
    writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
    writeFileSync(
      legacyEnvPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
    );

    const result = runInstall(root, 'unreadable-source', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
      RELEASE_TEST_SYSTEMD_LOG: systemLog,
      RELEASE_TEST_LEGACY_LOG: legacyLog,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('legacy migration accounts.db must be readable');
    expect(recordedActions(systemLog)).toEqual([]);
    expect(recordedActions(legacyLog)).toEqual([]);
    expect(existsSync(join(root, 'etc/antigravity-proxy/antigravity-proxy.env'))).toBe(false);
    expect(existsSync(join(root, 'var/lib/antigravity-proxy'))).toBe(false);
    expect(existsSync(join(root, 'opt/antigravity-proxy'))).toBe(false);
  });

  it('rejects a missing migration source before creating target layout or changing either service', () => {
    const root = createRoot();
    const systemLog = join(root, 'systemd.log');
    const legacyLog = join(root, 'legacy.log');
    const result = runInstall(root, 'missing-source', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
      RELEASE_TEST_SYSTEMD_LOG: systemLog,
      RELEASE_TEST_LEGACY_LOG: legacyLog,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Legacy state directory does not exist');
    expect(recordedActions(systemLog)).toEqual([]);
    expect(recordedActions(legacyLog)).toEqual([]);
    expect(existsSync(join(root, 'etc/antigravity-proxy'))).toBe(false);
    expect(existsSync(join(root, 'var/lib/antigravity-proxy'))).toBe(false);
    expect(existsSync(join(root, 'opt/antigravity-proxy'))).toBe(false);
  });

  it('rejects duplicate and malformed critical environment assignments before cutover', () => {
    const root = createRoot();
    const envPath = join(root, 'etc/antigravity-proxy/antigravity-proxy.env');
    execFileSync('mkdir', ['-p', join(root, 'etc/antigravity-proxy')]);
    writeFileSync(
      envPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_PORT=8046\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=bad key\nAG_PROXY_ADMIN_API_KEY=admin\n',
    );

    const result = runInstall(root, 'bad-environment', 'update');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Environment contract has missing or duplicate AG_PROXY_PORT');
    expect(existsSync(join(root, 'opt/antigravity-proxy/current'))).toBe(false);
  });

  it('captures legacy-only, system-only, and neither migration topology while rejecting both-active', () => {
    const topologyCases: Array<[string, string, number]> = [
      ['1', '0', 0],
      ['0', '1', 0],
      ['1', '1', 1],
      ['0', '0', 0],
    ];
    for (const [systemActive, legacyActive, expectedStatus] of topologyCases) {
      const root = createRoot();
      const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
      const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
      execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
      writeFileSync(join(legacyDataPath, 'accounts.db'), 'legacy-database');
      writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
      writeFileSync(
        legacyEnvPath,
        'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
      );

      const result = runInstall(root, `topology-${systemActive}-${legacyActive}`, 'migrate', {
        LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
        LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
        RELEASE_TEST_SYSTEM_ACTIVE: systemActive,
        RELEASE_TEST_LEGACY_ACTIVE: legacyActive,
      });

      expect(result.status).toBe(expectedStatus);
      if (expectedStatus === 1) {
        expect(result.stderr).toContain('Migration refused');
      }
    }
  }, 30_000);

  it('restores legacy-only topology after a system start or smoke failure', () => {
    const root = createRoot();
    const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
    const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
    const systemLog = join(root, 'systemd.log');
    const legacyLog = join(root, 'legacy.log');
    execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
    writeFileSync(join(legacyDataPath, 'accounts.db'), 'legacy-database');
    writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
    writeFileSync(
      legacyEnvPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
    );

    const result = runInstall(root, 'legacy-start-failure', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
      RELEASE_TEST_SMOKE: 'fail',
      RELEASE_TEST_SYSTEMD_LOG: systemLog,
      RELEASE_TEST_LEGACY_LOG: legacyLog,
    });

    expect(result.status).toBe(1);
    expect(recordedActions(systemLog)).toEqual([
      'daemon-reload',
      'enable --now antigravity-proxy.service',
      'disable --now antigravity-proxy.service',
    ]);
    expect(recordedActions(legacyLog)).toEqual(['stop antigravity-proxy.service', 'start antigravity-proxy.service']);
    expect(existsSync(join(root, 'opt/antigravity-proxy/current'))).toBe(false);
  });

  it('restores legacy-only topology if disabling the legacy unit fails', () => {
    const root = createRoot();
    const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
    const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
    const systemLog = join(root, 'systemd.log');
    const legacyLog = join(root, 'legacy.log');
    execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
    writeFileSync(join(legacyDataPath, 'accounts.db'), 'legacy-database');
    writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
    writeFileSync(
      legacyEnvPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
    );

    const result = runInstall(root, 'legacy-disable-failure', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
      RELEASE_TEST_LEGACY_DISABLE: 'fail',
      RELEASE_TEST_SYSTEMD_LOG: systemLog,
      RELEASE_TEST_LEGACY_LOG: legacyLog,
    });

    expect(result.status).toBe(1);
    expect(recordedActions(systemLog)).toEqual([
      'daemon-reload',
      'enable --now antigravity-proxy.service',
      'disable --now antigravity-proxy.service',
    ]);
    expect(recordedActions(legacyLog)).toEqual([
      'stop antigravity-proxy.service',
      'disable antigravity-proxy.service',
      'start antigravity-proxy.service',
    ]);
    expectMigrationPublicationRolledBack(root);
  });

  it('never starts legacy during system-only recovery, including a restored-release smoke failure', () => {
    const root = createRoot();
    expect(runInstall(root, 'system-before').status).toBe(0);
    const legacyDataPath = join(root, 'home/legacy/.local/share/antigravity-proxy');
    const legacyEnvPath = join(root, 'home/legacy/.config/antigravity-proxy/antigravity-proxy.env');
    const systemLog = join(root, 'systemd.log');
    const legacyLog = join(root, 'legacy.log');
    execFileSync('mkdir', ['-p', legacyDataPath, join(root, 'home/legacy/.config/antigravity-proxy')]);
    writeFileSync(join(legacyDataPath, 'accounts.db'), 'legacy-database');
    writeFileSync(join(legacyDataPath, '.master-key'), 'legacy-master-key');
    writeFileSync(
      legacyEnvPath,
      'AG_PROXY_HOST=127.0.0.1\nAG_PROXY_PORT=8045\nAG_PROXY_DATA_DIR=/var/lib/antigravity-proxy\nAG_PROXY_API_KEY=legacy-proxy\nAG_PROXY_ADMIN_API_KEY=legacy-admin\n',
    );

    const result = runInstall(root, 'system-after', 'migrate', {
      LEGACY_DATA_DIR: '/home/legacy/.local/share/antigravity-proxy',
      LEGACY_ENV_FILE: '/home/legacy/.config/antigravity-proxy/antigravity-proxy.env',
      RELEASE_TEST_SYSTEM_ACTIVE: '1',
      RELEASE_TEST_LEGACY_ACTIVE: '0',
      RELEASE_TEST_SMOKE: 'fail',
      RELEASE_TEST_SYSTEMD_LOG: systemLog,
      RELEASE_TEST_LEGACY_LOG: legacyLog,
    });

    expect(result.status).toBe(1);
    expect(recordedActions(systemLog)).toEqual([
      'daemon-reload',
      'restart antigravity-proxy.service',
      'daemon-reload',
      'restart antigravity-proxy.service',
    ]);
    expect(recordedActions(legacyLog)).toEqual([]);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(
      join(root, 'opt/antigravity-proxy/releases/system-before'),
    );
  }, 30_000);

  it('keeps resolved current and previous links correct across consecutive updates and failed smoke rollback', () => {
    const root = createRoot();
    expect(runInstall(root, 'first').status).toBe(0);
    expect(runInstall(root, 'second', 'update').status).toBe(0);
    expect(runInstall(root, 'third', 'update').status).toBe(0);

    const installRoot = join(root, 'opt/antigravity-proxy');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/third'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/second'));

    const failedUpdate = runInstall(root, 'fourth', 'update', { RELEASE_TEST_SMOKE: 'fail' });

    expect(failedUpdate.status).toBe(1);
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/third'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/second'));
  }, 30_000);

  it('updates a legacy runtime/node release to a new bin/node release with a matching unit', () => {
    const root = createRoot();
    expect(runInstall(root, 'legacy').status).toBe(0);
    convertReleaseToLegacyRuntime(root, 'legacy');
    setUnitRuntimeLayout(root, 'runtime/node');

    const result = runInstall(root, 'new', 'update');

    expect(result.status).toBe(0);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(join(root, 'opt/antigravity-proxy/releases/new'));
    expectCurrentUnitRuntime(root, 'bin/node');
    expect(existsSync(join(root, 'opt/antigravity-proxy/releases/legacy/runtime/node'))).toBe(true);
  }, 30_000);

  it('restores a legacy runtime/node unit after a failed new-release activation', () => {
    const root = createRoot();
    expect(runInstall(root, 'legacy').status).toBe(0);
    convertReleaseToLegacyRuntime(root, 'legacy');
    setUnitRuntimeLayout(root, 'runtime/node');

    const result = runInstall(root, 'new', 'update', { RELEASE_TEST_SMOKE: 'fail' });

    expect(result.status).toBe(1);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(join(root, 'opt/antigravity-proxy/releases/legacy'));
    expectCurrentUnitRuntime(root, 'runtime/node');
  }, 30_000);

  it('rolls back from a new bin/node release to a legacy runtime/node release with a matching unit', () => {
    const root = createRoot();
    expect(runInstall(root, 'legacy').status).toBe(0);
    convertReleaseToLegacyRuntime(root, 'legacy');
    setUnitRuntimeLayout(root, 'runtime/node');
    expect(runInstall(root, 'new', 'update').status).toBe(0);

    const result = runRollback(root);

    expect(result.status).toBe(0);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(join(root, 'opt/antigravity-proxy/releases/legacy'));
    expect(realpathSync(join(root, 'opt/antigravity-proxy/previous'))).toBe(join(root, 'opt/antigravity-proxy/releases/new'));
    expectCurrentUnitRuntime(root, 'runtime/node');
  }, 30_000);

  it('restores the new bin/node unit when rollback to a legacy runtime/node release fails', () => {
    const root = createRoot();
    expect(runInstall(root, 'legacy').status).toBe(0);
    convertReleaseToLegacyRuntime(root, 'legacy');
    setUnitRuntimeLayout(root, 'runtime/node');
    expect(runInstall(root, 'new', 'update').status).toBe(0);

    const result = runRollback(root, 'legacy', { RELEASE_TEST_SMOKE: 'fail' });

    expect(result.status).toBe(1);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(join(root, 'opt/antigravity-proxy/releases/new'));
    expect(realpathSync(join(root, 'opt/antigravity-proxy/previous'))).toBe(join(root, 'opt/antigravity-proxy/releases/legacy'));
    expectCurrentUnitRuntime(root, 'bin/node');
  }, 30_000);

  it('rejects a rollback target with no executable runtime before changing links, unit, or systemd state', () => {
    const root = createRoot();
    expect(runInstall(root, 'first').status).toBe(0);
    expect(runInstall(root, 'second', 'update').status).toBe(0);
    const installRoot = join(root, 'opt/antigravity-proxy');
    const unitPath = join(root, 'etc/systemd/system/antigravity-proxy.service');
    const systemLog = join(root, 'systemd.log');
    const unitBefore = readFileSync(unitPath, 'utf8');
    rmSync(join(installRoot, 'releases/first/bin/node'));

    const result = runRollback(root, 'first', { RELEASE_TEST_SYSTEMD_LOG: systemLog });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Release first has no executable bundled runtime');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/second'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/first'));
    expect(readFileSync(unitPath, 'utf8')).toBe(unitBefore);
    expect(recordedActions(systemLog)).toEqual([]);
  }, 30_000);

  it.each(['bin/node', 'runtime/node'] as const)(
    'rejects a bundled runtime directory at %s before changing links, unit, or systemd state',
    (runtimePath) => {
      const root = createRoot();
      expect(runInstall(root, 'first').status).toBe(0);
      expect(runInstall(root, 'second', 'update').status).toBe(0);
      const installRoot = join(root, 'opt/antigravity-proxy');
      const firstRelease = join(installRoot, 'releases/first');
      const unitPath = join(root, 'etc/systemd/system/antigravity-proxy.service');
      const systemLog = join(root, 'systemd.log');
      const unitBefore = readFileSync(unitPath, 'utf8');
      if (runtimePath === 'runtime/node') {
        rmSync(join(firstRelease, 'bin'), { recursive: true, force: true });
      } else {
        rmSync(join(firstRelease, runtimePath));
      }
      execFileSync('mkdir', ['-p', join(firstRelease, runtimePath)]);

      const result = runRollback(root, 'first', { RELEASE_TEST_SYSTEMD_LOG: systemLog });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Release first has no executable bundled runtime');
      expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/second'));
      expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/first'));
      expect(readFileSync(unitPath, 'utf8')).toBe(unitBefore);
      expect(recordedActions(systemLog)).toEqual([]);
    },
    30_000,
  );

  it('rejects a bundled runtime symlink that escapes its verified release before changing links, unit, or systemd state', () => {
    const root = createRoot();
    expect(runInstall(root, 'first').status).toBe(0);
    expect(runInstall(root, 'second', 'update').status).toBe(0);
    const installRoot = join(root, 'opt/antigravity-proxy');
    const unitPath = join(root, 'etc/systemd/system/antigravity-proxy.service');
    const systemLog = join(root, 'systemd.log');
    const unitBefore = readFileSync(unitPath, 'utf8');
    const escapedBin = join(root, 'escaped-bin');
    execFileSync('mkdir', ['-p', escapedBin]);
    writeFileSync(join(escapedBin, 'node'), '#!/bin/sh\n');
    chmodSync(join(escapedBin, 'node'), 0o755);
    rmSync(join(installRoot, 'releases/first/bin'), { recursive: true, force: true });
    symlinkSync(escapedBin, join(installRoot, 'releases/first/bin'));

    const result = runRollback(root, 'first', { RELEASE_TEST_SYSTEMD_LOG: systemLog });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bundled runtime escapes verified release directory');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/second'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/first'));
    expect(readFileSync(unitPath, 'utf8')).toBe(unitBefore);
    expect(recordedActions(systemLog)).toEqual([]);
  }, 30_000);

  it('keeps external-node units independent of release runtime layout', () => {
    const root = createRoot();
    expect(runInstall(root, 'first', 'install', { BUNDLE_NODE: '0' }).status).toBe(0);
    expect(runInstall(root, 'second', 'update', { BUNDLE_NODE: '0' }).status).toBe(0);

    const result = runRollback(root, 'first', { BUNDLE_NODE: '0' });

    expect(result.status).toBe(0);
    const unit = readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8');
    expect(unit).toContain(`ExecStart=${process.execPath} /opt/antigravity-proxy/current/dist/cli.js serve`);
  }, 30_000);

  it('rolls back the true prior immutable release and restores topology when its smoke check fails', () => {
    const root = createRoot();
    expect(runInstall(root, 'first').status).toBe(0);
    expect(runInstall(root, 'second', 'update').status).toBe(0);

    const result = spawnSync('bash', [rollbackScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ROOT_PREFIX: root,
        RELEASE_TEST_MODE: '1',
        NODE_BINARY: process.execPath,
      },
    });

    expect(result.status).toBe(0);
    const installRoot = join(root, 'opt/antigravity-proxy');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/first'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/second'));

    const failedRollback = spawnSync('bash', [rollbackScript, 'second'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ROOT_PREFIX: root,
        RELEASE_TEST_MODE: '1',
        RELEASE_TEST_SMOKE: 'fail',
        NODE_BINARY: process.execPath,
      },
    });

    expect(failedRollback.status).toBe(1);
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/first'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/second'));
  }, 30_000);

  it('rejects an explicit rollback to the current release without changing previous', () => {
    const root = createRoot();
    expect(runInstall(root, 'first').status).toBe(0);
    expect(runInstall(root, 'second', 'update').status).toBe(0);
    const installRoot = join(root, 'opt/antigravity-proxy');
    const result = spawnSync('bash', [rollbackScript, 'second'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, ROOT_PREFIX: root, RELEASE_TEST_MODE: '1', NODE_BINARY: process.execPath },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing a rollback from the current release to itself');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/second'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/first'));
  }, 30_000);

  it('fails a second transaction while the root-owned release lock is held', async () => {
    const root = createRoot();
    const lockPath = join(root, 'run/lock/antigravity-proxy-release.lock');
    execFileSync('mkdir', ['-p', join(root, 'run/lock')]);
    const holder = spawn('bash', ['-c', 'flock "$1" sh -c "printf locked; sleep 2"', '-', lockPath], {
      stdio: 'pipe',
    });

    await once(holder.stdout!, 'data');
    const contender = runInstall(root, 'blocked-by-lock');
    expect(contender.status).toBe(1);
    expect(contender.stderr).toContain('Another Antigravity Proxy release transaction is in progress');
    await once(holder, 'exit');
  }, 30_000);

  it('keeps the previous unit intact before rename and restores it after an atomic unit publication fault', () => {
    const root = createRoot();
    expect(runInstall(root, 'before').status).toBe(0);
    const source = writeLegacyMigrationSource(root);
    const unitPath = join(root, 'etc/systemd/system/antigravity-proxy.service');
    const originalUnit = readFileSync(unitPath, 'utf8');
    const originalMode = statSync(unitPath).mode & 0o777;

    const beforeRename = runInstall(root, 'unit-stage-failure', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'unit-stage',
    });
    expect(beforeRename.status).toBe(1);
    expect(readFileSync(unitPath, 'utf8')).toBe(originalUnit);
    expect(statSync(unitPath).mode & 0o777).toBe(originalMode);

    const afterRename = runInstall(root, 'unit-rename-failure', 'migrate', {
      LEGACY_DATA_DIR: source.dataDir,
      LEGACY_ENV_FILE: source.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'unit-rename',
    });
    expect(afterRename.status).toBe(1);
    expect(readFileSync(unitPath, 'utf8')).toBe(originalUnit);
    expect(statSync(unitPath).mode & 0o777).toBe(originalMode);
    expect(readdirSync(join(root, 'etc/systemd/system')).filter((entry) => entry.includes('.migration-'))).toEqual([]);
  }, 30_000);

  it('retains substitutions made after atomic cleanup detach instead of traversing or deleting them', () => {
    for (const kind of ['directory', 'file', 'symlink']) {
      const candidateRoot = createRoot();
      const candidate = runInstall(candidateRoot, `candidate-substitution-${kind}`, 'install', {
        RELEASE_TEST_RUNTIME_PROBE: 'fail',
        RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'candidate-staging',
        RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: kind,
      });
      const candidateStaging = readdirSync(join(candidateRoot, 'opt/antigravity-proxy/releases')).find((entry) =>
        entry.startsWith(`.staging-candidate-substitution-${kind}`),
      );
      const candidatePath = join(candidateRoot, 'opt/antigravity-proxy/releases', candidateStaging!);
      expect(candidate.status).toBe(1);
      expect(candidate.stderr).toContain('Retained path after atomic cleanup detach');
      if (kind === 'directory') {
        expect(readFileSync(join(candidatePath, 'replacement'), 'utf8')).toBe('substituted\n');
      } else if (kind === 'file') {
        expect(readFileSync(candidatePath, 'utf8')).toBe('substituted\n');
      } else {
        expect(execFileSync('readlink', [candidatePath], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');
      }
    }

    const stateRoot = createRoot();
    const stateSource = writeLegacyMigrationSource(stateRoot);
    const state = runInstall(stateRoot, 'state-substitution', 'migrate', {
      LEGACY_DATA_DIR: stateSource.dataDir,
      LEGACY_ENV_FILE: stateSource.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'environment',
      RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'migration-state-staging',
    });
    const stateStaging = readdirSync(join(stateRoot, 'var/lib')).find((entry) =>
      entry.startsWith('.migration-staging-state-substitution'),
    );
    expect(state.status).toBe(1);
    expect(state.stderr).toContain('Retained path after atomic cleanup detach');
    expect(readFileSync(join(stateRoot, 'var/lib', stateStaging!, 'replacement'), 'utf8')).toBe('substituted\n');

    const releaseRoot = createRoot();
    expect(runInstall(releaseRoot, 'before').status).toBe(0);
    const releaseSource = writeLegacyMigrationSource(releaseRoot);
    const release = runInstall(releaseRoot, 'release-substitution', 'migrate', {
      LEGACY_DATA_DIR: releaseSource.dataDir,
      LEGACY_ENV_FILE: releaseSource.environmentFile,
      RELEASE_TEST_MIGRATION_FAIL_AFTER: 'release-switch',
      RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'migration-release-directory',
    });
    const releasePath = join(releaseRoot, 'opt/antigravity-proxy/releases/release-substitution');
    expect(release.status).toBe(1);
    expect(release.stderr).toContain('Retained path after atomic cleanup detach');
    expect(readFileSync(join(releasePath, 'replacement'), 'utf8')).toBe('substituted\n');
  }, 30_000);

  it('retains post-detach substitutions for migration publication and backup cleanup paths', () => {
    for (const kind of ['file', 'link'] as const) {
      const root = createRoot();
      const path = join(root, `published-${kind}`);
      const result = runReleaseLibrary(
        root,
        `published-${kind}`,
        `
          source "$1"
          release_init
          if [ "$TEST_KIND" = link ]; then
            ln -s /owned-publication "$ROOT_PREFIX/published-$TEST_KIND"
          else
            printf '%s\\n' owned >"$ROOT_PREFIX/published-$TEST_KIND"
          fi
          ownership_acquire published_token "$ROOT_PREFIX/published-$TEST_KIND" "$TEST_KIND"; record_migration_publication "$ROOT_PREFIX/published-$TEST_KIND" "$TEST_KIND" "$published_token"
          if rollback_migration_publication; then
            exit 9
          fi
        `,
        {
          TEST_KIND: kind,
          RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: `migration-publication-${kind}`,
          RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: kind === 'link' ? 'symlink' : 'file',
        },
      );

      expect(result.status, kind).toBe(0);
      expect(result.stderr).toContain('Retained path after atomic cleanup detach');
      if (kind === 'link') {
        expect(execFileSync('readlink', [path], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');
      } else {
        expect(readFileSync(path, 'utf8')).toBe('substituted\n');
      }
      expect(readdirSync(root).some((entry) => entry.startsWith(`.published-${kind}.quarantine.`))).toBe(true);
    }

    for (const [label, checkpoint, kind] of [
      ['unit', 'migration-unit-backup', 'file'],
      ['wants', 'migration-wants-backup', 'symlink'],
    ] as const) {
      const root = createRoot();
      const backup = join(root, `${label}-backup`);
      const result = runReleaseLibrary(
        root,
        `${label}-backup`,
        `
          source "$1"
          release_init
          if [ "$TEST_LABEL" = unit ]; then
            printf '%s\\n' owned >"$ROOT_PREFIX/$TEST_LABEL-backup"
            migration_unit_backup_fs="$ROOT_PREFIX/$TEST_LABEL-backup"
            ownership_acquire migration_unit_backup_identity "$migration_unit_backup_fs" file
          else
            ln -s /owned-backup "$ROOT_PREFIX/$TEST_LABEL-backup"
            migration_wants_backup_fs="$ROOT_PREFIX/$TEST_LABEL-backup"
            ownership_acquire migration_wants_backup_identity "$migration_wants_backup_fs" link
          fi
          if complete_migration_unit_rollback; then
            exit 9
          fi
        `,
        {
          TEST_LABEL: label,
          RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: checkpoint,
          RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: kind,
        },
      );

      expect(result.status, label).toBe(0);
      expect(result.stderr).toContain('Retained path after atomic cleanup detach');
      if (kind === 'symlink') {
        expect(execFileSync('readlink', [backup], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');
      } else {
        expect(readFileSync(backup, 'utf8')).toBe('substituted\n');
      }
      expect(readdirSync(root).some((entry) => entry.startsWith(`.${label}-backup.quarantine.`))).toBe(true);
    }
  });

  it('retains substitutions at migration backup restoration and successful staging cleanup boundaries', () => {
    for (const [label, checkpoint, kind] of [
      ['unit', 'migration-unit-backup-restore', 'file'],
      ['wants', 'migration-wants-backup-restore', 'symlink'],
    ] as const) {
      const root = createRoot();
      const backup = join(root, `etc/systemd/system/${label}-backup`);
      const result = runReleaseLibrary(
        root,
        `${label}-backup-restore`,
        `
          source "$1"
          release_init
          mode=migrate
          install -d -m 0755 "$ROOT_PREFIX/etc/systemd/system/multi-user.target.wants"
          if [ "$TEST_LABEL" = unit ]; then
            unit_fs="$ROOT_PREFIX/etc/systemd/system/antigravity-proxy.service"
            migration_unit_backup_fs="$ROOT_PREFIX/etc/systemd/system/unit-backup"
            printf '%s\\n' original >"$migration_unit_backup_fs"
            printf '%s\\n' published >"$unit_fs"
            migration_unit_had_file=1
            migration_unit_rename_completed=1
            ownership_acquire migration_unit_backup_identity "$migration_unit_backup_fs" file
            ownership_acquire migration_unit_published_identity "$unit_fs" file
            if restore_migration_unit_state; then
              exit 9
            fi
          else
            migration_wants_fs="$ROOT_PREFIX/etc/systemd/system/multi-user.target.wants/antigravity-proxy.service"
            migration_wants_backup_fs="$ROOT_PREFIX/etc/systemd/system/wants-backup"
            ln -s /original-wants "$migration_wants_backup_fs"
            ln -s /published-wants "$migration_wants_fs"
            migration_wants_had_entry=1
            ownership_acquire migration_wants_backup_identity "$migration_wants_backup_fs" link
            ownership_acquire migration_wants_published_identity "$migration_wants_fs" link
            if restore_migration_wants_state; then
              exit 9
            fi
          fi
        `,
        {
          TEST_LABEL: label,
          RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: checkpoint,
          RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: kind,
        },
      );

      expect(result.status, label).toBe(0);
      expect(result.stderr).toContain('Retained path after atomic cleanup detach');
      if (kind === 'symlink') {
        expect(execFileSync('readlink', [backup], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');
      } else {
        expect(readFileSync(backup, 'utf8')).toBe('substituted\n');
      }
    }

    const root = createRoot();
    const result = runReleaseLibrary(
      root,
      'successful-staging-cleanup',
      `
        source "$1"
        release_init
        data_fs="$(root_path "$data_dir")"
        install -d -m 0700 "$data_fs"
        migration_state_staging_fs="$(dirname "$data_fs")/.migration-staging-$release_id"
        mkdir -m 0700 "$migration_state_staging_fs"
        ownership_acquire migration_state_staging_identity "$migration_state_staging_fs" directory; ownership_seal "$migration_state_staging_identity" "$migration_state_staging_fs"
        if publish_staged_migration_set; then
          exit 9
        fi
      `,
      { RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'migration-state-staging-success' },
    );
    const staging = join(root, 'var/lib/.migration-staging-successful-staging-cleanup');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Retained path after atomic cleanup detach');
    expect(readFileSync(join(staging, 'replacement'), 'utf8')).toBe('substituted\n');
  });

  it('retains substitutions at empty-topology current and previous branches, and failed-first-activation current cleanup', () => {
    const currentRoot = createRoot();
    const currentCleanup = runReleaseLibrary(
      currentRoot,
      'empty-topology-current',
      `
        source "$1"
        release_init
        install -d -m 0755 "$ROOT_PREFIX/opt/antigravity-proxy"
        ln -s /original-current "$ROOT_PREFIX/opt/antigravity-proxy/current"
        ln -s /original-previous "$ROOT_PREFIX/opt/antigravity-proxy/previous"
        if restore_release_topology '' ''; then
          exit 9
        fi
      `,
      {
        RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'empty-topology-release-link',
        RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: 'symlink',
      },
    );
    const current = join(currentRoot, 'opt/antigravity-proxy/current');

    expect(currentCleanup.status).toBe(0);
    expect(currentCleanup.stderr).toContain(`Retained path after atomic cleanup detach: ${current}`);
    expect(execFileSync('readlink', [current], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');
    expect(execFileSync('readlink', [join(currentRoot, 'opt/antigravity-proxy/previous')], { encoding: 'utf8' }).trim()).toBe(
      '/original-previous',
    );

    const previousRoot = createRoot();
    const previousCleanup = runReleaseLibrary(
      previousRoot,
      'empty-topology-previous',
      `
        source "$1"
        release_init
        install -d -m 0755 "$ROOT_PREFIX/opt/antigravity-proxy"
        ln -s /original-previous "$ROOT_PREFIX/opt/antigravity-proxy/previous"
        if restore_release_topology '' ''; then
          exit 9
        fi
      `,
      {
        RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'empty-topology-release-link',
        RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: 'symlink',
      },
    );
    const previous = join(previousRoot, 'opt/antigravity-proxy/previous');

    expect(previousCleanup.status).toBe(0);
    expect(previousCleanup.stderr).toContain(`Retained path after atomic cleanup detach: ${previous}`);
    expect(execFileSync('readlink', [previous], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');

    const activationRoot = createRoot();
    const activation = runInstall(activationRoot, 'failed-first-activation', 'install', {
      RELEASE_TEST_SMOKE: 'fail',
      RELEASE_TEST_CLEANUP_SUBSTITUTE_AFTER: 'failed-first-activation-current-link',
      RELEASE_TEST_CLEANUP_SUBSTITUTE_KIND: 'symlink',
    });
    const activationCurrent = join(activationRoot, 'opt/antigravity-proxy/current');

    expect(activation.status).toBe(1);
    expect(activation.stderr).toContain(`Retained path after atomic cleanup detach: ${activationCurrent}`);
    expect(execFileSync('readlink', [activationCurrent], { encoding: 'utf8' }).trim()).toBe('/retained-cleanup-substitution');
  });

  it('removes only the candidate staging directory when pre-switch probing fails', () => {
    const root = createRoot();
    const result = runInstall(root, 'failed-probe', 'install', { RELEASE_TEST_RUNTIME_PROBE: 'fail' });
    const releasesPath = join(root, 'opt/antigravity-proxy/releases');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Release runtime probe was forced to fail');
    expect(existsSync(join(releasesPath, '.staging-failed-probe'))).toBe(false);
    expect(existsSync(join(releasesPath, 'failed-probe'))).toBe(false);
    expect(existsSync(join(root, 'opt/antigravity-proxy/current'))).toBe(false);
    expect(existsSync(join(root, 'opt/antigravity-proxy/previous'))).toBe(false);
  });

  interface SmokeShimOptions {
    healthDelayedAttempts?: number;
    healthCode?: string;
    adminCode?: string;
    failRelease?: string;
    adminFailRelease?: string;
    systemctlPid?: string;
    systemctlUser?: string;
    systemctlActiveState?: string;
    systemctlNotEnabled?: boolean;
    systemctlNotActive?: boolean;
    ssPid?: string;
    ssDropListener?: boolean;
  }

  function setupRealSmokeShims(root: string, options: SmokeShimOptions = {}) {
    const binDir = join(root, 'shims/bin');
    const stateDir = join(root, 'shims/state');
    execFileSync('mkdir', ['-p', binDir, stateDir]);

    if (options.healthDelayedAttempts !== undefined) {
      writeFileSync(join(stateDir, 'health-delayed-until'), String(options.healthDelayedAttempts));
    }
    if (options.healthCode !== undefined) {
      writeFileSync(join(stateDir, 'health-code'), options.healthCode);
    }
    if (options.adminCode !== undefined) {
      writeFileSync(join(stateDir, 'admin-code'), options.adminCode);
    }
    if (options.failRelease !== undefined) {
      writeFileSync(join(stateDir, 'fail-release'), options.failRelease);
    }
    if (options.adminFailRelease !== undefined) {
      writeFileSync(join(stateDir, 'admin-fail-release'), options.adminFailRelease);
    }
    if (options.systemctlPid !== undefined) {
      writeFileSync(join(stateDir, 'systemctl-pid'), options.systemctlPid);
    }
    if (options.systemctlUser !== undefined) {
      writeFileSync(join(stateDir, 'systemctl-user'), options.systemctlUser);
    }
    if (options.systemctlActiveState !== undefined) {
      writeFileSync(join(stateDir, 'systemctl-active-state'), options.systemctlActiveState);
    }
    if (options.systemctlNotEnabled) writeFileSync(join(stateDir, 'systemctl-not-enabled'), '1');
    if (options.systemctlNotActive) writeFileSync(join(stateDir, 'systemctl-not-active'), '1');
    if (options.ssPid !== undefined) writeFileSync(join(stateDir, 'ss-pid'), options.ssPid);
    if (options.ssDropListener) writeFileSync(join(stateDir, 'ss-drop-listener'), '1');
    const caDir = join(root, 'var/lib/antigravity-proxy/certs');
    mkdirSync(caDir, { recursive: true });
    writeFileSync(join(caDir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----\n');

    writeFileSync(
      join(binDir, 'curl'),
      `#!/usr/bin/env bash
url="\${!#}"
state_dir="${stateDir}"

if [[ "$url" == *"/health" ]]; then
  attempt=0
  if [ -f "$state_dir/health-attempts" ]; then
    attempt=$(<"$state_dir/health-attempts")
  fi
  attempt=$((attempt + 1))
  echo "$attempt" > "$state_dir/health-attempts"

  current_release=""
  if [ -L "${root}/opt/antigravity-proxy/current" ]; then
    current_release="$(basename "$(readlink -f "${root}/opt/antigravity-proxy/current")")"
  fi

  if [ -f "$state_dir/fail-release" ] && [ "$current_release" = "$(<"$state_dir/fail-release")" ]; then
    printf '000'
    exit 7
  fi

  if [ -f "$state_dir/health-delayed-until" ]; then
    delayed_until=$(<"$state_dir/health-delayed-until")
    if [ "$attempt" -lt "$delayed_until" ]; then
      printf '000'
      exit 7
    fi
  fi

  if [ -f "$state_dir/health-code" ]; then
    code=$(<"$state_dir/health-code")
    [ "$code" = "000" ] && { printf '000'; exit 7; }
    printf '%s' "$code"; exit 0
  fi
  out_f="" prev=""
  for a in "$@"; do [ "$prev" = "--output" ] && out_f="$a"; prev="$a"; done
  [ -n "$out_f" ] && printf '{"ok":true,"connect_ready":true}' > "$out_f"
  printf '200'; exit 0
fi

if [[ "$url" == *"/admin/status" ]]; then
  current_release=""
  if [ -L "${root}/opt/antigravity-proxy/current" ]; then
    current_release="$(basename "$(readlink -f "${root}/opt/antigravity-proxy/current")")"
  fi

  if [ -f "$state_dir/admin-code" ]; then
    printf '%s' "$(<"$state_dir/admin-code")"
    exit 0
  fi

  if [ -f "$state_dir/admin-fail-release" ] && [ "$current_release" = "$(<"$state_dir/admin-fail-release")" ]; then
    printf '200'
    exit 0
  fi

  printf '401'
  exit 0
fi

if [[ "$url" == *"cloudcode-pa.googleapis.com"* ]]; then
  [ -f "$state_dir/connect-fail" ] && exit 56
  exit 0
fi

exec /usr/bin/curl "$@"
`,
    );
    chmodSync(join(binDir, 'curl'), 0o755);

    writeFileSync(
      join(binDir, 'ss'),
      `#!/usr/bin/env bash
state_dir="${stateDir}"
port="8045"
host="127.0.0.1"

if [ -f "$state_dir/ss-drop-listener" ]; then
  exit 0
fi

pid="4242"
if [ -f "$state_dir/ss-pid" ]; then
  pid=$(<"$state_dir/ss-pid")
elif [ -f "$state_dir/systemctl-pid" ]; then
  pid=$(<"$state_dir/systemctl-pid")
fi

case "$*" in
  *-ltnpH*)
    printf 'LISTEN 0 511 %s:%s 0.0.0.0:* users:(("node",pid=%s,fd=18))\\n' "$host" "$port" "$pid"
    ;;
  *-ltnH*)
    printf 'LISTEN 0 511 %s:%s 0.0.0.0:*\\n' "$host" "$port"
    ;;
  *)
    exec /usr/bin/ss "$@"
    ;;
esac
`,
    );
    chmodSync(join(binDir, 'ss'), 0o755);

    writeFileSync(
      join(binDir, 'systemctl'),
      `#!/usr/bin/env bash
state_dir="${stateDir}"

case "$1" in
  show)
    case "$2" in
      --property=ActiveState*)
        if [ -f "$state_dir/systemctl-active-state" ]; then
          cat "$state_dir/systemctl-active-state"
        else
          printf 'active\\n'
        fi
        ;;
      --property=MainPID*)
        if [ -f "$state_dir/systemctl-pid" ]; then
          cat "$state_dir/systemctl-pid"
        else
          printf '4242\\n'
        fi
        ;;
      --property=User*)
        if [ -f "$state_dir/systemctl-user" ]; then
          cat "$state_dir/systemctl-user"
        else
          printf 'antigravity-proxy\\n'
        fi
        ;;
      *)
        printf '\\n'
        ;;
    esac
    ;;
  is-enabled)
    if [ -f "$state_dir/systemctl-not-enabled" ]; then
      exit 1
    fi
    exit 0
    ;;
  is-active)
    if [ -f "$state_dir/systemctl-not-active" ]; then
      exit 1
    fi
    exit 0
    ;;
  daemon-reload|restart|enable|disable)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    );
    chmodSync(join(binDir, 'systemctl'), 0o755);

    return {
      binDir,
      stateDir,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        RELEASE_TEST_SMOKE: 'real',
        SMOKE_POLL_INTERVAL_SECS: '0.01',
      },
      getHealthAttempts: () => {
        const attemptsPath = join(stateDir, 'health-attempts');
        return existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, 'utf8').trim()) : 0;
      },
    };
  }

  it('tolerates transient connection refusal during startup readiness and succeeds once ready', () => {
    const root = createRoot();
    const shims = setupRealSmokeShims(root, { healthDelayedAttempts: 3 });
    const result = runInstall(root, 'delayed-start-success', 'install', shims.env);

    expect(result.status).toBe(0);
    expect(shims.getHealthAttempts()).toBeGreaterThanOrEqual(3);
    expect(realpathSync(join(root, 'opt/antigravity-proxy/current'))).toBe(
      join(root, 'opt/antigravity-proxy/releases/delayed-start-success'),
    );
  }, 30_000);

  it('fails when startup readiness times out due to persistent connection refusal', () => {
    const root = createRoot();
    const shims = setupRealSmokeShims(root, { healthCode: '000' });
    const result = runInstall(root, 'unready-timeout', 'install', {
      ...shims.env,
      SMOKE_TIMEOUT_SECS: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Startup readiness timed out after 1 seconds');
    expect(existsSync(join(root, 'opt/antigravity-proxy/current'))).toBe(false);
  }, 30_000);

  it('fails immediately without masking on wrong admin auth status or wrong socket ownership', () => {
    const rootBadAuth = createRoot();
    const shimsBadAuth = setupRealSmokeShims(rootBadAuth, { adminCode: '200' });
    const resultBadAuth = runInstall(rootBadAuth, 'bad-admin-auth', 'install', shimsBadAuth.env);
    expect(resultBadAuth.status).toBe(1);
    expect(resultBadAuth.stderr).toContain('Unauthenticated admin endpoint returned unexpected HTTP 200');

    const rootWrongPid = createRoot();
    const shimsWrongPid = setupRealSmokeShims(rootWrongPid, { ssPid: '99999' });
    const resultWrongPid = runInstall(rootWrongPid, 'wrong-socket-pid', 'install', shimsWrongPid.env);
    expect(resultWrongPid.status).toBe(1);
    expect(resultWrongPid.stderr).toContain('Systemd MainPID 4242 does not own listener 127.0.0.1:8045');

    const rootWrongUser = createRoot();
    const shimsWrongUser = setupRealSmokeShims(rootWrongUser, { systemctlUser: 'wrong-user' });
    const resultWrongUser = runInstall(rootWrongUser, 'wrong-service-user', 'install', shimsWrongUser.env);
    expect(resultWrongUser.status).toBe(1);
    expect(resultWrongUser.stderr).toContain(
      'Systemd service user wrong-user does not match expected user antigravity-proxy',
    );
  }, 30_000);

  it('restores previous release topology, matching unit, and succeeds recovery when update smoke check fails', () => {
    const root = createRoot();
    expect(runInstall(root, 'release-one').status).toBe(0);
    expect(runInstall(root, 'release-two', 'update').status).toBe(0);

    const installRoot = join(root, 'opt/antigravity-proxy');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/release-two'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/release-one'));

    const shims = setupRealSmokeShims(root, { failRelease: 'release-three' });
    const failedUpdate = runInstall(root, 'release-three', 'update', {
      ...shims.env,
      SMOKE_TIMEOUT_SECS: '1',
    });

    expect(failedUpdate.status).toBe(1);
    expect(failedUpdate.stderr).toContain('Release release-three failed smoke checks; previous release was restored');
    expect(failedUpdate.stderr).not.toContain('Migration publication rollback was incomplete');

    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/release-two'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/release-one'));

    const unit = readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8');
    expect(unit).toContain('ExecStart=/opt/antigravity-proxy/current/bin/node /opt/antigravity-proxy/current/dist/cli.js serve');
  }, 30_000);

  it('restores prior release topology, matching unit, and succeeds recovery when rollback smoke check fails', () => {
    const root = createRoot();
    expect(runInstall(root, 'release-one').status).toBe(0);
    expect(runInstall(root, 'release-two', 'update').status).toBe(0);

    const installRoot = join(root, 'opt/antigravity-proxy');
    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/release-two'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/release-one'));

    const shims = setupRealSmokeShims(root, { failRelease: 'release-one' });
    const failedRollback = runRollback(root, 'release-one', {
      ...shims.env,
      SMOKE_TIMEOUT_SECS: '1',
    });

    expect(failedRollback.status).toBe(1);
    expect(failedRollback.stderr).toContain('Rollback to release release-one failed smoke checks; prior release topology was restored');

    expect(realpathSync(join(installRoot, 'current'))).toBe(join(installRoot, 'releases/release-two'));
    expect(realpathSync(join(installRoot, 'previous'))).toBe(join(installRoot, 'releases/release-one'));

    const unit = readFileSync(join(root, 'etc/systemd/system/antigravity-proxy.service'), 'utf8');
    expect(unit).toContain('ExecStart=/opt/antigravity-proxy/current/bin/node /opt/antigravity-proxy/current/dist/cli.js serve');
  }, 30_000);

  it('T17-F02 Probe C04: Failed rollback unit restore preserves both concurrent replacement and previous backup', () => {
    const root = createRoot();
    execFileSync(
      'bash',
      [
        '-c',
        `
          set -eu
          export ROOT_PREFIX="${root}"
          source scripts/release-lib.sh
          root_prefix="$ROOT_PREFIX"; ownership_init

          unit_file="/etc/systemd/system/antigravity-proxy.service"
          unit_fs="$(root_path "$unit_file")"
          mkdir -p "$(dirname "$unit_fs")"
          mkdir -p "$ROOT_PREFIX/backup"

          migration_unit_backup_fs="$ROOT_PREFIX/backup/unit.backup"
          printf "PRIOR_BACKUP\\n" > "$migration_unit_backup_fs"
          ownership_acquire migration_unit_backup_identity "$migration_unit_backup_fs" file
          migration_unit_published_identity="published-identity-123"
          migration_unit_had_file=1
          migration_unit_rename_completed=1

          rm -f "$unit_fs"

          eval "quarantine_owned_path_real() $(declare -f quarantine_owned_path | tail -n +2)"
          quarantine_owned_path() {
            local target="$1"
            if [ "$target" = "$unit_fs" ]; then
              printf "CONCURRENT_REPLACEMENT\\n" > "$unit_fs"
              return 2
            fi
            quarantine_owned_path_real "$@"
          }

          set +e
          restore_migration_unit_state
          status=$?
          set -e

          [ "$status" -eq 1 ] || exit 10
          [ "$(cat "$unit_fs")" = "CONCURRENT_REPLACEMENT" ] || exit 11
          [ "$(cat "$migration_unit_backup_fs")" = "PRIOR_BACKUP" ] || exit 12
        `,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
  });

  it('T17-F02 Probe C05: Failed rollback wants restore preserves both concurrent replacement and previous backup', () => {
    const root = createRoot();
    execFileSync(
      'bash',
      [
        '-c',
        `
          set -eu
          export ROOT_PREFIX="${root}"
          source scripts/release-lib.sh
          root_prefix="$ROOT_PREFIX"; ownership_init

          migration_wants_fs="$ROOT_PREFIX/etc/systemd/system/multi-user.target.wants/antigravity-proxy.service"
          mkdir -p "$(dirname "$migration_wants_fs")"
          mkdir -p "$ROOT_PREFIX/backup"

          migration_wants_backup_fs="$ROOT_PREFIX/backup/wants.backup"
          ln -s "/prior/target" "$migration_wants_backup_fs"
          ownership_acquire migration_wants_backup_identity "$migration_wants_backup_fs" link
          migration_wants_published_identity="published-wants-id-123"
          migration_wants_had_entry=1

          rm -f "$migration_wants_fs"

          eval "quarantine_owned_path_real() $(declare -f quarantine_owned_path | tail -n +2)"
          quarantine_owned_path() {
            local target="$1"
            if [ "$target" = "$migration_wants_fs" ]; then
              ln -s "/concurrent/replacement" "$migration_wants_fs"
              return 2
            fi
            quarantine_owned_path_real "$@"
          }

          set +e
          restore_migration_wants_state
          status=$?
          set -e

          [ "$status" -eq 1 ] || exit 20
          [ "$(readlink "$migration_wants_fs")" = "/concurrent/replacement" ] || exit 21
          [ "$(readlink "$migration_wants_backup_fs")" = "/prior/target" ] || exit 22
        `,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
  });
});
