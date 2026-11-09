import type { TrafficWindow } from '@/features/dashboard/types';
import type { Account, RequestEntry, Statistics } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
let csrfToken = '';
export function setCsrf(token: string) {
  csrfToken = token;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!path.startsWith('/admin/') || path.includes('://') || path.includes('..'))
    throw new Error('Недопустимый адрес API');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('agp-session-expired'));
      throw new ApiError(
        response.status,
        typeof data.message === 'string' ? data.message : `Ошибка сервера (${response.status})`
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('Сервер недоступен или время ожидания истекло. Повторите запрос.');
  } finally {
    window.clearTimeout(timeout);
  }
}
export const consoleApi = <T>(path: string, method = 'GET', body?: unknown) =>
  api<T>(`/admin/console${path}`, method, body);
export const display = (value: unknown): string =>
  value === null || value === undefined
    ? 'Неизвестно'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
export function mapping(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.values(value).some((item) => typeof item !== 'string')
  )
    throw new Error('Ожидается JSON-объект: имя модели → физическая модель.');
  return value as Record<string, string>;
}

export function localDateValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export type StatisticsGranularity = 'hour' | 'day';

export function statisticsQueryDates(from: string, to: string): URLSearchParams {
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
  return params;
}

export function statisticsTraffic(
  statistics: Statistics | undefined,
  granularity: StatisticsGranularity
): TrafficWindow {
  const buckets =
    granularity === 'hour'
      ? (statistics?.by_hour ?? []).map((hour) => ({
          time: `${hour.hour.slice(0, 10).replace(/-/g, '.')} ${hour.hour.slice(11, 16)} UTC`,
          success: hour.total_requests - hour.failed_requests,
          failed: hour.failed_requests,
        }))
      : (statistics?.by_day ?? []).map((day) => ({
          time: `${day.date.replace(/-/g, '.')} UTC`,
          success: day.total_requests - day.failed_requests,
          failed: day.failed_requests,
        }));
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.success + bucket.failed));
  return {
    buckets,
    totalSuccess: statistics?.success_requests ?? 0,
    totalFailure: statistics?.failed_requests ?? 0,
    total: statistics?.total_requests ?? 0,
    successRate: statistics?.total_requests
      ? (statistics.success_requests / statistics.total_requests) * 100
      : null,
    peakTotal: peak,
    peakIndex: buckets.findIndex((bucket) => bucket.success + bucket.failed === peak),
    activeBuckets: buckets.filter((bucket) => bucket.success + bucket.failed > 0).length,
    windowMinutes: buckets.length * (granularity === 'hour' ? 60 : 1440),
  };
}

export function requestModelLabel(request: RequestEntry): string {
  if (request.route === 'other' && !request.requested_model && !request.effective_model)
    return 'Историческая запись: операция не сохранена';
  if (request.request_kind === 'service') return 'Служебный запрос';
  return `${request.requested_model ?? 'Не измерена'} → ${request.effective_model ?? 'Не измерена'}`;
}

export function requestAccountLabel(request: RequestEntry, accounts: Account[]): string {
  if (!request.account_id)
    return request.authorization_source === 'client'
      ? 'Исходная авторизация'
      : 'Аккаунт неизвестен';
  const account = accounts.find((item) => item.id === request.account_id);
  return account?.email || account?.name || request.account_id;
}
