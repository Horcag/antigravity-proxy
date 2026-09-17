import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import { extractSanitizedOperation } from '../../modules/proxy-gateway/server/cloudcode-diagnostics.js';
import { isReplaySafeOperation } from '../../modules/proxy-gateway/server/cloudcode-request-adapter.js';
import { evaluateRetryDecision } from '../../modules/proxy-gateway/server/upstream-retry-decision.js';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import type { CloudAccount } from '../../modules/cloud-account/types.js';

const READ_ONLY_RPCS = [
  ':loadCodeAssist',
  ':fetchAvailableModels',
  ':retrieveUserQuotaSummary',
  ':fetchCredits',
  ':listCloudAICompanionProjects',
  ':listModelConfigs',
  ':listExperiments',
  ':fetchCodeCustomizationState',
  ':fetchAdminControls',
  ':getCodeAssistGlobalUserSetting',
  ':loadModel',
];

function createMockStream(chunks: Array<string | Buffer> = ['{}']): any {
  const readable = Readable.from(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  return Object.assign(readable, { destroy: vi.fn() });
}

function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): any {
  const req = new EventEmitter() as any;
  req.method = options.method || 'POST';
  req.url = options.url || '/v1internal:loadCodeAssist';
  req.headers = options.headers || {
    host: 'daily-cloudcode-pa.googleapis.com',
    'content-type': 'application/json',
  };
  const bodyBuffer = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body || '', 'utf-8');
  req[Symbol.asyncIterator] = async function* () {
    if (bodyBuffer.length > 0) yield bodyBuffer;
  };
  return req;
}

function createMockResponse(): any {
  const res = new EventEmitter() as any;
  res.headers = {};
  res.body = '';
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = vi.fn((statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
    res.headersSent = true;
  });
  res.write = vi.fn((chunk) => {
    res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    return true;
  });
  res.end = vi.fn((chunk) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');
  });
  return res;
}

function createMockAccount(projectId: string): CloudAccount {
  return {
    id: 'acc-eligibility',
    provider: 'google',
    email: 'eligibility@test.local',
    token: {
      access_token: 'token-eligibility',
      refresh_token: 'refresh-eligibility',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: projectId,
    },
    created_at: Math.floor(Date.now() / 1000),
    last_used: Math.floor(Date.now() / 1000),
  };
}

describe('Cloud Code eligibility project-context repair', () => {
  let leaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    leaseService = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
      markAsForbidden: vi.fn(),
      markModelUnrequestable: vi.fn(),
      resolveDynamicModelForAccount: vi.fn((_accountId, model) => model),
    };
    gateway = new CloudCodeFailoverGateway(leaseService);
  });

  it('treats Cloud Code read-only POST RPCs as replay safe', () => {
    for (const rpc of READ_ONLY_RPCS) {
      expect(isReplaySafeOperation('POST', `/v1internal${rpc}`)).toBe(true);
    }
  });

  it('extracts loadCodeAssist as a sanitized diagnostics operation', () => {
    expect(extractSanitizedOperation('/v1internal:loadCodeAssist')).toBe('loadCodeAssist');
  });

  it('retries first project-context failure without quota header, then migrates or commits terminally', () => {
    const evidence = classifyUpstreamFailure({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      errorText: 'Cloud Code Private API has not been used in project amiable-energy-3gh3w before or it is disabled.',
      urlPath: '/v1internal:loadCodeAssist',
      source: 'json',
    });
    expect(evidence.category).toBe('project-context');

    expect(evaluateRetryDecision({
      evidence,
      attempt: 1,
      maxAttempts: 5,
      downstreamCommitted: false,
      isReplaySafe: true,
      ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 0,
      quotaHeaderMode: 'with-quota-header',
      hasAlternativeAccounts: false,
    })).toEqual({
      action: { kind: 'retry-same-account', repair: 'project-context' },
      healthEffect: { kind: 'none' },
    });

    expect(evaluateRetryDecision({
      evidence,
      attempt: 2,
      maxAttempts: 5,
      downstreamCommitted: false,
      isReplaySafe: true,
      ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 1,
      quotaHeaderMode: 'without-quota-header',
      hasAlternativeAccounts: true,
    })).toEqual({
      action: { kind: 'migrate-account', reason: 'project-rejected' },
      healthEffect: { kind: 'project-capability-rejected' },
    });

    expect(evaluateRetryDecision({
      evidence,
      attempt: 2,
      maxAttempts: 5,
      downstreamCommitted: false,
      isReplaySafe: true,
      ambiguityProbesUsed: 0,
      projectCorrectionsUsed: 1,
      quotaHeaderMode: 'without-quota-header',
      hasAlternativeAccounts: false,
    })).toEqual({
      action: { kind: 'commit-error' },
      healthEffect: { kind: 'project-capability-rejected' },
    });
  });

  it('repairs loadCodeAssist by suppressing the first 403 and retrying same account without x-goog-user-project', async () => {
    const account = createMockAccount('disabled-proj');
    const calls: Array<{ headers: Record<string, string>; body: Buffer }> = [];
    leaseService.getNextToken.mockResolvedValue(account);
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async (...args: any[]) => {
      const headers = (args[2] || {}) as Record<string, string>;
      const body = args[3] as Buffer;
      calls.push({ headers, body });
      if (calls.length === 1) {
        return {
          statusCode: 403,
          headers: { 'content-type': 'application/json' },
          bufferedBody: Buffer.from(JSON.stringify({
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: 'Cloud Code Private API has not been used in project disabled-proj before or it is disabled.',
            },
          })),
          bodyStream: createMockStream(),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bufferedBody: Buffer.from('{"userTier":"PAID"}'),
        bodyStream: createMockStream(['{"userTier":"PAID"}']),
      };
    });

    const req = createMockRequest({
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'content-type': 'application/json',
        'x-goog-user-project': 'disabled-proj',
      },
      body: JSON.stringify({ metadata: { ide: 'antigravity' } }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(calls).toHaveLength(2);
    expect(calls[0].headers['x-goog-user-project']).toBe('disabled-proj');
    expect(calls[1].headers['x-goog-user-project']).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"userTier":"PAID"');
    expect(res.body).not.toContain('PERMISSION_DENIED');
    expect(leaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(leaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });
});
