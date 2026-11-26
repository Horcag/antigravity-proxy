import { round1, round4, type AccountMeta, type DrainInterval, type WorkloadEvent } from './quota-analytics-core';
import type {
  IntegrationUsageRow,
  ModelCostRow,
  OptimizationHint,
  QuotaPreset,
  SessionUsageRow,
  ShiftVerdict,
} from './quota-analytics-types';

export function summarizeIntegrations(workload: WorkloadEvent[], intervals: DrainInterval[]): IntegrationUsageRow[] {
  const rows = new Map<IntegrationUsageRow['source'], IntegrationUsageRow>();
  const byAccountPool = new Map<string, WorkloadEvent[]>();
  for (const event of workload) {
    const source = event.integration;
    if (!source) continue;
    const row = rows.get(source) ?? {
      source, requests: 0, measured_requests: 0, priced_requests: 0, api_usd: null,
      matched_drain_pp: null, matched_intervals: 0,
    };
    row.requests++;
    if (event.input_tokens !== null && event.output_tokens !== null) row.measured_requests++;
    if (event.priced && event.api_usd !== null) {
      row.priced_requests++;
      row.api_usd = (row.api_usd ?? 0) + event.api_usd;
    }
    rows.set(source, row);
    if (event.account_id && !event.failed) {
      const key = `${event.account_id}|${event.pool}`;
      const events = byAccountPool.get(key) ?? [];
      events.push(event);
      byAccountPool.set(key, events);
    }
  }

  for (const events of byAccountPool.values()) events.sort((a, b) => a.time_ms - b.time_ms);
  for (const interval of intervals) {
    const events = byAccountPool.get(`${interval.account_id}|${interval.pool}`);
    if (!events) continue;
    let start = 0;
    let end = events.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (events[middle].time_ms <= interval.start_ms) start = middle + 1;
      else end = middle;
    }
    const source = events[start]?.integration;
    if (!source || events[start].time_ms > interval.end_ms) continue;
    let cursor = start + 1;
    while (cursor < events.length && events[cursor].time_ms <= interval.end_ms && events[cursor].integration === source) cursor++;
    if (cursor < events.length && events[cursor].time_ms <= interval.end_ms) continue;
    const row = rows.get(source)!;
    row.matched_intervals++;
    row.matched_drain_pp = (row.matched_drain_pp ?? 0) + interval.drain_pct;
  }

  return Array.from(rows.values(), (row) => ({
    ...row,
    api_usd: row.api_usd === null ? null : round4(row.api_usd),
    matched_drain_pp: row.matched_drain_pp === null ? null : round1(row.matched_drain_pp),
  })).sort((a, b) => Number(b.source === 'native') - Number(a.source === 'native'));
}

function formatSessionLabel(sessionKey: string | null): string {
  if (!sessionKey) return 'Без идентификатора сессии';
  if (sessionKey.startsWith('session:')) return sessionKey.slice(8);
  if (sessionKey.startsWith('hint:prefix:')) return `префикс ${sessionKey.slice(12)}`;
  return sessionKey;
}

export interface WorkloadAggregation {
  totalApiUsd: number;
  cacheSavingsUsd: number;
  measuredCount: number;
  pricedCount: number;
  failedCount: number;
  inTok: number;
  outTok: number;
  thoughtTok: number;
  cacheTok: number;
  cacheWriteTok: number;
  unpricedModels: string[];
  byModel: ModelCostRow[];
  sessions: SessionUsageRow[];
  accAgg: Map<string, { req: number; fail: number; usd: number; priced: number }>;
  spikes: Array<{ start: string; end: string; requests: number; api_usd: number; top_model: string | null }>;
}

