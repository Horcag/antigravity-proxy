import { describe, expect, it } from 'vitest';
import { normalizePricingConfig } from '@/observability/pricing-catalog';
import { computeQuotaAnalytics } from '@/observability/quota-analytics';
import type { QuotaSnapshotRow } from '@/observability/quota-analytics-types';
import type { AnalyticsRequestRow } from '@/observability/request-history';

const pricing = normalizePricingConfig();
const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const H = 3_600_000;

function snap(acc: string, hoursFromT0: number, frac: number, resetHours = 168): QuotaSnapshotRow {
  const ms = T0 + hoursFromT0 * H;
  return {
    observed_at: new Date(ms).toISOString(),
    observed_ms: ms,
    account_id: acc,
    subscription_tier: 'Google AI Pro',
    pool: 'gemini',
    window: 'weekly',
    bucket_id: 'gemini-weekly',
    remaining_fraction: frac,
    reset_time: new Date(T0 + resetHours * H).toISOString(),
    ai_credits: null,
    is_forbidden: 0,
  };
}

function req(acc: string, hoursFromT0: number, inputTokens: number, outputTokens: number, session = 'session:s1'): AnalyticsRequestRow {
  return {
    time: new Date(T0 + hoursFromT0 * H).toISOString(),
    account_id: acc,
    requested_model: 'gemini-4-neon',
    effective_model: 'gemini-4-neon-high',
    route: '/v1/chat/completions',
    protocol: 'http',
    project_id: 'p1',
    project_name: 'Main',
    session_key: session,
    status: 200,
    grpc_status: null,
    duration_ms: 20_000,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    thought_tokens: null,
    cache_tokens: 0,
    cache_write_tokens: null,
    usage_schema: 'openai',
  };
}

describe('quota-analytics engine', () => {
  it('detects resets, excludes reset jumps from drain, computes active time, and flags a >=15% nerf', () => {
    // Baseline period [0..48h]: 2 drain intervals consuming 10% total (1.00 -> 0.95 -> 0.90) with $6 API spend => $0.60 / 1%
    // Reset at 48h (0.90 -> 1.00) with new reset time!
    // Current period [48..96h]: 2 drain intervals consuming 10% total (1.00 -> 0.95 -> 0.90) with $3 API spend => $0.30 / 1% (-50% => possible_nerf)
    const snapshots: QuotaSnapshotRow[] = [
      snap('a1', 1, 1.0, 48),
      snap('a1', 10, 0.95, 48),
      snap('a1', 20, 0.90, 48),
      snap('a1', 49, 1.0, 216), // reset!
      snap('a1', 60, 0.95, 216),
      snap('a1', 70, 0.90, 216),
    ];

    // gemini-4-neon: $3/1M in, $15/1M out => 1M in = $3
    const baselineRaw = [req('a1', 5, 1_000_000, 0, 'session:base-1'), req('a1', 15, 1_000_000, 0, 'session:base-2')];
    const currentRaw = [req('a1', 55, 500_000, 0, 'session:cur-1'), req('a1', 65, 500_000, 0, 'session:cur-2')];

    const result = computeQuotaAnalytics({
      nowMs: T0 + 96 * H,
      fromMs: T0 + 48 * H,
      toExclusiveMs: T0 + 96 * H,
      baselineFromMs: T0,
      baselineToExclusiveMs: T0 + 48 * H,
      preset: '7d',
      pool: 'all',
      window: 'weekly',
      accountId: null,
      projectId: null,
      model: null,
      tier: null,
      splitAt: null,
      idleGapMinutes: 5,
      minDeltaPp: 0.5,
      rawRetentionDays: 7,
      snapshotRetentionDays: 90,
      accounts: [{ id: 'a1', label: 'alice@example.test', subscription_tier: 'Google AI Pro', disabled: false }],
      rawRequests: currentRaw,
      baselineRawRequests: baselineRaw,
      hourlyRollups: [],
      snapshots,
      pricing,
    });

    expect(result.resets).toHaveLength(1);
    expect(result.resets[0]).toMatchObject({ from_pct: 90, to_pct: 100, delta_pct: 10, boundary_accuracy: 'exact' });
    expect(result.efficiency.baseline.sample_drain_pct).toBe(10);
    expect(result.efficiency.baseline.usd_per_1pct).toBeCloseTo(0.6, 3);
    expect(result.efficiency.current.sample_drain_pct).toBe(10);
    expect(result.efficiency.current.usd_per_1pct).toBeCloseTo(0.3, 3);
    expect(result.efficiency.verdict).toBe('possible_nerf');
    expect(result.efficiency.usd_per_1pct_delta_pct).toBeCloseTo(-50, 1);
    expect(result.summary.active_minutes).toBeGreaterThan(0);
    expect(result.sessions).toHaveLength(2);
    expect(result.hints.some((h) => h.id === 'nerf')).toBe(true);
  });

  it('negative control: returns insufficient_data when drain sample is below 5% or fewer than 2 intervals', () => {
    const snapshots = [snap('a1', 1, 1.0, 168), snap('a1', 10, 0.98, 168), snap('a1', 50, 1.0, 336), snap('a1', 60, 0.98, 336)];
    const result = computeQuotaAnalytics({
      nowMs: T0 + 96 * H,
      fromMs: T0 + 48 * H,
      toExclusiveMs: T0 + 96 * H,
      baselineFromMs: T0,
      baselineToExclusiveMs: T0 + 48 * H,
      preset: '7d',
      pool: 'all',
      window: 'weekly',
      accountId: null,
      projectId: null,
      model: null,
      tier: null,
      splitAt: null,
      idleGapMinutes: 5,
      minDeltaPp: 0.5,
      rawRetentionDays: 7,
      snapshotRetentionDays: 90,
      accounts: [{ id: 'a1', label: 'alice', subscription_tier: 'Google AI Pro', disabled: false }],
      rawRequests: [req('a1', 55, 500_000, 0)],
      baselineRawRequests: [req('a1', 5, 1_000_000, 0)],
      hourlyRollups: [],
      snapshots,
      pricing,
    });

    expect(result.efficiency.verdict).toBe('insufficient_data');
    expect(result.summary.verdict).toBe('insufficient_data');
  });
});
