import { randomUUID } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, DEFAULT_PROXY_CONFIG, ProxyConfigSchema } from '@/modules/config/types';

const CONFIG_FILE_NAME = 'config.json';
const LOCK_FILE_NAME = '.config.json.lock';
const FLOCK_EXECUTABLE = '/usr/bin/flock';
const FLOCK_ACQUISITION_TIMEOUT_SECONDS = 0.25;
const LOCK_HANDSHAKE_TIMEOUT_MS = 400;
const LOCK_RELEASE_TIMEOUT_MS = 250;
const LOCK_TERMINATION_GRACE_MS = 100;
const OWNED_TEMPORARY_NAME_PATTERN = /^\.config\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const LOCK_HELPER_SCRIPT = [
  'expected=$1',
  'case "$expected" in',
  '  .config.json.????????-????-????-????-????????????.tmp) ;;',
  '  *) exit 1 ;;',
  'esac',
  'uuid=${expected#.config.json.}',
  'uuid=${uuid%.tmp}',
  'case "$uuid" in',
  "  *[!0-9a-f.-]*) exit 1 ;;",
  'esac',
  `${FLOCK_EXECUTABLE} --exclusive --wait ${FLOCK_ACQUISITION_TIMEOUT_SECONDS} 3 || exit`,
  "printf 'locked\\n'",
  'IFS= read -r command || exit',
  '[ "$command" = "publish $expected" ] || exit 1',
  `mv -f -- "/proc/self/fd/4/$expected" /proc/self/fd/4/${CONFIG_FILE_NAME} || exit`,
  "printf 'committed\\n'",
  'exec cat >/dev/null',
].join('\n');

interface PartialProxyConfig {
  host?: string;
  port?: number;
  api_key?: string;
  admin_api_key?: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
}

interface FileBackedConfig {
  config: Record<string, unknown>;
  identity?: FileIdentity;
}

interface AnchoredDataDirectory {
  descriptor?: number;
  path: string;
}

interface ConfigLock {
  child: ChildProcess;
  inputClosed: boolean;
  monitor: ConfigLockMonitor;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ConfigPersistenceError extends Error {
  constructor(readonly committed: boolean, options?: ErrorOptions) {
    super(
      committed
        ? 'Proxy configuration was updated but its containing directory could not be synchronized'
        : 'Unable to update proxy configuration',
      options,
    );
    this.name = 'ConfigPersistenceError';
  }
}

function getIdentity(stats: fs.Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode & 0o777 };
}

function isSameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function getConfiguredDataDirectory(): string {
  const configured = process.env.AG_PROXY_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.antigravity-proxy');
}

function assertLinuxPersistenceSupport(): void {
  if (
    process.platform !== 'linux' ||
    !fs.existsSync('/proc/self/fd') ||
    fs.constants.O_NOFOLLOW === undefined
  ) {
    throw new Error('Preferred-account persistence is only supported on Linux');
  }
  try {
    fs.accessSync(FLOCK_EXECUTABLE, fs.constants.X_OK);
  } catch {
    throw new Error('Preferred-account persistence requires the Linux flock utility');
  }
}

