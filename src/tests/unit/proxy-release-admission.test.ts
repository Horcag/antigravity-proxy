import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import tls from 'node:tls';
import dns from 'node:dns';
import Fastify from 'fastify';
import { installReleaseHooks, ReleaseAdmission, awaitDrain, awaitShutdown } from '../../server/release-admission';
import { ConnectIngressService } from '../../modules/proxy-gateway/server/connect-ingress.service';
import { CaManager } from '../../modules/proxy-gateway/server/cert/ca-manager';
import { CloudCodeFailoverGateway } from '../../modules/proxy-gateway/server/cloudcode-failover-gateway';

const token = 'queue_' + 'a'.repeat(32);
let directory: string;
let admission: ReleaseAdmission;
const cleanup: (() => Promise<unknown>)[] = [];
function gate(value = token) { fs.writeFileSync(path.join(directory, 'request'), value, { mode: 0o640 }); }
function ackExists() { return fs.existsSync(path.join(directory, 'ack/quiesce.json')); }
function response() {
  return Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn(), writableFinished: false });
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-release-admission-'));
  fs.chmodSync(directory, 0o750);
  fs.mkdirSync(path.join(directory, 'ack'), { mode: 0o770 });
  admission = new ReleaseAdmission(directory, process.getuid!());
  admission.start();
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  admission.stop();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true });
});

