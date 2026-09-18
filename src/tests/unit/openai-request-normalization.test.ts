import { describe, expect, it, vi } from 'vitest';
import { OpenAIProtocolException } from '../../modules/proxy-gateway/server/openai-protocol-error';
import {
  OpenAIRequestNormalizer,
  attachCompatibilityHeaders,
} from '../../modules/proxy-gateway/server/openai-request-normalizer';
import { ProxyController } from '../../modules/proxy-gateway/server/proxy.controller';

function createMockReply() {
  const headers: Record<string, string> = {};
  const reply: any = {
    statusCode: 200,
    headers,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    header(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return this;
    },
    getHeaders() {
      return { ...headers };
    },
    send(body: any) {
      this.sentBody = body;
      return this;
    },
    raw: {
      writableEnded: false,
      writeHead: vi.fn((statusCode: number, headHeaders: any) => {
        Object.assign(headers, headHeaders);
      }),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    },
  };
  return reply;
}

function createController(mockResponse: any) {
  const proxyService: any = {
    handleChatCompletions: vi.fn().mockResolvedValue(mockResponse),
    extractOpenAISessionKey: (req: any) => {
      if (req.extra?.session_id) return `session:${req.extra.session_id}`;
      return undefined;
    },
  };
  const controller = new ProxyController(proxyService);
  return { controller, proxyService };
}

