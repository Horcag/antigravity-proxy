import { calculateRequestCost, resolveAccountMonthlyUsd } from './pricing-catalog';
import { requestMetadata } from './metadata';
import { aggregateWorkloadBreakdowns, buildOptimizationHints } from './quota-analytics-breakdowns';
import {
  buildPoolTimeline,
  detectResetsAndDrainIntervals,
  matchesPool,
  round1,
  round4,
  type AccountMeta,
  type WorkloadEvent,
} from './quota-analytics-core';
import {
  buildWorkloadFromRaw,
  compareEfficiencyPeriods,
  computeActiveTimeStats,
  computePeriodEfficiency,
} from './quota-analytics-efficiency';
import type {
  AccountQuotaCostRow,
  HourlyRollupRow,
  PaceStatus,
  QuotaAnalyticsResponse,
  QuotaPoolFilter,
  QuotaPreset,
  QuotaPricingConfig,
  QuotaSnapshotRow,
  QuotaWindowKind,
} from './quota-analytics-types';
import type { AnalyticsRequestRow } from './request-history';

export interface ComputeQuotaAnalyticsInput {
  nowMs: number;
  fromMs: number;
  toExclusiveMs: number;
  baselineFromMs: number;
  baselineToExclusiveMs: number;
  efficiencyCurrentFromMs?: number;
  preset: QuotaPreset;
  pool: QuotaPoolFilter;
  window: QuotaWindowKind;
  accountId: string | null;
  projectId: string | null;
  model: string | null;
  tier: string | null;
  splitAt: string | null;
  idleGapMinutes: number;
  minDeltaPp: number;
  rawRetentionDays: number;
  snapshotRetentionDays: number;
  accounts: AccountMeta[];
  rawRequests: AnalyticsRequestRow[];
  baselineRawRequests: AnalyticsRequestRow[];
  hourlyRollups: HourlyRollupRow[];
  snapshots: QuotaSnapshotRow[];
  pricing: QuotaPricingConfig;
}

function rollupsToWorkload(rollups: HourlyRollupRow[], pricing: QuotaPricingConfig): WorkloadEvent[] {
  return rollups.map((r) => {
    const cost = calculateRequestCost(
      {
        model: r.model || null,
        usage_schema: r.usage_schema,
        input_tokens: r.measured_requests > 0 ? r.input_tokens : null,
        output_tokens: r.measured_requests > 0 ? r.output_tokens : null,
        thought_tokens: r.thought_tokens,
        cache_tokens: r.cache_tokens,
        cache_write_tokens: r.cache_write_tokens,
      },
      pricing,
    );
    return {
      time_ms: r.hour_ms + 1_800_000,
      account_id: r.account_id || null,
      model: r.model || null,
      pool: r.pool,
      route: '',
      usage_schema: r.usage_schema,
      project_id: '',
      project_name: '',
      session_key: null,
      failed: r.failed_requests > 0,
      duration_ms: 0,
      input_tokens: r.measured_requests > 0 ? r.input_tokens : null,
      output_tokens: r.measured_requests > 0 ? r.output_tokens : null,
      thought_tokens: r.thought_tokens,
      cache_tokens: r.cache_tokens,
      cache_write_tokens: r.cache_write_tokens,
      api_usd: cost.total_usd,
      cache_savings_usd: cost.cache_savings_usd,
      priced: cost.priced,
    };
  });
}

