import { calculateRequestCost, classifyModelPool } from './pricing-catalog';
import {
  round1,
  round4,
  type DrainInterval,
  type WorkloadEvent,
} from './quota-analytics-core';
import type {
  EfficiencyComparison,
  PeriodEfficiencyStats,
  QuotaPricingConfig,
  QuotaWindowKind,
  ShiftVerdict,
} from './quota-analytics-types';

export function computeActiveTimeStats(
  workload: WorkloadEvent[],
  fromMs: number,
  toMs: number,
  idleGapMinutes: number,
): { active_minutes: number; active_hours: number; wall_hours: number; active_share_pct: number; burst_count: number } {
  const wallHours = Math.max(0, (toMs - fromMs) / 3_600_000);
  if (workload.length === 0) {
    return { active_minutes: 0, active_hours: 0, wall_hours: round1(wallHours), active_share_pct: 0, burst_count: 0 };
  }
  const gapMs = Math.max(1, idleGapMinutes) * 60_000;
  const spans = workload
    .map((w) => {
      const dur = Math.max(15_000, Math.min(w.duration_ms || 15_000, 30 * 60_000));
      return [Math.max(fromMs, w.time_ms - dur), Math.min(toMs, w.time_ms)] as [number, number];
    })
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  if (spans.length === 0) {
    return { active_minutes: 0, active_hours: 0, wall_hours: round1(wallHours), active_share_pct: 0, burst_count: 0 };
  }
  let curStart = spans[0][0];
  let curEnd = spans[0][1];
  let activeMs = 0;
  let burstCount = 1;
  for (let i = 1; i < spans.length; i += 1) {
    const [s, e] = spans[i];
    if (s - curEnd <= gapMs) {
      if (e > curEnd) curEnd = e;
    } else {
      activeMs += curEnd - curStart;
      curStart = s;
      curEnd = e;
      burstCount += 1;
    }
  }
  activeMs += curEnd - curStart;
  const activeMinutes = activeMs / 60_000;
  const activeHours = activeMs / 3_600_000;
  return {
    active_minutes: round1(activeMinutes),
    active_hours: Math.round(activeHours * 100) / 100,
    wall_hours: round1(wallHours),
    active_share_pct: wallHours > 0 ? round1(Math.min(100, (activeHours / wallHours) * 100)) : 0,
    burst_count: burstCount,
  };
}

export function computePeriodEfficiency(options: {
  intervals: DrainInterval[];
  workload: WorkloadEvent[];
  fromMs: number;
  toMs: number;
  window: QuotaWindowKind;
}): PeriodEfficiencyStats {
  const { intervals, workload, fromMs, toMs, window } = options;
  const scopedIntervals = intervals.filter(
    (iv) => iv.window === window && iv.end_ms > fromMs && iv.start_ms >= fromMs - 10 * 60_000 && iv.end_ms <= toMs,
  );
  let matchedUsd = 0;
  let matchedTokens = 0;
  let totalDrainPct = 0;
  let measuredMatched = 0;
  let pricedMatched = 0;
  let inputSum = 0;
  let cacheSum = 0;

  for (const iv of scopedIntervals) {
    totalDrainPct += iv.drain_pct;
    for (const w of workload) {
      if (w.account_id === iv.account_id && w.pool === iv.pool && w.time_ms > iv.start_ms && w.time_ms <= iv.end_ms) {
        if (w.input_tokens !== null && w.output_tokens !== null) {
          measuredMatched += 1;
          matchedTokens +=
            (w.input_tokens ?? 0) +
            (w.output_tokens ?? 0) +
            (w.thought_tokens ?? 0) +
            (w.cache_tokens ?? 0) +
            (w.cache_write_tokens ?? 0);
          inputSum += w.input_tokens ?? 0;
          cacheSum += w.cache_tokens ?? 0;
        }
        if (w.priced && w.api_usd !== null) {
          pricedMatched += 1;
          matchedUsd += w.api_usd;
        }
      }
    }
  }

  const usdPer1Pct = totalDrainPct > 0 && pricedMatched > 0 ? round4(matchedUsd / totalDrainPct) : null;
  const tokensPer1Pct = totalDrainPct > 0 && measuredMatched > 0 ? Math.round(matchedTokens / totalDrainPct) : null;
  const implied100 = usdPer1Pct !== null ? round4(usdPer1Pct * 100) : null;
  const impliedMonthly = implied100 !== null ? round4(implied100 * (window === '5h' ? (30 * 24) / 5 : 30 / 7)) : null;

  return {
    from: new Date(fromMs).toISOString(),
    to_exclusive: new Date(toMs).toISOString(),
    matched_api_usd: round4(matchedUsd),
    matched_tokens: matchedTokens,
    sample_drain_pct: round1(totalDrainPct),
    interval_count: scopedIntervals.length,
    usd_per_1pct: usdPer1Pct,
    tokens_per_1pct: tokensPer1Pct,
    implied_100pct_usd: implied100,
    implied_monthly_usd: impliedMonthly,
    priced_coverage_pct: measuredMatched > 0 ? round1((pricedMatched / measuredMatched) * 100) : null,
    cache_hit_pct: inputSum + cacheSum > 0 ? round1((cacheSum / (inputSum + cacheSum)) * 100) : null,
  };
}

