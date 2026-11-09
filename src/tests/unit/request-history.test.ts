import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestHistoryStore, configureRequestHistory, closeRequestHistory, getRequestHistory, getAccountStats, getUsageSummary } from '@/observability/request-history';
import { createRequestObservation, runWithRequestObservation, getRequestObservation, observeSelectedAccount, observeAccountOutcome, observeAttemptStart, observeUpstreamStreamFailure } from '@/observability/request-context';
import { installDashboardHooks } from '@/dashboard/request-journal';
import { observeNativeRequest } from '@/dashboard/native-request-journal';
import { AccountPerformancePolicy } from '@/modules/proxy-gateway/server/account-performance-policy';
import { DEFAULT_PROXY_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';

const directories: string[] = [];
const stores: RequestHistoryStore[] = [];
const originalConfig = getServerConfig();
function temporaryDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-history-'));
  directories.push(dir);
  return path.join(dir, 'request-history.db');
}
afterEach(() => {
  closeRequestHistory();
  stores.forEach((store) => store.close()); stores.length = 0;
  directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })); directories.length = 0;
  setServerConfig(originalConfig);
});
const input = { protocol: 'http' as const, route: '/v1/chat/completions', status: 200, duration_ms: 12, model: 'gemini-pro' };

describe('persistent request history', () => {
  it('reopens real SQLite history and keeps unknown usage null with stable start time', () => {
    const file = temporaryDatabase();
    const first = new RequestHistoryStore(file); stores.push(first);
    first.record(input);
    const started = first.getUsageSummary().started_at;
    first.close();
    const second = new RequestHistoryStore(file); stores.push(second);
    expect(second.getRequestHistory()).toMatchObject({ total: 1, items: [{ requested_model: 'gemini-pro', input_tokens: null, output_tokens: null, cache_tokens: null }] });
    expect(second.getUsageSummary()).toMatchObject({ started_at: started, total_requests: 1, token_metrics_available: false, cache_metrics_available: false });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('groups UTC hours with the same filters and preserves daily totals', () => {
    const store = new RequestHistoryStore(':memory:', { now: () => Date.parse('2026-11-09T12:00:00Z') }); stores.push(store);
    for (const [time, status, project_id] of [
      ['2026-11-08T23:59:00Z', 200, 'one'], ['2026-11-09T00:00:00Z', 502, 'one'],
      ['2026-11-09T00:59:59Z', 200, 'one'], ['2026-11-09T01:00:00Z', 200, 'two'],
    ] as const) store.record({ ...input, time, status, project_id });
    const summary = store.getUsageSummary({ projectId: 'one', from: '2026-11-09T00:00:00Z', to: '2026-11-09T00:59:59Z' });
    expect(summary.by_hour).toEqual([expect.objectContaining({ hour: '2026-11-09T00:00:00.000Z', total_requests: 2, failed_requests: 1, input_tokens: null })]);
    expect(summary.by_day).toEqual([expect.objectContaining({ date: '2026-11-09', total_requests: 2, failed_requests: 1 })]);
    expect(summary.total_requests).toBe(2);
    expect(store.getUsageSummary().by_hour).toHaveLength(3);
    expect(store.getUsageSummary({ projectId: 'missing' }).by_hour).toEqual([]);
  });

  it('retains safe service operations and distinguishes pool, client and historical attribution', () => {
    const store = new RequestHistoryStore(':memory:'); stores.push(store);
    for (const row of [
      { route: '/v1internal:fetchAvailableModels?token=private', protocol: 'connect' as const, model: undefined },
      { route: '/v1internal:recordClientEvent', protocol: 'connect' as const, account_id: 'A', model: undefined },
      { route: 'other', protocol: 'connect' as const, model: undefined },
      { route: '/v1internal:generateContent', protocol: 'connect' as const, model: 'gemini-pro', account_id: 'B', effective_model: 'gemini-pro' },
    ]) store.record({ ...input, ...row });
    const rows = store.getRequestHistory().items;
    expect(rows.find(r => r.route === '/v1internal:fetchAvailableModels')).toMatchObject({ request_kind: 'service', authorization_source: 'client', requested_model: null });
    expect(rows.find(r => r.route === '/v1internal:recordClientEvent')).toMatchObject({ request_kind: 'service', authorization_source: 'pool', account_id: 'A' });
    expect(rows.find(r => r.route === 'other')).toMatchObject({ request_kind: 'unknown', authorization_source: 'unknown' });
    expect(rows.find(r => r.route === '/v1internal:generateContent')).toMatchObject({ request_kind: 'inference', requested_model: 'gemini-pro', effective_model: 'gemini-pro', account_id: 'B' });
    expect(JSON.stringify(rows)).not.toContain('private');
    store.record({ ...input, route: '/v1internal:privateUnknownOperation' });
    expect(store.getRequestHistory().items[0].route).toBe('other');
  });

  it('prunes by age and count, cascades attempt records, and filters safely', () => {
    let now = Date.parse('2026-11-09T12:00:00Z');
    const store = new RequestHistoryStore(temporaryDatabase(), { now: () => now, maxEntries: 2 }); stores.push(store);
    for (let index = 0; index < 3; index++) store.record({ ...input, time: new Date(now + index).toISOString(), project_id: `project-${index}`, account_id: `account-${index}`, status: index === 2 ? 502 : 200, attempts: [{ account_id: `account-${index}`, outcome: 'success' }] });
    expect(store.getRequestHistory().total).toBe(2);
    expect(store.getAccountStats()).toHaveLength(2);
    expect(store.getAccountStats({ projectId: 'project-2' })).toMatchObject([{ account_id: 'account-2' }]);
    expect(store.getRequestHistory({ projectId: 'project-2', status: 'error' })).toMatchObject({ total: 1, items: [{ status: 502 }] });
    expect(store.getRequestHistory({ accountId: "' OR 1=1 --" }).total).toBe(0);
    now += 8 * 86_400_000;
    expect(store.getRequestHistory().total).toBe(0);
    expect(store.getAccountStats()).toEqual([]);
  });

  it('keeps logical outcomes separate from failed and successful upstream attempts', () => {
    const store = new RequestHistoryStore(':memory:'); stores.push(store);
    store.record({ ...input, account_id: 'B', attempts: [{ account_id: 'A', outcome: 'failure' }, { account_id: 'B', outcome: 'success', ttft_ms: 45 }] });
    expect(store.getUsageSummary()).toMatchObject({ total_requests: 1, success_requests: 1, failed_requests: 0 });
    expect(store.getAccountStats()).toEqual([
      expect.objectContaining({ account_id: 'A', failed_attempts: 1, success_attempts: 0, final_requests: 0, logical_requests: 1 }),
      expect.objectContaining({ account_id: 'B', failed_attempts: 0, success_attempts: 1, final_requests: 1, success_requests: 1 }),
    ]);
  });

  it('filters history by participating account while keeping account statistics and token attribution separate', () => {
    const store = new RequestHistoryStore(':memory:'); stores.push(store);
    store.record({ ...input, account_id: 'B', project_id: 'failover-project', input_tokens: 12, output_tokens: 4,
      attempts: [{ account_id: 'A', outcome: 'failure' }, { account_id: 'B', outcome: 'success', ttft_ms: 45 }] });
    const history = store.getRequestHistory({ accountId: 'A' });
    expect(history).toMatchObject({ total: 1, items: [{ account_id: 'B', attempts: [{ account_id: 'A', outcome: 'failure' }, { account_id: 'B', outcome: 'success' }] }] });
    expect(store.getRequestHistory({ accountId: 'B' }).total).toBe(1);
    expect(store.getRequestHistory({ accountId: 'missing' }).total).toBe(0);
    expect(store.getAccountStats({ accountId: 'A' })).toEqual([
      expect.objectContaining({ account_id: 'A', failed_attempts: 1, logical_requests: 1, final_requests: 0, input_tokens: null, output_tokens: null }),
    ]);
    expect(store.getAccountStats({ accountId: 'B' })).toEqual([
      expect.objectContaining({ account_id: 'B', success_attempts: 1, final_requests: 1, input_tokens: 12, output_tokens: 4 }),
    ]);
    expect(store.getAccountStats({ accountId: 'A', projectId: 'other-project' })).toEqual([]);
  });

  it('stores only allowlisted metadata without prompt, credentials, URLs or raw errors', () => {
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, api_key: 'api-secret', admin_api_key: 'admin-secret' });
    const store = new RequestHistoryStore(temporaryDatabase()); stores.push(store);
    store.record({ ...input, route: '/v1/chat/completions?token=api-secret', model: 'api-secret', project_name: 'admin-secret', effective_model: 'https://credential@example.test/?secret', input_tokens: -1,
      attempts: [{ account_id: 'account', outcome: 'failure', error_category: 'raw-error-api-secret' }],
      ...{ prompt: 'private-prompt', access_token: 'oauth-secret', response: 'response-secret' } });
    const serialized = JSON.stringify(store.getRequestHistory());
    expect(serialized).not.toMatch(/api-secret|admin-secret|credential|raw-error|private-prompt|oauth-secret|response-secret|\?token/);
  });
});

