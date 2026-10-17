import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { PassThrough, Readable } from 'node:stream';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { inspectSuspensionResponse } from '@/modules/proxy-gateway/server/clients/gemini-upstream-error';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';
import { ProxyRetryPolicy } from '@/modules/proxy-gateway/server/proxy-retry-policy';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

const message = 'This service has been disabled in this account for violation of Terms of Service.';
const body = { model: 'gemini-3.8-flash-high', project: 'test-project', requestId: 'test', userAgent: 'test', request: { contents: [] } };
function denied(data: unknown, status = 403) {
  return new axios.AxiosError('private diagnostic', 'ERR_BAD_REQUEST', undefined, undefined,
    { status, statusText: 'Forbidden', headers: {}, data, config: { headers: new axios.AxiosHeaders() } });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('native terminal account suspension', () => {
  it.each(['json', 'text', 'buffer', 'stream'] as const)('stops %s 403 before project retry and discards private diagnostics', async kind => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const text = JSON.stringify({ error: { message }, private: 'secret-canary' });
    const data = kind === 'json' ? JSON.parse(text) : kind === 'buffer' ? Buffer.from(text) : kind === 'stream' ? Readable.from([text.slice(0, 40), text.slice(40)]) : text;
    const post = vi.spyOn(axios, 'post').mockRejectedValue(denied(data));
    const client = new GeminiClient();
    const error = await client.streamGenerateInternal(body, 'secret-token', undefined, undefined, 'account-test').catch(value => value);
    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(error).toMatchObject({ status: 403, reason: 'account_suspended' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(client.userProjectCapabilityCache.hasNegativeCapability('account-test', 'test-project')).toBe(false);
    expect(JSON.stringify(error)).not.toMatch(/secret|Terms of Service|private diagnostic/);
    if (data instanceof Readable) expect(data.destroyed).toBe(true);
  });

  it.each(['generate', 'streamGenerate'] as const)('classifies direct %s without another request', async operation => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const post = vi.spyOn(axios, 'post').mockRejectedValue(denied(Readable.from([message])));
    await expect(new GeminiClient()[operation]('model', { contents: [] }, 'token')).rejects.toMatchObject({ reason: 'account_suspended' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps generic project-denial correction and successful SSE untouched', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const success = new PassThrough();
    const post = vi.spyOn(axios, 'post').mockRejectedValueOnce(denied(Readable.from(['Project quota not enabled'])))
      .mockResolvedValueOnce({ status: 200, data: success });
    expect(await new GeminiClient().streamGenerateInternal(body, 'token')).toBe(success);
    expect(post).toHaveBeenCalledTimes(2);
    expect(success.destroyed).toBe(false);
    success.destroy();
  });

  it('bounds rejected stream bytes and removes inspection listeners', async () => {
    const stream = Readable.from([Buffer.alloc(128 * 1024, 'a')]);
    const error = denied(stream);
    await inspectSuspensionResponse(error);
    expect((error.response?.data as Buffer).length).toBe(64 * 1024);
    expect(stream.destroyed).toBe(true);
    for (const event of ['data', 'end', 'close', 'error']) expect(stream.listenerCount(event)).toBe(0);
  });

  it('bounds stalled streams by deadline and preserves cancellation', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const error = denied(stream);
    const pending = inspectSuspensionResponse(error);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(stream.destroyed).toBe(true);
    expect((error.response?.data as Buffer).length).toBe(0);
    const abort = new AbortController();
    const second = new PassThrough();
    const rejected = inspectSuspensionResponse(denied(second), abort.signal).catch(value => value);
    abort.abort();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(second.destroyed).toBe(true);
  });

  it('does not consume unrelated error streams', async () => {
    const stream = new PassThrough();
    const error = denied(stream, 429);
    await inspectSuspensionResponse(error);
    expect(error.response?.data).toBe(stream);
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });

  it.each(['gemini-3.8-flash-high', 'gemini-image'])('persists suspension before terminal policy return for %s', async model => {
    const lease = { suspendAccount: vi.fn().mockResolvedValue(undefined), markAsForbidden: vi.fn(), recordParityError: vi.fn(),
      getNextToken: vi.fn(), markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn() };
    const policy = new ProxyRetryPolicy(lease, { log: vi.fn(), warn: vi.fn() });
    const error = new UpstreamRequestError({ status: 403, reason: 'account_suspended' });
    const state = policy.createTokenRetryState();
    expect(policy.shouldFailoverImmediately(error)).toBe(false);
    expect(await policy.applyUpstreamPenalty('first', model, error, state)).toBe(false);
    expect(lease.suspendAccount).toHaveBeenCalledExactlyOnceWith('first');
    expect(lease.markAsForbidden).not.toHaveBeenCalled();
    expect(state.migrationAuthorization).toBeUndefined();
    policy.disposeTokenRetryState(state);
  });

  it.each(['initial', 'stream-fallback'])('never selects a second account after suspended media %s', async failureMethod => {
    const account = { id: 'first', email: 'fixture@example.invalid', provider: 'google', created_at: 1, last_used: 1,
      token: { access_token: 'token', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: Date.now() / 1000 + 3600, project_id: 'project' } };
    const lease = { getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(2), getNextToken: vi.fn().mockResolvedValue(account),
      resolveDynamicModelForAccount: vi.fn((_id: string, model: string) => model), getModelOutputLimitForAccount: vi.fn(), getModelThinkingBudgetForAccount: vi.fn(),
      recordParityError: vi.fn(), markAsForbidden: vi.fn(), markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn(), suspendAccount: vi.fn().mockResolvedValue(undefined) };
    const error = new UpstreamRequestError({ status: 403, reason: 'account_suspended' });
    const client = { generateInternal: failureMethod === 'initial' ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue({ candidates: [] }),
      streamGenerateInternal: vi.fn().mockResolvedValue(Readable.from([Buffer.from('data: '+JSON.stringify({error:{code:403,message}})+'\n\n')])) };
    const service = new ProxyService(lease as never, client as never);
    await expect(service.handleGeminiGenerateContent(body.model, { contents: [{ role: 'user', parts: [{ text: 'Transcribe test audio' }] }] })).rejects.toMatchObject({ reason: 'account_suspended', status: 403 });
    expect(lease.getNextToken).toHaveBeenCalledTimes(1);
    expect(lease.suspendAccount).toHaveBeenCalledExactlyOnceWith('first');
    expect(client.generateInternal).toHaveBeenCalledTimes(1);
    expect(client.streamGenerateInternal).toHaveBeenCalledTimes(failureMethod === 'initial' ? 0 : 1);
  });
  it.each(['opening', 'sse'])('never falls back or reuses an account after chat stream %s suspension', async failureMethod => {
    const account = { id: 'first', email: 'fixture@example.invalid', provider: 'google', created_at: 1, last_used: 1,
      token: { access_token: 'token', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: Date.now() / 1000 + 3600, project_id: 'project' } };
    const lease = { getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(2), getNextToken: vi.fn().mockResolvedValue(account),
      resolveDynamicModelForAccount: vi.fn((_id: string, model: string) => model), getModelOutputLimitForAccount: vi.fn(), getModelThinkingBudgetForAccount: vi.fn(),
      recordParityError: vi.fn(), markAsForbidden: vi.fn(), markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn(), suspendAccount: vi.fn().mockResolvedValue(undefined) };
    const error = new UpstreamRequestError({ status: 403, reason: 'account_suspended' });
    const client = { streamGenerateInternal: failureMethod === 'opening' ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(Readable.from([Buffer.from('data: '+JSON.stringify({error:{code:403,message}})+'\n\n')])), generateInternal: vi.fn() };
    const service = new ProxyService(lease as never, client as never);
    const pending = service.handleChatCompletions({ model: body.model, stream: true, messages: [{ role: 'user', content: 'Transcribe audio fixture' }] });
    if (failureMethod === 'opening') await expect(pending).rejects.toMatchObject({ reason: 'account_suspended' });
    else {
      const result = await pending;
      expect(result).toHaveProperty('subscribe');
      await new Promise<void>((resolve, reject) => {
        (result as import('rxjs').Observable<string>).subscribe({ complete: () => reject(new Error('Stream must fail')), error: value => { expect(value.message).toBe('Upstream stream failed'); resolve(); } });
      });
      await vi.waitFor(() => expect(lease.suspendAccount).toHaveBeenCalledExactlyOnceWith('first'));
    }
    expect(lease.getNextToken).toHaveBeenCalledTimes(1);
    expect(lease.suspendAccount).toHaveBeenCalledExactlyOnceWith('first');
    expect(client.generateInternal).not.toHaveBeenCalled();
    expect(client.streamGenerateInternal).toHaveBeenCalledTimes(1);
  });

});
