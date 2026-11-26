import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Collapsible } from '@/components/ui/Collapsible';
import type { AccountQuotaCostRow, QuotaTimelinePoint } from './quotaAnalyticsTypes';
import {
  createQuotaChartGeometry,
  formatUsd,
  pointAtX,
  quotaChartLayout,
  type QuotaChartDirection,
} from './quotaChartModel';
import { formatSamaraDateTime } from './time';
import { Button, DataTable } from './shared';
import chartStyles from './TrafficChart.module.scss';
import styles from './QuotaAnalytics.module.scss';

type Props = {
  timeline: QuotaTimelinePoint[];
  accounts: AccountQuotaCostRow[];
  direction: QuotaChartDirection;
  onDirectionChange: (dir: QuotaChartDirection) => void;
  showAccountsOverlay: boolean;
  showUsdBars: boolean;
  onRefreshQuota?: () => void;
  refreshBusy?: boolean;
  onSelectSpan: (fromIso: string, toExclusiveIso: string) => void;
};

export function QuotaTimelineChart({
  timeline,
  accounts,
  direction,
  onDirectionChange,
  showAccountsOverlay,
  showUsdBars,
  onRefreshQuota,
  refreshBusy,
  onSelectSpan,
}: Props) {
  const descId = useId();
  const [selectedIdx, setSelectedIdx] = useState<number>();
  const [tableOpen, setTableOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<SVGSVGElement>(null);
  const [layout, setLayout] = useState(quotaChartLayout);
  const hasChart = timeline.length >= 2;
  useEffect(() => {
    const wrap = wrapRef.current;
    const plot = plotRef.current;
    if (!hasChart || !wrap || !plot) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = plot.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setLayout((current) => current.width === width && current.height === height
          ? current
          : { ...quotaChartLayout, width, height, bottom: height - 20 });
      }
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [hasChart]);

  const accountIds = useMemo(() => accounts.map((a) => a.account_id), [accounts]);
  const accountLabels = useMemo(
    () => new Map(accounts.map((a) => [a.account_id, a.label])),
    [accounts]
  );
  const geometry = useMemo(
    () => createQuotaChartGeometry(timeline, direction, showAccountsOverlay ? accountIds : [], layout),
    [timeline, direction, showAccountsOverlay, accountIds, layout]
  );

  const activeIndex =
    selectedIdx !== undefined && selectedIdx >= 0 && selectedIdx < geometry.points.length
      ? selectedIdx
      : Math.max(0, geometry.points.length - 1);
  const activePoint = geometry.points[activeIndex];
  const prevPoint = activeIndex > 0 ? geometry.points[activeIndex - 1] : undefined;

  function locateX(event: MouseEvent<SVGSVGElement>): number {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * layout.width;
    return pointAtX(geometry.points, x);
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (!geometry.points.length) return;
    let next = activeIndex;
    if (event.key === 'ArrowLeft') next = Math.max(0, activeIndex - 1);
    else if (event.key === 'ArrowRight') next = Math.min(geometry.points.length - 1, activeIndex + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = geometry.points.length - 1;
    else if (event.key === 'Enter' && activePoint) {
      event.preventDefault();
      const start = prevPoint?.point.time ?? new Date(activePoint.point.time_ms - 600_000).toISOString();
      onSelectSpan(start, new Date(activePoint.point.time_ms + 1).toISOString());
      return;
    } else return;
    event.preventDefault();
    setSelectedIdx(next);
  }

  return (
    <div ref={wrapRef} className={styles.chartWrap}>
      <div className={chartStyles.legend}>
        <span className={chartStyles.timezone}>Самара · UTC+4 · Факт Google (снимки квот)</span>
        <div className={styles.pillGroup} role="group" aria-label="Направление шкалы квоты">
          <button
            type="button"
            className={`${styles.pill} ${direction === 'remaining' ? styles.pillActive : ''}`}
            onClick={() => onDirectionChange('remaining')}
          >
            Остаток %
          </button>
          <button
            type="button"
            className={`${styles.pill} ${direction === 'used' ? styles.pillActive : ''}`}
            onClick={() => onDirectionChange('used')}
          >
            Израсходовано %
          </button>
        </div>
      </div>

      {timeline.length < 2 ? (
        <div className="agp-stack">
          <p className="agp-muted">
            {timeline.length === 1
              ? `Зафиксирована 1 точка (${formatSamaraDateTime(timeline[0].time)}): ${timeline[0].pool_remaining_pct ?? '—'}%. История квоты накапливается автоматически каждые 10 минут — после следующего снимка появится пилообразная динамика и расход %/ч.`
              : 'Снимки квоты за выбранный период ещё не накоплены.'}
          </p>
          {onRefreshQuota && (
            <div>
              <Button size="sm" variant="secondary" loading={refreshBusy} onClick={onRefreshQuota}>
                Снять снимок квот сейчас
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <p id={descId} className={chartStyles.help}>
            Зелёные отметки показывают пополнения, соседние отметки сгруппированы. Нажмите на точку или Enter, чтобы открыть запросы интервала.
          </p>
          <svg
            ref={plotRef}
            className={styles.chartSvg}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="none"
            role="group"
            tabIndex={0}
            aria-label="Динамика квоты пула и сбросы по времени, Самара UTC+4"
            aria-describedby={descId}
            onKeyDown={handleKeyDown}
            onMouseMove={(e) => {
              const idx = locateX(e);
              if (idx >= 0) setSelectedIdx(idx);
            }}
            onClick={(e) => {
              const idx = locateX(e);
              if (idx >= 0) {
                setSelectedIdx(idx);
                const pt = geometry.points[idx];
                const prev = idx > 0 ? geometry.points[idx - 1].point.time : new Date(pt.point.time_ms - 600_000).toISOString();
                onSelectSpan(prev, new Date(pt.point.time_ms + 1).toISOString());
              }
            }}
          >
            {[0, 25, 50, 75, 100].map((pct) => (
              <g key={pct}>
                <line
                  className={chartStyles.grid}
                  x1={layout.left}
                  x2={layout.width - layout.right}
                  y1={geometry.yPct(pct)}
                  y2={geometry.yPct(pct)}
                />
                <text
                  className={styles.chartAxis}
                  x={layout.left - 8}
                  y={geometry.yPct(pct) + 4}
                  textAnchor="end"
                >
                  {pct}%
                </text>
              </g>
            ))}

            {showUsdBars &&
              geometry.points.map((gp) =>
                gp.barHeight > 0 ? (
                  <rect
                    key={`bar-${gp.point.time_ms}`}
                    className={styles.usdBar}
                    x={gp.x - 3}
                    width={6}
                    y={gp.barTop}
                    height={gp.barHeight}
                    rx={2}
                  />
                ) : null
              )}

            {geometry.poolAreaPath && <path d={geometry.poolAreaPath} className={styles.poolArea} />}
            {geometry.poolLinePath && <path d={geometry.poolLinePath} className={styles.poolLine} />}

            {showAccountsOverlay &&
              geometry.accountSeries.map((series) => (
                <path
                  key={series.accountId}
                  d={series.path}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={1.3}
                  strokeOpacity={0.7}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

            {geometry.resetMarkers
              .map((gp) => (
                <line
                  key={gp.point.time_ms}
                  className={styles.resetLine}
                  x1={gp.x}
                  x2={gp.x}
                  y1={layout.top - 12}
                  y2={layout.top - 3}
                />
              ))}

            {activePoint && (
              <g>
                <line
                  className={chartStyles.crosshair}
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={layout.top}
                  y2={layout.bottom}
                />
                {activePoint.pct !== null && (
                  <circle cx={activePoint.x} cy={activePoint.y} r={4} className={styles.chartPoint} />
                )}
              </g>
            )}
          </svg>

          <div className={styles.chartDates} aria-hidden="true">
            {formatSamaraDateTime(timeline[0].time)}
            <span>{formatSamaraDateTime(timeline[timeline.length - 1].time)}</span>
          </div>

          {showAccountsOverlay && geometry.accountSeries.length > 0 && (
            <div className={chartStyles.legend}>
              {geometry.accountSeries.map((s) => (
                <span key={s.accountId} style={{ color: s.color }}>
                  ● {accountLabels.get(s.accountId) ?? s.accountId}
                </span>
              ))}
            </div>
          )}

          {activePoint && (
            <div className={chartStyles.details} aria-live="polite">
              <button
                type="button"
                className={chartStyles.interval}
                onClick={() => {
                  const prev = prevPoint?.point.time ?? new Date(activePoint.point.time_ms - 600_000).toISOString();
                  onSelectSpan(prev, new Date(activePoint.point.time_ms + 1).toISOString());
                }}
              >
                {formatSamaraDateTime(activePoint.point.time)}
              </button>
              <div className={chartStyles.legend}>
                <span>
                  {direction === 'remaining' ? 'Остаток пула' : 'Израсходовано пула'}:{' '}
                  <strong>{activePoint.pct !== null ? `${activePoint.pct}%` : 'Неизвестно'}</strong>
                </span>
                <span>
                  Активных экв.: <strong>{activePoint.point.pool_account_equivalents.toFixed(2)}</strong> /{' '}
                  {activePoint.point.active_accounts_count} акк.
                </span>
                {activePoint.point.stale_accounts_count > 0 && (
                  <span className="agp-muted">
                    Устаревших: {activePoint.point.stale_accounts_count}
                  </span>
                )}
                <span>
                  API-$ за шаг: <strong>{formatUsd(activePoint.point.api_usd, 3)}</strong> ({activePoint.point.requests} запр.)
                </span>
                {activePoint.hasReset && (
                  <span className={chartStyles.success}>
                    Пополнения ({activePoint.point.resets.length}): {activePoint.point.resets.slice(0, 3).map((r) => `${r.account_label} ${r.from_pct}% → ${r.to_pct}%`).join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}

          <Collapsible
            label="Таблица точек квоты"
            hint={`${timeline.length} точек`}
            open={tableOpen}
            onToggle={(e) => setTableOpen(e.currentTarget.open)}
          >
            {tableOpen && (
              <DataTable
                headers={['Время (Самара)', 'Остаток пула %', 'Экв. аккаунтов', 'API-$ на интервале', 'Сбросы']}
                rows={timeline.slice(-60).reverse().map((pt) => [
                  formatSamaraDateTime(pt.time),
                  pt.pool_remaining_pct !== null ? `${pt.pool_remaining_pct}%` : 'Неизвестно',
                  pt.pool_account_equivalents.toFixed(2),
                  formatUsd(pt.api_usd, 3),
                  pt.resets.length ? pt.resets.map((r) => `${r.account_label}: ${r.from_pct}%→${r.to_pct}%`).join('; ') : '—',
                ])}
              />
            )}
          </Collapsible>
        </>
      )}
    </div>
  );
}
