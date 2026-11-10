import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '../shared/paths';
import { safeLabel, normalizedRoute, nullableCount, errorCategory, requestMetadata } from './metadata';

export interface AttemptRecord {
  account_id: string;
  effective_model?: string | null;
  outcome: 'success' | 'failure' | 'unknown';
  error_category?: string | null;
  ttft_ms?: number | null;
}
export interface HistoryInput {
  request_id?: string;
  time?: string;
  protocol: 'http' | 'connect';
  route: string;
  model?: unknown;
  requested_model?: unknown;
  effective_model?: unknown;
  project_id?: unknown;
  project_name?: unknown;
  account_id?: unknown;
  status: number;
  grpc_status?: string;
  duration_ms: number;
  ttft_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_tokens?: number | null;
  attempts?: AttemptRecord[];
}
export type HistoryGranularity = 'minute' | 'five_minutes' | 'hour' | 'day';
export type HistoryMetric = 'input_tokens' | 'output_tokens' | 'cache_tokens' | 'ttft_ms' | 'duration_ms';
export interface HistoryFilters {
  limit?: number;
  offset?: number;
  accountId?: string;
  finalAccountId?: string;
  attemptOutcome?: AttemptRecord['outcome'];
  metric?: HistoryMetric;
  missingModel?: boolean;
  projectId?: string;
  model?: string;
  status?: number | string;
  result?: 'success' | 'failure' | 'none';
  from?: string | number;
  to?: string | number;
  toExclusive?: string | number;
}
export interface HistoryEntry {
  request_kind: 'inference' | 'service' | 'unknown';
  authorization_source: 'client' | 'pool' | 'unknown';
  request_id: string;
  id: string;
  time: string;
  protocol: string;
  route: string;
  model: string | null;
  requested_model: string | null;
  effective_model: string | null;
  project_id: string;
  project_name: string;
  project: { id: string; name: string };
  account_id: string | null;
  status: number;
  grpc_status: string | null;
  error_category: string | null;
  duration_ms: number;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  attempts: AttemptRecord[];
}
interface StoredEntry extends Omit<HistoryEntry, 'id' | 'project' | 'attempts' | 'request_kind' | 'authorization_source'> { sequence: number }
interface StoreOptions { retentionDays?: number; maxEntries?: number; now?: () => number }
const nullableLabel = (value: unknown) => safeLabel(value, '') || null;
const milliseconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
const failedSql = "(status >= 400 OR (grpc_status IS NOT NULL AND grpc_status != '0'))";

