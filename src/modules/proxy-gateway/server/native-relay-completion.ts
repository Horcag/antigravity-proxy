import { createNativeResponseUsage } from '../../../observability/native-response-usage';
import { observeUpstreamStreamFailure } from '../../../observability/request-context';
import type http from 'node:http';
import type http2 from 'node:http2';
import type { Readable } from 'node:stream';

export function createRelayCompletionPromise(
  req: http.IncomingMessage | http2.Http2ServerRequest,
  res: http.ServerResponse | http2.Http2ServerResponse,
  bodyStream: Readable,
  releaseUpstreamReservation: () => void = () => {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const onDone = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    // Downstream completion
    res.once('finish', () => {
      releaseUpstreamReservation();
      onDone();
    });
    res.once('close', () => {
      releaseUpstreamReservation();
      onDone();
    });
    res.once('error', () => {
      releaseUpstreamReservation();
      onDone();
    });
    // Upstream events release upstream reservation slot without settling downstream promise prematurely
    bodyStream.once('end', () => {
      releaseUpstreamReservation();
    });
    bodyStream.once('error', (err: unknown) => {
      observeUpstreamStreamFailure();
      releaseUpstreamReservation();
      if (!res.writableEnded) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });
    bodyStream.once('close', () => {
      releaseUpstreamReservation();
      if (!bodyStream.readableEnded && !res.writableEnded) {
        observeUpstreamStreamFailure();
        res.destroy(new Error('Upstream stream closed prematurely'));
      }
    });
    req.once?.('close', () => {
      releaseUpstreamReservation();
      onDone();
    });
    req.once?.('aborted', () => {
      releaseUpstreamReservation();
      onDone();
    });
  });
}

/** Завершает учёт метаданных до события finish и сохраняет исходные trailers. */
export function createNativeRelayEnd(
  res: http.ServerResponse | http2.Http2ServerResponse,
  bodyStream: Readable & { trailers?: http.IncomingHttpHeaders },
  headers: http.IncomingHttpHeaders,
  endDownstream: () => boolean,
  rejectDownstream: (error: unknown) => void,
  onUpstreamEnd: () => void = () => {},
) {
  const contentType = headers['content-type'] ? String(headers['content-type']) : undefined;
  const responseUsage = createNativeResponseUsage(contentType, headers['content-encoding'] as string | undefined);
  const onStreamEnd = async () => {
    onUpstreamEnd();
    await responseUsage.finish(!bodyStream.trailers?.['grpc-status'] || String(bodyStream.trailers['grpc-status']) === '0');
    try {
      if (bodyStream.trailers && typeof res.addTrailers === 'function' && !res.writableEnded) res.addTrailers(bodyStream.trailers);
      if (!res.writableEnded) endDownstream();
    } catch (error) { rejectDownstream(error); }
  };
  bodyStream.once('end', onStreamEnd);
  bodyStream.once('error', responseUsage.discard);
  res.once('close', responseUsage.discard);
  res.once('error', responseUsage.discard);
  return { responseUsage, onStreamEnd };
}
