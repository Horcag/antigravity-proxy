import { describe, expect, it, vi } from 'vitest';
import { GeminiController } from '@/modules/proxy-gateway/server/gemini.controller';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';

function createReply() {
  return {
    send: vi.fn(),
    status: vi.fn(),
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
    const controller = new GeminiController(proxyService as never);
    const reply = createReply();
    reply.status.mockReturnValue(reply);

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
});
