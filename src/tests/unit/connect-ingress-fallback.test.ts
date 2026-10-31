import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaManager } from '../../modules/proxy-gateway/server/cert/ca-manager';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import { ReleaseAdmission } from '../../server/release-admission';
import tls from 'node:tls';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('ConnectIngressService IPv4 preference and sequential fallback', () => {
  let gateDirectory: string;
  let admission: ReleaseAdmission;

  beforeEach(() => {
    gateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-ingress-fallback-test-'));
    fs.chmodSync(gateDirectory, 0o750);
    admission = new ReleaseAdmission(gateDirectory, process.getuid!());
    vi.spyOn(CaManager, 'ensureCertificates').mockReturnValue(tls.createSecureContext());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(gateDirectory, { recursive: true, force: true });
  });

  it('prefers IPv4 over IPv6 and falls back to next IP on connect error', async () => {
    const dns = await import('node:dns');
    const originalLookup = dns.lookup.bind(dns);
    const lookupSpy = vi.spyOn(dns.default || dns, 'lookup').mockImplementation(((host: any, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (host === 'fallback.example.com') {
        cb(null, [
          { address: '2001:4860:4845:400::', family: 6 },
          { address: '198.51.100.1', family: 4 },
          { address: '198.51.100.2', family: 4 },
        ]);
        return;
      }
      return (originalLookup as any)(host, options, callback);
    }) as any);

    const attemptedHosts: string[] = [];
    const originalConnect = net.connect;
    const netConnectSpy = vi.spyOn(net, 'connect').mockImplementation((...args: any[]) => {
      if (typeof args[0] === 'object' && args[0].port === 443) {
        const host = args[0].host;
        attemptedHosts.push(host);
        const sock = new net.Socket();
        const cb = typeof args[1] === 'function' ? args[1] : undefined;
        if (host === '198.51.100.1') {
          process.nextTick(() => sock.emit('error', new Error('ECONNREFUSED')));
          return sock;
        }
        if (host === '198.51.100.2') {
          if (cb) process.nextTick(cb);
          return sock;
        }
      }
      return (originalConnect as any)(...args);
    });

    const server = http.createServer();
    const ingress = new ConnectIngressService(undefined, admission);
    ingress.attach(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const resp = await new Promise<string>((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write('CONNECT fallback.example.com:443 HTTP/1.1\r\nHost: fallback.example.com:443\r\n\r\n');
      });
      client.on('data', (d) => {
        client.destroy();
        resolve(d.toString('utf-8'));
      });
    });

    expect(resp).toContain('HTTP/1.1 200 Connection Established');
    expect(attemptedHosts).toEqual(['198.51.100.1', '198.51.100.2']);

    lookupSpy.mockRestore();
    netConnectSpy.mockRestore();
    await ingress.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns HTTP 502 when all IP addresses fail to connect', async () => {
    const dns = await import('node:dns');
    const originalLookup = dns.lookup.bind(dns);
    const lookupSpy = vi.spyOn(dns.default || dns, 'lookup').mockImplementation(((host: any, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (host === 'fail.example.com') {
        cb(null, [
          { address: '198.51.100.1', family: 4 },
        ]);
        return;
      }
      return (originalLookup as any)(host, options, callback);
    }) as any);

    const originalConnect = net.connect;
    const netConnectSpy = vi.spyOn(net, 'connect').mockImplementation((...args: any[]) => {
      if (typeof args[0] === 'object' && args[0].port === 443) {
        const sock = new net.Socket();
        process.nextTick(() => sock.emit('error', new Error('ECONNREFUSED')));
        return sock;
      }
      return (originalConnect as any)(...args);
    });

    const server = http.createServer();
    const ingress = new ConnectIngressService(undefined, admission);
    ingress.attach(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const resp = await new Promise<string>((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write('CONNECT fail.example.com:443 HTTP/1.1\r\nHost: fail.example.com:443\r\n\r\n');
      });
      client.on('data', (d) => {
        client.destroy();
        resolve(d.toString('utf-8'));
      });
    });

    expect(resp).toContain('HTTP/1.1 502 Bad Gateway');

    lookupSpy.mockRestore();
    netConnectSpy.mockRestore();
    await ingress.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
