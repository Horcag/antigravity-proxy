import type { StatisticsBucket } from './types';

export const historyFilterKeys = [
  'accountId',
  'finalAccountId',
  'projectId',
  'model',
  'missingModel',
  'status',
  'result',
  'from',
  'to',
  'toExclusive',
  'metric',
  'attemptOutcome',
] as const;
export function historyParams(source: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const key of historyFilterKeys) {
    const value = source.get(key);
    if (value) result.set(key, value);
  }
  return result;
}
export function requestsHref(
  source: URLSearchParams,
  changes: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const params = historyParams(source);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === null || value === '') params.delete(key);
    else if (key === 'result' && params.get('result') && params.get('result') !== value)
      params.set('result', 'none');
    else params.set(key, String(value));
  }
  return `/requests?${params}`;
}
export function bucketRequestHref(
  source: URLSearchParams,
  bucket: StatisticsBucket,
  status?: 'success' | 'failure'
): string {
  const from = Math.max(Date.parse(bucket.start), Date.parse(source.get('from') ?? bucket.start));
  const ends = [Date.parse(bucket.end)];
  if (source.get('toExclusive')) ends.push(Date.parse(source.get('toExclusive')!));
  if (source.get('to')) ends.push(Date.parse(source.get('to')!) + 1);
  return requestsHref(source, {
    from: new Date(from).toISOString(),
    to: null,
    toExclusive: new Date(Math.min(...ends)).toISOString(),
    ...(status ? { result: status } : {}),
  });
}
export function modelRequestFilters(model: string | null) {
  return model === null ? { model: null, missingModel: 'true' } : { model, missingModel: null };
}
export const metricLabels: Record<string, string> = {
  input_tokens: 'Входные токены',
  output_tokens: 'Выходные токены',
  cache_tokens: 'Кэшированные токены',
  duration_ms: 'Время ответа',
  ttft_ms: 'TTFT',
};
export function formatMetric(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'Неизвестно'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}