describe('OpenAIRequestNormalizer', () => {
  const normalizer = new OpenAIRequestNormalizer();

  describe('Value matrix: Chat Completions', () => {
    it('accepts store: false as honor-locally and omits it from upstream payload', () => {
      const input = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        store: false,
      };
      const { normalized, notices } = normalizer.normalizeChatRequest(input);
      expect(normalized.model).toBe('gemini-3-flash');
      expect((normalized as any).store).toBeUndefined();
      expect(notices).toContainEqual(
        expect.objectContaining({
          parameter: 'store',
          action: 'honor-locally',
          reasonCode: 'stateless_proxy_retention',
        }),
      );
    });

    it('rejects store: true with unsupported_parameter', () => {
      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hello' }],
          store: true,
        }),
      ).toThrow('persistent response storage is not implemented');
    });

    it('accepts parallel_tool_calls: true as accept-noop and omits it upstream', () => {
      const input = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        parallel_tool_calls: true,
      };
      const { normalized, notices } = normalizer.normalizeChatRequest(input);
      expect((normalized as any).parallel_tool_calls).toBeUndefined();
      expect(notices).toContainEqual(
        expect.objectContaining({
          parameter: 'parallel_tool_calls',
          action: 'accept-noop',
        }),
      );
    });

    it('rejects parallel_tool_calls: false with unsupported_parameter', () => {
      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hello' }],
          parallel_tool_calls: false,
        }),
      ).toThrow('single-tool execution cannot be enforced upstream');
    });

    it('accepts bounded string user as ignore-with-notice and omits it upstream', () => {
      const input = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        user: 'screenpipe_user_001',
      };
      const { normalized, notices } = normalizer.normalizeChatRequest(input);
      expect(normalized.user).toBeUndefined();
      expect(notices).toContainEqual(
        expect.objectContaining({
          parameter: 'user',
          action: 'ignore-with-notice',
          reasonCode: 'user_attribution_not_forwarded',
        }),
      );
    });

    it('rejects non-string user or overlong user', () => {
      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
          user: 12345,
        }),
      ).toThrow(OpenAIProtocolException);

      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
          user: 'a'.repeat(513),
        }),
      ).toThrow(OpenAIProtocolException);
    });

    it('accepts bounded metadata as ignore-with-notice and omits it from generation payload', () => {
      const input = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { source: 'screenpipe', session: 'test-123' },
      };
      const { normalized, notices } = normalizer.normalizeChatRequest(input);
      expect((normalized as any).metadata).toBeUndefined();
      expect(notices).toContainEqual(
        expect.objectContaining({
          parameter: 'metadata',
          action: 'ignore-with-notice',
          reasonCode: 'metadata_not_persisted',
        }),
      );
    });

    it('rejects malformed metadata (more than 16 entries or non-string values)', () => {
      const overManyEntries: Record<string, string> = {};
      for (let i = 0; i < 17; i++) overManyEntries[`k${i}`] = `v${i}`;
      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: overManyEntries,
        }),
      ).toThrow('metadata supports at most 16 entries');

      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { count: 42 as any },
        }),
      ).toThrow('metadata must be an object with string values');
    });

    it('preserves extra session context for session-affinity extraction', () => {
      const input = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        extra: { session_id: 'conversation-A' },
      };
      const { normalized, notices } = normalizer.normalizeChatRequest(input);
      expect(normalized.extra?.session_id).toBe('conversation-A');
      expect(notices).toContainEqual(
        expect.objectContaining({
          parameter: 'extra',
          action: 'honor-locally',
          reasonCode: 'session_context_preserved',
        }),
      );
    });

    it('translates 32-bit integer seed and rejects values outside int32 range', () => {
      const valid = normalizer.normalizeChatRequest({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        seed: 42,
      });
      expect(valid.normalized.seed).toBe(42);

      const zero = normalizer.normalizeChatRequest({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        seed: 0,
      });
      expect(zero.normalized.seed).toBe(0);

      expect(() =>
        normalizer.normalizeChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
          seed: 9007199254740991, // 53-bit overflow
        }),
      ).toThrow('seed must be an integer between -2147483648 and 2147483647');
    });

    it('preserves input immutability and does not delete nested properties', () => {
      const rawInput = {
        model: 'gemini-3-flash',
        messages: [
          { role: 'user', content: JSON.stringify({ store: true, user: 'nested', metadata: { key: 'val' } }) },
        ],
        store: false,
        user: 'top_level_user',
        metadata: { top: 'meta' },
      };
      const inputCopy = JSON.parse(JSON.stringify(rawInput));
      const { normalized } = normalizer.normalizeChatRequest(rawInput);
      expect(rawInput).toEqual(inputCopy);
      expect(normalized.messages[0].content).toContain('"store":true');
    });
  });

  describe('Value matrix: Responses API Options', () => {
    it('accepts standard { text: { format: { type: "text" } } } and alias "text"', () => {
      const objFormat = normalizer.normalizeResponsesOptions({
        text: { format: { type: 'text' } },
      });
      expect(objFormat.notices).toContainEqual(
        expect.objectContaining({ parameter: 'text', action: 'accept-noop' }),
      );

      const stringFormat = normalizer.normalizeResponsesOptions({
        text: { format: 'text' },
      });
      expect(stringFormat.notices).toContainEqual(
        expect.objectContaining({ parameter: 'text', action: 'accept-noop' }),
      );
    });

    it('rejects unsupported text options and non-text formats', () => {
      expect(() =>
        normalizer.normalizeResponsesOptions({
          text: { format: { type: 'json_schema' } },
        }),
      ).toThrow("format type 'json_schema' is not supported; only 'text' is supported");

      expect(() =>
        normalizer.normalizeResponsesOptions({
          text: { verbosity: 'high' } as any,
        }),
      ).toThrow("text option 'verbosity' is not supported");
    });

    it('accepts null/undefined metadata and rejects oversized metadata', () => {
      const nullMeta = normalizer.normalizeResponsesOptions({ metadata: null });
      expect(nullMeta.notices).toContainEqual(
        expect.objectContaining({ parameter: 'metadata', action: 'accept-noop' }),
      );

      const overMany: Record<string, string> = {};
      for (let i = 0; i < 17; i++) overMany[`k${i}`] = `v${i}`;
      expect(() =>
        normalizer.normalizeResponsesOptions({ metadata: overMany }),
      ).toThrow('metadata supports at most 16 entries');
    });

    it('accepts store: false, background: false, previous_response_id: null', () => {
      const { notices } = normalizer.normalizeResponsesOptions({
        store: false,
        background: false,
        previous_response_id: null,
      });
      expect(notices).toContainEqual(
        expect.objectContaining({ parameter: 'store', action: 'honor-locally' }),
      );
    });
  });

  describe('Observability & Streaming Headers', () => {
    it('attaches separated dropped and honored headers to Fastify response', () => {
      const reply = createMockReply();
      const notices = [
        { parameter: 'user', ruleId: 'chat.user', action: 'ignore-with-notice' as const, reasonCode: 'r1' },
        { parameter: 'metadata', ruleId: 'chat.meta', action: 'ignore-with-notice' as const, reasonCode: 'r2' },
        { parameter: 'store', ruleId: 'chat.store', action: 'honor-locally' as const, reasonCode: 'r3' },
      ];
      attachCompatibilityHeaders(reply, notices);
      expect(reply.headers['x-ag-proxy-dropped-params']).toBe('user, metadata');
      expect(reply.headers['x-ag-proxy-honored-locally']).toBe('store');
    });

    it('forwards compatibility headers into raw SSE writeHead during streaming', () => {
      const { controller } = createController({});
      const reply = createMockReply();
      reply.header('x-ag-proxy-dropped-params', 'user, metadata');
      reply.header('x-ag-proxy-honored-locally', 'store');

      const dummyStream: any = { subscribe: () => ({ unsubscribe: vi.fn() }) };
      (controller as any).writeSseResponse(reply, dummyStream, 'chat');

      expect(reply.raw.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/event-stream',
          'x-ag-proxy-dropped-params': 'user, metadata',
          'x-ag-proxy-honored-locally': 'store',
        }),
      );
    });
  });

  describe('Application Fixture: Screenpipe & Legacy Integrations', () => {
    it('accepts realistic Screenpipe payload and forwards cleaned request with notices', async () => {
      const mockResponse = {
        id: 'chatcmpl_screenpipe_1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Screen summary.' }, finish_reason: 'stop' }],
      };
      const { controller, proxyService } = createController(mockResponse);
      const reply = createMockReply();

      const screenpipePayload = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'What application is on screen?' }],
        store: false,
        user: 'screenpipe-desktop-v0.14.2',
        metadata: { client: 'screenpipe', platform: 'linux' },
        parallel_tool_calls: true,
        service_tier: 'auto',
      };

      await controller.chatCompletions(screenpipePayload as any, reply);

      expect(reply.statusCode).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledTimes(1);
      const forwarded = proxyService.handleChatCompletions.mock.calls[0][0];
      expect(forwarded.store).toBeUndefined();
      expect(forwarded.user).toBeUndefined();
      expect(forwarded.service_tier).toBeUndefined();

      expect(reply.headers['x-ag-proxy-dropped-params']).toBe('user, metadata');
      expect(reply.headers['x-ag-proxy-honored-locally']).toBe('store');
    });

    it('forwards seed to legacy completions endpoint', async () => {
      const { controller, proxyService } = createController({ choices: [] });
      const reply = createMockReply();
      await controller.completions({ model: 'gemini-3-flash', prompt: 'test', seed: 12345 } as any, reply);
      const forwarded = proxyService.handleChatCompletions.mock.calls[0][0];
      expect(forwarded.seed).toBe(12345);
    });
  });
});
