import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  isElfFile,
  generateServerWrapperContent,
  getAntigravityServerPatchStatus,
  patchAntigravityServer,
  unpatchAntigravityServer,
} from '../../modules/proxy-gateway/server/cert/server-launcher';

describe('server-launcher', () => {
  let tmpDir: string;
  let serverBinDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-server-test-'));
    serverBinDir = path.join(tmpDir, '.antigravity-server', 'bin');
    fs.mkdirSync(serverBinDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockElfBinary(filePath: string): void {
    const buf = Buffer.alloc(100);
    buf[0] = 0x7f;
    buf[1] = 0x45; // 'E'
    buf[2] = 0x4c; // 'L'
    buf[3] = 0x46; // 'F'
    fs.writeFileSync(filePath, buf, { mode: 0o755 });
  }

  it('correctly detects ELF binaries and non-ELF scripts', () => {
    const elfPath = path.join(tmpDir, 'test.elf');
    const scriptPath = path.join(tmpDir, 'test.sh');
    createMockElfBinary(elfPath);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi\n', { mode: 0o755 });

    expect(isElfFile(elfPath)).toBe(true);
    expect(isElfFile(scriptPath)).toBe(false);
    expect(isElfFile(path.join(tmpDir, 'nonexistent'))).toBe(false);
  });

  it('generates wrapper content with proper proxy and cert settings', () => {
    const wrapper = generateServerWrapperContent('/path/to/trust.pem', 'http://127.0.0.1:8045');
    expect(wrapper).toContain('PROXY_URL="http://127.0.0.1:8045"');
    expect(wrapper).toContain('TRUST_BUNDLE="/path/to/trust.pem"');
    expect(wrapper).toContain('export HTTPS_PROXY="$PROXY_URL"');
    expect(wrapper).toContain('export SSL_CERT_FILE="$TRUST_BUNDLE"');
    expect(wrapper).toContain('NO_PROXY=\'localhost,127.0.0.1,::1\'');
    expect(wrapper).toContain('exec "$SERVER_REAL" "$@"');
  });

  it('patches unpatched language_server installations and reports status accurately', () => {
    const ver1Dir = path.join(serverBinDir, '2.25.0');
    const ver2Dir = path.join(serverBinDir, '2.26.0');
    fs.mkdirSync(ver1Dir, { recursive: true });
    fs.mkdirSync(ver2Dir, { recursive: true });

    createMockElfBinary(path.join(ver1Dir, 'language_server'));
    createMockElfBinary(path.join(ver2Dir, 'language_server'));

    let status = getAntigravityServerPatchStatus(serverBinDir);
    expect(status).toHaveLength(2);
    expect(status[0].status).toBe('unpatched');
    expect(status[1].status).toBe('unpatched');

    const patchResult = patchAntigravityServer(serverBinDir, {
      trustBundlePath: '/custom/ca.pem',
      proxyPort: 8045,
    });
    expect(patchResult.patched).toEqual(expect.arrayContaining(['2.25.0', '2.26.0']));
    expect(patchResult.errors).toHaveLength(0);

    status = getAntigravityServerPatchStatus(serverBinDir);
    expect(status).toHaveLength(2);
    expect(status[0].status).toBe('patched');
    expect(status[1].status).toBe('patched');

    // language_server is now a script, language_server.bin is the ELF
    const serverScript = fs.readFileSync(path.join(ver2Dir, 'language_server'), 'utf-8');
    expect(serverScript).toContain('/custom/ca.pem');
    expect(isElfFile(path.join(ver2Dir, 'language_server'))).toBe(false);
    expect(isElfFile(path.join(ver2Dir, 'language_server.bin'))).toBe(true);

    // Second patch should be idempotent (skipped)
    const secondPatch = patchAntigravityServer(serverBinDir, {
      trustBundlePath: '/custom/ca.pem',
      proxyPort: 8045,
    });
    expect(secondPatch.patched).toHaveLength(0);
    expect(secondPatch.skipped).toEqual(expect.arrayContaining(['2.25.0', '2.26.0']));
  });

  it('unpatches language_server and restores original binary', () => {
    const verDir = path.join(serverBinDir, '2.26.0');
    fs.mkdirSync(verDir, { recursive: true });
    createMockElfBinary(path.join(verDir, 'language_server'));

    patchAntigravityServer(serverBinDir);
    expect(fs.existsSync(path.join(verDir, 'language_server.bin'))).toBe(true);

    const unpatchResult = unpatchAntigravityServer(serverBinDir);
    expect(unpatchResult.unpatched).toEqual(['2.26.0']);
    expect(unpatchResult.errors).toHaveLength(0);

    expect(fs.existsSync(path.join(verDir, 'language_server.bin'))).toBe(false);
    expect(fs.existsSync(path.join(verDir, 'language_server'))).toBe(true);
    expect(isElfFile(path.join(verDir, 'language_server'))).toBe(true);
  });
});