function assertNoSymlinkComponents(targetPath: string): void {
  const parsed = path.parse(targetPath);
  const relativePath = path.relative(parsed.root, targetPath);
  let currentPath = parsed.root;

  for (const component of relativePath.split(path.sep)) {
    if (!component) {
      continue;
    }
    currentPath = path.join(currentPath, component);
    try {
      if (fs.lstatSync(currentPath).isSymbolicLink()) {
        throw new Error('Unsafe proxy configuration path');
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function assertSafeDataDirectory(dataDirectory: string): fs.Stats {
  assertNoSymlinkComponents(dataDirectory);
  try {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error('Unable to prepare proxy configuration directory');
  }
  assertNoSymlinkComponents(dataDirectory);

  let directoryStats: fs.Stats;
  try {
    directoryStats = fs.lstatSync(dataDirectory);
  } catch {
    throw new Error('Unable to inspect proxy configuration directory');
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Unsafe proxy configuration directory');
  }
  if (typeof process.getuid === 'function' && directoryStats.uid !== process.getuid()) {
    throw new Error('Unsafe proxy configuration directory ownership');
  }
  if ((directoryStats.mode & 0o077) !== 0) {
    throw new Error('Unsafe proxy configuration directory permissions');
  }
  return directoryStats;
}

function openAnchoredDataDirectory(): AnchoredDataDirectory {
  assertLinuxPersistenceSupport();
  const dataDirectory = getConfiguredDataDirectory();
  const expectedStats = assertSafeDataDirectory(dataDirectory);

  let descriptor: number | undefined;
  let opened = false;
  try {
    descriptor = fs.openSync(
      dataDirectory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const openedStats = fs.fstatSync(descriptor);
    if (
      !openedStats.isDirectory() ||
      openedStats.dev !== expectedStats.dev ||
      openedStats.ino !== expectedStats.ino
    ) {
      throw new Error('Unsafe proxy configuration directory');
    }
    const anchoredPath = `/proc/self/fd/${descriptor}`;
    const anchoredStats = fs.statSync(anchoredPath);
    if (
      !anchoredStats.isDirectory() ||
      anchoredStats.dev !== openedStats.dev ||
      anchoredStats.ino !== openedStats.ino
    ) {
      throw new Error('Unable to anchor proxy configuration directory');
    }
    opened = true;
    return { descriptor, path: anchoredPath };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Unsafe proxy configuration directory' ||
        error.message === 'Unable to anchor proxy configuration directory')
    ) {
      throw error;
    }
    throw new Error('Unable to inspect proxy configuration directory');
  } finally {
    if (descriptor !== undefined && !opened) {
      fs.closeSync(descriptor);
    }
  }
}

function withAnchoredDataDirectory<T>(
  operation: (directory: AnchoredDataDirectory, markCommitted: () => void) => T,
): T {
  const directory = openAnchoredDataDirectory();
  let committed = false;
  let result: T | undefined;
  let operationFailure: unknown;
  let closeFailure: unknown;
  try {
    result = operation(directory, () => {
      committed = true;
    });
  } catch (error) {
    operationFailure = error;
  }
  try {
    if (directory.descriptor !== undefined) {
      fs.closeSync(directory.descriptor);
    }
  } catch (error) {
    closeFailure = error;
  }
  if (operationFailure !== undefined) {
    throw operationFailure;
  }
  if (closeFailure !== undefined) {
    if (committed) {
      throw new ConfigPersistenceError(true, { cause: closeFailure });
    }
    throw closeFailure;
  }
  return result as T;
}

async function withAnchoredDataDirectoryAsync<T>(
  operation: (directory: AnchoredDataDirectory, markCommitted: () => void) => Promise<T>,
): Promise<T> {
  const directory = openAnchoredDataDirectory();
  let committed = false;
  let result: T | undefined;
  let operationFailure: unknown;
  let closeFailure: unknown;
  try {
    result = await operation(directory, () => {
      committed = true;
    });
  } catch (error) {
    operationFailure = error;
  }
  try {
    if (directory.descriptor !== undefined) {
      fs.closeSync(directory.descriptor);
    }
  } catch (error) {
    closeFailure = error;
  }
  if (operationFailure !== undefined) {
    throw operationFailure;
  }
  if (closeFailure !== undefined) {
    if (committed) {
      throw new ConfigPersistenceError(true, { cause: closeFailure });
    }
    throw closeFailure;
  }
  return result as T;
}

function childPath(directory: AnchoredDataDirectory, name: string): string {
  return path.join(directory.path, name);
}

function inspectConfigEntry(configPath: string): FileIdentity | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(configPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new Error('Unable to inspect proxy configuration');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Unsafe proxy configuration entry');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Unsafe proxy configuration ownership');
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error('Unsafe proxy configuration permissions');
  }
  return getIdentity(stats);
}

function assertExpectedConfigEntry(configPath: string, expected: FileIdentity | undefined): void {
  const actual = inspectConfigEntry(configPath);
  if (
    (expected === undefined && actual !== undefined) ||
    (expected !== undefined && (actual === undefined || !isSameFile(actual, expected)))
  ) {
    throw new Error('Proxy configuration changed during update');
  }
}

function readFileBackedConfig(configPath: string): FileBackedConfig {
  const expectedIdentity = inspectConfigEntry(configPath);
  if (!expectedIdentity) {
    return { config: {} };
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStats = fs.fstatSync(descriptor);
    const openedIdentity = getIdentity(openedStats);
    if (!openedStats.isFile() || !isSameFile(openedIdentity, expectedIdentity)) {
      throw new Error('Unsafe proxy configuration entry');
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!isRecord(parsed)) {
      throw new Error('Proxy configuration must be a JSON object');
    }
    return { config: parsed, identity: openedIdentity };
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function assertTemporaryEntry(temporaryPath: string, expected: FileIdentity): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(temporaryPath);
  } catch {
    throw new Error('Temporary proxy configuration was replaced');
  }
  if (stats.isSymbolicLink() || !stats.isFile() || !isSameFile(getIdentity(stats), expected)) {
    throw new Error('Temporary proxy configuration was replaced');
  }
}

function isPublishedTemporaryEntry(targetPath: string, temporaryIdentity: FileIdentity): boolean {
  const published = inspectConfigEntry(targetPath);
  return published !== undefined && isSameFile(published, temporaryIdentity);
}

function removeExactTemporaryEntry(temporaryPath: string, expected: FileIdentity | undefined): void {
  if (!expected) {
    return;
  }
  try {
    const stats = fs.lstatSync(temporaryPath);
    if (!stats.isSymbolicLink() && stats.isFile() && isSameFile(getIdentity(stats), expected)) {
      fs.unlinkSync(temporaryPath);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function inspectLockEntry(lockPath: string): FileIdentity | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new Error('Unable to inspect proxy configuration lock');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Unsafe proxy configuration lock entry');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Unsafe proxy configuration lock ownership');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Unsafe proxy configuration lock permissions');
  }
  return getIdentity(stats);
}

function openLockDescriptor(lockPath: string): number {
  const expected = inspectLockEntry(lockPath);
  let descriptor: number | undefined;
  let opened = false;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        (expected === undefined ? fs.constants.O_EXCL : 0) |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    const stats = fs.fstatSync(descriptor);
    const identity = getIdentity(stats);
    if (
      !stats.isFile() ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
      (stats.mode & 0o077) !== 0 ||
      (expected !== undefined && !isSameFile(identity, expected))
    ) {
      throw new Error('Unsafe proxy configuration lock entry');
    }
    if (expected === undefined) {
      fs.fchmodSync(descriptor, 0o600);
    }
    opened = true;
    return descriptor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && expected === undefined) {
      return openLockDescriptor(lockPath);
    }
    throw error;
  } finally {
    if (descriptor !== undefined && !opened) {
      fs.closeSync(descriptor);
    }
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function endLockHelperInput(lock: Pick<ConfigLock, 'child' | 'inputClosed'>): void {
  if (lock.inputClosed) {
    return;
  }
  lock.inputClosed = true;
  lock.child.stdin?.end();
}

function waitForChildExit(child: ChildProcess, timeoutMs: number, action: string): Promise<ChildExit> {
  if (hasChildExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const input = child.stdin;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      input?.removeListener('error', onInputError);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onInputError = (error: Error) => settle(() => reject(error));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => resolve({ code, signal }));
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Timed out while ${action}`)));
    }, timeoutMs);
    child.once('error', onError);
    child.once('close', onClose);
    input?.once('error', onInputError);
  });
}

async function terminateLockHelper(lock: Pick<ConfigLock, 'child' | 'inputClosed'>): Promise<void> {
  const { child } = lock;
  let inputFailure: unknown;
  try {
    endLockHelperInput(lock);
  } catch (error) {
    inputFailure = error;
  }
  if (hasChildExited(child)) {
    if (inputFailure !== undefined) {
      throw inputFailure;
    }
    return;
  }

  try {
    await waitForChildExit(child, LOCK_RELEASE_TIMEOUT_MS, 'releasing proxy configuration lock');
  } catch {
    // The helper owns the descriptor and did not release it after its control pipe closed.
    try {
      const terminate = async (signal: NodeJS.Signals, action: string): Promise<void> => {
        const exited = waitForChildExit(child, LOCK_TERMINATION_GRACE_MS, action);
        if (!child.kill(signal)) {
          await exited.catch(() => undefined);
          throw new Error(`Unable to send ${signal} to proxy configuration lock helper`);
        }
        await exited;
      };

      try {
        await terminate('SIGTERM', 'waiting for proxy configuration lock helper to terminate');
      } catch {
        await terminate('SIGKILL', 'waiting for proxy configuration lock helper to be killed');
      }
    } catch (error) {
      if (inputFailure === undefined) {
        throw error;
      }
    }
  }
  if (inputFailure !== undefined) {
    throw inputFailure;
  }
}

class ConfigLockMonitor {
  private phase: 'acquiring' | 'held' | 'publishing' | 'committed' | 'releasing' | 'finished' =
    'acquiring';
  private output = '';
  private errorOutput = '';
  private failure: Error | undefined;
  private acquisition: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private publication: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private release: { resolve: (exit: ChildExit) => void; reject: (error: Error) => void } | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private publicationTimer: NodeJS.Timeout | undefined;
  private releaseTimer: NodeJS.Timeout | undefined;

  constructor(private readonly child: ChildProcess) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('Unable to observe proxy configuration lock');
    }
    child.once('error', this.onChildError);
    child.once('close', this.onChildClose);
    child.stdin.once('error', this.onInputError);
    child.stdout.on('data', this.onStdout);
    child.stdout.once('error', this.onOutputError);
    child.stdout.once('close', this.onOutputClose);
    child.stderr.on('data', this.onStderr);
    child.stderr.once('error', this.onErrorOutputError);
    child.stderr.once('close', this.onErrorOutputClose);
  }

  waitForAcquisition(): Promise<void> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.acquisition = { resolve, reject };
      this.handshakeTimer = setTimeout(() => {
        this.fail(new Error('Timed out acquiring proxy configuration lock'));
      }, LOCK_HANDSHAKE_TIMEOUT_MS);
    });
  }

  publish(temporaryName: string): Promise<void> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.phase !== 'held') {
      return Promise.reject(new Error('Proxy configuration lock helper is not ready to publish'));
    }
    this.phase = 'publishing';
    return new Promise((resolve, reject) => {
      this.publication = { resolve, reject };
      this.publicationTimer = setTimeout(() => {
        this.fail(new Error('Timed out publishing proxy configuration under lock'));
      }, LOCK_HANDSHAKE_TIMEOUT_MS);
      try {
        this.child.stdin?.write(`publish ${temporaryName}\n`);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Unable to publish proxy configuration under lock'));
      }
    });
  }

  releaseLock(lock: ConfigLock): Promise<ChildExit> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.phase !== 'committed') {
      return Promise.reject(new Error('Proxy configuration lock helper did not confirm publication'));
    }
    this.phase = 'releasing';
    return new Promise((resolve, reject) => {
      this.release = { resolve, reject };
      this.releaseTimer = setTimeout(() => {
        if (this.phase === 'releasing') {
          this.fail(new Error('Timed out while releasing proxy configuration lock'));
        }
      }, LOCK_RELEASE_TIMEOUT_MS);
      try {
        endLockHelperInput(lock);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Unable to close proxy configuration lock helper'));
      }
    });
  }

  dispose(): void {
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.publicationTimer);
    clearTimeout(this.releaseTimer);
    this.child.removeListener('error', this.onChildError);
    this.child.removeListener('close', this.onChildClose);
    this.child.stdin?.removeListener('error', this.onInputError);
    this.child.stdout?.removeListener('data', this.onStdout);
    this.child.stdout?.removeListener('error', this.onOutputError);
    this.child.stdout?.removeListener('close', this.onOutputClose);
    this.child.stderr?.removeListener('data', this.onStderr);
    this.child.stderr?.removeListener('error', this.onErrorOutputError);
    this.child.stderr?.removeListener('close', this.onErrorOutputClose);
  }

  private readonly onChildError = (error: Error): void => this.fail(error);

  private readonly onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.phase === 'releasing') {
      this.finishRelease({ code, signal });
      return;
    }
    this.fail(
      new Error(
        `Proxy configuration lock helper exited before release (${code ?? signal ?? 'unknown'}): ${this.errorOutput}`,
      ),
    );
  };

  private readonly onInputError = (error: Error): void => this.fail(error);

  private readonly onOutputError = (error: Error): void => this.fail(error);

  private readonly onErrorOutputError = (error: Error): void => this.fail(error);

  private readonly onOutputClose = (): void => {
    if (this.phase !== 'releasing') {
      this.fail(new Error('Proxy configuration lock helper control output closed before release'));
    }
  };

  private readonly onErrorOutputClose = (): void => {
    if (this.phase !== 'releasing') {
      this.fail(new Error('Proxy configuration lock helper error output closed before release'));
    }
  };

  private readonly onStderr = (chunk: Buffer): void => {
    this.errorOutput += chunk.toString();
  };

  private readonly onStdout = (chunk: Buffer): void => {
    this.output += chunk.toString();
    while (true) {
      const newline = this.output.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      if (this.phase === 'acquiring' && line === 'locked') {
        clearTimeout(this.handshakeTimer);
        this.phase = 'held';
        this.acquisition?.resolve();
        this.acquisition = undefined;
        continue;
      }
      if (this.phase === 'publishing' && line === 'committed') {
        clearTimeout(this.publicationTimer);
        this.phase = 'committed';
        this.publication?.resolve();
        this.publication = undefined;
        continue;
      }
      this.fail(new Error('Unexpected proxy configuration lock helper output'));
      return;
    }
  };

  private fail(error: Error): void {
    if (this.phase === 'finished') {
      return;
    }
    this.phase = 'finished';
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.publicationTimer);
    clearTimeout(this.releaseTimer);
    this.failure = error;
    this.acquisition?.reject(error);
    this.publication?.reject(error);
    this.release?.reject(error);
    this.acquisition = undefined;
    this.publication = undefined;
    this.release = undefined;
    this.dispose();
  }

  private finishRelease(exit: ChildExit): void {
    this.phase = 'finished';
    this.release?.resolve(exit);
    this.release = undefined;
    this.dispose();
  }
}

async function acquireConfigLock(directory: AnchoredDataDirectory, temporaryName: string): Promise<ConfigLock> {
  if (!OWNED_TEMPORARY_NAME_PATTERN.test(temporaryName)) {
    throw new Error('Unsafe temporary proxy configuration entry');
  }
  const descriptor = openLockDescriptor(childPath(directory, LOCK_FILE_NAME));
  let child: ChildProcess | undefined;
  let monitor: ConfigLockMonitor | undefined;
  let descriptorClosed = false;
  try {
    if (directory.descriptor === undefined) {
      throw new Error('Unable to anchor proxy configuration directory');
    }
    // flock receives only the checked, already-open descriptor. The separately passed, parent-owned
    // temporary basename lets the helper authorize one exact publication under that lock.
    child = spawn(
      '/bin/sh',
      [
        '-c',
        LOCK_HELPER_SCRIPT,
        'config-lock-helper',
        temporaryName,
      ],
      { stdio: ['pipe', 'pipe', 'pipe', descriptor, directory.descriptor] },
    );
    fs.closeSync(descriptor);
    descriptorClosed = true;
    monitor = new ConfigLockMonitor(child);
    await monitor.waitForAcquisition();
    return { child, inputClosed: false, monitor };
  } catch (error) {
    monitor?.dispose();
    if (child !== undefined) {
      try {
        await terminateLockHelper({ child, inputClosed: false });
      } catch {
        // The primary acquisition failure is more useful before config publication.
      }
    }
    if (!descriptorClosed) {
      fs.closeSync(descriptor);
    }
    throw new ConfigPersistenceError(false, { cause: error });
  }
}

async function releaseConfigLock(lock: ConfigLock): Promise<void> {
  try {
    const exit = await lock.monitor.releaseLock(lock);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Unable to release proxy configuration lock (${exit.code ?? exit.signal ?? 'unknown'})`);
    }
  } catch (error) {
    lock.monitor.dispose();
    try {
      await terminateLockHelper(lock);
    } catch (cleanupError) {
      throw new Error('Unable to release proxy configuration lock helper', { cause: cleanupError });
    }
    throw error;
  }
}

