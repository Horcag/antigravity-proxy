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

describe('GeminiController upstream errors', () => {
  it.each([
    ['INVALID_ARGUMENT', 400],
    ['PERMISSION_DENIED', 403],
    ['RESOURCE_EXHAUSTED', 429],
    ['UNAVAILABLE', 503],
  ])('uses the native %s status when the upstream HTTP status is absent', async (status, code) => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockRejectedValue(
        new UpstreamRequestError({
          message: 'native Gemini error',
          body: JSON.stringify({ error: { status } }),
        }),
      ),
    };
    const controller = new GeminiController(proxyService as never, createAccountLeaseService() as never);
    const reply = createReply();

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      {} as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(code);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ status }) }),
    );
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
        handleGeminiGenerateContent: vi.fn(),
        handleGeminiStreamGenerateContent: vi.fn(),
      };
      const accountLeaseService = createAccountLeaseService();
      const controller = new GeminiController(proxyService as never, accountLeaseService as never);
      const reply = createReply();

      await controller.modelAction(`not-advertised:${action}`, {} as never, reply as never);

      expect(accountLeaseService.refreshQuotaCatalog).toHaveBeenCalledWith({
        force: true,
        model: 'not-advertised',
      });
      expect(reply.status).toHaveBeenCalledWith(404);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ status: 'NOT_FOUND' }) }),
      );
      expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
      expect(proxyService.handleGeminiStreamGenerateContent).not.toHaveBeenCalled();
    },
  );

  it('dispatches an advertised native model after refreshing its catalog entry', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({ candidates: [] }),
    };
    const accountLeaseService = createAccountLeaseService();
    const controller = new GeminiController(proxyService as never, accountLeaseService as never);
    const reply = createReply();

    await controller.modelAction('gemini-3-flash:generateContent', {} as never, reply as never);

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith('models/gemini-3-flash', {});
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});
