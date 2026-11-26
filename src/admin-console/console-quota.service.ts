import { BadRequestException, Injectable } from '@nestjs/common';
import type { CloudQuotaData } from '@/modules/cloud-account/types';
import { getRequestHistoryStore } from '@/observability/request-history';
import { computeQuotaAnalytics } from '@/observability/quota-analytics';
import { detectResetsAndDrainIntervals } from '@/observability/quota-analytics-core';
import type {
  QuotaAnalyticsResponse,
  QuotaPoolFilter,
  QuotaPreset,
  QuotaWindowKind,
} from '@/observability/quota-analytics-types';
import { ConsoleAccountsService } from './console-accounts.service';
import { ConsoleConfigService } from './console-config.service';

export interface QuotaAnalyticsQueryInput {
  from?: string;
  toExclusive?: string;
  preset: QuotaPreset;
  pool: QuotaPoolFilter;
  window: QuotaWindowKind;
  accountId?: string;
  projectId?: string;
  model?: string;
  tier?: string;
  splitAt?: string;
  idleGapMinutes: number;
  minDeltaPp: number;
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function samaraIso(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms + 4 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')} UTC+4`;
}

@Injectable()
export class ConsoleQuotaService {
  constructor(
    private readonly accounts: ConsoleAccountsService,
    private readonly config: ConsoleConfigService,
  ) {}

  async getAnalytics(query: QuotaAnalyticsQueryInput, nowMs = Date.now()): Promise<QuotaAnalyticsResponse> {
    const store = getRequestHistoryStore();
    const accountList = await this.accounts.list();
    for (const acc of accountList) {
      if (acc.quota && !acc.disabled && !acc.review_required) {
        store.quotaHistory.seedAccountSnapshotIfMissing(acc.id, acc.quota as unknown as CloudQuotaData);
      }
    }

    const defaultSpanMs =
      query.preset === '24h'
        ? 86_400_000
        : query.preset === '30d'
          ? 30 * 86_400_000
          : query.preset === 'cycle'
            ? (query.window === '5h' ? 5 * 3_600_000 : 7 * 86_400_000)
            : 7 * 86_400_000;

    const toExclusiveMs = query.toExclusive ? Date.parse(query.toExclusive) : nowMs + 1;
    let fromMs = query.from ? Date.parse(query.from) : toExclusiveMs - defaultSpanMs;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toExclusiveMs) || fromMs >= toExclusiveMs) {
      throw new BadRequestException('Invalid analytics time range');
    }

    if (query.preset === 'cycle' && !query.from) {
      const recentSnaps = store.quotaHistory.getQuotaSnapshots({
        fromMs: nowMs - defaultSpanMs * 2,
        toExclusiveMs,
        window: query.window,
        ...(query.pool !== 'all' ? { pool: query.pool } : {}),
        ...(query.accountId ? { accountId: query.accountId } : {}),
      });
      const eligibleIds = new Set(accountList.filter((a) =>
        !a.disabled && !a.review_required &&
        (!query.tier || a.quota?.subscription_tier?.toLowerCase() === query.tier.toLowerCase())
      ).map((a) => a.id));
      const { resets } = detectResetsAndDrainIntervals(
        recentSnaps.filter((s) => eligibleIds.has(s.account_id)), new Map(), query.minDeltaPp,
      );
      const lastReset = resets.at(-1)?.observed_ms;
      if (lastReset) {
        fromMs = lastReset;
      }
    }

    const splitMs = query.splitAt ? Date.parse(query.splitAt) : NaN;
    const hasValidSplit = Number.isFinite(splitMs) && splitMs > fromMs && splitMs < toExclusiveMs;
    const spanMs = toExclusiveMs - fromMs;
    const baselineFromMs = hasValidSplit ? fromMs : fromMs - spanMs;
    const baselineToExclusiveMs = hasValidSplit ? splitMs : fromMs;
    const efficiencyCurrentFromMs = hasValidSplit ? splitMs : fromMs;

