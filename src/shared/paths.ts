import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getDataDir(): string {
  const configured = process.env.AG_PROXY_DATA_DIR?.trim();
  const dataDir = configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.antigravity-proxy');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
}

export function getDatabasePath(): string {
  return path.join(getDataDir(), 'accounts.db');
}

export function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

export function getMasterKeyPath(): string {
  return path.join(getDataDir(), '.master-key');
}

export function getCertsDir(): string {
  const dir = path.join(getDataDir(), 'certs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getCaCertPath(): string {
  return path.join(getCertsDir(), 'ca.crt');
}

export function getCaKeyPath(): string {
  return path.join(getCertsDir(), 'ca.key');
}
