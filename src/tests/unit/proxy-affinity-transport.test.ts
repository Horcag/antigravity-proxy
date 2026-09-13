import { expect, it, vi } from 'vitest';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

it('aborts the in-flight native transport when its affinity placement owner expires', async () => {
  const owner = new AbortController();
  const account = { id: 'affinity-owner', token: { access_token: 'token', project_id: 'project' } };
  const accountLeaseService: any = {
    getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(1),
    acquireAttemptLease: vi.fn().mockResolvedValue({ account, generation: 1, tableIncarnation: 1,
      breakerGeneration: 0, releaseReservation: vi.fn(), affinityAbortSignal: owner.signal }),
    resolveDynamicModelForAccount: vi.fn((_id: string, model: string) => model),
    getModelOutputLimitForAccount: vi.fn(), getModelThinkingBudgetForAccount: vi.fn(),
    recordParityError: vi.fn(), markAsForbidden: vi.fn(), markAsRateLimited: vi.fn(),
    markFromUpstreamError: vi.fn(), markModelSuccess: vi.fn(), markModelUnrequestable: vi.fn(),
  };
  const transportObservedAbort = vi.fn();
  const geminiClient: any = { generateInternal: vi.fn((...args: unknown[]) => new Promise((_resolve, reject) => {
    (args.at(-1) as AbortSignal | undefined)?.addEventListener('abort', () => {
      transportObservedAbort(); reject(new Error('transport cancelled'));
    }, { once: true });
  })) };
  const service = new ProxyService(accountLeaseService, geminiClient);
  const result = service.handlePreflightedGeminiGenerateContent(
    'gemini-2.5-pro', { contents: [{ role: 'user', parts: [{ text: 'slow request' }] }] } as any,
  );
  await vi.waitFor(() => expect(geminiClient.generateInternal).toHaveBeenCalledOnce());
  owner.abort();
  await expect(result).rejects.toThrow();
  expect(transportObservedAbort).toHaveBeenCalledOnce();
});
