import { Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

type StreamFamily = 'anthropic' | 'gemini' | 'openai' | 'responses';

function account(): CloudAccount {
  return {
    id: 'account-secret',
    provider: 'google',
    email: 'account-secret@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: 'project-secret',
    },
    created_at: 1,
    last_used: 1,
  };
}

function createAccountLeaseService() {
  const selectedAccount = account();
  return {
    getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(1),
    getNextToken: vi.fn().mockResolvedValue(selectedAccount),
    resolveDynamicModelForAccount: vi.fn((_accountId: string, model: string) => model),
    getModelOutputLimitForAccount: vi.fn().mockReturnValue(undefined),
    getModelThinkingBudgetForAccount: vi.fn().mockReturnValue(undefined),
    recordParityError: vi.fn(),
    markAsForbidden: vi.fn(),
    markAsRateLimited: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    markModelSuccess: vi.fn(),
    recordPerformanceSuccess: vi.fn(),
    recordPerformanceFailure: vi.fn(),
    markModelUnrequestable: vi.fn(),
  };
}

async function createStreamRequest(family: StreamFamily) {
  const accountLeaseService = createAccountLeaseService();
  const upstream = new PassThrough();
  const geminiClient = {
    streamGenerateInternal: vi.fn().mockResolvedValue(upstream),
  };
  const service = new ProxyService(accountLeaseService as never, geminiClient as never);
  vi.spyOn(service as any, 'waitBeforeRetry').mockResolvedValue(undefined);

  let result: Observable<string>;
  if (family === 'anthropic') {
    result = (await service.handleAnthropicMessages({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    } as any)) as Observable<string>;
  } else if (family === 'gemini') {
    result = await service.handleGeminiStreamGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
  } else if (family === 'openai') {
    result = (await service.handleChatCompletions({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    } as any)) as Observable<string>;
  } else {
    result = (await service.handleChatCompletions(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      } as any,
      'responses',
    )) as Observable<string>;
  }

  return { accountLeaseService, result, service, upstream };
}

function consume(stream: Observable<string>): Promise<{ error?: Error; values: string[] }> {
  return new Promise((resolve) => {
    const values: string[] = [];
    stream.subscribe({
      next: (value) => values.push(value),
      error: (error: unknown) =>
        resolve({ error: error instanceof Error ? error : new Error(String(error)), values }),
      complete: () => resolve({ values }),
    });
  });
}

async function settlePenalty(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function canaries(prefix: string): string[] {
  return [
    `${prefix}-raw-canary`,
    `${prefix}-account-project-model-canary`,
    `https://${prefix}-user:${prefix}-password@proxy.example.test/path`,
  ].flatMap((value) => [
    value,
    Buffer.from(value).toString('base64'),
    createHash('sha256').update(value).digest('hex'),
  ]);
}

const usableEvent =
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}]}}\n\n';

