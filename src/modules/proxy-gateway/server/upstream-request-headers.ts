import type { IncomingHttpHeaders } from 'node:http';

const LOCAL_HEADERS = new Set([
  'host', 'connection', 'proxy-connection', 'proxy-authorization',
  'transfer-encoding', 'te', 'trailer', 'keep-alive', 'upgrade',
  'forwarded', 'via', 'x-real-ip', 'x-goog-session-id',
]);

export function isolateUpstreamHeaders(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  // Connection can nominate arbitrary hop-by-hop headers, including credentials.
  const connectionHeaders = new Set(
    (normalized.connection ?? '').split(',').map((name) => name.trim().toLowerCase()),
  );
  const upstream: Record<string, string> = {};
  for (const [name, value] of Object.entries(normalized)) {
    if (name.startsWith(':') || LOCAL_HEADERS.has(name) || connectionHeaders.has(name)
      || name.startsWith('x-ag-proxy-') || name.startsWith('x-forwarded-')) continue;
    upstream[name] = value;
  }
  return upstream;
}
