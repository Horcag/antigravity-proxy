import crypto from 'node:crypto';
import fs from 'node:fs';
import { getMasterKeyPath } from '@/shared/paths';

const ENVELOPE_VERSION = 'agp1';
let cachedMasterKey: Buffer | null = null;

function parseMasterKey(value: string, source: string): Buffer {
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error(`${source} must contain exactly 64 hexadecimal characters`);
  }
  return Buffer.from(normalized, 'hex');
}

function createMasterKeyFile(keyPath: string): Buffer {
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, `${key.toString('hex')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    return parseMasterKey(fs.readFileSync(keyPath, 'utf8'), keyPath);
  }
}

export function getMasterKey(): Buffer {
  if (cachedMasterKey) {
    return cachedMasterKey;
  }
  const fromEnvironment = process.env.AG_PROXY_MASTER_KEY;
  cachedMasterKey = fromEnvironment
    ? parseMasterKey(fromEnvironment, 'AG_PROXY_MASTER_KEY')
    : (() => {
        const keyPath = getMasterKeyPath();
        return fs.existsSync(keyPath)
          ? parseMasterKey(fs.readFileSync(keyPath, 'utf8'), keyPath)
          : createMasterKeyFile(keyPath);
      })();
  return cachedMasterKey;
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptJson<T>(envelope: string): T {
  const [version, ivValue, tagValue, ciphertextValue] = envelope.split(':');
  if (version !== ENVELOPE_VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Encrypted value has an unsupported or invalid format');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getMasterKey(),
    Buffer.from(ivValue, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function resetMasterKeyCacheForTesting(): void {
  cachedMasterKey = null;
}