function configPath(directory: AnchoredDataDirectory): string {
  return childPath(directory, CONFIG_FILE_NAME);
}

export class ConfigManager {
  static loadConfig(): AppConfig {
    const fileBackedConfig = withAnchoredDataDirectory((directory) => readFileBackedConfig(configPath(directory)));
    const fileProxy = isRecord(fileBackedConfig.config.proxy)
      ? (fileBackedConfig.config.proxy as PartialProxyConfig)
      : {};
    const proxy = ProxyConfigSchema.parse({
      ...DEFAULT_PROXY_CONFIG,
      ...fileProxy,
      host: process.env.AG_PROXY_HOST ?? fileProxy.host,
      port: process.env.AG_PROXY_PORT ? Number(process.env.AG_PROXY_PORT) : fileProxy.port,
      api_key: process.env.AG_PROXY_API_KEY ?? fileProxy.api_key,
      admin_api_key: process.env.AG_PROXY_ADMIN_API_KEY ?? fileProxy.admin_api_key,
    });
    return { proxy };
  }

  static async saveConfig(config: AppConfig): Promise<void> {
    const validated = { proxy: ProxyConfigSchema.parse(config.proxy) };
    await this.updateConfig((current) => ({
      ...current,
      proxy: {
        ...(isRecord(current.proxy) ? current.proxy : {}),
        ...validated.proxy,
      },
    }));
  }

