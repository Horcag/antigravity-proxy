import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  isLanguageServerProcess,
  hasProxyEnvironment,
  scanUnproxiedLanguageServerProcesses,
  terminateUnproxiedLanguageServers,
  checkAndEnforceLanguageServer,
  startLanguageServerWatcher,
} from '../../modules/proxy-gateway/server/cert/server-update-observer';

describe('server-update-observer', () => {
  let tmpDir: string;
  let mockProcDir: string;
  let mockServerBinDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-test-'));
    mockProcDir = path.join(tmpDir, 'proc');
    mockServerBinDir = path.join(tmpDir, '.antigravity-server', 'bin');
    fs.mkdirSync(mockProcDir, { recursive: true });
    fs.mkdirSync(mockServerBinDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockElfBinary(filePath: string): void {
    const buf = Buffer.alloc(100);
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    fs.writeFileSync(filePath, buf, { mode: 0o755 });
  }

  function createMockProc(pid: number, cmdline: string, environ: string): void {
    const pidDir = path.join(mockProcDir, String(pid));
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, 'cmdline'), cmdline);
    fs.writeFileSync(path.join(pidDir, 'environ'), environ);
  }

  it('correctly identifies language_server processes and rejects non-matching', () => {
    expect(isLanguageServerProcess('/path/to/language_server\0--standalone')).toBe(true);
    expect(isLanguageServerProcess('/path/to/language_server.bin\0--standalone')).toBe(true);
    expect(isLanguageServerProcess('/usr/bin/node\0server.js')).toBe(false);
    expect(isLanguageServerProcess('/home/nikit/.local/bin/agy\0serve')).toBe(false);
    expect(isLanguageServerProcess('')).toBe(false);
  });

  it('correctly detects proxy presence in environment string', () => {
    expect(hasProxyEnvironment('USER=nikit\0HTTPS_PROXY=http://127.0.0.1:8045\0HOME=/home/nikit')).toBe(true);
    expect(hasProxyEnvironment('USER=nikit\0https_proxy=http://127.0.0.1:8045\0HOME=/home/nikit')).toBe(true);
    expect(hasProxyEnvironment('USER=nikit\0SOME_VAR=123\0HOME=/home/nikit')).toBe(false);
    expect(hasProxyEnvironment('')).toBe(false);
  });

  it('scans proc directory and isolates only unproxied language_server instances', () => {
    // PID 101: language_server WITH proxy -> compliant
    createMockProc(
      101,
      '/opt/antigravity/bin/language_server.bin\0--standalone',
      'USER=nikit\0HTTPS_PROXY=http://127.0.0.1:8045\0PATH=/bin',
    );
    // PID 102: language_server WITHOUT proxy -> unproxied
    createMockProc(
      102,
      '/home/nikit/.antigravity-server/bin/2.27.0/language_server.bin\0--standalone',
      'USER=nikit\0NO_PROXY_HERE=1\0PATH=/bin',
    );
    // PID 103: unrelated node process without proxy -> ignored
    createMockProc(
      103,
      '/usr/bin/node\0cli.js',
      'USER=nikit\0PATH=/bin',
    );
    // PID 104: language_server with lowercase https_proxy -> compliant
    createMockProc(
      104,
      '/opt/antigravity/bin/language_server\0--standalone',
      'USER=nikit\0https_proxy=http://127.0.0.1:8045\0PATH=/bin',
    );

    const unproxied = scanUnproxiedLanguageServerProcesses(mockProcDir);
    expect(unproxied).toEqual([102]);
  });

  it('terminates unproxied language_server processes with SIGTERM', () => {
    createMockProc(
      201,
      '/home/nikit/.antigravity-server/bin/2.27.0/language_server.bin\0--standalone',
      'USER=nikit\0PATH=/bin',
    );
    const mockKill = vi.fn();

    const terminated = terminateUnproxiedLanguageServers({
      procDir: mockProcDir,
      killFn: mockKill as any,
    });

    expect(terminated).toEqual([201]);
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(201, 'SIGTERM');
  });

  it('patches unpatched versions and enforces process termination together', () => {
    // Create unpatched server version
    const verDir = path.join(mockServerBinDir, '2.28.0');
    fs.mkdirSync(verDir, { recursive: true });
    createMockElfBinary(path.join(verDir, 'language_server'));

    // Create running unproxied process
    createMockProc(
      301,
      '/home/nikit/.antigravity-server/bin/2.28.0/language_server\0--standalone',
      'USER=nikit\0PATH=/bin',
    );
    const mockKill = vi.fn();

    const result = checkAndEnforceLanguageServer({
      serverBinDir: mockServerBinDir,
      procDir: mockProcDir,
      killFn: mockKill as any,
    });

    expect(result.patched).toContain('2.28.0');
    expect(result.terminatedPids).toEqual([301]);
    expect(mockKill).toHaveBeenCalledWith(301, 'SIGTERM');

    // Binary should now be language_server.bin and wrapper is language_server
    expect(fs.existsSync(path.join(verDir, 'language_server.bin'))).toBe(true);
    const wrapper = fs.readFileSync(path.join(verDir, 'language_server'), 'utf-8');
    expect(wrapper).toContain('HTTPS_PROXY=');
  });

  it('runs watcher interval and stops cleanly', () => {
    vi.useFakeTimers();
    try {
      const mockKill = vi.fn();
      const watcher = startLanguageServerWatcher({
        serverBinDir: mockServerBinDir,
        procDir: mockProcDir,
        intervalMs: 1000,
        killFn: mockKill as any,
      });

      // Advance time by 3 seconds
      vi.advanceTimersByTime(3000);

      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
