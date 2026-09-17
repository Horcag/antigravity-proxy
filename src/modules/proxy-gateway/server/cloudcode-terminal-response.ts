import type * as http from 'node:http';
import type * as http2 from 'node:http2';
import * as zlib from 'node:zlib';

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
 * 1. Decompresses compressed bodies (gzip/deflate/br) into uncompressed text and strips content-encoding.
 * 2. Updates content-length to exact byte length of terminal payload.
 * 3. Frames SSE streams without double-wrapping existing SSE structures.
 * 4. Sets canonical gRPC status and message headers with HTTP 200 for native gRPC requests.
 */
export function formatTerminalDownstreamError(
  req: http.IncomingMessage | http2.Http2ServerRequest | { headers: http.IncomingHttpHeaders },
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  body?: string | Buffer,
): FormattedTerminalError {
  const resultHeaders: http.IncomingHttpHeaders = { ...headers };

  // 1. Detect content-encoding, decompress body if compressed, then strip content-encoding header
  let contentEncoding: string | undefined;
  for (const key of Object.keys(resultHeaders)) {
    if (key.toLowerCase() === 'content-encoding') {
      contentEncoding = String(resultHeaders[key] || '').toLowerCase();
      delete resultHeaders[key];
    }
  }

  let terminalBody: string | Buffer | undefined = body;
  const bodyBuf = Buffer.isBuffer(terminalBody)
    ? terminalBody
    : typeof terminalBody === 'string'
      ? Buffer.from(terminalBody, 'utf-8')
      : undefined;

  if (bodyBuf && bodyBuf.length > 0) {
    const isGzipMagic = bodyBuf.length >= 2 && bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b;
    const enc = contentEncoding || (isGzipMagic ? 'gzip' : '');
    try {
      if (enc.includes('gzip') || isGzipMagic) {
        terminalBody = zlib.gunzipSync(bodyBuf).toString('utf-8');
      } else if (enc.includes('deflate')) {
        terminalBody = zlib.inflateSync(bodyBuf).toString('utf-8');
      } else if (enc.includes('br')) {
        terminalBody = zlib.brotliDecompressSync(bodyBuf).toString('utf-8');
      }
    } catch {
      // Decompression fallback: retain original body if decompression fails
    }
  }

  const reqHeaders = req?.headers || {};
  const reqAccept = String(reqHeaders.accept || '').toLowerCase();
  const reqContentType = String(reqHeaders['content-type'] || '').toLowerCase();
  const resContentType = String(resultHeaders['content-type'] || '').toLowerCase();

  const isSse = reqAccept.includes('text/event-stream') || resContentType.includes('text/event-stream');
  const isGrpc = reqContentType.includes('application/grpc');

  let terminalStatusCode = statusCode;

  if (isGrpc) {
    // Native gRPC error framing: must return HTTP 200 with grpc-status and grpc-message
    terminalStatusCode = 200;
    let grpcStatus = resultHeaders['grpc-status'];
    if (grpcStatus === undefined || String(grpcStatus) === '0') {
      grpcStatus = HTTP_TO_GRPC_STATUS[statusCode] || '13';
      resultHeaders['grpc-status'] = grpcStatus;
    }
    if (!resultHeaders['grpc-message']) {
      resultHeaders['grpc-message'] = String(resultHeaders['grpc-status-details-bin'] || `HTTP_${statusCode}`);
    }
    resultHeaders['content-type'] = 'application/grpc';
    terminalBody = Buffer.alloc(0);
    resultHeaders['content-length'] = '0';
  } else if (isSse) {
    // SSE stream framing: data: {...}\n\n
    let errorPayload: Record<string, unknown> | null = null;
    const rawText = typeof terminalBody === 'string' ? terminalBody : Buffer.isBuffer(terminalBody) ? terminalBody.toString('utf-8') : '';
    const trimmed = rawText.trim();

    if (trimmed.startsWith('data:')) {
      const dataPayload = trimmed.slice(5).trim();
      if (dataPayload.startsWith('{')) {
        try {
          const parsed = JSON.parse(dataPayload);
          if (parsed && typeof parsed === 'object') {
            errorPayload = (parsed as Record<string, unknown>).error
              ? (parsed as Record<string, unknown>)
              : { error: parsed };
          }
        } catch { /* not valid JSON, preserve framing */ }
      }
      if (errorPayload) {
        terminalBody = `data: ${JSON.stringify(errorPayload)}\n\n`;
      } else {
        terminalBody = trimmed.endsWith('\n\n') ? trimmed : `${trimmed}\n\n`;
      }
    } else if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          errorPayload = (parsed as Record<string, unknown>).error
            ? (parsed as Record<string, unknown>)
            : { error: parsed };
        } else {
          errorPayload = { error: { code: statusCode, message: trimmed } };
        }
      } catch {
        errorPayload = { error: { code: statusCode, message: trimmed || 'Error' } };
      }
      terminalBody = `data: ${JSON.stringify(errorPayload)}\n\n`;
    } else {
      errorPayload = {
        error: {
          code: statusCode,
          message: trimmed || `HTTP error ${statusCode}`,
        },
      };
      terminalBody = `data: ${JSON.stringify(errorPayload)}\n\n`;
    }

    resultHeaders['content-type'] = 'text/event-stream; charset=utf-8';
  }

  if (terminalBody !== undefined) {
    const byteLength = typeof terminalBody === 'string' ? Buffer.byteLength(terminalBody, 'utf-8') : terminalBody.length;
    resultHeaders['content-length'] = String(byteLength);
  }

  return {
    statusCode: terminalStatusCode,
    headers: resultHeaders,
    body: terminalBody,
  };
}
