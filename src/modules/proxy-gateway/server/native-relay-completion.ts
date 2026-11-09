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
