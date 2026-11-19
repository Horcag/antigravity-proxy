import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const code = ts.transpileModule(fs.readFileSync(new URL('./quotaChartModel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const {
  createQuotaChartGeometry,
  pointAtX,
  formatUsd,
  formatTokensCompact,
  formatCountdownUntil,
} = await import(dataUrl(code));

test('createQuotaChartGeometry handles empty, single-point, direction toggle, and reset cliff markers', () => {
  const empty = createQuotaChartGeometry([], 'remaining');
  assert.equal(empty.points.length, 0);
  assert.equal(pointAtX(empty.points, 100), -1);

  const timeline = [
    {
      time: '2026-11-18T10:00:00.000Z',
      time_ms: Date.parse('2026-11-18T10:00:00.000Z'),
      pool_remaining_pct: 90,
      pool_account_equivalents: 0.9,
      active_accounts_count: 1,
      stale_accounts_count: 0,
      api_usd: 1.5,
      requests: 10,
      by_account: { a1: 90 },
      resets: [],
    },
    {
      time: '2026-11-18T12:00:00.000Z',
      time_ms: Date.parse('2026-11-18T12:00:00.000Z'),
      pool_remaining_pct: 100,
      pool_account_equivalents: 1.0,
      active_accounts_count: 1,
      stale_accounts_count: 0,
      api_usd: 0.5,
      requests: 4,
      by_account: { a1: 100 },
      resets: [{ observed_at: '2026-11-18T12:00:00.000Z', observed_ms: 0, account_id: 'a1', account_label: 'a1', pool: 'gemini', window: 'weekly', from_pct: 60, to_pct: 100, delta_pct: 40, new_reset_time: null, boundary_accuracy: 'exact' }],
    },
  ];

  const rem = createQuotaChartGeometry(timeline, 'remaining', ['a1']);
  assert.equal(rem.points[0].pct, 90);
  assert.equal(rem.points[1].hasReset, true);
  assert.equal(rem.points[1].resetLabel, '↺ +40%');
  assert.equal(rem.accountSeries.length, 1);

  const used = createQuotaChartGeometry(timeline, 'used', ['a1']);
  assert.equal(used.points[0].pct, 10);
  assert.equal(used.points[1].pct, 0);
  assert.equal(pointAtX(used.points, used.points[1].x), 1);
});

test('formatters render Russian/USD/countdown safely', () => {
  assert.equal(formatUsd(null), 'Неизвестно');
  assert.match(formatUsd(12.345, 2), /12,35/);
  assert.match(formatTokensCompact(1_500_000), /1,5M/);
  assert.equal(formatCountdownUntil('2026-11-19T10:30:00Z', Date.parse('2026-11-19T08:00:00Z')), 'через 2 ч 30 м');
});