function computePaceHealth(
  remainingPct: number | null,
  nearestResetIso: string | null,
  window: QuotaWindowKind,
  nowMs: number,
  runwayActiveHours: number | null,
): { elapsed_window_pct: number | null; pace_delta_pct: number | null; pace_status: PaceStatus } {
  const windowMs = window === '5h' ? 5 * 3_600_000 : 7 * 86_400_000;
  const resetMs = nearestResetIso ? Date.parse(nearestResetIso) : NaN;
  let elapsedPct: number | null = null;
  let paceDelta: number | null = null;
  if (remainingPct !== null && Number.isFinite(resetMs) && resetMs > nowMs && resetMs - nowMs <= windowMs) {
    elapsedPct = round1(((windowMs - (resetMs - nowMs)) / windowMs) * 100);
    paceDelta = round1(100 - remainingPct - elapsedPct);
  }
  let paceStatus: PaceStatus = 'unknown';
  if (remainingPct !== null) {
    const hoursToReset = Number.isFinite(resetMs) && resetMs > nowMs ? (resetMs - nowMs) / 3_600_000 : null;
    if (remainingPct <= 0.5 || (paceDelta !== null && paceDelta > 20) || (runwayActiveHours !== null && hoursToReset !== null && runwayActiveHours < Math.min(2, hoursToReset * 0.4))) {
      paceStatus = 'will_exhaust';
    } else if ((paceDelta !== null && paceDelta > 5) || (runwayActiveHours !== null && hoursToReset !== null && runwayActiveHours < hoursToReset)) {
      paceStatus = 'tight';
    } else if (paceDelta !== null || runwayActiveHours !== null) {
      paceStatus = 'ok';
    }
  }
  return { elapsed_window_pct: elapsedPct, pace_delta_pct: paceDelta, pace_status: paceStatus };
}

