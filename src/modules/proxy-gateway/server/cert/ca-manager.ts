import { execFileSync } from 'node:child_process';
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
  'generativelanguage.googleapis.com',
] as const;

export class CaManager {
  private static secureContext: tls.SecureContext | null = null;

  static isTargetHost(destination: string): boolean {
    const hostOnly = destination.split(':')[0]?.trim().toLowerCase();
    if (!hostOnly) {
      return false;
    }
    return (
      TARGET_CLOUDCODE_HOSTS.some((target) => hostOnly === target) ||
      hostOnly.includes('cloudcode-pa') ||
      hostOnly.endsWith('generativelanguage.googleapis.com')
    );
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
    const agyPath = path.join(homeDir, '.local', 'bin', 'agy');
    const agyBinPath = path.join(homeDir, '.local', 'bin', 'agy.bin');

    try {
      if (!fs.existsSync(agyPath) && !fs.existsSync(agyBinPath)) {
        return;
      }

      let shouldRewrap = false;
      if (fs.existsSync(agyPath)) {
        const buffer = Buffer.alloc(4);
        const fd = fs.openSync(agyPath, 'r');
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);

        // Check if agy is an ELF binary (magic: 0x7f, 'E', 'L', 'F')
        if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
          logger.info('[CaManager] Detected ELF binary at agy path; moving to agy.bin and restoring failover wrapper');
          fs.renameSync(agyPath, agyBinPath);
          shouldRewrap = true;
        }
      } else if (fs.existsSync(agyBinPath)) {
        shouldRewrap = true;
      }

      if (shouldRewrap) {
        const wrapperScript = `#!/usr/bin/env bash
# Managed Antigravity CLI Launcher with Transparent HTTPS Proxy Failover

PROXY_PORT="\${AG_PROXY_PORT:-8046}"
PROXY_URL="\${HTTPS_PROXY:-http://127.0.0.1:\${PROXY_PORT}}"
TRUST_BUNDLE="\${SSL_CERT_FILE:-${homeDir}/.antigravity-proxy/certs/agy-trust.pem}"

if [[ ! -f "$TRUST_BUNDLE" ]]; then
  TRUST_BUNDLE="${homeDir}/.antigravity-proxy/certs/ca.crt"
fi

export HTTPS_PROXY="$PROXY_URL"
export https_proxy="$PROXY_URL"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"
export SSL_CERT_FILE="$TRUST_BUNDLE"

exec "${agyBinPath}" "$@"
`;
        fs.writeFileSync(agyPath, wrapperScript, { encoding: 'utf-8', mode: 0o755 });
        logger.info(`[CaManager] Restored failover launcher at ${agyPath}`);
      }
    } catch (err) {
      logger.warn('[CaManager] Failed to ensure agy launcher wrapper', err);
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
