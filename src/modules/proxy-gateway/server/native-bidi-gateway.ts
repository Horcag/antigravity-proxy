import crypto from 'node:crypto';
import type http from 'node:http';
import http2 from 'node:http2';
import type { AccountLeaseService, AttemptLease } from './account-lease.service';
import { logger } from '../../../shared/logging/logger';
import { safeDecodeGrpcMessage } from './upstream-failure';

export const NATIVE_AUDIO_HOST = 'aicode.googleapis.com';
export const NATIVE_AUDIO_PATH = '/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent';

type NativeRequest = http.IncomingMessage | http2.Http2ServerRequest;
type NativeResponse = http.ServerResponse | http2.Http2ServerResponse;
type LeaseOwner = Pick<AccountLeaseService, 'acquireAttemptLease'> & Partial<Pick<AccountLeaseService, 'markAsForbidden'>>;
const nativeAudioOutcomes = new WeakMap<NativeRequest, string>();

/** Only a bounded gRPC status is retained; audio and upstream error messages are not stored. */
export function getNativeAudioOutcome(req: NativeRequest): string | undefined {
  return nativeAudioOutcomes.get(req);
}

interface NativeBidiOptions {
  connect?: (authority: string) => http2.ClientHttp2Session;
  setupTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export function isNativeAudioRequest(req: NativeRequest): boolean {
  const authority = String(req.headers[':authority'] ?? req.headers.host ?? '').toLowerCase();
  return (authority === NATIVE_AUDIO_HOST || authority === `${NATIVE_AUDIO_HOST}:443`)
    && req.method === 'POST' && req.url === NATIVE_AUDIO_PATH;
}

function endToEndHeaders(headers: http2.IncomingHttpHeaders | http.IncomingHttpHeaders): http2.OutgoingHttpHeaders {
  const excluded = new Set([
    'connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
    'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'http2-settings',
  ]);
  const connection = headers.connection;
  for (const value of Array.isArray(connection) ? connection : [connection ?? '']) {
    for (const name of value.split(',')) excluded.add(name.trim().toLowerCase());
  }
  const result: http2.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith(':') && !excluded.has(name.toLowerCase()) && value !== undefined) {
      result[name] = Array.isArray(value) ? [...value] : value;
    }
  }
  return result;
}

function unavailable(req: NativeRequest, res: NativeResponse, status: string, message: string): void {
  nativeAudioOutcomes.set(req, status);
  if (res.destroyed || res.writableEnded) return;
  writeHeaders(res, 200, { 'content-type': 'application/grpc' });
  res.addTrailers({ 'grpc-status': status, 'grpc-message': encodeURIComponent(message) });
  res.end();
}

function writeHeaders(res: NativeResponse, status: number, headers: http2.OutgoingHttpHeaders): void {
  if ('stream' in res) res.writeHead(status, headers);
  else res.writeHead(status, headers);
}

function resetResponse(res: NativeResponse): void {
  if ('stream' in res) res.stream.close(http2.constants.NGHTTP2_CANCEL);
  else res.destroy();
}

