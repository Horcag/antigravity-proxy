import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { getCaCertPath, getCaKeyPath, getCertsDir } from '../../../../shared/paths';
import { logger } from '../../../../shared/logging/logger';

export const TARGET_CLOUDCODE_HOSTS = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
  'autopush-cloudcode-pa.sandbox.googleapis.com',
  'preprod-daily-cloudcode-pa.sandbox.googleapis.com',
] as const;

export const ALLOWED_TARGET_HOSTS = new Set<string>(TARGET_CLOUDCODE_HOSTS);

export interface TargetAuthority {
  hostname: string;
  port: 443;
}

export function parseTargetAuthority(destination: string | undefined): TargetAuthority | null {
  if (!destination || typeof destination !== 'string') {
    return null;
  }
  const trimmed = destination.trim().toLowerCase();
  // Strictly validate authority: hostname must consist only of lowercase alphanumeric, dot, hyphen
  // port if specified must consist only of digits and evaluate strictly to 443
  const match = /^([a-z0-9.-]+)(?::([0-9]+))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const hostname = match[1];
  const portStr = match[2];
  const port = portStr !== undefined ? Number(portStr) : 443;
  if (port !== 443 || !ALLOWED_TARGET_HOSTS.has(hostname)) {
    return null;
  }
  return { hostname, port: 443 };
}

export class CaManager {
  private static secureContext: tls.SecureContext | null = null;

  static isTargetHost(destination: string): boolean {
    return parseTargetAuthority(destination) !== null;
  }

  static getCaCertPath(): string {
    return getCaCertPath();
  }

