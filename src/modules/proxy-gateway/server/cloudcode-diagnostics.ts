import { Logger } from '@nestjs/common';
import type { FailureEvidence } from './upstream-failure.js';
import type { RecoveryAction } from './upstream-retry-decision.js';

const logger = new Logger('CloudCodeDiagnostics');

const ALLOWED_OPERATIONS = new Set([
  'streamGenerateContent',
  'generateContent',
  'countTokens',
  'predict',
  'streamRawPredict',
  'loadModel',
  'loadCodeAssist',
  'fetchUserInfo',
  'fetchAvailableModels',
  'retrieveUserQuota',
  'retrieveUserQuotaSummary',
  'fetchLicenses',
  'fetchCredits',
  'listAgents',
  'listInstances',
  'listAuthorizedDevices',
  'listRemoteRepositories',
  'listCloudAICompanionProjects',
  'listModelConfigs',
  'listExperiments',
  'fetchCodeCustomizationState',
  'fetchAdminControls',
  'getCodeAssistGlobalUserSetting',
  'fetchQuotaStatus',
  'fetchConfig',
  'fetchFromTrawlerCache',
  'recordTrajectoryAnalytics',
  'writeTrajectoryAcls',
  'recordCodeAssistMetrics',
  'recordClientEvent',
  'recordSmartchoicesFeedback',
  'rewriteUri',
  'completeCode',
  'generateChat',
  'streamGenerateChat',
  'generateCode',
  'transformCode',
  'searchSnippets',
]);

export interface LogUpstreamFailureParams {
  receiptId?: string;
  requestId?: string;
  urlPath?: string;
  accountId?: string;
  attempt: number;
  maxAttempts: number;
  requestedModel?: string;
  effectiveModel?: string;
  quotaHeaderMode?: string;
  evidence: FailureEvidence;
  action: RecoveryAction;
  downstreamCommitted: boolean;
}

export function sanitizeLogString(str?: string): string {
  if (!str) return '';
  return str
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{20,}/gi, 'AIza[REDACTED]')
    .replace(
      /(["']?(?:token|secret|key|refresh_token|access_token|authorization|auth|credential|password|cookie|session)["']?\s*[:=]\s*)["']?[^"',\s{}]{6,}["']?/gi,
      '$1"[REDACTED]"',
    )
    .replace(/SYNTHETIC_[A-Za-z0-9_]+/gi, '[REDACTED_SENTINEL]')
    .slice(0, 200)
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

export function maskAccountId(accountId?: string): string {
  if (!accountId) return 'unknown';
  const sanitized = sanitizeLogString(accountId);
  if (sanitized.length <= 8) return sanitized;
  return `${sanitized.slice(0, 8)}...`;
}

export function extractSanitizedOperation(urlPath?: string): string {
  if (!urlPath) return 'unknown_operation';
  try {
    const pathname = new URL(urlPath, 'https://cloudcode.googleapis.com').pathname;
    const colonIdx = pathname.lastIndexOf(':');
    if (colonIdx !== -1) {
      const op = pathname.slice(colonIdx + 1);
      if (ALLOWED_OPERATIONS.has(op)) {
        return op;
      }
    }
  } catch { /* ignore */ }
  return 'unknown_operation';
}

export function sanitizeModelIdentifier(model?: string): string {
  if (!model) return 'unknown';
  const sanitized = sanitizeLogString(model);
  if (/^[a-zA-Z0-9_.:-]{1,64}$/.test(sanitized)) {
    return sanitized;
  }
  return 'invalid_model_identifier';
}

export function logUpstreamFailure(params: LogUpstreamFailureParams): void {
  try {
    const {
      receiptId,
      requestId,
      urlPath,
      accountId,
      attempt,
      maxAttempts,
      requestedModel,
      effectiveModel,
      quotaHeaderMode = 'with-quota-header',
      evidence,
      action,
      downstreamCommitted,
    } = params;

    const payload = {
      event: 'cloudcode_upstream_failure',
      receiptId: sanitizeLogString(receiptId) || 'none',
      requestId: sanitizeLogString(requestId) || 'none',
      operation: extractSanitizedOperation(urlPath),
      accountId: maskAccountId(accountId),
      attempt,
      maxAttempts,
      requestedModel: sanitizeModelIdentifier(requestedModel),
      effectiveModel: sanitizeModelIdentifier(effectiveModel || requestedModel),
      quotaHeaderMode: sanitizeLogString(quotaHeaderMode),
      httpStatus: evidence.httpStatus ?? 0,
      rpcStatus: sanitizeLogString(evidence.rpcStatus) || 'UNKNOWN',
      category: evidence.category,
      ruleId: sanitizeLogString(evidence.ruleId),
      confidence: evidence.confidence,
      safeMessage: sanitizeLogString(evidence.safeMessage),
      action: action.kind,
      downstreamCommitted,
    };

    logger.warn(`[UpstreamFailure] ${JSON.stringify(payload)}`);
  } catch {
    // Fail-safe: diagnostics should never interfere with request lifecycle
  }
}

// Retain transport metadata outside provider payloads and downstream wire objects.
const upstreamDiagnosticContexts = new WeakMap<object, UpstreamDiagnosticContext>();
export interface UpstreamDiagnosticContext {
  requestId: string;
  httpStatus?: number;
}
const TERMINAL_ENUMS = new Set([
  'FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION',
  'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'IMAGE_OTHER',
  'NO_IMAGE', 'MISSING_THOUGHT_SIGNATURE', 'MALFORMED_RESPONSE', 'ESCALATION',
  'PUP_LIMITED_DISABLED',
]);

export function registerUpstreamDiagnosticContext(
  payload: unknown, context: UpstreamDiagnosticContext,
): void {
  if (payload && typeof payload === 'object') upstreamDiagnosticContexts.set(payload, context);
}

export function getUpstreamDiagnosticContext(payload: object): UpstreamDiagnosticContext | undefined {
  return upstreamDiagnosticContexts.get(payload);
}

export function logUpstreamTerminalDiagnostic(
  context: UpstreamDiagnosticContext | undefined,
  event: 'start' | 'http_response' | 'terminal' | 'failure',
  finishReason?: unknown,
): void {
  if (!context) return;
  try {
    // Only server UUIDs and exact known enums enter diagnostics. Unknown strings may
    // contain credentials or content, so neither their bytes nor derivatives are logged.
    const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(context.requestId)
      ? context.requestId : 'invalid_request_id';
    const rawTerminalEnum = finishReason == null || finishReason === '' ? 'ABSENT'
      : typeof finishReason === 'string' && TERMINAL_ENUMS.has(finishReason)
        ? finishReason : 'UNKNOWN_TERMINAL';
    const httpStatus = Number.isInteger(context.httpStatus) && context.httpStatus! >= 100 && context.httpStatus! <= 599
      ? context.httpStatus : null;
    logger.log(`[UpstreamTerminal] ${JSON.stringify({ event, requestId, httpStatus, rawTerminalEnum })}`);
  } catch {
    // Diagnostics must leave the request lifecycle and wire behavior unchanged.
  }
}
