import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';

import type { CloudAccount } from '@/modules/cloud-account/types';
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
    markModelUnrequestable: vi.fn(),
  };
}

describe('ProxyService account failover', () => {
  it('tries compatible accounts beyond the former three-attempt limit', async () => {
    const accounts = Array.from({ length: 5 }, (_, index) => account(`acc-${index + 1}`));
    const accountLeaseService = createAccountLeaseService(accounts);
    const quotaError = () =>
      new UpstreamRequestError({
        message: 'quota exhausted',
        status: 429,
        body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}',
      });
    const geminiClient = {
      generateInternal: vi
        .fn()
        .mockRejectedValueOnce(quotaError())
        .mockRejectedValueOnce(quotaError())
        .mockRejectedValueOnce(quotaError())
        .mockRejectedValueOnce(quotaError())
        .mockResolvedValueOnce({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
        }),
    };
    const service = new ProxyService(accountLeaseService as any, geminiClient as any);
    vi.spyOn((service as any).retryPolicy, 'waitBeforeRetry').mockResolvedValue(undefined);

    await expect(
      service.handleGeminiGenerateContent('gemini-3.1-flash-image', {
        contents: [{ role: 'user', parts: [{ text: 'generate' }] }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ content: expect.objectContaining({ parts: [{ text: 'ok' }] }) }),
        ]),
      }),
    );

    expect(geminiClient.generateInternal).toHaveBeenCalledTimes(5);
    expect(accountLeaseService.getNextToken).toHaveBeenCalledTimes(5);
    expect(
      accountLeaseService.getNextToken.mock.calls.map(
        ([options]) => options?.excludeAccountIds,
      ),
    ).toEqual([
      [],
      ['acc-1'],
      ['acc-1', 'acc-2'],
      ['acc-1', 'acc-2', 'acc-3'],
      ['acc-1', 'acc-2', 'acc-3', 'acc-4'],
    ]);
  });

  it('retries an advertised text preset after upstream rejects the model id', async () => {
    const accounts = [account('acc-1'), account('acc-2')];
    const accountLeaseService = createAccountLeaseService(accounts);
    const geminiClient = {
      generateInternal: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamRequestError({
            message: 'Requested entity was not found.',
            status: 404,
          }),
        )
        .mockResolvedValueOnce({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
        }),
    };
    const service = new ProxyService(accountLeaseService as any, geminiClient as any);
    vi.spyOn((service as any).retryPolicy, 'waitBeforeRetry').mockResolvedValue(undefined);

    await expect(
      service.handleGeminiGenerateContent('gemini-3.7-flash-high', {
        contents: [{ role: 'user', parts: [{ text: 'reply ok' }] }],
      }),
    ).resolves.toEqual(expect.objectContaining({ candidates: expect.any(Array) }));

    expect(geminiClient.generateInternal).toHaveBeenCalledTimes(2);
    expect(accountLeaseService.markModelUnrequestable).toHaveBeenCalledWith(
      'gemini-3.7-flash-high',
    );
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it('reports missing model capability as service unavailable instead of rate limited', async () => {
    const accountLeaseService = createAccountLeaseService([]);
    const service = new ProxyService(accountLeaseService as any, {} as any);

    await expect(
      service.handleGeminiGenerateContent('missing-image-model', {
        contents: [{ role: 'user', parts: [{ text: 'generate' }] }],
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'No account advertises a compatible upstream model for missing-image-model',
    });
  });

  it('refreshes model capability before proxy preflight rejects a request', async () => {
    const accounts = [account('acc-1')];
    const accountLeaseService = {
      ...createAccountLeaseService(accounts),
      getModelCapableAccountCount: vi.fn().mockReturnValue(0),
      getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(1),
    };
    const geminiClient = {
      generateInternal: vi.fn().mockResolvedValue({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      }),
    };
    const service = new ProxyService(accountLeaseService as any, geminiClient as any);

    await expect(
      service.handleGeminiGenerateContent('gemini-new-flash-high', {
        contents: [{ role: 'user', parts: [{ text: 'reply' }] }],
      }),
    ).resolves.toEqual(expect.objectContaining({ candidates: expect.any(Array) }));

    expect(accountLeaseService.getRefreshedModelCapableAccountCount).toHaveBeenCalledWith(
      'gemini-new-flash-high',
    );
    expect(accountLeaseService.getNextToken).toHaveBeenCalledWith({
      excludeAccountIds: [],
      model: 'gemini-new-flash-high',
      sessionKey: undefined,
    });
  });
});
