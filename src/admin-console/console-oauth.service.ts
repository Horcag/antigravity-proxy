import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Inject, Optional, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ReleaseAdmission, releaseAdmission } from '@/server/release-admission';
import { z } from 'zod';
import { AdminService } from '@/admin/admin.service';
interface Flow {
  owner: string; expires: number; status: 'pending' | 'processing' | 'completed' | 'error';
  account?: { id: string; email: string; name?: string | null; provider: string };
  error?: string; completion?: Promise<void>;
}
@Injectable()
export class ConsoleOAuthService implements OnModuleDestroy {
  private readonly flows = new Map<string, Flow>();
  private listener?: http.Server;
  private binding?: Promise<string | null>;
  private redirect?: URL;
  private destroying = false;
  private readonly listenerClosures = new Set<Promise<void>>();
  private readonly expiryTimer = setInterval(() => this.prune(), 1000).unref();
  constructor(private readonly admin: AdminService,
    @Optional() @Inject(ReleaseAdmission) private readonly admission: ReleaseAdmission = releaseAdmission()) {}
  private prune() {
    for (const [state, flow] of this.flows) {
      if (flow.expires <= Date.now() && flow.status === 'pending') { flow.status = 'error'; flow.error = 'OAuth attempt expired'; }
      if (flow.expires + 600_000 <= Date.now() && flow.status !== 'processing') this.flows.delete(state);
    }
    if (![...this.flows.values()].some((f) => f.status === 'pending' || f.status === 'processing')) this.closeListener();
  }
  private closeListener() {
    const listener = this.listener;
    this.listener = undefined;
    this.binding = undefined;
    if (!listener) return;
    const closure = new Promise<void>((resolve) => listener.close(() => resolve()));
    this.listenerClosures.add(closure);
    void closure.then(() => this.listenerClosures.delete(closure));
    listener.closeIdleConnections();
  }
  async onModuleDestroy() {
    this.destroying = true;
    clearInterval(this.expiryTimer);
    await this.binding;
    this.closeListener();
    await Promise.all([...this.flows.values()].map((flow) => flow.completion));
    await Promise.all([...this.listenerClosures]);
    this.flows.clear();
  }
  private async bind(redirect: URL): Promise<string | null> {
    if (this.binding) return this.binding;
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || redirect.username || redirect.password || !redirect.port) return 'Configured OAuth redirect is not a supported local HTTP callback';
    if (this.listener) return this.redirect?.href === redirect.href ? null : 'A different OAuth redirect is already active';
    this.redirect = redirect;
    const server = http.createServer((request, response) => {
      let url: URL;
      try {
        if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\') || request.url.includes('#')) throw new Error('Invalid request target');
        url = new URL(request.url, redirect.origin);
        if (url.origin !== redirect.origin) throw new Error('Invalid request origin');
      } catch { response.writeHead(400).end('Invalid callback request'); return; }
      if (request.method !== 'GET' || url.pathname !== redirect.pathname) { response.writeHead(404).end(); return; }
      const state = url.searchParams.get('state') ?? '';
      const flow = this.flows.get(state);
      if (!flow || flow.expires <= Date.now()) { response.writeHead(400).end('Invalid or expired OAuth state'); return; }
      if (url.searchParams.has('error')) {
        flow.status = 'error'; flow.error = 'Google authorization was declined';
        response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Authorization declined. Return to the console.');
        this.prune(); return;
      }
      const code = url.searchParams.get('code');
      if (!code) { response.writeHead(400).end('OAuth code missing'); return; }
      void this.complete(flow, code).then(() => {
        response.writeHead(flow.status === 'completed' ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        response.end(flow.status === 'completed' ? 'Account added. Return to the management console.' : 'Authorization failed. Return to the management console.');
        this.prune();
      }).catch(() => {
        response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('OAuth processing temporarily unavailable. Retry after the service resumes.');
      });
    });
    this.listener = server;
    this.binding = new Promise((resolve) => {
      server.once('error', () => {
        if (this.listener === server) this.listener = undefined;
        this.binding = undefined;
        resolve('Configured OAuth callback port is unavailable; paste the complete callback URL manually');
      });
      server.listen(Number(redirect.port), redirect.hostname.replace(/^\[|\]$/g, ''), () => resolve(null));
    });
    return this.binding;
  }
  async start(owner: string) {
    if (this.destroying) throw new ServiceUnavailableException('OAuth service is closing');
    this.prune();
    if (this.flows.size >= 100) throw new ConflictException('Too many pending OAuth attempts');
    const url = new URL(this.admin.getOAuthUrl().url);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    const state = randomBytes(32).toString('base64url');
    this.flows.set(state, { owner, expires: Date.now() + 600_000, status: 'pending' });
    url.searchParams.set('state', state);
    const manualFallback = await this.bind(redirect);
    return { url: url.toString(), state, expires_in: 600, mode: manualFallback ? 'manual_callback' : 'automatic_callback',
      redirect_uri: redirect.toString(), manualFallback,
      instructions: manualFallback ? 'Откройте ссылку в нужном профиле браузера. После входа Google вставьте полный адрес возврата или код авторизации.' : 'Откройте ссылку в нужном профиле браузера. После входа Google аккаунт добавится автоматически; при необходимости вставьте полный адрес возврата или код авторизации.' };
  }
  status(state: string, owner: string) {
    this.prune();
    const flow = this.find(state, owner);
    return { state, status: flow.status, account: flow.account ?? null, error: flow.error ?? null };
  }
  private find(state: string, owner: string) {
    const flow = this.flows.get(state);
    if (!flow || flow.owner !== owner) throw new BadRequestException('OAuth state invalid for this session');
    return flow;
  }
  private complete(flow: Flow, code: string): Promise<void> {
    if (flow.completion) return flow.completion;
    if (flow.status !== 'pending' || flow.expires <= Date.now()) return Promise.resolve();
    const release = this.destroying ? null : this.admission.reserve('background');
    if (!release) return Promise.reject(new ServiceUnavailableException('OAuth processing temporarily unavailable'));
    flow.status = 'processing';
    flow.completion = (async () => {
      try {
        const account = await this.admin.exchangeOAuthCode({ code });
        flow.account = { id: account.id, email: account.email, name: account.name, provider: account.provider };
        flow.status = 'completed';
      } catch { flow.status = 'error'; flow.error = 'OAuth exchange failed; start a new attempt'; }
      finally { release(); }
    })();
    return flow.completion;
  }
  async exchange(body: unknown, owner: string) {
    const parsed = z.object({ state: z.string().min(1), code: z.string().min(1) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('OAuth code and state are required');
    const { state } = parsed.data;
    let { code } = parsed.data;
    const flow = this.find(state, owner);
    if (/^https?:\/\//.test(code)) {
      let url: URL;
      try { url = new URL(code); } catch { throw new BadRequestException('Invalid callback URL'); }
      if (url.searchParams.get('state') !== state) throw new BadRequestException('OAuth state mismatch');
      code = url.searchParams.get('code') ?? '';
    }
    if (!code || flow.expires <= Date.now()) throw new BadRequestException('OAuth state expired or invalid');
    await this.complete(flow, code);
    this.prune();
    if (flow.status !== 'completed') throw new BadRequestException(flow.error ?? 'OAuth attempt failed');
    return flow.account;
  }
}
