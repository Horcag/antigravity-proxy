import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
    return this.secureContext;
  }

  static getSecureContext(): tls.SecureContext {
    return this.ensureCertificates();
  }
}
