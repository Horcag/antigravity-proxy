import { describe, expect, it, vi } from 'vitest';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';

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

function createController(response: unknown) {
  const proxyService = {
    handleChatCompletions: vi.fn(),
    handleGeminiGenerateContent: vi.fn().mockResolvedValue(response),
  };
  return { controller: new ProxyController(proxyService as never), proxyService };
}

describe('ProxyController OpenAI image endpoints', () => {
  it('uses the native Gemini image path with an explicit image response modality', async () => {
    const { controller, proxyService } = createController({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
          },
        },
      ],
    });
    const reply = createReplyMock();

    await controller.imageGenerations(
      { model: 'gemini-3.1-flash-image', prompt: 'cat' },
      reply,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3.1-flash-image',
      {
        contents: [{ role: 'user', parts: [{ text: 'cat' }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      },
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.sentBody.data).toEqual([{ b64_json: 'aW1hZ2U=' }]);
  });

  it('returns a bounded 502 when native Gemini output has no inline image', async () => {
    const { controller } = createController({
      candidates: [{ content: { parts: [{ text: 'no image was generated' }] } }],
    });
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'cat' }, reply);

    expect(reply.statusCode).toBe(502);
    expect(reply.sentBody.error).toMatchObject({
      message: 'Upstream did not return inline image data',
      type: 'server_error',
    });
  });

  it('preserves JSON edit image input parts for the native Gemini request', async () => {
    const { controller, proxyService } = createController({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/png', data: 'ZWRpdGVk' } }],
          },
        },
      ],
    });
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        model: 'gemini-3.1-flash-image',
        prompt: 'make it blue',
        image: 'data:image/png;base64,iVBORw0KGgo=',
      },
      { headers: {} } as never,
      reply,
    );

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3.1-flash-image',
      expect.objectContaining({
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'make it blue' },
              { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
            ],
          },
        ],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    );
    expect(reply.statusCode).toBe(200);
  });
});
