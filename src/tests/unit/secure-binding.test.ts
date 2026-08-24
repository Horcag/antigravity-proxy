import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { bootstrapNestServer } from '@/server/main';

describe('remote binding security', () => {
  it('rejects non-loopback binding without separate proxy and admin keys', async () => {
    await expect(
      bootstrapNestServer({
        ...DEFAULT_PROXY_CONFIG,
        host: '100.110.245.111',
        api_key: '',
        admin_api_key: '',
      }),
    ).resolves.toMatchObject({
      success: false,
      reason: 'invalid-config',
    });

    await expect(
      bootstrapNestServer({
        ...DEFAULT_PROXY_CONFIG,
        host: '100.110.245.111',
        api_key: 'same-key',
        admin_api_key: 'same-key',
      }),
    ).resolves.toMatchObject({
      success: false,
      reason: 'invalid-config',
    });
  });
});
