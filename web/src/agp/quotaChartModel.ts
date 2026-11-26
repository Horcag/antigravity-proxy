import type { QuotaTimelinePoint } from './quotaAnalyticsTypes';

export type QuotaChartDirection = 'remaining' | 'used';

export const quotaChartLayout = {
  width: 960,
  height: 290,
  left: 52,
  right: 20,
  top: 24,
  bottom: 236,
};

export interface QuotaGeometryPoint {
  point: QuotaTimelinePoint;
  x: number;
  y: number;
  pct: number | null;
  barTop: number;
  barHeight: number;
  hasReset: boolean;
}

export interface QuotaAccountSeries {
  accountId: string;
  path: string;
  color: string;
}

const ACCOUNT_PALETTE = ['#6366f1', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];

function projectValue(pct: number | null, direction: QuotaChartDirection): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  return direction === 'used' ? Math.round((100 - clamped) * 10) / 10 : clamped;
}

export function createQuotaChartGeometry(
  timeline: QuotaTimelinePoint[],
  direction: QuotaChartDirection = 'remaining',
  accountIds: string[] = [],
  layout = quotaChartLayout,
) {
  const { width, left, right, top, bottom } = layout;
  const fromMs = timeline.length ? timeline[0].time_ms : 0;
  const toMs = timeline.length
    ? Math.max(fromMs + 1, timeline[timeline.length - 1].time_ms)
    : fromMs + 1;
  const maxUsd = timeline.reduce((m, p) => Math.max(m, p.api_usd), 0.01);

  const x = (timeMs: number) =>
    timeline.length <= 1
      ? (left + width - right) / 2
      : left + ((timeMs - fromMs) / Math.max(1, toMs - fromMs)) * (width - left - right);

  const yPct = (pct: number) => bottom - (Math.max(0, Math.min(100, pct)) / 100) * (bottom - top);

  const points: QuotaGeometryPoint[] = timeline.map((point) => {
    const pct = projectValue(point.pool_remaining_pct, direction);
    const barH = point.api_usd > 0 ? Math.max(2, (point.api_usd / maxUsd) * (bottom - top) * 0.45) : 0;
    return {
      point,
      x: x(point.time_ms),
      y: pct === null ? bottom : yPct(pct),
      pct,
      barTop: bottom - barH,
      barHeight: barH,
      hasReset: point.resets.length > 0,
    };
  });

  function buildLinePath(getter: (pt: QuotaTimelinePoint) => number | null, area = false): string {
    const parts: string[] = [];
    let openSegment: QuotaGeometryPoint[] = [];
    const flush = () => {
      if (openSegment.length === 0) return;
      const cmds = openSegment.map((gp, idx) => {
        const val = projectValue(getter(gp.point), direction) ?? 0;
        const py = yPct(val);
        return `${idx === 0 ? 'M' : 'L'}${gp.x.toFixed(1)},${py.toFixed(1)}`;
      });
      if (area && openSegment.length >= 2) {
        const first = openSegment[0];
        const last = openSegment[openSegment.length - 1];
        cmds.push(`L${last.x.toFixed(1)},${bottom}L${first.x.toFixed(1)},${bottom}Z`);
      }
      parts.push(cmds.join(''));
      openSegment = [];
    };

    for (const gp of points) {
      if (projectValue(getter(gp.point), direction) === null) flush();
      else openSegment.push(gp);
    }
    flush();
    return parts.join('');
  }

  const poolLinePath = buildLinePath((p) => p.pool_remaining_pct, false);
  const poolAreaPath = buildLinePath((p) => p.pool_remaining_pct, true);
  const accountSeries: QuotaAccountSeries[] = accountIds
    .slice(0, 6)
    .map((accountId, idx) => ({
      accountId,
      path: buildLinePath((p) => p.by_account[accountId] ?? null, false),
      color: ACCOUNT_PALETTE[idx % ACCOUNT_PALETTE.length],
    }))
    .filter((s) => Boolean(s.path));

  const resetMarkers: QuotaGeometryPoint[] = [];
  for (const point of points) {
    const previous = resetMarkers[resetMarkers.length - 1];
    if (point.hasReset && point.x - (previous?.x ?? -Infinity) >= 20) resetMarkers.push(point);
  }
  return { points, poolLinePath, poolAreaPath, accountSeries, resetMarkers, yPct, fromMs, toMs, maxUsd };
}

export function pointAtX(points: QuotaGeometryPoint[], x: number): number {
  if (points.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs(points[0].x - x);
  for (let i = 1; i < points.length; i += 1) {
    const dist = Math.abs(points[i].x - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function formatUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Неизвестно';
  return `$${value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatTokensCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Неизвестно';
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}M`;
  if (value >= 1_000) return `${(value / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}K`;
  return value.toLocaleString('ru-RU');
}

export function formatCountdownUntil(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return 'Неизвестно';
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return 'Неизвестно';
  const diffMs = target - nowMs;
  if (diffMs <= 0) return 'Сброс ожидается';
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `через ${days} д ${hours} ч`;
  if (hours > 0) return `через ${hours} ч ${mins} м`;
  return `через ${Math.max(1, mins)} м`;
}