  static ensureCertificates(): tls.SecureContext {
    if (this.secureContext) {
      return this.secureContext;
    }

    const certsDir = getCertsDir();
    const caKeyPath = getCaKeyPath();
    const caCertPath = getCaCertPath();
    const leafKeyPath = path.join(certsDir, 'cloudcode.key');
    const leafCertPath = path.join(certsDir, 'cloudcode.crt');

    const caExists = fs.existsSync(caKeyPath) && fs.existsSync(caCertPath);
    const leafExists = fs.existsSync(leafKeyPath) && fs.existsSync(leafCertPath);

    if (!caExists) {
      logger.info('Generating local root CA for transparent Antigravity CLI failover...');
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        caKeyPath,
        '-out',
        caCertPath,
        '-days',
        '3650',
        '-subj',
        '/CN=Antigravity Local Root CA/O=Antigravity Proxy',
      ]);
      fs.chmodSync(caKeyPath, 0o600);
      fs.chmodSync(caCertPath, 0o644);
    }

    if (!leafExists || !caExists) {
      logger.info('Generating leaf certificate for CloudCode domains...');
      const csrPath = path.join(certsDir, 'cloudcode.csr');
      const extPath = path.join(certsDir, 'cloudcode.ext');

      const sanList = TARGET_CLOUDCODE_HOSTS.map((h) => `DNS:${h}`).join(',');
      fs.writeFileSync(
        extPath,
        `subjectAltName=${sanList},DNS:*.googleapis.com,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n`,
        { encoding: 'utf-8' },
      );

      execFileSync('openssl', [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        leafKeyPath,
        '-out',
        csrPath,
        '-subj',
        '/CN=daily-cloudcode-pa.googleapis.com/O=Antigravity Proxy',
      ]);
      fs.chmodSync(leafKeyPath, 0o600);

      execFileSync('openssl', [
        'x509',
        '-req',
        '-in',
        csrPath,
        '-CA',
        caCertPath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        leafCertPath,
        '-days',
        '825',
        '-extfile',
        extPath,
      ]);
      fs.chmodSync(leafCertPath, 0o644);

      try {
        fs.unlinkSync(csrPath);
        fs.unlinkSync(extPath);
      } catch {
        // ignore cleanup error
      }
    }

    const key = fs.readFileSync(leafKeyPath);
    const cert = fs.readFileSync(leafCertPath);
    const ca = fs.readFileSync(caCertPath);

    this.secureContext = tls.createSecureContext({
      key,
      cert,
      ca,
    });

    logger.info(`Transparent CA ready at: ${caCertPath}`);

    // Generate merged trust bundle for agy containing system roots + local root CA
    const trustBundlePath = path.join(certsDir, 'agy-trust.pem');
    const systemCaPaths = [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ssl/ca-bundle.pem',
    ];
    let systemCa = '';
    for (const sysPath of systemCaPaths) {
      if (fs.existsSync(sysPath)) {
        systemCa = fs.readFileSync(sysPath, 'utf-8');
        break;
      }
    }
    fs.writeFileSync(
      trustBundlePath,
      `${systemCa.trim()}\n\n# Antigravity Proxy Local Root CA\n${ca.toString('utf-8').trim()}\n`,
      { encoding: 'utf-8', mode: 0o644 },
    );
    logger.info(`Merged trust bundle ready at: ${trustBundlePath}`);

    this.ensureAgyLauncher();

    return this.secureContext;
  }

  static ensureAgyLauncher(): void {
    const homeDir = os.homedir();
    const libexecDir = path.join(homeDir, '.local', 'libexec', 'antigravity-proxy');
    const launcherPath = path.join(libexecDir, 'agy');
    const agyNativePath = path.join(homeDir, '.local', 'bin', 'agy');
    const agyBinPath = path.join(homeDir, '.local', 'bin', 'agy.bin');
    const trustBundlePath = path.join(getCertsDir(), 'agy-trust.pem');

    try {
      // Legacy cleanup: if agy.bin exists and agy is not an ELF binary, restore agy.bin to agy
      if (fs.existsSync(agyBinPath) && (!fs.existsSync(agyNativePath) || !this.isElfFile(agyNativePath))) {
        logger.info('[Launcher] Restoring native binary from agy.bin to agy');
        fs.renameSync(agyBinPath, agyNativePath);
      }

      fs.mkdirSync(libexecDir, { recursive: true });

      const wrapperContent = `#!/bin/sh
# Managed Antigravity CLI Launcher with Transparent HTTPS Proxy Failover
# Installed at: ${launcherPath}

AGY_REAL="${agyNativePath}"
TRUST_BUNDLE="${trustBundlePath}"
PROXY_URL="http://127.0.0.1:8046"

if [ ! -x "$AGY_REAL" ]; then
    printf '%s\\n' 'agy launcher: native executable is unavailable' >&2
    exit 126
fi

if [ ! -r "$TRUST_BUNDLE" ]; then
    printf '%s\\n' 'agy launcher: managed trust bundle is unavailable' >&2
    exit 78
fi

unset AGY_CLI_DISABLE_AUTO_UPDATE

export HTTPS_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL"
export NO_PROXY='localhost,127.0.0.1,::1'
export no_proxy='localhost,127.0.0.1,::1'
export SSL_CERT_FILE="$TRUST_BUNDLE"

exec "$AGY_REAL" "$@"
`;

      let needsWrite = true;
      if (fs.existsSync(launcherPath)) {
        const existing = fs.readFileSync(launcherPath, 'utf-8');
        if (existing === wrapperContent) {
          needsWrite = false;
        }
      }

      if (needsWrite) {
        const tempPath = path.join(libexecDir, `agy.tmp.${crypto.randomUUID()}`);
        fs.writeFileSync(tempPath, wrapperContent, { encoding: 'utf-8', mode: 0o755 });
        fs.renameSync(tempPath, launcherPath);
        logger.info(`[Launcher] Atomically published managed launcher at: ${launcherPath}`);
      }

      this.observeAgyBinary(agyNativePath);
    } catch (err) {
      logger.warn('[Launcher] Failed to ensure managed launcher', err);
    }
  }

  private static isElfFile(filePath: string): boolean {
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

  private static observeAgyBinary(nativePath: string): void {
    if (!fs.existsSync(nativePath)) {
      return;
    }

    try {
      const updatesDir = path.join(os.homedir(), '.antigravity-proxy', 'updates');
      fs.mkdirSync(updatesDir, { recursive: true });

      const statePath = path.join(updatesDir, 'state.json');
      const historyPath = path.join(updatesDir, 'history.jsonl');
      const noticePath = path.join(updatesDir, 'notice.txt');

      const fileBuffer = fs.readFileSync(nativePath);
      const currentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      let prevState: { sha256?: string; version?: string } = {};
      if (fs.existsSync(statePath)) {
        try {
          prevState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        } catch {
          prevState = {};
        }
      }

      if (prevState.sha256 !== currentHash) {
        let reportedVersion = 'unknown';
        try {
          const out = execFileSync(nativePath, ['--version'], { timeout: 3000, encoding: 'utf-8' });
          const match = out.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
          if (match) {
            reportedVersion = match[1];
          }
        } catch {
          // ignore probe error
        }

        const isInitial = !prevState.sha256;
        const eventId = `event-${Date.now()}`;
        const newState = {
          sha256: currentHash,
          version: reportedVersion,
          observedAt: new Date().toISOString(),
        };

        fs.writeFileSync(statePath, JSON.stringify(newState, null, 2), 'utf-8');

        if (!isInitial) {
          const oldVersion = prevState.version || 'unknown';
          logger.info(`[UpdateObserver] Detected native agy binary update: ${oldVersion} -> ${reportedVersion} (${currentHash.slice(0, 8)})`);

          const historyEntry = JSON.stringify({
            eventId,
            timestamp: new Date().toISOString(),
            previousHash: prevState.sha256,
            currentHash,
            previousVersion: oldVersion,
            currentVersion: reportedVersion,
          }) + '\n';
          fs.appendFileSync(historyPath, historyEntry, 'utf-8');

          const tempNotice = path.join(updatesDir, `notice.tmp.${crypto.randomUUID()}`);
          fs.writeFileSync(
            tempNotice,
            `${eventId}\nGoogle Antigravity CLI updated: version ${oldVersion} -> ${reportedVersion}; proxy failover active.\n`,
            { encoding: 'utf-8', mode: 0o644 },
          );
          fs.renameSync(tempNotice, noticePath);
        } else {
          logger.info(`[UpdateObserver] Baseline established for agy binary: version ${reportedVersion} (${currentHash.slice(0, 8)})`);
        }
      }
    } catch (err) {
      logger.debug('[UpdateObserver] Failed to observe agy binary', err);
    }
  }

  static getTrustBundlePath(): string {
    const certsDir = getCertsDir();
    const trustBundlePath = path.join(certsDir, 'agy-trust.pem');
    if (!fs.existsSync(trustBundlePath)) {
      this.ensureCertificates();
    }
    return trustBundlePath;
  }

  static getSecureContext(): tls.SecureContext {
    return this.ensureCertificates();
  }
}
