import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';

import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { ProxyProtocolExceptionFilter } from '@/modules/proxy-gateway/server/openai-protocol-error';

function createReply(raw?: Record<string, unknown>) {
  const reply: any = {
    statusCode: 200,
    status: vi.fn().mockImplementation((code: number) => {
      reply.statusCode = code;
      return reply;
    }),
    send: vi.fn().mockImplementation((body: unknown) => {
      reply.sentBody = body;
      return reply;
    }),
    header: vi.fn().mockReturnThis(),
    raw,
  };
  return reply;
}

function createRequest(
  id: string,
  anthropicVersion: string | null = '2023-06-01',
): Record<string, unknown> {
  return {
    id,
    method: 'POST',
    url: '/v1/messages',
    headers: anthropicVersion ? { 'anthropic-version': anthropicVersion } : {},
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-sonnet-4-6-thinking',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

async function invokeWithProtocolFilter(
  controller: ProxyController,
  body: Record<string, unknown>,
  request: Record<string, unknown>,
  reply: ReturnType<typeof createReply>,
) {
  try {
    await controller.anthropicMessages(body as never, request as never, reply as never);
  } catch (error) {
    new ProxyProtocolExceptionFilter().catch(error, {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as never);
  }
}

describe('Anthropic wire contract', () => {
  it.each([
    ['missing max_tokens', validBody({ max_tokens: undefined }), createRequest('invalid-max')],
    ['negative max_tokens', validBody({ max_tokens: -1 }), createRequest('invalid-max')],
    ['fractional max_tokens', validBody({ max_tokens: 1.5 }), createRequest('invalid-max')],
    ['non-number max_tokens', validBody({ max_tokens: '64' }), createRequest('invalid-max')],
    ['above-bound max_tokens', validBody({ max_tokens: 128_001 }), createRequest('invalid-max')],
    ['missing anthropic-version', validBody(), createRequest('invalid-header', null)],
    ['unsupported anthropic-version', validBody(), createRequest('invalid-header', '2024-01-01')],
  ])('rejects %s before dispatch with the Anthropic error envelope', async (_case, body, request) => {
    const service = { handleAnthropicMessages: vi.fn() };
    const controller = new ProxyController(service as never);
    const reply = createReply();

    await invokeWithProtocolFilter(controller, body, request, reply);

    expect(service.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.sentBody).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
    const requestId = (reply.sentBody as { request_id: string }).request_id;
    expect(requestId).toBe(String(request.id).replace(/[^a-zA-Z0-9_-]/g, ''));
    expect(reply.header).toHaveBeenCalledWith('request-id', requestId);
  });

  it('accepts max_tokens of 0 and dispatches to handler', async () => {
    const service = {
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', content: [] }),
    };
    const controller = new ProxyController(service as never);
    const reply = createReply();
    const request = createRequest('zero-max-tokens');

    await controller.anthropicMessages(validBody({ max_tokens: 0 }) as never, request as never, reply as never);

    expect(service.handleAnthropicMessages).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 0 }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ id: 'msg_1', content: [] });
    expect(reply.header).toHaveBeenCalledWith('request-id', 'zero-max-tokens');
  });

  it('uses the same request id for an Anthropic handler error header and body', async () => {
    const service = { handleAnthropicMessages: vi.fn().mockRejectedValue(new Error('upstream failed')) };
    const controller = new ProxyController(service as never);
    const reply = createReply();
    const request = createRequest('safe/request:id');

    await controller.anthropicMessages(validBody() as never, request as never, reply as never);

    const requestId = (reply.sentBody as { request_id: string }).request_id;
    expect(requestId).toBe('saferequestid');
    expect(reply.header).toHaveBeenCalledWith('request-id', requestId);
    expect(reply.sentBody).toMatchObject({ type: 'error', error: { type: 'api_error' } });
  });

  it('sets the request-id header on a successful Anthropic SSE response', async () => {
    const raw = {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };
    const service = { handleAnthropicMessages: vi.fn().mockResolvedValue(of('event: message_stop\n\n')) };
    const controller = new ProxyController(service as never);
    const reply = createReply(raw);
    const request = createRequest('stream-1');

    await controller.anthropicMessages(validBody({ stream: true }) as never, request as never, reply as never);

    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'request-id': 'stream-1' }),
    );
  });

  it('includes the same request id in an Anthropic SSE error event', async () => {
    const raw = {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };
    const service = {
      handleAnthropicMessages: vi.fn().mockResolvedValue(throwError(() => new Error('stream failed'))),
    };
    const controller = new ProxyController(service as never);
    const reply = createReply(raw);
    const request = createRequest('stream-error-1');

    await controller.anthropicMessages(validBody({ stream: true }) as never, request as never, reply as never);

    const payload = String(raw.write.mock.calls[0][0]).match(/data: (.+)\n\n/)?.[1];
    expect(JSON.parse(payload ?? '{}')).toMatchObject({
      type: 'error',
      request_id: 'stream-error-1',
    });
  });
});
