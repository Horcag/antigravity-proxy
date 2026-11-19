import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { consoleApi } from './api';
import { QuotaComparisonPanel } from './QuotaComparisonPanel';
import { QuotaPricingEditor } from './QuotaPricingEditor';
import { QuotaTimelineChart } from './QuotaTimelineChart';
import type {
  AccountQuotaCostRow,
  QuotaAnalyticsResponse,
  QuotaPoolFilter,
  QuotaPreset,
  QuotaWindowKind,
} from './quotaAnalyticsTypes';
import {
  formatCountdownUntil,
  formatTokensCompact,
  formatUsd,
  type QuotaChartDirection,
} from './quotaChartModel';
import { formatSamaraDateTime, localDateValue, samaraDayBoundary } from './time';
import type { Account, Project } from './types';
import { Button, Card, DataTable, ErrorMessage, PageHeader, useMutation, useResource } from './shared';
import styles from './QuotaAnalytics.module.scss';

type BreakdownTab = 'sessions' | 'models' | 'accounts' | 'resets';

const presetLabels: Array<[QuotaPreset, string]> = [
  ['24h', '24 ч'],
  ['7d', '7 дней'],
  ['30d', '30 дней'],
  ['cycle', 'Текущий цикл'],
];

const poolLabels: Array<[QuotaPoolFilter, string]> = [
  ['all', 'Все пулы'],
  ['gemini', 'Gemini'],
  ['argon', 'Argon'],
  ['third_party', 'Claude / GPT'],
];

const windowLabels: Array<[QuotaWindowKind, string]> = [
  ['weekly', 'Неделя'],
  ['5h', '5 часов'],
];

const paceLabelMap = {
  ok: { text: 'Темп безопасный', cls: styles.tagOk },
  tight: { text: 'Впритык к сбросу', cls: styles.tagWarn },
  will_exhaust: { text: 'Риск исчерпания', cls: styles.tagDanger },
  unknown: { text: 'Темп неизвестен', cls: '' },
};

function buildAnalyticsQuery(params: URLSearchParams): string {
  const q = new URLSearchParams();
  q.set('preset', params.get('preset') ?? '7d');
  q.set('pool', params.get('pool') ?? 'all');
  q.set('window', params.get('window') ?? 'weekly');
  for (const key of ['from', 'toExclusive', 'accountId', 'projectId', 'model', 'tier', 'splitAt', 'idleGapMinutes', 'minDeltaPp']) {
    const val = params.get(key);
    if (val) q.set(key, val);
  }
  return q.toString();
}

