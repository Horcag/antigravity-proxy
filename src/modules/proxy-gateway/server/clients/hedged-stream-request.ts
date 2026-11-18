import type { AxiosRequestConfig } from 'axios';
import { Readable } from 'node:stream';
import { getUpstreamRequestCancellation, throwIfUpstreamRequestCanceled } from './upstream-error';

export const STREAM_ENDPOINT_HEDGE_DELAY_MS = 4000;

/** Race at most two endpoint requests; response streams are never combined. */
export function hedgedStreamRequest<T extends { data: unknown }>(options: {
  request: (index: number, signal: AbortSignal) => Promise<T>;
  endpointCount: number;
  shouldRetry: (error: unknown) => boolean;
  signal?: AxiosRequestConfig['signal'];
  delayMs?: number;
}): Promise<{ response: T; index: number }> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let pending = 0;
    let winner: T | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detach = () => options.signal?.removeEventListener?.('abort', onAbort);
    const destroy = (value: unknown) => {
      if (value instanceof Readable) value.destroy();
    };
    const stopPeers = (winnerIndex = -1) => {
      clearTimeout(timer);
      controllers.forEach((controller, index) => {
        if (index !== winnerIndex) controller.abort();
      });
    };
    const onAbort = () => {
      stopPeers();
      destroy(winner?.data);
      detach();
      if (settled) return;
      settled = true;
      const error = new Error('Upstream request canceled');
      error.name = 'AbortError';
      reject(error);
    };
    const start = () => {
      const index = controllers.length;
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      // The rejection handler also owns late failures after another endpoint won.
      void Promise.resolve().then(() => {
        throwIfUpstreamRequestCanceled(undefined, controller.signal);
        return options.request(index, controller.signal);
      }).then((response) => {
        pending--;
        if (settled) {
          destroy(response.data);
          return;
        }
        settled = true;
        winner = response;
        stopPeers(index);
        if (response.data instanceof Readable) {
          response.data.once('close', detach);
          response.data.once('end', detach);
          response.data.once('error', detach);
        } else {
          detach();
        }
        resolve({ response, index });
      }, (error: unknown) => {
        pending--;
        const failedData = (error as { response?: { data?: unknown } } | null)?.response?.data;
        if (settled) {
          destroy(failedData);
          return;
        }
        if (getUpstreamRequestCancellation(error, options.signal)) {
          destroy(failedData);
          onAbort();
          return;
        }
        if (!options.shouldRetry(error)) {
          settled = true;
          // Keep the rejected response readable for bounded 403/ToS classification.
          stopPeers(index);
          detach();
          reject(error);
          return;
        }
        if (controllers.length < Math.min(2, options.endpointCount)) {
          destroy(failedData);
          clearTimeout(timer);
          start();
        } else if (pending === 0) {
          settled = true;
          // Keep the final rejected response readable for upstream error classification (e.g. 429).
          stopPeers();
          detach();
          reject(error);
        } else {
          destroy(failedData);
        }
      });
    };
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    start();
    if (options.endpointCount > 1) {
      timer = setTimeout(() => {
        if (!settled && controllers.length === 1) start();
      }, options.delayMs ?? STREAM_ENDPOINT_HEDGE_DELAY_MS);
    }
  });
}