describe('ProxyService stream health lifecycle', () => {
  it.each<StreamFamily>(['anthropic', 'gemini', 'openai', 'responses'])(
    '%s clears scoped failure state only after usable upstream output',
    async (family) => {
      const { accountLeaseService, result, upstream } = await createStreamRequest(family);

      expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
      const consumed = consume(result);
      upstream.end(usableEvent);

      expect((await consumed).error).toBeUndefined();
      expect(accountLeaseService.markModelSuccess).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.markModelSuccess).toHaveBeenCalledWith(
        'account-secret',
        expect.any(String),
      );
    },
  );

  it('preserves native Gemini SSE framing while classifying usable output', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const upstreamFrames = [
      ': keepalive comment\r\n',
      'id: upstream-event-1\r\n',
      'event: message\r\n',
      usableEvent,
    ].join('');
    const consumed = consume(result);

    upstream.end(upstreamFrames);

    expect((await consumed).values.join('')).toBe(upstreamFrames);
  });

  it('classifies native server tool-combination parts as usable Gemini stream output', async () => {
    const { accountLeaseService, result, upstream } = await createStreamRequest('gemini');
    const serverToolEvent =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"toolCall":{"functionCalls":[{"name":"weather"}]},"thoughtSignature":"server-call-signature"},{"toolResponse":{"functionResponses":[{"name":"weather","response":{"result":"sunny"}}]},"thought_signature":"server-response-signature"}]}}]}}\n\n';
    const consumed = consume(result);

    upstream.end(serverToolEvent);

    expect((await consumed).error).toBeUndefined();
    expect(accountLeaseService.markModelSuccess).toHaveBeenCalledTimes(1);
  });

  it('buffers native Gemini frames across chunks and preserves valid data, metadata, comments, and DONE bytes', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const frames = [
      ': keepalive\r\n\r\n',
      'id: upstream-event-1\r\nevent: message\r\ndata: {"response":\r\ndata: {"usageMetadata":{"totalTokenCount":1}}}\r\n\r\n',
      usableEvent,
      'data: [DONE]\n\n',
    ];
    const consumed = consume(result);

    upstream.write(frames[0].slice(0, 7));
    upstream.write(frames[0].slice(7) + frames[1].slice(0, 31));
    upstream.write(frames[1].slice(31) + frames[2] + frames[3]);
    upstream.end();

    expect((await consumed).values.join('')).toBe(frames.join(''));
  });

  it('delivers multiple CR-only native Gemini frames incrementally', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const frames = [
      usableEvent.replaceAll('\n', '\r'),
      'data: [DONE]\r\r',
      usableEvent.replaceAll('\n', '\r'),
    ];
    const values: string[] = [];
    const completion = new Promise<Error | undefined>((resolve) => {
      result.subscribe({
        next: (value) => values.push(value),
        error: (error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve(undefined),
      });
    });

    upstream.write(frames[0] + frames[1].slice(0, 1));
    expect(values).toEqual([frames[0]]);
    upstream.end(frames[1].slice(1) + frames[2]);

    expect(await completion).toBeUndefined();
    expect(values.join('')).toBe(frames.join(''));
  });

  it('waits for a CRLF frame terminator split across chunks', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const frame = usableEvent.replaceAll('\n', '\r\n');
    const values: string[] = [];
    const completion = new Promise<Error | undefined>((resolve) => {
      result.subscribe({
        next: (value) => values.push(value),
        error: (error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve(undefined),
      });
    });

    upstream.write(frame.slice(0, -1));
    expect(values).toEqual([]);
    upstream.end(frame.slice(-1));

    expect(await completion).toBeUndefined();
    expect(values).toEqual([frame]);
  });

  it('recognizes CRLF frames when every CRLF is split across chunks', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const frame = `: keepalive\r\nid: event-1\r\ndata: ${usableEvent.slice('data: '.length, -2)}\r\n\r\n`;
    const chunks = frame.split(/(?<=\r)(?=\n)/u);
    const consumed = consume(result);

    for (const chunk of chunks) {
      upstream.write(chunk);
    }
    upstream.end();

    expect((await consumed).error).toBeUndefined();
    expect((await consumed).values).toEqual([frame]);
  });

  it('preserves a structurally valid mixed-ending comment and multiline-data frame', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const payload = JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] },
    });
    const splitAt = payload.indexOf('{', payload.indexOf(':') + 1);
    const frame = [
      ': keepalive\r',
      'event: message\n',
      `data: ${payload.slice(0, splitAt)}\r\n`,
      `data: ${payload.slice(splitAt)}\r`,
      '\n',
    ].join('');
    const consumed = consume(result);

    upstream.end(frame);

    expect((await consumed).error).toBeUndefined();
    expect((await consumed).values).toEqual([frame]);
  });

  it.each([
    ['before valid output', false],
    ['after valid output', true],
  ])('does not emit invalid native Gemini SSE frames %s', async (_position, emitValidFirst) => {
    const { result, service, upstream } = await createStreamRequest('gemini');
    const rawCanaries = canaries('native-gemini-sse');
    const destroyUpstreamStream = vi.spyOn(service as any, 'destroyUpstreamStream');
    const consumed = consume(result);
    if (emitValidFirst) {
      upstream.write(usableEvent);
    }
    upstream.write(`data: {${rawCanaries.join('|')}}\n\n`);
    upstream.end();

    const { error, values } = await consumed;
    expect(error?.message).toBe('Upstream stream failed');
    expect(values.join('')).toBe(emitValidFirst ? usableEvent : '');
    expect(destroyUpstreamStream).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(values);
    for (const canary of rawCanaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('does not emit a CR-only invalid frame after valid native Gemini output', async () => {
    const { result, upstream } = await createStreamRequest('gemini');
    const rawCanaries = canaries('native-gemini-cr-sse');
    const consumed = consume(result);
    const validFrame = usableEvent.replaceAll('\n', '\r');

    upstream.end(`${validFrame}data: {${rawCanaries.join('|')}}\r\r`);

    const { error, values } = await consumed;
    expect(error?.message).toBe('Upstream stream failed');
    expect(values).toEqual([validFrame]);
    for (const canary of rawCanaries) {
      expect(JSON.stringify(values)).not.toContain(canary);
    }
  });

  it.each<StreamFamily>(['anthropic', 'gemini', 'openai', 'responses'])(
    '%s records a scoped penalty instead of success when the stream is empty',
    async (family) => {
      const { accountLeaseService, result, upstream } = await createStreamRequest(family);
      const consumed = consume(result);
      upstream.end();

      await consumed;
      await settlePenalty();
      expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
        expect.objectContaining({ accountIdOrEmail: 'account-secret', model: expect.any(String) }),
      );
      expect(accountLeaseService.recordPerformanceFailure).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.recordPerformanceSuccess).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['explicit upstream error', 'data: {"error":{"code":429,"message":"RESOURCE_EXHAUSTED"}}\n\n'],
    ['malformed payload', 'data: {not-json}\n\n'],
  ])('records a scoped penalty for %s before native Gemini output', async (_case, event) => {
    const { accountLeaseService, result, upstream } = await createStreamRequest('gemini');
    const consumed = consume(result);
    upstream.end(event);

    await consumed;
    await settlePenalty();
    expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({ accountIdOrEmail: 'account-secret', model: 'gemini-3-flash' }),
    );
  });

  it('records a scoped penalty on OpenAI-compatible transport failure after stream acquisition', async () => {
    const { accountLeaseService, result, upstream } = await createStreamRequest('openai');
    const consumed = consume(result);
    upstream.destroy(new Error('socket hang up'));

    await consumed;
    await settlePenalty();
    expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({ accountIdOrEmail: 'account-secret', model: 'gemini-3-flash' }),
    );
  });

  it.each<Extract<StreamFamily, 'gemini' | 'openai'>>(['gemini', 'openai'])(
    '%s ignores late upstream callbacks after the client unsubscribes',
    async (family) => {
      const { accountLeaseService, result, service, upstream } = await createStreamRequest(family);
      const idleTimer = {
        reset: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
      };
      vi.spyOn(service as any, 'createStreamIdleTimer').mockReturnValue(idleTimer);

      const subscription = result.subscribe();
      const lateDataCallbacks = upstream.listeners('data') as Array<(chunk: Buffer) => void>;
      const lateEndCallbacks = upstream.listeners('end') as Array<() => void>;
      const lateErrorCallbacks = upstream.listeners('error') as Array<(error: Error) => void>;

      expect(lateDataCallbacks).toHaveLength(1);
      expect(lateEndCallbacks).toHaveLength(1);
      expect(lateErrorCallbacks).toHaveLength(1);

      subscription.unsubscribe();

      expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
      expect(upstream.listenerCount('data')).toBe(0);
      expect(upstream.listenerCount('end')).toBe(0);
      expect(upstream.listenerCount('error')).toBe(0);

      lateDataCallbacks.forEach((callback) => callback(Buffer.from(usableEvent)));
      lateEndCallbacks.forEach((callback) => callback());
      lateErrorCallbacks.forEach((callback) => callback(new Error('late upstream error')));

      await settlePenalty();
      expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
      expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    },
  );

  it.each<StreamFamily>(['anthropic', 'gemini', 'openai', 'responses'])(
    '%s includes stream acquisition time in TTFT',
    async (family) => {
      const now = vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(42);
      try {
        const { accountLeaseService, result, upstream } = await createStreamRequest(family);
        const consumed = consume(result);
        upstream.end(usableEvent);

        await consumed;
        expect(accountLeaseService.recordPerformanceSuccess).toHaveBeenCalledWith(
          'account-secret',
          expect.any(String),
          32,
        );
      } finally {
        now.mockRestore();
      }
    },
  );

  it('records non-stream success without supplying a TTFT sample', async () => {
    const accountLeaseService = createAccountLeaseService();
    const geminiClient = {
      generateInternal: vi.fn().mockResolvedValue({
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] } }],
      }),
    };
    const service = new ProxyService(accountLeaseService as never, geminiClient as never);

    await service.handleGeminiGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });

    expect(accountLeaseService.recordPerformanceSuccess).toHaveBeenCalledWith(
      'account-secret',
      'gemini-3-flash',
    );
    expect(accountLeaseService.recordPerformanceSuccess).not.toHaveBeenCalledWith(
      'account-secret',
      'gemini-3-flash',
      expect.any(Number),
    );
  });

  it('records every failed initiated non-stream retry once', async () => {
    const accountLeaseService = createAccountLeaseService();
    accountLeaseService.getRefreshedModelCapableAccountCount.mockResolvedValue(2);
    const geminiClient = {
      generateInternal: vi
        .fn()
        .mockRejectedValue(new UpstreamRequestError({ status: 503, reason: 'upstream_error' })),
    };
    const service = new ProxyService(accountLeaseService as never, geminiClient as never);
    vi.spyOn(service as any, 'waitBeforeRetry').mockResolvedValue(undefined);

    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    ).rejects.toBeInstanceOf(UpstreamRequestError);

    expect(geminiClient.generateInternal).toHaveBeenCalledTimes(2);
    expect(accountLeaseService.recordPerformanceFailure).toHaveBeenCalledTimes(2);
    expect(accountLeaseService.recordPerformanceFailure).toHaveBeenNthCalledWith(
      1,
      'account-secret',
      'gemini-3-flash',
    );
  });

  it('Responses removes its listeners and disposes timers on normal completion', async () => {
    vi.useFakeTimers();
    try {
      const { accountLeaseService, result, service, upstream } = await createStreamRequest('responses');
      const idleTimer = {
        reset: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
      };
      vi.spyOn(service as any, 'createStreamIdleTimer').mockReturnValue(idleTimer);
      const consumed = consume(result);

      upstream.end(usableEvent);

      expect((await consumed).error).toBeUndefined();
      expect(accountLeaseService.markModelSuccess).toHaveBeenCalledTimes(1);
      expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
      expect(upstream.listenerCount('data')).toBe(0);
      expect(upstream.listenerCount('end')).toBe(0);
      expect(upstream.listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Responses ignores late upstream callbacks after the client unsubscribes', async () => {
    const { accountLeaseService, result, service, upstream } = await createStreamRequest('responses');
    const idleTimer = {
      reset: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    };
    vi.spyOn(service as any, 'createStreamIdleTimer').mockReturnValue(idleTimer);

    const subscription = result.subscribe();
    const lateDataCallbacks = upstream.listeners('data') as Array<(chunk: Buffer) => void>;
    const lateEndCallbacks = upstream.listeners('end') as Array<() => void>;
    const lateErrorCallbacks = upstream.listeners('error') as Array<(error: Error) => void>;

    subscription.unsubscribe();

    expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
    expect(upstream.listenerCount('data')).toBe(0);
    expect(upstream.listenerCount('end')).toBe(0);
    expect(upstream.listenerCount('error')).toBe(0);

    lateDataCallbacks.forEach((callback) => callback(Buffer.from(usableEvent)));
    lateEndCallbacks.forEach((callback) => callback());
    lateErrorCallbacks.forEach((callback) => callback(new Error('late upstream error')));

    await settlePenalty();
    expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it('Responses records one bounded failure and cleans up on mapper failure', async () => {
    const { accountLeaseService, result, service, upstream } = await createStreamRequest('responses');
    const idleTimer = {
      reset: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    };
    vi.spyOn(service as any, 'createStreamIdleTimer').mockReturnValue(idleTimer);
    const consumed = consume(result);

    upstream.write('data: {not-json}\n\n');

    expect((await consumed).error).toBeUndefined();
    await settlePenalty();
    expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledTimes(1);
    expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
    expect(upstream.listenerCount('data')).toBe(0);
    expect(upstream.listenerCount('end')).toBe(0);
    expect(upstream.listenerCount('error')).toBe(0);
  });

  it.each([
    [401, undefined],
    [403, undefined],
    [429, '30'],
    [429, 'Wed, 21 Oct 2037 07:28:00 GMT'],
    [500, undefined],
  ] as const)(
    'Responses preserves typed in-band HTTP %i failures through stream health',
    async (status, retryAfter) => {
      const { accountLeaseService, result, upstream } = await createStreamRequest('responses');
      const consumed = consume(result);
      upstream.end(
        `data: ${JSON.stringify({
          error: {
            code: status,
            ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
          },
        })}\n\n`,
      );

      expect((await consumed).error).toBeUndefined();
      await settlePenalty();
      expect(accountLeaseService.recordParityError).toHaveBeenCalledTimes(1);
      if (status === 401 || status === 403) {
        expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith('account-secret');
        expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
        return;
      }
      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
        expect.objectContaining({
          accountIdOrEmail: 'account-secret',
          status,
          ...(retryAfter ? { retryAfter } : {}),
        }),
      );
    },
  );

  it('Responses records one bounded failure and cleans up on idle timeout', async () => {
    const { accountLeaseService, result, service, upstream } = await createStreamRequest('responses');
    const idleTimer = {
      reset: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    };
    let onTimeout: (() => void) | undefined;
    vi.spyOn(service as any, 'createStreamIdleTimer').mockImplementation((...args: unknown[]) => {
      const callback = args[2];
      if (typeof callback === 'function') {
        onTimeout = callback as () => void;
      }
      return idleTimer;
    });
    const consumed = consume(result);

    onTimeout?.();

    expect((await consumed).error).toBeUndefined();
    await settlePenalty();
    expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledTimes(1);
    expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
    expect(upstream.listenerCount('data')).toBe(0);
    expect(upstream.listenerCount('end')).toBe(0);
    expect(upstream.listenerCount('error')).toBe(0);
  });

  it.each<Extract<StreamFamily, 'gemini' | 'responses'>>(['gemini', 'responses'])(
    '%s idle timeout has one destruction and terminal owner during late error and unsubscribe races',
    async (family) => {
      vi.useFakeTimers();
      try {
        const { result, service, upstream } = await createStreamRequest(family);
        (service as any).streamIdleTimeoutMs = 1;
        const destroyUpstreamStream = vi.spyOn(service as any, 'destroyUpstreamStream');
        const terminalSettlements = vi.fn();
        const subscription = result.subscribe({
          complete: () => terminalSettlements('complete'),
          error: () => terminalSettlements('error'),
        });
        const lateErrorCallbacks = upstream.listeners('error') as Array<(error: Error) => void>;

        await vi.advanceTimersByTimeAsync(2);
        lateErrorCallbacks.forEach((callback) => callback(new Error('late upstream error')));
        subscription.unsubscribe();

        expect(destroyUpstreamStream).toHaveBeenCalledTimes(1);
        expect(terminalSettlements).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('Responses preserves one health penalty while suppressing performance failure after output', async () => {
    const { accountLeaseService, result, service, upstream } = await createStreamRequest('responses');
    const idleTimer = {
      reset: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    };
    vi.spyOn(service as any, 'createStreamIdleTimer').mockReturnValue(idleTimer);
    const consumed = consume(result);

    upstream.write(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}}\n\n',
    );
    upstream.emit('error', new Error('socket hang up'));

    expect((await consumed).error).toBeUndefined();
    await settlePenalty();
    expect(accountLeaseService.markModelSuccess).toHaveBeenCalledTimes(1);
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledTimes(1);
    expect(accountLeaseService.recordPerformanceSuccess).toHaveBeenCalledTimes(1);
    expect(accountLeaseService.recordPerformanceFailure).not.toHaveBeenCalled();
    expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
  });

  it.each<Extract<StreamFamily, 'gemini' | 'openai'>>(['gemini', 'openai'])(
    '%s preserves one health penalty while suppressing performance failure after usable output',
    async (family) => {
      const { accountLeaseService, result, upstream } = await createStreamRequest(family);
      const consumed = consume(result);

      upstream.write(usableEvent);
      upstream.destroy(new Error('socket hang up'));

      await consumed;
      await settlePenalty();
      expect(accountLeaseService.markModelSuccess).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.recordPerformanceSuccess).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.recordPerformanceFailure).not.toHaveBeenCalled();
    },
  );

  it('contains asynchronous penalty recording failures', async () => {
    const { accountLeaseService, result, upstream } = await createStreamRequest('gemini');
    accountLeaseService.markFromUpstreamError.mockRejectedValueOnce(new Error('persistence failed'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const consumed = consume(result);
    upstream.end();

    await consumed;
    await settlePenalty();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith('Unable to record stream health penalty');
  });

  it('records a scoped penalty on Anthropic stream idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const { accountLeaseService, result, service } = await createStreamRequest('anthropic');
      (service as any).streamIdleTimeoutMs = 1;
      const consumed = consume(result);
      await vi.advanceTimersByTimeAsync(2);

      await consumed;
      await settlePenalty();
      expect(accountLeaseService.markModelSuccess).not.toHaveBeenCalled();
      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
        expect.objectContaining({ accountIdOrEmail: 'account-secret' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GeminiClient project-header downgrade logging', () => {
  it('does not include account or project identifiers in the downgrade warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const post = vi.spyOn(axios, 'post');
    const request = {
      project: 'project-secret',
      requestId: 'request-id',
      model: 'gemini-3-flash',
      userAgent: 'test-agent',
      request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    } as any;
    const error = new Error('Permission denied') as any;
    error.isAxiosError = true;
    error.response = { status: 403, headers: {}, data: { error: { message: 'Permission denied' } } };
    post.mockRejectedValueOnce(error).mockResolvedValueOnce({
      data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] },
      headers: {},
    } as any);

    await new GeminiClient().generateInternal(request, 'access-token', undefined, undefined, 'account-secret');

    const downgradeWarning = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('project_context_rejected'));
    expect(downgradeWarning).toBeDefined();
    expect(downgradeWarning).not.toContain('account-secret');
    expect(downgradeWarning).not.toContain('project-secret');
  });
});
