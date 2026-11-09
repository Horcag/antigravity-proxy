import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getServerConfig } from '../server/server-config';
import { extractApiKeyToken, resolveApiProject } from '../modules/proxy-gateway/server/guards/api-key-auth.util';

export function safeLabel(value: unknown, fallback = 'unknown', privateValues: string[] = []): string {
  const config = getServerConfig();
  const secrets = [...privateValues, config?.api_key, config?.admin_api_key, ...(config?.projects ?? []).map((project) => project.api_key)];
  if (typeof value === 'string' && secrets.some((secret) => secret && value.includes(secret))) return fallback;
  return typeof value === 'string' && /^[\p{L}\p{N}_. @:+-]{1,100}$/u.test(value) ? value : fallback;
}

export function normalizedRoute(value: unknown): string {
  const path = typeof value === 'string' ? value.split('?')[0] : '';
  if (/^\/v1internal:(?:streamGenerateContent|generateContent|countTokens)$/.test(path)) return path;
  if (path === '/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent') return path;
  if (/^\/(?:v1|v1beta)\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(path)) {
    return '/v1beta/models/:model:generateContent';
  }
  return ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1/audio/transcriptions', '/v1/audio/translations', '/v1/audio/speech'].includes(path) ? path : 'other';
}

export interface JournalInput {
  protocol: 'http' | 'connect';
  route: string;
  model?: unknown;
  project_id?: unknown;
  project_name?: unknown;
  status: number;
  grpc_status?: string;
  duration_ms: number;
  request_id?: unknown;
}

export class RequestJournal {
  private entries: ReturnType<RequestJournal['sanitize']>[] = [];
  private total = 0;
  private errors = 0;
  readonly started_at = new Date().toISOString();

  private sanitize(input: JournalInput) {
    return {
      request_id: randomUUID(),
      time: new Date().toISOString(),
      protocol: input.protocol === 'connect' ? 'connect' : 'http',
      route: normalizedRoute(input.route),
      model: safeLabel(input.model, '—'),
      project_id: safeLabel(input.project_id, 'default'),
      project_name: safeLabel(input.project_name, 'Общий ключ'),
      status: Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : 500,
      grpc_status: /^(?:[0-9]|1[0-6])$/.test(input.grpc_status ?? '') ? input.grpc_status : undefined,
      duration_ms: Number.isFinite(input.duration_ms) ? Math.max(0, Math.round(input.duration_ms)) : 0,
    };
  }

  record(input: JournalInput): void {
    const entry = this.sanitize(input);
    this.total += 1;
    if (entry.status >= 400 || (entry.grpc_status !== undefined && entry.grpc_status !== '0')) this.errors += 1;
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
  }

  snapshot() {
    return { started_at: this.started_at, total: this.total, errors: this.errors, limit: 500, entries: this.entries.map((entry) => ({ ...entry })).reverse() };
  }
}

export const requestJournal = new RequestJournal();
const installed = new WeakSet<FastifyInstance>();

export function installDashboardHooks(server: FastifyInstance): void {
  if (installed.has(server)) return;
  installed.add(server);
  const starts = new WeakMap<FastifyRequest, number>();
  server.addHook('onRequest', async (request) => { starts.set(request, performance.now()); });
  server.addHook('onResponse', async (request, reply) => {
    const route = normalizedRoute(request.url);
    if (route === 'other') return;
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const project = resolveApiProject(getServerConfig(), extractApiKeyToken(request.headers));
    const model = body.model ?? request.url.split('?')[0].match(/\/models\/([^/:]+):/)?.[1];
    requestJournal.record({ protocol: 'http', route: request.url, model, project_id: project?.id,
      project_name: project?.name, status: reply.statusCode,
      duration_ms: performance.now() - (starts.get(request) ?? performance.now()) });
    starts.delete(request);
  });
}