export function computeQuotaAnalytics(input: ComputeQuotaAnalyticsInput): QuotaAnalyticsResponse {
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  const eligibleAccounts = input.accounts.filter((a) => {
    if (input.accountId && a.id !== input.accountId) return false;
    if (input.tier && (a.subscription_tier ?? '').toLowerCase() !== input.tier.toLowerCase()) return false;
    return true;
  });
  const eligibleIds = eligibleAccounts.map((a) => a.id);
  const eligibleSet = new Set(eligibleIds);

  const filterRawInference = (rows: AnalyticsRequestRow[]) =>
    rows.filter((r) => {
      if (requestMetadata(r.route, r.protocol, r.account_id).request_kind !== 'inference') return false;
      if (input.accountId && r.account_id !== input.accountId) return false;
      if (input.tier && !eligibleSet.has(r.account_id ?? '')) return false;
      if (input.projectId && r.project_id !== input.projectId) return false;
      if (input.model) {
        const m = (r.effective_model ?? r.requested_model ?? '').toLowerCase();
        if (!m.includes(input.model.toLowerCase())) return false;
      }
      return true;
    });

  const currentInferenceRaw = filterRawInference(input.rawRequests);
  const rawEarliestMs = input.nowMs - input.rawRetentionDays * 86_400_000;
  const rawBoundaryHourMs = Math.floor(rawEarliestMs / 3_600_000) * 3_600_000;
  const currentRawWorkload = buildWorkloadFromRaw(currentInferenceRaw, input.pricing).filter((w) => matchesPool(w.pool, input.pool));
  const usingHourlyRollups = input.fromMs < rawBoundaryHourMs || input.baselineFromMs < rawBoundaryHourMs;

  const filteredRollups = (fromMs: number, toMs: number) =>
    rollupsToWorkload(
      input.hourlyRollups.filter((r) => {
        if (r.hour_ms < Math.floor(fromMs / 3_600_000) * 3_600_000 || r.hour_ms >= toMs) return false;
        if (input.accountId && r.account_id !== input.accountId) return false;
        if (input.tier && !eligibleSet.has(r.account_id)) return false;
        if (input.model && !r.model.toLowerCase().includes(input.model.toLowerCase())) return false;
        return matchesPool(r.pool, input.pool);
      }),
      input.pricing,
    );

  const olderRollupWorkload = input.fromMs < rawBoundaryHourMs && !input.projectId
    ? filteredRollups(input.fromMs, Math.min(input.toExclusiveMs, rawBoundaryHourMs))
    : [];
  const currentWorkload = olderRollupWorkload.length > 0
    ? [...olderRollupWorkload, ...currentRawWorkload.filter((w) => w.time_ms >= rawBoundaryHourMs)].sort((a, b) => a.time_ms - b.time_ms)
    : currentRawWorkload;
  const baselineWorkload = input.baselineFromMs >= rawBoundaryHourMs
    ? buildWorkloadFromRaw(filterRawInference(input.baselineRawRequests), input.pricing).filter((w) => matchesPool(w.pool, input.pool))
    : filteredRollups(input.baselineFromMs, input.baselineToExclusiveMs);

  const filteredSnaps = input.snapshots.filter((s) => (eligibleSet.size === 0 || eligibleSet.has(s.account_id)) && matchesPool(s.pool, input.pool));
  const { resets, intervals } = detectResetsAndDrainIntervals(filteredSnaps, accountsById, input.minDeltaPp);
  const timeline = buildPoolTimeline({
    snapshots: input.snapshots, resets, workload: currentWorkload, eligibleAccountIds: eligibleIds,
    poolFilter: input.pool, window: input.window, fromMs: input.fromMs, toMs: input.toExclusiveMs,
  });

  const active = computeActiveTimeStats(currentWorkload, input.fromMs, input.toExclusiveMs, input.idleGapMinutes);
  const effFromMs = input.efficiencyCurrentFromMs ?? input.fromMs;
  const effWorkload = effFromMs === input.fromMs ? currentWorkload : currentWorkload.filter((w) => w.time_ms >= effFromMs);
  const currentEff = computePeriodEfficiency({ intervals, workload: effWorkload, fromMs: effFromMs, toMs: input.toExclusiveMs, window: input.window });
  const baselineEff = computePeriodEfficiency({ intervals, workload: baselineWorkload, fromMs: input.baselineFromMs, toMs: input.baselineToExclusiveMs, window: input.window });
  const efficiency = compareEfficiencyPeriods(currentEff, baselineEff);
  const agg = aggregateWorkloadBreakdowns(currentWorkload, accountsById, input.preset);

  const latestByAccWinPool = new Map<string, QuotaSnapshotRow>();
  for (const s of filteredSnaps) {
    if (s.observed_ms <= input.toExclusiveMs) latestByAccWinPool.set(`${s.account_id}|${s.window}|${s.pool}|${s.bucket_id}`, s);
  }

  const periodDays = Math.max(0.01, (input.toExclusiveMs - input.fromMs) / 86_400_000);
  let monthlyTotalUsd: number | null = 0;
  let staleCount = 0;
  const tierCounts = new Map<string, number>();
  const weeklyPcts: number[] = [];
  const fiveHPcts: number[] = [];
  const futureResets: string[] = [];

  const byAccount: AccountQuotaCostRow[] = eligibleAccounts.map((acc) => {
    const tierName = acc.subscription_tier ?? 'Неизвестно';
    tierCounts.set(tierName, (tierCounts.get(tierName) ?? 0) + 1);
    const monthly = resolveAccountMonthlyUsd(acc.id, acc.subscription_tier, input.pricing);
    if (monthly === null) monthlyTotalUsd = null;
    else if (monthlyTotalUsd !== null) monthlyTotalUsd += monthly;

    const accSnaps = Array.from(latestByAccWinPool.values()).filter((s) => s.account_id === acc.id);
    const wSnaps = accSnaps.filter((s) => s.window === 'weekly');
    const hSnaps = accSnaps.filter((s) => s.window === '5h');
    const weeklyPct = wSnaps.length ? round1((wSnaps.reduce((a, b) => a + b.remaining_fraction, 0) / wSnaps.length) * 100) : null;
    const fiveHPct = hSnaps.length ? round1((hSnaps.reduce((a, b) => a + b.remaining_fraction, 0) / hSnaps.length) * 100) : null;
    const wReset = wSnaps.map((s) => s.reset_time).filter((v): v is string => Boolean(v)).sort()[0] ?? null;
    const hReset = hSnaps.map((s) => s.reset_time).filter((v): v is string => Boolean(v)).sort()[0] ?? null;
    const latestMs = accSnaps.reduce((mx, s) => Math.max(mx, s.observed_ms), acc.last_refresh_at ?? 0);
    const stale = !latestMs || input.nowMs - latestMs > 30 * 60_000;
    if (stale) staleCount += 1;
    if (weeklyPct !== null) weeklyPcts.push(weeklyPct);
    if (fiveHPct !== null) fiveHPcts.push(fiveHPct);
    const targetReset = input.window === '5h' ? hReset : wReset;
    if (targetReset && Date.parse(targetReset) > input.nowMs) futureResets.push(targetReset);

    const aStats = agg.accAgg.get(acc.id);
    const aDrain = intervals
      .filter((iv) => iv.account_id === acc.id && iv.window === input.window && iv.end_ms > input.fromMs && iv.end_ms <= input.toExclusiveMs)
      .reduce((sum, iv) => sum + iv.drain_pct, 0);
    const aPeriodSub = monthly !== null ? monthly * (periodDays / 30) : null;
    const aUsd = aStats && aStats.priced > 0 ? round4(aStats.usd) : null;
    return {
      account_id: acc.id, label: acc.label, subscription_tier: acc.subscription_tier, monthly_usd: monthly,
      weekly_pct: weeklyPct, weekly_reset_time: wReset, five_hour_pct: fiveHPct, five_hour_reset_time: hReset,
      last_refresh_at: latestMs ? new Date(latestMs).toISOString() : null, stale,
      requests: aStats?.req ?? 0, failed_requests: aStats?.fail ?? 0, api_usd: aUsd,
      roi_ratio: aUsd !== null && aPeriodSub && aPeriodSub > 0 ? round4(aUsd / aPeriodSub) : null,
      drain_pct: round1(aDrain), usd_per_1pct: aUsd !== null && aDrain >= 0.5 ? round4(aUsd / aDrain) : null,
    };
  });

  const poolWeeklyPct = weeklyPcts.length ? round1(weeklyPcts.reduce((a, b) => a + b, 0) / weeklyPcts.length) : null;
  const pool5hPct = fiveHPcts.length ? round1(fiveHPcts.reduce((a, b) => a + b, 0) / fiveHPcts.length) : null;
  const selectedPoolPct = input.window === '5h' ? pool5hPct : poolWeeklyPct;
  const nearestReset = futureResets.sort()[0] ?? null;
  const avgAccountDrainPct = eligibleAccounts.length > 0 ? currentEff.sample_drain_pct / Math.max(1, eligibleAccounts.length) : 0;
  const pctPerActiveHour = active.active_hours > 0 && avgAccountDrainPct > 0 ? round4(avgAccountDrainPct / active.active_hours) : null;
  const runwayActiveHours = selectedPoolPct !== null && pctPerActiveHour && pctPerActiveHour > 0 ? round1(selectedPoolPct / pctPerActiveHour) : null;
  const pace = computePaceHealth(selectedPoolPct, nearestReset, input.window, input.nowMs, runwayActiveHours);
  const periodSubUsd = monthlyTotalUsd !== null ? round4(monthlyTotalUsd * (periodDays / 30)) : null;
  const totalTokens = agg.inTok + agg.outTok + agg.thoughtTok + agg.cacheTok + agg.cacheWriteTok;
  const cacheHitPct = agg.inTok + agg.cacheTok > 0 ? round1((agg.cacheTok / (agg.inTok + agg.cacheTok)) * 100) : null;
  const tierBreakdown = Array.from(tierCounts.entries()).map(([tier, accounts]) => ({ tier, accounts }));
  const hints = buildOptimizationHints({
    verdict: efficiency.verdict, verdictReason: efficiency.reason, cacheHitPct, totalApiUsd: agg.totalApiUsd,
    thoughtTok: agg.thoughtTok, outTok: agg.outTok, failedCount: agg.failedCount, totalRequests: currentWorkload.length,
    topSession: agg.sessions[0],
  });

  return {
    range: { from: new Date(input.fromMs).toISOString(), to_exclusive: new Date(input.toExclusiveMs).toISOString(), preset: input.preset, time_zone: 'Europe/Samara' },
    filters: {
      pool: input.pool, window: input.window, account_id: input.accountId, project_id: input.projectId,
      model: input.model, tier: input.tier, split_at: input.splitAt, idle_gap_minutes: input.idleGapMinutes, min_delta_pp: input.minDeltaPp,
    },
    data_quality: {
      raw_retention_days: input.rawRetentionDays, snapshot_retention_days: input.snapshotRetentionDays,
      using_hourly_rollups: usingHourlyRollups, snapshots_count: filteredSnaps.length,
      priced_coverage_pct: agg.measuredCount > 0 ? round1((agg.pricedCount / agg.measuredCount) * 100) : null,
      unpriced_models: agg.unpricedModels, heterogeneous_tiers: tierBreakdown.filter((t) => t.tier !== 'Неизвестно').length > 1, tier_breakdown: tierBreakdown,
    },
    summary: {
      api_usd: round4(agg.totalApiUsd), api_multiplier: input.pricing.api_multiplier, cache_savings_usd: round4(agg.cacheSavingsUsd),
      total_requests: currentWorkload.length, measured_requests: agg.measuredCount, failed_requests: agg.failedCount,
      input_tokens: agg.inTok, cache_tokens: agg.cacheTok, cache_write_tokens: agg.cacheWriteTok, output_tokens: agg.outTok, thought_tokens: agg.thoughtTok,
      cache_hit_pct: cacheHitPct, subscription_monthly_usd: monthlyTotalUsd, period_subscription_usd: periodSubUsd,
      roi_ratio: periodSubUsd && periodSubUsd > 0 ? round4(agg.totalApiUsd / periodSubUsd) : null,
      pool_weekly_pct: poolWeeklyPct, pool_5h_pct: pool5hPct,
      pool_account_equivalents: round4((selectedPoolPct ?? 0) / 100 * Math.max(0, eligibleAccounts.length - staleCount)),
      eligible_accounts: eligibleAccounts.length, stale_accounts: staleCount, nearest_reset_time: nearestReset,
      elapsed_window_pct: pace.elapsed_window_pct, pace_delta_pct: pace.pace_delta_pct, pace_status: pace.pace_status,
      active_minutes: active.active_minutes, active_hours: active.active_hours, wall_hours: active.wall_hours,
      active_share_pct: active.active_share_pct, burst_count: active.burst_count,
      api_usd_per_active_hour: active.active_hours > 0 ? round4(agg.totalApiUsd / active.active_hours) : null,
      api_usd_per_active_minute: active.active_minutes > 0 ? round4(agg.totalApiUsd / active.active_minutes) : null,
      tokens_per_active_minute: active.active_minutes > 0 ? Math.round(totalTokens / active.active_minutes) : null,
      quota_pct_per_active_hour: pctPerActiveHour, runway_active_hours: runwayActiveHours,
      usd_per_1pct: currentEff.usd_per_1pct, tokens_per_1pct: currentEff.tokens_per_1pct,
      implied_100pct_usd: currentEff.implied_100pct_usd, implied_monthly_usd: currentEff.implied_monthly_usd,
      verdict: efficiency.verdict, verdict_delta_pct: efficiency.usd_per_1pct_delta_pct,
    },
    timeline, resets: resets.filter((r) => r.observed_ms >= input.fromMs && r.observed_ms < input.toExclusiveMs),
    efficiency, sessions: agg.sessions, by_model: agg.byModel, by_account: byAccount, spikes: agg.spikes, hints,
  };
}
