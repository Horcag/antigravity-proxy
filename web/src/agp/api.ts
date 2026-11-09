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
