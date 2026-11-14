import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaManager } from '../../modules/proxy-gateway/server/cert/ca-manager';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import { ReleaseAdmission } from '../../server/release-admission';
import tls from 'node:tls';
import http from 'node:http';
import http2 from 'node:http2';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Intercepted CONNECT socket lifecycle', () => {
  let gateDirectory: string;
  let admission: ReleaseAdmission;
  beforeEach(() => {
    gateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-lifecycle-test-'));
    fs.chmodSync(gateDirectory, 0o750);
    admission = new ReleaseAdmission(gateDirectory, process.getuid!());
    vi.spyOn(CaManager, 'ensureCertificates').mockReturnValue(tls.createSecureContext());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(gateDirectory, { recursive: true });
  });
  it.each(['end', 'destroy'] as const)('releases an intercepted CONNECT slot when the client calls %s before TLS', async (disconnect) => {
    const server = http.createServer();
    const ingress = new ConnectIngressService(undefined, admission);
    ingress.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const client = net.connect(port, '127.0.0.1');
    try {
      const response = await new Promise<string>((resolve, reject) => {
        client.once('error', reject);
        client.once('data', (data) => resolve(data.toString()));
        client.write('CONNECT daily-cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: daily-cloudcode-pa.googleapis.com:443\r\n\r\n');
      });
      expect(response).toContain('200 Connection Established');
      expect((ingress as any).activeSockets.size).toBe(1);
      client[disconnect]();
      await vi.waitFor(() => expect((ingress as any).activeSockets.size).toBe(0), { timeout: 1500 });
    } finally {
      client.destroy();
      await ingress.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves a complete HTTP/2 response over intercepted TLS and releases the closed session', async () => {
    const keyPath = path.join(gateDirectory, 'test.key');
    const certPath = path.join(gateDirectory, 'test.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=connect-test'], { stdio: 'ignore' });
    vi.mocked(CaManager.ensureCertificates).mockReturnValue(tls.createSecureContext({
      key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath),
    }));
    const server = http.createServer();
    const ingress = new ConnectIngressService(undefined, admission);
    const body = 'complete-response'.repeat(8192);
    vi.spyOn((ingress as any).failoverGateway, 'handleRequest').mockImplementation(async (_req, res: any) => {
      res.writeHead(200);
      res.end(body);
    });
    ingress.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
    let session: http2.ClientHttp2Session | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('error', reject);
        client.once('data', () => resolve());
        client.write('CONNECT daily-cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: daily-cloudcode-pa.googleapis.com:443\r\n\r\n');
      });
      session = http2.connect('https://daily-cloudcode-pa.googleapis.com', {
        createConnection: () => tls.connect({ socket: client,
          servername: 'daily-cloudcode-pa.googleapis.com', rejectUnauthorized: false, ALPNProtocols: ['h2'] }),
      });
      const response = await new Promise<string>((resolve, reject) => {
        session!.once('error', reject);
        const request = session!.request({ ':path': '/v1internal:loadCodeAssist' });
        let data = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { data += chunk; });
        request.once('end', () => resolve(data));
        request.once('error', reject);
        request.end();
      });
      expect(response).toBe(body);
      session.close();
      await vi.waitFor(() => expect((ingress as any).activeSockets.size).toBe(0), { timeout: 1500 });
    } finally {
      session?.destroy();
      client.destroy();
      await ingress.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});
