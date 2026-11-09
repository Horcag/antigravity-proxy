import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway.js';
import { extractSanitizedOperation } from '../../modules/proxy-gateway/server/cloudcode-diagnostics.js';
import { isReplaySafeOperation } from '../../modules/proxy-gateway/server/cloudcode-request-adapter.js';
import { evaluateRetryDecision } from '../../modules/proxy-gateway/server/upstream-retry-decision.js';
import { classifyUpstreamFailure } from '../../modules/proxy-gateway/server/upstream-failure.js';
import * as nativeControl from '../../modules/proxy-gateway/server/native-control-plane.js';

const READ_ONLY_RPCS = [
  ':loadCodeAssist',
  ':fetchUserInfo',
  ':fetchAvailableModels',
  ':retrieveUserQuota',
  ':retrieveUserQuotaSummary',
  ':fetchLicenses',
  ':fetchCredits',
  ':listAgents',
  ':listInstances',
  ':listAuthorizedDevices',
  ':listRemoteRepositories',
  ':listCloudAICompanionProjects',
  ':listModelConfigs',
  ':listExperiments',
  ':fetchCodeCustomizationState',
  ':fetchAdminControls',
  ':getCodeAssistGlobalUserSetting',
  ':loadModel',
  ':fetchQuotaStatus',
  ':fetchConfig',
  ':fetchFromTrawlerCache',
];

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

describe('Cloud Code eligibility project-context handling', () => {
  afterEach(() => vi.restoreAllMocks());
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

  it('extracts read-only RPCs as sanitized diagnostics operations', () => {
    for (const rpc of READ_ONLY_RPCS) {
      expect(extractSanitizedOperation(`/v1internal${rpc}`)).toBe(rpc.slice(1));
    }
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

  it('returns fetchUserInfo project rejection without modifying native request context', async () => {
    const calls: Array<{ headers: Record<string, string>; body: Buffer }> = [];
    const managedTransport = vi.spyOn(gateway as any, 'executeUpstreamCall');
    vi.spyOn(nativeControl, 'forwardNativeControlPlane').mockImplementation(async (req, res, host, urlPath) => {
      expect(host).toBe('daily-cloudcode-pa.googleapis.com');
      expect(urlPath).toBe('/v1internal:fetchUserInfo');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) });
      (res as http.ServerResponse).writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Original caller project rejected' } }));
    });

    const req = createMockRequest({
      url: '/v1internal:fetchUserInfo',
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'content-type': 'application/json',
        'x-goog-user-project': 'disabled-proj',
      },
      body: JSON.stringify({ metadata: { ide: 'antigravity' } }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(calls).toHaveLength(1);
    expect(managedTransport).not.toHaveBeenCalled();
    expect(leaseService.getNextToken).not.toHaveBeenCalled();
    expect(calls[0].headers['x-goog-user-project']).toBe('disabled-proj');
    expect(calls[0].body.equals(Buffer.from(JSON.stringify({ metadata: { ide: 'antigravity' } })))).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('PERMISSION_DENIED');
    expect(leaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(leaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });
});