describe('request observation flow', { timeout: 20_000 }, () => {
  it('isolates concurrent identical HTTP bodies by project and records real usage and effective model', async () => {
    configureRequestHistory(temporaryDatabase());
    setServerConfig({ ...DEFAULT_PROXY_CONFIG, projects: ['one', 'two'].map((id) => ({ id, name: id, api_key: `key-${id}`, enabled: true, model_mapping: {} })) });
    const server = Fastify(); installDashboardHooks(server);
    const performance = new AccountPerformancePolicy();
    server.post('/v1/chat/completions', async (request) => {
      const account = request.headers.authorization === 'Bearer key-one' ? 'A' : 'B';
      observeSelectedAccount(account);
      await new Promise((resolve) => setTimeout(resolve, account === 'A' ? 10 : 1));
      performance.recordSuccess(account, 'effective-gemini', 35);
      performance.recordSuccess(account, 'effective-gemini', 35);
      return { choices: [{ message: 'private-output' }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
    });
    try {
      await Promise.all(['one', 'two'].map((id) => server.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer key-${id}` }, payload: { model: 'requested-gemini', messages: ['same-private-prompt'] } })));
      const { items, total } = getRequestHistory();
      expect(total).toBe(2);
      expect(items.find((item) => item.project_id === 'one')).toMatchObject({ account_id: 'A', effective_model: 'effective-gemini', input_tokens: 12, output_tokens: 4, cache_tokens: null, attempts: [{ outcome: 'success', ttft_ms: 35 }] });
      expect(items.find((item) => item.project_id === 'two')).toMatchObject({ account_id: 'B', attempts: [{ outcome: 'success' }] });
      expect(getAccountStats().every((item) => item.total_attempts === 1)).toBe(true);
      expect(getUsageSummary()).toMatchObject({ input_tokens: 24, output_tokens: 8, cache_tokens: null });
      expect(JSON.stringify(items)).not.toMatch(/same-private-prompt|private-output|key-one|key-two/);
      expect(getRequestObservation()).toBeUndefined();
    } finally { await server.close(); }
  });

  it('captures native cancellation exactly once and runs callbacks in isolated contexts', async () => {
    configureRequestHistory(temporaryDatabase());
    const req = Object.assign(new EventEmitter(), { url: '/v1internal:streamGenerateContent?token=secret' }) as unknown as http.IncomingMessage;
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false }) as unknown as http.ServerResponse;
    await new Promise<void>((resolve) => {
      observeNativeRequest(req, res, () => {
        observeSelectedAccount('A'); observeAttemptStart('A', 'gemini-pro');
        setTimeout(() => { observeAccountOutcome('A', 'gemini-pro', 'success', 7); res.emit('close'); res.emit('finish'); resolve(); }, 1);
      });
    });
    expect(getRequestHistory()).toMatchObject({ total: 1, items: [{ status: 499, error_category: 'client_cancelled', account_id: 'A', attempts: [{ outcome: 'success' }] }] });
    expect(getRequestObservation()).toBeUndefined();
  });

  it('reports a late upstream error even when HTTP headers were already successful', async () => {
    configureRequestHistory(temporaryDatabase());
    const server = Fastify(); installDashboardHooks(server);
    server.post('/v1/chat/completions', async () => {
      observeSelectedAccount('A'); observeAccountOutcome('A', 'gemini', 'success', 8);
      observeUpstreamStreamFailure('A', 'gemini');
      return { error: 'private-upstream-error' };
    });
    try {
      await server.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'gemini' } });
      expect(getRequestHistory()).toMatchObject({ total: 1, items: [{ status: 502, attempts: [{ outcome: 'failure' }] }] });
      expect(getUsageSummary()).toMatchObject({ failed_requests: 1, success_requests: 0 });
    } finally { await server.close(); }
  });

  it('records actual HTTP streaming socket cancellation once as 499', async () => {
    configureRequestHistory(temporaryDatabase());
    const server = Fastify(); installDashboardHooks(server);
    server.post('/v1/chat/completions', (_request, reply) => {
      observeSelectedAccount('stream-account');
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('data: private-output\n\n');
    });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.request(`${address}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
          response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
        });
        request.once('error', reject); request.end(JSON.stringify({ model: 'gemini' }));
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getRequestHistory()).toMatchObject({ total: 1, items: [{ status: 499, account_id: 'stream-account', error_category: 'client_cancelled' }] });
    } finally { await server.close(); }
  });

  it('records repeated native attempts on the same account independently', () => {
    const context = createRequestObservation();
    runWithRequestObservation(context, () => {
      observeSelectedAccount('A'); observeAttemptStart('A', 'gemini'); observeAccountOutcome('A', 'gemini', 'failure', undefined, 503);
      observeAttemptStart('A', 'gemini'); observeAccountOutcome('A', 'gemini', 'success', 10);
    });
    expect(context.attempts.map((attempt) => attempt.outcome)).toEqual(['failure', 'success']);
  });
  it('replaces usable-frame success with one failure when upstream breaks, without changing client cancellation', () => {
    const context = createRequestObservation();
    runWithRequestObservation(context, () => {
      observeSelectedAccount('A'); observeAccountOutcome('A', 'gemini', 'success', 8);
      observeUpstreamStreamFailure('A', 'gemini'); observeUpstreamStreamFailure('A', 'gemini');
    });
    expect(context.attempts).toHaveLength(1);
    expect(context.attempts[0]).toMatchObject({ outcome: 'failure', ttft_ms: 8, error_category: 'upstream_error' });
    context.finished = true;
    runWithRequestObservation(context, () => observeAccountOutcome('A', 'gemini', 'success', 8));
    expect(context.attempts[0].outcome).toBe('failure');
  });

});
