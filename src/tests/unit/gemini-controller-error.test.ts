import { describe, expect, it, vi } from 'vitest';
import { GeminiController } from '@/modules/proxy-gateway/server/gemini.controller';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';

function createReply() {
  const reply: any = {
    send: vi.fn(),
    status: vi.fn(),
    header: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply;
}

function createAccountLeaseService(models: string[] = ['gemini-3-flash']) {
  return {
    refreshQuotaCatalog: vi.fn().mockResolvedValue(undefined),
    getAllCollectedModels: vi.fn().mockReturnValue(new Set(models)),
  };
}

const validNativeBody = { contents: [{ parts: [{ text: 'hello' }], role: 'user' }] };
const malformedNativeBodies = [
  { contents: [] },
  { contents: [{ parts: [] }] },
  { contents: [{ parts: [{ text: '' }] }] },
  { contents: [{ parts: [{ inlineData: [] }] }] },
  { contents: [{ parts: [{ fileData: { fileUri: '' } }] }] },
  { contents: [{ parts: [{ functionCall: null }] }] },
  { contents: [{ parts: [{ functionResponse: [] }] }] },
  { contents: [{ parts: [{ executableCode: { code: '', language: 'PYTHON' } }] }] },
  { contents: [{ parts: [{ codeExecutionResult: { outcome: 'OUTCOME_UNSPECIFIED' } }] }] },
  {
    contents: [{ parts: [{ text: 'hello' }] }],
    systemInstruction: {
      parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, text: 'system' }],
    },
  },
  { contents: [{ parts: [{ futureDataVariant: {}, anotherFutureDataVariant: {} }] }] },
  { contents: [{ parts: [{ text: 'hello', futureDataVariant: {} }] }] },
  {
    contents: [
      {
        parts: [{
          functionResponse: {
            name: 'weather',
            parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, futureDataVariant: {} }],
            response: {},
          },
        }],
      },
    ],
  },
  {
    contents: [
      {
        parts: [{
          functionResponse: {
            name: 'weather',
            parts: [{ futureDataVariant: {} }],
            response: {},
          },
        }],
      },
    ],
  },
  ...[
    { thought: 'true' },
    { thoughtSignature: '' },
    { thought_signature: '' },
    { thoughtSignature: 'camel', thought_signature: 'snake' },
  ].map((metadata) => ({
    contents: [
      {
        parts: [{
          functionResponse: {
            name: 'weather',
            parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' }, ...metadata }],
            response: {},
          },
        }],
      },
    ],
  })),
  { contents: [{ parts: [{ futureDataVariant: {}, thought: 'true' }] }] },
];

