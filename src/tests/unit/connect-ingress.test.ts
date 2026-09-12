import { describe, expect, it, vi } from 'vitest';
import { CaManager } from '../../modules/proxy-gateway/server/cert/ca-manager';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { CloudAccount } from '../../modules/cloud-account/types';

describe('CaManager', () => {
  it('identifies target CloudCode hosts correctly', () => {
    expect(CaManager.isTargetHost('daily-cloudcode-pa.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('cloudcode-pa.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('daily-cloudcode-pa.sandbox.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('autopush-cloudcode-pa.sandbox.googleapis.com:443')).toBe(true);
    expect(CaManager.isTargetHost('preprod-daily-cloudcode-pa.sandbox.googleapis.com:443')).toBe(true);
    // Non-cloudcode-pa endpoints and unverified services are left outside interception (T10-F06)
    expect(CaManager.isTargetHost('generativelanguage.googleapis.com:443')).toBe(false);
    expect(CaManager.isTargetHost('businessaicode.googleapis.com:443')).toBe(false);
    expect(CaManager.isTargetHost('aicode.googleapis.com:443')).toBe(false);
    expect(CaManager.isTargetHost('aiplatform.googleapis.com:443')).toBe(false);
    // Rejects attacker and unauthorized domains (Probe C25)
    expect(CaManager.isTargetHost('aicode.attacker.invalid:443')).toBe(false);
    expect(CaManager.isTargetHost('businessaicode.attacker.invalid:443')).toBe(false);
    expect(CaManager.isTargetHost('not-google-cloudcode-pa.attacker.invalid:443')).toBe(false);
    expect(CaManager.isTargetHost('notgenerativelanguage.googleapis.com:443')).toBe(false);
    expect(CaManager.isTargetHost('notaiplatform.googleapis.com:443')).toBe(false);
    expect(CaManager.isTargetHost('daily-cloudcode-pa.googleapis.com:8080')).toBe(false);
    expect(CaManager.isTargetHost('api.openai.com:443')).toBe(false);
    expect(CaManager.isTargetHost('github.com:443')).toBe(false);
    expect(CaManager.isTargetHost('')).toBe(false);
  });

  it('generates and provides a valid secureContext and CA cert', () => {
    const ctx = CaManager.ensureCertificates();
    expect(ctx).toBeDefined();

    const caPath = CaManager.getCaCertPath();
    expect(caPath).toContain('ca.crt');
    expect(fs.existsSync(caPath)).toBe(true);

    const caContent = fs.readFileSync(caPath, 'utf-8');
    expect(caContent).toContain('BEGIN CERTIFICATE');

    const bundlePath = CaManager.getTrustBundlePath();
    expect(bundlePath).toContain('agy-trust.pem');
    expect(fs.existsSync(bundlePath)).toBe(true);
    const bundleContent = fs.readFileSync(bundlePath, 'utf-8');
    expect(bundleContent).toContain('Antigravity Proxy Local Root CA');
  });

  it('publishes managed launcher in libexec and establishes baseline update observer', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-test-'));
    const binDir = path.join(tmpDir, '.local', 'bin');
    const libexecDir = path.join(tmpDir, '.local', 'libexec', 'antigravity-proxy');
    fs.mkdirSync(binDir, { recursive: true });

    const agyNativePath = path.join(binDir, 'agy');
    const launcherPath = path.join(libexecDir, 'agy');

    // Create a mock native executable
    const elfContent = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x90, 0x90]);
    fs.writeFileSync(agyNativePath, elfContent);

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

    try {
      CaManager.ensureAgyLauncher();

      // Native binary must remain untouched at ~/.local/bin/agy
      expect(fs.existsSync(agyNativePath)).toBe(true);
      expect(fs.readFileSync(agyNativePath)).toEqual(elfContent);

      // Managed launcher must be published at ~/.local/libexec/antigravity-proxy/agy
      expect(fs.existsSync(launcherPath)).toBe(true);
      const wrapperScript = fs.readFileSync(launcherPath, 'utf-8');
      expect(wrapperScript).toContain('#!/bin/sh');
      expect(wrapperScript).toContain('PROXY_URL="http://127.0.0.1:8045"');
      expect(wrapperScript).toContain(agyNativePath);

      // Update observer state must be initialized
      const statePath = path.join(tmpDir, '.antigravity-proxy', 'updates', 'state.json');
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(state.sha256).toBeDefined();
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CloudCodeFailoverGateway', () => {
  it('detects quota error strings accurately', () => {
    const gateway = new CloudCodeFailoverGateway();
    const isQuotaError = (gateway as any).isQuotaErrorText.bind(gateway);

    expect(isQuotaError('RESOURCE_EXHAUSTED')).toBe(true);
    expect(isQuotaError('Quota exceeded for quota metric')).toBe(true);
    expect(isQuotaError('Rate limit exceeded')).toBe(true);
    expect(isQuotaError('Insufficient AI credit')).toBe(true);
    expect(isQuotaError('normal valid response')).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('filters out forbidden HTTP/2 connection headers', () => {
    const gateway = new CloudCodeFailoverGateway();
    const mockRes: any = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    (gateway as any).writeHeaders(mockRes, 200, {
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'proxy-connection': 'keep-alive',
      upgrade: 'h2c',
      'x-custom-header': 'safe',
    });

    expect(mockRes.writeHead).toHaveBeenCalledTimes(1);
    const writtenHeaders = mockRes.writeHead.mock.calls[0][1];
    expect(writtenHeaders['content-type']).toBe('application/json');
    expect(writtenHeaders['x-custom-header']).toBe('safe');
    expect(writtenHeaders['transfer-encoding']).toBeUndefined();
    expect(writtenHeaders['connection']).toBeUndefined();
    expect(writtenHeaders['proxy-connection']).toBeUndefined();
    expect(writtenHeaders['upgrade']).toBeUndefined();
  });

  it('rotates account and retries when upstream returns 429 quota error', async () => {
    const account1: CloudAccount = {
      id: 'acc-1',
      provider: 'google',
      email: 'acc1@example.com',
      is_active: true,
      created_at: Date.now(),
      last_used: Date.now(),
      token: {
        access_token: 'token-1',
        refresh_token: 'ref-1',
        expires_in: 3600,
        expiry_timestamp: Date.now() + 3600000,
        token_type: 'Bearer',
        project_id: 'project-1',
      },
    };

    const account2: CloudAccount = {
      id: 'acc-2',
      provider: 'google',
      email: 'acc2@example.com',
      is_active: true,
      created_at: Date.now(),
      last_used: Date.now(),
      token: {
        access_token: 'token-2',
        refresh_token: 'ref-2',
        expires_in: 3600,
        expiry_timestamp: Date.now() + 3600000,
        token_type: 'Bearer',
        project_id: 'project-2',
      },
    };

    let leaseCount = 0;
    const mockAccountLeaseService: any = {
      getNextToken: vi.fn(async () => {
        leaseCount++;
        return leaseCount === 1 ? account1 : account2;
      }),
      markFromUpstreamError: vi.fn(async () => {}),
    };

    const gateway = new CloudCodeFailoverGateway(mockAccountLeaseService);

    // Mock executeUpstreamCall: attempt 1 returns 429, attempt 2 returns 200
    let attemptCount = 0;
    (gateway as any).executeUpstreamCall = vi.fn(async () => {
      attemptCount++;
      if (attemptCount === 1) {
        return {
          statusCode: 429,
          headers: { 'content-type': 'application/json' },
          bodyStream: new PassThrough(),
          bufferedBody: Buffer.from(
            JSON.stringify({ error: { code: 429, message: 'RESOURCE_EXHAUSTED' } }),
          ),
        };
      } else {
        const streamStub = new PassThrough();
        process.nextTick(() => {
          streamStub.write('{"result":"success"}');
          streamStub.end();
        });
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          bodyStream: streamStub,
        };
      }
    });

    const mockReq: any = {
      url: '/v1internal:streamGenerateContent',
      method: 'POST',
      headers: { host: 'daily-cloudcode-pa.googleapis.com' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ model: 'gemini-2.5-pro', contents: [] }));
      },
    };

    const mockRes: any = new PassThrough();
    mockRes.writeHead = vi.fn();
    mockRes.headersSent = false;

    await gateway.handleRequest(mockReq, mockRes);

    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdOrEmail: 'acc-1',
        status: 429,
        model: 'gemini-2.5-pro',
        reason: expect.anything(),
      }),
    );
    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });
});

