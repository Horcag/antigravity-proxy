import { Input } from '@/components/ui/Input';
import type { EfficiencyComparison, ShiftVerdict } from './quotaAnalyticsTypes';
import { formatTokensCompact, formatUsd } from './quotaChartModel';
import { formatSamaraDateTime, localDateTimeValue, samaraDateTimeToIso } from './time';
import { Button, Card, DataTable } from './shared';
import styles from './QuotaAnalytics.module.scss';

type Props = {
  efficiency: EfficiencyComparison;
  splitAt: string;
  idleGapMinutes: number;
  minDeltaPp: number;
  onChangeParam: (key: string, value: string) => void;
};

const verdictMap: Record<ShiftVerdict, { label: string; tone: string }> = {
  possible_nerf: { label: 'Возможная урезка квоты', tone: styles.tagDanger },
  improved: { label: 'Квота стала выгоднее', tone: styles.tagOk },
  stable: { label: 'Эффективность в норме', tone: styles.tagOk },
  insufficient_data: { label: 'Недостаточно данных', tone: styles.tagWarn },
};

function formatDelta(delta: number | null): string {
  if (delta === null) return 'Неизвестно';
  return `${delta > 0 ? '+' : ''}${delta}%`;
}

export function QuotaComparisonPanel({
  efficiency,
  splitAt,
  idleGapMinutes,
  minDeltaPp,
  onChangeParam,
}: Props) {
  const badge = verdictMap[efficiency.verdict];
  const { baseline, current } = efficiency;

  return (
    <Card
      title="Сравнение эффективности: до / после (детектор урезки)"
      extra={<span className={`${styles.tag} ${badge.tone}`}>{badge.label}</span>}
    >
      <p>{efficiency.reason}</p>
      <div className="agp-filters">
        <Input
          label="Рубеж сравнения (Самара, пусто = прошлый период)"
          type="datetime-local"
          step="60"
          value={localDateTimeValue(splitAt || null)}
          onChange={(e) => onChangeParam('splitAt', samaraDateTimeToIso(e.target.value))}
        />
        {splitAt && (
          <Button variant="secondary" size="sm" onClick={() => onChangeParam('splitAt', '')}>
            Сбросить рубеж
          </Button>
        )}
        <label className="agp-field">
          Порог паузы активного времени
          <select
            className="input"
            value={String(idleGapMinutes)}
            onChange={(e) => onChangeParam('idleGapMinutes', e.target.value)}
          >
            <option value="2">2 мин</option>
            <option value="5">5 мин (по умолчанию)</option>
            <option value="10">10 мин</option>
            <option value="15">15 мин</option>
          </select>
        </label>
        <label className="agp-field">
          Мин. шаг дельты квоты
          <select
            className="input"
            value={String(minDeltaPp)}
            onChange={(e) => onChangeParam('minDeltaPp', e.target.value)}
          >
            <option value="0.5">0.5% (точный)</option>
            <option value="1">1.0%</option>
            <option value="2">2.0% (грубый)</option>
          </select>
        </label>
      </div>
      <DataTable
        headers={['Метрика (по верифицированным интервалам без сбросов)', 'Базовый период', 'Текущий период', 'Сдвиг']}
        rows={[
          [
            'Границы (Самара)',
            `${formatSamaraDateTime(baseline.from)} — ${formatSamaraDateTime(baseline.to_exclusive)}`,
            `${formatSamaraDateTime(current.from)} — ${formatSamaraDateTime(current.to_exclusive)}`,
            '—',
          ],
          [
            'Выборка расхода / интервалов',
            `${baseline.sample_drain_pct}% (${baseline.interval_count} инт.)`,
            `${current.sample_drain_pct}% (${current.interval_count} инт.)`,
            '≥ 5% и ≥ 2 инт.',
          ],
          [
            'Сопоставлено API-$ в интервалах',
            formatUsd(baseline.matched_api_usd, 3),
            formatUsd(current.matched_api_usd, 3),
            '—',
          ],
          [
            'API-$ за 1% квоты',
            formatUsd(baseline.usd_per_1pct, 3),
            formatUsd(current.usd_per_1pct, 3),
            formatDelta(efficiency.usd_per_1pct_delta_pct),
          ],
          [
            'Токенов за 1% квоты',
            formatTokensCompact(baseline.tokens_per_1pct),
            formatTokensCompact(current.tokens_per_1pct),
            formatDelta(efficiency.tokens_per_1pct_delta_pct),
          ],
          [
            'Оценка 100% окна квоты (проекция)',
            formatUsd(baseline.implied_100pct_usd, 2),
            formatUsd(current.implied_100pct_usd, 2),
            'Проекция',
          ],
          [
            'Cache Hit / покрытие тарифами',
            `${baseline.cache_hit_pct ?? '—'}% / ${baseline.priced_coverage_pct ?? '—'}%`,
            `${current.cache_hit_pct ?? '—'}% / ${current.priced_coverage_pct ?? '—'}%`,
            '—',
          ],
        ]}
      />
    </Card>
  );
}
