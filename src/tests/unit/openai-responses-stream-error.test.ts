import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import type { Observable } from 'rxjs';

import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

function collectStream(stream: Observable<string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    stream.subscribe({
      complete: () => resolve(events),
      error: reject,
      next: (event) => events.push(event),
    });
  });
}

function createResponsesStream(service: ProxyService, upstream: Readable): Promise<string[]> {
  return collectStream(
    (service as any).processResponsesStreamResponse(upstream, 'gemini-3-flash'),
  );
}

function createCanaries(): string[] {
  const rawValues = [
    'responses-upstream-error-canary',
    'responses-oauth-token-canary',
    'responses-account-project-model-canary',
    'https://responses-user:responses-password@proxy.example.test/path',
  ];
  return rawValues.flatMap((value) => [
    value,
    Buffer.from(value).toString('base64'),
    createHash('sha256').update(value).digest('hex'),
  ]);
}

function expectSingleTerminalFailure(events: string[], code: string): void {
  const payloads = events.flatMap((event) => {
    const data = event.match(/^event: [^\n]+\ndata: (.+)\n\n$/)?.[1];
    return data ? [JSON.parse(data)] : [];
  });

  expect(payloads.filter((payload) => payload.type === 'error')).toEqual([
    expect.objectContaining({
      code,
      message:
        code === 'upstream_error'
          ? 'Upstream Responses stream failed'
          : 'Malformed upstream Responses payload',
      param: null,
      type: 'error',
    }),
  ]);
  expect(payloads.filter((payload) => payload.type === 'response.failed')).toHaveLength(1);
  expect(payloads.filter((payload) => payload.type === 'response.completed')).toHaveLength(0);
}

describe('OpenAI Responses stream errors', () => {
  it('fails closed for in-band upstream errors without exposing raw or derived diagnostics', async () => {
    const canaries = createCanaries();
    const upstream = new Readable({ read() {} });
    const service = new ProxyService({} as never, {} as never);
    const eventsPromise = createResponsesStream(service, upstream);

    upstream.push(`data: ${JSON.stringify({ error: { message: canaries.join('|') } })}\n\n`);
    upstream.push(null);

    const events = await eventsPromise;
    expectSingleTerminalFailure(events, 'upstream_error');
    const serialized = JSON.stringify(events);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('fails closed for malformed upstream chunks containing raw or derived diagnostics', async () => {
    const canaries = createCanaries();
    const upstream = new Readable({ read() {} });
    const service = new ProxyService({} as never, {} as never);
    const eventsPromise = createResponsesStream(service, upstream);

    upstream.push(`data: {${canaries.join('|')}}\n\n`);
    upstream.push(null);

    const events = await eventsPromise;
    expectSingleTerminalFailure(events, 'invalid_upstream_payload');
    const serialized = JSON.stringify(events);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('fails closed for transport errors without exposing raw or derived diagnostics', async () => {
    const canaries = createCanaries();
    const upstream = new Readable({ read() {} });
    const service = new ProxyService({} as never, {} as never);
    const eventsPromise = createResponsesStream(service, upstream);

    upstream.destroy(new Error(canaries.join('|')));

    const events = await eventsPromise;
    expectSingleTerminalFailure(events, 'upstream_error');
    const serialized = JSON.stringify(events);
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });
});
