import fs from 'node:fs';
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager, ConfigPersistenceError } from '@/modules/config/ipc/manager';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const environmentKeys = [
  'AG_PROXY_DATA_DIR',
  'AG_PROXY_API_KEY',
  'AG_PROXY_ADMIN_API_KEY',
  'AG_PROXY_HOST',
  'AG_PROXY_PORT',
] as const;

describe('preferred account config persistence', () => {
  let dataDir: string;
  let originalEnvironment: Map<string, string | undefined>;

  function getConfigPath(): string {
    return path.join(dataDir, 'config.json');
  }

  function getLockPath(): string {
    return path.join(dataDir, '.config.json.lock');
  }

  function setPreferredAccountInChild(accountId: string): Promise<void> {
    const managerUrl = pathToFileURL(path.join(process.cwd(), 'src/modules/config/ipc/manager.ts')).href;
    const source = `import { ConfigManager } from ${JSON.stringify(managerUrl)}; await ConfigManager.setPreferredAccount(${JSON.stringify(accountId)});`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: process.cwd(),
        env: { ...process.env, AG_PROXY_DATA_DIR: dataDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Preferred account child failed (${code ?? 'signal'}): ${stderr}`));
      });
    });
  }

  function terminateLockHolder(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) {
      throw new Error('Lock holder did not expose a PID');
    }
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === null && signal === 'SIGKILL') {
          resolve();
          return;
        }
        reject(new Error(`Lock holder did not stop abruptly (${code ?? 'signal'} / ${signal ?? 'none'})`));
      });
      if (!child.kill('SIGKILL')) {
        reject(new Error(`Unable to terminate lock holder PID ${child.pid}`));
      }
    });
  }

  function startLockHolder(): Promise<ChildProcess> {
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'umask 077; exec 3>"$1"; flock -x 3 || exit; printf "locked\\n"; exec cat >/dev/null',
        'lock-holder',
        getLockPath(),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error('Unable to observe lock-holding writer process');
    }
    return new Promise((resolve, reject) => {
      let errorOutput = '';
      stderr.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (code) => {
        reject(new Error(`Lock-holding writer exited early (${code ?? 'signal'}): ${errorOutput}`));
      });
      stdout.once('data', (chunk: Buffer) => {
        if (chunk.toString() === 'locked\n') {
          resolve(child);
          return;
        }
        reject(new Error(`Unexpected lock-holding writer output: ${chunk.toString()}`));
      });
    });
  }

  function waitForLockHolderExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))));
    });
  }

  function createLockHelperThatNeverReleases(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          Object.assign(child, { signalCode: 'SIGKILL' });
          child.emit('close', null, 'SIGKILL');
        });
      }
      return true;
    });
    stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().startsWith('publish ')) {
        stdout.write('committed\n');
      }
    });
    queueMicrotask(() => stdout.write('locked\n'));
    return child;
  }

  function createLockHelperThatExitsAfterHandshake(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
    queueMicrotask(() => {
      stdout.write('locked\n');
      Object.assign(child, { exitCode: 1, signalCode: null });
      child.emit('close', 1, null);
    });
    return child;
  }

  function createLockHelperThatFailsPublication(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
    stdin.once('data', () => {
      Object.assign(child, { exitCode: 1, signalCode: null });
      child.emit('close', 1, null);
    });
    queueMicrotask(() => stdout.write('locked\n'));
    return child;
  }

  function createLockHelperThatPublishes(publish: (temporaryName: string) => void): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
    stdin.once('data', (chunk: Buffer) => {
      publish(chunk.toString().trim().replace(/^publish /, ''));
      stdout.write('committed\n');
    });
    stdin.once('end', () => {
      Object.assign(child, { exitCode: 0, signalCode: null });
      child.emit('close', 0, null);
    });
    queueMicrotask(() => stdout.write('locked\n'));
    return child;
  }

  function createLockHelperWithPostHandshakeFailure(
    failure: 'control error' | 'stdout close' | 'stderr close',
  ): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => {
          Object.assign(child, { exitCode: null, signalCode: 'SIGTERM' });
          child.emit('close', null, 'SIGTERM');
        });
      }
      return true;
    });
    queueMicrotask(() => {
      stdout.write('locked\n');
      if (failure === 'control error') {
        stdin.destroy(new Error('simulated control pipe failure'));
      } else if (failure === 'stdout close') {
        stdout.destroy();
      } else {
        stderr.destroy();
      }
    });
    return child;
  }

  function createLockHelperThatPublishesThenExits(publish: (temporaryName: string) => void): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
    stdin.once('data', (chunk: Buffer) => {
      publish(chunk.toString().trim().replace(/^publish /, ''));
      Object.assign(child, { exitCode: 1, signalCode: null });
      child.emit('close', 1, null);
    });
    queueMicrotask(() => stdout.write('locked\n'));
    return child;
  }

  function runLockHelper(helperArguments: string[], input: string): string {
    const lockDescriptor = fs.openSync(getLockPath(), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    const directoryDescriptor = fs.openSync(
      dataDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      return execFileSync('/bin/sh', helperArguments, {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe', lockDescriptor, directoryDescriptor],
      });
    } finally {
      fs.closeSync(directoryDescriptor);
      fs.closeSync(lockDescriptor);
    }
  }

  function runLockHelperCapture(helperArguments: string[], input: string) {
    const lockDescriptor = fs.openSync(getLockPath(), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    const directoryDescriptor = fs.openSync(
      dataDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      return spawnSync('/bin/sh', helperArguments, {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe', lockDescriptor, directoryDescriptor],
      });
    } finally {
      fs.closeSync(directoryDescriptor);
      fs.closeSync(lockDescriptor);
    }
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-proxy-config-test-'));
    originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    process.env.AG_PROXY_DATA_DIR = dataDir;
    process.env.AG_PROXY_API_KEY = 'environment-proxy-key';
    process.env.AG_PROXY_ADMIN_API_KEY = 'environment-admin-key';
    process.env.AG_PROXY_HOST = '192.0.2.44';
    process.env.AG_PROXY_PORT = '9876';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('updates only the file-backed preferred account while preserving unknown fields', async () => {
    const configPath = getConfigPath();
    const originalConfig = {
      config_version: 9,
      future_top_level: { enabled: true },
      proxy: {
        api_key: 'file-proxy-key',
        admin_api_key: 'file-admin-key',
        scheduling_mode: 'cache-first',
        future_proxy_field: { retry_budget: 3 },
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`, 'utf8');
    fs.chmodSync(configPath, 0o640);

    await ConfigManager.setPreferredAccount('acc-2');

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      ...originalConfig,
      proxy: {
        ...originalConfig.proxy,
        preferred_account_id: 'acc-2',
      },
    });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('environment-proxy-key');
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('environment-admin-key');
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('192.0.2.44');
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('9876');
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o640);
  });

  it('creates a new preferred account config with restrictive permissions', async () => {
    const configPath = getConfigPath();

    await ConfigManager.setPreferredAccount('acc-1');

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      proxy: { preferred_account_id: 'acc-1' },
    });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['.config.json.lock', 'config.json']);
  });

  it('leaves the original config bytes unchanged and cleans up the temporary file on a failed publication', async () => {
    const configPath = getConfigPath();
    const originalContents = '{\n  "proxy": {\n    "preferred_account_id": "acc-1"\n  }\n}\n';
    fs.writeFileSync(configPath, originalContents, 'utf8');
    vi.mocked(spawn).mockImplementationOnce(() => createLockHelperThatFailsPublication());

    await expect(ConfigManager.setPreferredAccount('acc-2')).rejects.toMatchObject({ committed: false });

    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContents);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['.config.json.lock', 'config.json']);
  });

  it('keeps the opened directory anchored when its configured parent entry is replaced', async () => {
    const configPath = getConfigPath();
    const displacedDataDir = `${dataDir}-displaced`;
    const replacementContents = '{"proxy":{"preferred_account_id":"replacement"}}\n';
    fs.writeFileSync(configPath, '{"proxy":{"future_field":"preserved"}}\n', 'utf8');
    const originalOpen = fs.openSync;
    let replaced = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const descriptor = originalOpen(...args);
      if (!replaced && args[0] === dataDir) {
        fs.renameSync(dataDir, displacedDataDir);
        fs.mkdirSync(dataDir, { mode: 0o700 });
        fs.writeFileSync(getConfigPath(), replacementContents, 'utf8');
        replaced = true;
      }
      return descriptor;
    });

    await ConfigManager.setPreferredAccount('acc-2');

    expect(replaced).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(displacedDataDir, 'config.json'), 'utf8'))).toMatchObject({
      proxy: { future_field: 'preserved', preferred_account_id: 'acc-2' },
    });
    expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(replacementContents);
    fs.rmSync(displacedDataDir, { recursive: true, force: true });
  });

  it('rejects a symlinked configured data directory without following it', async () => {
    const linkedDataDir = `${dataDir}-link`;
    fs.symlinkSync(dataDir, linkedDataDir, 'dir');
    process.env.AG_PROXY_DATA_DIR = linkedDataDir;

    await expect(ConfigManager.setPreferredAccount('acc-1')).rejects.toThrow('Unsafe proxy configuration path');
    expect(fs.readdirSync(dataDir)).toEqual([]);

    fs.unlinkSync(linkedDataDir);
  });

  it('rejects a data directory that is accessible to other users', async () => {
    fs.chmodSync(dataDir, 0o755);

    await expect(ConfigManager.setPreferredAccount('acc-1')).rejects.toThrow(
      'Unsafe proxy configuration directory permissions',
    );
  });

  it.each(['symlink', 'directory', 'insecure permissions'])(
    'rejects a %s lock artifact before mutating config or an external file',
    async (artifact) => {
      const configPath = getConfigPath();
      const outsidePath = path.join(dataDir, 'outside.json');
      const originalConfig = '{"proxy":{"future_proxy_field":"preserved"}}\n';
      const outsideContents = '{"opaque":"outside-value"}\n';
      fs.writeFileSync(configPath, originalConfig, 'utf8');
      fs.writeFileSync(outsidePath, outsideContents, 'utf8');

      if (artifact === 'symlink') {
        fs.symlinkSync(outsidePath, getLockPath());
      } else if (artifact === 'directory') {
        fs.mkdirSync(getLockPath());
      } else {
        fs.writeFileSync(getLockPath(), '', { mode: 0o666 });
        fs.chmodSync(getLockPath(), 0o666);
      }

      await expect(ConfigManager.setPreferredAccount('acc-2')).rejects.toThrow(
        'Unsafe proxy configuration lock',
      );
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
      expect(fs.readFileSync(outsidePath, 'utf8')).toBe(outsideContents);
    },
  );

  it('rejects a foreign-owned lock artifact before mutating config', async () => {
    const configPath = getConfigPath();
    const originalConfig = '{"proxy":{"future_proxy_field":"preserved"}}\n';
    fs.writeFileSync(configPath, originalConfig, 'utf8');
    fs.writeFileSync(getLockPath(), '', { mode: 0o600 });
    const originalLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target) => {
      const stats = originalLstat(target);
      if (!String(target).endsWith(`/${path.basename(getLockPath())}`)) {
        return stats;
      }
      const foreignOwnedStats = Object.create(stats) as fs.Stats;
      Object.defineProperty(foreignOwnedStats, 'uid', { value: stats.uid + 1 });
      return foreignOwnedStats;
    });

    await expect(ConfigManager.setPreferredAccount('acc-2')).rejects.toThrow(
      'Unsafe proxy configuration lock ownership',
    );
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('fails closed before mutating files when Linux anchoring is unavailable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      await expect(ConfigManager.setPreferredAccount('acc-1')).rejects.toThrow('only supported on Linux');
      expect(fs.readdirSync(dataDir)).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor as PropertyDescriptor);
    }
  });

  it('rejects a symlinked config file without reading or replacing its target', async () => {
    const configPath = getConfigPath();
    const outsidePath = path.join(dataDir, 'outside.json');
    const outsideContents = '{"opaque":"outside-value"}\n';
    fs.writeFileSync(outsidePath, outsideContents, 'utf8');
    fs.symlinkSync(outsidePath, configPath);

    await expect(ConfigManager.setPreferredAccount('acc-1')).rejects.toThrow('Unsafe proxy configuration entry');
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe(outsideContents);
  });

  it('rejects non-regular config entries', async () => {
    fs.mkdirSync(getConfigPath());

    await expect(ConfigManager.setPreferredAccount('acc-1')).rejects.toThrow('Unsafe proxy configuration entry');
  });

  it('rejects a substituted temporary entry and leaves the original config unchanged', async () => {
    const configPath = getConfigPath();
    const originalContents = '{"proxy":{"preferred_account_id":"acc-1"}}\n';
    const outsidePath = path.join(dataDir, 'outside.json');
    fs.writeFileSync(configPath, originalContents, 'utf8');
    fs.writeFileSync(outsidePath, '{"opaque":"outside-value"}\n', 'utf8');
    const originalFsync = fs.fsyncSync;
    let substituted = false;

    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      originalFsync(descriptor);
      if (substituted) {
        return;
      }
      const temporaryName = fs.readdirSync(dataDir).find((entry) => entry.endsWith('.tmp'));
      if (!temporaryName) {
        return;
      }
      const temporaryPath = path.join(dataDir, temporaryName);
      fs.unlinkSync(temporaryPath);
      fs.symlinkSync(outsidePath, temporaryPath);
      substituted = true;
    });

    await expect(ConfigManager.setPreferredAccount('acc-2')).rejects.toThrow(
      'Temporary proxy configuration was replaced',
    );
    expect(substituted).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContents);
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe('{"opaque":"outside-value"}\n');
  });

  it('keeps the exclusive temporary descriptor open through helper-owned atomic publication', async () => {
    const configPath = getConfigPath();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalRename = fs.renameSync;
    let temporaryDescriptor: number | undefined;
    const closedDescriptors = new Set<number>();
    let published = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const descriptor = originalOpen(...args);
      closedDescriptors.delete(descriptor);
      if (String(args[0]).endsWith('.tmp')) {
        temporaryDescriptor = descriptor;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      closedDescriptors.add(descriptor);
      originalClose(descriptor);
    });
    vi.mocked(spawn).mockImplementationOnce(() =>
      createLockHelperThatPublishes((temporaryName) => {
        expect(temporaryDescriptor).toBeTypeOf('number');
        expect(closedDescriptors.has(temporaryDescriptor as number)).toBe(false);
        originalRename(path.join(dataDir, temporaryName), configPath);
        published = true;
      }),
    );

    await ConfigManager.setPreferredAccount('acc-2');

    expect(published).toBe(true);
    expect(fs.readdirSync(dataDir)).not.toContain(expect.stringMatching(/\.commit$/));
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it('binds direct helper publication to its exact owned temporary basename', async () => {
    let helperArguments: string[] | undefined;
    vi.mocked(spawn).mockImplementationOnce((command, arguments_) => {
      if (command === '/bin/sh' && Array.isArray(arguments_)) {
        helperArguments = [...arguments_];
      }
      return createLockHelperThatPublishes(() => undefined);
    });

    await ConfigManager.setPreferredAccount('acc-2');

    expect(helperArguments).toBeDefined();
    const expectedName = helperArguments?.at(-1);
    expect(expectedName).toMatch(/^\.config\.json\.[0-9a-f-]{36}\.tmp$/);
    const helperArgumentsForTest = helperArguments as string[];
    const configPath = getConfigPath();
    const expectedContents = '{"proxy":{"preferred_account_id":"exact"}}\n';
    fs.writeFileSync(path.join(dataDir, expectedName as string), expectedContents, 'utf8');

    expect(runLockHelper(helperArgumentsForTest, `publish ${expectedName}\n`)).toBe('locked\ncommitted\n');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(expectedContents);

    const originalContents = '{"proxy":{"preferred_account_id":"original"}}\n';
    const stagedContents = '{"proxy":{"preferred_account_id":"staged"}}\n';
    const foreignPath = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-foreign.tmp`);
    const foreignContents = 'foreign bytes must not move\n';
    const traversalDirectory = path.join(dataDir, '.config.json.attacker.tmp');
    fs.writeFileSync(configPath, originalContents, 'utf8');
    fs.writeFileSync(path.join(dataDir, expectedName as string), stagedContents, 'utf8');
    fs.mkdirSync(traversalDirectory);
    fs.writeFileSync(foreignPath, foreignContents, 'utf8');

    try {
      for (const command of [
        'publish ',
        `publish ${expectedName} `,
        `publish ${expectedName}\textra`,
        `publish ${expectedName}\r`,
        `publish ${expectedName}\u00a0`,
        `publish ${expectedName}; true`,
        'publish .config.json.11111111-1111-1111-1111-111111111111.tmp',
        'publish ../foreign.tmp',
        'publish /foreign.tmp',
        'publish .config.json.attacker.tmp/nested.tmp',
        `publish .config.json.attacker.tmp/../../${path.basename(foreignPath)}`,
      ]) {
        expect(() => runLockHelper(helperArgumentsForTest, `${command}\n`)).toThrow();
        expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContents);
        expect(fs.readFileSync(foreignPath, 'utf8')).toBe(foreignContents);
      }

      const firstWriter = await startLockHolder();
      try {
        for (const malformedName of [
          '.config.json.gggggggg-gggg-gggg-gggg-gggggggggggg.tmp',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaA.tmp',
          '.config.json.aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp',
          '.config.json.aaaaaaaa_aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp.extra',
          '.other.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp ',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp\r',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp\n',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp\u00a0',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp;true',
          '/tmp/.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp',
          '../.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp',
          '.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp/nested',
          `.config.json.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp/../../${path.basename(foreignPath)}`,
        ]) {
          const startedAt = Date.now();
          const result = runLockHelperCapture(
            [...helperArgumentsForTest.slice(0, -1), malformedName],
            `publish ${expectedName}\n`,
          );

          expect(Date.now() - startedAt).toBeLessThan(200);
          expect(result.status).not.toBe(0);
          expect(result.stdout).toBe('');
          expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContents);
          expect(fs.readFileSync(path.join(dataDir, expectedName as string), 'utf8')).toBe(stagedContents);
          expect(fs.readFileSync(foreignPath, 'utf8')).toBe(foreignContents);
          expect(firstWriter.exitCode).toBeNull();
        }
      } finally {
        const firstWriterExit = waitForLockHolderExit(firstWriter);
        firstWriter.stdin?.end();
        await firstWriterExit;
      }
    } finally {
      fs.rmSync(foreignPath, { force: true });
    }
  });

  it('serializes a confirmed lock-holding child writer with a second real writer', async () => {
    const configPath = getConfigPath();
    fs.writeFileSync(
      configPath,
      '{"future_top_level":{"enabled":true},"proxy":{"future_proxy_field":"preserved"}}\n',
      'utf8',
    );

    const firstWriter = await startLockHolder();
    let secondWriterFinished = false;
    const secondWriter = setPreferredAccountInChild('acc-2').then(() => {
      secondWriterFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondWriterFinished).toBe(false);
    const firstWriterExit = waitForLockHolderExit(firstWriter);
    firstWriter.stdin?.end();
    await firstWriterExit;
    await secondWriter;

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted).toMatchObject({
      future_top_level: { enabled: true },
      proxy: { future_proxy_field: 'preserved', preferred_account_id: 'acc-2' },
    });
  });

  it('bounds a real competing lock acquisition without publishing, then succeeds after the holder exits', async () => {
    fs.writeFileSync(getConfigPath(), '{"proxy":{"preferred_account_id":"initial"}}\n', 'utf8');
    const firstWriter = await startLockHolder();
    const timeout = Symbol('acquisition timeout');
    const startedAt = Date.now();

    try {
      const outcome = await Promise.race([
        ConfigManager.setPreferredAccount('acc-2').then(
          () => undefined,
          (error: unknown) => error,
        ),
        new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 750)),
      ]);

      expect(outcome).not.toBe(timeout);
      expect(Date.now() - startedAt).toBeLessThan(750);
      expect(outcome).toBeInstanceOf(ConfigPersistenceError);
      expect(outcome).toMatchObject({ committed: false });
      expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
        proxy: { preferred_account_id: 'initial' },
      });
    } finally {
      const firstWriterExit = waitForLockHolderExit(firstWriter);
      firstWriter.stdin?.end();
      await firstWriterExit;
    }

    await ConfigManager.setPreferredAccount('acc-2');
    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it('forces termination of a lock helper that ignores release after committing', async () => {
    const helper = createLockHelperThatNeverReleases();
    vi.mocked(spawn).mockImplementationOnce(() => helper);
    const startedAt = Date.now();

    const timeout = Symbol('release timeout');
    const thrown = await Promise.race([
      ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 3_000)),
    ]);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(thrown).not.toBe(timeout);
    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: true });
    expect(helper.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(helper.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(helper.listenerCount('error')).toBe(0);
    expect(helper.listenerCount('close')).toBe(0);
    expect(helper.stdout?.listenerCount('data')).toBe(0);
    expect(helper.stderr?.listenerCount('data')).toBe(0);
  });

  it('fails closed when the helper exits after handshake and a later writer can acquire the lock', async () => {
    const configPath = getConfigPath();
    const originalContents = '{\n  "proxy": {\n    "preferred_account_id": "initial"\n  }\n}\n';
    fs.writeFileSync(configPath, originalContents, 'utf8');
    fs.chmodSync(configPath, 0o640);
    vi.mocked(spawn).mockImplementationOnce(() => createLockHelperThatExitsAfterHandshake());

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: false });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContents);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o640);
    expect(ConfigManager.loadConfig().proxy.preferred_account_id).toBe('initial');
    expect(fs.readdirSync(dataDir)).not.toContain(expect.stringMatching(/\.tmp$/));

    await ConfigManager.setPreferredAccount('acc-2');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it.each(['control error', 'stdout close', 'stderr close'] as const)(
    'fails closed when helper %s occurs after handshake',
    async (failure) => {
      const configPath = getConfigPath();
      const originalContents = '{"proxy":{"preferred_account_id":"initial"}}\n';
      fs.writeFileSync(configPath, originalContents, 'utf8');
      vi.mocked(spawn).mockImplementationOnce(() => createLockHelperWithPostHandshakeFailure(failure));

      const thrown = await Promise.race([
        ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error),
        new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol('timeout')), 5_000)),
      ]);

      expect(thrown).toBeInstanceOf(ConfigPersistenceError);
      expect(thrown).toMatchObject({ committed: false });
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContents);
      expect(fs.readdirSync(dataDir)).not.toContain(expect.stringMatching(/\.tmp$/));

      await ConfigManager.setPreferredAccount('acc-2');
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
        proxy: { preferred_account_id: 'acc-2' },
      });
    },
  );

  it('reports an exact helper-owned rename as committed when the acknowledgement is lost', async () => {
    const configPath = getConfigPath();
    const originalRename = fs.renameSync;
    fs.writeFileSync(configPath, '{"proxy":{"preferred_account_id":"initial"}}\n', 'utf8');
    vi.mocked(spawn).mockImplementationOnce(() =>
      createLockHelperThatPublishesThenExits((temporaryName) => {
        originalRename(path.join(dataDir, temporaryName), configPath);
      }),
    );

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: true });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it('terminates the exact lock helper when closing its control pipe fails after committing', async () => {
    const helper = createLockHelperThatNeverReleases();
    const input = helper.stdin as PassThrough;
    vi.spyOn(input, 'end').mockImplementation(() => {
      throw new Error('simulated control pipe failure');
    });
    vi.mocked(spawn).mockImplementationOnce(() => helper);

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: true });
    expect(helper.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(helper.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(helper.listenerCount('error')).toBe(0);
    expect(helper.listenerCount('close')).toBe(0);
  });

  it.each([
    ['spawn error', () => {
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw new Error('simulated spawn error');
      });
    }],
    ['early helper exit', () => {
      vi.mocked(spawn).mockImplementationOnce(() => {
        const helper = new EventEmitter() as ChildProcess;
        Object.assign(helper, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(() => {
          Object.assign(helper, { exitCode: 1, signalCode: null });
          helper.emit('close', 1, null);
        });
        return helper;
      });
    }],
    ['invalid handshake', () => {
      vi.mocked(spawn).mockImplementationOnce(() => {
        const helper = new EventEmitter() as ChildProcess;
        const stdout = new PassThrough();
        Object.assign(helper, { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
        queueMicrotask(() => {
          stdout.write('not locked\n');
          Object.assign(helper, { exitCode: 0, signalCode: null });
          helper.emit('close', 0, null);
        });
        return helper;
      });
    }],
  ])('fails promptly and leaves no config change after %s', async (_scenario, arrange) => {
    fs.writeFileSync(getConfigPath(), '{"proxy":{"preferred_account_id":"initial"}}\n', 'utf8');
    arrange();
    const startedAt = Date.now();

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: false });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'initial' },
    });
  });

  it('releases the kernel lock after an abruptly terminated writer without stale cleanup', async () => {
    const lockHolder = await startLockHolder();
    try {
      await terminateLockHolder(lockHolder);
      await ConfigManager.setPreferredAccount('acc-2');
    } finally {
      if (lockHolder.exitCode === null && lockHolder.signalCode === null) {
        await terminateLockHolder(lockHolder);
      }
    }

    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it('reports a post-rename durability failure after committing the new config', async () => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, '{"proxy":{"preferred_account_id":"acc-1"}}\n', 'utf8');
    const originalFsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        throw new Error('simulated directory fsync failure');
      }
      originalFsync(descriptor);
    });

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: true });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it('reports a post-rename temporary descriptor close failure as committed', async () => {
    const configPath = getConfigPath();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let temporaryDescriptor: number | undefined;
    fs.writeFileSync(configPath, '{"proxy":{"preferred_account_id":"acc-1"}}\n', 'utf8');
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const descriptor = originalOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        temporaryDescriptor = descriptor;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === temporaryDescriptor) {
        throw new Error('simulated temporary close failure');
      }
      originalClose(descriptor);
    });

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: true });
    expect((thrown as Error).cause).toMatchObject({ message: 'simulated temporary close failure' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

  it('reports a post-rename temporary cleanup failure as committed', async () => {
    const configPath = getConfigPath();
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    let temporaryPath: string | undefined;
    fs.writeFileSync(configPath, '{"proxy":{"preferred_account_id":"acc-1"}}\n', 'utf8');
    vi.mocked(spawn).mockImplementationOnce(() =>
      createLockHelperThatPublishes((temporaryName) => {
        temporaryPath = path.join(dataDir, temporaryName);
        originalRename(temporaryPath, configPath);
        fs.linkSync(configPath, temporaryPath);
      }),
    );
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (temporaryPath !== undefined && String(target).endsWith(path.basename(temporaryPath))) {
        throw new Error('simulated temporary cleanup failure');
      }
      originalUnlink(target);
    });

    const thrown = await ConfigManager.setPreferredAccount('acc-2').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConfigPersistenceError);
    expect(thrown).toMatchObject({ committed: true });
    expect((thrown as Error).cause).toMatchObject({ message: 'simulated temporary cleanup failure' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      proxy: { preferred_account_id: 'acc-2' },
    });
  });

});