export function QuotaAnalytics() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<BreakdownTab>('sessions');
  const [direction, setDirection] = useState<QuotaChartDirection>('remaining');
  const [showAccountsOverlay, setShowAccountsOverlay] = useState(false);
  const [showUsdBars, setShowUsdBars] = useState(true);

  const proMode = params.get('pro') === '1';
  const preset = (params.get('preset') ?? '7d') as QuotaPreset;
  const pool = (params.get('pool') ?? 'all') as QuotaPoolFilter;
  const win = (params.get('window') ?? 'weekly') as QuotaWindowKind;
  const queryString = useMemo(() => buildAnalyticsQuery(params), [params]);

  const resource = useResource<QuotaAnalyticsResponse>(`/quota-analytics?${queryString}`);
  const accounts = useResource<Account[]>('/accounts');
  const projects = useResource<Project[]>('/projects');
  const refreshQuotaMutation = useMutation(resource.refresh);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'preset') {
      next.delete('from');
      next.delete('toExclusive');
    }
    setParams(next);
  }

  const data = resource.data;
  const s = data?.summary;
  const dq = data?.data_quality;
  const activePoolPct = win === '5h' ? s?.pool_5h_pct : s?.pool_weekly_pct;
  const paceInfo = paceLabelMap[s?.pace_status ?? 'unknown'];
  const fromDate = localDateValue(params.get('from'));
  const toExclusive = params.get('toExclusive');
  const toDate = localDateValue(toExclusive ? new Date(Date.parse(toExclusive) - 1).toISOString() : null);

  function requestsDrillHref(extra: Record<string, string | undefined> = {}): string {
    const next = new URLSearchParams();
    if (data?.range.from) next.set('from', data.range.from);
    if (data?.range.to_exclusive) next.set('toExclusive', data.range.to_exclusive);
    if (params.get('accountId')) next.set('accountId', params.get('accountId')!);
    if (params.get('projectId')) next.set('projectId', params.get('projectId')!);
    for (const [k, v] of Object.entries(extra)) {
      if (v) next.set(k, v);
    }
    return `/requests?${next.toString()}`;
  }

  function renderAccountCell(a: AccountQuotaCostRow) {
    return (
      <>
        <Link to={requestsDrillHref({ accountId: a.account_id })}>{a.label}</Link>
        <small>
          {a.subscription_tier ?? 'Тариф неизвестен'}
          {a.stale ? ' · устарело' : ''}
        </small>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Квота и API-эквивалент"
        resource={{
          ...resource,
          refresh: async () => {
            await Promise.all([resource.refresh(), accounts.refresh()]);
          },
        }}
      >
        <ToggleSwitch
          checked={proMode}
          onChange={(checked) => setParam('pro', checked ? '1' : '')}
          label="Pro-режим"
        />
        <Button
          variant="secondary"
          loading={refreshQuotaMutation.busy}
          onClick={() => void refreshQuotaMutation.run(() => consoleApi('/accounts/refresh-quota', 'POST'))}
        >
          Обновить квоты
        </Button>
      </PageHeader>
      <ErrorMessage error={refreshQuotaMutation.error} />

      <Card>
        <div className={styles.controlsBar}>
          <div className={styles.pillGroup} role="group" aria-label="Период">
            {presetLabels.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${styles.pill} ${preset === id && !params.get('from') ? styles.pillActive : ''}`}
                onClick={() => setParam('preset', id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.pillGroup} role="group" aria-label="Пул моделей">
            {poolLabels.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${styles.pill} ${pool === id ? styles.pillActive : ''}`}
                onClick={() => setParam('pool', id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.pillGroup} role="group" aria-label="Окно лимита">
            {windowLabels.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${styles.pill} ${win === id ? styles.pillActive : ''}`}
                onClick={() => setParam('window', id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {proMode && (
          <div className="agp-filters" style={{ marginTop: 16 }}>
            <Input
              label="С даты (Самара)"
              type="date"
              value={fromDate}
              onChange={(e) => setParam('from', samaraDayBoundary(e.target.value))}
            />
            <Input
              label="По дату (Самара)"
              type="date"
              value={toDate}
              onChange={(e) =>
                setParam(
                  'toExclusive',
                  e.target.value ? new Date(Date.parse(samaraDayBoundary(e.target.value)) + 86_400_000).toISOString() : ''
                )
              }
            />
            <label className="agp-field">
              Аккаунт
              <select className="input" value={params.get('accountId') ?? ''} onChange={(e) => setParam('accountId', e.target.value)}>
                <option value="">Все аккаунты</option>
                {(accounts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.email || a.name || a.id}</option>
                ))}
              </select>
            </label>
            <label className="agp-field">
              Проект
              <select className="input" value={params.get('projectId') ?? ''} onChange={(e) => setParam('projectId', e.target.value)}>
                <option value="">Все проекты</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <Input label="Модель" placeholder="Фильтр подстроки" value={params.get('model') ?? ''} onChange={(e) => setParam('model', e.target.value)} />
            <label className="agp-field">
              Тариф подписки
              <select className="input" value={params.get('tier') ?? ''} onChange={(e) => setParam('tier', e.target.value)}>
                <option value="">Все тарифы</option>
                {(dq?.tier_breakdown ?? []).map((t) => (
                  <option key={t.tier} value={t.tier}>{t.tier} ({t.accounts})</option>
                ))}
              </select>
            </label>
            <div className="agp-actions">
              <ToggleSwitch checked={showAccountsOverlay} onChange={setShowAccountsOverlay} label="Линии аккаунтов" />
              <ToggleSwitch checked={showUsdBars} onChange={setShowUsdBars} label="Столбцы API-$" />
              <Button variant="secondary" size="sm" onClick={() => setParams(proMode ? { pro: '1' } : {})}>
                Сбросить
              </Button>
            </div>
          </div>
        )}
      </Card>

      {dq && (dq.heterogeneous_tiers || dq.unpriced_models.length > 0 || dq.using_hourly_rollups || (s?.stale_accounts ?? 0) > 0) && (
        <p className="agp-muted">
          {dq.heterogeneous_tiers && `Смешанные тарифы (${dq.tier_breakdown.map((t) => `${t.tier}: ${t.accounts}`).join(', ')}) — при необходимости отфильтруйте в Pro-режиме. `}
          {dq.unpriced_models.length > 0 && `Без тарифа (не учтены в $): ${dq.unpriced_models.join(', ')}. Покрытие: ${dq.priced_coverage_pct ?? 0}%. `}
          {dq.using_hourly_rollups && `Для периода > ${dq.raw_retention_days} д используются часовые агрегаты (до ${dq.snapshot_retention_days} д). `}
          {(s?.stale_accounts ?? 0) > 0 && `Устаревшие снимки квот (>30м): ${s?.stale_accounts}.`}
        </p>
      )}

      <div className="agp-metrics">
        <Card>
          <div className={styles.provenanceRow}>
            <span>API-эквивалент</span>
            <span className={styles.tag}>По логам прокси</span>
          </div>
          <div className="agp-metric">{s ? formatUsd(s.api_usd, 2) : '—'}</div>
          <div className={styles.kpiSub}>
            <span>
              {s?.roi_ratio !== null && s?.roi_ratio !== undefined
                ? `Окупаемость: ${s.roi_ratio}× к доле подписок (${formatUsd(s.period_subscription_usd, 2)})`
                : `Множитель тарифа: ${s?.api_multiplier ?? 1}×`}
            </span>
            <span>Экономия кэшем: {s ? formatUsd(s.cache_savings_usd, 2) : '—'} (Cache Hit: {s?.cache_hit_pct ?? '—'}%)</span>
          </div>
        </Card>

        <Card>
          <div className={styles.provenanceRow}>
            <span>Остаток пула ({win === '5h' ? '5ч' : 'Неделя'})</span>
            <span className={`${styles.tag} ${paceInfo.cls}`}>{paceInfo.text}</span>
          </div>
          <div className="agp-metric">{activePoolPct !== null && activePoolPct !== undefined ? `${activePoolPct}%` : 'Неизвестно'}</div>
          {activePoolPct !== null && activePoolPct !== undefined && (
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${s?.pace_status === 'will_exhaust' ? styles.progressDanger : s?.pace_status === 'tight' ? styles.progressTight : ''}`}
                style={{ width: `${Math.max(2, Math.min(100, activePoolPct))}%` }}
              />
            </div>
          )}
          <div className={styles.kpiSub}>
            <span>
              5ч: {s?.pool_5h_pct ?? '—'}% · Нед: {s?.pool_weekly_pct ?? '—'}% · Сброс: {formatCountdownUntil(s?.nearest_reset_time)}
            </span>
            <span>
              {s?.pace_delta_pct !== null && s?.pace_delta_pct !== undefined
                ? `Темп vs окно: ${s.pace_delta_pct > 0 ? '+' : ''}${s.pace_delta_pct}% (прошло ${s.elapsed_window_pct}% окна)`
                : `Факт Google · Активных экв.: ${s?.pool_account_equivalents.toFixed(2) ?? '—'} / ${s?.eligible_accounts ?? 0}`}
            </span>
          </div>
        </Card>

        <Card>
          <div className={styles.provenanceRow}>
            <span>Активный расход</span>
            <span className={styles.tag}>По логам прокси</span>
          </div>
          <div className="agp-metric">
            {s?.api_usd_per_active_hour !== null && s?.api_usd_per_active_hour !== undefined
              ? `${formatUsd(s.api_usd_per_active_hour, 2)}/ч`
              : '—'}
          </div>
          <div className={styles.kpiSub}>
            <span>
              {s?.quota_pct_per_active_hour !== null && s?.quota_pct_per_active_hour !== undefined
                ? `${s.quota_pct_per_active_hour}%/акт.ч · Запас: ~${s.runway_active_hours ?? '—'} акт.ч`
                : `Токенов/акт.мин: ${formatTokensCompact(s?.tokens_per_active_minute)}`}
            </span>
            <span>
              Активно {s?.active_minutes ?? 0} мин ({s?.burst_count ?? 0} сеансов из {s?.wall_hours ?? 0} ч)
            </span>
          </div>
        </Card>

        <Card>
          <div className={styles.provenanceRow}>
            <span>API-$ за 1% квоты</span>
            <span className={`${styles.tag} ${s?.verdict === 'possible_nerf' ? styles.tagDanger : s?.verdict === 'improved' || s?.verdict === 'stable' ? styles.tagOk : styles.tagWarn}`}>
              {s?.verdict === 'possible_nerf' ? 'Снижение' : s?.verdict === 'improved' ? 'Выгоднее' : s?.verdict === 'stable' ? 'В норме' : 'Сбор выборки'}
            </span>
          </div>
          <div className="agp-metric">{formatUsd(s?.usd_per_1pct, 3)}</div>
          <div className={styles.kpiSub}>
            <span>
              Проекция 100% окна: {formatUsd(s?.implied_100pct_usd, 1)} · {formatTokensCompact(s?.tokens_per_1pct)} ток./1%
            </span>
            <span>
              {s?.verdict_delta_pct !== null && s?.verdict_delta_pct !== undefined
                ? `Сдвиг к прошлому периоду: ${s.verdict_delta_pct > 0 ? '+' : ''}${s.verdict_delta_pct}%`
                : `Выборка: ${data?.efficiency.current.sample_drain_pct ?? 0}% (${data?.efficiency.current.interval_count ?? 0} инт.)`}
            </span>
          </div>
        </Card>
      </div>

      <Card title="Динамика квоты и сбросы · Самара (UTC+4)">
        {data ? (
          <QuotaTimelineChart
            timeline={data.timeline}
            accounts={data.by_account}
            direction={direction}
            onDirectionChange={setDirection}
            showAccountsOverlay={proMode && showAccountsOverlay}
            showUsdBars={!proMode || showUsdBars}
            refreshBusy={refreshQuotaMutation.busy}
            onRefreshQuota={() => void refreshQuotaMutation.run(() => consoleApi('/accounts/refresh-quota', 'POST'))}
            onSelectSpan={(fromIso, toIso) =>
              navigate(requestsDrillHref({ from: fromIso, toExclusive: toIso }))
            }
          />
        ) : (
          <p className="agp-muted">{resource.loading ? 'Загрузка аналитики…' : 'Данные не загружены'}</p>
        )}
      </Card>

      {data && data.hints.length > 0 && (
        <div className={styles.hintsStrip}>
          {data.hints.map((h) => (
            <div key={h.id} className={`${styles.hintCard} ${h.severity === 'warn' ? styles.hintWarn : ''}`}>
              <strong>{h.title}</strong>
              <span>{h.detail}</span>
            </div>
          ))}
        </div>
      )}

      {data && (
        <Card
          title="Что съело квоту"
          extra={
            <div className={styles.pillGroup} role="tablist" aria-label="Разрез потребления">
              {(
                [
                  ['sessions', `Сессии (${data.sessions.length})`],
                  ['models', `Модели (${data.by_model.length})`],
                  ['accounts', `Аккаунты (${data.by_account.length})`],
                  ['resets', `Сбросы (${data.resets.length}) и пики`],
                ] as Array<[BreakdownTab, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`${styles.pill} ${tab === id ? styles.pillActive : ''}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {tab === 'sessions' && (
            <DataTable
              headers={['Сессия / контекст', 'Проект и модель', 'Запросы', 'Вход / кэш / выход (+thinking)', 'Cache Hit', 'API-$ (доля)', 'Последний запрос']}
              rows={data.sessions.map((row) => [
                <Link to={requestsDrillHref({ sessionKey: row.session_key ?? '__none__' })}>{row.label}</Link>,
                <>
                  {row.project_name}
                  <small>{row.primary_model ?? 'Не записана'}</small>
                </>,
                `${row.requests} (ош: ${row.failed_requests})`,
                `${formatTokensCompact(row.input_tokens)} / ${formatTokensCompact(row.cache_tokens)} / ${formatTokensCompact(row.output_tokens)} (+${formatTokensCompact(row.thought_tokens)})`,
                row.cache_hit_pct !== null ? `${row.cache_hit_pct}%` : '—',
                `${formatUsd(row.api_usd, 3)}${row.cost_share_pct !== null ? ` (${row.cost_share_pct}%)` : ''}`,
                formatSamaraDateTime(row.last_seen),
              ])}
            />
          )}
          {tab === 'models' && (
            <DataTable
              headers={['Модель', 'Пул', 'Запросы', 'Вход / кэш / выход (+thinking)', 'Экономия кэша', 'API-$ (доля)']}
              rows={data.by_model.map((m) => [
                <Link to={requestsDrillHref({ model: m.model })}>{m.model}</Link>,
                m.pool,
                `${m.requests} (ош: ${m.failed_requests})`,
                `${formatTokensCompact(m.input_tokens)} / ${formatTokensCompact(m.cache_tokens)} / ${formatTokensCompact(m.output_tokens)} (+${formatTokensCompact(m.thought_tokens)})`,
                formatUsd(m.cache_savings_usd, 3),
                m.priced ? `${formatUsd(m.api_usd, 3)}${m.cost_share_pct !== null ? ` (${m.cost_share_pct}%)` : ''}` : 'Без тарифа',
              ])}
            />
          )}
          {tab === 'accounts' && (
            <DataTable
              headers={['Аккаунт', 'Нед / 5ч остаток', 'Ближ. сброс', 'Запросы', 'Подписка / мес', 'API-$ (ROI)', 'Расход / $/1%']}
              rows={data.by_account.map((a) => [
                renderAccountCell(a),
                `${a.weekly_pct ?? '—'}% / ${a.five_hour_pct ?? '—'}%`,
                formatSamaraDateTime(win === '5h' ? a.five_hour_reset_time : a.weekly_reset_time),
                `${a.requests} (ош: ${a.failed_requests})`,
                a.monthly_usd !== null ? formatUsd(a.monthly_usd, 0) : 'Неизвестно',
                `${formatUsd(a.api_usd, 2)}${a.roi_ratio !== null ? ` (${a.roi_ratio}×)` : ''}`,
                `${a.drain_pct}% · ${formatUsd(a.usd_per_1pct, 3)}`,
              ])}
            />
          )}
          {tab === 'resets' && (
            <div className="agp-stack">
              <DataTable
                headers={['Время сброса (Самара)', 'Аккаунт', 'Пул / окно', 'Было → стало', 'Точность', 'След. сброс']}
                rows={data.resets.slice().reverse().map((r) => [
                  formatSamaraDateTime(r.observed_at),
                  r.account_label,
                  `${r.pool} · ${r.window}`,
                  `${r.from_pct}% → ${r.to_pct}% (+${r.delta_pct}%)`,
                  r.boundary_accuracy === 'exact' ? 'Точно' : 'Прибл.',
                  formatSamaraDateTime(r.new_reset_time),
                ])}
                empty="Сбросов квоты в выбранном периоде ещё не зафиксировано"
              />
              <DataTable
                headers={['Пиковый интервал (Самара)', 'Запросы', 'API-$', 'Основная модель']}
                rows={data.spikes.map((sp) => [
                  <Link to={requestsDrillHref({ from: sp.start, toExclusive: sp.end })}>
                    {formatSamaraDateTime(sp.start)}
                  </Link>,
                  sp.requests,
                  formatUsd(sp.api_usd, 3),
                  sp.top_model ?? 'Не записана',
                ])}
              />
            </div>
          )}
        </Card>
      )}

      {proMode && data && (
        <>
          <QuotaComparisonPanel
            efficiency={data.efficiency}
            splitAt={params.get('splitAt') ?? ''}
            idleGapMinutes={Number(params.get('idleGapMinutes') ?? 5)}
            minDeltaPp={Number(params.get('minDeltaPp') ?? 0.5)}
            onChangeParam={setParam}
          />
          <Card
            title="Оценка стоимости подписки: факт vs проекция"
            extra={
              <div className="agp-actions">
                <a className="btn btn-secondary btn-sm" href={`/admin/console/quota-analytics/export?${queryString}&format=csv`}>
                  Экспорт CSV
                </a>
                <a className="btn btn-secondary btn-sm" href={`/admin/console/quota-analytics/export?${queryString}&format=json`}>
                  Экспорт JSON
                </a>
              </div>
            }
          >
            <DataTable
              headers={['Показатель', 'Значение', 'Источник / статус']}
              rows={[
                ['Фактический API-эквивалент за период', formatUsd(s?.api_usd, 2), `По логам прокси (×${s?.api_multiplier ?? 1})`],
                ['Доля стоимости подписок за период', formatUsd(s?.period_subscription_usd, 2), `Месячная сумма: ${formatUsd(s?.subscription_monthly_usd, 0)}`],
                ['Проекция 100% одного окна квоты', formatUsd(s?.implied_100pct_usd, 2), 'Проекция по наблюдаемой цене 1%'],
                ['Проекция на 30 дней при полной утилизации 1 окна', formatUsd(s?.implied_monthly_usd, 2), 'Проекция (не фактический расход)'],
              ]}
            />
          </Card>
          <QuotaPricingEditor accounts={data.by_account} onSaved={resource.refresh} />
        </>
      )}
    </>
  );
}