    const rawRequests = store.getRawRequestsForAnalytics({
      from: new Date(fromMs).toISOString(),
      toExclusive: new Date(toExclusiveMs).toISOString(),
      ...(query.accountId ? { finalAccountId: query.accountId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
    });

    const baselineRawRequests = hasValidSplit
      ? rawRequests.filter((r) => Date.parse(r.time) < splitMs)
      : store.getRawRequestsForAnalytics({
          from: new Date(baselineFromMs).toISOString(),
          toExclusive: new Date(baselineToExclusiveMs).toISOString(),
          ...(query.accountId ? { finalAccountId: query.accountId } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
        });

    const snapshots = store.quotaHistory.getQuotaSnapshots({
      fromMs: Math.min(fromMs, baselineFromMs) - 24 * 3_600_000,
      toExclusiveMs,
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.pool !== 'all' ? { pool: query.pool } : {}),
    });

    const hourlyRollups = store.quotaHistory.getHourlyRollups({
      fromMs: Math.min(fromMs, baselineFromMs),
      toExclusiveMs,
      ...(query.accountId ? { accountId: query.accountId } : {}),
    });

    const pricing = this.config.getQuotaPricing().config;
    const summaryMeta = store.getUsageSummary({ limit: 1 });
    const latestTierByAccount = new Map<string, string>();
    for (const s of snapshots) {
      if (s.subscription_tier) latestTierByAccount.set(s.account_id, s.subscription_tier);
    }

    return computeQuotaAnalytics({
      nowMs,
      fromMs,
      toExclusiveMs,
      baselineFromMs,
      baselineToExclusiveMs,
      efficiencyCurrentFromMs,
      preset: query.preset,
      pool: query.pool,
      window: query.window,
      accountId: query.accountId ?? null,
      projectId: query.projectId ?? null,
      model: query.model ?? null,
      tier: query.tier ?? null,
      splitAt: query.splitAt ?? null,
      idleGapMinutes: query.idleGapMinutes,
      minDeltaPp: query.minDeltaPp,
      rawRetentionDays: summaryMeta.retention_days,
      snapshotRetentionDays: 90,
      accounts: accountList.map((a) => ({
        id: a.id,
        label: a.email || a.name || a.id,
        subscription_tier: a.quota?.subscription_tier ?? latestTierByAccount.get(a.id) ?? null,
        disabled: a.disabled || a.review_required,
      })),
      rawRequests,
      baselineRawRequests,
      hourlyRollups,
      snapshots,
      pricing,
    });
  }

  toCsv(report: QuotaAnalyticsResponse): string {
    const lines: string[] = [
      ['Раздел', 'Ключ', 'Значение', 'Единица / Заметки'].map(csvCell).join(','),
      ['Сводка', 'Период (Самара)', `${samaraIso(report.range.from)} .. ${samaraIso(report.range.to_exclusive)}`, report.range.preset].map(csvCell).join(','),
      ['Сводка', 'API-эквивалент', report.summary.api_usd, `USD (x${report.summary.api_multiplier})`].map(csvCell).join(','),
      ['Сводка', 'Экономия кэша', report.summary.cache_savings_usd, 'USD'].map(csvCell).join(','),
      ['Сводка', 'Активное время', report.summary.active_minutes, 'мин'].map(csvCell).join(','),
      ['Сводка', 'API-$ / 1% квоты', report.summary.usd_per_1pct ?? '', report.efficiency.verdict].map(csvCell).join(','),
      '',
      ['Интеграция', 'Запросы', 'С токенами', 'С тарифом и токенами', 'API-$', 'Расход квоты, п.п.', 'Интервалы'].map(csvCell).join(','),
      ...report.by_integration.map((row) => [
        row.source === 'native' ? 'Antigravity / AGY' : 'API прокси',
        row.requests, row.measured_requests, row.priced_requests, row.api_usd, row.matched_drain_pp, row.matched_intervals,
      ].map(csvCell).join(',')),
      '',
      ['Сессия / Модель / Аккаунт', 'Тип', 'Запросы', 'Входные токены', 'Кэш чтение', 'Кэш запись', 'Выходные токены', 'Thinking', 'API-$', 'Доля %'].map(csvCell).join(','),
    ];
    for (const s of report.sessions) {
      lines.push([s.label, 'session', s.requests, s.input_tokens, s.cache_tokens, s.cache_write_tokens, s.output_tokens, s.thought_tokens, s.api_usd ?? '', s.cost_share_pct ?? ''].map(csvCell).join(','));
    }
    for (const m of report.by_model) {
      lines.push([m.model, 'model', m.requests, m.input_tokens, m.cache_tokens, m.cache_write_tokens, m.output_tokens, m.thought_tokens, m.api_usd ?? '', m.cost_share_pct ?? ''].map(csvCell).join(','));
    }
    for (const a of report.by_account) {
      lines.push([a.label, `account:${a.subscription_tier ?? 'unknown'}`, a.requests, '', '', '', '', '', a.api_usd ?? '', a.drain_pct].map(csvCell).join(','));
    }
    return `\uFEFF${lines.join('\n')}\n`;
  }
}
