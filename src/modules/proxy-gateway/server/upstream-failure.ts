import * as zlib from 'node:zlib';
import type { IncomingHttpHeaders } from 'node:http';
import { sanitizeLogString } from './cloudcode-diagnostics.js';

export type FailureCategory =
  | 'quota'
  | 'authentication'
  | 'model-capability'
  | 'project-context'
  | 'invalid-request'
  | 'ambiguous-invalid-argument'
  | 'transient'
  | 'unknown';

export interface FailureEvidence {
  category: FailureCategory;
  confidence: 'explicit' | 'heuristic' | 'unknown';
  source: 'http' | 'json' | 'grpc' | 'sse';
  httpStatus?: number;
  rpcStatus?: string;
  ruleId: string;
  safeMessage: string;
  isQuota: boolean;
  rawErrorText?: string;
}

export interface ClassifyFailureOptions {
  statusCode: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  bufferedBody?: Buffer;
  errorText?: string;
  modelName?: string;
  urlPath?: string;
  source?: 'http' | 'json' | 'grpc' | 'sse';
}

export interface DecodedErrorBody {
  text: string;
  truncated: boolean;
  decodeError: boolean;
}

export function safeDecodeErrorBody(
  bufferedBody: Buffer | undefined,
  contentEncoding?: string | string[],
): DecodedErrorBody {
  if (!bufferedBody || bufferedBody.length === 0) {
    return { text: '', truncated: false, decodeError: false };
  }
  const enc = (Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding || '').toLowerCase();
  const maxOutputLength = 65536;
  try {
    let decompressed: Buffer;
    if (enc.includes('gzip')) decompressed = zlib.gunzipSync(bufferedBody, { maxOutputLength });
    else if (enc.includes('deflate')) decompressed = zlib.inflateSync(bufferedBody, { maxOutputLength });
    else if (enc.includes('br')) decompressed = zlib.brotliDecompressSync(bufferedBody, { maxOutputLength });
    else {
      if (bufferedBody.length > maxOutputLength) {
        return { text: bufferedBody.subarray(0, maxOutputLength).toString('utf-8'), truncated: true, decodeError: false };
      }
      return { text: bufferedBody.toString('utf-8'), truncated: false, decodeError: false };
    }
    return { text: decompressed.toString('utf-8'), truncated: decompressed.length >= maxOutputLength, decodeError: false };
  } catch {
    return { text: '', truncated: false, decodeError: true };
  }
}

export function buildSafeErrorMessage(
  category: FailureCategory,
  ruleId: string,
  rpcStatus?: string,
  httpStatus?: number,
  sanitizedDetail?: string,
): string {
  const code = rpcStatus || (httpStatus ? `HTTP_${httpStatus}` : 'UNKNOWN');
  if (sanitizedDetail) {
    const detail = sanitizeLogString(sanitizedDetail).slice(0, 100);
    return `[${ruleId}] ${category.toUpperCase()} (${code}): ${detail}`;
  }
  return `[${ruleId}] ${category.toUpperCase()} (${code})`;
}

function makeEvidence(
  cat: FailureCategory,
  rule: string,
  src: 'http' | 'json' | 'grpc' | 'sse',
  code: number,
  rpc: string,
  msg: string,
  raw: string,
  isQuota = false,
  conf: 'explicit' | 'heuristic' | 'unknown' = 'explicit',
): FailureEvidence {
  return {
    category: cat,
    confidence: conf,
    source: src,
    httpStatus: code,
    rpcStatus: rpc,
    ruleId: rule,
    safeMessage: msg,
    isQuota,
    rawErrorText: raw,
  };
}

