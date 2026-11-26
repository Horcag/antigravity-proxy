import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RequestHistoryStore } from '@/observability/request-history';

describe('quota-history SQLite repository & migration', () => {
  it('migrates legacy requests table cleanly without losing rows and records deduplicated quota snapshots + rollups', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-hist-'));
    const dbPath = path.join(tmpDir, 'history.db');
    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE history_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE requests (
          sequence INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, time TEXT NOT NULL,
          protocol TEXT NOT NULL, route TEXT NOT NULL, model TEXT, requested_model TEXT, effective_model TEXT,
          project_id TEXT NOT NULL, project_name TEXT NOT NULL, account_id TEXT,
          status INTEGER NOT NULL, grpc_status TEXT, error_category TEXT, duration_ms INTEGER NOT NULL,
          ttft_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER
        );
        CREATE TABLE attempts (
          sequence INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
          account_id TEXT NOT NULL, effective_model TEXT, outcome TEXT NOT NULL, error_category TEXT, ttft_ms INTEGER
        );
        INSERT INTO requests (request_id, time, protocol, route, model, requested_model, project_id, project_name, account_id, status, duration_ms, input_tokens, output_tokens)
        VALUES ('11111111-1111-4111-8111-111111111111', '2026-11-18T10:00:00.000Z', 'http', '/v1/messages', 'claude-opus-5-5', 'claude-opus-5-5', 'p1', 'Proj', 'acc-1', 200, 100, 50, 10);
      `);
      legacyDb.close();

      let now = Date.parse('2026-11-18T12:00:00.000Z');
      const store = new RequestHistoryStore(dbPath, { now: () => now, retentionDays: 7 });
      try {
        expect(store.getRequestHistory().total).toBe(1);

        const quotaA = {
          subscription_tier: 'Google AI Pro',
          models: {},
          last_successful_refresh_at: now,
          quota_groups: [
            {
              display_name: 'Gemini Models',
              buckets: [
                { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-11-25T00:00:00Z' },
                { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.8, reset_time: '2026-11-18T17:00:00Z' },
              ],
            },
          ],
        };

        // Initial insert: 2 buckets
        expect(store.quotaHistory.recordQuotaSnapshot('acc-1', quotaA, now)).toBe(2);
        // Same values 10m later -> skipped due to 30m heartbeat dedup
        expect(store.quotaHistory.recordQuotaSnapshot('acc-1', quotaA, now + 10 * 60_000)).toBe(0);
        // Same values 31m later -> inserted as heartbeat
        expect(store.quotaHistory.recordQuotaSnapshot('acc-1', quotaA, now + 31 * 60_000)).toBe(2);
        // Drop immediately recorded even after 1m
        const quotaDrop = {
          ...quotaA,
          quota_groups: [{
            display_name: 'Gemini Models',
            buckets: [
              { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.87, reset_time: '2026-11-25T00:00:00Z' },
              { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.72, reset_time: '2026-11-18T17:00:00Z' },
            ],
          }],
        };
        expect(store.quotaHistory.recordQuotaSnapshot('acc-1', quotaDrop, now + 32 * 60_000)).toBe(2);

        // seedAccountSnapshotIfMissing does not duplicate newer snapshot
        store.quotaHistory.seedAccountSnapshotIfMissing('acc-1', quotaA);
        expect(store.quotaHistory.getQuotaSnapshots({ accountId: 'acc-1' })).toHaveLength(6);

        // Record new request with sessionKey & verify rollup + session filter
        store.record({
          time: '2026-11-18T12:15:00.000Z',
          protocol: 'http',
          route: '/v1/messages',
          model: 'claude-opus-5-5',
          effective_model: 'claude-opus-5-5-high',
          account_id: 'acc-1',
          session_key: 'session:abc',
          status: 200,
          duration_ms: 250,
          input_tokens: 1000,
          output_tokens: 200,
          cache_tokens: 500,
          cache_write_tokens: 100,
          usage_schema: 'anthropic',
        });
        expect(store.getRequestHistory({ sessionKey: 'session:abc' }).total).toBe(1);
        expect(store.getRequestHistory({ sessionKey: '__none__' }).total).toBe(1);
        const rollups = store.quotaHistory.getHourlyRollups({ accountId: 'acc-1' });
        expect(rollups).toHaveLength(1);
        expect(rollups[0]).toMatchObject({
          account_id: 'acc-1',
          model: 'claude-opus-5-5-high',
          pool: 'third_party',
          input_tokens: 1000,
          cache_write_tokens: 100,
        });

        // Advance clock by 91 days -> prune removes old snapshots & rollups
        now += 91 * 86_400_000;
        store.quotaHistory.pruneQuotaHistory();
        expect(store.quotaHistory.getQuotaSnapshots()).toHaveLength(0);
        expect(store.quotaHistory.getHourlyRollups()).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
