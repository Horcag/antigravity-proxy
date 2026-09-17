import type * as http from 'node:http';
import type * as http2 from 'node:http2';

export interface FormattedTerminalError {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string | Buffer | undefined;
}

const HTTP_TO_GRPC_STATUS: Record<number, string> = {
  400: '3', // INVALID_ARGUMENT
  401: '16', // UNAUTHENTICATED
  403: '7', // PERMISSION_DENIED
  404: '5', // NOT_FOUND
  408: '4', // DEADLINE_EXCEEDED
  409: '10', // ABORTED
  413: '11', // OUT_OF_RANGE
  429: '8', // RESOURCE_EXHAUSTED
  499: '1', // CANCELLED
  500: '13', // INTERNAL
  501: '12', // UNIMPLEMENTED
  503: '14', // UNAVAILABLE
  504: '4', // DEADLINE_EXCEEDED
};

/**
 * Format terminal downstream error headers and payload consistency:
 * 1. Strips content-encoding header (since error payload is plaintext/uncompressed).
 * 2. Updates content-length to exact byte length of terminal payload.
 * 3. Frames SSE streams as `data: ${JSON.stringify(errorPayload)}\n\n` with text/event-stream content-type.
 * 4. Sets canonical gRPC status and message headers for native gRPC requests.
 */
export function formatTerminalDownstreamError(
  req: http.IncomingMessage | http2.Http2ServerRequest | { headers: http.IncomingHttpHeaders },
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  body?: string | Buffer,
): FormattedTerminalError {
  const resultHeaders: http.IncomingHttpHeaders = { ...headers };

  // 1. Strip content-encoding (error payloads are uncompressed)
  for (const key of Object.keys(resultHeaders)) {
    if (key.toLowerCase() === 'content-encoding') {
      delete resultHeaders[key];
    }
  }

  const reqHeaders = req?.headers || {};
  const reqAccept = String(reqHeaders.accept || '').toLowerCase();
  const reqContentType = String(reqHeaders['content-type'] || '').toLowerCase();
  const resContentType = String(resultHeaders['content-type'] || '').toLowerCase();

  const isSse = reqAccept.includes('text/event-stream') || resContentType.includes('text/event-stream');
  const isGrpc =
    reqContentType.includes('application/grpc') ||
    resContentType.includes('application/grpc') ||
    resultHeaders['grpc-status'] !== undefined;

  let terminalBody = body;

  if (isGrpc) {
    // Native gRPC error framing
    let grpcStatus = resultHeaders['grpc-status'];
    if (grpcStatus === undefined || String(grpcStatus) === '0') {
      grpcStatus = HTTP_TO_GRPC_STATUS[statusCode] || '13';
      resultHeaders['grpc-status'] = grpcStatus;
    }
    if (!resultHeaders['grpc-message']) {
      resultHeaders['grpc-message'] = String(resultHeaders['grpc-status-details-bin'] || `HTTP_${statusCode}`);
    }
    resultHeaders['content-type'] = 'application/grpc';
  } else if (isSse) {
    // SSE stream framing: data: {...}\n\n
    let errorPayload: Record<string, unknown>;
    const rawText = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf-8') : '';

    if (rawText.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawText.trim());
        if (parsed && typeof parsed === 'object') {
          errorPayload = parsed.error ? parsed : { error: parsed };
        } else {
          errorPayload = { error: { code: statusCode, message: rawText.trim() } };
        }
      } catch {
        errorPayload = { error: { code: statusCode, message: rawText.trim() || 'Error' } };
      }
    } else {
      errorPayload = {
        error: {
          code: statusCode,
          message: rawText.trim() || `HTTP error ${statusCode}`,
        },
      };
    }

    terminalBody = `data: ${JSON.stringify(errorPayload)}\n\n`;
    resultHeaders['content-type'] = 'text/event-stream; charset=utf-8';
  }

  if (terminalBody !== undefined) {
    const byteLength = typeof terminalBody === 'string' ? Buffer.byteLength(terminalBody, 'utf-8') : terminalBody.length;
    resultHeaders['content-length'] = String(byteLength);
  }

  return {
    statusCode,
    headers: resultHeaders,
    body: terminalBody,
  };
}
