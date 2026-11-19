import type {
  QuotaPoolFilter,
  QuotaPoolId,
  QuotaResetEvent,
  QuotaSnapshotRow,
  QuotaTimelinePoint,
  QuotaWindowKind,
} from './quota-analytics-types';

export interface AccountMeta {
  id: string;
  label: string;
  subscription_tier: string | null;
  disabled: boolean;
  last_refresh_at?: number | null;
}

export interface WorkloadEvent {
  time_ms: number;
  account_id: string | null;
  model: string | null;
  pool: QuotaPoolId | 'other';
  route: string;
  usage_schema: string | null;
  project_id: string;
  project_name: string;
  session_key: string | null;
  failed: boolean;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  thought_tokens: number | null;
  cache_tokens: number | null;
  cache_write_tokens: number | null;
  api_usd: number | null;
  cache_savings_usd: number;
  priced: boolean;
}

export interface DrainInterval {
  account_id: string;
  pool: QuotaPoolId;
  window: QuotaWindowKind;
  bucket_id: string;
  start_ms: number;
  end_ms: number;
  drain_pct: number;
}

const RESET_JUMP_FRACTION = 0.02;
const RESET_SHIFT_MS = 5 * 60_000;
const ANCHOR_JITTER_MS = 60_000;

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export function matchesPool(pool: QuotaPoolId | 'other', filter: QuotaPoolFilter): boolean {
  return filter === 'all' || pool === filter;
}

function sameAnchor(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return a === b;
  return Math.abs(ma - mb) <= ANCHOR_JITTER_MS;
}

export function detectResetsAndDrainIntervals(
  snapshots: QuotaSnapshotRow[],
  accountsById: Map<string, AccountMeta>,
  minDeltaPp: number,
): { resets: QuotaResetEvent[]; intervals: DrainInterval[] } {
  const grouped = new Map<string, QuotaSnapshotRow[]>();
  for (const s of snapshots) {
    const key = `${s.account_id}|${s.pool}|${s.window}|${s.bucket_id}`;
    const list = grouped.get(key) ?? [];
    list.push(s);
    grouped.set(key, list);
  }

  const resets: QuotaResetEvent[] = [];
  const intervals: DrainInterval[] = [];

  for (const series of grouped.values()) {
    series.sort((a, b) => a.observed_ms - b.observed_ms || (a.id ?? 0) - (b.id ?? 0));
    let reboundBlockedAnchor: string | null | undefined;
    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1];
      const curr = series[i];
      const prevResetMs = prev.reset_time ? Date.parse(prev.reset_time) : NaN;
      const currResetMs = curr.reset_time ? Date.parse(curr.reset_time) : NaN;
      const resetJump = curr.remaining_fraction > prev.remaining_fraction + RESET_JUMP_FRACTION;
      const resetShift =
        Number.isFinite(prevResetMs) &&
        Number.isFinite(currResetMs) &&
        currResetMs - prevResetMs > RESET_SHIFT_MS &&
        curr.remaining_fraction >= prev.remaining_fraction - 0.005;

      if (resetJump || resetShift) {
        reboundBlockedAnchor = undefined;
        resets.push({
          observed_at: curr.observed_at,
          observed_ms: curr.observed_ms,
          account_id: curr.account_id,
          account_label: accountsById.get(curr.account_id)?.label ?? curr.account_id,
          pool: curr.pool,
          window: curr.window,
          from_pct: round1(prev.remaining_fraction * 100),
          to_pct: round1(curr.remaining_fraction * 100),
          delta_pct: round1((curr.remaining_fraction - prev.remaining_fraction) * 100),
          new_reset_time: curr.reset_time,
          boundary_accuracy: prev.remaining_fraction < 0.99 ? 'exact' : 'inferred',
        });
        continue;
      }

      if (curr.remaining_fraction > prev.remaining_fraction + 0.001) {
        reboundBlockedAnchor = curr.reset_time ?? null;
        continue;
      }
      if (reboundBlockedAnchor !== undefined && sameAnchor(reboundBlockedAnchor, curr.reset_time)) continue;
      if (prev.remaining_fraction <= 0.001) continue;

      const drainPct = (prev.remaining_fraction - curr.remaining_fraction) * 100;
      if (drainPct >= minDeltaPp) {
        intervals.push({
          account_id: curr.account_id,
          pool: curr.pool,
          window: curr.window,
          bucket_id: curr.bucket_id,
          start_ms: prev.observed_ms,
          end_ms: curr.observed_ms,
          drain_pct: drainPct,
        });
      }
    }
  }

  resets.sort((a, b) => a.observed_ms - b.observed_ms);
  intervals.sort((a, b) => a.start_ms - b.start_ms);
  return { resets, intervals };
}