  static async setPreferredAccount(accountId?: string): Promise<void> {
    await this.updateConfig((fileBackedConfig) => {
      const fileProxy = isRecord(fileBackedConfig.proxy) ? fileBackedConfig.proxy : {};
      return {
        ...fileBackedConfig,
        proxy: {
          ...fileProxy,
          preferred_account_id: accountId ?? '',
        },
      };
    });
  }

  private static async updateConfig(
    update: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await withAnchoredDataDirectoryAsync(async (directory, markCommitted) => {
      const temporaryName = `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`;
      const lock = await acquireConfigLock(directory, temporaryName);
      let operationFailure: unknown;
      let releaseFailure: unknown;
      try {
        const targetPath = configPath(directory);
        const current = readFileBackedConfig(targetPath);
        await this.writeConfigAtomically(
          lock,
          directory,
          targetPath,
          update(current.config),
          current.identity,
          temporaryName,
        );
        markCommitted();
      } catch (error) {
        operationFailure = error;
      }
      try {
        await releaseConfigLock(lock);
      } catch (error) {
        releaseFailure = error;
      }
      if (operationFailure !== undefined) {
        throw operationFailure;
      }
      if (releaseFailure !== undefined) {
        throw new ConfigPersistenceError(true, { cause: releaseFailure });
      }
    });
  }

