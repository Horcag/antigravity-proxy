import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { PassThrough } from 'node:stream';

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
    markModelSuccess: vi.fn(),
    markModelUnrequestable: vi.fn(),
  };
}

function geminiDataFrame(payload: unknown): Buffer {
  return Buffer.from(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
}

function validGeminiFrame(text: string): Buffer {
  return geminiDataFrame({
    candidates: [{ content: { parts: [{ text }] } }],
  });
}

describe('ProxyService account failover', () => {
  it.each([
    [
      'malformed frame before valid content',
      (malformedFrame: Buffer) => [malformedFrame, validGeminiFrame('later valid content')],
    ],
    [
      'malformed frame after valid content',
      (malformedFrame: Buffer) => [validGeminiFrame('initial valid content'), malformedFrame],
    ],
    ['malformed frame without valid content', (malformedFrame: Buffer) => [malformedFrame]],
  ])('fails closed on a %s', async (_scenario, createFrames) => {
    const rawCanary = 'malformed-gemini-fallback-canary';
    const canaries = [
      rawCanary,
      Buffer.from(rawCanary).toString('base64'),
      createHash('sha256').update(rawCanary).digest('hex'),
    ];
    const stream = Readable.from(createFrames(geminiDataFrame(canaries.join('|'))));
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const destroyUpstreamStream = vi.spyOn(service as any, 'destroyUpstreamStream');
    const terminalSettlements = vi.fn();
    const result = await (service as any).collectGeminiStreamAsResponse(stream).then(
      (response: unknown) => {
        terminalSettlements('resolved');
        return response;
      },
      (error: unknown) => {
        terminalSettlements('rejected');
        return error;
      },
    );
    const serialized = JSON.stringify({
      error: result,
      message: result instanceof Error ? result.message : undefined,
      stack: result instanceof Error ? result.stack : undefined,
    });

    expect(result).toMatchObject({ name: 'UpstreamRequestError', reason: 'upstream_error' });
    expect(terminalSettlements).toHaveBeenCalledTimes(1);
    expect(terminalSettlements).toHaveBeenCalledWith('rejected');
    expect(destroyUpstreamStream).toHaveBeenCalledTimes(1);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it.each([
    ['before valid content', [geminiDataFrame({}), validGeminiFrame('later valid content')]],
    ['after valid content', [validGeminiFrame('initial valid content'), geminiDataFrame({})]],
    ['without valid content', [geminiDataFrame({})]],
  ])('fails closed when an empty object fallback frame appears %s', async (_scenario, frames) => {
    const stream = Readable.from(frames);
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const destroyUpstreamStream = vi.spyOn(service as any, 'destroyUpstreamStream');

    const result = await (service as any)
      .collectGeminiStreamAsResponse(stream)
      .catch((error: unknown) => error);

    expect(result).toMatchObject({ name: 'UpstreamRequestError', reason: 'upstream_error' });
    expect(destroyUpstreamStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['array', []],
    ['primitive', 'fallback-structure-canary'],
    ['empty candidates', { candidates: [] }],
    ['candidate object without a response field', { candidates: [{}] }],
    ['candidate with an empty part', { candidates: [{ content: { parts: [{}] } }] }],
    ['usage metadata with an invalid field', { usageMetadata: { promptTokenCount: 'one' } }],
    ['prompt feedback with an invalid field', { promptFeedback: { blockReason: 1 } }],
    ['model version with an invalid field', { modelVersion: 1 }],
    ['response id with an empty field', { responseId: '' }],
  ])('rejects JSON-valid invalid fallback %s without false success or disclosure', async (_case, payload) => {
    const rawCanary = 'fallback-structure-canary';
    const canaries = [
      rawCanary,
      Buffer.from(rawCanary).toString('base64'),
      createHash('sha256').update(rawCanary).digest('hex'),
    ];
    const stream = Readable.from([validGeminiFrame('initial valid content'), geminiDataFrame(payload)]);
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const destroyUpstreamStream = vi.spyOn(service as any, 'destroyUpstreamStream');
    const terminalSettlements = vi.fn();
    const result = await (service as any).collectGeminiStreamAsResponse(stream).then(
      () => terminalSettlements('resolved'),
      (error: unknown) => {
        terminalSettlements('rejected');
        return error;
      },
    );
    const serialized = JSON.stringify({
      error: result,
      message: result instanceof Error ? result.message : undefined,
      stack: result instanceof Error ? result.stack : undefined,
    });

    expect(result).toMatchObject({ name: 'UpstreamRequestError', reason: 'upstream_error' });
    expect(terminalSettlements).toHaveBeenCalledTimes(1);
    expect(terminalSettlements).toHaveBeenCalledWith('rejected');
    expect(destroyUpstreamStream).toHaveBeenCalledTimes(1);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('preserves valid fallback aggregation, keepalives, and completion', async () => {
    const stream = Readable.from([
      Buffer.from(': keepalive\n'),
      Buffer.from('data:\n'),
      validGeminiFrame('first'),
      validGeminiFrame('second'),
      Buffer.from('data: [DONE]\n'),
    ]);
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const destroyUpstreamStream = vi.spyOn(service as any, 'destroyUpstreamStream');
    const terminalSettlements = vi.fn();
    const response = await (service as any).collectGeminiStreamAsResponse(stream).then(
      (value: unknown) => {
        terminalSettlements('resolved');
        return value;
      },
      (error: unknown) => {
        terminalSettlements('rejected');
        throw error;
      },
    );

    expect(response).toMatchObject({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'first' }, { text: 'second' }],
          },
        },
      ],
    });
    expect(terminalSettlements).toHaveBeenCalledTimes(1);
    expect(terminalSettlements).toHaveBeenCalledWith('resolved');
    expect(destroyUpstreamStream).not.toHaveBeenCalled();
  });

  it('preserves valid metadata-only fallback frames around valid candidates', async () => {
    const stream = Readable.from([
      Buffer.from(': keepalive\n'),
      geminiDataFrame({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }),
      geminiDataFrame({ promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' } }),
      geminiDataFrame({ modelVersion: 'gemini-3.1-flash', responseId: 'response-123' }),
      validGeminiFrame('first'),
      geminiDataFrame({ candidates: [{ finishReason: 'STOP' }] }),
      Buffer.from('data: [DONE]\n'),
    ]);
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);

    await expect((service as any).collectGeminiStreamAsResponse(stream)).resolves.toMatchObject({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'first' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
      modelVersion: 'gemini-3.1-flash',
      responseId: 'response-123',
    });
  });

  it('redacts raw stream failures while preserving safe upstream classifications', async () => {
    const rawValues = [
      'stream-upstream-response-canary',
      'stream-credential-canary',
      'stream-account-canary',
      'stream-project-canary',
      'stream-model-canary',
      'http://stream-proxy-user:stream-proxy-password@proxy.example.test',
    ];
    const canaries = rawValues.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);
    const stream = new Readable({ read() {} });
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const collected = (service as any).collectGeminiStreamAsResponse(stream);
    const terminalSettlements = vi.fn();
    stream.destroy(new Error(canaries.join('|')));
    const error = await collected.then(
      (response: unknown) => {
        terminalSettlements('resolved');
        return response;
      },
      (caught: unknown) => {
        terminalSettlements('rejected');
        return caught;
      },
    );
    const serialized = JSON.stringify({
      error,
      message: error instanceof Error ? error.message : undefined,
      stack: error instanceof Error ? error.stack : undefined,
      cause: error instanceof Error ? error.cause : undefined,
    });

    expect(error).toMatchObject({ name: 'UpstreamRequestError', reason: 'transport' });
    expect(terminalSettlements).toHaveBeenCalledTimes(1);
    expect(terminalSettlements).toHaveBeenCalledWith('rejected');
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('fails stream fallback tool-call ID conflicts without retaining upstream IDs', async () => {
    const rawToolCallId = 'tool-call-id-canary';
    const canaries = [
      rawToolCallId,
      Buffer.from(rawToolCallId).toString('base64'),
      createHash('sha256').update(rawToolCallId).digest('hex'),
    ];
    const stream = Readable.from([
      Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { args: { value: 1 }, id: rawToolCallId, name: 'one' } }] } }] })}\n`),
      Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { args: { value: 2 }, id: rawToolCallId, name: 'two' } }] } }] })}\n`),
    ]);
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const error = await (service as any).collectGeminiStreamAsResponse(stream).catch((caught: unknown) => caught);
    const serialized = JSON.stringify({ error, message: error instanceof Error ? error.message : undefined });

    expect(error).toMatchObject({ name: 'UpstreamRequestError', reason: 'upstream_error' });
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('normalizes bounded string stream statuses without retaining upstream text', () => {
    const service = new ProxyService(createAccountLeaseService([]) as any, {} as any);
    const cases = [
      ['UNAUTHENTICATED', 401, 'authentication'],
      ['PERMISSION_DENIED', 403, 'authentication'],
      ['RESOURCE_EXHAUSTED', 429, 'rate_limited'],
      ['UNAVAILABLE', 503, 'upstream_error'],
    ] as const;

    for (const [rawStatus, expectedStatus, expectedReason] of cases) {
      const typed = (service as any).getUpstreamStreamError({ error: { code: expectedStatus } });
      const stringStatus = (service as any).getUpstreamStreamError({
        error: { message: `${rawStatus}-detail-canary`, status: rawStatus },
      });
      const serialized = JSON.stringify({ typed, stringStatus });
      expect(stringStatus).toMatchObject({ status: expectedStatus, reason: expectedReason });
      expect(stringStatus).toMatchObject({ status: typed.status, reason: typed.reason });
      expect(serialized).not.toContain(rawStatus);
      expect(serialized).not.toContain(`${rawStatus}-detail-canary`);
    }
  });

  it('tries compatible accounts beyond the former three-attempt limit', async () => {
    const accounts = Array.from({ length: 5 }, (_, index) => account(`acc-${index + 1}`));
    const accountLeaseService = createAccountLeaseService(accounts);
    const quotaError = () =>
      new UpstreamRequestError({
        status: 429,
        reason: 'quota_exhausted',
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
    expect(accountLeaseService.markModelSuccess).toHaveBeenCalledWith(
      'acc-5',
      'gemini-3.1-flash-image',
    );
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
            status: 404,
            reason: 'model_not_found',
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
      'acc-1',
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
      message: 'No account advertises a compatible upstream model.',
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

  it('recomputes safety settings from the selected cross-family target for non-stream requests', async () => {
    const accountLeaseService = createAccountLeaseService([account('acc-1')]);
    accountLeaseService.resolveDynamicModelForAccount.mockReturnValue('gpt-oss-120b-medium');
    const geminiClient = {
      generateInternal: vi.fn().mockResolvedValue({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      }),
    };
    const service = new ProxyService(accountLeaseService as any, geminiClient as any);

    await service.handleAnthropicMessages({
      model: 'claude-sonnet-4-6',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);
    await service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    await service.handleChatCompletions({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    expect(geminiClient.generateInternal).toHaveBeenCalledTimes(3);
    for (const [body] of geminiClient.generateInternal.mock.calls) {
      expect(body.model).toBe('gpt-oss-120b-medium');
      expect(body.request.safetySettings).toBeUndefined();
    }
  });

  it('recomputes safety settings from the selected cross-family target for stream requests', async () => {
    const accountLeaseService = createAccountLeaseService([account('acc-1')]);
    accountLeaseService.resolveDynamicModelForAccount.mockReturnValue('gpt-oss-120b-medium');
    const geminiClient = {
      streamGenerateInternal: vi.fn().mockImplementation(() => new PassThrough()),
    };
    const service = new ProxyService(accountLeaseService as any, geminiClient as any);

    await service.handleAnthropicMessages({
      model: 'claude-sonnet-4-6',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    } as any);
    await service.handleGeminiStreamGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    await service.handleChatCompletions({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    } as any);

    expect(geminiClient.streamGenerateInternal).toHaveBeenCalledTimes(3);
    for (const [body] of geminiClient.streamGenerateInternal.mock.calls) {
      expect(body.model).toBe('gpt-oss-120b-medium');
      expect(body.request.safetySettings).toBeUndefined();
    }
  });
});
