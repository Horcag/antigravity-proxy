import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const REPLAY_SAFE_POST_ACTIONS = new Set([
  ':streamGenerateContent',
  ':generateContent',
  ':predict',
  ':streamRawPredict',
  ':countTokens',
]);

export interface ComposeAttemptOptions {
  rawBody: Buffer;
  reqHeaders: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  targetHost: string;
  method: string;
  urlPath: string;
  requestedModel?: string;
  effectiveModel?: string;
  routingProject?: string;
  quotaHeaderMode: 'with-quota-header' | 'without-quota-header';
  accessToken?: string;
  attempt: number;
  isProjectless?: boolean;
}

export function isReplaySafeOperation(
  method: string,
  urlPath: string,
  options?: { hasAccountPinnedResources?: boolean },
): boolean {
  if (options?.hasAccountPinnedResources) return false;
  const m = method.toUpperCase();
  let pathname = '';
  try {
    pathname = new URL(urlPath, 'https://cloudcode.googleapis.com').pathname;
  } catch {
    return false;
  }

  if (m === 'POST') {
    for (const action of REPLAY_SAFE_POST_ACTIONS) {
      if (pathname.endsWith(action)) return true;
    }
    return false;
  }

  if (m === 'GET') {
    if (pathname === '/v1/models' || pathname === '/v1beta/models' || pathname === '/v1internal/models') {
      return true;
    }
    return /^\/v1(?:beta|internal)?\/models\/[a-zA-Z0-9_.-]+$/.test(pathname);
  }

  return false;
}

export function validateAndExtractRequestModel(
  urlPath: string,
  body?: unknown,
): { valid: boolean; model?: string; error?: string } {
  const urlMatch = urlPath.match(/\/models\/([^/:]+)/);
  const urlModel = urlMatch?.[1]?.trim() || undefined;

  let rootModel: string | undefined;
  let nestedModel: string | undefined;
  if (body && typeof body === 'object') {
    const anyBody = body as any;
    if (typeof anyBody.model === 'string' && anyBody.model.trim()) rootModel = anyBody.model.trim();
    if (anyBody.request && typeof anyBody.request === 'object' && typeof anyBody.request.model === 'string') {
      nestedModel = anyBody.request.model.trim() || undefined;
    }
  }

  if (rootModel && nestedModel && rootModel !== nestedModel) {
    return { valid: false, error: `Conflicting model selectors: root "${rootModel}" does not match nested "${nestedModel}"` };
  }
  const bodyModel = rootModel || nestedModel;
  if (urlModel && bodyModel && urlModel !== bodyModel) {
    return { valid: false, error: `Conflicting model selectors: URL model "${urlModel}" does not match body model "${bodyModel}"` };
  }
  return { valid: true, model: bodyModel || urlModel || undefined };
}

export function extractModelName(urlPath: string, body?: unknown): string | undefined {
  return validateAndExtractRequestModel(urlPath, body).model;
}

export function decompressBody(buffer: Buffer, contentEncoding?: string | string[]): { text: string; error?: boolean } {
  if (!buffer || buffer.length === 0) return { text: '' };
  const enc = (Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return { text: zlib.gunzipSync(buffer, { maxOutputLength: 10 * 1024 * 1024 }).toString('utf-8') };
    if (enc.includes('deflate')) return { text: zlib.inflateSync(buffer, { maxOutputLength: 10 * 1024 * 1024 }).toString('utf-8') };
    if (enc.includes('br')) return { text: zlib.brotliDecompressSync(buffer, { maxOutputLength: 10 * 1024 * 1024 }).toString('utf-8') };
    return { text: buffer.toString('utf-8') };
  } catch {
    return { text: '', error: true };
  }
}

export function preflightValidateJsonRequest(
  rawBody: Buffer,
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  urlPath: string,
): { valid: boolean; error?: string; parsedBody?: any; decodedText?: string; hasAccountPinnedResources?: boolean } {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const isJson = contentType.includes('application/json') || urlPath.includes(':') || urlPath.includes('/models/');
  if (!isJson || rawBody.length === 0) return { valid: true };

  const decomp = decompressBody(rawBody, headers['content-encoding']);
  if (decomp.error) return { valid: false, error: 'Malformed or unsupported compressed request body' };

  try {
    const parsed = JSON.parse(decomp.text);
    if (!parsed || typeof parsed !== 'object') return { valid: false, error: 'Malformed JSON root element' };

    const modelValidation = validateAndExtractRequestModel(urlPath, parsed);
    if (!modelValidation.valid) {
      return { valid: false, error: modelValidation.error };
    }

    const hasAccountPinned = Boolean(
      parsed.cachedContent ||
      (parsed.request && typeof parsed.request === 'object' && parsed.request.cachedContent)
    );

    return { valid: true, parsedBody: parsed, decodedText: decomp.text, hasAccountPinnedResources: hasAccountPinned };
  } catch {
    return { valid: false, error: 'Malformed JSON syntax in request body' };
  }
}

