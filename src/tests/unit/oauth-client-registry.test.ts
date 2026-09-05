import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const OAUTH_CLIENTS_ENV = 'ANTIGRAVITY_OAUTH_CLIENTS';
const originalExtraClients = process.env[OAUTH_CLIENTS_ENV];

function restoreEnvironment(): void {
  if (originalExtraClients === undefined) {
    delete process.env[OAUTH_CLIENTS_ENV];
    return;
  }
  process.env[OAUTH_CLIENTS_ENV] = originalExtraClients;
}

describe('OAuthClientRegistryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnvironment();
    vi.resetModules();
  });

  it('logs only bounded metadata for malformed OAuth client entries', async () => {
    const rawValues = ['oauth-client-key-canary', 'oauth-client-secret-canary'];
    const canaries = rawValues.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    process.env[OAUTH_CLIENTS_ENV] = `${rawValues[0]}|${rawValues[1]};${rawValues[0]}||${rawValues[1]}`;
    vi.resetModules();

    const { logger } = await import('@/shared/logging/logger');
    const warnSpy = vi.spyOn(logger, 'warn');
    const { OAuthClientRegistryService } = await import(
      '@/modules/cloud-account/services/OAuthClientRegistryService'
    );

    OAuthClientRegistryService.listOAuthClients();
    const diagnostics = warnSpy.mock.calls.flat().map(String).join('\n');

    expect(diagnostics).toContain('category=invalid_field_count index=1 count=2');
    expect(diagnostics).toContain('category=incomplete_required_fields index=2 count=2');
    for (const canary of canaries) {
      expect(diagnostics).not.toContain(canary);
    }
  });
});
