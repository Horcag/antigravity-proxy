import axios from 'axios';
import { PassThrough, Readable } from 'node:stream';
import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';
import { classifyUpstreamFailure } from '@/modules/proxy-gateway/server/upstream-failure';
import { getServerConfig, setServerConfig } from '@/server/server-config';

const originalConfig = getServerConfig();
const message = 'This service has been disabled in this account for violation of Terms of Service.';
const candidate = { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] };
function payload(details: unknown[] = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TOS_VIOLATION' }]) {
  return { error: { code: 403, status: 'PERMISSION_DENIED', message, details } };
}
function rejected(data: unknown) {
  return Object.assign(new Error('private-upstream-canary'), { isAxiosError: true, response: { status: 403, headers: {}, data } });
}
function setup(client = new GeminiClient()) {
  const accounts = ['first', 'second'].map((id) => ({ id, provider: 'google', email: `${id}@example.test`, created_at: 1, last_used: 1,
    token: { access_token: `fixture-${id}`, refresh_token: 'fixture', token_type: 'Bearer', expires_in: 3600, expiry_timestamp: 9999999999, project_id: `project-${id}` } }));
  const leases = {
    getModelCapableAccountCount: vi.fn().mockReturnValue(2), getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(2),
    getNextToken: vi.fn(async (options?: { excludeAccountIds?: string[] }) => accounts.find((row) => !options?.excludeAccountIds?.includes(row.id)) ?? null),
    resolveDynamicModelForAccount: vi.fn((_id: string, model: string) => model), getModelOutputLimitForAccount: vi.fn(), getModelThinkingBudgetForAccount: vi.fn(),
    recordParityError: vi.fn(), markAsForbidden: vi.fn(), markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn(), markModelSuccess: vi.fn(), markModelUnrequestable: vi.fn(),
  };
  const service = new ProxyService(leases as never, client);
  vi.spyOn((service as any).retryPolicy, 'waitBeforeRetry').mockResolvedValue(undefined);
  return { service, leases, client };
}
const chat = { model: 'gemini-3-flash', messages: [{ role: 'user' as const, content: 'hello' }], stream: true };
async function consume(result: unknown) {
  if (!(result instanceof Observable)) throw new Error('Expected stream');
  return new Promise<void>((resolve, reject) => result.subscribe({ error: reject, complete: resolve }));
}
afterEach(() => { vi.restoreAllMocks(); setServerConfig(originalConfig); });

describe('ProxyService precise ToS fallback protection', () => {
  it.each(['json', 'rejected-stream', 'image'] as const)('stops the real client/proxy %s path after one upstream call', async (format) => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(rejected(format === 'rejected-stream' ? Readable.from([JSON.stringify(payload())]) : payload()));
    const { service, leases, client } = setup();
    const nonstream = vi.spyOn(client, 'generateInternal');
    const request = format === 'image' ? { ...chat, model: 'gemini-3-pro-image' } : chat;
    await expect(service.handleChatCompletions(request)).rejects.toMatchObject({ status: 403, reason: 'tos_violation' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(nonstream).not.toHaveBeenCalled();
    expect(leases.getNextToken).toHaveBeenCalledTimes(1);
    expect(leases.markAsForbidden).toHaveBeenCalledWith('first', 'tos_violation');
  });

  it('does not replay a successful HTTP envelope carrying an explicit ToS error through stream aggregation', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: payload(), headers: {} });
    const { service, leases, client } = setup();
    const stream = vi.spyOn(client, 'streamGenerateInternal');
    await expect(service.handleChatCompletions({ ...chat, stream: false })).rejects.toMatchObject({ status: 403, reason: 'tos_violation' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
    expect(leases.getNextToken).toHaveBeenCalledTimes(1);
    expect(leases.markAsForbidden).toHaveBeenCalledWith('first', 'tos_violation');
  });

  it('preserves Google ErrorInfo ToS classification in an embedded SSE failure through stream health', async () => {
    const bytes = `data: ${JSON.stringify(payload())}\n\n`;
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: Readable.from([Buffer.from(bytes)]), headers: {} });
    const { service, leases } = setup();
    const result = await service.handleChatCompletions(chat);
    await expect(consume(result)).rejects.toMatchObject({ message: 'Upstream stream failed' });
    await vi.waitFor(() => expect(leases.markAsForbidden).toHaveBeenCalledWith('first', 'tos_violation'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(leases.getNextToken).toHaveBeenCalledTimes(1);
  });

  it('rotates accounts on transient failure without replaying nonstream', async () => {
    const client = new GeminiClient();
    const stream = vi.spyOn(client, 'streamGenerateInternal').mockRejectedValueOnce(new UpstreamRequestError({ status: 503 })).mockResolvedValueOnce(Readable.from([Buffer.from(`data: ${JSON.stringify(candidate)}\n\n`)]));
    const direct = vi.spyOn(client, 'generateInternal').mockResolvedValue(candidate);
    const { service, leases } = setup(client);
    await consume(await service.handleChatCompletions(chat));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(direct).not.toHaveBeenCalled();
    expect(leases.getNextToken).toHaveBeenCalledTimes(2);
    expect(leases.markAsForbidden).not.toHaveBeenCalled();
  });

  it('does not invent a projectless retry after ordinary project-context rejection', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(rejected({ error: { code: 403, message: 'Permission to use this quota project denied' } }));
    const body = { project: 'native-project', model: 'gemini-3-flash', request: { contents: [] } } as never;
    await expect(new GeminiClient().streamGenerateInternal(body, 'fixture')).rejects.toMatchObject({ status: 403, reason: 'authentication' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2]?.headers).not.toHaveProperty('x-goog-user-project');
    expect(JSON.parse(post.mock.calls[0][1] as string).project).toBe('native-project');
  });

  it('returns cancellation during rejected 403 body inspection without fallback or penalty', async () => {
    const controller = new AbortController();
    const body = new PassThrough(); body.write(JSON.stringify(payload()));
    const post = vi.spyOn(axios, 'post').mockRejectedValue(rejected(body));
    const { service, leases } = setup();
    const pending = service.handleChatCompletions(chat, undefined, undefined, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(body.listenerCount('readable')).toBeGreaterThan(0));
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(leases.markAsForbidden).not.toHaveBeenCalled();
    expect(leases.markFromUpstreamError).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
  });
});

describe('explicit ToS evidence precedence', () => {
  it.each([
    [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'serviceusage.googleapis.com' }],
    [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ subject: 'quota-project' }] }],
  ])('keeps explicit suspension terminal despite other AIP-193 details', (details) => {
    expect(classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: JSON.stringify(payload([details])) })).toMatchObject({ ruleId: 'google.tos.violation', isQuota: false });
  });

  it.each(['Permission denied; consult Terms of Service', 'A violation of Terms of Service is described in the documentation', 'User location is not supported'])('does not classify an ordinary 403 as suspension: %s', (text) => {
    expect(classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: text }).ruleId).not.toBe('google.tos.violation');
  });
});
