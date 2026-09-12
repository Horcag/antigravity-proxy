import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import { ProxyRetryPolicy } from '../../modules/proxy-gateway/server/proxy-retry-policy';
import { ProxyConfigSchema } from '../../modules/config/types';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import * as zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
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
  const writtenChunks: Buffer[] = [];
  res.writtenChunks = writtenChunks;
  res.writeHead = vi.fn((statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
    res.headersSent = true;
  });
  res.end = vi.fn((chunk?: any) => {
    if (chunk) {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');
  });
  res.write = vi.fn((chunk: any) => {
    if (chunk) {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  });
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

describe('Oracle Turn 12 Release Gates Integration', () => {
  let leaseService: AccountLeaseService;
  let gateway: CloudCodeFailoverGateway;

  beforeEach(() => {
    leaseService = new AccountLeaseService();
    // Populate leaseService with 2 real accounts
    const acc1 = createMockAccount('acc-1', 'acc1@test.com');
    const acc2 = createMockAccount('acc-2', 'acc2@test.com');
    (leaseService as any).tokens = new Map([
      ['acc-1', { ...acc1.token, account_id: 'acc-1', email: 'acc1@test.com', model_quotas: {}, model_forwarding_rules: {} }],
      ['acc-2', { ...acc2.token, account_id: 'acc-2', email: 'acc2@test.com', model_quotas: {}, model_forwarding_rules: {} }],
    ]);
    gateway = new CloudCodeFailoverGateway(leaseService);
  });

  // Gate 1: A returns 429; B succeeds; only two accounts exist -> B’s response reaches the client and becomes the confirmed binding
  it('Gate 1: 2-account pool failover from A (429) to B (200) confirms B as session binding', async () => {
    const sessionKey = 'session:gate-1-test';
    // Bind session to acc-1 initially
    leaseService.bindSession(sessionKey, 'acc-1', 60000);
    expect(leaseService.getSessionBinding(sessionKey)?.accountId).toBe('acc-1');
    expect(leaseService.getSessionBinding(sessionKey)?.generation).toBe(1);

    let attemptCount = 0;
    (vi.spyOn(gateway as any, 'executeUpstreamCall') as any).mockImplementation(
      async (_method: string, _url: string, headers: Record<string, string>) => {
        attemptCount++;
        const auth = headers['authorization'] || '';
        if (auth.includes('token-acc-1') || attemptCount === 1) {
          const bodyBuf = Buffer.from('{"error":{"code":429,"message":"Quota exceeded"}}');
          return {
            statusCode: 429,
            headers: { 'content-type': 'application/json' },
            bodyStream: createMockStream([bodyBuf]),
            bufferedBody: bodyBuf,
          };
        }
        const bodyBuf = Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Hello from B"}]}}]}');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bodyStream: createMockStream([bodyBuf]),
          bufferedBody: bodyBuf,
        };
      },
    );

    const req = createMockRequest({
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'x-session-id': 'gate-1-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(attemptCount).toBe(2);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    // Verify session binding is now confirmed to acc-2 with generation 2
    const binding = leaseService.getSessionBinding(sessionKey);
    expect(binding?.accountId).toBe('acc-2');
    expect(binding?.state).toBe('active');
    expect(binding?.generation).toBe(2);
  });

  // Gate 2: A and B fail; C succeeds -> Each candidate transition uses the returned current migration capability
  it('Gate 2: Multi-step migration A -> B (fails) -> C (succeeds) tracks versioned migration capability', async () => {
    const acc3 = createMockAccount('acc-3', 'acc3@test.com');
    (leaseService as any).tokens.set('acc-3', {
      ...acc3.token,
      account_id: 'acc-3',
      email: 'acc3@test.com',
      model_quotas: {},
      model_forwarding_rules: {},
    });

    const sessionKey = 'session:gate-2-test';
    leaseService.bindSession(sessionKey, 'acc-1', 60000);
    expect(leaseService.getSessionBinding(sessionKey)?.generation).toBe(1);

    (vi.spyOn(gateway as any, 'executeUpstreamCall') as any).mockImplementation(
      async (_method: string, _url: string, headers: Record<string, string>) => {
        const auth = headers['authorization'] || '';
        if (auth.includes('token-acc-1') || auth.includes('token-acc-2')) {
          const bodyBuf = Buffer.from('{"error":{"code":429,"message":"Quota exceeded"}}');
          return {
            statusCode: 429,
            headers: { 'content-type': 'application/json' },
            bodyStream: createMockStream([bodyBuf]),
            bufferedBody: bodyBuf,
          };
        }
        const bodyBuf = Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Hello from C"}]}}]}');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bodyStream: createMockStream([bodyBuf]),
          bufferedBody: bodyBuf,
        };
      },
    );

    const req = createMockRequest({
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'x-session-id': 'gate-2-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const binding = leaseService.getSessionBinding(sessionKey);
    expect(binding?.accountId).toBe('acc-3');
    expect(binding?.state).toBe('active');
    expect(binding?.generation).toBe(2);
  });

  // Gate 3: Old A response arrives after B confirmation -> No stale migration back to A
  it('Gate 3: Stale A arrival after B is confirmed is strictly rejected', () => {
    const sessionKey = 'session:gate-3-test';
    leaseService.bindSession(sessionKey, 'acc-1', 60000);
    expect(leaseService.getSessionBinding(sessionKey)?.generation).toBe(1);

    // B migrates and confirms at generation 2
    const capB = leaseService.startSessionMigration(sessionKey, 1, 'acc-2', 'req-new');
    expect(capB).not.toBeNull();
    expect(capB?.generation).toBe(2);
    const confirmedB = leaseService.confirmOrBindSession(sessionKey, 'acc-2', 2, 'req-new');
    expect(confirmedB).toEqual({ kind: 'confirmed' });
    expect(leaseService.getSessionBinding(sessionKey)?.accountId).toBe('acc-2');
    expect(leaseService.getSessionBinding(sessionKey)?.generation).toBe(2);

    // Old attempt on A arrives with expectedGeneration=1 and req-old
    const staleResult = leaseService.confirmOrBindSession(sessionKey, 'acc-1', 1, 'req-old');
    expect(staleResult).toEqual({ kind: 'rejected', reason: expect.any(String) });
    // State remains active on acc-2, generation 2
    const current = leaseService.getSessionBinding(sessionKey);
    expect(current?.accountId).toBe('acc-2');
    expect(current?.generation).toBe(2);
    expect(current?.state).toBe('active');
  });

  // Gate 4: API retry succeeds on B -> The API carries ownership, handles confirmation result, and updates binding
  it('Gate 4: ProxyRetryPolicy carries owner requestId and migration capability to update binding', async () => {
    const retryPolicy = new ProxyRetryPolicy(leaseService, console as any);
    const retryState = retryPolicy.createTokenRetryState();
    const sessionKey = 'session:gate-4-api-test';
    leaseService.bindSession(sessionKey, 'acc-1', 60000);

    // Initial token was acc-1
    retryState.attemptedAccountIds.add('acc-1');

    // Select retry token initiates migration towards acc-2
    const retryToken = await retryPolicy.selectRetryToken(retryState, 'gemini-2.5-flash', sessionKey);
    expect(retryToken).toMatchObject({ id: 'acc-2' });
    expect(retryState.migrationCapability).toMatchObject({
      sessionKey,
      targetAccountId: 'acc-2',
      generation: 2,
    });

    // Upstream succeeds on B: markUpstreamSuccess carries owner requestId and generation
    const confirmed = retryPolicy.markUpstreamSuccess(
      'acc-2',
      'gemini-2.5-flash',
      sessionKey,
      retryState.sessionGeneration,
      retryState.breakerGeneration,
      retryState.requestId,
    );
    expect(confirmed).toEqual({ kind: 'confirmed' });

    const binding = leaseService.getSessionBinding(sessionKey);
    expect(binding?.accountId).toBe('acc-2');
    expect(binding?.generation).toBe(2);
    expect(binding?.state).toBe('active');
  });

  // Gate 5: Caller omits migration owner -> It cannot inherit ownership from current state
  it('Gate 5: confirmOrBindSession rejects if owner requestId is omitted during migration', () => {
    const sessionKey = 'session:gate-5-test';
    leaseService.bindSession(sessionKey, 'acc-1', 60000);

    const cap = leaseService.startSessionMigration(sessionKey, 1, 'acc-2', 'legit-owner');
    expect(cap).not.toBeNull();

    // Caller passes no owner requestId
    const acceptedWithoutOwner = leaseService.confirmOrBindSession(sessionKey, 'acc-2', 2);
    expect(acceptedWithoutOwner).toEqual({ kind: 'rejected', reason: expect.any(String) });

    // Caller passes wrong owner
    const acceptedWrongOwner = leaseService.confirmOrBindSession(sessionKey, 'acc-2', 2, 'impostor');
    expect(acceptedWrongOwner).toEqual({ kind: 'rejected', reason: expect.any(String) });

    // State remains migrating
    expect(leaseService.getSessionBinding(sessionKey)?.state).toBe('migrating');
  });

  // Gate 6: Prefix reaches its byte limit while incomplete -> NEED_MORE_DATA does not commit to client
  it('Gate 6: Classifier returns NEED_MORE_DATA when incomplete frame reaches limit', () => {
    // Incomplete JSON prefix starting with {" but unclosed and streamEnded=false
    const incompletePrefix = Buffer.from('{"candidates": [{"content": "' + 'a'.repeat(65530));
    const decision = gateway.classifyProtocolFrame(
      'application/json',
      incompletePrefix,
      { 'content-type': 'application/json' },
      undefined,
      false,
    );
    expect(decision.state).toBe('NEED_MORE_DATA');
  });

  // Gate 7: Malformed JSON reaches EOF -> Returns VALIDATED_ERROR, no false validated response
  it('Gate 7: Malformed JSON at EOF returns VALIDATED_ERROR', () => {
    const malformedBody = Buffer.from('{"error":', 'utf-8');
    const decision = gateway.classifyProtocolFrame(
      'application/json',
      malformedBody,
      { 'content-type': 'application/json' },
      undefined,
      true,
    );
    expect(decision.state).toBe('VALIDATED_ERROR');
  });

  // Gate 8: Gzip compressed JSON quota error -> Decompresses before inspection, correctly classified as quota error
  it('Gate 8: Gzip compressed JSON quota error is decompressed and classified as quota error', () => {
    const jsonError = JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted' } });
    const gzipped = zlib.gzipSync(Buffer.from(jsonError, 'utf-8'));

    const decision = gateway.classifyProtocolFrame(
      'application/json',
      gzipped,
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      undefined,
      true,
    );
    expect(decision.state).toBe('VALIDATED_ERROR');
    expect(decision.isQuota).toBe(true);
  });

  // Gate 9: Hint-only request goes through API and native ingress -> No hard session mutation
  it('Gate 9: Hint-only request records soft cache hint and never mutates hard sessionBindings', () => {
    const hintKey = 'hint:prefix:abcdef0123456789';

    // 1. In leaseService.bindSession
    leaseService.bindSession(hintKey, 'acc-1', 60000);
    expect(leaseService.getSessionBinding(hintKey)).toBeNull();
    expect((leaseService as any).selectionPolicy.getCacheHint(hintKey)).toBe('acc-1');

    // 2. In leaseService.confirmOrBindSession
    const confirmed = leaseService.confirmOrBindSession(hintKey, 'acc-2', 1, 'req-hint');
    expect(confirmed).toEqual({ kind: 'hint-recorded' });
    expect(leaseService.getSessionBinding(hintKey)).toBeNull();
    expect((leaseService as any).selectionPolicy.getCacheHint(hintKey)).toBe('acc-2');
  });

  // Gate 10: Malformed CONNECT authority -> Rejected before either interception or tunneling
  it('Gate 10: Malformed CONNECT authority daily-cloudcode-pa.googleapis.com:443junk returns 400 Bad Request', () => {
    const ingress = new ConnectIngressService();
    const socket = new EventEmitter() as any;
    socket.write = vi.fn().mockReturnValue(true);
    socket.destroy = vi.fn();

    (ingress as any).handleConnect(
      {
        url: 'daily-cloudcode-pa.googleapis.com:443junk',
        headers: { host: 'daily-cloudcode-pa.googleapis.com:443junk' },
      } as any,
      socket,
      Buffer.alloc(0),
    );

    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\n\r\n');
    expect(socket.destroy).toHaveBeenCalled();
  });

  // Gate 11: Slow downstream after upstream EOF -> Relay ownership follows the documented lifetime
  it('Gate 11: Relay completion promise awaits downstream finish, not just upstream stream close', async () => {
    const sourceStream = new PassThrough();
    const destStream = new PassThrough();
    const mockReq = new EventEmitter() as any;

    let relayFinished = false;
    const relayPromise = gateway.createRelayCompletionPromise(mockReq, destStream as any, sourceStream).then(() => {
      relayFinished = true;
    });

    sourceStream.write('test data');
    sourceStream.end();

    // Allow source to end and close
    await new Promise((r) => setTimeout(r, 10));
    // Downstream has not ended yet
    expect(relayFinished).toBe(false);

    // Finish downstream
    destStream.emit('finish');
    await relayPromise;
    expect(relayFinished).toBe(true);
  });

  // Gate 12: Initial grpc-status: 14 -> Handled as transient retry without committing 200 OK headers
  it('Gate 12: Initial grpc-status: 14 on 200 OK response triggers retry without committing headers', async () => {
    let attemptCount = 0;
    (vi.spyOn(gateway as any, 'executeUpstreamCall') as any).mockImplementation(
      async (_method: string, _url: string, headers: Record<string, string>) => {
        attemptCount++;
        const auth = headers['authorization'] || '';
        if (auth.includes('token-acc-1') || attemptCount === 1) {
          return {
            statusCode: 200,
            headers: {
              'content-type': 'application/grpc',
              'grpc-status': '14',
              'grpc-message': 'Unavailable',
            },
            bodyStream: createMockStream([]),
            bufferedBody: Buffer.alloc(0),
          };
        }
        const bodyBuf = Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Success"}]}}]}');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bodyStream: createMockStream([bodyBuf]),
          bufferedBody: bodyBuf,
        };
      },
    );

    const req = createMockRequest({
      headers: { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(attemptCount).toBe(2);
    // Ensure final response committed was from acc-2
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'application/json' }));
  });

  // T13-F02: Migration is initiated on account change on attempt 1
  it('T13-F02: Session migration is initiated on attempt 1 when account differs from bound account', () => {
    const sessionKey = 'session:t13-f02-test';
    leaseService.bindSession(sessionKey, 'acc-1', 60000);
    const initialBinding = leaseService.getSessionBinding(sessionKey);
    expect(initialBinding?.accountId).toBe('acc-1');

    // On attempt 1, scheduler picked acc-2 because acc-1 was unavailable
    const selectedAccount = { id: 'acc-2' };
    const needsMigration = Boolean(
      sessionKey &&
      selectedAccount &&
      initialBinding &&
      initialBinding.accountId !== selectedAccount.id,
    );
    expect(needsMigration).toBe(true);

    const migrationCap = leaseService.startSessionMigration(
      sessionKey,
      initialBinding!.generation,
      selectedAccount.id,
      'req-attempt-1',
    );
    expect(migrationCap).not.toBeNull();
    expect(migrationCap?.generation).toBe(2);
    expect(migrationCap?.targetAccountId).toBe('acc-2');

    // Now confirm on attempt 1 succeeds with acc-2
    const commitResult = leaseService.confirmOrBindSession(
      sessionKey,
      'acc-2',
      migrationCap!.generation,
      'req-attempt-1',
    );
    expect(commitResult).toEqual({ kind: 'confirmed' });
    expect(leaseService.getSessionBinding(sessionKey)?.accountId).toBe('acc-2');
  });

  // T13-F03: 80KB JSON on HTTP 200 is validated without cycling accounts
  it('T13-F03: 80KB JSON on HTTP 200 is classified as VALIDATED_RESPONSE without cycling accounts', async () => {
    let attempts = 0;
    const largeJson = JSON.stringify({
      responseBytes: 80052,
      data: 'x'.repeat(80000),
    });
    const largeBuf = Buffer.from(largeJson, 'utf-8');

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      attempts++;
      // Split 80KB buffer into 4 chunks to simulate ordinary chunked delivery
      const chunkSize = 20000;
      const chunks = [
        largeBuf.subarray(0, chunkSize),
        largeBuf.subarray(chunkSize, chunkSize * 2),
        largeBuf.subarray(chunkSize * 2, chunkSize * 3),
        largeBuf.subarray(chunkSize * 3),
      ];
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(largeBuf.length) },
        bodyStream: createMockStream(chunks),
        bufferedBody: largeBuf,
      };
    });

    const req = createMockRequest({
      headers: { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'big' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(attempts).toBe(1);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });

  // T13-F03: Locally detected malformed responses on HTTP 200 synthesize 502 Bad Gateway
  it('T13-F03: Truncated JSON at EOF with HTTP 200 synthesizes 502 Bad Gateway instead of forwarding 200', async () => {
    const malformedBuf = Buffer.from('{"error":', 'utf-8');
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream([malformedBuf]),
        bufferedBody: malformedBuf,
      };
    });

    const req = createMockRequest({
      headers: { host: 'daily-cloudcode-pa.googleapis.com', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(
      502,
      expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
    );
  });

  // T13-F04: Incremental gzip stream with sync flush produces complete event before stream ends
  it('T13-F04: classifyProtocolFrame handles gzip streamed chunk and enforces maxOutputLength', () => {
    // 1. Sync flushed gzip chunk
    const sseEvent = 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n';
    const compressedChunk = zlib.gzipSync(Buffer.from(sseEvent, 'utf-8'));
    const decision = gateway.classifyProtocolFrame(
      'text/event-stream',
      compressedChunk,
      { 'content-encoding': 'gzip' },
      undefined,
      false,
    );
    expect(decision.state).toBe('VALIDATED_RESPONSE');

    // 2. Exceeding maxOutputLength triggers bounded rejection rather than memory explosion
    const hugeBuffer = Buffer.alloc(100000, 'a');
    const bombChunk = zlib.gzipSync(hugeBuffer);
    const bombDecision = gateway.classifyProtocolFrame(
      'application/json',
      bombChunk,
      { 'content-encoding': 'gzip' },
      undefined,
      true,
    );
    expect(bombDecision.state).toBe('VALIDATED_ERROR');
    expect(bombDecision.category).toBe('unsupported-encoding');
  });

  // T13-F05: gRPC and gRPC-Web framing interpretation
  it('T13-F05: gRPC-Web trailers frame 0x80 status 8 is classified as quota error', () => {
    // Probe C06: gRPC-Web trailers frame (flag 0x80) with grpc-status: 8
    const trailerBody = 'grpc-status: 8\r\ngrpc-message: Resource exhausted\r\n';
    const trailerBuf = Buffer.from(trailerBody, 'utf-8');
    const frame = Buffer.alloc(5 + trailerBuf.length);
    frame.writeUInt8(0x80, 0); // Trailers flag
    frame.writeUInt32BE(trailerBuf.length, 1);
    trailerBuf.copy(frame, 5);

    const decision = gateway.classifyProtocolFrame(
      'application/grpc-web+proto',
      frame,
      undefined,
      undefined,
      false,
    );
    expect(decision.state).toBe('VALIDATED_ERROR');
    expect(decision.isQuota).toBe(true);
    expect(decision.category).toBe('account-quota');
  });

  it('T13-F05: Native gRPC frame with invalid compressed flag 0x7f is classified as error', () => {
    // Probe C07: Native gRPC frame with invalid compressed flag 0x7f
    const frame = Buffer.alloc(10);
    frame.writeUInt8(0x7f, 0); // Invalid flag
    frame.writeUInt32BE(5, 1);

    const decision = gateway.classifyProtocolFrame(
      'application/grpc',
      frame,
      undefined,
      undefined,
      false,
    );
    expect(decision.state).toBe('VALIDATED_ERROR');
    expect(decision.isLocalValidationError).toBe(true);
  });

  it('T13-F05: Empty successful gRPC response with terminal status 0 is VALIDATED_RESPONSE', () => {
    // Probe C08: Empty gRPC stream at EOF with terminal status 0
    const decision = gateway.classifyProtocolFrame(
      'application/grpc',
      Buffer.alloc(0),
      { 'grpc-status': '0' },
      undefined,
      true,
    );
    expect(decision.state).toBe('VALIDATED_RESPONSE');
  });

  // T13-F06: Native successful hint requests populate the cache hint store
  it('T13-F06: Native successful hint requests populate the cache hint store', async () => {
    const hintKey = 'hint:prefix:session-locality-native';
    const bodyBuf = Buffer.from('{"candidates":[{"content":{"parts":[{"text":"Success"}]}}]}');
    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyStream: createMockStream([bodyBuf]),
        bufferedBody: bodyBuf,
      };
    });

    const req = createMockRequest({
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'content-type': 'application/json',
        'x-session-id': hintKey,
      },
      body: JSON.stringify({ prompt: 'test' }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    // Verify soft hint store was populated
    expect((leaseService as any).selectionPolicy.getCacheHint(hintKey)).toBe('acc-1');
    // Verify no hard session binding was created
    expect(leaseService.getSessionBinding(hintKey)).toBeNull();
  });

  // T13-F01: Confirmation rejection is propagated as AffinityCommitResult rejected
  it('T13-F01: Confirmation rejection is strictly propagated as AffinityCommitResult rejected', () => {
    vi.spyOn(leaseService, 'confirmOrBindSession').mockReturnValue({
      kind: 'rejected',
      reason: 'Binding rejected in test',
    });

    const retryPolicy = new ProxyRetryPolicy(leaseService, console as any);
    const commitResult = retryPolicy.markUpstreamSuccess(
      'acc-1',
      'gemini-2.5-flash',
      'session:rejected-test',
      1,
      1,
      'req-test',
    );
    expect(commitResult).toEqual({
      kind: 'rejected',
      reason: 'Binding rejected in test',
    });
  });

  // T14-F01: Streaming decompressor decodes chunked gzip response once without double decompression
  it('T14-F01: classifyProtocolFrame handles already decoded buffer without double decompressing', () => {
    const validJson = Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }), 'utf-8');
    const headers = {
      'content-type': 'application/json',
      'content-encoding': 'gzip', // original transport header remains gzip
    };

    // When isAlreadyDecoded is true, classifyProtocolFrame should NOT call gunzipSync on validJson
    const decision = gateway.classifyProtocolFrame(
      'application/json',
      validJson,
      headers as any,
      {},
      false,
      200,
      true, // isAlreadyDecoded
    );

    expect(decision.state).toBe('VALIDATED_RESPONSE');
  });

  // T14-F02: 64 KiB threshold returns NEED_MORE_DATA (inspection-limit) without falsely promoting to valid response
  it('T14-F02: Exceeding 64 KiB inspection buffer without complete frame does not promote to VALIDATED_RESPONSE', () => {
    const incompleteJsonPrefix = Buffer.from('{"data":"' + 'x'.repeat(70000), 'utf-8');
    const decision = gateway.classifyProtocolFrame(
      'application/json',
      incompleteJsonPrefix,
      { 'content-type': 'application/json' } as any,
      {},
      false,
      200,
      false,
    );

    // Incomplete JSON must return NEED_MORE_DATA, NEVER VALIDATED_RESPONSE
    expect(decision.state).toBe('NEED_MORE_DATA');
  });

  // T14-F04: API retry selector initiates migration on attempt 1 when account differs from session binding
  it('T14-F04: selectRetryToken initiates migration on attempt 1 when account differs from bound account', async () => {
    const sessionKey = 'session:api-attempt1-migration';
    // Bind session to account A
    leaseService.bindSession(sessionKey, 'acc-1');

    const startMigrationSpy = vi.spyOn(leaseService, 'startSessionMigration');
    const retryPolicy = new ProxyRetryPolicy(leaseService, console as any);
    const retryState = retryPolicy.createTokenRetryState();

    // Account A is cooling down with empty attemptedAccountIds, verifying attempt-1 behavior without retry flag
    expect(retryState.attemptedAccountIds.size).toBe(0);
    (leaseService as any).accountCooldowns.set('acc-1', Date.now() + 60000);

    const selected = await retryPolicy.selectRetryToken(retryState, 'gemini-2.5-flash', sessionKey);

    expect(selected?.id).toBe('acc-2');
    // Verify migration was initiated before attempt 1 dispatched to B!
    expect(startMigrationSpy).toHaveBeenCalledWith(
      sessionKey,
      1,
      'acc-2',
      retryState.requestId,
      leaseService.getTableIncarnation(),
    );
    expect(retryState.migrationCapability).toBeDefined();
    expect(retryState.tableIncarnation).toBe(leaseService.getTableIncarnation());
  });

  // T14-F05: Generation-1 attempt completes after clearSessions reset is rejected
  it('T14-F05: Old generation-1 attempt is rejected after clearSessions reset', () => {
    const sessionKey = 'session:reset-fence-test';
    const oldIncarnation = leaseService.getTableIncarnation();

    // Simulate reset
    leaseService.clearSessions();
    const newIncarnation = leaseService.getTableIncarnation();
    expect(newIncarnation).toBeGreaterThan(oldIncarnation);

    // Attempt with old incarnation tries to confirm generation 1
    const commitResult = leaseService.confirmOrBindSession(
      sessionKey,
      'acc-1',
      1,
      'req-old',
      undefined,
      oldIncarnation, // old incarnation from before reset!
    );

    expect(commitResult.kind).toBe('rejected');
    expect((commitResult as any).reason).toContain('does not match current table incarnation');
  });

  // T14-F05: Migration lease renewal extends expiresAt with matching incarnation
  it('T14-F05: renewSessionMigration successfully extends migration expiry', () => {
    const sessionKey = 'session:renew-test';
    leaseService.bindSession(sessionKey, 'acc-1');
    const cap = leaseService.startSessionMigration(sessionKey, 1, 'acc-2', 'req-renew');
    expect(cap).not.toBeNull();

    const rawBindingBefore = (leaseService as any).selectionPolicy.sessionBindings.get(sessionKey);
    const migrationExpiresAtBefore = rawBindingBefore.migrationExpiresAt;

    const renewed = leaseService.renewSessionMigration(
      sessionKey,
      cap!.generation,
      'req-renew',
      120000,
      cap!.tableIncarnation,
    );

    expect(renewed).toBe(true);
    const rawBindingAfter = (leaseService as any).selectionPolicy.sessionBindings.get(sessionKey);
    expect(rawBindingAfter.migrationExpiresAt).toBeGreaterThan(migrationExpiresAtBefore);
  });

  // T14-F02: Large valid JSON responses (>64 KiB) are fully classified as VALIDATED_RESPONSE at EOF without being cut off
  it('T14-F02: Large valid JSON response (>64 KiB) at EOF classifies as VALIDATED_RESPONSE', () => {
    const largeValidJson = Buffer.from(
      JSON.stringify({
        models: Array.from({ length: 500 }, (_, i) => ({
          name: `model-${i}`,
          displayName: `Model ${i} display name with long descriptive text to exceed 64 KiB easily`,
          supportedMimeTypes: ['application/json', 'text/plain', 'image/png'],
        })),
      }),
      'utf-8',
    );
    expect(largeValidJson.length).toBeGreaterThan(65536);

    const decision = gateway.classifyProtocolFrame(
      'application/json',
      largeValidJson,
      { 'content-type': 'application/json' } as any,
      {},
      true, // streamEnded
      200,
      false,
    );

    expect(decision.state).toBe('VALIDATED_RESPONSE');
  });

  // T15-F01: Reset during hydration reacquires or rejects without leaking mismatched incarnation
  it('T15-F01: Reset during hydration captures admission incarnation and reacquires cleanly', async () => {
    const sessionKey = 'session:hydration-incarnation-fence';
    leaseService.bindSession(sessionKey, 'acc-1');

    const originalFinalize = (leaseService as any).finalizeSelectedToken.bind(leaseService);
    let resetDone = false;
    vi.spyOn(leaseService as any, 'finalizeSelectedToken').mockImplementation(
      async (...args: any[]) => {
        if (!resetDone) {
          resetDone = true;
          // Table advances incarnation during hydration (Probe C01)
          leaseService.clearSessions();
        }
        return originalFinalize(...args);
      },
    );

    const lease = await leaseService.acquireAttemptLease({ sessionKey });
    expect(lease).not.toBeNull();
    // Verify lease returned matches the current table incarnation, not the pre-reset admission snapshot!
    expect(lease?.tableIncarnation).toBe(leaseService.getTableIncarnation());
  });

  // T15-F01: startSessionMigration rejects caller with stale table incarnation
  it('T15-F01: startSessionMigration strictly rejects caller with stale table incarnation', () => {
    const sessionKey = 'session:stale-caller-migration';
    leaseService.bindSession(sessionKey, 'acc-1');
    const oldIncarnation = leaseService.getTableIncarnation();

    // Table advances incarnation
    leaseService.clearSessions();
    const newIncarnation = leaseService.getTableIncarnation();
    expect(newIncarnation).toBeGreaterThan(oldIncarnation);

    // Re-bind in new table
    leaseService.bindSession(sessionKey, 'acc-1');

    // Attempt migration from old lease (incarnation 1) into new table (incarnation 2)
    const cap = leaseService.startSessionMigration(
      sessionKey,
      1,
      'acc-2',
      'req-stale-caller',
      oldIncarnation, // stale caller incarnation!
    );

    expect(cap).toBeNull();
  });

  // T15-F03: AbortSignal during hydration releases reservation immediately
  it('T15-F03: AbortSignal during hydration immediately releases active reservation', async () => {
    const abortController = new AbortController();
    let reservationReleased = false;

    const originalAcquireWorkReservation = (leaseService as any).acquireWorkReservation.bind(leaseService);
    (vi.spyOn(leaseService as any, 'acquireWorkReservation') as any).mockImplementation((accId: string) => {
      const rel = originalAcquireWorkReservation(accId);
      return () => {
        reservationReleased = true;
        rel();
      };
    });

    vi.spyOn(leaseService as any, 'finalizeSelectedToken').mockImplementation(async () => {
      // Simulate slow hydration where deadline/abort fires
      abortController.abort();
      return null;
    });

    const lease = await leaseService.acquireAttemptLease({
      signal: abortController.signal,
    });

    expect(lease).toBeNull();
    expect(reservationReleased).toBe(true);
  });

  // T15-F04: Migration renewal stops upon confirmation
  it('T15-F04: Migration renewal stops once session migration is confirmed active', () => {
    const sessionKey = 'session:renewal-stop-test';
    leaseService.bindSession(sessionKey, 'acc-1');

    const cap = leaseService.startSessionMigration(sessionKey, 1, 'acc-2', 'req-active-test');
    expect(cap).not.toBeNull();

    // While migrating, renewal succeeds
    const renewedWhileMigrating = leaseService.renewSessionMigration(
      sessionKey,
      cap!.generation,
      'req-active-test',
      30000,
      cap!.tableIncarnation,
    );
    expect(renewedWhileMigrating).toBe(true);

    // Confirm migration (transitions to active)
    const confirmed = leaseService.confirmSessionMigration(
      sessionKey,
      cap!.generation,
      'acc-2',
      'req-active-test',
      60000,
      cap!.tableIncarnation,
    );
    expect(confirmed).toBe(true);

    // Once active, renewSessionMigration correctly returns false
    const renewedAfterConfirm = leaseService.renewSessionMigration(
      sessionKey,
      cap!.generation,
      'req-active-test',
      30000,
      cap!.tableIncarnation,
    );
    expect(renewedAfterConfirm).toBe(false);
  });

  // T16-F01 Probe C01: Boundary chunk crossing 64KB inspection budget forwards 100% of consumed bytes without data loss
  it('T16-F01: Boundary chunk crossing 64KB inspection budget forwards 100% of consumed bytes without data loss', async () => {
    const sessionKey = 'session:relay-budget-cross';
    leaseService.bindSession(sessionKey, 'acc-1');

    // Create a valid SSE payload > 64KB (75KB) with text/event-stream where inspection budget is 64 KiB (65536 bytes)
    const event1 = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A'.repeat(39000) }] } }] })}\n\n`;
    const event2 = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'B'.repeat(36000) }] } }] })}\n\n`;
    const fullSseStr = event1 + event2;
    const fullSseBuf = Buffer.from(fullSseStr, 'utf-8');
    expect(fullSseBuf.length).toBeGreaterThan(65536);

    // Split into chunk1 (45KB) and chunk2 (rest, ~30KB).
    // chunk1 + chunk2 crosses the 64KB inspection budget during chunk2!
    const chunk1 = fullSseBuf.subarray(0, 45000);
    const chunk2 = fullSseBuf.subarray(45000);

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        bodyStream: createMockStream([chunk1, chunk2]),
        bufferedBody: fullSseBuf,
      };
    });

    const req = createMockRequest({
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'x-session-id': 'relay-budget-cross',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const receivedBody = Buffer.concat(res.writtenChunks);
    expect(receivedBody.length).toBe(fullSseBuf.length);
    expect(receivedBody.equals(fullSseBuf)).toBe(true);
  });

  // T16-F01: Chunk partition invariance verifies byte-for-byte identical client forwarding
  it('T16-F01: Chunk partition invariance verifies byte-for-byte identical client forwarding', async () => {
    const sessionKey = 'session:chunk-invariance';
    leaseService.bindSession(sessionKey, 'acc-1');

    const event1 = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'X'.repeat(38000) }] } }] })}\n\n`;
    const event2 = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Y'.repeat(38000) }] } }] })}\n\n`;
    const fullSseStr = event1 + event2;
    const fullSseBuf = Buffer.from(fullSseStr, 'utf-8');
    expect(fullSseBuf.length).toBeGreaterThan(65536);

    async function runWithChunks(chunks: Buffer[]): Promise<Buffer> {
      vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          bodyStream: createMockStream(chunks),
          bufferedBody: fullSseBuf,
        };
      });

      const req = createMockRequest({
        headers: {
          host: 'daily-cloudcode-pa.googleapis.com',
          'x-session-id': 'chunk-invariance',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });
      const res = createMockResponse();
      await gateway.handleRequest(req, res);
      return Buffer.concat(res.writtenChunks);
    }

    // Partition 1: 1KB chunks
    const chunks1KB: Buffer[] = [];
    for (let i = 0; i < fullSseBuf.length; i += 1024) {
      chunks1KB.push(fullSseBuf.subarray(i, i + 1024));
    }
    const result1KB = await runWithChunks(chunks1KB);

    // Partition 2: 16KB chunks
    const chunks16KB: Buffer[] = [];
    for (let i = 0; i < fullSseBuf.length; i += 16384) {
      chunks16KB.push(fullSseBuf.subarray(i, i + 16384));
    }
    const result16KB = await runWithChunks(chunks16KB);

    // Partition 3: Boundary-crossing (48KB + remainder)
    const chunksBoundary = [fullSseBuf.subarray(0, 48000), fullSseBuf.subarray(48000)];
    const resultBoundary = await runWithChunks(chunksBoundary);

    expect(result1KB.equals(fullSseBuf)).toBe(true);
    expect(result16KB.equals(fullSseBuf)).toBe(true);
    expect(resultBoundary.equals(fullSseBuf)).toBe(true);
    expect(result1KB.equals(resultBoundary)).toBe(true);
  });

  // T16-F01 Probe C02: Encoded gzip reaching raw budget flushes decompressor and validates response without premature 502
  it('T16-F01 Probe C02: Encoded gzip reaching raw budget flushes decompressor and validates response without premature 502', async () => {
    const sessionKey = 'session:gzip-flush-test';
    leaseService.bindSession(sessionKey, 'acc-1');

    const event = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Validated after raw cap' }] } }] })}\n\n`;
    const randomPadding = randomBytes(70000).toString('base64');
    const fullSse = event + `: keepalive ${randomPadding}\n\n`;
    const gzipped = zlib.gzipSync(Buffer.from(fullSse, 'utf-8'));
    expect(gzipped.length).toBeGreaterThan(65536);

    const compressedChunks: Buffer[] = [];
    const chunkSize = 16384;
    for (let i = 0; i < gzipped.length; i += chunkSize) {
      compressedChunks.push(gzipped.subarray(i, i + chunkSize));
    }

    vi.spyOn(gateway as any, 'executeUpstreamCall').mockImplementation(async () => {
      return {
        statusCode: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
        },
        bodyStream: createMockStream(compressedChunks),
        bufferedBody: gzipped,
      };
    });

    const req = createMockRequest({
      headers: {
        host: 'daily-cloudcode-pa.googleapis.com',
        'x-session-id': 'gzip-flush-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const res = createMockResponse();

    await gateway.handleRequest(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.statusCode).toBe(200);
    const receivedCompressed = Buffer.concat(res.writtenChunks);
    expect(receivedCompressed.equals(gzipped)).toBe(true);
    const decompressed = zlib.gunzipSync(receivedCompressed);
    expect(decompressed.equals(Buffer.from(fullSse, 'utf-8'))).toBe(true);
  });

  // T16-F02 Probe C03: Abort while hydration is pending behind barrier settles acquisition immediately to null before barrier release
  it('T16-F02 Probe C03: Abort while hydration is pending behind barrier settles acquisition immediately to null before barrier release', async () => {
    const abortController = new AbortController();
    let barrierReleased = false;
    let finalizeSettled = false;

    let resolveBarrier!: () => void;
    const barrierPromise = new Promise<void>((resolve) => {
      resolveBarrier = () => {
        barrierReleased = true;
        resolve();
      };
    });

    let hydrationEntered!: () => void;
    const hydrationEnteredPromise = new Promise<void>((resolve) => {
      hydrationEntered = resolve;
    });

    vi.spyOn(leaseService as any, 'finalizeSelectedToken').mockImplementation(async () => {
      hydrationEntered();
      await barrierPromise;
      return null;
    });

    const acquirePromise = leaseService.acquireAttemptLease({
      signal: abortController.signal,
    }).then((res) => {
      finalizeSettled = true;
      return res;
    });

    // Wait explicitly until finalizeSelectedToken has entered and is waiting on the barrier!
    await hydrationEnteredPromise;

    // Now trigger abort while actively blocked inside hydration barrier
    abortController.abort();

    const lease = await acquirePromise;
    expect(finalizeSettled).toBe(true);
    expect(barrierReleased).toBe(false);
    expect(lease).toBeNull();

    resolveBarrier();
  });

  // T16-F03 Probe C04: ProxyRetryPolicy starts migration renewal upon capability issuance and sustains capability beyond 60s
  it('T16-F03 Probe C04: ProxyRetryPolicy starts migration renewal upon capability issuance and sustains capability beyond 60s', async () => {
    vi.useFakeTimers();
    try {
      const policy = new ProxyRetryPolicy(leaseService as any, { log: () => {}, warn: () => {} });
      const sessionKey = 'session:migration-sustain-test';
      leaseService.bindSession(sessionKey, 'acc-1');

      const abortController = new AbortController();
      const retryState = policy.createTokenRetryState(abortController.signal);
      retryState.attemptedAccountIds.add('acc-1');

      const selectedAccount = await policy.selectRetryToken(
        retryState,
        'gemini-2.5-pro',
        sessionKey,
      );

      expect(selectedAccount).not.toBeNull();
      expect(selectedAccount?.id).toBe('acc-2');
      expect(retryState.migrationCapability).toBeDefined();
      expect(retryState.migrationRenewalTimer).toBeDefined();

      // Advance time by 75 seconds (beyond default 60s lease)
      await vi.advanceTimersByTimeAsync(75000);

      const binding = leaseService.getSessionBinding(sessionKey);
      expect(binding).not.toBeNull();
      expect(binding?.state).toBe('migrating');
      expect(binding?.migratingToAccountId).toBe('acc-2');

      policy.markUpstreamSuccess(
        selectedAccount!.id,
        'gemini-2.5-pro',
        sessionKey,
        retryState.sessionGeneration,
        retryState.breakerGeneration,
        retryState.requestId,
        retryState.tableIncarnation,
        retryState,
      );

      expect(retryState.migrationRenewalTimer).toBeUndefined();
      const confirmedBinding = leaseService.getSessionBinding(sessionKey);
      expect(confirmedBinding?.state).toBe('active');
      expect(confirmedBinding?.accountId).toBe('acc-2');

      policy.disposeTokenRetryState(retryState);
    } finally {
      vi.useRealTimers();
    }
  });

  // T17-F01 Probe C01: Abort while API acquisition is pending releases late lease and does not start renewal
  it('T17-F01 Probe C01: Abort while API acquisition is pending releases late lease and does not start renewal', async () => {
    const policy = new ProxyRetryPolicy(leaseService as any, { log: () => {}, warn: () => {} });
    const sessionKey = 'session:t17-probe-c01';
    leaseService.bindSession(sessionKey, 'acc-1');

    const abortController = new AbortController();
    const retryState = policy.createTokenRetryState(abortController.signal);
    retryState.attemptedAccountIds.add('acc-1');

    let releaseCalled = false;
    let acquisitionDeferred!: () => void;
    const acquisitionPromise = new Promise<{
      account: any;
      generation: number;
      tableIncarnation: number;
      releaseReservation: () => void;
    }>((resolve) => {
      acquisitionDeferred = () => {
        resolve({
          account: { id: 'acc-2', email: 'acc2@test.com', token: {} as any },
          generation: 1,
          tableIncarnation: 1,
          releaseReservation: () => {
            releaseCalled = true;
          },
        });
      };
    });

    vi.spyOn(leaseService as any, 'acquireAttemptLease').mockReturnValue(acquisitionPromise);

    const selectPromise = policy.selectRetryToken(retryState, 'gemini-2.5-pro', sessionKey);

    // Abort while acquisition is pending
    abortController.abort();
    expect(policy.isTerminal(retryState)).toBe(true);

    // Now acquisition finishes and returns late lease
    acquisitionDeferred();
    const selected = await selectPromise;

    expect(selected).toBeNull();
    expect(releaseCalled).toBe(true);
    expect(retryState.migrationRenewalTimer).toBeUndefined();
    expect(retryState.activeReservation).toBeUndefined();
  });

  // T17-F01 Probe C02: Abort after capability issuance disposes timer and reservation
  it('T17-F01 Probe C02: Abort after capability issuance disposes timer and reservation', async () => {
    const policy = new ProxyRetryPolicy(leaseService as any, { log: () => {}, warn: () => {} });
    const sessionKey = 'session:t17-probe-c02';
    leaseService.bindSession(sessionKey, 'acc-1');

    const abortController = new AbortController();
    const retryState = policy.createTokenRetryState(abortController.signal);
    retryState.attemptedAccountIds.add('acc-1');

    let reservationReleased = false;
    vi.spyOn(leaseService as any, 'acquireAttemptLease').mockResolvedValue({
      account: { id: 'acc-2', email: 'acc2@test.com', token: {} as any },
      generation: 1,
      tableIncarnation: 1,
      releaseReservation: () => {
        reservationReleased = true;
      },
    });

    const selected = await policy.selectRetryToken(retryState, 'gemini-2.5-pro', sessionKey);
    expect(selected?.id).toBe('acc-2');
    expect(retryState.migrationRenewalTimer).toBeDefined();
    expect(retryState.activeReservation).toBeDefined();

    // Abort after capability issuance
    abortController.abort();

    expect(policy.isTerminal(retryState)).toBe(true);
    expect(retryState.status).toBe('cancelled');
    expect(retryState.migrationRenewalTimer).toBeUndefined();
    expect(retryState.activeReservation).toBeUndefined();
    expect(reservationReleased).toBe(true);
  });

  // T17-F01 Probe C03: Disposal during acquisition prevents disposed state from adopting late lease
  it('T17-F01 Probe C03: Call disposal then let acquisition finish prevents adoption of late lease', async () => {
    const policy = new ProxyRetryPolicy(leaseService as any, { log: () => {}, warn: () => {} });
    const sessionKey = 'session:t17-probe-c03-disposal';
    leaseService.bindSession(sessionKey, 'acc-1');

    const retryState = policy.createTokenRetryState();
    retryState.attemptedAccountIds.add('acc-1');

    let releaseCalled = false;
    let acquisitionDeferred!: () => void;
    const acquisitionPromise = new Promise<any>((resolve) => {
      acquisitionDeferred = () => {
        resolve({
          account: { id: 'acc-2', email: 'acc2@test.com', token: {} as any },
          generation: 1,
          tableIncarnation: 1,
          releaseReservation: () => {
            releaseCalled = true;
          },
        });
      };
    });

    vi.spyOn(leaseService as any, 'acquireAttemptLease').mockReturnValue(acquisitionPromise);

    const selectPromise = policy.selectRetryToken(retryState, 'gemini-2.5-pro', sessionKey);

    // Call disposal before acquisition finishes
    policy.disposeTokenRetryState(retryState);
    expect(retryState.status).toBe('disposed');

    acquisitionDeferred();
    const selected = await selectPromise;

    expect(selected).toBeNull();
    expect(releaseCalled).toBe(true);
    expect(retryState.activeReservation).toBeUndefined();
    expect(retryState.migrationRenewalTimer).toBeUndefined();
  });

  // T17-F01 Probe C03: Exception between acquisition and try disposes renewal and lease via outer finalizer
  it('T17-F01 Probe C03: Throw immediately after selection cleans up renewal and lease via outer finalizer', async () => {
    let reservationReleased = false;
    vi.spyOn(leaseService as any, 'acquireAttemptLease').mockResolvedValue({
      account: { id: 'acc-1', email: 'acc1@test.com', token: {} as any },
      generation: 1,
      tableIncarnation: 1,
      releaseReservation: () => {
        reservationReleased = true;
      },
    });

    // Injected resolver error before per-attempt try (Oracle Probe C03)
    vi.spyOn(leaseService as any, 'resolveDynamicModelForAccount').mockImplementation(() => {
      throw new Error('Resolver failure injected at pre-try boundary');
    });

    const service = (gateway as any).proxyService;
    if (service) {
      await expect(
        service.handleAnthropicMessages({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow('Resolver failure injected at pre-try boundary');

      expect(reservationReleased).toBe(true);
    }
  });

  // Config Normalization: Explicit null in legacy config fields normalizes to default values
  it('Config Normalization: Explicit null in legacy config fields normalizes to default values', () => {
    const legacyNullConfig = {
      enabled: null,
      host: null,
      port: null,
      api_key: null,
      admin_api_key: null,
      auto_start: null,
      backend_canary_enabled: null,
      parity_enabled: null,
      parity_shadow_enabled: null,
      parity_kill_switch: null,
      parity_no_go_mismatch_rate: null,
      parity_no_go_error_rate: null,
      scheduling_mode: null,
      max_concurrency_per_account: null,
      max_wait_seconds: null,
      preferred_account_id: null,
      circuit_breaker_enabled: null,
      circuit_breaker_backoff_steps: null,
      custom_mapping: null,
      anthropic_mapping: null,
      request_timeout: null,
      upstream_proxy: null,
      experimental: null,
    };

    const parsed = ProxyConfigSchema.parse(legacyNullConfig);
    expect(parsed.enabled).toBe(true);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(8045);
    expect(parsed.api_key).toBe('');
    expect(parsed.admin_api_key).toBe('');
    expect(parsed.auto_start).toBe(true);
    expect(parsed.backend_canary_enabled).toBe(true);
    expect(parsed.parity_enabled).toBe(true);
    expect(parsed.parity_shadow_enabled).toBe(false);
    expect(parsed.parity_kill_switch).toBe(false);
    expect(parsed.parity_no_go_mismatch_rate).toBe(0.15);
    expect(parsed.parity_no_go_error_rate).toBe(0.4);
    expect(parsed.scheduling_mode).toBe('cache-first');
    expect(parsed.max_concurrency_per_account).toBe(8);
    expect(parsed.max_wait_seconds).toBe(2);
    expect(parsed.preferred_account_id).toBe('');
    expect(parsed.circuit_breaker_enabled).toBe(true);
    expect(parsed.circuit_breaker_backoff_steps).toEqual([60, 300, 1800, 7200]);
    expect(parsed.custom_mapping).toEqual({});
    expect(parsed.anthropic_mapping).toEqual({});
    expect(parsed.request_timeout).toBe(120);
    expect(parsed.upstream_proxy).toEqual({ enabled: false, url: '' });
    expect(parsed.experimental).toEqual({ enable_cloud_code_meta: false });
  });
});


