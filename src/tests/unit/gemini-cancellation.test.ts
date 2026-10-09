import { Logger } from '@nestjs/common';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { ProxyRetryPolicy } from '@/modules/proxy-gateway/server/proxy-retry-policy';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

function createInternalRequest(params?: Partial<GeminiInternalRequest>): GeminiInternalRequest {
  return {
    project: '', requestId: 'req-test', model: 'gemini-3-flash', userAgent: 'test-agent',
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    ...params,
  };
}

function createAxiosError(status: number, message: string) {
  return new axios.AxiosError(message, undefined, undefined, undefined, {
    status, statusText: String(status), headers: {},
    config: { headers: new axios.AxiosHeaders() },
    data: { error: { message } },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Cancellation preserves identity without upstream diagnostics', () => {
  it('does not fall back to non-stream generation after OpenAI streaming is aborted', async () => {
    const aborted = new Error('Upstream request canceled');
    aborted.name = 'AbortError';
    const releaseReservation = vi.fn();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const selectedAccount = {
      releaseReservation,
      id: 'account-test', provider: 'google', email: 'account@example.com',
      token: {
        access_token: 'test-token', refresh_token: 'test-refresh', token_type: 'Bearer',
        expires_in: 3600, expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        project_id: 'test-project',
      },
      created_at: 1, last_used: 1,
    };
    const lease = {
      getRefreshedModelCapableAccountCount: vi.fn().mockResolvedValue(1),
      getNextToken: vi.fn().mockResolvedValue(selectedAccount),
      resolveDynamicModelForAccount: vi.fn((_accountId: string, model: string) => model),
      getModelOutputLimitForAccount: vi.fn(), getModelThinkingBudgetForAccount: vi.fn(),
      recordParityError: vi.fn(), markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
      recordPerformanceFailure: vi.fn(),
    };
    const client = {
      streamGenerateInternal: vi.fn().mockRejectedValue(aborted),
      generateInternal: vi.fn(),
    };
    const service = new ProxyService(lease as never, client as never);

    await expect(service.handleChatCompletions({
      model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], stream: true,
    })).rejects.toBe(aborted);
    expect(client.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(client.generateInternal).not.toHaveBeenCalled();
    expect(lease.recordPerformanceFailure).not.toHaveBeenCalled();
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(lease.recordParityError).not.toHaveBeenCalled();
    expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['generateInternal', 'streamGenerateInternal', 'generate', 'streamGenerate'] as const)(
    '%s stops after cancellation and returns a safe AbortError',
    async (operation) => {
      const client = new GeminiClient();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const canceled = new axios.CanceledError('secret-upstream-diagnostic', {
        headers: new axios.AxiosHeaders({ Authorization: 'Bearer secret-access-token' }),
      });
      const post = vi.spyOn(axios, 'post').mockRejectedValue(canceled);
      const signal = new AbortController().signal;
      const request = operation === 'generateInternal' || operation === 'streamGenerateInternal'
        ? client[operation](createInternalRequest(), 'token-1', undefined, undefined, 'acc-1', signal)
        : client[operation]('test-model', { contents: [] }, 'token-1', undefined, signal);

      const error = await request.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: 'AbortError', message: 'Upstream request canceled' });
      expect(error).not.toBe(canceled);
      expect(post).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
      expect(log.mock.calls.map(([message]) => message).join('\n')).not.toContain('"event":"failure"');
      const diagnostic = JSON.stringify(error) + String((error as Error).stack);
      expect(diagnostic).not.toContain('secret-upstream-diagnostic');
      expect(diagnostic).not.toContain('secret-access-token');
      expect(error).not.toHaveProperty('config');
      expect(error).not.toHaveProperty('cause');
    },
  );

  it('cleans cancellation reservations and renewal without failing a migration candidate', async () => {
    vi.useFakeTimers();
    const lease = {
      getNextToken: vi.fn(), recordParityError: vi.fn(), markAsForbidden: vi.fn(),
      markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn(),
      failSessionMigrationCandidate: vi.fn(), abortSessionMigration: vi.fn(),
      renewSessionMigration: vi.fn().mockReturnValue(true),
    };
    const logger = { log: vi.fn(), warn: vi.fn() };
    const policy = new ProxyRetryPolicy(lease, logger);
    const state = policy.createTokenRetryState();
    const release = vi.fn();
    const placement = vi.fn();
    state.activeReservation = release;
    state.completeAffinityPlacement = placement;
    state.migrationCapability = {
      sessionKey: 'session-test', generation: 1, tableIncarnation: 1,
      ownerRequestId: state.requestId, targetAccountId: 'account-test',
    };
    policy.startMigrationRenewal(state, 'session-test');
    const canceled = new Error('Upstream request canceled');
    canceled.name = 'AbortError';
    try {
      await expect(policy.applyUpstreamPenalty('account-test', 'gemini-3-flash', canceled, state))
        .resolves.toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      expect(placement).toHaveBeenCalledExactlyOnceWith('aborted');
      expect(state.migrationRenewalTimer).toBeUndefined();
      expect(lease.failSessionMigrationCandidate).not.toHaveBeenCalled();
      expect(lease.recordParityError).not.toHaveBeenCalled();
      expect(lease.markAsForbidden).not.toHaveBeenCalled();
      expect(lease.markAsRateLimited).not.toHaveBeenCalled();
      expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40000);
      expect(lease.renewSessionMigration).not.toHaveBeenCalled();
    } finally {
      policy.disposeTokenRetryState(state);
      vi.useRealTimers();
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(placement).toHaveBeenCalledTimes(1);
    expect(lease.abortSessionMigration).toHaveBeenCalledTimes(1);
  });

  it('does not retry project context after the request signal is aborted', async () => {
    const client = new GeminiClient();
    const controller = new AbortController();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      controller.abort();
      throw createAxiosError(403, 'Permission denied');
    });

    await expect(client.generateInternal(
      createInternalRequest({ project: 'project-1' }),
      'token-1', undefined, undefined, 'acc-1', controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(client.userProjectCapabilityCache.getSnapshot()).toEqual([]);
  });
});
