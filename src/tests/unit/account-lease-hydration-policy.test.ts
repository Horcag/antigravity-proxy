import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseHydrationPolicy } from '@/modules/proxy-gateway/server/account-lease-hydration-policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/account-lease-token-types';

function createToken(accountId: string, overrides: Partial<AccountLeaseTokenData> = {}) {
  return {
    account_id: accountId,
    email: 'hydration-email-canary@example.test',
    access_token: 'hydration-access-token-canary',
    refresh_token: 'hydration-refresh-token-canary',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: 10_000,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  } satisfies AccountLeaseTokenData;
}

describe('AccountLeaseHydrationPolicy diagnostics', () => {
  it('redacts account, token, project, and upstream-error canaries from hydration logs', async () => {
    const accountId = 'hydration-account-id-canary';
    const projectId = 'hydration-project-id-canary';
    const upstreamError = 'hydration-upstream-error-canary';
    const tokenCache = new Map<string, AccountLeaseTokenData>();
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    };
    const refreshToken = createToken(accountId, { expiry_timestamp: 0 });
    const resolvedProjectToken = createToken('resolved-project-account');
    const fallbackProjectToken = createToken('fallback-project-account');
    tokenCache.set(accountId, refreshToken);
    tokenCache.set(resolvedProjectToken.account_id, resolvedProjectToken);
    tokenCache.set(fallbackProjectToken.account_id, fallbackProjectToken);

    const policy = new AccountLeaseHydrationPolicy({
      accountStore: {
        getAccounts: vi.fn(),
        getAccount: vi.fn(),
        updateQuota: vi.fn(),
        updateQuotaIfCurrent: vi.fn().mockReturnValue(true),
        updateToken: vi.fn(),
        updateTokenIfCurrent: vi.fn().mockReturnValue(true),
        updateLastUsed: vi.fn(),
        updateLastUsedIfCurrent: vi.fn().mockReturnValue(true),
      },
      upstream: {
        fetchQuota: vi.fn(),
        refreshAccessToken: vi.fn().mockRejectedValue(new Error(upstreamError)),
        fetchProjectId: vi
          .fn()
          .mockResolvedValueOnce(projectId)
          .mockResolvedValueOnce(null),
        normalizeRefreshedOAuthClientKey: vi.fn(),
      },
      getTokenCache: () => tokenCache,
      logger,
      persistTokenState: vi.fn().mockResolvedValue(undefined),
    });

    await policy.refreshSelectedTokenIfNeeded(accountId, refreshToken, 1);
    await policy.hydrateSelectedToken({
      accountId: resolvedProjectToken.account_id,
      tokenData: resolvedProjectToken,
      nowSeconds: 1,
      fallbackProjectId: `fallback-${projectId}`,
    });
    await policy.hydrateSelectedToken({
      accountId: fallbackProjectToken.account_id,
      tokenData: fallbackProjectToken,
      nowSeconds: 1,
      fallbackProjectId: `fallback-${projectId}`,
    });

    const diagnostics = Object.values(logger)
      .flatMap((method) => method.mock.calls)
      .flat()
      .map(String)
      .join('\n');
    const canaries = [
      accountId,
      projectId,
      upstreamError,
      refreshToken.email,
      refreshToken.access_token,
      refreshToken.refresh_token,
    ];

    expect(diagnostics).toContain('operation=refresh_token reason=refresh_failed');
    expect(diagnostics).toContain('operation=project_context reason=project_resolved');
    expect(diagnostics).toContain('operation=project_context reason=fallback_project');
    for (const canary of canaries) {
      expect(diagnostics).not.toContain(canary);
      expect(diagnostics).not.toContain(Buffer.from(canary).toString('base64'));
      expect(diagnostics).not.toContain(createHash('sha256').update(canary).digest('hex'));
    }
  });
});
