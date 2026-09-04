import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAllDynamicModels,
  getOpenAICompatibleModels,
  isNonChatCatalogModelId,
  isImageCatalogModelId,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';
import {
  transformClaudeRequestIn,
  resolveSafetySettings,
  MODEL_FAMILY_SAFETY_OVERRIDES,
} from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { GeminiController } from '@/modules/proxy-gateway/server/gemini.controller';
import { ProxyModelRoutingPolicy } from '@/modules/proxy-gateway/server/proxy-model-routing-policy';
import { AccountLeaseModelPolicy } from '@/modules/proxy-gateway/server/account-lease-model-policy';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/proxy-model-availability-store';
import type { OpenAIChatRequest } from '@/modules/proxy-gateway/server/interfaces/request-interfaces';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/account-lease-token-types';

function createReplyMock() {
  const reply: any = {
    statusCode: 200,
    status: vi.fn().mockImplementation((code: number) => {
      reply.statusCode = code;
      return reply;
    }),
    send: vi.fn().mockImplementation((body: any) => {
      reply.sentBody = body;
      return reply;
    }),
    header: vi.fn().mockReturnThis(),
  };
  return reply;
}

const ALL_FIVE_SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
];

const FOUR_CATEGORIES_WITHOUT_CIVIC = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

const MODEL_POLICY_TEST_ACCOUNT_IDS = [
  'catalog-only-account',
  'catalog-capable-account',
  'catalog-cooldown-account',
  'catalog-display-account',
  'sibling-account',
];

function modelToken(accountId: string, modelQuotas: Record<string, number>): AccountLeaseTokenData {
  return {
    account_id: accountId,
    email: `${accountId}@test.dev`,
    access_token: `access-${accountId}`,
    refresh_token: `refresh-${accountId}`,
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    model_quotas: modelQuotas,
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
  };
}

function createModelPolicy(
  tokenCache: Map<string, AccountLeaseTokenData>,
): AccountLeaseModelPolicy {
  return new AccountLeaseModelPolicy({
    getTokenCache: () => tokenCache,
    logger: { log: vi.fn(), warn: vi.fn() } as any,
  });
}

afterEach(() => {
  for (const accountId of MODEL_POLICY_TEST_ACCOUNT_IDS) {
    proxyModelAvailabilityStore.clearAccount(accountId);
  }
});

