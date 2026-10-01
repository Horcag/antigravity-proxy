import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';

const ROOT = '/var/lib/antigravity-proxy-release-controller/gate';
const TOKEN = /^queue_[a-f0-9]{32}$/;
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Gate = { state: 'open' | 'gated' | 'invalid'; token: string | null };
export type ReleaseStatus = Omit<Gate, 'state'> & {
  state: Gate['state'] | 'closing';
  schemaVersion: 1; pid: number; startTicks: string; bootId: string;
  observedAtMs: number; activeRequests: number; activeTunnels: number; activeBackgroundTasks: number;
  closing: boolean; ready: boolean;
};

function identity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.uid, stat.mode].join(':');
}
function parents(directory: string, production = directory === ROOT || directory === path.join(ROOT, 'ack')): void {
  let current = directory;
  for (;;) {
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || (production ? info.uid !== 0 || Boolean(info.mode & (current === path.join(ROOT, 'ack') ? 0o007 : 0o022)) :
      info.uid !== 0 && info.uid !== process.getuid?.())) throw new Error('Unsafe gate parent');
    const next = path.dirname(current);
    if (next === current) return;
    current = next;
  }
}
function stableFile(filename: string, owner: number): string {
  parents(path.dirname(filename));
  const parent = fs.lstatSync(path.dirname(filename));
  if (parent.uid !== owner || (parent.mode & 0o022)) throw new Error('Writable gate parent');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== owner || before.nlink !== 1 ||
        (before.mode & 0o022) || before.size > 128) throw new Error('Unsafe gate file');
    const value = fs.readFileSync(fd, 'utf8');
    if (identity(before) !== identity(fs.fstatSync(fd)) ||
        identity(before) !== identity(fs.lstatSync(filename))) throw new Error('Gate changed during read');
    return value.trim();
  } finally { fs.closeSync(fd); }
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Synchronous admission establishes a reservation without yielding to another request. */
export class ReleaseAdmission {
  private readonly responses = new WeakMap<EventEmitter, { done: boolean; pending: number; release: () => void }>();
  private background = 0;
  private requests = 0;
  private tunnels = 0;
  private closing = false;
  private timer?: NodeJS.Timeout;
  private publishing = false;
  private publicationReady = false;
  private readonly startTicks: string;
  private readonly bootId: string;

  constructor(private readonly directory = ROOT, private readonly owner = 0) {
    this.startTicks = fs.readFileSync('/proc/self/stat', 'utf8').split(')').at(-1)!.trim().split(/\s+/)[19];
    if (!/^\d+$/.test(this.startTicks)) throw new Error('Process start identity unavailable');
    let boot: string;
    try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
    catch { boot = stableFile(path.join(directory, 'boot-id'), owner); }
    if (!BOOT.test(boot)) throw new Error('Boot identity unavailable');
    this.bootId = boot;
  }

  gate(): Gate {
    try {
      const token = stableFile(path.join(this.directory, 'request'), this.owner);
      if (!TOKEN.test(token)) return { state: 'invalid', token: null };
      return { state: 'gated', token };
    } catch (error) {
      // Missing gate is the normal ungated state; unsafe existing parents fail closed.
      if (missing(error)) {
        try {
          let ancestor = this.directory;
          while (true) {
            try {
              const info = fs.lstatSync(ancestor);
              if (!info.isDirectory() || (this.directory === ROOT ? info.uid !== 0 || Boolean(info.mode & 0o022) :
                info.uid !== 0 && info.uid !== process.getuid?.())) throw new Error('Unsafe gate ancestry');
            } catch (err) { if (!missing(err)) throw err; }
            const next = path.dirname(ancestor);
            if (next === ancestor) break;
            ancestor = next;
          }
          if (fs.existsSync(this.directory)) {
            parents(this.directory);
            const info = fs.lstatSync(this.directory);
            if (info.uid !== this.owner || (info.mode & 0o022)) throw new Error('Writable gate parent');
          }
          return { state: 'open', token: null };
        } catch { /* fail closed */ }
      }
      return { state: 'invalid', token: null };
    }
  }

  private count(kind: 'request' | 'tunnel' | 'background', delta: number): void {
    if (kind === 'request') this.requests += delta;
    else if (kind === 'tunnel') this.tunnels += delta;
    else this.background += delta;
  }