/** One native gRPC stream owns one account. Frames are never buffered for replay. */
export class NativeBidiGateway {
  private readonly connect: (authority: string) => http2.ClientHttp2Session;
  private readonly setupTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly leaseOwner?: LeaseOwner, options: NativeBidiOptions = {}) {
    this.connect = options.connect ?? ((authority) => http2.connect(authority));
    this.setupTimeoutMs = options.setupTimeoutMs ?? 15_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  async handleRequest(req: NativeRequest, res: NativeResponse): Promise<void> {
    if (!isNativeAudioRequest(req)) {
      unavailable(req, res, '12', 'Native audio RPC is not supported');
      return;
    }
    if (req.httpVersionMajor !== 2 || !/^application\/grpc(?:\+[^;\s]+)?(?:;|$)/.test(String(req.headers['content-type'] ?? ''))) {
      unavailable(req, res, '12', 'Native audio requires HTTP/2 gRPC');
      return;
    }

    const abort = new AbortController();
    const onClientClose = () => abort.abort();
    req.once('aborted', onClientClose);
    res.once('close', onClientClose);
    let lease: AttemptLease | null = null;
    try {
      lease = await this.leaseOwner?.acquireAttemptLease({ signal: abort.signal, requestId: crypto.randomUUID() }) ?? null;
      if (abort.signal.aborted) return;
      if (!lease?.account.token.access_token) {
        unavailable(req, res, '14', 'No native audio account capacity available');
        return;
      }
      let quarantined = false;
      const observeMetadata = (headers: http2.IncomingHttpHeaders) => {
        const status = String(headers['grpc-status'] ?? '');
        if (/^(?:[0-9]|1[0-6])$/.test(status)) nativeAudioOutcomes.set(req, status);
        const message = safeDecodeGrpcMessage(String(headers['grpc-message'] ?? '')).toLowerCase();
        if (!quarantined && status === '7' && message.includes('this service has been disabled in this account for violation of terms of service')) {
          quarantined = true;
          try { this.leaseOwner?.markAsForbidden?.(lease!.account.id, 'tos_violation'); }
          catch { logger.warn('[NativeBidiGateway] Could not quarantine a native audio account after a TOS denial'); }
        }
      };
      await this.forward(req, res, lease.account.token.access_token, abort.signal, observeMetadata);
    } catch {
      logger.warn('[NativeBidiGateway] Native audio transport failed; request was not retried');
      if (!res.headersSent) unavailable(req, res, '14', 'Native audio upstream unavailable');
      else resetResponse(res);
    } finally {
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
      lease?.releaseReservation();
    }
  }

  private forward(req: NativeRequest, res: NativeResponse, accessToken: string, signal: AbortSignal,
    observeMetadata: (headers: http2.IncomingHttpHeaders) => void): Promise<void> {
    return new Promise((resolve) => {
      let session: http2.ClientHttp2Session | undefined;
      let upstream: http2.ClientHttp2Stream | undefined;
      let settled = false;
      let receivedHeaders = false;
      let responseEnded = false;
      const timer = setTimeout(() => fail(), this.setupTimeoutMs);
      timer.unref();

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        req.off('error', fail);
        res.off('error', fail);
        res.off('finish', finish);
        if (upstream) req.unpipe(upstream);
        upstream?.unpipe(res);
        upstream?.close(http2.constants.NGHTTP2_CANCEL);
        session?.destroy();
        resolve();
      };
      const fail = () => {
        if (settled) return;
        logger.warn('[NativeBidiGateway] Native audio stream failed; request was not retried');
        if (!nativeAudioOutcomes.has(req)) nativeAudioOutcomes.set(req, '14');
        if (!res.headersSent) unavailable(req, res, '14', 'Native audio upstream unavailable');
        // Upstream reset can emit end before error, so pipe() may already have
        // ended the response while the duplex stream still needs an RST_STREAM.
        else resetResponse(res);
        cleanup();
      };
      const cancel = () => {
        if (!nativeAudioOutcomes.has(req)) nativeAudioOutcomes.set(req, '1');
        cleanup();
      };
      const finish = () => cleanup();
      signal.addEventListener('abort', cancel, { once: true });
      req.once('error', fail);
      res.once('error', fail);
      res.once('finish', finish);
      if (signal.aborted) { cleanup(); return; }

      try {
        session = this.connect(`https://${NATIVE_AUDIO_HOST}`);
        session.on('error', fail);
        session.once('close', () => { if (!responseEnded) fail(); });
        const headers = endToEndHeaders(req.headers);
        delete headers['x-goog-api-key'];
        headers.authorization = `Bearer ${accessToken}`;
        headers[':method'] = 'POST';
        headers[':path'] = NATIVE_AUDIO_PATH;
        headers[':scheme'] = 'https';
        headers[':authority'] = String(req.headers[':authority'] ?? req.headers.host);
        upstream = session.request(headers, { endStream: false, waitForTrailers: true });
        upstream.setTimeout(this.idleTimeoutMs, fail);
        upstream.on('error', fail);
        upstream.once('aborted', fail);
        upstream.once('close', () => { if (!responseEnded) fail(); });
        upstream.once('wantTrailers', () => {
          if (!upstream?.destroyed) upstream?.sendTrailers(endToEndHeaders(req.trailers));
        });
        upstream.once('response', (responseHeaders) => {
          if (settled) return;
          receivedHeaders = true;
          clearTimeout(timer);
          observeMetadata(responseHeaders);
          writeHeaders(res, Number(responseHeaders[':status'] ?? 502), endToEndHeaders(responseHeaders));
        });
        upstream.once('trailers', (trailers) => {
          if (!settled) {
            observeMetadata(trailers);
            res.addTrailers(endToEndHeaders(trailers));
          }
        });
        upstream.once('end', () => {
          responseEnded = true;
          if (!receivedHeaders) fail();
        });
        // pipe() applies bounded stream backpressure independently in both directions.
        upstream.pipe(res);
        req.pipe(upstream);
      } catch {
        fail();
      }
    });
  }
}
