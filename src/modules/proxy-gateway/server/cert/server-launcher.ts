import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../../../shared/logging/logger';
import { getCertsDir } from '../../../../shared/paths';

export interface LauncherOptions {
  trustBundlePath?: string;
  proxyHost?: string;
  proxyPort?: number;
}

export interface VersionPatchStatus {
  version: string;
  versionDir: string;
  status: 'patched' | 'unpatched' | 'corrupt' | 'missing';
  hasWrapper: boolean;
  hasBinary: boolean;
}

export function isElfFile(filePath: string): boolean {
  try {
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46;
  } catch {
    return false;
  }
}

export function resolveServerBinDir(explicitDir?: string): string {
  if (explicitDir) {
    return path.resolve(explicitDir);
  }
  return path.join(os.homedir(), '.antigravity-server', 'bin');
}

export function resolveLauncherConfig(options: LauncherOptions = {}): {
  trustBundlePath: string;
  proxyUrl: string;
} {
  const publicTrustBundle = '/usr/local/share/antigravity-proxy/agy-trust.pem';
  const trustBundlePath =
    options.trustBundlePath ||
    (fs.existsSync(publicTrustBundle) ? publicTrustBundle : path.join(getCertsDir(), 'agy-trust.pem'));

  const rawPort = options.proxyPort ?? Number(process.env.AG_PROXY_PORT?.trim());
  const proxyPort = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 8045;

  const rawHost = options.proxyHost?.trim() || process.env.AG_PROXY_HOST?.trim() || '127.0.0.1';
  const proxyHost = /^[a-zA-Z0-9.-]+$/.test(rawHost) ? rawHost : '127.0.0.1';

  return {
    trustBundlePath,
    proxyUrl: `http://${proxyHost}:${proxyPort}`,
  };
}

export function generateServerWrapperContent(trustBundlePath: string, proxyUrl: string): string {
  return `#!/bin/sh
# Managed Antigravity Language Server Launcher with Transparent HTTPS Proxy Failover

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_REAL="$SERVER_DIR/language_server.bin"
TRUST_BUNDLE="${trustBundlePath}"
PROXY_URL="${proxyUrl}"

if [ ! -x "$SERVER_REAL" ]; then
    printf '%s\\n' 'antigravity language_server: real binary is unavailable' >&2
    exit 126
fi

if [ -r "$TRUST_BUNDLE" ]; then
    export SSL_CERT_FILE="$TRUST_BUNDLE"
fi

export HTTPS_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL"
export NO_PROXY='localhost,127.0.0.1,::1'
export no_proxy='localhost,127.0.0.1,::1'

exec "$SERVER_REAL" "$@"
`;
}

