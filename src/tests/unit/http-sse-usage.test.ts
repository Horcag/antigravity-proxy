import http from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardHooks } from '@/dashboard/request-journal';
import { observeAccountOutcome, observeSelectedAccount } from '@/observability/request-context';
import { closeRequestHistory, configureRequestHistory, getRequestHistory } from '@/observability/request-history';

afterEach(() => {
  closeRequestHistory();
});

describe('HTTP SSE usage capture & session_key persistence', () => {
  it('captures hijacked SSE usage for OpenAI Responses, Anthropic, and Gemini without modifying stream bytes', async () => {
    configureRequestHistory(':memory:');
    const server = Fastify();
    installDashboardHooks(server);

    server.post('/v1/messages', (_req, reply) => {
      observeSelectedAccount('acc-claude');
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      reply.raw.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":500,"cache_read_input_tokens":300,"cache_creation_input_tokens":100,"output_tokens":5}}}\n\n');
      reply.raw.write('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":0,"output_tokens":120}}\n\n');
      reply.raw.end();
    });

    server.post('/v1/responses', (_req, reply) => {
      observeSelectedAccount('acc-resp');
      observeAccountOutcome('acc-resp', 'gemini-4-neon-high', 'success', 42);
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":900,"input_tokens_details":{"cached_tokens":400},"output_tokens":250,"output_tokens_details":{"reasoning_tokens":80}}}}\n\n');
      reply.raw.end();
    });

    server.post('/v1beta/models/gemini-4-argon-high:streamGenerateContent', (_req, reply) => {
      observeSelectedAccount('acc-gem');
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('data: {"usageMetadata":{"promptTokenCount":700,"cachedContentTokenCount":200,"candidatesTokenCount":90,"thoughtsTokenCount":30}}\n\n');
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    });

    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      const r1 = await fetch(`${address}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': 'sess-anthropic-1' },
        body: JSON.stringify({ model: 'claude-opus-5-5' }),
      });
      await r1.text();

      const r2 = await fetch(`${address}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-4-neon', sessionId: 'sess-resp-2' }),
      });
      await r2.text();

      const r3 = await fetch(`${address}/v1beta/models/gemini-4-argon-high:streamGenerateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello prefix' }] }] }),
      });
      await r3.text();

      await new Promise((r) => setTimeout(r, 20));
      const history = getRequestHistory({ limit: 10 });
      expect(history.total).toBe(3);

      const anthropicRow = history.items.find((i) => i.route === '/v1/messages');
      expect(anthropicRow).toMatchObject({
        status: 200,
        session_key: 'session:sess-anthropic-1',
        usage_schema: 'anthropic',
        input_tokens: 500,
        cache_tokens: 300,
        cache_write_tokens: 100,
        output_tokens: 120,
      });

      const respRow = history.items.find((i) => i.route === '/v1/responses');
      expect(respRow).toMatchObject({
        status: 200,
        session_key: 'session:sess-resp-2',
        usage_schema: 'openai',
        input_tokens: 900,
        cache_tokens: 400,
        output_tokens: 250,
        thought_tokens: 80,
      });

      const gemRow = history.items.find((i) => i.route.includes(':generateContent'));
      expect(gemRow?.usage_schema).toBe('gemini');
      expect(gemRow?.session_key).toMatch(/^hint:prefix:[0-9a-f]{16}$/);
      expect(gemRow).toMatchObject({ input_tokens: 700, cache_tokens: 200, output_tokens: 90, thought_tokens: 30 });
    } finally {
      await server.close();
    }
  });

  it('negative control: preserves 499 and drops partial usage when client disconnects mid-SSE', async () => {
    configureRequestHistory(':memory:');
    const server = Fastify();
    installDashboardHooks(server);
    server.post('/v1/chat/completions', (_req, reply) => {
      observeSelectedAccount('acc-cancel');
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":5}}\n\n');
    });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(`${address}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
        });
        req.once('error', reject);
        req.end(JSON.stringify({ model: 'gemini-4-neon' }));
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(getRequestHistory().items[0]).toMatchObject({
        status: 499,
        input_tokens: null,
        output_tokens: null,
      });
    } finally {
      await server.close();
    }
  });
});
