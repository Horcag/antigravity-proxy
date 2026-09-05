import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudAccount } from '@/modules/cloud-account/types';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

function account(id = 'account-a'): CloudAccount {
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

function createAccountLeaseService(selectedAccount = account()) {
  return {
    getModelCapableAccountCount: vi.fn().mockReturnValue(1),
    getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(1),
    getNextToken: vi.fn().mockResolvedValue(selectedAccount),
    resolveDynamicModelForAccount: vi.fn((_accountId: string, model: string) => model),
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

function createService(accountId = 'account-a') {
  const selectedAccount = account(accountId);
  const accountLeaseService = createAccountLeaseService(selectedAccount);
  const geminiClient = {
    generateInternal: vi.fn().mockResolvedValue({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
    }),
    streamGenerateInternal: vi.fn().mockResolvedValue(new PassThrough()),
  };
  const service = new ProxyService(
    accountLeaseService as never,
    geminiClient as never,
  );
  vi.spyOn(service as any, 'waitBeforeRetry').mockResolvedValue(undefined);
  return { accountLeaseService, geminiClient, selectedAccount, service };
}

function expectNoNativeGeminiPreflightSideEffects(
  accountLeaseService: ReturnType<typeof createAccountLeaseService>,
  geminiClient: ReturnType<typeof createService>['geminiClient'],
  selectedAccount: CloudAccount,
  selectRetryToken: ReturnType<typeof vi.spyOn>,
  storeSignature: ReturnType<typeof vi.spyOn>,
) {
  expect(selectRetryToken).not.toHaveBeenCalled();
  expect(accountLeaseService.getNextToken).not.toHaveBeenCalled();
  expect(accountLeaseService.resolveDynamicModelForAccount).not.toHaveBeenCalled();
  expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
  expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
  expect(accountLeaseService.markAsRateLimited).not.toHaveBeenCalled();
  expect(selectedAccount.last_used).toBe(1);
  expect(storeSignature).not.toHaveBeenCalled();
  expect(geminiClient.generateInternal).not.toHaveBeenCalled();
  expect(geminiClient.streamGenerateInternal).not.toHaveBeenCalled();
}

const toolHistory = {
  contents: [
    {
      role: 'model',
      parts: [{ functionCall: { id: 'call-weather', name: 'weather', args: { city: 'Samara' } } }],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call-weather',
            name: 'weather',
            response: { result: 'sunny' },
          },
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        { name: 'weather', description: 'Get weather', parameters: { type: 'object' } },
      ],
    },
  ],
};

const serverToolParts = [
  {
    thoughtSignature: 'server-tool-call-signature',
    toolCall: { functionCalls: [{ args: { city: 'Samara' }, name: 'weather' }] },
  },
  {
    thought_signature: 'server-tool-response-signature',
    toolResponse: { functionResponses: [{ name: 'weather', response: { result: 'sunny' } }] },
  },
];

const nativePositiveCompatibilityCases = [
  {
    name: 'VALIDATED allowed names, omitted role, native extensions, and non-function tools',
    request: {
      cachedContent: 'cachedContents/compat-r7',
      serviceTier: 'priority',
      store: true,
      futureTopLevelExtension: { revision: 'r7' },
      contents: [
        {
          parts: [
            { text: 'Find the latest price', futurePartExtension: { source: 'client' } },
            {
              thoughtSignature: 'client-provided',
              functionCall: {
                args: { symbol: 'GOOG' },
                futureFunctionCallExtension: { partial: false },
                id: 'call-stock',
                name: 'stocks_lookup-v2',
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                futureFunctionResponseExtension: { source: 'market' },
                id: 'call-stock',
                name: 'stocks_lookup-v2',
                response: { price: 123 },
                scheduling: 'SILENT' as const,
                willContinue: false,
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          allowedFunctionNames: ['stocks_lookup-v2'],
          futureFunctionCallingConfigExtension: { enabled: true },
          mode: 'VALIDATED' as const,
        },
        futureToolConfigExtension: { enabled: true },
      },
      tools: [
        { codeExecution: {} },
        { googleSearch: {} },
        {
          functionDeclarations: [
            {
              behavior: 'NON_BLOCKING',
              futureDeclarationExtension: { version: 2 },
              name: 'stocks_lookup-v2',
              response: { type: 'object' },
            },
          ],
        },
      ],
    },
  },
  ...(['WHEN_IDLE', 'SILENT', 'INTERRUPT'] as const).map((scheduling) => ({
    name: `FunctionResponse scheduling ${scheduling}`,
    request: {
      contents: [
        {
          parts: [
            {
              functionResponse: {
                name: 'weather',
                response: {},
                scheduling,
                willContinue: true,
              },
            },
          ],
        },
      ],
    },
  })),
  ...(['AUTO', 'ANY', 'NONE', 'VALIDATED'] as const).map((mode) => ({
    name: `current function-calling mode ${mode}`,
    request: {
      contents: [{ parts: [{ text: 'hello' }] }],
      toolConfig: {
        functionCallingConfig: {
          mode,
          ...((mode === 'ANY' || mode === 'VALIDATED')
            ? { allowedFunctionNames: [] }
            : {}),
        },
      },
    },
  })),
];

const nativeMalformedCompatibilityCases = [
  {
    name: 'allowed function names outside ANY or VALIDATED',
    request: {
      contents: [{ parts: [{ text: 'hello' }] }],
      toolConfig: { functionCallingConfig: { allowedFunctionNames: ['weather'], mode: 'AUTO' } },
    },
  },
  {
    name: 'unsupported content role',
    request: { contents: [{ role: 'tool', parts: [{ text: 'hello' }] }] },
  },
  {
    name: 'non-boolean FunctionResponse willContinue',
    request: {
      contents: [
        { parts: [{ functionResponse: { name: 'weather', response: {}, willContinue: 'yes' } }] },
      ],
    },
  },
  {
    name: 'unsupported FunctionResponse scheduling',
    request: {
      contents: [
        { parts: [{ functionResponse: { name: 'weather', response: {}, scheduling: 'LATER' } }] },
      ],
    },
  },
  {
    name: 'empty contents',
    request: { contents: [] },
  },
  {
    name: 'empty content parts',
    request: { contents: [{ parts: [] }] },
  },
  {
    name: 'malformed known part structures',
    request: {
      contents: [
        {
          parts: [
            { codeExecutionResult: { outcome: 'OUTCOME_OK' }, executableCode: { code: 'print(1)', language: 'PYTHON' } },
          ],
        },
      ],
    },
  },
];

const nativeFunctionNameLocations = [
  {
    request: (name: unknown) => ({
      contents: [{ role: 'model', parts: [{ functionCall: { args: {}, name } }] }],
    }),
  },
  {
    request: (name: unknown) => ({
      contents: [{ role: 'user', parts: [{ functionResponse: { name, response: {} } }] }],
    }),
  },
  {
    request: (name: unknown) => ({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      tools: [{ functionDeclarations: [{ name }] }],
    }),
  },
  {
    request: (name: unknown) => ({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } },
    }),
  },
];

describe('native Gemini compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(nativePositiveCompatibilityCases)(
    'forwards $name unchanged to the internal upstream request',
    async ({ request }) => {
      const { geminiClient, service } = createService();

      await service.handleGeminiGenerateContent('gemini-3-flash', request as never);

      const upstreamRequest = geminiClient.generateInternal.mock.calls[0][0].request;
      const preservedRequest = { ...upstreamRequest };
      delete preservedRequest.safetySettings;
      expect(preservedRequest).toEqual(request);
      expect(upstreamRequest.contents[0]).not.toHaveProperty('role');
    },
  );

  it('preserves NONE function-calling mode on the wire', async () => {
    const { geminiClient, service } = createService();

    await service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [{ parts: [{ text: 'hello' }] }],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    } as never);

    expect(geminiClient.generateInternal.mock.calls[0][0].request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
  });

  it('preserves current data variants and opaque future data with thought metadata on both paths', async () => {
    const { geminiClient, service } = createService();
    const request = {
      contents: [
        {
          parts: [
            { text: 'hello', futureTextExtension: { revision: 8 } },
            { text: 'reasoning', thought: true, thoughtSignature: 'opaque-thought-signature' },
            { futureDataVariant: { revision: 9 }, thought: true, thoughtSignature: 'future-data-signature' },
            { inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' } },
            { fileData: { fileUri: 'https://example.com/document.pdf', mimeType: 'application/pdf' } },
            { functionCall: { args: {}, name: 'weather' } },
            {
              functionResponse: {
                name: 'weather',
                parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' } }],
                response: {},
              },
            },
            { executableCode: { code: 'print(1)', language: 'PYTHON' } },
            { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } },
          ],
        },
      ],
    };

    await service.handleGeminiGenerateContent('gemini-3-flash', request as never);
    await service.handleGeminiStreamGenerateContent('gemini-3-flash', request as never);

    expect(geminiClient.generateInternal.mock.calls[0][0].request.contents[0].parts).toEqual(
      request.contents[0].parts,
    );
    expect(geminiClient.streamGenerateInternal.mock.calls[0][0].request.contents[0].parts).toEqual(
      request.contents[0].parts,
    );
  });

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects invalid system instruction and opaque future-part boundaries through %s before side effects',
    async (handle) => {
      const invalidRequests = [
        {
          contents: [{ parts: [{ text: 'hello' }] }],
          systemInstruction: {
            parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, text: 'system' }],
          },
        },
        { contents: [{ parts: [{ thought: true }] }] },
        { contents: [{ parts: [{ futureDataVariant: {}, anotherFutureDataVariant: {} }] }] },
        { contents: [{ parts: [{ futureDataVariant: {}, thought: 'true' }] }] },
        { contents: [{ parts: [{ futureDataVariant: {}, thoughtSignature: '' }] }] },
        { contents: [{ parts: [{ thoughtSignature: 'metadata-without-data' }] }] },
      ];

      for (const request of invalidRequests) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(service[handle]('gemini-3-flash', request as never)).rejects.toMatchObject({ status: 400 });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects malformed nested FunctionResponse part metadata through %s before every side effect',
    async (handle) => {
      const malformedMetadata = [
        { thought: 'true' },
        { thoughtSignature: '' },
        { thought_signature: '' },
        { thoughtSignature: 'camel', thought_signature: 'snake' },
      ];

      for (const metadata of malformedMetadata) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(
          service[handle]('gemini-3-flash', {
            contents: [
              {
                parts: [
                  {
                    functionResponse: {
                      name: 'weather',
                      parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, ...metadata }],
                      response: {},
                    },
                  },
                ],
              },
            ],
          } as never),
        ).rejects.toMatchObject({ status: 400 });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'preserves valid nested FunctionResponse inline media metadata and extensions through %s',
    async (handle) => {
      const { geminiClient, service } = createService();
      const nestedPart = {
        futurePartExtension: { source: 'client' },
        inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' },
        thought: true,
        thoughtSignature: 'matching-signature',
        thought_signature: 'matching-signature',
      };
      const request = {
        contents: [
          {
            parts: [
              { functionResponse: { name: 'weather', parts: [nestedPart], response: { result: 'sunny' } } },
            ],
          },
        ],
      };

      await service[handle]('gemini-3-flash', request as never);

      const upstreamCall = handle === 'handleGeminiGenerateContent'
        ? geminiClient.generateInternal.mock.calls[0][0]
        : geminiClient.streamGenerateInternal.mock.calls[0][0];
      expect(upstreamCall.request.contents[0].parts[0].functionResponse.parts[0]).toEqual(nestedPart);
    },
  );

  it.each(nativeMalformedCompatibilityCases)(
    'rejects $name before direct-path routing side effects',
    async ({ request }) => {
      const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
      const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
      const storeSignature = vi.spyOn(SignatureStore, 'store');

      await expect(service.handleGeminiGenerateContent('gemini-3-flash', request as never)).rejects.toMatchObject({
        status: 400,
      });
      expectNoNativeGeminiPreflightSideEffects(
        accountLeaseService,
        geminiClient,
        selectedAccount,
        selectRetryToken,
        storeSignature,
      );
    },
  );

  it('forwards tools and a snake-case tool config alias identically for non-streaming and streaming', async () => {
    const { geminiClient, service } = createService();
    const request = {
      ...toolHistory,
      tool_config: {
        functionCallingConfig: { mode: 'ANY' as const, allowedFunctionNames: ['weather'] },
      },
    };

    await service.handleGeminiGenerateContent('gemini-3-flash', request);
    await service.handleGeminiStreamGenerateContent('gemini-3-flash', request);

    const [nonStreamingBody] = geminiClient.generateInternal.mock.calls[0];
    const [streamingBody] = geminiClient.streamGenerateInternal.mock.calls[0];
    expect(nonStreamingBody.request).toMatchObject({
      tools: request.tools,
      toolConfig: request.tool_config,
    });
    expect(nonStreamingBody.request).not.toHaveProperty('tool_config');
    expect(streamingBody.request).toEqual(nonStreamingBody.request);
  });

  it('accepts matching tool config spellings and rejects contradictory duplicates', async () => {
    const { geminiClient, service } = createService();
    const toolConfig = { functionCallingConfig: { mode: 'AUTO' as const } };

    await service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      toolConfig,
      tool_config: { functionCallingConfig: { mode: 'AUTO' as const } },
    });
    expect(geminiClient.generateInternal.mock.calls[0][0].request.toolConfig).toEqual(toolConfig);

    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        toolConfig,
        tool_config: { functionCallingConfig: { mode: 'NONE' as const } },
      }),
    ).rejects.toThrow('toolConfig and tool_config must not contradict each other');
  });

  it('preserves per-field Gemini name boundaries and non-function tool variants', async () => {
    const { geminiClient, service } = createService();
    const callResponseName = `a${'b'.repeat(127)}`;
    const declarationName = `tool.name:${'b'.repeat(118)}`;
    const request = {
      contents: [
        { role: 'model', parts: [{ functionCall: { args: {}, name: callResponseName } }] },
        { role: 'user', parts: [{ functionResponse: { name: callResponseName, response: {} } }] },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY' as const, allowedFunctionNames: [declarationName] } },
      tools: [
        { functionDeclarations: [{ name: declarationName }] },
        { googleSearch: {} },
      ],
    };

    await service.handleGeminiGenerateContent('gemini-3-flash', request);

    expect(geminiClient.generateInternal.mock.calls[0][0].request).toMatchObject({
      toolConfig: request.toolConfig,
      tools: request.tools,
    });
  });

  it('replays only an exact account/model signature and otherwise injects the flash placeholder', async () => {
    SignatureStore.clear();
    SignatureStore.store(
      { accountId: 'account-a', model: 'gemini-3-flash', toolCallId: 'call-weather' },
      'stored-signature',
    );
    const matching = createService('account-a');
    const otherAccount = createService('account-b');
    const otherModel = createService('account-a');

    await matching.service.handleGeminiGenerateContent('gemini-3-flash', toolHistory);
    await otherAccount.service.handleGeminiGenerateContent('gemini-3-flash', toolHistory);
    await otherModel.service.handleGeminiGenerateContent('gemini-3.5-flash-high', toolHistory);

    const matchingPart = matching.geminiClient.generateInternal.mock.calls[0][0].request.contents[0]
      .parts[0];
    const isolatedPart = otherAccount.geminiClient.generateInternal.mock.calls[0][0].request.contents[0]
      .parts[0];
    const modelIsolatedPart = otherModel.geminiClient.generateInternal.mock.calls[0][0].request.contents[0]
      .parts[0];
    expect(matchingPart).toMatchObject({
      thoughtSignature: 'stored-signature',
      thought_signature: 'stored-signature',
    });
    expect(isolatedPart).toMatchObject({
      thoughtSignature: 'skip_thought_signature_validator',
      thought_signature: 'skip_thought_signature_validator',
    });
    expect(modelIsolatedPart).toMatchObject({
      thoughtSignature: 'skip_thought_signature_validator',
      thought_signature: 'skip_thought_signature_validator',
    });
    SignatureStore.clear();
  });

  it('injects the flash placeholder for an id-less model tool call without a store lookup key', async () => {
    const { geminiClient, service } = createService();

    await service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'weather', args: { city: 'Samara' } } }],
        },
      ],
    });

    expect(geminiClient.generateInternal.mock.calls[0][0].request.contents[0].parts[0]).toMatchObject({
      thoughtSignature: 'skip_thought_signature_validator',
      thought_signature: 'skip_thought_signature_validator',
    });
  });

  it('preserves supplied signature spellings and rejects malformed signature aliases', async () => {
    const { geminiClient, service } = createService();
    const request = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'call-weather', name: 'weather', args: {} },
              thoughtSignature: 'client-supplied',
            },
            {
              functionCall: { id: 'call-time', name: 'time', args: {} },
              thought_signature: 'client-supplied-snake',
            },
          ],
        },
      ],
    };

    await service.handleGeminiGenerateContent('gemini-3-flash', request);
    expect(geminiClient.generateInternal.mock.calls[0][0].request.contents[0].parts[0]).toMatchObject({
      thoughtSignature: 'client-supplied',
    });
    expect(geminiClient.generateInternal.mock.calls[0][0].request.contents[0].parts[0]).not.toHaveProperty(
      'thought_signature',
    );
    expect(geminiClient.generateInternal.mock.calls[0][0].request.contents[0].parts[1]).toMatchObject({
      thought_signature: 'client-supplied-snake',
    });
    expect(geminiClient.generateInternal.mock.calls[0][0].request.contents[0].parts[1]).not.toHaveProperty(
      'thoughtSignature',
    );

    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call-weather', name: 'weather', args: {} },
                thoughtSignature: 'camel',
                thought_signature: 'snake',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('thoughtSignature and thought_signature must match');
  });

  it.each(['toolConfig', 'tool_config'] as const)(
    'strictly validates malformed %s at both native request boundaries',
    async (fieldName) => {
      const invalidConfigs = [
        null,
        [],
        {},
        { functionCallingConfig: {} },
        { functionCallingConfig: { mode: 'INVALID' } },
        { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather', ''] } },
        { functionCallingConfig: { mode: 'AUTO', allowedFunctionNames: ['weather'] } },
        { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: 'weather' } },
      ];

      for (const handle of ['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const) {
        for (const invalidConfig of invalidConfigs) {
          const { geminiClient, service } = createService();
          await expect(
            service[handle]('gemini-3-flash', {
              contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
              [fieldName]: invalidConfig,
            } as never),
          ).rejects.toMatchObject({ status: 400 });
          expect(geminiClient.generateInternal).not.toHaveBeenCalled();
          expect(geminiClient.streamGenerateInternal).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'returns an indexed Gemini 400 for malformed functionCall.args through %s before account selection',
    async (handle) => {
      const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
      const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
      const storeSignature = vi.spyOn(SignatureStore, 'store');

      await expect(
        service[handle]('gemini-3-flash', {
          contents: [
            {
              role: 'model',
              parts: [{ functionCall: { args: [], id: 'call-weather', name: 'weather' } }],
            },
          ],
        } as never),
      ).rejects.toMatchObject({
        message: 'contents[0].parts[0].functionCall.args must be a plain JSON object',
        status: 400,
      });
      expectNoNativeGeminiPreflightSideEffects(
        accountLeaseService,
        geminiClient,
        selectedAccount,
        selectRetryToken,
        storeSignature,
      );
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects every malformed known part structure through %s before every side effect',
    async (handle) => {
      const malformedParts = [
        null,
        [],
        {},
        { thought: true },
        { text: '' },
        { text: [] },
        { text: 'hello', inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' } },
        { text: 'hello', futureDataVariant: { revision: 11 } },
        { anotherFutureDataVariant: { revision: 11 }, futureDataVariant: { revision: 11 } },
        { inlineData: [] },
        { inlineData: { data: 'aGVsbG8=', mimeType: '' } },
        { fileData: [] },
        { fileData: { fileUri: '' } },
        { functionCall: [] },
        { functionResponse: [] },
        { functionResponse: { name: 'weather', parts: [], response: {} } },
        { functionResponse: { name: 'weather', parts: [{ text: 'not-media' }], response: {} } },
        {
          functionResponse: {
            name: 'weather',
            parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, text: 'not-media' }],
            response: {},
          },
        },
        {
          functionResponse: {
            name: 'weather',
            parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, futureDataVariant: {} }],
            response: {},
          },
        },
        {
          functionResponse: {
            name: 'weather',
            parts: [{ futureDataVariant: {} }],
            response: {},
          },
        },
        { executableCode: [] },
        { executableCode: { code: '', language: 'PYTHON' } },
        { executableCode: { code: 'print(1)', language: 'JAVASCRIPT' } },
        { codeExecutionResult: [] },
        { codeExecutionResult: { outcome: 'OUTCOME_UNSPECIFIED' } },
        { codeExecutionResult: { outcome: 'OUTCOME_OK', output: [] } },
        { thought: [] },
        { thoughtSignature: '' },
      ];

      for (const part of malformedParts) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(
          service[handle]('gemini-3-flash', {
            contents: [{ parts: [part] }],
          } as never),
        ).rejects.toMatchObject({ status: 400 });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects unsupported function-calling modes through %s before account selection',
    async (handle) => {
      const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
      const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
      const storeSignature = vi.spyOn(SignatureStore, 'store');

      await expect(
        service[handle]('gemini-3-flash', {
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
          toolConfig: { functionCallingConfig: { mode: 'OFF' } },
        } as never),
      ).rejects.toMatchObject({ status: 400 });

      expectNoNativeGeminiPreflightSideEffects(
        accountLeaseService,
        geminiClient,
        selectedAccount,
        selectRetryToken,
        storeSignature,
      );
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects invalid constrained names in every native Gemini location through %s before side effects',
    async (handle) => {
      const invalidNames = [
        undefined,
        null,
        '',
        ' ',
        'bad name',
        'bad\tname',
        'bad\nname',
        'bad/name',
        'a'.repeat(129),
      ];

      for (const { request } of nativeFunctionNameLocations) {
        for (const name of invalidNames) {
          const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
          const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
          const storeSignature = vi.spyOn(SignatureStore, 'store');

          await expect(service[handle]('gemini-3-flash', request(name) as never)).rejects.toMatchObject({
            status: 400,
          });
          expectNoNativeGeminiPreflightSideEffects(
            accountLeaseService,
            geminiClient,
            selectedAccount,
            selectRetryToken,
            storeSignature,
          );
        }
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects dots and colons in FunctionCall and FunctionResponse names through %s',
    async (handle) => {
      const requests = [
        { contents: [{ parts: [{ functionCall: { args: {}, name: 'tool.name' } }] }] },
        { contents: [{ parts: [{ functionResponse: { name: 'tool:name', response: {} } }] }] },
      ];

      for (const request of requests) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(service[handle]('gemini-3-flash', request as never)).rejects.toMatchObject({ status: 400 });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects malformed tool containers through %s before side effects',
    async (handle) => {
      const invalidTools = [null, {}, [null], [[]], [{ functionDeclarations: null }], [{ functionDeclarations: [null] }]];

      for (const tools of invalidTools) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(
          service[handle]('gemini-3-flash', {
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            tools,
          } as never),
        ).rejects.toMatchObject({ status: 400 });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects non-object functionCall values through %s before every service side effect',
    async (handle) => {
      const invalidValues = [null, [], 'weather', 1, false];

      for (const value of invalidValues) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(
          service[handle]('gemini-3-flash', {
            contents: [{ role: 'model', parts: [{ functionCall: value }] }],
          } as never),
        ).rejects.toMatchObject({
          message: 'contents[0].parts[0].functionCall must be an object',
          status: 400,
        });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it.each(['handleGeminiGenerateContent', 'handleGeminiStreamGenerateContent'] as const)(
    'rejects structurally malformed functionResponse and server tool parts through %s',
    async (handle) => {
      const invalidParts = [
        { functionResponse: null },
        { functionResponse: { name: 'weather', response: [] } },
        { functionResponse: { response: {} } },
        { functionResponse: { id: '', name: 'weather', response: {} } },
        { toolCall: [] },
        { toolResponse: 'not-an-object' },
      ];

      for (const part of invalidParts) {
        const { accountLeaseService, geminiClient, selectedAccount, service } = createService();
        const selectRetryToken = vi.spyOn(service as any, 'selectRetryToken');
        const storeSignature = vi.spyOn(SignatureStore, 'store');

        await expect(
          service[handle]('gemini-3-flash', {
            contents: [{ role: 'user', parts: [part] }],
          } as never),
        ).rejects.toMatchObject({ status: 400 });
        expectNoNativeGeminiPreflightSideEffects(
          accountLeaseService,
          geminiClient,
          selectedAccount,
          selectRetryToken,
          storeSignature,
        );
      }
    },
  );

  it('preserves server tool-combination parts in direct responses and stream fallback aggregation', async () => {
    const direct = createService();
    direct.geminiClient.generateInternal.mockResolvedValueOnce({
      candidates: [{ content: { parts: serverToolParts, role: 'model' } }],
    });

    const directResponse = await direct.service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    expect(directResponse.candidates?.[0]?.content?.parts).toEqual(serverToolParts);

    const fallback = createService();
    const upstream = new PassThrough();
    fallback.geminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    fallback.geminiClient.streamGenerateInternal.mockResolvedValueOnce(upstream);
    const response = fallback.service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    upstream.end(
      `data: ${JSON.stringify({
        response: { candidates: [{ content: { parts: serverToolParts, role: 'model' } }] },
      })}\n\n`,
    );

    const fallbackResponse = await response;
    expect(fallbackResponse.candidates?.[0]?.content?.parts).toEqual(serverToolParts);
  });
});