export function aggregateWorkloadBreakdowns(
  currentWorkload: WorkloadEvent[],
  accountsById: Map<string, AccountMeta>,
  preset: QuotaPreset,
): WorkloadAggregation {
  let totalApiUsd = 0, cacheSavingsUsd = 0, measuredCount = 0, pricedCount = 0, failedCount = 0;
  let inTok = 0, outTok = 0, thoughtTok = 0, cacheTok = 0, cacheWriteTok = 0;
  const unpricedSet = new Set<string>();
  const modelMap = new Map<string, ModelCostRow>();
  const sessionMap = new Map<string, SessionUsageRow & { modelCounts: Map<string, number>; accSet: Set<string> }>();
  const accAgg = new Map<string, { req: number; fail: number; usd: number; priced: number }>();

  const bucketStepMs = preset === '24h' ? 300_000 : 3_600_000;
  const spikeMap = new Map<number, { requests: number; api_usd: number; models: Map<string, number> }>();

  for (const w of currentWorkload) {
    if (w.failed) failedCount += 1;
    if (w.input_tokens !== null && w.output_tokens !== null) {
      measuredCount += 1;
      inTok += w.input_tokens;
      outTok += w.output_tokens;
      thoughtTok += w.thought_tokens ?? 0;
      cacheTok += w.cache_tokens ?? 0;
      cacheWriteTok += w.cache_write_tokens ?? 0;
    }
    if (w.priced && w.api_usd !== null) {
      pricedCount += 1;
      totalApiUsd += w.api_usd;
      cacheSavingsUsd += w.cache_savings_usd;
    } else if (w.model && !w.canonical_model && w.input_tokens !== null && w.output_tokens !== null) {
      unpricedSet.add(w.model);
    }

    const mKey = w.model ?? 'Без модели';
    const mRow = modelMap.get(mKey) ?? {
      model: mKey, canonical_model: w.canonical_model ?? null, pool: w.pool, requests: 0, failed_requests: 0,
      input_tokens: 0, cache_tokens: 0, cache_write_tokens: 0, output_tokens: 0, thought_tokens: 0,
      api_usd: w.priced ? 0 : null, cache_savings_usd: 0, cost_share_pct: null, priced: w.priced,
    };
    mRow.requests += 1;
    if (w.failed) mRow.failed_requests += 1;
    mRow.input_tokens += w.input_tokens ?? 0;
    mRow.cache_tokens += w.cache_tokens ?? 0;
    mRow.cache_write_tokens += w.cache_write_tokens ?? 0;
    mRow.output_tokens += w.output_tokens ?? 0;
    mRow.thought_tokens += w.thought_tokens ?? 0;
    if (w.priced && w.api_usd !== null) {
      mRow.priced = true;
      mRow.api_usd = (mRow.api_usd ?? 0) + w.api_usd;
      mRow.cache_savings_usd += w.cache_savings_usd;
    }
    modelMap.set(mKey, mRow);

    if (w.route) {
      const sKey = w.session_key ?? '__none__';
      const sRow = sessionMap.get(sKey) ?? {
        session_key: w.session_key, label: formatSessionLabel(w.session_key), requests: 0, failed_requests: 0,
        project_name: w.project_name || 'Общий ключ', primary_model: w.model, accounts: [],
        input_tokens: 0, cache_tokens: 0, cache_write_tokens: 0, output_tokens: 0, thought_tokens: 0,
        cache_hit_pct: null, api_usd: null, cost_share_pct: null, estimated_quota_share_pct: null,
        first_seen: new Date(w.time_ms).toISOString(), last_seen: new Date(w.time_ms).toISOString(),
        modelCounts: new Map(), accSet: new Set(),
      };
      sRow.requests += 1;
      if (w.failed) sRow.failed_requests += 1;
      sRow.input_tokens += w.input_tokens ?? 0;
      sRow.cache_tokens += w.cache_tokens ?? 0;
      sRow.cache_write_tokens += w.cache_write_tokens ?? 0;
      sRow.output_tokens += w.output_tokens ?? 0;
      sRow.thought_tokens += w.thought_tokens ?? 0;
      if (w.priced && w.api_usd !== null) sRow.api_usd = (sRow.api_usd ?? 0) + w.api_usd;
      if (w.model) sRow.modelCounts.set(w.model, (sRow.modelCounts.get(w.model) ?? 0) + 1);
      if (w.account_id) sRow.accSet.add(accountsById.get(w.account_id)?.label ?? w.account_id);
      if (w.time_ms < Date.parse(sRow.first_seen)) sRow.first_seen = new Date(w.time_ms).toISOString();
      if (w.time_ms > Date.parse(sRow.last_seen)) sRow.last_seen = new Date(w.time_ms).toISOString();
      sessionMap.set(sKey, sRow);
    }

    if (w.account_id) {
      const a = accAgg.get(w.account_id) ?? { req: 0, fail: 0, usd: 0, priced: 0 };
      a.req += 1;
      if (w.failed) a.fail += 1;
      if (w.priced && w.api_usd !== null) { a.usd += w.api_usd; a.priced += 1; }
      accAgg.set(w.account_id, a);
    }

    const bStart = Math.floor(w.time_ms / bucketStepMs) * bucketStepMs;
    const item = spikeMap.get(bStart) ?? { requests: 0, api_usd: 0, models: new Map() };
    item.requests += 1;
    item.api_usd += w.api_usd ?? 0;
    if (w.model) item.models.set(w.model, (item.models.get(w.model) ?? 0) + (w.api_usd ?? 0));
    spikeMap.set(bStart, item);
  }

  const byModel = Array.from(modelMap.values())
    .map((m) => ({
      ...m,
      api_usd: m.api_usd !== null ? round4(m.api_usd) : null,
      cache_savings_usd: round4(m.cache_savings_usd),
      cost_share_pct: totalApiUsd > 0 && m.api_usd !== null ? round1((m.api_usd / totalApiUsd) * 100) : null,
    }))
    .sort((a, b) => (b.api_usd ?? -1) - (a.api_usd ?? -1) || b.requests - a.requests);

  const sessions: SessionUsageRow[] = Array.from(sessionMap.values())
    .map(({ modelCounts, accSet, ...s }) => {
      const topModel = Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.primary_model;
      const share = totalApiUsd > 0 && s.api_usd !== null ? round1((s.api_usd / totalApiUsd) * 100) : null;
      return {
        ...s,
        primary_model: topModel,
        accounts: Array.from(accSet),
        api_usd: s.api_usd !== null ? round4(s.api_usd) : null,
        cache_hit_pct: s.input_tokens + s.cache_tokens > 0 ? round1((s.cache_tokens / (s.input_tokens + s.cache_tokens)) * 100) : null,
        cost_share_pct: share,
        estimated_quota_share_pct: share,
      };
    })
    .sort((a, b) => (b.api_usd ?? -1) - (a.api_usd ?? -1) || b.requests - a.requests)
    .slice(0, 50);

  const spikes = Array.from(spikeMap.entries())
    .map(([start, v]) => ({
      start: new Date(start).toISOString(),
      end: new Date(start + bucketStepMs).toISOString(),
      requests: v.requests,
      api_usd: round4(v.api_usd),
      top_model: Array.from(v.models.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }))
    .sort((a, b) => b.api_usd - a.api_usd || b.requests - a.requests)
    .slice(0, 8);

  return {
    totalApiUsd, cacheSavingsUsd, measuredCount, pricedCount, failedCount,
    inTok, outTok, thoughtTok, cacheTok, cacheWriteTok,
    unpricedModels: Array.from(unpricedSet).sort(),
    byModel, sessions, accAgg, spikes,
  };
}

export function buildOptimizationHints(opts: {
  verdict: ShiftVerdict;
  verdictReason: string;
  cacheHitPct: number | null;
  totalApiUsd: number;
  thoughtTok: number;
  outTok: number;
  failedCount: number;
  totalRequests: number;
  topSession: SessionUsageRow | undefined;
}): OptimizationHint[] {
  const hints: OptimizationHint[] = [];
  if (opts.verdict === 'possible_nerf') {
    hints.push({ id: 'nerf', severity: 'warn', title: 'Зафиксирован сдвиг стоимости квоты', detail: opts.verdictReason });
  }
  if (opts.cacheHitPct !== null && opts.cacheHitPct < 30 && opts.totalApiUsd >= 1) {
    hints.push({ id: 'cache', severity: 'warn', title: `Низкий Cache Hit (${opts.cacheHitPct}%)`, detail: 'Повторное переиспользование префиксов сессий сейчас мало кэшируется.' });
  }
  if (opts.thoughtTok > opts.outTok && opts.thoughtTok > 100_000) {
    hints.push({ id: 'thinking', severity: 'info', title: 'Высокая доля thinking-токенов', detail: `Размышления (${opts.thoughtTok.toLocaleString('ru-RU')}) превышают видимый вывод (${opts.outTok.toLocaleString('ru-RU')}).` });
  }
  if (opts.totalRequests >= 20 && opts.failedCount / opts.totalRequests >= 0.15) {
    hints.push({ id: 'errors', severity: 'warn', title: 'Повышенная доля ошибок', detail: `${opts.failedCount} из ${opts.totalRequests} запросов завершились ошибкой.` });
  }
  if (opts.topSession?.cost_share_pct && opts.topSession.cost_share_pct >= 50 && (opts.topSession.api_usd ?? 0) >= 1) {
    hints.push({ id: 'session-top', severity: 'info', title: `Сессия «${opts.topSession.label}» — ${opts.topSession.cost_share_pct}% расхода`, detail: `Потратила $${opts.topSession.api_usd?.toFixed(2)} за ${opts.topSession.requests} запросов.` });
  }
  return hints.slice(0, 4);
}
