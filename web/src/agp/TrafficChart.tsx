import { useId, useMemo, useState, type MouseEvent, type KeyboardEvent } from 'react';
import { Collapsible } from '@/components/ui/Collapsible';
import { Button, DataTable } from './shared';
import {
  bucketAtX,
  chartLayout,
  createTrafficGeometry,
  seriesAtY,
  type ChartBucket,
} from './trafficChartModel';
import styles from './TrafficChart.module.scss';
export type { ChartBucket } from './trafficChartModel';

type Status = 'success' | 'failure';
type Props = {
  buckets: ChartBucket[];
  onSelect: (bucket: ChartBucket, status?: Status) => void;
  formatTime: (iso: string) => string;
  onTotal?: (status?: Status) => void;
};

export function TrafficChart({ buckets, onSelect, formatTime, onTotal }: Props) {
  const descriptionId = useId();
  const [selectedStart, setSelectedStart] = useState<string>();
  const [page, setPage] = useState(0);
  const [tableOpen, setTableOpen] = useState(false);
  const geometry = useMemo(() => createTrafficGeometry(buckets), [buckets]);
  const paths = useMemo(
    () => ({
      successArea: geometry.path('success', true),
      failureArea: geometry.path('failure', true),
      successLine: geometry.path('success'),
      failureLine: geometry.path('failure'),
    }),
    [geometry]
  );
  const indices = useMemo(
    () => new Map(buckets.map((bucket, index) => [bucket.start, index])),
    [buckets]
  );
  const selectedIndex = selectedStart
    ? (indices.get(selectedStart) ?? 0)
    : Math.max(0, buckets.length - 1);
  const selected = buckets[selectedIndex];
  const selectedPoint = geometry.points[selectedIndex];
  const errorMarkers = useMemo(() => {
    const errors = geometry.points.filter((point) => point.bucket.failed_requests > 0);
    if (errors.length <= 80) return errors;
    return Array.from(
      { length: 80 },
      (_, index) => errors[Math.floor((index * (errors.length - 1)) / 79)]
    );
  }, [geometry]);
  const totals = useMemo(
    () =>
      buckets.reduce(
        (sum, b) => ({
          total: sum.total + b.total_requests,
          failed: sum.failed + b.failed_requests,
        }),
        { total: 0, failed: 0 }
      ),
    [buckets]
  );
  const pageCount = Math.ceil(buckets.length / 100);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const interval = (bucket: ChartBucket) =>
    `${formatTime(bucket.start)} — ${formatTime(bucket.end)} (конец не включён)`;
  function locate(event: MouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * chartLayout.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * chartLayout.height;
    const index = bucketAtX(geometry.points, x);
    return { index, y };
  }
  function navigate(event: KeyboardEvent<SVGSVGElement>) {
    let index = selectedIndex;
    if (event.key === 'ArrowLeft') index = Math.max(0, index - 1);
    else if (event.key === 'ArrowRight') index = Math.min(buckets.length - 1, index + 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buckets.length - 1;
    else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      onSelect(selected);
      return;
    } else return;
    event.preventDefault();
    if (buckets[index]) setSelectedStart(buckets[index].start);
  }
  function countButton(bucket: ChartBucket, value: number, label: string, status?: Status) {
    return (
      <button
        type="button"
        className={`${styles.count} ${status ? styles[status] : ''}`}
        onClick={() => onSelect(bucket, status)}
        aria-label={`${label}: ${value}. ${interval(bucket)}. Открыть запросы`}
      >
        {label}: <strong>{value.toLocaleString('ru-RU')}</strong>
      </button>
    );
  }
  return (
    <div className={styles.chart}>
      <div className={styles.legend}>
        <span className={styles.timezone}>Самара · UTC+4</span>
        {(['all', 'success', 'failure'] as const).map((status) => {
          const label = status === 'all' ? 'Всего' : status === 'success' ? 'Успех' : 'Ошибки';
          const value =
            status === 'all'
              ? totals.total
              : status === 'success'
                ? totals.total - totals.failed
                : totals.failed;
          const content = (
            <>
              {label}: <strong>{value.toLocaleString('ru-RU')}</strong>
            </>
          );
          return onTotal ? (
            <button
              key={status}
              type="button"
              className={`${styles.count} ${status === 'all' ? '' : styles[status]}`}
              onClick={() => onTotal(status === 'all' ? undefined : status)}
            >
              {content}
            </button>
          ) : (
            <span key={status} className={status === 'all' ? '' : styles[status]}>
              {content}
            </span>
          );
        })}
      </div>
      {!buckets.length ? (
        <p className="agp-muted">За выбранный период нет интервалов.</p>
      ) : (
        <>
          <p id={descriptionId} className={styles.help}>
            Наведите или выберите интервал. Нажмите зелёную линию для успешных запросов, красную —
            для ошибок. С клавиатуры: ← →, Home / End, Enter — все запросы интервала.
          </p>
          <svg
            className={styles.plot}
            viewBox={`0 0 ${chartLayout.width} ${chartLayout.height}`}
            preserveAspectRatio="none"
            role="group"
            tabIndex={0}
            aria-label="Запросы по времени, Самара UTC+4"
            aria-describedby={descriptionId}
            onKeyDown={navigate}
            onMouseMove={(event) => {
              const { index } = locate(event);
              if (index >= 0) setSelectedStart(buckets[index].start);
            }}
            onClick={(event) => {
              const { index, y } = locate(event);
              if (index >= 0) {
                setSelectedStart(buckets[index].start);
                onSelect(buckets[index], seriesAtY(geometry.points[index], y));
              }
            }}
          >
            {[0, 0.5, 1].map((ratio) => (
              <g key={ratio}>
                <line
                  className={styles.grid}
                  x1={chartLayout.left}
                  x2={chartLayout.width - chartLayout.right}
                  y1={geometry.y(geometry.max * ratio)}
                  y2={geometry.y(geometry.max * ratio)}
                />
                <text
                  className={styles.axis}
                  x={chartLayout.left - 10}
                  y={geometry.y(geometry.max * ratio) + 4}
                  textAnchor="end"
                >
                  {Number((geometry.max * ratio).toFixed(1))}
                </text>
              </g>
            ))}
            <path d={paths.successArea} className={styles.successArea} />
            <path d={paths.failureArea} className={styles.failureArea} />
            <path d={paths.successLine} className={styles.successLine} />
            <path d={paths.failureLine} className={styles.failureLine} />
            {errorMarkers.map((point) => (
              <circle
                key={point.bucket.start}
                className={styles.failureDot}
                cx={point.x}
                cy={point.failureY}
                r={3}
                onMouseMove={(event) => {
                  event.stopPropagation();
                  setSelectedStart(point.bucket.start);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(point.bucket, 'failure');
                }}
              />
            ))}
            {selectedPoint && (
              <g>
                <rect
                  className={styles.selection}
                  x={selectedPoint.left}
                  width={Math.max(1, selectedPoint.right - selectedPoint.left)}
                  y={chartLayout.top}
                  height={chartLayout.bottom - chartLayout.top}
                />
                <line
                  className={styles.crosshair}
                  x1={selectedPoint.x}
                  x2={selectedPoint.x}
                  y1={chartLayout.top}
                  y2={chartLayout.bottom}
                />
                <circle
                  className={styles.successDot}
                  cx={selectedPoint.x}
                  cy={selectedPoint.successY}
                  r={4}
                />
                <circle
                  className={styles.failureDot}
                  cx={selectedPoint.x}
                  cy={selectedPoint.failureY}
                  r={4}
                />
              </g>
            )}
          </svg>
          <div className={styles.timeLabels} aria-hidden="true">
            {[0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]
              .filter((index, position, all) => all.indexOf(index) === position)
              .map((index) => (
                <span key={index}>{formatTime(buckets[index].start)}</span>
              ))}
          </div>
          {selected && (
            <div className={styles.details} aria-live="polite">
              <button type="button" className={styles.interval} onClick={() => onSelect(selected)}>
                {interval(selected)}
              </button>
              <div className={styles.legend}>
                {countButton(selected, selected.total_requests, 'Всего')}
                {countButton(
                  selected,
                  selected.total_requests - selected.failed_requests,
                  'Успех',
                  'success'
                )}
                {countButton(selected, selected.failed_requests, 'Ошибки', 'failure')}
              </div>
            </div>
          )}
          <Collapsible
            label="Точные значения по интервалам"
            hint={`${buckets.length} интервалов`}
            open={tableOpen}
            onToggle={(event) => setTableOpen(event.currentTarget.open)}
          >
            {tableOpen && (
              <>
                <DataTable
                  headers={['Интервал · Самара', 'Всего', 'Успех', 'Ошибки']}
                  rows={buckets.slice(currentPage * 100, (currentPage + 1) * 100).map((bucket) => [
                    <button
                      type="button"
                      className={styles.interval}
                      onClick={() => onSelect(bucket)}
                    >
                      {interval(bucket)}
                    </button>,
                    countButton(bucket, bucket.total_requests, 'Всего'),
                    countButton(
                      bucket,
                      bucket.total_requests - bucket.failed_requests,
                      'Успех',
                      'success'
                    ),
                    countButton(bucket, bucket.failed_requests, 'Ошибки', 'failure'),
                  ])}
                />
                <div className={styles.pagination}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Назад
                  </Button>
                  <span>
                    {currentPage + 1} / {pageCount}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={currentPage + 1 >= pageCount}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Далее
                  </Button>
                </div>
              </>
            )}
          </Collapsible>
        </>
      )}
    </div>
  );
}