export function getAntigravityServerPatchStatus(explicitDir?: string): VersionPatchStatus[] {
  const serverBinDir = resolveServerBinDir(explicitDir);
  if (!fs.existsSync(serverBinDir)) {
    return [];
  }

  const results: VersionPatchStatus[] = [];
  try {
    const entries = fs.readdirSync(serverBinDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const versionDir = path.join(serverBinDir, entry.name);
      const serverPath = path.join(versionDir, 'language_server');
      const serverBinPath = path.join(versionDir, 'language_server.bin');

      const serverExists = fs.existsSync(serverPath);
      const binExists = fs.existsSync(serverBinPath);

      if (serverExists && binExists && !isElfFile(serverPath) && isElfFile(serverBinPath)) {
        results.push({
          version: entry.name,
          versionDir,
          status: 'patched',
          hasWrapper: true,
          hasBinary: true,
        });
      } else if (serverExists && !binExists && isElfFile(serverPath)) {
        results.push({
          version: entry.name,
          versionDir,
          status: 'unpatched',
          hasWrapper: false,
          hasBinary: true,
        });
      } else if (!serverExists && binExists && isElfFile(serverBinPath)) {
        results.push({
          version: entry.name,
          versionDir,
          status: 'corrupt',
          hasWrapper: false,
          hasBinary: true,
        });
      } else if (!serverExists && !binExists) {
        results.push({
          version: entry.name,
          versionDir,
          status: 'missing',
          hasWrapper: false,
          hasBinary: false,
        });
      } else {
        results.push({
          version: entry.name,
          versionDir,
          status: 'corrupt',
          hasWrapper: serverExists,
          hasBinary: binExists,
        });
      }
    }
  } catch (err) {
    logger.warn('[Launcher] Failed to list language_server patch status', err);
  }

  return results.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export function patchAntigravityServer(explicitDir?: string, options: LauncherOptions = {}): {
  patched: string[];
  skipped: string[];
  errors: Array<{ version: string; error: string }>;
} {
  const serverBinDir = resolveServerBinDir(explicitDir);
  const result: {
    patched: string[];
    skipped: string[];
    errors: Array<{ version: string; error: string }>;
  } = { patched: [], skipped: [], errors: [] };

  if (!fs.existsSync(serverBinDir)) {
    return result;
  }

  const { trustBundlePath, proxyUrl } = resolveLauncherConfig(options);
  const wrapperContent = generateServerWrapperContent(trustBundlePath, proxyUrl);

  try {
    const entries = fs.readdirSync(serverBinDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const versionDir = path.join(serverBinDir, entry.name);
      const serverPath = path.join(versionDir, 'language_server');
      const serverBinPath = path.join(versionDir, 'language_server.bin');

      try {
        // If native binary is at language_server, move it to language_server.bin
        if (fs.existsSync(serverPath) && isElfFile(serverPath)) {
          fs.renameSync(serverPath, serverBinPath);
        }

        if (fs.existsSync(serverBinPath)) {
          let needsWrite = true;
          if (fs.existsSync(serverPath)) {
            const existing = fs.readFileSync(serverPath, 'utf-8');
            if (existing === wrapperContent) {
              needsWrite = false;
              result.skipped.push(entry.name);
            }
          }

          if (needsWrite) {
            const tempPath = path.join(versionDir, `language_server.tmp.${crypto.randomUUID()}`);
            fs.writeFileSync(tempPath, wrapperContent, { encoding: 'utf-8', mode: 0o755 });
            fs.renameSync(tempPath, serverPath);
            result.patched.push(entry.name);
            logger.info(`[Launcher] Patched language_server wrapper for version ${entry.name}`);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ version: entry.name, error: errorMsg });
        logger.warn(`[Launcher] Failed to patch language_server in ${versionDir}`, err);
      }
    }
  } catch (err) {
    logger.warn('[Launcher] Failed to scan serverBinDir for patching', err);
  }

  return result;
}

export function unpatchAntigravityServer(explicitDir?: string): {
  unpatched: string[];
  skipped: string[];
  errors: Array<{ version: string; error: string }>;
} {
  const serverBinDir = resolveServerBinDir(explicitDir);
  const result: {
    unpatched: string[];
    skipped: string[];
    errors: Array<{ version: string; error: string }>;
  } = { unpatched: [], skipped: [], errors: [] };

  if (!fs.existsSync(serverBinDir)) {
    return result;
  }

  try {
    const entries = fs.readdirSync(serverBinDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const versionDir = path.join(serverBinDir, entry.name);
      const serverPath = path.join(versionDir, 'language_server');
      const serverBinPath = path.join(versionDir, 'language_server.bin');

      try {
        if (fs.existsSync(serverBinPath)) {
          if (fs.existsSync(serverPath) && !isElfFile(serverPath)) {
            fs.unlinkSync(serverPath);
          }
          if (!fs.existsSync(serverPath)) {
            fs.renameSync(serverBinPath, serverPath);
            result.unpatched.push(entry.name);
            logger.info(`[Launcher] Restored native language_server for version ${entry.name}`);
          }
        } else {
          result.skipped.push(entry.name);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ version: entry.name, error: errorMsg });
        logger.warn(`[Launcher] Failed to unpatch language_server in ${versionDir}`, err);
      }
    }
  } catch (err) {
    logger.warn('[Launcher] Failed to scan serverBinDir for unpatching', err);
  }

  return result;
}
