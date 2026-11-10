import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { ProxyRetryPolicy } from '@/modules/proxy-gateway/server/proxy-retry-policy';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';

function account(id: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: `project-${id}`,
    },
    created_at: 1,
    last_used: 1,
  };
}

function createAccountLeaseService(accounts: CloudAccount[]) {
  return {
    getModelCapableAccountCount: vi.fn().mockReturnValue(accounts.length),
    getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(accounts.length),
    getNextToken: vi.fn(
      async (options?: { excludeAccountIds?: string[] }): Promise<CloudAccount | null> => {
        const excluded = new Set(options?.excludeAccountIds ?? []);
        return accounts.find((candidate) => !excluded.has(candidate.id)) ?? null;
      },
    ),
    resolveDynamicModelForAccount: vi.fn(
      (_accountId: string, model: string): string => model,
    ),
    getModelOutputLimitForAccount: vi.fn().mockReturnValue(undefined),
    getModelThinkingBudgetForAccount: vi.fn().mockReturnValue(undefined),
    recordParityError: vi.fn(),
    markAsForbidden: vi.fn(),
    markAsRateLimited: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    markModelSuccess: vi.fn(),
    markModelUnrequestable: vi.fn(),
  };
}

function geminiDataFrame(payload: unknown): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
}

describe('Pre-stream recovery', () => {
  it('does not penalize or retry an upstream failure arriving after client cancellation', async () => {
    const accountLeaseService = createAccountLeaseService([]);
    const policy = new ProxyRetryPolicy(accountLeaseService, { log: vi.fn(), warn: vi.fn() });
    const controller = new AbortController(); const state = policy.createTokenRetryState(controller.signal);
    const release = vi.fn(); state.activeReservation = release;
    controller.abort();
    await expect(policy.applyUpstreamPenalty('acc-1', 'gemini-3-flash',
      new UpstreamRequestError({ status: 503 }), state)).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(accountLeaseService.recordParityError).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    policy.disposeTokenRetryState(state);
  });

  it.each([408, 499, 500, 502, 503, 504, undefined])(
    'retries a pre-stream failure (%s) on another account without a nonstream detour', async (status) => {
      const lease = createAccountLeaseService([account('failed'), account('healthy')]);
      const upstream = {
        streamGenerateInternal: vi.fn()
          .mockRejectedValueOnce(new UpstreamRequestError({ status, reason: status === undefined ? 'transport' : 'upstream_error' }))
          .mockResolvedValueOnce(Readable.from([geminiDataFrame({
            candidates: [{ content: { parts: [{ text: 'recovered' }] }, finishReason: 'STOP' }],
          })])),
        generateInternal: vi.fn(),
      };
      const service = new ProxyService(lease as never, upstream as never);
      vi.spyOn(service as any, 'waitBeforeRetry').mockResolvedValue(undefined);
      const result = await service.handleChatCompletions({
        model: 'gemini-3.8-flash-high', stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      });
      const chunks = await new Promise<string[]>((resolve, reject) => {
        const received: string[] = [];
        (result as import('rxjs').Observable<string>).subscribe({
          next: (chunk) => received.push(chunk), complete: () => resolve(received), error: reject,
        });
      });
      expect(chunks.join('')).toContain('recovered');
      expect(chunks.join('')).toContain('[DONE]');
      expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(2);
      expect(upstream.streamGenerateInternal.mock.calls.map((call) => call[4])).toEqual(['failed', 'healthy']);
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(lease.markAsForbidden).not.toHaveBeenCalled();
    },
  );
});