export function classifyUpstreamFailure(options: ClassifyFailureOptions): FailureEvidence {
  const { statusCode, headers, bufferedBody, errorText: explicitErrorText, modelName, source = 'http' } = options;

  let errorText = explicitErrorText;
  let decodeError = false;
  if (errorText === undefined) {
    const decoded = safeDecodeErrorBody(bufferedBody, headers['content-encoding']);
    errorText = decoded.text;
    decodeError = decoded.decodeError;
  }

  let rpcStatus: string | undefined;
  let parsedMessage: string | undefined;
  let errorInfoReason: string | undefined;
  let errorInfoDomain: string | undefined;
  let hasFieldViolations = false;
  let hasQuotaViolations = false;

  try {
    const trimmed = errorText.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error && typeof parsed.error === 'object') {
        if (typeof parsed.error.status === 'string') rpcStatus = parsed.error.status;
        if (typeof parsed.error.message === 'string') parsedMessage = parsed.error.message;
        if (Array.isArray(parsed.error.details)) {
          for (const d of parsed.error.details) {
            const type = d['@type'] || '';
            if (type.includes('ErrorInfo')) {
              errorInfoReason = d.reason;
              errorInfoDomain = d.domain;
            } else if (type.includes('BadRequest')) {
              if (Array.isArray(d.fieldViolations) && d.fieldViolations.length > 0) hasFieldViolations = true;
            } else if (type.includes('QuotaFailure')) hasQuotaViolations = true;
          }
        }
      }
    }
  } catch { /* Non-JSON or incomplete body */ }

  const lowerText = errorText.toLowerCase();

  // 1. gRPC status header / trailers
  const grpcHeader = headers['grpc-status'];
  if (grpcHeader !== undefined && String(grpcHeader) !== '0') {
    const code = String(grpcHeader);
    if (code === '8') {
      return makeEvidence('quota', 'google.grpc.resource-exhausted', 'grpc', 429, 'RESOURCE_EXHAUSTED',
        buildSafeErrorMessage('quota', 'google.grpc.resource-exhausted', 'RESOURCE_EXHAUSTED', 429), errorText, true);
    }
    if (code === '14') {
      return makeEvidence('transient', 'google.grpc.unavailable', 'grpc', 503, 'UNAVAILABLE',
        buildSafeErrorMessage('transient', 'google.grpc.unavailable', 'UNAVAILABLE', 503), errorText, false);
    }
    if (code === '16') {
      return makeEvidence('authentication', 'google.grpc.unauthenticated', 'grpc', 401, 'UNAUTHENTICATED',
        buildSafeErrorMessage('authentication', 'google.grpc.unauthenticated', 'UNAUTHENTICATED', 401), errorText, false);
    }
  }

  // 2. Structured AIP-193 details
  if (hasQuotaViolations || errorInfoReason === 'RATE_LIMIT_EXCEEDED' || errorInfoReason === 'RESOURCE_EXHAUSTED') {
    const rpc = rpcStatus || 'RESOURCE_EXHAUSTED';
    return makeEvidence('quota', 'google.aip193.quota-failure', source, statusCode, rpc,
      buildSafeErrorMessage('quota', 'google.aip193.quota-failure', rpc, statusCode, parsedMessage), errorText, true);
  }
  if (errorInfoDomain === 'serviceusage.googleapis.com' || errorInfoReason === 'CONSUMER_INVALID' ||
      errorInfoReason === 'SERVICE_DISABLED' || errorInfoReason === 'USER_PROJECT_DENIED') {
    const rpc = rpcStatus || 'PERMISSION_DENIED';
    return makeEvidence('project-context', 'google.aip193.project-context', source, statusCode, rpc,
      buildSafeErrorMessage('project-context', 'google.aip193.project-context', rpc, statusCode, parsedMessage), errorText, false);
  }
  if (hasFieldViolations) {
    const rpc = rpcStatus || 'INVALID_ARGUMENT';
    return makeEvidence('invalid-request', 'google.aip193.bad-request', source, statusCode, rpc,
      buildSafeErrorMessage('invalid-request', 'google.aip193.bad-request', rpc, statusCode, parsedMessage), errorText, false);
  }
  if (errorInfoReason === 'MODEL_NOT_FOUND' || errorInfoReason === 'MODEL_DEPRECATED') {
    const rpc = rpcStatus || 'NOT_FOUND';
    return makeEvidence('model-capability', 'google.aip193.model-not-found', source, statusCode, rpc,
      buildSafeErrorMessage('model-capability', 'google.aip193.model-not-found', rpc, statusCode, modelName), errorText, false);
  }

  // 3. Invalid Request (Evaluated BEFORE model check & quota check)
  const isInvalidRequest =
    statusCode === 413 ||
    /thought.*signature|signature.*required/i.test(errorText) ||
    /image.*corrupt|unsupported.*mime|image.*decode|failed to decode image/i.test(errorText) ||
    /file.*resource.*not found|cachedcontent.*not found|resource '?(?:files|cachedcontents)\//i.test(errorText) ||
    (rpcStatus === 'INVALID_ARGUMENT' && /field.*violation|syntax.*error|malformed json|unexpected token/i.test(errorText));
  if (isInvalidRequest) {
    const rpc = rpcStatus || 'INVALID_ARGUMENT';
    return makeEvidence('invalid-request', 'google.request.invalid', source, statusCode, rpc,
      buildSafeErrorMessage('invalid-request', 'google.request.invalid', rpc, statusCode, parsedMessage), errorText, false);
  }

  // 4. Project Context Failure (Evaluated BEFORE quota check)
  const isProject =
    (statusCode === 400 || statusCode === 403) && (
      lowerText.includes('x-goog-user-project') ||
      lowerText.includes('serviceusage.services.use') ||
      lowerText.includes('quota project') ||
      lowerText.includes('consumer project') ||
      lowerText.includes('caller project') ||
      lowerText.includes('permission to use this quota project') ||
      (statusCode === 403 && lowerText.includes('permission_denied') && lowerText.includes('project'))
    );
  if (isProject) {
    const rpc = rpcStatus || 'PERMISSION_DENIED';
    return makeEvidence('project-context', 'google.project.context-rejected', source, statusCode, rpc,
      buildSafeErrorMessage('project-context', 'google.project.context-rejected', rpc, statusCode, parsedMessage), errorText, false);
  }

  // 5. Quota / Rate limit (Excludes quota project permission denial)
  const isQuota =
    statusCode === 429 ||
    rpcStatus === 'RESOURCE_EXHAUSTED' ||
    lowerText.includes('individual quota reached') ||
    lowerText.includes('exhausted your quota') ||
    lowerText.includes('quota exceeded') ||
    ((statusCode === 403 || source === 'sse' || source === 'json') && (
      lowerText.includes('resource_exhausted') ||
      lowerText.includes('rate limit') ||
      lowerText.includes('credit') ||
      lowerText.includes('quota')
    ));
  if (isQuota) {
    const rpc = rpcStatus || 'RESOURCE_EXHAUSTED';
    const finalStatus = statusCode === 200 || !statusCode ? 429 : statusCode;
    return makeEvidence('quota', 'google.quota.exhausted', source, finalStatus, rpc,
      buildSafeErrorMessage('quota', 'google.quota.exhausted', rpc, finalStatus, parsedMessage), errorText, true);
  }

  // 6. Model Capability / Incompatibility (Explicit model identification only)
  const isModelIncompatible =
    Boolean(modelName) &&
    (statusCode === 400 || statusCode === 404) &&
    (
      new RegExp(`models/${modelName}.*(?:not found|is not supported|does not exist)`, 'i').test(errorText) ||
      new RegExp(`model ['"]?${modelName}['"]?.*(?:not found|is not supported|does not exist)`, 'i').test(errorText) ||
      /unsupported model|model not supported|model does not exist/i.test(errorText) ||
      (statusCode === 404 && /model.*not found/i.test(errorText))
    );
  if (isModelIncompatible) {
    const rpc = rpcStatus || 'NOT_FOUND';
    return makeEvidence('model-capability', 'google.model.incompatible', source, statusCode, rpc,
      buildSafeErrorMessage('model-capability', 'google.model.incompatible', rpc, statusCode, modelName), errorText, false, 'heuristic');
  }

  // 7. Authentication Failure
  const isAuth =
    statusCode === 401 ||
    (statusCode === 403 && (
      rpcStatus === 'UNAUTHENTICATED' ||
      lowerText.includes('unauthenticated') ||
      lowerText.includes('invalid credential') ||
      lowerText.includes('token expired') ||
      lowerText.includes('invalid_grant')
    ));
  if (isAuth) {
    const rpc = rpcStatus || 'UNAUTHENTICATED';
    return makeEvidence('authentication', 'google.auth.invalid-credentials', source, statusCode, rpc,
      buildSafeErrorMessage('authentication', 'google.auth.invalid-credentials', rpc, statusCode), errorText, false);
  }

  // 8. Ambiguous 400 INVALID_ARGUMENT (only when body was cleanly parsed)
  if (statusCode === 400 && !decodeError) {
    const rpc = rpcStatus || 'INVALID_ARGUMENT';
    return makeEvidence('ambiguous-invalid-argument', 'google.generic.invalid-argument', source, statusCode, rpc,
      buildSafeErrorMessage('ambiguous-invalid-argument', 'google.generic.invalid-argument', rpc, statusCode), errorText, false, 'unknown');
  }

  // 9. Transient / Network / Decoding error
  if (statusCode === 503 || statusCode === 504 || statusCode === 408 || rpcStatus === 'UNAVAILABLE' || decodeError) {
    const rpc = rpcStatus || 'UNAVAILABLE';
    const rule = decodeError ? 'google.transient.decode-error' : 'google.transient.unavailable';
    return makeEvidence('transient', rule, source, statusCode, rpc,
      buildSafeErrorMessage('transient', rule, rpc, statusCode), errorText, false, decodeError ? 'unknown' : 'explicit');
  }

  // 10. Fallback
  return makeEvidence('unknown', 'google.unknown.error', source, statusCode, rpcStatus || 'UNKNOWN',
    buildSafeErrorMessage('unknown', 'google.unknown.error', rpcStatus, statusCode), errorText, false, 'unknown');
}
