import type Database from 'better-sqlite3';
import type { CloudQuotaData } from '@/modules/cloud-account/types';
import { classifyModelPool } from './pricing-catalog';
import { safeLabel } from './metadata';
import type { HourlyRollupRow, QuotaPoolId, QuotaSnapshotRow, QuotaWindowKind } from './quota-analytics-types';

export const SNAPSHOT_RETENTION_DAYS = 90;
const SNAPSHOT_HEARTBEAT_MS = 30 * 60_000;
const PRUNE_THROTTLE_MS = 5 * 60_000;

export interface ExtractedQuotaBucket {
  pool: QuotaPoolId;
  window: QuotaWindowKind;
  bucket_id: string;
  remaining_fraction: number;
  reset_time: string | null;
}

function normalizeMs(ts: number | undefined, fallback: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return fallback;
  return ts < 1e12 ? Math.floor(ts * 1000) : Math.floor(ts);
}

function classifyBucketPool(groupText: string, bucketText: string): QuotaPoolId | null {
  const combined = `${groupText} ${bucketText}`.toLowerCase();
  if (/claude|gpt|3p/.test(combined)) return 'third_party';
  if (/argon/.test(combined)) return 'argon';
  if (/gemini/.test(combined)) return 'gemini';
  return null;
}

export function extractQuotaBuckets(quota: CloudQuotaData, observedMs: number): ExtractedQuotaBucket[] {
  const result = new Map<string, ExtractedQuotaBucket>();
  for (const group of quota.quota_groups ?? []) {
    const groupText = `${group.display_name ?? ''} ${group.description ?? ''}`;
    for (const bucket of group.buckets ?? []) {
      const pool = classifyBucketPool(groupText, `${bucket.bucket_id ?? ''} ${bucket.display_name ?? ''} ${bucket.description ?? ''}`);
      if (!pool || !Number.isFinite(bucket.remaining_fraction)) continue;
      const rawWin = `${bucket.window ?? ''} ${bucket.bucket_id ?? ''}`.toLowerCase();
      const window: QuotaWindowKind = rawWin.includes('5h') ? '5h' : 'weekly';
      const bucketId = safeLabel(bucket.bucket_id || `${pool}-${window}`, `${pool}-${window}`);
      const fraction = Math.max(0, Math.min(1, bucket.remaining_fraction));
      const key = `${pool}:${window}:${bucketId}`;
      const existing = result.get(key);
      if (!existing || fraction < existing.remaining_fraction) {
        result.set(key, {
          pool,
          window,
          bucket_id: bucketId,
          remaining_fraction: fraction,
          reset_time: typeof bucket.reset_time === 'string' && bucket.reset_time.trim() ? bucket.reset_time.trim() : null,
        });
      }
    }
  }
  if (result.size > 0) return Array.from(result.values());

  for (const [modelId, info] of Object.entries(quota.models ?? {})) {
    const lower = modelId.toLowerCase();
    if (lower.endsWith('-sonar') || lower.endsWith('-disabled') || lower.startsWith('gemini-2.5-') || lower.startsWith('gemini-2.0-')) {
      continue;
    }
    const pool = classifyModelPool(modelId);
    if (pool === 'other' || !Number.isFinite(info.percentage)) continue;
    const fraction = Math.max(0, Math.min(1, info.percentage / 100));
    const resetMs = info.resetTime ? Date.parse(info.resetTime) : NaN;
    const window: QuotaWindowKind = pool === 'argon' || (Number.isFinite(resetMs) && resetMs - observedMs > 24 * 3_600_000)
      ? 'weekly'
      : '5h';
    const bucketId = `models-fallback-${pool}-${window}`;
    const key = `${pool}:${window}:${bucketId}`;
    const existing = result.get(key);
    if (!existing || fraction < existing.remaining_fraction) {
      result.set(key, {
        pool,
        window,
        bucket_id: bucketId,
        remaining_fraction: fraction,
        reset_time: typeof info.resetTime === 'string' && info.resetTime.trim() ? info.resetTime.trim() : null,
      });
    }
  }
  return Array.from(result.values());
}

