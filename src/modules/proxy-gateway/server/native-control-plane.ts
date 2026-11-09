import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { Transform } from 'node:stream';
import { getServerConfig } from '../../../server/server-config';
import { parseTargetAuthority } from './cert/ca-manager';
import { composeAttemptRequest } from './cloudcode-request-adapter';

import { isNativeControlPlaneRequest } from '../../../shared/native-operations';
export { isNativeControlPlaneRequest } from '../../../shared/native-operations';

export async function forwardNativeControlPlane(
  req: http.IncomingMessage | http2.Http2ServerRequest,
  res: http.ServerResponse | http2.Http2ServerResponse,
  targetHost: string,
  urlPath: string,
): Promise<void> {
  if (!parseTargetAuthority(targetHost) || !isNativeControlPlaneRequest(req.method || 'POST', urlPath)) {
    throw new Error('Native control destination is not permitted');
  }
  const { headers } = composeAttemptRequest({
    rawBody: Buffer.alloc(0), reqHeaders: req.headers, targetHost,
    method: req.method || 'POST', urlPath,
  });
  // The body is streamed unchanged; composeAttemptRequest has not buffered its length.
  delete headers['content-length'];
  if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];

  await new Promise<void>((resolve) => {
    let settled = false;
    let upstream: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 64 * 1024 * 1024 ? new Error('Native request body exceeds limit') : null, chunk);
      },
    });
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onRequestError);
      res.removeListener('close', onClose);
      res.removeListener('error', onResponseError);
      res.removeListener('finish', onFinished);
      req.unpipe(limiter);
      limiter.unpipe();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const stopTransport = () => {
      upstream?.destroy();
      response?.destroy();
      limiter.destroy();
    };
    const fail = (status: number) => {
      if (settled) return;
      finish();
      stopTransport();
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        (res as http.ServerResponse).writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: status, message: 'Native control request transport failed' } }));
      } else if (!res.writableEnded && !res.destroyed) res.destroy();
    };
    const onAborted = () => { finish(); stopTransport(); };
    const onRequestError = () => fail(502);
    const onResponseError = () => { finish(); stopTransport(); };
    const onClose = () => { if (!res.writableFinished) { finish(); stopTransport(); } };
    const onFinished = () => {
      finish();
      stopTransport();
      // Upstream may reject before upload EOF. Stop that upload only after its
      // response has flushed, so neither connection nor an unread body remains.
      if (!req.complete && !req.destroyed) req.destroy();
    };
    const timer = setTimeout(() => fail(504), (getServerConfig()?.request_timeout ?? 120) * 1000);
    timer.unref();
    req.once('aborted', onAborted);
    req.once('error', onRequestError);
    res.once('close', onClose);
    res.once('error', onResponseError);
    res.once('finish', onFinished);
    limiter.once('error', () => fail(bytes > 64 * 1024 * 1024 ? 413 : 502));
    try {
      upstream = https.request({ hostname: targetHost, port: 443, path: urlPath, method: req.method || 'POST', headers }, (incoming) => {
        if (settled) { incoming.destroy(); return; }
        response = incoming;
        const responseHeaders = composeAttemptRequest({
          rawBody: Buffer.alloc(0), reqHeaders: incoming.headers, targetHost, method: 'GET', urlPath,
        }).headers;
        delete responseHeaders.host;
        try { (res as http.ServerResponse).writeHead(incoming.statusCode ?? 502, responseHeaders); } catch { fail(502); return; }
        incoming.once('error', () => fail(502));
        incoming.once('aborted', () => fail(502));
        incoming.pipe(res);
      });
      upstream.once('error', () => fail(502));
      req.pipe(limiter).pipe(upstream);
    } catch {
      fail(502);
    }
  });
}
