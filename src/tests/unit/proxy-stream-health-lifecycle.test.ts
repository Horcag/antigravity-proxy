import { Logger } from '@nestjs/common';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
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

  it('Responses retains one success and records one failure when transport fails after output', async () => {
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
    expect(idleTimer.dispose).toHaveBeenCalledTimes(1);
  });

  it.each<Extract<StreamFamily, 'gemini' | 'openai'>>(['gemini', 'openai'])(
    '%s records exactly one bounded penalty when transport fails after usable output',
    async (family) => {
      const { accountLeaseService, result, upstream } = await createStreamRequest(family);
      const consumed = consume(result);

      upstream.write(usableEvent);
      upstream.destroy(new Error('socket hang up'));

      await consumed;
      await settlePenalty();
      expect(accountLeaseService.markModelSuccess).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledTimes(1);
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
      .find((message) => message.includes('retrying without project context'));
    expect(downgradeWarning).toBeDefined();
    expect(downgradeWarning).not.toContain('account-secret');
    expect(downgradeWarning).not.toContain('project-secret');
  });
});
