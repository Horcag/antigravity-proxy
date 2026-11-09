import { Readable } from 'node:stream';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { ProxyRetryPolicy } from '@/modules/proxy-gateway/server/proxy-retry-policy';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/clients/upstream-error';

const payload = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'violation of Terms of Service', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TOS_VIOLATION' }] } };

afterEach(() => vi.restoreAllMocks());

describe('API TOS fail closed', () => {
  it.each(['json', 'stream'] as const)('preserves TOS classification for %s errors and avoids project/endpoint replay', async (format) => {
    const error = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, headers: {}, data: format === 'stream' ? Readable.from([JSON.stringify(payload)]) : payload },
    });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(error);
    const client = new GeminiClient();
    await expect(client.generateInternal({ project: 'test-project', model: 'gemini-3-flash', request: { contents: [] } } as any, 'test-token')).rejects.toMatchObject({ status: 403, reason: 'tos_violation' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rejects the credential without authorizing pool migration or immediate failover', async () => {
    const service = { getNextToken: vi.fn(), recordParityError: vi.fn(), markAsForbidden: vi.fn(), markAsRateLimited: vi.fn(), markFromUpstreamError: vi.fn() };
    const policy = new ProxyRetryPolicy(service, { log: vi.fn(), warn: vi.fn() });
    const state = policy.createTokenRetryState();
    const error = new UpstreamRequestError({ status: 403, reason: 'tos_violation' });
    expect(policy.shouldFailoverImmediately(error)).toBe(false);
    expect(await policy.applyUpstreamPenalty('rejected-account', 'gemini-3-flash', error, state)).toBe(false);
    expect(state.migrationAuthorization).toBeUndefined();
    expect(service.markAsForbidden).toHaveBeenCalledWith('rejected-account', 'tos_violation');
    expect(policy.shouldFailoverImmediately(new UpstreamRequestError({ status: 403, reason: 'authentication' }))).toBe(true);
    expect(policy.shouldFailoverImmediately(new UpstreamRequestError({ status: 429, reason: 'quota_exhausted' }))).toBe(true);
    policy.disposeTokenRetryState(state);
  });
});
