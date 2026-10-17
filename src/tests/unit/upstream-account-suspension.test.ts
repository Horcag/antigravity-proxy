import { describe, expect, it } from 'vitest';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { isAccountSuspended } from '../../modules/proxy-gateway/server/account-suspension.js';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import { evaluateRetryDecision } from '../../modules/proxy-gateway/server/upstream-retry-decision.js';

const message = 'This service has been disabled in this account for violation of Terms of Service';
const json = (code: number, text = message, details: unknown[] = []) => JSON.stringify({
  error: { code, message: text, status: 'PERMISSION_DENIED', details },
});
const projectDetail = { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'serviceusage.googleapis.com' };

describe('explicit account suspension classification', () => {
  it.each([
    ['plain response', message],
    ['case and whitespace', message.toUpperCase().replaceAll(' ', '\n\t ')],
    ['JSON escaped whitespace', json(403, message.replaceAll(' ', '\n\t '))],
  ])('recognizes normalized phrase in %s', (_name, text) => {
    const evidence = classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: text });
    expect(evidence).toMatchObject({ category: 'account-suspended', confidence: 'explicit', httpStatus: 403,
      rpcStatus: 'PERMISSION_DENIED', isQuota: false, ruleId: 'google.account.suspended' });
    expect(evidence.safeMessage).not.toContain(message);
  });

  it.each([
    ['identity', (value: Buffer) => value],
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('recognizes bounded %s error bodies', (encoding, compress) => {
    const evidence = classifyUpstreamFailure({ statusCode: 403, headers: { 'content-encoding': encoding }, bufferedBody: compress(Buffer.from(json(403))) });
    expect(evidence.category).toBe('account-suspended');
  });

  it.each([403, 7])('recognizes embedded denial code %i on HTTP 200', code => {
    const evidence = classifyUpstreamFailure({ statusCode: 200, headers: {}, errorText: json(code), source: 'json' });
    expect(evidence).toMatchObject({ category: 'account-suspended', httpStatus: 403 });
  });

  it('recognizes gRPC7 with percent-encoded grpc-message', () => {
    const evidence = classifyUpstreamFailure({ statusCode: 200,
      headers: { 'grpc-status': '7', 'grpc-message': encodeURIComponent(message) }, source: 'grpc' });
    expect(evidence).toMatchObject({ category: 'account-suspended', source: 'grpc', httpStatus: 403 });
  });

  it.each([
    ['project SERVICE_DISABLED', [projectDetail]],
    ['quota failure', [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{}] }]],
    ['bad request', [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{}] }]],
  ])('takes priority over %s evidence', (_name, details) => {
    const evidence = classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: json(403, message, details) });
    expect(evidence.category).toBe('account-suspended');
  });

  it('takes priority over project evidence on gRPC7', () => {
    const evidence = classifyUpstreamFailure({ statusCode: 200, headers: { 'grpc-status': '7' },
      errorText: json(403, message, [projectDetail]) });
    expect(evidence.category).toBe('account-suspended');
  });

  it.each([
    ['generic403', 403, 'Forbidden'],
    ['API not enabled', 403, json(403, 'This API has not been enabled for the consumer project', [projectDetail])],
    ['HTTP200 quoted input', 200, `Input quotes: ${message}`],
    ['HTTP400 quoted input', 400, `Input quotes: ${message}`],
    ['HTTP429', 429, message],
    ['HTTP503', 503, message],
    ['different disabled service', 403, 'This service has been disabled in this project'],
  ] as const)('does not suspend for %s', (_name, statusCode, errorText) => {
    const evidence = classifyUpstreamFailure({ statusCode, headers: {}, errorText });
    expect(evidence.category).not.toBe('account-suspended');
  });

  it('preserves project recovery for API-not-enabled and permission denial for generic403', () => {
    expect(classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: json(403, 'API not enabled', [projectDetail]) }).category).toBe('project-context');
    expect(classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: 'Forbidden' }).category).toBe('permission-denied');
  });

  it('bounds helper inspection and requires effective403', () => {
    expect(isAccountSuspended(403, message)).toBe(true);
    expect(isAccountSuspended(undefined, message)).toBe(false);
    expect(isAccountSuspended(7, message)).toBe(false);
    expect(isAccountSuspended(403, ' '.repeat(64 * 1024) + message)).toBe(false);
  });
});

describe('account suspension is terminal across retry budgets', () => {
  const evidence = classifyUpstreamFailure({ statusCode: 403, headers: {}, errorText: json(403, message, [projectDetail]) });
  for (const downstreamCommitted of [false, true]) {
    for (const attempt of [1, 5]) {
      for (const isReplaySafe of [false, true]) {
        for (const hasAlternativeAccounts of [false, true]) {
          it(`committed=${downstreamCommitted} attempt=${attempt} replay=${isReplaySafe} alternatives=${hasAlternativeAccounts}`, () => {
            expect(evaluateRetryDecision({ evidence, downstreamCommitted, attempt, maxAttempts: 5,
              isReplaySafe, hasAlternativeAccounts, projectCorrectionsUsed: 0, maxProjectCorrections: 8,
              ambiguityProbesUsed: 0, maxAmbiguityProbes: 8, transientRetriesUsed: 0, maxTransientRetries: 8,
              quotaHeaderMode: 'with-quota-header' })).toEqual({ action: { kind: 'commit-error' },
              healthEffect: { kind: downstreamCommitted ? 'none' : 'credential-rejected' } });
          });
        }
      }
    }
  }
});
