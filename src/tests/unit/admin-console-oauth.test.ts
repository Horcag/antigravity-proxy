import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReleaseAdmission } from '@/server/release-admission';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleOAuthService } from '@/admin-console/console-oauth.service';
import type { AdminService } from '@/admin/admin.service';
async function reservePort() {
  const listener = http.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Fixture socket missing');
  return { listener, port: address.port };
}
const gateDirectories: string[] = [];
function fixture(port: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-admission-'));
  gateDirectories.push(directory);
  const admission = new ReleaseAdmission(directory, process.getuid!());
  const exchangeOAuthCode = vi.fn().mockResolvedValue({ id: 'fixture', email: 'fixture@example.test', provider: 'google', token: { access_token: 'never-return' } });
  const getOAuthUrl = () => ({ url: `https://accounts.google.com/auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/oauth-callback`)}&state=old` });
  return { service: new ConsoleOAuthService({ exchangeOAuthCode, getOAuthUrl } as unknown as AdminService, admission), exchangeOAuthCode, admission, directory };
}
describe('console OAuth callback lifecycle', () => {
  const services: ConsoleOAuthService[] = [];
  afterEach(async () => {
    await Promise.all(services.map((s) => s.onModuleDestroy())); services.length = 0; vi.restoreAllMocks();
    for (const directory of gateDirectories.splice(0)) { fs.rmSync(directory, { recursive: true, force: true }); expect(fs.existsSync(directory)).toBe(false); }
  });
  it('binds configured loopback callback, verifies state/owner, exchanges once and polls sanitized result', async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) => reservation.listener.close(() => resolve()));
    const { service, exchangeOAuthCode } = fixture(reservation.port); services.push(service);
    const flow = await service.start('session-a');
    expect(flow.mode).toBe('automatic_callback');
    expect(() => service.status(flow.state, 'session-b')).toThrow('invalid for this session');
    const invalid = await fetch(`http://127.0.0.1:${reservation.port}/oauth-callback?state=wrong&code=hidden-code`);
    expect(invalid.status).toBe(400); expect(exchangeOAuthCode).not.toHaveBeenCalled();
    const callback = await fetch(`http://127.0.0.1:${reservation.port}/oauth-callback?state=${flow.state}&code=hidden-code`);
    expect(callback.status).toBe(200); expect(await callback.text()).not.toContain('hidden-code');
    const status = service.status(flow.state, 'session-a');
    expect(status).toMatchObject({status: 'completed', account: { id: 'fixture' }});
    expect(JSON.stringify(status)).not.toContain('never-return');
    await service.exchange({ state: flow.state, code: 'hidden-code' }, 'session-a');
    expect(exchangeOAuthCode).toHaveBeenCalledTimes(1);
    await expect(fetch(`http://127.0.0.1:${reservation.port}/oauth-callback?state=${flow.state}&code=other`)).rejects.toThrow();
  });
  it('reports occupied callback port and supports validated manual URL fallback', async () => {
    const reservation = await reservePort();
    try {
      const { service, exchangeOAuthCode } = fixture(reservation.port); services.push(service);
      const flow = await service.start('session-a');
      expect(flow.mode).toBe('manual_callback'); expect(flow.manualFallback).toContain('unavailable');
      await expect(service.exchange({ state: flow.state, code: 'http://localhost/callback?state=wrong&code=secret' }, 'session-a')).rejects.toThrow('mismatch');
      expect(exchangeOAuthCode).not.toHaveBeenCalled();
      await service.exchange({ state: flow.state, code: `http://localhost/callback?state=${flow.state}&code=secret` }, 'session-a');
      expect(exchangeOAuthCode).toHaveBeenCalledWith({ code: 'secret' });
    } finally { await new Promise<void>((resolve) => reservation.listener.close(() => resolve())); }
  });
  it('completes a copied link with a bare code while keeping other profile attempts separate', async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) => reservation.listener.close(() => resolve()));
    const { service, exchangeOAuthCode } = fixture(reservation.port); services.push(service);
    const first = await service.start('session-a');
    const second = await service.start('session-a');
    expect(new URL(first.url).searchParams.get('state')).toBe(first.state);
    expect(first.state).not.toBe(second.state);
    expect(first.instructions).not.toContain('popup');
    await service.exchange({ state: first.state, code: 'profile-a-code' }, 'session-a');
    expect(exchangeOAuthCode).toHaveBeenCalledWith({ code: 'profile-a-code' });
    expect(service.status(first.state, 'session-a').status).toBe('completed');
    expect(service.status(second.state, 'session-a').status).toBe('pending');
    const callback = await fetch(`http://127.0.0.1:${reservation.port}/oauth-callback?state=${second.state}&code=profile-b-code`);
    expect(callback.status).toBe(200);
    expect(exchangeOAuthCode).toHaveBeenCalledTimes(2);
    expect(exchangeOAuthCode).toHaveBeenLastCalledWith({ code: 'profile-b-code' });
  });
  it('rejects release-gated and closing callbacks without consuming their code', async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) => reservation.listener.close(() => resolve()));
    const { service, exchangeOAuthCode, admission, directory } = fixture(reservation.port); services.push(service);
    const flow = await service.start('session-a');
    const callback = `http://127.0.0.1:${reservation.port}/oauth-callback?state=${flow.state}&code=fixture-code`;
    fs.writeFileSync(path.join(directory, 'request'), `queue_${'a'.repeat(32)}`, {mode: 0o600});
    expect((await fetch(callback)).status).toBe(503);
    expect(service.status(flow.state, 'session-a').status).toBe('pending');
    fs.unlinkSync(path.join(directory, 'request'));
    admission.beginClose();
    expect((await fetch(callback)).status).toBe(503);
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
    expect(admission.status().activeBackgroundTasks).toBe(0);
    admission.prepareStart();
    expect((await fetch(callback)).status).toBe(200);
    expect(exchangeOAuthCode).toHaveBeenCalledTimes(1);
  });
  it('holds release admission and waits for active credential exchange before destruction completes', async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) => reservation.listener.close(() => resolve()));
    const { service, exchangeOAuthCode, admission } = fixture(reservation.port); services.push(service);
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const deferred = new Promise<void>((resolve) => { finish = resolve; });
    let writes = 0;
    exchangeOAuthCode.mockImplementation(async () => { began(); await deferred; writes++; return { id: 'fixture', email: 'fixture@example.test', provider: 'google' }; });
    const flow = await service.start('session-a');
    const response = fetch(`http://127.0.0.1:${reservation.port}/oauth-callback?state=${flow.state}&code=fixture-code`);
    await started;
    expect(admission.status().activeBackgroundTasks).toBe(1);
    let destroyed = false;
    const destroy = service.onModuleDestroy().then(() => { destroyed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyed).toBe(false); expect(writes).toBe(0);
    finish();
    expect((await response).status).toBe(200);
    await destroy;
    expect(writes).toBe(1); expect(admission.status().activeBackgroundTasks).toBe(0);
    await expect(fetch(`http://127.0.0.1:${reservation.port}/oauth-callback`)).rejects.toThrow();
  });
  it('returns 400 for malformed raw callback targets and continues serving valid requests', async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) => reservation.listener.close(() => resolve()));
    const { service, exchangeOAuthCode } = fixture(reservation.port); services.push(service);
    const flow = await service.start('session-a');
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(reservation.port, '127.0.0.1');
      let bytes = '';
      socket.on('connect', () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      socket.on('data', (chunk) => { bytes += chunk.toString(); });
      socket.on('end', () => resolve(bytes)); socket.on('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1.1 400/);
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
    expect((await fetch(`http://127.0.0.1:${reservation.port}/oauth-callback?state=${flow.state}&code=fixture-code`)).status).toBe(200);
  });
  it('expires pending states and closes only its owned listener', async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) => reservation.listener.close(() => resolve()));
    const { service, exchangeOAuthCode } = fixture(reservation.port); services.push(service);
    const flow = await service.start('session-a');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 600_001);
    expect(service.status(flow.state, 'session-a')).toMatchObject({ status: 'error', error: 'OAuth attempt expired' });
    await expect(service.exchange({ state: flow.state, code: 'secret' }, 'session-a')).rejects.toThrow('expired');
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
    await expect(fetch(`http://127.0.0.1:${reservation.port}/oauth-callback`)).rejects.toThrow();
  });
});
