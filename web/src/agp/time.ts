export const CONSOLE_TIME_ZONE = 'Europe/Samara';
export const CONSOLE_TIME_LABEL = 'Самара · UTC+4';

function timestamp(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return NaN;
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
}

export function localDateTimeValue(iso: string | null): string {
  const ms = timestamp(iso);
  if (!Number.isFinite(ms)) return '';
  // Console history covers modern dates: Samara has a fixed UTC+4 offset.
  return new Date(ms + 4 * 60 * 60 * 1000).toISOString().slice(0, 19);
}
export function localDateValue(iso: string | null): string {
  return localDateTimeValue(iso).slice(0, 10);
}
export function samaraDateTimeToIso(value: string): string {
  if (!value) return '';
  return new Date(`${value}+04:00`).toISOString();
}
export function samaraDayBoundary(value: string, end = false): string {
  return value ? samaraDateTimeToIso(`${value}T${end ? '23:59:59.999' : '00:00:00'}`) : '';
}
export function formatSamaraDateTime(value: string | number | null | undefined): string {
  const ms = timestamp(value);
  return Number.isFinite(ms)
    ? `${new Intl.DateTimeFormat('ru-RU', {
        timeZone: CONSOLE_TIME_ZONE,
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(ms)} (Самара)`
    : 'Неизвестно';
}
export function formatSamaraTime(value: string | number): string {
  const ms = timestamp(value);
  return `${new Intl.DateTimeFormat('ru-RU', {
    timeZone: CONSOLE_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(ms)} (Самара)`;
}
export function formatConsoleValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'Неизвестно';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))
    return formatSamaraDateTime(value);
  if (typeof value === 'number' && /(?:_at|_time|Time|timestamp)$/.test(key))
    return formatSamaraDateTime(value);
  if (typeof value === 'object')
    return JSON.stringify(
      value,
      (nestedKey, nestedValue: unknown) => {
        if (typeof nestedValue === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(nestedValue))
          return formatSamaraDateTime(nestedValue);
        if (typeof nestedValue === 'number' && /(?:_at|_time|Time|timestamp)$/.test(nestedKey))
          return formatSamaraDateTime(nestedValue);
        return nestedValue;
      },
      2
    );
  return String(value);
}
