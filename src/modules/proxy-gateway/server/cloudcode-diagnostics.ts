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
  'fetchAvailableModels',
  'retrieveUserQuotaSummary',
  'fetchCredits',
  'listCloudAICompanionProjects',
  'listModelConfigs',
  'listExperiments',
  'fetchCodeCustomizationState',
  'fetchAdminControls',
  'getCodeAssistGlobalUserSetting',
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