describe('Model-Family Safety Settings Resolution (acdc530f)', () => {
  it.each([
    ['gemini-2.5-flash', FOUR_CATEGORIES_WITHOUT_CIVIC],
    ['gemini-2.5-flash-lite', FOUR_CATEGORIES_WITHOUT_CIVIC],
    ['gemini-2.5-flash-thinking', FOUR_CATEGORIES_WITHOUT_CIVIC],
    ['gemini-3.1-flash-lite', FOUR_CATEGORIES_WITHOUT_CIVIC],
    ['gpt-oss-120b-medium', []],
    ['gemini-3-flash', ALL_FIVE_SAFETY_CATEGORIES],
    ['gemini-3.5-flash-high', ALL_FIVE_SAFETY_CATEGORIES],
    ['gemini-2.0-flash', ALL_FIVE_SAFETY_CATEGORIES],
  ])('resolves safety settings correctly for %s', (model, expectedCategories) => {
    const settings = resolveSafetySettings(model);
    const actualCategories = settings.map((s) => s.category);
    expect(actualCategories).toEqual(expectedCategories);
  });

  it('omits safetySettings property entirely in transformClaudeRequestIn for gpt-oss-120b-medium', () => {
    const result = transformClaudeRequestIn({
      model: 'gpt-oss-120b-medium',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.request.safetySettings).toBeUndefined();
    expect('safetySettings' in result.request).toBe(false);
  });

  it('omits CIVIC_INTEGRITY in transformClaudeRequestIn for gemini-2.5-flash and gemini-3.1-flash-lite', () => {
    const flash25 = transformClaudeRequestIn({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(flash25.request.safetySettings?.map((s) => s.category)).toEqual(
      FOUR_CATEGORIES_WITHOUT_CIVIC,
    );
    expect(
      flash25.request.safetySettings?.some((s) => s.category === 'HARM_CATEGORY_CIVIC_INTEGRITY'),
    ).toBe(false);

    const flashLite31 = transformClaudeRequestIn({
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(flashLite31.request.safetySettings?.map((s) => s.category)).toEqual(
      FOUR_CATEGORIES_WITHOUT_CIVIC,
    );
    expect(
      flashLite31.request.safetySettings?.some((s) => s.category === 'HARM_CATEGORY_CIVIC_INTEGRITY'),
    ).toBe(false);
  });

  it('preserves all 5 categories for standard Gemini models in transformClaudeRequestIn', () => {
    const standard = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(standard.request.safetySettings?.map((s) => s.category)).toEqual(
      ALL_FIVE_SAFETY_CATEGORIES,
    );
  });

  it('exposes MODEL_FAMILY_SAFETY_OVERRIDES matching upstream acdc530f definitions', () => {
    expect(MODEL_FAMILY_SAFETY_OVERRIDES).toHaveLength(3);
    expect(MODEL_FAMILY_SAFETY_OVERRIDES[0].omittedSafetyCategories).toEqual([
      'HARM_CATEGORY_CIVIC_INTEGRITY',
    ]);
    expect(MODEL_FAMILY_SAFETY_OVERRIDES[1].omittedSafetyCategories).toEqual([
      'HARM_CATEGORY_CIVIC_INTEGRITY',
    ]);
    expect(MODEL_FAMILY_SAFETY_OVERRIDES[2].omittedSafetyCategories).toHaveLength(5);
  });
});

describe('Truthful Model Catalog (/v1/models and /v1beta/models)', () => {
  it('correctly identifies non-chat catalog models', () => {
    expect(isNonChatCatalogModelId('chat_20706')).toBe(true);
    expect(isNonChatCatalogModelId('chat_23310')).toBe(true);
    expect(isNonChatCatalogModelId('tab_flash_lite_preview')).toBe(true);
    expect(isNonChatCatalogModelId('tab_jump_flash_lite_preview')).toBe(true);
    expect(isNonChatCatalogModelId('internal-background-task')).toBe(true);
    expect(isNonChatCatalogModelId('gemini-3-flash')).toBe(false);
  });

  it('correctly identifies image-only catalog models', () => {
    expect(isImageCatalogModelId('gemini-3.1-flash-image')).toBe(true);
    expect(isImageCatalogModelId('gemini-3-pro-image')).toBe(true);
    expect(isImageCatalogModelId('gemini-3-flash')).toBe(false);
  });
  it('returns an empty catalog when snapshots are empty (zero loaded snapshots)', () => {
    const openAIModels = getOpenAICompatibleModels({}, []);
    expect(openAIModels).toEqual([]);

    const geminiModels = getAllDynamicModels({}, []);
    expect(geminiModels).toEqual([]);
  });

  it('OpenAI catalog (/v1/models) lists only provider-derived chat models and hides image-only models', () => {
    const discovered = [
      'gemini-3-flash',
      'gemini-3.5-flash-high',
      'gemini-3.8-flash-tiered',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'chat_20706',
      'chat_23310',
      'tab_flash_lite_preview',
      'tab_jump_flash_lite_preview',
      'claude-sonnet-4-6-thinking',
      'gpt-oss-120b-medium',
    ];

    const openAIModels = getOpenAICompatibleModels({}, discovered);
    // Discovered chat models are present
    expect(openAIModels).toContain('gemini-3-flash');
    expect(openAIModels).toContain('gemini-3.5-flash-high');
    expect(openAIModels).toContain('gemini-3.8-flash-tiered');
    expect(openAIModels).toContain('claude-sonnet-4-6-thinking');
    expect(openAIModels).toContain('gpt-oss-120b-medium');

    // Image-only models are hidden from OpenAI catalog
    expect(openAIModels).not.toContain('gemini-3.1-flash-image');
    expect(openAIModels).not.toContain('gemini-3-pro-image');

    // Non-chat service IDs are hidden
    expect(openAIModels).not.toContain('chat_20706');
    expect(openAIModels).not.toContain('chat_23310');
    expect(openAIModels).not.toContain('tab_flash_lite_preview');
    expect(openAIModels).not.toContain('tab_jump_flash_lite_preview');

    // Static legacy compatibility aliases are absent
    expect(openAIModels).not.toContain('gpt-4');
    expect(openAIModels).not.toContain('gpt-4o');
    expect(openAIModels).not.toContain('gpt-3.5-turbo');
    expect(openAIModels).not.toContain('claude-sonnet-4-6');
    expect(openAIModels).not.toContain('claude-3-5-sonnet-20241022');
    expect(openAIModels).not.toContain('gemini-3-pro-high');
    expect(openAIModels).not.toContain('gemini-3-pro-low');
    expect(openAIModels).not.toContain('gemini-3-pro-preview');
  });

  it('Gemini catalog (/v1beta/models) exposes valid image capabilities and hides non-chat service IDs', () => {
    const discovered = [
      'gemini-3-flash',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'chat_20706',
      'tab_flash_lite_preview',
    ];

    const geminiModels = getAllDynamicModels({}, discovered);
    expect(geminiModels).toContain('gemini-3-flash');
    expect(geminiModels).toContain('gemini-3.1-flash-image');
    expect(geminiModels).toContain('gemini-3-pro-image');
    expect(geminiModels).not.toContain('chat_20706');
    expect(geminiModels).not.toContain('tab_flash_lite_preview');

    // Does not add phantom permutations
    expect(geminiModels.some((m) => m.includes('-2k-'))).toBe(false);
    expect(geminiModels.some((m) => m.includes('-4k-'))).toBe(false);
    expect(geminiModels.some((m) => m.includes('-16x9'))).toBe(false);
  });

  it('ProxyController GET /v1/models returns truthful list from AccountLeaseService', async () => {
    const mockProxyService: any = {};
    const mockAccountLeaseService: any = {
      refreshQuotaCatalog: vi.fn().mockResolvedValue(undefined),
      getAllCollectedModels: vi.fn().mockReturnValue(
        new Set([
          'gemini-3-flash',
          'gemini-3.5-flash-high',
          'gemini-3.1-flash-image',
          'chat_20706',
        ]),
      ),
    };

    const controller = new ProxyController(mockProxyService, mockAccountLeaseService);
    const reply = createReplyMock();

    await controller.listModels(reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    const modelIds = reply.sentBody.data.map((item: any) => item.id);
    expect(modelIds).toEqual(['gemini-3-flash', 'gemini-3.5-flash-high']);
    expect(modelIds).not.toContain('gemini-3.1-flash-image');
    expect(modelIds).not.toContain('chat_20706');
    expect(modelIds).not.toContain('gpt-4o');
    expect(modelIds).not.toContain('claude-sonnet-4-6');
  });

  it('ProxyController GET /v1/models returns empty list when no snapshots are loaded', async () => {
    const mockProxyService: any = {};
    const mockAccountLeaseService: any = {
      refreshQuotaCatalog: vi.fn().mockResolvedValue(undefined),
      getAllCollectedModels: vi.fn().mockReturnValue(new Set()),
    };

    const controller = new ProxyController(mockProxyService, mockAccountLeaseService);
    const reply = createReplyMock();

    await controller.listModels(reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.sentBody).toEqual({ object: 'list', data: [] });
  });

  it('GeminiController GET /v1beta/models returns models with image capabilities', async () => {
    const mockProxyService: any = {};
    const mockAccountLeaseService: any = {
      refreshQuotaCatalog: vi.fn().mockResolvedValue(undefined),
      getAllCollectedModels: vi.fn().mockReturnValue(
        new Set([
          'gemini-3-flash',
          'gemini-3.1-flash-image',
          'chat_20706',
        ]),
      ),
    };

    const controller = new GeminiController(mockProxyService, mockAccountLeaseService);
    const reply = createReplyMock();

    await controller.listModels(reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    const names = reply.sentBody.models.map((item: any) => item.name);
    expect(names).toEqual(['models/gemini-3-flash', 'models/gemini-3.1-flash-image']);
    expect(names).not.toContain('models/chat_20706');
  });

  it('GeminiController GET /v1beta/models returns empty array when no snapshots exist', async () => {
    const mockProxyService: any = {};
    const mockAccountLeaseService: any = {
      refreshQuotaCatalog: vi.fn().mockResolvedValue(undefined),
      getAllCollectedModels: vi.fn().mockReturnValue(new Set()),
    };

    const controller = new GeminiController(mockProxyService, mockAccountLeaseService);
    const reply = createReplyMock();

    await controller.listModels(reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.sentBody).toEqual({ models: [] });
  });
});

describe('Request compatibility for legacy aliases', () => {
  it('ProxyModelRoutingPolicy routes legacy GPT/Claude aliases to concrete targets', () => {
    const policy = new ProxyModelRoutingPolicy();

    expect(policy.resolveTargetModel('gpt-4')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('gpt-4o')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('gpt-3.5-turbo')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6-thinking');
    expect(policy.resolveTargetModel('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-6-thinking');
    expect(policy.resolveTargetModel('claude-opus-4')).toBe('claude-opus-4-6-thinking');
  });

  it('AccountLeaseModelPolicy routes gemini-3.8-flash-low to gemini-3.8-flash-tiered', () => {
    const tokenCache = new Map<string, AccountLeaseTokenData>([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          model_quotas: { 'gemini-3.8-flash-tiered': 99 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const policy = new AccountLeaseModelPolicy({
      getTokenCache: () => tokenCache,
      logger: { log: vi.fn(), warn: vi.fn() } as any,
    });

    const resolved = policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.8-flash-low');
    expect(resolved).toBe('gemini-3.8-flash-tiered');
  });

  it('removes a runtime-rejected model from catalogs while preserving sibling rerouting', () => {
    const tokenCache = new Map<string, AccountLeaseTokenData>([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          model_quotas: {
            'gemini-3.8-flash-high': 99,
            'gemini-3.8-flash-low': 99,
          },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);
    const policy = new AccountLeaseModelPolicy({
      getTokenCache: () => tokenCache,
      logger: { log: vi.fn(), warn: vi.fn() } as any,
    });

    policy.markModelUnrequestable('gemini-3.8-flash-high');

    expect(policy.getAllCollectedModels()).not.toContain('gemini-3.8-flash-high');
    expect(policy.getAllCollectedModels()).toContain('gemini-3.8-flash-low');
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.8-flash-high')).toBe(
      'gemini-3.8-flash-low',
    );
  });

  it('never rewrites an unrequestable sibling to an account model in cooldown', () => {
    const policy = createModelPolicy(
      new Map([
        [
          'sibling-account',
          modelToken('sibling-account', {
            'gemini-3.8-flash-high': 99,
            'gemini-3.8-flash-low': 99,
          }),
        ],
      ]),
    );

    policy.markModelUnrequestable('gemini-3.8-flash-high');
    proxyModelAvailabilityStore.mark(
      'sibling-account',
      'gemini-3.8-flash-low',
      'quota_exhausted',
    );

    expect(policy.resolveDynamicModelForAccount('sibling-account', 'gemini-3.8-flash-high')).toBe(
      'gemini-3.8-flash-high',
    );
  });

  it('publishes the union of capability-eligible account models without cooldown erasure', () => {
    const policy = createModelPolicy(
      new Map([
        [
          'catalog-only-account',
          modelToken('catalog-only-account', { 'gemini-3.1-pro-image': 99 }),
        ],
        [
          'catalog-capable-account',
          modelToken('catalog-capable-account', { 'gemini-3.1-pro-image': 99 }),
        ],
        [
          'catalog-cooldown-account',
          modelToken('catalog-cooldown-account', { 'gemini-3.5-flash-high': 99 }),
        ],
      ]),
    );

    proxyModelAvailabilityStore.mark(
      'catalog-only-account',
      'gemini-3.1-pro-image',
      'model_not_supported',
    );
    proxyModelAvailabilityStore.mark(
      'catalog-cooldown-account',
      'gemini-3.5-flash-high',
      'quota_exhausted',
    );

    const models = policy.getAllCollectedModels();
    expect(models).toContain('gemini-3.1-pro-image');
    expect(models).toContain('gemini-3.5-flash-high');

    proxyModelAvailabilityStore.mark(
      'catalog-capable-account',
      'gemini-3.1-pro-image',
      'model_forbidden',
    );
    expect(policy.getAllCollectedModels()).not.toContain('gemini-3.1-pro-image');
  });

  it('uses raw provider capability state for display-mapped catalog entries', () => {
    const token = modelToken('catalog-display-account', {});
    token.quota = {
      models: {
        'provider-gemini-3.1-pro-high': {
          display_name: 'Gemini 3.1 Pro (High)',
        },
      },
    } as any;
    const policy = createModelPolicy(new Map([['catalog-display-account', token]]));

    expect(policy.getAllCollectedModels()).toEqual(new Set(['gemini-3.1-pro-high']));

    proxyModelAvailabilityStore.mark(
      'catalog-display-account',
      'provider-gemini-3.1-pro-high',
      'model_not_supported',
    );
    expect(policy.getAllCollectedModels()).toEqual(new Set());
  });

  it('ProxyController accepts chat completion requests with legacy aliases', async () => {
    const mockProxyService: any = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hello back' },
            finish_reason: 'stop',
          },
        ],
      }),
    };

    const controller = new ProxyController(mockProxyService);
    const reply = createReplyMock();

    const request: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    };

    await controller.chatCompletions(request, reply);

    expect(mockProxyService.handleChatCompletions).toHaveBeenCalledWith(request);
    expect(reply.sentBody.model).toBe('gpt-4o');
  });
});
