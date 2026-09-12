import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Extracts an AbortSignal observing client disconnection during request-response lifecycle.
 * Accurately distinguishes between:
 * - reading request body completion (IncomingMessage.complete)
 * - premature client disconnection while waiting for upstream response
 * - normal response completion
 */
export function extractRequestAbortSignal(
  request?: FastifyRequest,
  reply?: FastifyReply,
): AbortSignal | undefined {
  if (!request) return undefined;
  const raw = request.raw;
  if (!raw) return undefined;

  const resRaw = reply?.raw || (raw.socket && (raw.socket as any)._httpMessage);
  const socket = raw.socket || (resRaw && resRaw.socket);

  // If the response has already finished sending, the request is not aborted
  if (resRaw?.writableFinished) {
    return undefined;
  }

  // If client disconnected before response finished
  if (resRaw?.destroyed || socket?.destroyed) {
    return AbortSignal.abort();
  }

  const controller = new AbortController();

  const onAbort = () => {
    if (resRaw && !resRaw.writableFinished) {
      controller.abort();
    } else if (!resRaw && (!raw.complete || socket?.destroyed)) {
      controller.abort();
    }
    cleanup();
  };

  const cleanup = () => {
    if (resRaw) {
      resRaw.removeListener('close', onAbort);
      resRaw.removeListener('finish', cleanup);
    }
    if (socket) {
      socket.removeListener('close', onAbort);
      socket.removeListener('error', onAbort);
    }
  };

  if (resRaw) {
    resRaw.once('close', onAbort);
    resRaw.once('finish', cleanup);
  }
  if (socket) {
    socket.once('close', onAbort);
    socket.once('error', onAbort);
  }

  return controller.signal;
}