export function rewriteJsonPayloadLossless(
  rawJsonText: string,
  edits: {
    model?: string;
    routingProject?: string;
    isProjectless?: boolean;
  },
): string {
  const rawNums: string[] = [];
  const token = crypto.randomUUID().replace(/-/g, '');
  const reviver = function (this: unknown, _k: string, v: unknown, ctx?: { source?: string }): unknown {
    if (typeof v === 'number' && ctx?.source !== undefined) {
      if (!Number.isSafeInteger(v) || ctx.source !== String(v)) {
        const id = rawNums.length;
        rawNums.push(ctx.source);
        return `__RAW_NUM_${token}_${id}__`;
      }
    }
    return v;
  };
  const parsed = (JSON.parse as any)(rawJsonText, reviver);

  if (edits.model) {
    if ('model' in parsed) {
      parsed.model = edits.model;
    }
    if (parsed.request && typeof parsed.request === 'object' && 'model' in parsed.request) {
      parsed.request.model = edits.model;
    }
  }

  if (edits.isProjectless) {
    if ('project' in parsed) delete parsed.project;
    if (parsed.request && typeof parsed.request === 'object' && 'project' in parsed.request) delete parsed.request.project;
  } else if (edits.routingProject) {
    if ('project' in parsed) {
      parsed.project = edits.routingProject;
    }
    if (parsed.request && typeof parsed.request === 'object' && 'project' in parsed.request) {
      parsed.request.project = edits.routingProject;
    }
  }

  let serialized = JSON.stringify(parsed);
  for (let i = 0; i < rawNums.length; i++) {
    serialized = serialized.replace(`"__RAW_NUM_${token}_${i}__"`, rawNums[i]);
  }
  return serialized;
}

export function composeAttemptRequest(options: ComposeAttemptOptions): {
  urlPath: string;
  headers: Record<string, string>;
  payloadToSend: Buffer;
} {
  const {
    rawBody,
    reqHeaders,
    targetHost,
    method,
    urlPath,
    requestedModel,
    effectiveModel,
    routingProject,
    quotaHeaderMode,
    accessToken,
    attempt,
    isProjectless,
  } = options;

  let resolvedUrlPath = urlPath;
  if (effectiveModel && effectiveModel !== requestedModel && resolvedUrlPath.includes('/models/')) {
    resolvedUrlPath = resolvedUrlPath.replace(/\/models\/([^/:]+)/, `/models/${effectiveModel}`);
  }

  let payloadToSend = rawBody;
  const contentEncoding = (Array.isArray(reqHeaders['content-encoding'])
    ? reqHeaders['content-encoding'][0]
    : reqHeaders['content-encoding'] || '').toLowerCase();

  const needsModelEdit = Boolean(effectiveModel && effectiveModel !== requestedModel);
  const needsProjectEdit = Boolean(routingProject || isProjectless);

  const rawContentType = (Array.isArray(reqHeaders['content-type'])
    ? reqHeaders['content-type'][0]
    : reqHeaders['content-type'] || '').toLowerCase();
  const isJson = rawContentType.includes('application/json') || (!rawContentType && (urlPath.includes(':') || urlPath.includes('/models/')));

  if (isJson && (needsModelEdit || needsProjectEdit) && rawBody.length > 0) {
    const decomp = decompressBody(rawBody, contentEncoding);
    if (!decomp.error && decomp.text) {
      try {
        const rewritten = rewriteJsonPayloadLossless(decomp.text, {
          model: needsModelEdit ? effectiveModel : undefined,
          routingProject: isProjectless ? undefined : routingProject,
          isProjectless,
        });

        const utfBuf = Buffer.from(rewritten, 'utf-8');
        if (contentEncoding.includes('gzip')) {
          payloadToSend = zlib.gzipSync(utfBuf);
        } else if (contentEncoding.includes('deflate')) {
          payloadToSend = zlib.deflateSync(utfBuf);
        } else if (contentEncoding.includes('br')) {
          payloadToSend = zlib.brotliCompressSync(utfBuf);
        } else {
          payloadToSend = utfBuf;
        }
      } catch {
        payloadToSend = rawBody;
      }
    }
  }

  const upstreamHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (!key.startsWith(':') && key.toLowerCase() !== 'host') {
      if (Array.isArray(value)) upstreamHeaders[key] = value.join(', ');
      else if (value !== undefined) upstreamHeaders[key] = String(value);
    }
  }

  upstreamHeaders['host'] = targetHost;
  delete upstreamHeaders['transfer-encoding'];
  delete upstreamHeaders['connection'];
  delete upstreamHeaders['proxy-connection'];
  delete upstreamHeaders['proxy-authorization'];
  delete upstreamHeaders['te'];
  delete upstreamHeaders['keep-alive'];
  delete upstreamHeaders['upgrade'];
  delete upstreamHeaders['x-ag-proxy-session-id'];
  delete upstreamHeaders['x-goog-session-id'];

  const connHeader = reqHeaders['connection'];
  if (typeof connHeader === 'string') {
    for (const h of connHeader.split(',').map((s) => s.trim().toLowerCase())) {
      delete upstreamHeaders[h];
    }
  }

  const upperMethod = method.toUpperCase();
  if (payloadToSend.length > 0 || upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH') {
    upstreamHeaders['content-length'] = String(payloadToSend.length);
  }

  if (accessToken) {
    for (const key of Object.keys(upstreamHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'x-goog-api-key' || lower === 'authorization') {
        delete upstreamHeaders[key];
      }
    }
    upstreamHeaders['authorization'] = `Bearer ${accessToken}`;
  } else if (attempt === 1 && reqHeaders['authorization']) {
    upstreamHeaders['authorization'] = String(reqHeaders['authorization']);
  }

  if (quotaHeaderMode === 'with-quota-header' && routingProject) {
    upstreamHeaders['x-goog-user-project'] = routingProject;
  } else {
    delete upstreamHeaders['x-goog-user-project'];
  }

  return {
    urlPath: resolvedUrlPath,
    headers: upstreamHeaders,
    payloadToSend,
  };
}

