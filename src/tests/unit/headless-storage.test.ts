import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { resetMasterKeyCacheForTesting } from '@/shared/security/encryption';

describe('headless encrypted account storage', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-proxy-test-'));
    process.env.AG_PROXY_DATA_DIR = dataDir;
    process.env.AG_PROXY_MASTER_KEY = '11'.repeat(32);
    resetMasterKeyCacheForTesting();
  });

  afterEach(() => {
    CloudAccountRepo.close();
    resetMasterKeyCacheForTesting();
    delete process.env.AG_PROXY_DATA_DIR;
    delete process.env.AG_PROXY_MASTER_KEY;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips an account without storing token plaintext in SQLite', async () => {
    const secretAccessToken = 'access-token-that-must-not-appear-in-the-database';
    const secretRefreshToken = 'refresh-token-that-must-not-appear-in-the-database';
    await CloudAccountRepo.addAccount({
      id: 'account-1',
      provider: 'google',
      email: 'account@example.com',
      token: {
        access_token: secretAccessToken,
        refresh_token: secretRefreshToken,
        expires_in: 3600,
        expiry_timestamp: 4_000_000_000,
        token_type: 'Bearer',
      },
      created_at: 1,
      last_used: 1,
      status: 'active',
    });

    await expect(CloudAccountRepo.getAccount('account-1')).resolves.toMatchObject({
      email: 'account@example.com',
      token: {
        access_token: secretAccessToken,
        refresh_token: secretRefreshToken,
      },
    });

    const databaseBytes = fs.readFileSync(path.join(dataDir, 'accounts.db'));
    expect(databaseBytes.includes(Buffer.from(secretAccessToken))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(secretRefreshToken))).toBe(false);
  });
});