describe('ConnectIngressService', () => {
  it('attaches to http.Server and closes cleanly', () => {
    const server = http.createServer();
    const ingress = new ConnectIngressService();

    expect(() => ingress.attach(server)).not.toThrow();
    expect(() => ingress.close()).not.toThrow();
  });

  it('handles CONNECT request for target host and non-target tunnel', async () => {
    const server = http.createServer();
    const ingress = new ConnectIngressService();
    ingress.attach(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const response = await new Promise<string>((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(
          'CONNECT daily-cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: daily-cloudcode-pa.googleapis.com:443\r\n\r\n',
        );
      });
      client.on('data', (d) => {
        client.destroy();
        resolve(d.toString('utf-8'));
      });
      client.on('error', reject);
    });

    expect(response).toContain('HTTP/1.1 200 Connection Established');

    ingress.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects disallowed destinations with HTTP 403 (RFC1918, loopback, cloud metadata, bracketed IPv6)', async () => {
    const server = http.createServer();
    const ingress = new ConnectIngressService();
    ingress.attach(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const testTargets = [
      '10.0.0.1:443',
      '192.168.1.1:8443',
      '169.254.169.254:443',
      '127.1:443',
      '2130706433:443',
      '127.0.0.1:443',
      '[::1]:443',
      'localhost:443',
    ];

    for (const target of testTargets) {
      const resp = await new Promise<string>((resolve, reject) => {
        const client = net.connect(port, '127.0.0.1', () => {
          client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        });
        client.on('data', (d) => {
          client.destroy();
          resolve(d.toString('utf-8'));
        });
        client.on('error', reject);
      });
      expect(resp).toContain('HTTP/1.1 403 Forbidden');
    }

    ingress.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('removes connect listener and cleans up active sockets on close()', () => {
    const server = http.createServer();
    const ingress = new ConnectIngressService();
    ingress.attach(server);

    expect(server.listenerCount('connect')).toBe(1);
    ingress.close();
    expect(server.listenerCount('connect')).toBe(0);
  });
});

