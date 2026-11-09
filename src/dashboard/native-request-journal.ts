import type http from 'node:http';
import type http2 from 'node:http2';
import { getObservedNativeModel } from '../shared/request-observation';
import { createRequestObservation, runWithRequestObservation } from '../observability/request-context';
import { requestJournal } from './request-journal';

export function observeNativeRequest(
  req: http.IncomingMessage | http2.Http2ServerRequest,
  res: http.ServerResponse | http2.Http2ServerResponse,
  work: () => void = () => {},
): void {
  const context = createRequestObservation();
  const started = performance.now();
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    context.finished = true;
    let route = 'other';
    try { route = new URL(req.url || '/', 'https://cloudcode-pa.googleapis.com').pathname; } catch { /* Invalid targets remain opaque. */ }
    requestJournal.record({ ...context, protocol: 'connect', route, model: getObservedNativeModel(req),
      project_id: 'native', project_name: 'Antigravity и agy',
      status: context.upstream_failed ? 502 : res.writableFinished ? res.statusCode : 499, duration_ms: performance.now() - started });
  };
  res.once('finish', record);
  res.once('close', record);
  runWithRequestObservation(context, work);
}