export function extractCanonicalUserTurnText(turn: unknown): string | null {
  if (!turn || typeof turn !== 'object') return null;
  const anyTurn = turn as any;
  if (typeof anyTurn.content === 'string' && anyTurn.content.trim()) return anyTurn.content.trim();
  const parts = Array.isArray(anyTurn.content) ? anyTurn.content : Array.isArray(anyTurn.parts) ? anyTurn.parts : null;
  if (parts) {
    const texts = parts.map((p: any) => typeof p?.text === 'string' ? p.text.trim() : '').filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

const formatSession = (v: string): string => {
  const t = v.trim();
  return t.startsWith('hint:') || t.startsWith('session:') ? t : `session:${t}`;
};

export function extractSessionKey(
  req: { headers: Record<string, string | string[] | undefined> },
  parsedBody?: Record<string, unknown> | null,
): string | undefined {
  const h = req.headers;
  const candidate = h['x-ag-proxy-session-id'] || h['x-session-id'] || h['x-conversation-id'] ||
    h['x-cloudcode-session-id'] || h['session-id'] || h['conversation-id'] || h['x-goog-session-id'];
  if (typeof candidate === 'string' && candidate.trim()) return formatSession(candidate);
  if (Array.isArray(candidate) && candidate[0]?.trim()) return formatSession(candidate[0]);
  if (parsedBody && typeof parsedBody === 'object') {
    const b = parsedBody as any;
    const meta = b.metadata as any;
    const reqObj = b.request as any;
    const bodyCand = b.sessionId ?? b.session_id ?? b.conversationId ?? b.conversation_id ?? b.sessionKey ??
      meta?.sessionId ?? meta?.session_id ?? meta?.conversationId ?? meta?.conversation_id ??
      reqObj?.sessionId ?? reqObj?.session_id ?? reqObj?.conversationId ?? reqObj?.conversation_id;
    if (typeof bodyCand === 'string' && bodyCand.trim()) return formatSession(bodyCand);
    const turns = (Array.isArray(b.contents) ? b.contents : b.messages) ??
      (Array.isArray(reqObj?.contents) ? reqObj.contents : reqObj?.messages);
    if (Array.isArray(turns) && turns.length > 0) {
      const userTurn = turns.find((c: any) => c?.role === 'user' || !c?.role);
      const text = extractCanonicalUserTurnText(userTurn);
      if (text) return `hint:prefix:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
    }
  }
  return undefined;
}
