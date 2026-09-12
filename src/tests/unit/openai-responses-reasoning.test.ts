import { describe, expect, it, vi } from 'vitest';

import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';

function createReply() {
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
  };
  return reply;
}

function createController(response: unknown) {
  const proxyService = { handleChatCompletions: vi.fn().mockResolvedValue(response) };
  return { controller: new ProxyController(proxyService as never), proxyService };
}

function chatResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl_response-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gemini-3-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'answer' },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    ...overrides,
  };
}

function requestBody(input: unknown = 'hello') {
  return { model: 'gemini-3-flash', input };
}

describe('ProxyController Responses reasoning output', () => {
  it('emits a stable reasoning item before message and tool-call output', async () => {
    const { controller } = createController(
      chatResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: 'brief reasoning summary',
              tool_calls: [
                {
                  id: 'call_response-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"query":"q"}' },
                },
              ],
            },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const reply = createReply();

    await controller.responses(requestBody() as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.sentBody.output.map((item: { type: string }) => item.type)).toEqual([
      'reasoning',
      'message',
      'function_call',
    ]);
    expect(reply.sentBody.output[0]).toEqual({
      id: 'rs_response-1',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'brief reasoning summary' }],
    });
    const outputIds = reply.sentBody.output.map((item: { id: string }) => item.id);
    expect(new Set(outputIds).size).toBe(outputIds.length);
  });

  it('emits reasoning before a tool call when there is no assistant text', async () => {
    const { controller } = createController(
      chatResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'need a tool',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'search', arguments: '{}' },
                },
              ],
            },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const reply = createReply();

    await controller.responses(requestBody() as never, reply as never);

    expect(reply.sentBody.output.map((item: { type: string }) => item.type)).toEqual([
      'reasoning',
      'function_call',
    ]);
  });

  it('marks the reasoning item incomplete when the response is incomplete', async () => {
    const { controller } = createController(
      chatResponse({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'partial', reasoning_content: 'partial trace' },
            logprobs: null,
            finish_reason: 'length',
          },
        ],
      }),
    );
    const reply = createReply();

    await controller.responses(requestBody() as never, reply as never);

    expect(reply.sentBody).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    expect(reply.sentBody.output[0]).toMatchObject({ type: 'reasoning', status: 'incomplete' });
  });

  it('does not fabricate a reasoning item when the upstream response has none', async () => {
    const { controller } = createController(chatResponse());
    const reply = createReply();

    await controller.responses(requestBody() as never, reply as never);

    expect(reply.sentBody.output).toEqual([
      expect.objectContaining({ type: 'message', content: expect.any(Array) }),
    ]);
  });

  it('does not emit a reasoning item for whitespace-only reasoning content', async () => {
    const { controller } = createController(
      chatResponse({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer', reasoning_content: ' \n\t ' },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const reply = createReply();

    await controller.responses(requestBody() as never, reply as never);

    expect(reply.sentBody.output).toEqual([
      expect.objectContaining({ type: 'message', content: expect.any(Array) }),
    ]);
  });

  it('preserves padded meaningful reasoning content', async () => {
    const { controller } = createController(
      chatResponse({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer', reasoning_content: '  padded summary  ' },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const reply = createReply();

    await controller.responses(requestBody() as never, reply as never);

    expect(reply.sentBody.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '  padded summary  ' }],
    });
  });

  it('validates replayed reasoning but omits it from the upstream prompt', async () => {
    const { controller, proxyService } = createController(chatResponse());
    const reply = createReply();

    await controller.responses(
      requestBody([
        {
          id: 'rs_previous',
          type: 'reasoning',
          status: 'completed',
          encrypted_content: 'opaque-private-state',
          summary: [{ type: 'summary_text', text: 'private summary' }],
          content: [{ type: 'reasoning_text', text: 'private detail' }],
        },
        { type: 'message', role: 'user', content: 'visible request' },
      ]) as never,
      reply as never,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'visible request' }],
      }),
      'responses',
      expect.any(Object),
      undefined,
    );
  });

  it.each([
    ['missing summary', { id: 'rs_1', type: 'reasoning' }],
    ['non-array summary', { id: 'rs_1', type: 'reasoning', summary: 'summary' }],
    [
      'malformed summary entry',
      { id: 'rs_1', type: 'reasoning', summary: [{ type: 'output_text', text: 'summary' }] },
    ],
    [
      'malformed reasoning content entry',
      {
        id: 'rs_1',
        type: 'reasoning',
        summary: [],
        content: [{ type: 'summary_text', text: 'detail' }],
      },
    ],
  ])('rejects %s replayed reasoning items', async (_case, reasoningItem) => {
    const { controller, proxyService } = createController(chatResponse());
    const reply = createReply();

    await expect(controller.responses(requestBody([reasoningItem]) as never, reply as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });
});