  private static async writeConfigAtomically(
    lock: ConfigLock,
    directory: AnchoredDataDirectory,
    targetPath: string,
    config: Record<string, unknown>,
    expectedConfig: FileIdentity | undefined,
    temporaryName: string,
  ): Promise<void> {
    const temporaryPath = childPath(directory, temporaryName);
    let temporaryFileDescriptor: number | undefined;
    let temporaryIdentity: FileIdentity | undefined;
    let committed = false;
    let failure: unknown;

    try {
      assertExpectedConfigEntry(targetPath, expectedConfig);
      temporaryFileDescriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const temporaryStats = fs.fstatSync(temporaryFileDescriptor);
      if (!temporaryStats.isFile()) {
        throw new Error('Unsafe temporary proxy configuration entry');
      }
      temporaryIdentity = getIdentity(temporaryStats);
      fs.writeFileSync(temporaryFileDescriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      fs.fsyncSync(temporaryFileDescriptor);
      if (expectedConfig !== undefined) {
        fs.fchmodSync(temporaryFileDescriptor, expectedConfig.mode);
        fs.fsyncSync(temporaryFileDescriptor);
      }
      const verifiedStats = fs.fstatSync(temporaryFileDescriptor);
      if (!verifiedStats.isFile() || !isSameFile(getIdentity(verifiedStats), temporaryIdentity)) {
        throw new Error('Unsafe temporary proxy configuration entry');
      }
      assertExpectedConfigEntry(targetPath, expectedConfig);
      assertTemporaryEntry(temporaryPath, temporaryIdentity);
      // The owner-only directory excludes other UIDs. Avoiding a second commit pathname keeps
      // the checked, open temporary entry as the direct atomic-replace source; a hostile same-UID
      // process remains outside this file-integrity boundary.
      try {
        await lock.monitor.publish(temporaryName);
      } catch (error) {
        throw new ConfigPersistenceError(false, { cause: error });
      }
      committed = true;
      if (directory.descriptor !== undefined) {
        fs.fsyncSync(directory.descriptor);
      }
    } catch (error) {
      failure = error;
      if (!committed && temporaryIdentity !== undefined) {
        try {
          committed = isPublishedTemporaryEntry(targetPath, temporaryIdentity);
        } catch {
          // The original failure remains authoritative when the target cannot prove our exact rename.
        }
      }
    } finally {
      if (temporaryFileDescriptor !== undefined) {
        try {
          fs.closeSync(temporaryFileDescriptor);
        } catch (error) {
          failure ??= error;
        }
      }
      try {
        removeExactTemporaryEntry(temporaryPath, temporaryIdentity);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      if (committed) {
        throw new ConfigPersistenceError(true, { cause: failure });
      }
      throw failure;
    }
  }
}