/** Contains only allowlisted metadata. Payloads and credentials never enter the database. */
export class RequestHistoryStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private closed = false;
  constructor(databasePath: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(1, options.retentionDays ?? 7) * 86_400_000;
    this.maxEntries = Math.min(100_000, Math.max(1, Math.floor(options.maxEntries ?? 100_000)));
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS history_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (
      sequence INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, time TEXT NOT NULL,
      protocol TEXT NOT NULL, route TEXT NOT NULL, model TEXT, requested_model TEXT, effective_model TEXT,
      project_id TEXT NOT NULL, project_name TEXT NOT NULL, account_id TEXT,
      status INTEGER NOT NULL, grpc_status TEXT, error_category TEXT, duration_ms INTEGER NOT NULL,
      ttft_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER
    );
    CREATE TABLE IF NOT EXISTS attempts (
      sequence INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, effective_model TEXT, outcome TEXT NOT NULL, error_category TEXT, ttft_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS requests_time ON requests(time);
    CREATE INDEX IF NOT EXISTS requests_account ON requests(account_id, time);
    CREATE INDEX IF NOT EXISTS requests_project ON requests(project_id, time);
    CREATE INDEX IF NOT EXISTS requests_status ON requests(status, time);
    CREATE INDEX IF NOT EXISTS requests_model ON requests(requested_model, time);
    CREATE INDEX IF NOT EXISTS attempts_account ON attempts(account_id);
    CREATE INDEX IF NOT EXISTS attempts_request ON attempts(request_id);`);
    this.db.prepare("INSERT OR IGNORE INTO history_metadata(key,value) VALUES ('started_at',?)").run(new Date(this.now()).toISOString());
    this.prune();
  }
  record(input: HistoryInput): void {
    if (this.closed) return;
    const status = Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : 500;
    const grpc = /^(?:[0-9]|1[0-6])$/.test(input.grpc_status ?? '') ? input.grpc_status! : null;
    const requestedModel = nullableLabel(input.requested_model ?? input.model);
    const time = input.time && Number.isFinite(Date.parse(input.time)) ? new Date(input.time).toISOString() : new Date(this.now()).toISOString();
    const row = { request_id: input.request_id && /^[\da-f-]{36}$/i.test(input.request_id) ? input.request_id : randomUUID(), time,
      protocol: input.protocol === 'connect' ? 'connect' : 'http', route: normalizedRoute(input.route), model: requestedModel,
      requested_model: requestedModel, effective_model: nullableLabel(input.effective_model),
      project_id: safeLabel(input.project_id, 'default'), project_name: safeLabel(input.project_name, 'Общий ключ'),
      account_id: nullableLabel(input.account_id), status, grpc_status: grpc,
      error_category: errorCategory(status) ?? (grpc && grpc !== '0' ? 'upstream_error' : null),
      duration_ms: milliseconds(input.duration_ms) ?? 0, ttft_ms: milliseconds(input.ttft_ms),
      input_tokens: nullableCount(input.input_tokens), output_tokens: nullableCount(input.output_tokens), cache_tokens: nullableCount(input.cache_tokens) };
    this.db.transaction(() => {
      const columns = Object.keys(row);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO requests (${columns.join(',')}) VALUES (${columns.map((key) => `@${key}`).join(',')})`).run(row);
      if (!inserted.changes) return;
      const insertAttempt = this.db.prepare('INSERT INTO attempts(request_id,account_id,effective_model,outcome,error_category,ttft_ms) VALUES (?,?,?,?,?,?)');
      for (const attempt of (input.attempts ?? []).slice(0, 100)) {
        insertAttempt.run(row.request_id, safeLabel(attempt.account_id), nullableLabel(attempt.effective_model),
          attempt.outcome === 'success' || attempt.outcome === 'failure' ? attempt.outcome : 'unknown',
          ['authentication','rate_limited','timeout','upstream_error','request_error','network_error','protocol_error'].includes(attempt.error_category ?? '') ? attempt.error_category! : null,
          milliseconds(attempt.ttft_ms));
      }
      this.prune();
    })();
  }
  prune(): void {
    if (this.closed) return;
    this.db.prepare('DELETE FROM requests WHERE time < ?').run(new Date(this.now() - this.retentionMs).toISOString());
    this.db.prepare('DELETE FROM requests WHERE sequence IN (SELECT sequence FROM requests ORDER BY sequence DESC LIMIT -1 OFFSET ?)').run(this.maxEntries);
  }
  getRequestHistory(filters: HistoryFilters = {}): { items: HistoryEntry[]; total: number; matching_attempts?: number } {
    this.prune();
    const { where, params } = this.filter(filters);
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM requests ${where}`).get(...params) as { total: number }).total;
    const limit = Math.min(500, Math.max(1, Math.floor(filters.limit ?? 50)));
    const offset = Math.max(0, Math.floor(filters.offset ?? 0));
    const rows = this.db.prepare(`SELECT * FROM requests ${where} ORDER BY time DESC, sequence DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as StoredEntry[];
    const attempts = this.db.prepare('SELECT account_id,effective_model,outcome,error_category,ttft_ms FROM attempts WHERE request_id = ? ORDER BY sequence');
    const matchingAttempts = filters.attemptOutcome === undefined ? {} : {
      matching_attempts: (this.db.prepare(`SELECT COUNT(*) AS total FROM attempts matched
        WHERE matched.request_id IN (SELECT request_id FROM requests ${where}) AND matched.outcome = ?
        ${filters.accountId !== undefined ? 'AND matched.account_id = ?' : ''}`).get(...params, filters.attemptOutcome,
        ...(filters.accountId !== undefined ? [filters.accountId] : [])) as { total: number }).total,
    };
    return { total, ...matchingAttempts, items: rows.map(({ sequence: _sequence, ...row }) => ({ ...row, ...requestMetadata(row.route, row.protocol, row.account_id), id: row.request_id,
      project: { id: row.project_id, name: row.project_name }, attempts: attempts.all(row.request_id) as AttemptRecord[] })) };
  }
  getUsageSummary(filters: HistoryFilters = {}, granularity: HistoryGranularity = 'hour') {
    this.prune();
    const { where, params } = this.filter(filters);
    const summary = this.db.prepare(`SELECT COUNT(*) AS total_requests, COALESCE(SUM(CASE WHEN ${failedSql} THEN 1 ELSE 0 END),0) AS failed_requests,
      MIN(time) AS oldest_request_at, AVG(duration_ms) AS avg_duration_ms, AVG(ttft_ms) AS avg_ttft_ms, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_tokens) AS cache_tokens, COUNT(input_tokens) AS requests_with_input_tokens, COUNT(output_tokens) AS requests_with_output_tokens,
      COUNT(cache_tokens) AS requests_with_cache_tokens FROM requests ${where}`).get(...params) as {
      oldest_request_at: string | null; total_requests: number; failed_requests: number; avg_duration_ms: number | null; avg_ttft_ms: number | null;
      input_tokens: number | null; output_tokens: number | null; cache_tokens: number | null;
      requests_with_input_tokens: number; requests_with_output_tokens: number; requests_with_cache_tokens: number;
    };
    const by_day = this.db.prepare(`SELECT substr(time,1,10) AS date, COUNT(*) AS total_requests, SUM(CASE WHEN ${failedSql} THEN 1 ELSE 0 END) AS failed_requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM requests ${where} GROUP BY substr(time,1,10) ORDER BY date`).all(...params);
    const by_hour = this.db.prepare(`SELECT substr(time,1,13) || ':00:00.000Z' AS hour, COUNT(*) AS total_requests, SUM(CASE WHEN ${failedSql} THEN 1 ELSE 0 END) AS failed_requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM requests ${where} GROUP BY substr(time,1,13) ORDER BY hour`).all(...params);
    const by_model = this.db.prepare(`SELECT requested_model AS model, COUNT(*) AS total_requests, SUM(CASE WHEN ${failedSql} THEN 1 ELSE 0 END) AS failed_requests, AVG(duration_ms) AS avg_duration_ms, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM requests ${where} GROUP BY requested_model ORDER BY total_requests DESC`).all(...params);
    const { value: started_at } = this.db.prepare("SELECT value FROM history_metadata WHERE key='started_at'").get() as { value: string };
    return { ...summary, ...this.timeBuckets(filters, granularity), started_at, available_since: started_at, by_day, by_hour, by_model, success_requests: summary.total_requests - summary.failed_requests,
      token_metrics_available: summary.requests_with_input_tokens > 0 || summary.requests_with_output_tokens > 0,
      cache_metrics_available: summary.requests_with_cache_tokens > 0, retention_days: this.retentionMs / 86_400_000, max_entries: this.maxEntries };
  }
  private timeBuckets(filters: HistoryFilters, granularity: HistoryGranularity) {
    const { where, params } = this.filter(filters);
    const interval = { minute: 60_000, five_minutes: 300_000, hour: 3_600_000, day: 86_400_000 }[granularity];
    const offset = 4 * 3_600_000;
    const bounds = this.db.prepare(`SELECT MIN(time) AS first, MAX(time) AS last FROM requests ${where}`).get(...params) as { first: string | null; last: string | null };
    const earliest = this.now() - this.retentionMs;
    const from = Math.max(earliest, filters.from === undefined ? Date.parse(bounds.first ?? '') : new Date(filters.from).getTime());
    const selectedEnd = filters.toExclusive !== undefined || filters.to !== undefined
      ? Math.min(filters.toExclusive === undefined ? Infinity : new Date(filters.toExclusive).getTime(), filters.to === undefined ? Infinity : new Date(filters.to).getTime() + 1)
      : Date.parse(bounds.last ?? '') + 1;
    const toExclusive = Math.min(this.now() + 1, selectedEnd);
    const range = { from: null as string | null, toExclusive: null as string | null };
    const buckets: { start: string; end: string; total_requests: number; failed_requests: number; input_tokens: number | null; output_tokens: number | null }[] = [];
    if (!Number.isFinite(from) || !Number.isFinite(toExclusive) || from >= toExclusive) return { granularity, time_zone: 'Europe/Samara', range, buckets };
    const first = Math.floor((from + offset) / interval) * interval - offset;
    const last = Math.floor((toExclusive - 1 + offset) / interval) * interval - offset;
    // Ограничиваем заполнение пропусков даже при ошибочно большом диапазоне.
    const start = Math.max(first, last - 10_081 * interval);
    range.from = new Date(Math.max(from, start)).toISOString();
    range.toExclusive = new Date(toExclusive).toISOString();
    const rows = this.db.prepare(`SELECT CAST((CAST(strftime('%s', time) AS INTEGER) * 1000 + ${offset}) / ${interval} AS INTEGER) * ${interval} - ${offset} AS bucket,
      COUNT(*) AS total_requests, SUM(CASE WHEN ${failedSql} THEN 1 ELSE 0 END) AS failed_requests,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM requests ${where} GROUP BY bucket`).all(...params) as {
        bucket: number; total_requests: number; failed_requests: number; input_tokens: number | null; output_tokens: number | null;
      }[];
    const counts = new Map(rows.map(({ bucket, ...row }) => [bucket, row]));
    for (let time = start; time < toExclusive; time += interval) {
      buckets.push({ start: new Date(Math.max(time, from)).toISOString(), end: new Date(Math.min(time + interval, toExclusive)).toISOString(),
        ...(counts.get(time) ?? { total_requests: 0, failed_requests: 0, input_tokens: null, output_tokens: null }) });
    }
    return { granularity, time_zone: 'Europe/Samara', range, buckets };
  }
  getAccountStats(filters: HistoryFilters = {}) {
    this.prune();
    const { where, params } = this.filter(filters);
    return this.db.prepare(`WITH selected_requests AS (SELECT * FROM requests ${where}),
      account_ids AS (SELECT account_id FROM selected_requests WHERE account_id IS NOT NULL
        UNION SELECT a.account_id FROM attempts a JOIN selected_requests r ON a.request_id=r.request_id),
      final_usage AS (SELECT account_id, AVG(duration_ms) AS avg_duration_ms, SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens, SUM(cache_tokens) AS cache_tokens, COUNT(*) AS final_requests,
        SUM(CASE WHEN ${failedSql} THEN 1 ELSE 0 END) AS failed_requests FROM selected_requests GROUP BY account_id),
      attempt_usage AS (SELECT a.account_id, COUNT(*) AS total_attempts,
        SUM(CASE WHEN a.outcome='success' THEN 1 ELSE 0 END) AS success_attempts,
        SUM(CASE WHEN a.outcome='failure' THEN 1 ELSE 0 END) AS failed_attempts,
        SUM(CASE WHEN a.outcome='unknown' THEN 1 ELSE 0 END) AS unknown_attempts, AVG(a.ttft_ms) AS avg_ttft_ms
        FROM attempts a JOIN selected_requests r ON a.request_id=r.request_id
        ${filters.attemptOutcome !== undefined ? 'WHERE a.outcome = ?' : ''} GROUP BY a.account_id)
      SELECT ids.account_id, COALESCE(a.total_attempts,0) AS total_attempts,
        COALESCE(a.success_attempts,0) AS success_attempts, COALESCE(a.failed_attempts,0) AS failed_attempts,
        COALESCE(a.unknown_attempts,0) AS unknown_attempts, a.avg_ttft_ms,
        u.avg_duration_ms, u.input_tokens, u.output_tokens, u.cache_tokens,
        COALESCE(u.final_requests,0) AS final_requests, COALESCE(u.failed_requests,0) AS failed_requests,
        COALESCE(u.final_requests-u.failed_requests,0) AS success_requests,
        (SELECT COUNT(*) FROM selected_requests r WHERE r.account_id=ids.account_id OR EXISTS
          (SELECT 1 FROM attempts participant WHERE participant.request_id=r.request_id AND participant.account_id=ids.account_id)) AS logical_requests,
        (SELECT MAX(r.time) FROM selected_requests r WHERE r.account_id=ids.account_id OR EXISTS
          (SELECT 1 FROM attempts participant WHERE participant.request_id=r.request_id AND participant.account_id=ids.account_id)) AS last_request_at
      FROM account_ids ids LEFT JOIN final_usage u ON u.account_id=ids.account_id LEFT JOIN attempt_usage a ON a.account_id=ids.account_id
      ${filters.accountId !== undefined || filters.attemptOutcome !== undefined ? `WHERE ${[filters.accountId !== undefined ? 'ids.account_id = ?' : '', filters.attemptOutcome !== undefined ? 'a.total_attempts > 0' : ''].filter(Boolean).join(' AND ')}` : ''}
      ORDER BY ids.account_id`).all(...params, ...(filters.attemptOutcome !== undefined ? [filters.attemptOutcome] : []), ...(filters.accountId !== undefined ? [filters.accountId] : [])) as {
        account_id: string; total_attempts: number; success_attempts: number; failed_attempts: number; unknown_attempts: number;
        avg_duration_ms: number | null; input_tokens: number | null; output_tokens: number | null; cache_tokens: number | null; avg_ttft_ms: number | null; last_request_at: string; logical_requests: number; final_requests: number; success_requests: number; failed_requests: number;
      }[];
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private filter(filters: HistoryFilters) {
    const clauses: string[] = [], params: (string | number)[] = [];
    if (filters.attemptOutcome !== undefined) {
      clauses.push(`EXISTS (SELECT 1 FROM attempts participant WHERE participant.request_id = requests.request_id AND participant.outcome = ?${filters.accountId !== undefined ? ' AND participant.account_id = ?' : ''})`);
      params.push(filters.attemptOutcome, ...(filters.accountId !== undefined ? [filters.accountId] : []));
    } else if (filters.accountId !== undefined) {
      clauses.push('(account_id = ? OR EXISTS (SELECT 1 FROM attempts participant WHERE participant.request_id = requests.request_id AND participant.account_id = ?))');
      params.push(filters.accountId, filters.accountId);
    }
    if (filters.finalAccountId !== undefined) { clauses.push('account_id = ?'); params.push(filters.finalAccountId); }
    if (filters.missingModel !== undefined) clauses.push(`requested_model IS ${filters.missingModel ? '' : 'NOT '}NULL`);
    if (filters.metric !== undefined) {
      const columns: HistoryMetric[] = ['input_tokens', 'output_tokens', 'cache_tokens', 'ttft_ms', 'duration_ms'];
      if (columns.includes(filters.metric)) clauses.push(`${filters.metric} IS NOT NULL`);
    }
    for (const [column, value] of [['project_id', filters.projectId], ['requested_model', filters.model]] as const) {
      if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value); }
    }
    if (filters.status !== undefined) {
      if (filters.status === 'success') clauses.push(`NOT ${failedSql}`);
      else if (filters.status === 'error' || filters.status === 'failure') clauses.push(failedSql);
      else if (Number.isInteger(Number(filters.status))) { clauses.push('status = ?'); params.push(Number(filters.status)); }
    }
    if (filters.result !== undefined) clauses.push(filters.result === 'none' ? '0' : filters.result === 'success' ? `NOT ${failedSql}` : failedSql);
    for (const [operator, value] of [['>=', filters.from], ['<=', filters.to], ['<', filters.toExclusive]] as const) {
      if (value !== undefined && Number.isFinite(new Date(value).getTime())) { clauses.push(`time ${operator} ?`); params.push(new Date(value).toISOString()); }
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
}
let store: RequestHistoryStore | undefined;
let configuredPath: string | undefined;
export function configureRequestHistory(databasePath?: string): void {
  closeRequestHistory();
  configuredPath = databasePath ?? (process.env.VITEST && !process.env.AG_PROXY_DATA_DIR ? ':memory:' : path.join(getDataDir(), 'request-history.db'));
}
export function closeRequestHistory(): void { store?.close(); store = undefined; }
export function getRequestHistoryStore(): RequestHistoryStore {
  if (!store) store = new RequestHistoryStore(configuredPath ?? (process.env.AG_PROXY_DATA_DIR ? path.join(getDataDir(), 'request-history.db') : ':memory:'));
  return store;
}
export function getRequestHistory(filters: HistoryFilters = {}) { return getRequestHistoryStore().getRequestHistory(filters); }
export function getUsageSummary(filters: HistoryFilters = {}, granularity: HistoryGranularity = 'hour') { return getRequestHistoryStore().getUsageSummary(filters, granularity); }
export function getAccountStats(filters: HistoryFilters = {}) { return getRequestHistoryStore().getAccountStats(filters); }