  reserve(kind: 'request' | 'tunnel' | 'background', alreadyAdmitted = false): (() => void) | null {
    if (!alreadyAdmitted && (this.closing || this.gate().state !== 'open')) return null;
    this.count(kind, 1);
    // Re-read after reservation so a gate created at the first read cannot admit work.
    if (!alreadyAdmitted && this.gate().state !== 'open') {
      this.count(kind, -1);
      this.refresh();
      return null;
    }
    this.refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count(kind, -1);
      this.refresh();
    };
  }

  observeResponse(response: EventEmitter): boolean {
    const release = this.reserve('request');
    if (!release) return false;
    const state = { done: false, pending: 0, release };
    this.responses.set(response, state);
    const finish = () => { state.done = true; if (state.pending === 0) release(); };
    for (const event of ['finish', 'close', 'error']) response.once(event, finish);
    return true;
  }

  async holdResponse<T>(response: EventEmitter, work: () => T | Promise<T>): Promise<T> {
    const state = this.responses.get(response);
    if (state) state.pending++;
    try { return await work(); }
    finally {
      if (state) {
        state.pending--;
        if (state.done && state.pending === 0) state.release();
      }
    }
  }

  runResponse(response: EventEmitter, work: () => Promise<void>): boolean {
    if (!this.observeResponse(response)) return false;
    // Hold disconnected requests until their asynchronous upstream work settles.
    void this.holdResponse(response, work).catch(() => {
      // Caller owns gateway error reporting and response termination.
    });
    return true;
  }

  status(): ReleaseStatus {
    const gate = this.gate();
    return { ...gate, state: this.closing ? 'closing' : gate.state, schemaVersion: 1, pid: process.pid, startTicks: this.startTicks,
      bootId: this.bootId, observedAtMs: Date.now(), activeRequests: this.requests,
      activeTunnels: this.tunnels, activeBackgroundTasks: this.background, closing: this.closing,
      ready: this.publicationReady && gate.state !== 'invalid' && !this.closing };
  }

  private ownFile(filename: string): void {
    try {
      const info = fs.lstatSync(filename);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 ||
          (info.mode & 0o022)) throw new Error('Unsafe receipt file');
    } catch (error) { if (!missing(error)) throw error; }
  }

  private write(filename: string, value: ReleaseStatus): void {
    this.ownFile(filename);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o640);
    try {
      try { fs.fchmodSync(fd, 0o640); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    this.syncDirectory(path.dirname(filename));
  }

  private syncDirectory(directory: string): void {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  refresh(): void {
    if (!this.publishing) return;
    const ack = path.join(this.directory, 'ack');
    const receipt = path.join(ack, 'quiesce.json');
    this.publicationReady = false;
    try {
      parents(ack);
      if (fs.lstatSync(ack).uid !== this.owner || (fs.lstatSync(ack).mode & 0o007)) throw new Error('Unsafe ACK parent');
      this.ownFile(receipt);
      if (fs.existsSync(receipt)) { fs.unlinkSync(receipt); this.syncDirectory(ack); }
      const status = this.status();
      status.ready = status.state !== 'invalid' && !this.closing;
      this.write(path.join(ack, 'status.json'), status);
      if (status.token && status.activeRequests === 0 && status.activeTunnels === 0 && status.activeBackgroundTasks === 0 && !this.closing) {
        if (this.gate().token !== status.token) return;
        this.write(receipt, status);
        if (this.gate().token !== status.token) { fs.unlinkSync(receipt); this.syncDirectory(ack); return; }
      }
      this.publicationReady = true;
    } catch { /* A missing/unwritable receipt never establishes a successful drain. */ }
  }

  async runBackground<T>(work: () => Promise<T>): Promise<T | undefined> {
    const release = this.reserve('background');
    if (!release) return undefined;
    try { return await work(); } finally { release(); }
  }

  prepareStart(): void {
    if (this.closing && (this.requests || this.tunnels || this.background)) throw new Error('Previous service work is not drained');
    this.closing = false;
  }

  start(): void {
    this.closing = false;
    this.publishing = true;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1000);
    this.timer.unref();
  }
  beginClose(): void { this.closing = true; this.refresh(); }
  stop(): void {
    this.beginClose();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.publishing = false;
  }
}

let shared: ReleaseAdmission | undefined;
export function releaseAdmission(): ReleaseAdmission { return shared ??= new ReleaseAdmission(); }
export function runReleaseBackground<T>(work: () => Promise<T>): Promise<T | undefined> {
  return releaseAdmission().runBackground(work);
}

export function installReleaseHooks(server: FastifyInstance, admission: ReleaseAdmission): void {
  server.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      return admission.holdResponse(reply.raw, () => handler.call(this, request, reply));
    };
  });
  server.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' && request.url.split('?')[0] === '/health') return;
    if (!admission.observeResponse(reply.raw)) {
      return reply.code(503).send({ error: 'release admission closed' });
    }
  });
  server.addHook('onSend', async (request, _reply, payload) => {
    if (request.method !== 'GET' || request.url.split('?')[0] !== '/health' || typeof payload !== 'string') return payload;
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return JSON.stringify({ ...value, release_admission: admission.status() });
    }
    return payload;
  });
}

export async function awaitDrain(drained: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!drained()) {
    if (Date.now() >= deadline) throw new Error('CONNECT drain did not complete');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

export async function awaitShutdown<T>(work: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Service shutdown did not complete')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