export class QuotaHistoryRepository {
  private lastPruneAt = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
    private readonly retentionDays: number = SNAPSHOT_RETENTION_DAYS,
  ) {}

  initSchema(): void {
    const columns = (this.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
    const additions: Array<[string, string]> = [
      ['session_key', 'TEXT'],
      ['thought_tokens', 'INTEGER'],
      ['cache_write_tokens', 'INTEGER'],
      ['usage_schema', 'TEXT'],
    ];
    for (const [col, type] of additions) {
      if (!columns.includes(col)) {
        this.db.exec(`ALTER TABLE requests ADD COLUMN ${col} ${type}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS requests_session ON requests(session_key, time);
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        id INTEGER PRIMARY KEY,
        observed_at TEXT NOT NULL,
        observed_ms INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        subscription_tier TEXT,
        pool TEXT NOT NULL,
        window TEXT NOT NULL,
        bucket_id TEXT NOT NULL,
        remaining_fraction REAL NOT NULL,
        reset_time TEXT,
        ai_credits REAL,
        is_forbidden INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS quota_snapshots_lookup ON quota_snapshots(account_id, pool, window, observed_ms);
      CREATE INDEX IF NOT EXISTS quota_snapshots_time ON quota_snapshots(observed_ms);
      CREATE TABLE IF NOT EXISTS hourly_usage_rollups (
        hour_ms INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        model TEXT NOT NULL,
        pool TEXT NOT NULL,
        usage_schema TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        failed_requests INTEGER NOT NULL DEFAULT 0,
        measured_requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        thought_tokens INTEGER NOT NULL DEFAULT 0,
        cache_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, account_id, model, pool, usage_schema)
      );
      CREATE INDEX IF NOT EXISTS hourly_usage_rollups_time ON hourly_usage_rollups(hour_ms);
    `);
  }

  recordQuotaSnapshot(accountId: string, quota: CloudQuotaData, observedMsInput?: number): number {
    const safeAccount = safeLabel(accountId, '');
    if (!safeAccount) return 0;
    const observedMs = normalizeMs(observedMsInput ?? quota.last_successful_refresh_at, this.now());
    const observedAt = new Date(observedMs).toISOString();
    const buckets = extractQuotaBuckets(quota, observedMs);
    const tier = typeof quota.subscription_tier === 'string' && quota.subscription_tier.trim()
      ? quota.subscription_tier.trim().slice(0, 80)
      : null;
    const isForbidden = quota.is_forbidden || quota.isForbidden ? 1 : 0;
    const aiCredits = typeof quota.ai_credits?.credits === 'number' && Number.isFinite(quota.ai_credits.credits)
      ? quota.ai_credits.credits
      : null;

    const latestStmt = this.db.prepare(
      `SELECT observed_ms, remaining_fraction, reset_time, subscription_tier, is_forbidden
       FROM quota_snapshots WHERE account_id = ? AND pool = ? AND window = ? AND bucket_id = ?
       ORDER BY observed_ms DESC, id DESC LIMIT 1`,
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO quota_snapshots(
        observed_at, observed_ms, account_id, subscription_tier, pool, window, bucket_id,
        remaining_fraction, reset_time, ai_credits, is_forbidden
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let inserted = 0;
    this.db.transaction(() => {
      for (const bucket of buckets) {
        const prev = latestStmt.get(safeAccount, bucket.pool, bucket.window, bucket.bucket_id) as {
          observed_ms: number;
          remaining_fraction: number;
          reset_time: string | null;
          subscription_tier: string | null;
          is_forbidden: number;
        } | undefined;
        if (prev) {
          const sameFraction = Math.abs(prev.remaining_fraction - bucket.remaining_fraction) < 1e-6;
          const prevResetMs = prev.reset_time ? Date.parse(prev.reset_time) : NaN;
          const nextResetMs = bucket.reset_time ? Date.parse(bucket.reset_time) : NaN;
          const sameReset = (prev.reset_time ?? null) === (bucket.reset_time ?? null)
            || (Number.isFinite(prevResetMs) && Number.isFinite(nextResetMs) && Math.abs(prevResetMs - nextResetMs) <= 5_000);
          const sameMeta = (prev.subscription_tier ?? null) === tier && prev.is_forbidden === isForbidden;
          const withinHeartbeat = observedMs >= prev.observed_ms && observedMs - prev.observed_ms < SNAPSHOT_HEARTBEAT_MS;
          if (sameFraction && sameReset && sameMeta && withinHeartbeat) {
            continue;
          }
        }
        insertStmt.run(
          observedAt,
          observedMs,
          safeAccount,
          tier,
          bucket.pool,
          bucket.window,
          bucket.bucket_id,
          bucket.remaining_fraction,
          bucket.reset_time,
          aiCredits,
          isForbidden,
        );
        inserted += 1;
      }
    })();

    this.maybePrune();
    return inserted;
  }

  seedAccountSnapshotIfMissing(accountId: string, quota: CloudQuotaData | undefined): void {
    if (!quota?.last_successful_refresh_at) return;
    const safeAccount = safeLabel(accountId, '');
    if (!safeAccount) return;
    const observedMs = normalizeMs(quota.last_successful_refresh_at, 0);
    if (!observedMs) return;
    const latest = this.db
      .prepare('SELECT MAX(observed_ms) AS max_ms FROM quota_snapshots WHERE account_id = ?')
      .get(safeAccount) as { max_ms: number | null };
    if (latest.max_ms !== null && latest.max_ms >= observedMs - 1_000) return;
    this.recordQuotaSnapshot(safeAccount, quota, observedMs);
  }

  recordUsageRollup(input: {
    timeMs: number;
    accountId: string;
    model: string;
    usageSchema: string;
    failed: boolean;
    inputTokens: number | null;
    outputTokens: number | null;
    thoughtTokens: number | null;
    cacheTokens: number | null;
    cacheWriteTokens: number | null;
  }): void {
    const hourMs = Math.floor(input.timeMs / 3_600_000) * 3_600_000;
    const measured = input.inputTokens !== null && input.outputTokens !== null ? 1 : 0;
    const pool = classifyModelPool(input.model);
    this.db
      .prepare(
        `INSERT INTO hourly_usage_rollups(
          hour_ms, account_id, model, pool, usage_schema,
          requests, failed_requests, measured_requests,
          input_tokens, output_tokens, thought_tokens, cache_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hour_ms, account_id, model, pool, usage_schema) DO UPDATE SET
          requests = requests + 1,
          failed_requests = failed_requests + excluded.failed_requests,
          measured_requests = measured_requests + excluded.measured_requests,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          thought_tokens = thought_tokens + excluded.thought_tokens,
          cache_tokens = cache_tokens + excluded.cache_tokens,
          cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
      )
      .run(
        hourMs,
        input.accountId,
        input.model,
        pool,
        input.usageSchema,
        input.failed ? 1 : 0,
        measured,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.thoughtTokens ?? 0,
        input.cacheTokens ?? 0,
        input.cacheWriteTokens ?? 0,
      );
  }

  getQuotaSnapshots(filters: {
    fromMs?: number;
    toExclusiveMs?: number;
    accountId?: string;
    pool?: QuotaPoolId;
    window?: QuotaWindowKind;
  } = {}): QuotaSnapshotRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.fromMs !== undefined) { clauses.push('observed_ms >= ?'); params.push(filters.fromMs); }
    if (filters.toExclusiveMs !== undefined) { clauses.push('observed_ms < ?'); params.push(filters.toExclusiveMs); }
    if (filters.accountId !== undefined) { clauses.push('account_id = ?'); params.push(filters.accountId); }
    if (filters.pool !== undefined) { clauses.push('pool = ?'); params.push(filters.pool); }
    if (filters.window !== undefined) { clauses.push('window = ?'); params.push(filters.window); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM quota_snapshots ${where} ORDER BY observed_ms ASC, id ASC LIMIT 100000`)
      .all(...params) as QuotaSnapshotRow[];
  }

  getHourlyRollups(filters: {
    fromMs?: number;
    toExclusiveMs?: number;
    accountId?: string;
    model?: string;
  } = {}): HourlyRollupRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.fromMs !== undefined) { clauses.push('hour_ms >= ?'); params.push(Math.floor(filters.fromMs / 3_600_000) * 3_600_000); }
    if (filters.toExclusiveMs !== undefined) { clauses.push('hour_ms < ?'); params.push(filters.toExclusiveMs); }
    if (filters.accountId !== undefined) { clauses.push('account_id = ?'); params.push(filters.accountId); }
    if (filters.model !== undefined) { clauses.push('model = ?'); params.push(filters.model); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM hourly_usage_rollups ${where} ORDER BY hour_ms ASC LIMIT 100000`)
      .all(...params) as HourlyRollupRow[];
  }

  pruneQuotaHistory(): void {
    const cutoff = this.now() - Math.max(1, this.retentionDays) * 86_400_000;
    this.db.prepare('DELETE FROM quota_snapshots WHERE observed_ms < ?').run(cutoff);
    this.db.prepare('DELETE FROM hourly_usage_rollups WHERE hour_ms < ?').run(cutoff);
    this.lastPruneAt = this.now();
  }

  private maybePrune(): void {
    if (this.now() - this.lastPruneAt >= PRUNE_THROTTLE_MS) {
      this.pruneQuotaHistory();
    }
  }
}
