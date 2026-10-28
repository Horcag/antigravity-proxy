import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../shared/logging/logger';
import { patchAntigravityServer, resolveServerBinDir } from './server-launcher';

export interface EnforceOptions {
  serverBinDir?: string;
  procDir?: string;
  autoKill?: boolean;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface WatcherOptions extends EnforceOptions {
  intervalMs?: number;
}

export interface EnforceResult {
  patched: string[];
  terminatedPids: number[];
}

export function isLanguageServerProcess(cmdline: string): boolean {
  if (!cmdline) return false;
  const firstToken = cmdline.split('\0')[0] || '';
  const base = path.basename(firstToken);
  return base === 'language_server' || base === 'language_server.bin';
}

export function hasProxyEnvironment(environ: string): boolean {
  if (!environ) return false;
  return environ.includes('HTTPS_PROXY=') || environ.includes('https_proxy=');
}

export function scanUnproxiedLanguageServerProcesses(procDir = '/proc'): number[] {
  if (process.platform !== 'linux' && procDir === '/proc') {
    return [];
  }
  if (!fs.existsSync(procDir)) {
    return [];
  }

  const unproxiedPids: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    try {
      const cmdPath = path.join(procDir, entry, 'cmdline');
      if (!fs.existsSync(cmdPath)) continue;
      const cmdline = fs.readFileSync(cmdPath, 'utf-8');
      if (!isLanguageServerProcess(cmdline)) continue;

      const envPath = path.join(procDir, entry, 'environ');
      let environ = '';
      if (fs.existsSync(envPath)) {
        environ = fs.readFileSync(envPath, 'utf-8');
      }

      if (!hasProxyEnvironment(environ)) {
        unproxiedPids.push(pid);
      }
    } catch {
      // Ignore transient process exits or permission boundaries
    }
  }

  return unproxiedPids;
}

export function terminateUnproxiedLanguageServers(options: EnforceOptions = {}): number[] {
  const killFn = options.killFn || process.kill.bind(process);
  const unproxiedPids = scanUnproxiedLanguageServerProcesses(options.procDir);
  const terminatedPids: number[] = [];

  for (const pid of unproxiedPids) {
    try {
      killFn(pid, 'SIGTERM');
      terminatedPids.push(pid);
      logger.warn(
        `[ServerUpdateObserver] Terminated unproxied language_server process (PID ${pid}) to enforce proxy wrapper`,
      );
    } catch (err) {
      logger.debug(`[ServerUpdateObserver] Failed to signal unproxied process ${pid}`, err);
    }
  }

  return terminatedPids;
}

export function checkAndEnforceLanguageServer(options: EnforceOptions = {}): EnforceResult {
  const serverBinDir = resolveServerBinDir(options.serverBinDir);
  let patched: string[] = [];

  try {
    const patchResult = patchAntigravityServer(serverBinDir);
    patched = patchResult.patched;
  } catch (err) {
    logger.warn('[ServerUpdateObserver] Failed to patch server directory', err);
  }

  let terminatedPids: number[] = [];
  if (options.autoKill !== false) {
    terminatedPids = terminateUnproxiedLanguageServers(options);
  }

  return { patched, terminatedPids };
}

export function startLanguageServerWatcher(options: WatcherOptions = {}): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 15000;
  const serverBinDir = resolveServerBinDir(options.serverBinDir);

  checkAndEnforceLanguageServer(options);

  let fsWatcher: fs.FSWatcher | null = null;
  try {
    if (fs.existsSync(serverBinDir)) {
      fsWatcher = fs.watch(serverBinDir, () => {
        checkAndEnforceLanguageServer(options);
      });
    }
  } catch (err) {
    logger.debug('[ServerUpdateObserver] fs.watch not supported or failed on serverBinDir', err);
  }

  const timer = setInterval(() => {
    checkAndEnforceLanguageServer(options);
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop: () => {
      clearInterval(timer);
      if (fsWatcher) {
        try {
          fsWatcher.close();
        } catch {
          // ignore
        }
        fsWatcher = null;
      }
    },
  };
}

export async function runLanguageServerWatchLoop(serverDir?: string): Promise<void> {
  const resolved = resolveServerBinDir(serverDir);
  logger.info(`[ServerUpdateObserver] Watching language_server installations in ${resolved}...`);

  const watcher = startLanguageServerWatcher({ serverBinDir: resolved, intervalMs: 5000, autoKill: true });

  await new Promise<void>((resolve) => {
    const onSignal = () => {
      logger.info('[ServerUpdateObserver] Stopping watcher...');
      watcher.stop();
      resolve();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
