import type * as http from 'node:http';
import type * as http2 from 'node:http2';
import * as zlib from 'node:zlib';

export interface FormattedTerminalError {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string | Buffer | undefined;
  trailers?: Record<string, string>;
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

const MAX_TERMINAL_DECOMPRESS_BYTES = 1024 * 1024; // 1MB limit

/**
 * Format terminal downstream error headers and payload consistency:
 * 1. Decompresses compressed bodies (gzip/deflate/br) into uncompressed text and strips content-encoding.
 * 2. Updates content-length to exact byte length of terminal payload.
 * 3. Frames SSE streams without double-wrapping existing SSE structures.
 * 4. Sets canonical gRPC status and message trailers with HTTP 200 for native gRPC requests.
 */
export function formatTerminalDownstreamError(
  req: http.IncomingMessage | http2.Http2ServerRequest | { headers: http.IncomingHttpHeaders },
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  body?: string | Buffer,
): FormattedTerminalError {
  const resultHeaders: http.IncomingHttpHeaders = { ...headers };

  // 1. Detect content-encoding and body buffer without premature header deletion
  let contentEncodingKey: string | undefined;
  let contentEncoding: string | undefined;
  for (const key of Object.keys(resultHeaders)) {
    if (key.toLowerCase() === 'content-encoding') {
      contentEncodingKey = key;
      contentEncoding = String(resultHeaders[key] || '').toLowerCase();
      break;
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
    const isDeflateMagic = bodyBuf.length >= 2 && (bodyBuf[0] === 0x78 || bodyBuf[0] === 0x58);
    const isAlreadyPlaintext =
      bodyBuf.length > 0 &&
      (bodyBuf[0] === 0x7b || bodyBuf[0] === 0x5b || bodyBuf.toString('utf-8', 0, 5).startsWith('data:'));

    if (isAlreadyPlaintext && !isGzipMagic && !isDeflateMagic) {
      if (contentEncodingKey) delete resultHeaders[contentEncodingKey];
      delete resultHeaders['content-length'];
      terminalBody = bodyBuf.toString('utf-8');
    } else {
      const enc = contentEncoding || (isGzipMagic ? 'gzip' : '');
      if (enc) {
        try {
          let decompressed: Buffer;
          if (enc.includes('gzip') || isGzipMagic) {
            decompressed = zlib.gunzipSync(bodyBuf, { maxOutputLength: MAX_TERMINAL_DECOMPRESS_BYTES });
          } else if (enc.includes('deflate')) {
            decompressed = zlib.inflateSync(bodyBuf, { maxOutputLength: MAX_TERMINAL_DECOMPRESS_BYTES });
          } else if (enc.includes('br')) {
            decompressed = zlib.brotliDecompressSync(bodyBuf, { maxOutputLength: MAX_TERMINAL_DECOMPRESS_BYTES });
          } else {
            decompressed = bodyBuf;
          }
          terminalBody = decompressed.toString('utf-8');
          if (contentEncodingKey) delete resultHeaders[contentEncodingKey];
          delete resultHeaders['content-length'];
        } catch {
          // Decompression failed (corrupt gzip, truncated, or exceeded 1MB limit).
          // NEVER emit raw corrupt/truncated compressed bytes as plaintext JSON!
          // Synthesize a safe, well-formed JSON error:
          if (contentEncodingKey) delete resultHeaders[contentEncodingKey];
          delete resultHeaders['content-length'];
          resultHeaders['content-type'] = 'application/json; charset=utf-8';
          terminalBody = JSON.stringify({
            error: {
              code: statusCode,
              message: 'Upstream error response could not be decoded',
              status: 'BAD_GATEWAY',
            },
          });
        }
      }
    }
  }

  const reqHeaders = req?.headers || {};
  const reqAccept = String(reqHeaders.accept || '').toLowerCase();
  const reqContentType = String(reqHeaders['content-type'] || '').toLowerCase();
  const resContentType = String(resultHeaders['content-type'] || '').toLowerCase();

  const isSse = reqAccept.includes('text/event-stream') || resContentType.includes('text/event-stream');
  const isGrpc = reqContentType.includes('application/grpc');

  let terminalStatusCode = statusCode;
  let trailers: Record<string, string> | undefined;

  if (isGrpc) {
    // Native gRPC error framing: must return HTTP 200 with grpc-status and grpc-message in trailers
    terminalStatusCode = 200;
    let grpcStatus = resultHeaders['grpc-status'];
    if (grpcStatus === undefined || String(grpcStatus) === '0') {
      grpcStatus = HTTP_TO_GRPC_STATUS[statusCode] || '13';
    }
    let grpcMessage = resultHeaders['grpc-message'];
    if (!grpcMessage) {
      grpcMessage = String(resultHeaders['grpc-status-details-bin'] || `HTTP_${statusCode}`);
    }
    resultHeaders['content-type'] = 'application/grpc';
    resultHeaders['content-length'] = '0';
    delete resultHeaders['grpc-status'];
    delete resultHeaders['grpc-message'];
    terminalBody = Buffer.alloc(0);
    trailers = {
      'grpc-status': String(grpcStatus),
      'grpc-message': String(grpcMessage),
    };
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

  if (terminalBody !== undefined && !isGrpc) {
    const byteLength = typeof terminalBody === 'string' ? Buffer.byteLength(terminalBody, 'utf-8') : terminalBody.length;
    resultHeaders['content-length'] = String(byteLength);
  }

  return {
    statusCode: terminalStatusCode,
    headers: resultHeaders,
    body: terminalBody,
    trailers,
  };
}

export function resolveHasAlternativeAccounts(
  accountLeaseService: unknown,
  account: { id: string } | null | undefined,
  attemptedAccountIds: Set<string>,
  attempt: number,
  maxAttempts: number,
): boolean {
  const service = accountLeaseService as {
    getUsableAccountCount?: () => number;
    getQuotaDiagnostics?: () => { accounts?: unknown[] };
  } | undefined;
  const totalAccounts = typeof service?.getUsableAccountCount === 'function'
    ? service.getUsableAccountCount()
    : typeof service?.getQuotaDiagnostics === 'function'
      ? service.getQuotaDiagnostics()?.accounts?.length
      : undefined;
  const attemptedCount = account && !attemptedAccountIds.has(account.id) ? attemptedAccountIds.size + 1 : attemptedAccountIds.size;
  return totalAccounts !== undefined
    ? totalAccounts > attemptedCount && attempt < maxAttempts
    : attempt < maxAttempts;
}
