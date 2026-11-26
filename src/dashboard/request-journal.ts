import { logger } from '../shared/logging/logger';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getServerConfig } from '../server/server-config';
import { extractApiKeyToken, resolveApiProject } from '../modules/proxy-gateway/server/guards/api-key-auth.util';

import { safeLabel, normalizedRoute } from '../observability/metadata';
import { getRequestHistoryStore, closeRequestHistory, type HistoryInput } from '../observability/request-history';
import { createRequestObservation, runWithRequestObservation, observeResponseUsage, type RequestObservation } from '../observability/request-context';
import { attachHttpSseUsageTap, type HttpSseUsageTap } from '../observability/http-sse-usage';
import { extractSessionKey } from '../modules/proxy-gateway/server/cloudcode-request-adapter';
export { safeLabel, normalizedRoute };

export type JournalInput = HistoryInput;

export class RequestJournal {
  constructor(private readonly persist?: (input: JournalInput) => void) {}
  private entries: ReturnType<RequestJournal['sanitize']>[] = [];
  private total = 0;
  private errors = 0;
  readonly started_at = new Date().toISOString();

  private sanitize(input: JournalInput) {
    return {
      request_id: input.request_id && /^[\da-f-]{36}$/i.test(input.request_id) ? input.request_id : randomUUID(),
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
    try { this.persist?.(input); } catch { logger.warn('Request history write failed; request telemetry was not persisted'); }
    this.total += 1;
    if (entry.status >= 400 || (entry.grpc_status !== undefined && entry.grpc_status !== '0')) this.errors += 1;
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
  }

  snapshot() {
    return { started_at: this.started_at, total: this.total, errors: this.errors, limit: 500, entries: this.entries.map((entry) => ({ ...entry })).reverse() };
  }
}

export const requestJournal = new RequestJournal((input) => getRequestHistoryStore().record(input));
const installed = new WeakSet<FastifyInstance>();

export function installDashboardHooks(server: FastifyInstance): void {
  if (installed.has(server)) return;
  installed.add(server);
  const contexts = new WeakMap<FastifyRequest, { started: number; context: RequestObservation; project: { id: string; name: string } | null; sseTap: HttpSseUsageTap }>();
  server.addHook('onRequest', (request, reply, done) => {
    const context = createRequestObservation();
    const started = performance.now();
    const project = resolveApiProject(getServerConfig(), extractApiKeyToken(request.headers));
    const sseTap = attachHttpSseUsageTap(reply, context);
    contexts.set(request, { started, context, project, sseTap });
    reply.raw.once('finish', () => {
      if (sseTap.isSse()) record(request, sseTap.statusCode() ?? reply.raw.statusCode ?? reply.statusCode);
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        sseTap.discard();
        record(request, context.upstream_failed ? 502 : 499);
      }
    });
    runWithRequestObservation(context, done);
  });
  server.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode < 400 && typeof payload === 'string' && payload.length <= 1_048_576 && String(reply.getHeader('content-type')).includes('application/json')) {
      try { observeResponseUsage(JSON.parse(payload)); } catch { /* Opaque/non-JSON responses have unknown usage. */ }
    }
    return payload;
  });
  const record = (request: FastifyRequest, status: number) => {
    const state = contexts.get(request);
    if (!state || state.context.finished) return;
    const { context, started, project, sseTap } = state;
    if (sseTap.isSse()) {
      status = status === 499 ? 499 : (sseTap.statusCode() ?? status);
      sseTap.finalize(status < 400 && !context.upstream_failed);
    }
    if (context.upstream_failed && status < 400) status = 502;
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    if (!context.session_key) {
      const extracted = extractSessionKey(request, body);
      if (extracted) {
        const safe = safeLabel(extracted.trim().slice(0, 100), '');
        if (safe) context.session_key = safe;
      }
    }
    context.finished = true;
    contexts.delete(request);
    const route = normalizedRoute(request.url);
    if (route === 'other') return;
    const model = body.model ?? request.url.split('?')[0].match(/\/models\/([^/:]+):/)?.[1];
    requestJournal.record({ ...context, protocol: 'http', route: request.url, model,
      project_id: project?.id, project_name: project?.name, status, duration_ms: performance.now() - started });
  };
  server.addHook('onResponse', async (request, reply) => { record(request, reply.statusCode); });
  server.addHook('onClose', async () => { closeRequestHistory(); });
}