describe('GeminiController upstream errors', () => {
  it.each([
    ['INVALID_ARGUMENT', 400],
    ['PERMISSION_DENIED', 403],
    ['RESOURCE_EXHAUSTED', 429],
    ['UNAVAILABLE', 503],
  ])('uses the upstream HTTP status without exposing upstream diagnostics: %s', async (status, code) => {
    const proxyService = {
      handlePreflightedGeminiGenerateContent: vi.fn().mockRejectedValue(
        new UpstreamRequestError({
          status: code,
        }),
      ),
    };
    const controller = new GeminiController(proxyService as never, createAccountLeaseService() as never);
    const reply = createReply();

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      validNativeBody,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(code);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ status }) }),
    );
  });

  it.each(['generateContent', 'streamGenerateContent'])(
    'rejects every malformed native request before quota refresh or %s service dispatch',
    async (action) => {
      for (const body of malformedNativeBodies) {
        const proxyService = {
          handlePreflightedGeminiGenerateContent: vi.fn(),
          handlePreflightedGeminiStreamGenerateContent: vi.fn(),
        };
        const accountLeaseService = createAccountLeaseService();
        const controller = new GeminiController(proxyService as never, accountLeaseService as never);
        const reply = createReply();

        await controller.modelAction(
          `gemini-3-flash:${action}`,
          body as never,
          reply as never,
        );

        expect(reply.status).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({
              code: 400,
              status: 'INVALID_ARGUMENT',
            }),
          }),
        );
        expect(accountLeaseService.refreshQuotaCatalog).not.toHaveBeenCalled();
        expect(proxyService.handlePreflightedGeminiGenerateContent).not.toHaveBeenCalled();
        expect(proxyService.handlePreflightedGeminiStreamGenerateContent).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [
      'function call',
      { contents: [{ parts: [{ functionCall: { args: {}, name: 'bad name' } }], role: 'model' }] },
    ],
    [
      'function response',
      { contents: [{ parts: [{ functionResponse: { name: 'bad name', response: {} } }], role: 'user' }] },
    ],
    [
      'function declaration',
      {
        contents: validNativeBody.contents,
        tools: [{ functionDeclarations: [{ name: 'bad name' }] }],
      },
    ],
    [
      'allowed function name',
      {
        contents: validNativeBody.contents,
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['bad name'] } },
      },
    ],
  ])('rejects an invalid %s before quota refresh or service dispatch', async (_location, body) => {
    const proxyService = {
      handlePreflightedGeminiGenerateContent: vi.fn(),
      handlePreflightedGeminiStreamGenerateContent: vi.fn(),
    };
    const accountLeaseService = createAccountLeaseService();
    const controller = new GeminiController(proxyService as never, accountLeaseService as never);
    const reply = createReply();

    await controller.modelAction('gemini-3-flash:generateContent', body as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ status: 'INVALID_ARGUMENT' }) }),
    );
    expect(accountLeaseService.refreshQuotaCatalog).not.toHaveBeenCalled();
    expect(proxyService.handlePreflightedGeminiGenerateContent).not.toHaveBeenCalled();
    expect(proxyService.handlePreflightedGeminiStreamGenerateContent).not.toHaveBeenCalled();
  });

  it('returns an advertised Gemini model metadata object unchanged from the list response', async () => {
    const accountLeaseService = createAccountLeaseService();
    const controller = new GeminiController({} as never, accountLeaseService as never);
    const listReply = createReply();
    const getReply = createReply();

    await controller.listModels(listReply as never);
    await controller.getModel('gemini-3-flash', getReply as never);

    expect(getReply.send).toHaveBeenCalledWith(listReply.send.mock.calls[0][0].models[0]);
    expect(listReply.send.mock.calls[0][0].models[0]).toMatchObject({
      name: 'models/gemini-3-flash',
      baseModelId: 'gemini-3-flash',
      version: 'gemini-3-flash',
    });
    expect(listReply.send.mock.calls[0][0].models[0]).not.toHaveProperty('inputTokenLimit');
  });

  it.each(['generateContent', 'streamGenerateContent'])(
    'rejects an unadvertised native model before %s dispatch',
    async (action) => {
      const proxyService = {
        handlePreflightedGeminiGenerateContent: vi.fn(),
        handlePreflightedGeminiStreamGenerateContent: vi.fn(),
      };
      const accountLeaseService = createAccountLeaseService();
      const controller = new GeminiController(proxyService as never, accountLeaseService as never);
      const reply = createReply();

      await controller.modelAction(`not-advertised:${action}`, validNativeBody, reply as never);

      expect(accountLeaseService.refreshQuotaCatalog).toHaveBeenCalledWith({
        force: true,
        model: 'not-advertised',
      });
      expect(reply.status).toHaveBeenCalledWith(404);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ status: 'NOT_FOUND' }) }),
      );
      expect(proxyService.handlePreflightedGeminiGenerateContent).not.toHaveBeenCalled();
      expect(proxyService.handlePreflightedGeminiStreamGenerateContent).not.toHaveBeenCalled();
    },
  );

  it('dispatches an advertised native model after refreshing its catalog entry', async () => {
    const proxyService = {
      handlePreflightedGeminiGenerateContent: vi.fn().mockResolvedValue({ candidates: [] }),
    };
    const accountLeaseService = createAccountLeaseService();
    const controller = new GeminiController(proxyService as never, accountLeaseService as never);
    const reply = createReply();

    await controller.modelAction('gemini-3-flash:generateContent', validNativeBody, reply as never);

    expect(proxyService.handlePreflightedGeminiGenerateContent).toHaveBeenCalledWith(
      'models/gemini-3-flash',
      validNativeBody,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});