export function compareEfficiencyPeriods(
  current: PeriodEfficiencyStats,
  baseline: PeriodEfficiencyStats,
): EfficiencyComparison {
  const minDrain = 5;
  const minIntervals = 2;
  const usdDelta =
    current.usd_per_1pct !== null && baseline.usd_per_1pct !== null && baseline.usd_per_1pct > 0
      ? round1(((current.usd_per_1pct - baseline.usd_per_1pct) / baseline.usd_per_1pct) * 100)
      : null;
  const tokDelta =
    current.tokens_per_1pct !== null && baseline.tokens_per_1pct !== null && baseline.tokens_per_1pct > 0
      ? round1(((current.tokens_per_1pct - baseline.tokens_per_1pct) / baseline.tokens_per_1pct) * 100)
      : null;

  let verdict: ShiftVerdict = 'insufficient_data';
  let reason = `Нужно >= ${minDrain}% расхода и >= ${minIntervals} интервалов в обоих периодах (сейчас: ${baseline.sample_drain_pct}% / ${current.sample_drain_pct}%).`;

  const hasEnoughSamples =
    current.sample_drain_pct >= minDrain &&
    baseline.sample_drain_pct >= minDrain &&
    current.interval_count >= minIntervals &&
    baseline.interval_count >= minIntervals &&
    (current.priced_coverage_pct ?? 0) >= 50 &&
    (baseline.priced_coverage_pct ?? 0) >= 50 &&
    usdDelta !== null;

  if (hasEnoughSamples && usdDelta !== null) {
    if (usdDelta <= -15) {
      verdict = 'possible_nerf';
      reason = `За 1% квоты получено на ${Math.abs(usdDelta)}% меньше API-$ (квота расходуется быстрее).`;
    } else if (usdDelta >= 15) {
      verdict = 'improved';
      reason = `За 1% квоты получено на ${usdDelta}% больше API-$ по сравнению с базовым периодом.`;
    } else {
      verdict = 'stable';
      reason = `Сдвиг ${usdDelta > 0 ? '+' : ''}${usdDelta}% в пределах нормы (±15%).`;
    }
  }

  return {
    verdict,
    reason,
    usd_per_1pct_delta_pct: usdDelta,
    tokens_per_1pct_delta_pct: tokDelta,
    current,
    baseline,
  };
}

export function buildWorkloadFromRaw(
  rows: Array<{
    time: string;
    account_id: string | null;
    requested_model: string | null;
    effective_model: string | null;
    route: string;
    protocol: string;
    project_id: string;
    project_name: string;
    session_key: string | null;
    status: number;
    grpc_status: string | null;
    duration_ms: number;
    input_tokens: number | null;
    output_tokens: number | null;
    thought_tokens: number | null;
    cache_tokens: number | null;
    cache_write_tokens: number | null;
    usage_schema: string | null;
  }>,
  pricing: QuotaPricingConfig,
): WorkloadEvent[] {
  return rows.map((r) => {
    const model = r.effective_model ?? r.requested_model;
    const cost = calculateRequestCost(
      {
        model,
        route: r.route,
        usage_schema: r.usage_schema,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        thought_tokens: r.thought_tokens,
        cache_tokens: r.cache_tokens,
        cache_write_tokens: r.cache_write_tokens,
      },
      pricing,
    );
    return {
      time_ms: Date.parse(r.time),
      account_id: r.account_id,
      model,
      pool: classifyModelPool(model),
      route: r.route,
      usage_schema: r.usage_schema,
      project_id: r.project_id,
      project_name: r.project_name,
      session_key: r.session_key,
      failed: r.status >= 400 || (r.grpc_status !== null && r.grpc_status !== '0'),
      duration_ms: r.duration_ms,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      thought_tokens: r.thought_tokens,
      cache_tokens: r.cache_tokens,
      cache_write_tokens: r.cache_write_tokens,
      api_usd: cost.total_usd,
      cache_savings_usd: cost.cache_savings_usd,
      priced: cost.priced,
    };
  });
}
