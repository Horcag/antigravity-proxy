import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { AccountLeaseSelectionPolicy } from '../../modules/proxy-gateway/server/account-lease-selection-policy';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { CloudAccount } from '../../modules/cloud-account/types';

function createMockStream(chunks: Array<string | Buffer> = ['{"candidates":[]}']): any {
  const readable = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
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
  req.url = options.url || '/v1internal:streamGenerateContent';
  req.headers = options.headers || {
    host: 'daily-cloudcode-pa.googleapis.com',
    'content-type': 'application/json',
  };

  const bodyBuffer = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body || '', 'utf-8');

  req[Symbol.asyncIterator] = async function* () {
    if (bodyBuffer.length > 0) {
      yield bodyBuffer;
    }
  };

  return req;
}

function createMockResponse(): any {
  const res = new EventEmitter() as any;
  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = vi.fn((statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
    res.headersSent = true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');
  });
  res.write = vi.fn(() => true);
  return res;
}

function createMockAccount(id: string, email: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email,
    token: {
      access_token: `token-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: `project-${id}`,
    },
    created_at: Math.floor(Date.now() / 1000),
    last_used: Math.floor(Date.now() / 1000),
  };
}

describe('CloudCodeFailoverGateway session stickiness and failover', () => {
  let mockAccountLeaseService: any;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    mockAccountLeaseService = {
      getNextToken: vi.fn(),
      bindSession: vi.fn(),
      markFromUpstreamError: vi.fn(),
    };
    gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);
  });

  it('extracts explicit session key from request headers', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(),
    });

    const req = createMockRequest({
      headers: {
        'x-session-id': 'session-custom-123',
        host: 'daily-cloudcode-pa.googleapis.com',
      },
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'session:session-custom-123',
      }),
    );
    expect(mockAccountLeaseService.bindSession).toHaveBeenCalledWith(
      'session:session-custom-123',
      'acc-1',
      undefined,
      1,
    );
  });

  it('extracts session key from JSON body metadata', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(),
    });

    const req = createMockRequest({
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        metadata: { conversationId: 'conv-abc-789' },
      }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'session:conv-abc-789',
      }),
    );
  });

  it('computes deterministic prefix fingerprint for multi-turn conversations', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream(),
    }));

    // Turn 1
    const turn1Body = {
      model: 'gemini-2.5-pro',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Please write a rust CLI' }] }],
      },
    };
    const req1 = createMockRequest({ body: JSON.stringify(turn1Body) });
    const res1 = createMockResponse();
    await gateway.handleRequest(req1, res1);

    const turn1SessionKey = mockAccountLeaseService.getNextToken.mock.calls[0][0].sessionKey;
    expect(turn1SessionKey).toMatch(/^hint:prefix:[a-f0-9]{16}$/);

    // Turn 2 (contains turn 1 history + assistant reply + new prompt)
    const turn2Body = {
      model: 'gemini-2.5-pro',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'Please write a rust CLI' }] },
          { role: 'model', parts: [{ text: 'Sure, here is the code...' }] },
          { role: 'user', parts: [{ text: 'Now add clap argument parsing' }] },
        ],
      },
    };
    const req2 = createMockRequest({ body: JSON.stringify(turn2Body) });
    const res2 = createMockResponse();
    await gateway.handleRequest(req2, res2);

    const turn2SessionKey = mockAccountLeaseService.getNextToken.mock.calls[1][0].sessionKey;
    // Turn 2 MUST have the exact same sessionKey as Turn 1 to hit prompt cache!
    expect(turn2SessionKey).toBe(turn1SessionKey);
  });

  it('rebinds session to the new account on 429 in-flight failover', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');

    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(account2);

    vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValueOnce({
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream(['{"error": {"message": "Quota exhausted"}}']),
        bufferedBody: Buffer.from(JSON.stringify({ error: { message: 'Quota exhausted' } })),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream(['{"candidates": []}']),
      });

    const req = createMockRequest({
      headers: { 'x-session-id': 'session-failover-test' },
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdOrEmail: 'acc-1',
        status: 429,
        model: 'gemini-2.5-pro',
      }),
    );

    // Verify failover called getNextToken excluding acc-1
    expect(mockAccountLeaseService.getNextToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        excludeAccountIds: ['acc-1'],
        sessionKey: 'session:session-failover-test',
      }),
    );

    // Verify session was rebound to acc-2 upon successful commit!
    expect(mockAccountLeaseService.bindSession).toHaveBeenCalledWith(
      'session:session-failover-test',
      'acc-2',
      undefined,
      1,
    );
  });

  it('does not falsely classify valid tool calls containing "error": "429" as quota errors (T10-F04, Probe C12)', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    const validToolGeneration = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'record_http_result',
                  args: { error: '429', status: 'RESOURCE_EXHAUSTED' },
                },
              },
            ],
          },
        },
      ],
    });

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: createMockStream([validToolGeneration]),
    });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    // Must NOT mark account as rate limited
    expect(mockAccountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });

  it('detects terminal gRPC status 8 in trailers when stream is empty and rotates account (T10-F04, Probe C14)', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    const account2 = createMockAccount('acc-2', 'acc2@test.com');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(account1)
      .mockResolvedValueOnce(account2);

    const emptyStreamWithTrailers: any = Readable.from([]);
    emptyStreamWithTrailers.trailers = { 'grpc-status': '8', 'grpc-message': 'Quota exceeded' };
    emptyStreamWithTrailers.destroy = vi.fn();

    vi.spyOn(gateway as any, 'executeUpstreamCall')
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/grpc-web+proto' },
        bodyStream: emptyStreamWithTrailers,
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream(['{"candidates": []}']),
      });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdOrEmail: 'acc-1',
        status: 429,
        reason: 'quota_exhausted',
      }),
    );
    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
  });

  it('forwards trailers to downstream response before concluding (T10-F05, Probe C15)', async () => {
    const account1 = createMockAccount('acc-1', 'acc1@test.com');
    mockAccountLeaseService.getNextToken.mockResolvedValue(account1);

    const streamWithTrailers: any = createMockStream(['{"candidates": []}']);
    streamWithTrailers.trailers = { 'grpc-status': '0', 'grpc-message': 'OK' };

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      bodyStream: streamWithTrailers,
    });

    const req = createMockRequest({
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    const res = createMockResponse();
    res.addTrailers = vi.fn();

    await gateway.handleRequest(req, res);

    expect(res.addTrailers).toHaveBeenCalledWith(
      expect.objectContaining({ 'grpc-status': '0', 'grpc-message': 'OK' }),
    );
    expect(res.end).toHaveBeenCalled();
  });
});

describe('AccountLeaseSelectionPolicy session affinity and parallel session distribution', () => {
  it('distributes parallel sessions across distinct accounts and preserves stickiness', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const candidateAccounts: Array<[string, any]> = [
      ['acc-1', { email: 'acc1@test.dev' }],
      ['acc-2', { email: 'acc2@test.dev' }],
      ['acc-3', { email: 'acc3@test.dev' }],
    ];

    const makeRequest = (sessionKey: string) => ({
      allTokens: candidateAccounts,
      sessionKey,
      model: 'gemini-2.5-pro',
      now: Date.now(),
      accountCooldowns: new Map(),
      rateLimitTracker: {
        cleanupExpired: () => undefined,
        isRateLimited: () => false,
        getRemainingWaitSeconds: () => 0,
      } as any,
      config: {
        parityEnabled: true,
        parityShadowEnabled: false,
        schedulingMode: 'cache-first' as const,
        maxWaitMs: 2000,
        noGoMismatchRateThreshold: 0.15,
        noGoErrorRateThreshold: 0.4,
      },
      logger: { warn: () => undefined, error: () => undefined } as any,
    });

    // Session A Turn 1 -> allocated to acc-1
    const pickA1 = await policy.selectCandidate(makeRequest('session-A'));
    expect(pickA1?.[0]).toBe('acc-1');
    policy.bindSession('session-A', 'acc-1', Date.now() + 3600000);

    // Session A Turn 2 -> stays on acc-1 (prompt cache hit!)
    const pickA2 = await policy.selectCandidate(makeRequest('session-A'));
    expect(pickA2?.[0]).toBe('acc-1');

    // Session B Turn 1 (parallel session arrives while Session A is on acc-1)
    // acc-1 has 1 active session; acc-2 and acc-3 have 0 active sessions.
    // Balancer chooses an idle account (acc-3 or acc-2), never hammering acc-1!
    const pickB1 = await policy.selectCandidate(makeRequest('session-B'));
    expect(pickB1?.[0]).not.toBe('acc-1');
    const assignedB = pickB1?.[0] as string;
    policy.bindSession('session-B', assignedB, Date.now() + 3600000);

    // Session B Turn 2 -> stays on assignedB!
    const pickB2 = await policy.selectCandidate(makeRequest('session-B'));
    expect(pickB2?.[0]).toBe(assignedB);

    // Session C Turn 1 (third parallel session arrives)
    // acc-1 and assignedB are busy; the third account is chosen!
    const pickC1 = await policy.selectCandidate(makeRequest('session-C'));
    expect(pickC1?.[0]).not.toBe('acc-1');
    expect(pickC1?.[0]).not.toBe(assignedB);
    const assignedC = pickC1?.[0] as string;
    policy.bindSession('session-C', assignedC, Date.now() + 3600000);

    // Subsequent turns of all 3 sessions stay on their respective accounts:
    const pickA3 = await policy.selectCandidate(makeRequest('session-A'));
    expect(pickA3?.[0]).toBe('acc-1');

    const pickB3 = await policy.selectCandidate(makeRequest('session-B'));
    expect(pickB3?.[0]).toBe(assignedB);

    const pickC2 = await policy.selectCandidate(makeRequest('session-C'));
    expect(pickC2?.[0]).toBe(assignedC);
  });

  it('distributes concurrent requests taking in-flight reservations into account', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const candidateAccounts: Array<[string, any]> = [
      ['acc-1', { email: 'acc1@test.dev' }],
      ['acc-2', { email: 'acc2@test.dev' }],
    ];

    const inFlightMap = new Map<string, number>();

    const makeRequest = () => ({
      allTokens: candidateAccounts,
      model: 'gemini-2.5-pro',
      now: Date.now(),
      accountCooldowns: new Map(),
      rateLimitTracker: {
        cleanupExpired: () => undefined,
        isRateLimited: () => false,
        getRemainingWaitSeconds: () => 0,
      } as any,
      getInFlightCount: (id: string) => inFlightMap.get(id) ?? 0,
      config: {
        parityEnabled: true,
        parityShadowEnabled: false,
        schedulingMode: 'cache-first' as const,
        maxWaitMs: 2000,
        noGoMismatchRateThreshold: 0.15,
        noGoErrorRateThreshold: 0.4,
      },
      logger: { warn: () => undefined, error: () => undefined } as any,
    });

    // Request 1 arrives: selects acc-1 and increments in-flight
    const pick1 = await policy.selectCandidate(makeRequest());
    expect(pick1?.[0]).toBe('acc-1');
    inFlightMap.set('acc-1', 1);

    // Request 2 arrives concurrently while Request 1 is in-flight:
    // acc-1 has inFlight=1, acc-2 has inFlight=0 -> picks acc-2!
    const pick2 = await policy.selectCandidate(makeRequest());
    expect(pick2?.[0]).toBe('acc-2');
    inFlightMap.set('acc-2', 1);

    inFlightMap.set('acc-1', 0);
    const pick3 = await policy.selectCandidate(makeRequest());
    expect(pick3?.[0]).toBe('acc-1');
  });

  it('enforces strict migration ownership, state, and generation invariants (T10-F03, Probes C06, C08, C20)', () => {
    const policy = new AccountLeaseSelectionPolicy();
    const sessionKey = 'session:migration-test';

    // 1. Initial bind establishes active gen 1
    policy.bindSession(sessionKey, 'acc-1', Date.now() + 60000);
    const initial = policy.getSessionBinding(sessionKey);
    expect(initial?.generation).toBe(1);
    expect(initial?.state).toBe('active');

    // 2. confirmSessionMigration fails if state is not 'migrating' (Probe C06)
    expect(
      policy.confirmSessionMigration(sessionKey, 1, 'acc-2', 'req-1'),
    ).toBe(false);

    // 3. Start migration by req-1 towards acc-2
    const migrationCapability = policy.startSessionMigration(sessionKey, 1, 'acc-2', 'req-1');
    expect(migrationCapability).toMatchObject({
      sessionKey,
      generation: 2,
      ownerRequestId: 'req-1',
      targetAccountId: 'acc-2',
    });
    const migrating = policy.getSessionBinding(sessionKey);
    expect(migrating?.state).toBe('migrating');
    expect(migrating?.generation).toBe(2);
    expect(migrating?.migratingToAccountId).toBe('acc-2');

    // 4. Another request req-2 cannot steal migration (Probe C05)
    expect(policy.startSessionMigration(sessionKey, 1, 'acc-3', 'req-2')).toBeNull();

    // 5. Wrong owner cannot confirm (Probe C08)
    expect(
      policy.confirmSessionMigration(sessionKey, 2, 'acc-2', 'req-wrong-owner'),
    ).toBe(false);

    // 6. Wrong candidate cannot confirm (Probe C07)
    expect(
      policy.confirmSessionMigration(sessionKey, 2, 'acc-wrong-candidate', 'req-1'),
    ).toBe(false);

    // 7. Right owner and right candidate confirms successfully!
    expect(
      policy.confirmSessionMigration(sessionKey, 2, 'acc-2', 'req-1'),
    ).toBe(true);
    const confirmed = policy.getSessionBinding(sessionKey);
    expect(confirmed?.state).toBe('active');
    expect(confirmed?.accountId).toBe('acc-2');
    expect(confirmed?.generation).toBe(2);

    // 8. Stale attempt from acc-1 cannot overwrite active gen 2 (Probe C20)
    expect(
      policy.confirmSessionMigration(sessionKey, 2, 'acc-1', 'req-stale'),
    ).toBe(false);
  });
});