export function buildPoolTimeline(options: {
  snapshots: QuotaSnapshotRow[];
  resets: QuotaResetEvent[];
  workload: WorkloadEvent[];
  eligibleAccountIds: string[];
  poolFilter: QuotaPoolFilter;
  window: QuotaWindowKind;
  fromMs: number;
  toMs: number;
}): QuotaTimelinePoint[] {
  const { snapshots, resets, workload, eligibleAccountIds, poolFilter, window, fromMs, toMs } = options;
  const eligibleSet = new Set(eligibleAccountIds);
  const filteredSnaps = snapshots
    .filter((s) => s.window === window && matchesPool(s.pool, poolFilter) && (eligibleSet.size === 0 || eligibleSet.has(s.account_id)))
    .sort((a, b) => a.observed_ms - b.observed_ms);

  const timeSet = new Set<number>();
  for (const s of filteredSnaps) {
    if (s.observed_ms >= fromMs && s.observed_ms < toMs) timeSet.add(s.observed_ms);
  }
  const resetMsSet = new Set<number>();
  for (const r of resets) {
    if (r.window === window && matchesPool(r.pool, poolFilter) && r.observed_ms >= fromMs && r.observed_ms < toMs) {
      timeSet.add(r.observed_ms);
      resetMsSet.add(r.observed_ms);
    }
  }
  let timestamps = Array.from(timeSet).sort((a, b) => a - b);
  if (timestamps.length > 360) {
    const sampled = new Set<number>(resetMsSet);
    const step = (timestamps.length - 1) / 300;
    for (let i = 0; i < 300; i += 1) sampled.add(timestamps[Math.round(i * step)]);
    sampled.add(timestamps[0]);
    sampled.add(timestamps[timestamps.length - 1]);
    timestamps = Array.from(sampled).sort((a, b) => a - b);
  }
  if (timestamps.length === 0) return [];

  const maxStaleMs = window === '5h' ? 2 * 3_600_000 : 24 * 3_600_000;
  const latestByAccPool = new Map<string, QuotaSnapshotRow>();
  let snapCursor = 0;
  while (snapCursor < filteredSnaps.length && filteredSnaps[snapCursor].observed_ms < fromMs) {
    const s = filteredSnaps[snapCursor++];
    latestByAccPool.set(`${s.account_id}|${s.pool}|${s.bucket_id}`, s);
  }

  let workCursor = 0;
  while (workCursor < workload.length && workload[workCursor].time_ms < fromMs) workCursor += 1;
  let resetCursor = 0;
  const relevantResets = resets.filter((r) => r.window === window && matchesPool(r.pool, poolFilter) && r.observed_ms >= fromMs && r.observed_ms < toMs);

  const points: QuotaTimelinePoint[] = [];
  for (let idx = 0; idx < timestamps.length; idx += 1) {
    const t = timestamps[idx];
    while (snapCursor < filteredSnaps.length && filteredSnaps[snapCursor].observed_ms <= t) {
      const s = filteredSnaps[snapCursor++];
      latestByAccPool.set(`${s.account_id}|${s.pool}|${s.bucket_id}`, s);
    }

    let apiUsd = 0;
    let reqCount = 0;
    while (workCursor < workload.length && workload[workCursor].time_ms <= t) {
      const w = workload[workCursor++];
      apiUsd += w.api_usd ?? 0;
      reqCount += 1;
    }

    const pointResets: QuotaResetEvent[] = [];
    while (resetCursor < relevantResets.length && relevantResets[resetCursor].observed_ms <= t) {
      pointResets.push(relevantResets[resetCursor++]);
    }

    const accValues = new Map<string, number[]>();
    const staleAccounts = new Set<string>();
    for (const s of latestByAccPool.values()) {
      if (t - s.observed_ms <= maxStaleMs) {
        const list = accValues.get(s.account_id) ?? [];
        list.push(s.remaining_fraction * 100);
        accValues.set(s.account_id, list);
      } else {
        staleAccounts.add(s.account_id);
      }
    }

    const byAccount: Record<string, number | null> = {};
    let sumPct = 0;
    let activeCount = 0;
    for (const accId of eligibleAccountIds) {
      const vals = accValues.get(accId);
      if (vals && vals.length > 0) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        byAccount[accId] = round1(avg);
        sumPct += avg;
        activeCount += 1;
      } else {
        byAccount[accId] = null;
      }
    }
    const staleCount = Array.from(staleAccounts).filter((id) => !accValues.has(id)).length;
    points.push({
      time: new Date(t).toISOString(),
      time_ms: t,
      pool_remaining_pct: activeCount > 0 ? round1(sumPct / activeCount) : null,
      pool_account_equivalents: round4(sumPct / 100),
      active_accounts_count: activeCount,
      stale_accounts_count: staleCount,
      api_usd: round4(apiUsd),
      requests: reqCount,
      by_account: byAccount,
      resets: pointResets,
    });
  }
  return points;
}
