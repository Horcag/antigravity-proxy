import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  logUpstreamFailure,
  maskAccountId,
  extractSanitizedOperation,
  sanitizeLogString,
} from '../../modules/proxy-gateway/server/cloudcode-diagnostics.js';
import type { FailureEvidence } from '../../modules/proxy-gateway/server/upstream-failure.js';

describe('CloudCodeDiagnostics Redaction and Safe Logging', () => {
  it('masks account identifiers securely', () => {
    expect(maskAccountId('short')).toBe('short');
    expect(maskAccountId('12345678')).toBe('12345678');
    expect(maskAccountId('1234567890abcdef')).toBe('12345678...');
    expect(maskAccountId(undefined)).toBe('unknown');
  });

  it('extracts sanitized operation from exact allowlist without query params', () => {
    expect(extractSanitizedOperation('/v1internal:streamGenerateContent?alt=json')).toBe(
      'streamGenerateContent',
    );
    expect(extractSanitizedOperation('/v1/models/gemini-2.5-pro:generateContent')).toBe(
      'generateContent',
    );
    // Unallowed operation or query string lookalike falls back to unknown_operation
    expect(extractSanitizedOperation('/unsafe?next=/v1internal:streamGenerateContent')).toBe(
      'unknown_operation',
    );
    expect(extractSanitizedOperation('/v1internal:deleteSession')).toBe('unknown_operation');
    expect(extractSanitizedOperation(undefined)).toBe('unknown_operation');
  });

  it('scrubs credentials, Bearer tokens, AIza keys, and sentinels', () => {
    const raw = 'Request failed: Bearer secret-token-12345 with AIzaSyDUMMYKEY1234567890 and password=supersecret';
    const scrubbed = sanitizeLogString(raw);
    expect(scrubbed).not.toContain('secret-token-12345');
    expect(scrubbed).not.toContain('AIzaSyDUMMYKEY1234567890');
    expect(scrubbed).not.toContain('supersecret');
    expect(scrubbed).toContain('Bearer [REDACTED]');
    expect(scrubbed).toContain('AIza[REDACTED]');
  });

  it('captures emitted log sink and asserts absence of sentinels in every field', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const SENTINEL_MSG = 'SYNTHETIC_BEARER_TOKEN_DO_NOT_LOG';
    const SENTINEL_ACC = 'SYNTHETIC_ACCOUNT_SECRET_99999';
    const SENTINEL_MODEL = 'SYNTHETIC_MODEL_LEAK';
    const SENTINEL_URL = 'SYNTHETIC_QUERY_PARAM_LEAK';

    const evidence: FailureEvidence = {
      category: 'ambiguous-invalid-argument',
      confidence: 'unknown',
      source: 'http',
      httpStatus: 400,
      rpcStatus: 'INVALID_ARGUMENT',
      ruleId: 'google.generic.invalid-argument',
      safeMessage: `Request rejected; Authorization: Bearer ${SENTINEL_MSG}`,
      isQuota: false,
      rawErrorText: `Internal error: token=${SENTINEL_MSG}`,
    };

    logUpstreamFailure({
      receiptId: 'receipt-safe-1',
      requestId: 'req-safe-1',
      urlPath: `/v1internal:streamGenerateContent?key=${SENTINEL_URL}`,
      accountId: `acc-${SENTINEL_ACC}`,
      attempt: 1,
      maxAttempts: 5,
      requestedModel: `model-${SENTINEL_MODEL}`,
      effectiveModel: `model-${SENTINEL_MODEL}`,
      quotaHeaderMode: 'with-quota-header',
      evidence,
      action: { kind: 'migrate-account', reason: 'ambiguity-probe' },
      downstreamCommitted: false,
    });

    expect(warnSpy).toHaveBeenCalled();
    const emittedLog = warnSpy.mock.calls[0][0] as string;

    // None of the sentinels should appear anywhere in the raw emitted log text!
    expect(emittedLog).not.toContain(SENTINEL_MSG);
    expect(emittedLog).not.toContain(SENTINEL_ACC);
    expect(emittedLog).not.toContain(SENTINEL_MODEL);
    expect(emittedLog).not.toContain(SENTINEL_URL);

    // Parse the emitted JSON and verify each individual field
    const jsonMatch = emittedLog.match(/\[UpstreamFailure\]\s*(\{.*\})/);
    expect(jsonMatch).not.toBeNull();
    const payload = JSON.parse(jsonMatch![1]);

    expect(payload.safeMessage).not.toContain(SENTINEL_MSG);
    expect(payload.accountId).not.toContain(SENTINEL_ACC);
    expect(payload.requestedModel).not.toContain(SENTINEL_MODEL);
    expect(payload.operation).toBe('streamGenerateContent');

    warnSpy.mockRestore();
  });
});