describe('native release admission', () => {
  it('allows ungated native work and denies gated work with a durable identity ACK', () => {
    const release = admission.reserve('request')!;
    expect(release).toBeTypeOf('function');
    gate();
    admission.refresh();
    expect(admission.reserve('request')).toBeNull();
    expect(ackExists()).toBe(false);
    release();
    const ack = JSON.parse(fs.readFileSync(path.join(directory, 'ack/quiesce.json'), 'utf8'));
    expect(ack).toMatchObject({ schemaVersion: 1, pid: process.pid, token, activeRequests: 0, activeTunnels: 0 });
    expect(ack.startTicks).toMatch(/^\d+$/);
    expect(ack.bootId).toMatch(/^[a-f0-9-]{36}$/);
    expect(ack.observedAtMs).toBeGreaterThan(Date.now() - 1000);
    expect(fs.statSync(path.join(directory, 'ack/quiesce.json')).mode & 0o777).toBe(0o640);
  });

  it('fails closed when production ancestry is service-owned or writable even with an absent gate', () => {
    const lstat = fs.lstatSync;
    for (const unsafe of [{ uid: process.getuid!() || 1000, mode: 0o40750 }, { uid: 0, mode: 0o40770 }]) {
      vi.spyOn(fs, 'lstatSync').mockImplementation(((filename: fs.PathLike, ...args: any[]) => {
        if (String(filename) === '/var/lib/antigravity-proxy-release-controller') {
          return { ...unsafe, isDirectory: () => true };
        }
        if (String(filename).startsWith('/var/lib/antigravity-proxy-release-controller/gate')) {
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        }
        return (lstat as any)(filename, ...args);
      }) as typeof fs.lstatSync);
      expect(new ReleaseAdmission().gate().state).toBe('invalid');
      vi.restoreAllMocks();
    }
  });

  it('publishes group-readable heartbeat and ACK even under restrictive service umask', () => {
    const previous = process.umask(0o077);
    try {
      gate();
      admission.refresh();
      for (const name of ['status.json', 'quiesce.json']) {
        expect(fs.statSync(path.join(directory, 'ack', name)).mode & 0o777).toBe(0o640);
      }
    } finally { process.umask(previous); }
  });

  it('holds a streaming response until finish/close/error and releases exactly once', () => {
    const stream = response();
    expect(admission.observeResponse(stream)).toBe(true);
    gate();
    admission.refresh();
    expect(admission.status().activeRequests).toBe(1);
    expect(ackExists()).toBe(false);
    for (const event of ['finish', 'close', 'error']) stream.emit(event);
    expect(admission.status().activeRequests).toBe(0);
    expect(ackExists()).toBe(true);
  });

  it('keeps disconnected asynchronous upstream work reserved until it settles', async () => {
    let complete!: () => void;
    const work = new Promise<void>((resolve) => { complete = resolve; });
    const stream = response();
    admission.runResponse(stream, () => work);
    gate();
    stream.emit('close');
    expect(ackExists()).toBe(false);
    expect(admission.status().activeRequests).toBe(1);
    complete();
    await awaitDrain(() => admission.status().activeRequests === 0);
    expect(ackExists()).toBe(true);
  });

  it('rechecks a gate appearing between observation and reservation', () => {
    const original = admission.gate.bind(admission);
    let first = true;
    vi.spyOn(admission, 'gate').mockImplementation(() => {
      const observed = original();
      if (first) { first = false; gate(); }
      return observed;
    });
    expect(admission.reserve('request')).toBeNull();
    expect(admission.status().activeRequests).toBe(0);
  });

  it('fails closed for corrupt, unreadable, symlinked, or unsafe-owner gate inputs', () => {
    gate('not-a-token');
    expect(admission.reserve('request')).toBeNull();
    expect(ackExists()).toBe(false);
    gate();
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((filename: fs.PathLike, ...args: any[]) => {
      if (filename === path.join(directory, 'request')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (open as any)(filename, ...args);
    }) as typeof fs.openSync);
    expect(admission.reserve('tunnel')).toBeNull();
    vi.restoreAllMocks();
    fs.unlinkSync(path.join(directory, 'request'));
    fs.symlinkSync(path.join(directory, 'missing'), path.join(directory, 'request'));
    expect(admission.reserve('request')).toBeNull();
    fs.unlinkSync(path.join(directory, 'request'));
    gate();
    expect(new ReleaseAdmission(directory, process.getuid!() + 1).reserve('request')).toBeNull();
  });

  it('rejects a gate changed during its stable file read', () => {
    gate();
    const read = fs.readFileSync;
    let changed = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filename: any, ...args: any[]) => {
      const value = (read as any)(filename, ...args);
      if (typeof filename === 'number' && !changed) {
        changed = true;
        fs.writeFileSync(path.join(directory, 'request'), 'queue_' + 'b'.repeat(32));
      }
      return value;
    }) as typeof fs.readFileSync);
    expect(admission.gate().state).toBe('invalid');
  });

  it('removes old ACK after work, malformed gate, or shutdown; tracks tunnel reservations', () => {
    const tunnel = admission.reserve('tunnel')!;
    const dns = admission.reserve('tunnel', true)!;
    gate();
    tunnel();
    expect(admission.status().activeTunnels).toBe(1);
    expect(ackExists()).toBe(false);
    dns();
    expect(ackExists()).toBe(true);
    gate('corrupt');
    admission.refresh();
    expect(ackExists()).toBe(false);
    gate();
    admission.refresh();
    admission.beginClose();
    expect(ackExists()).toBe(false);
    expect(admission.reserve('request')).toBeNull();
  });

  it('tracks background promises and defers startup/timer dispatch while gated', async () => {
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = admission.runBackground(work);
    expect(admission.status().activeBackgroundTasks).toBe(1);
    gate();
    admission.refresh();
    expect(ackExists()).toBe(false);
    await admission.runBackground(work);
    expect(work).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    expect(ackExists()).toBe(true);
  });

  it('keeps real async Fastify handler work after client disconnect and handles rejection', async () => {
    const app = Fastify();
    cleanup.push(() => app.close());
    installReleaseHooks(app, admission);
    let finish!: () => void;
    app.get('/delayed', async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      throw new Error('delayed failure');
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    const request = http.get(`http://127.0.0.1:${address.port}/delayed`);
    request.on('error', () => { /* Intentional disconnect. */ });
    await awaitDrain(() => !!finish);
    request.destroy();
    gate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    admission.refresh();
    expect(admission.status().activeRequests).toBe(1);
    expect(ackExists()).toBe(false);
    finish();
    await awaitDrain(() => ackExists());
  });

  it('reads stable root-owned boot-id fallback when proc sys is hidden', () => {
    const boot = admission.status().bootId;
    fs.writeFileSync(path.join(directory, 'boot-id'), boot, { mode: 0o640 });
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (filename === '/proc/sys/kernel/random/boot_id') throw Object.assign(new Error('hidden'), { code: 'EACCES' });
      return (read as any)(filename, ...args);
    }) as typeof fs.readFileSync);
    expect(new ReleaseAdmission(directory, process.getuid!()).status().bootId).toBe(boot);
    fs.chmodSync(path.join(directory, 'boot-id'), 0o666);
    expect(() => new ReleaseAdmission(directory, process.getuid!())).toThrow();
  });

  it('retains real HTTP streaming work while gated and permits only GET health', async () => {
    const app = Fastify();
    cleanup.push(() => app.close());
    installReleaseHooks(app, admission);
    let finish!: () => void;
    app.get('/stream', (_request, reply) => {
      reply.hijack();
      reply.raw.write('accepted');
      finish = () => reply.raw.end('completed');
    });
    app.get('/health', () => ({ ok: true }));
    app.post('/health', () => ({ action: true }));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    const completed = new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${address.port}/stream`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    await awaitDrain(() => !!finish);
    gate();
    admission.refresh();
    expect(ackExists()).toBe(false);
    expect((await app.inject('/stream')).statusCode).toBe(503);
    const health = await app.inject('/health');
    expect(health.json().release_admission).toMatchObject({ token, activeRequests: 1 });
    expect((await app.inject({ method: 'POST', url: '/health' })).statusCode).toBe(503);
    finish();
    expect(await completed).toBe('acceptedcompleted');
    await awaitDrain(() => ackExists());
  });

  it('rejects incomplete async shutdown without claiming completion', async () => {
    await expect(awaitShutdown(new Promise<void>(() => {}), 5)).rejects.toThrow('shutdown did not complete');
    await expect(awaitShutdown(Promise.resolve('closed'), 5)).resolves.toBe('closed');
  });

  it('counts outstanding DNS after disconnect and awaits it on bounded shutdown', async () => {
    let completeDns!: (error: null, addresses: { address: string; family: number }[]) => void;
    vi.spyOn(CaManager, 'ensureCertificates').mockReturnValue(tls.createSecureContext());
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: unknown, _options: unknown, callback: typeof completeDns) => {
      completeDns = callback;
    }) as any);
    const ingress = new ConnectIngressService(undefined, admission);
    cleanup.push(() => ingress.close());
    const server = http.createServer();
    ingress.attach(server);
    const client = Object.assign(new EventEmitter(), {
      remoteAddress: '127.0.0.1', setTimeout: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn(),
    });
    client.destroy.mockImplementation(() => { client.emit('close'); });
    server.emit('connect', { url: 'example.com:443' }, client, Buffer.alloc(0));
    expect(admission.status().activeTunnels).toBe(2);
    gate();
    client.emit('close');
    expect(admission.status().activeTunnels).toBe(1);
    expect(ackExists()).toBe(false);
    await expect(ingress.close(20)).rejects.toThrow('drain did not complete');
    expect(ingress.isAttached()).toBe(true);
    completeDns(null, [{ address: '93.184.216.34', family: 4 }]);
    await ingress.close();
    expect(admission.status().activeTunnels).toBe(0);
  });

  it('checks each intercepted HTTP2 request and rejects new CONNECT tunnels while gated', async () => {
    const fake = Object.assign(new EventEmitter(), { close: (callback: () => void) => callback() });
    let handler!: (req: any, res: any) => void;
    vi.spyOn(CaManager, 'ensureCertificates').mockReturnValue(tls.createSecureContext());
    vi.spyOn(http2, 'createSecureServer').mockImplementation(((_opts: unknown, callback: typeof handler) => {
      handler = callback;
      return fake;
    }) as any);
    const gateway = vi.spyOn(CloudCodeFailoverGateway.prototype, 'handleRequest').mockResolvedValue(undefined);
    const ingress = new ConnectIngressService(undefined, admission);
    cleanup.push(() => ingress.close());
    const server = http.createServer();
    ingress.attach(server);
    const client = Object.assign(new EventEmitter(), {
      remoteAddress: '127.0.0.1', setTimeout: vi.fn(), write: vi.fn(), end: vi.fn(),
      destroy: vi.fn(), unshift: vi.fn(),
    });
    client.destroy.mockImplementation(() => { client.emit('close'); });
    server.emit('connect', { url: 'daily-cloudcode-pa.googleapis.com:443' }, client, Buffer.alloc(0));
    expect(admission.status().activeTunnels).toBe(1);
    const first = response();
    handler({ headers: {} }, first);
    await Promise.resolve();
    expect(gateway).toHaveBeenCalledTimes(1);
    gate();
    const next = response();
    handler({ headers: {} }, next);
    expect(next.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(gateway).toHaveBeenCalledTimes(1);
    const denied = Object.assign(new EventEmitter(), client, { end: vi.fn() });
    server.emit('connect', { url: 'daily-cloudcode-pa.googleapis.com:443' }, denied, Buffer.alloc(0));
    expect(denied.end).toHaveBeenCalledWith(expect.stringContaining('503'));
    first.emit('finish');
    expect(ackExists()).toBe(false);
    client.emit('close');
    await awaitDrain(() => ackExists());
    expect(admission.status().activeTunnels).toBe(0);
  });
});
