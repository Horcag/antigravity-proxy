import type http from 'node:http';
import { logger } from '../../../shared/logging/logger';
import type { AccountLeaseService } from './account-lease.service';
import { RateLimitReason } from './rate-limit-tracker';
import type { HealthEffect } from './upstream-retry-decision';
import type { FailureEvidence } from './upstream-failure';

export async function recordAccountFailureHealth(input: {
  service: AccountLeaseService; accountId: string; health: HealthEffect;
  evidence: FailureEvidence; status: number; headers: http.IncomingHttpHeaders; model?: string;
}): Promise<void> {
  const { service, accountId, health, evidence, status, headers, model } = input;
  try {
    if (health.kind === 'rate-limited') {
      void service.markFromUpstreamError({ accountIdOrEmail: accountId, status: status >= 400 ? status : 429,
        model, body: evidence.rawErrorText, headers,
        reason: health.isQuota ? RateLimitReason.QuotaExhausted : RateLimitReason.RateLimitExceeded,
      }).catch(() => logger.warn('[CloudCodeGateway] Failed to record account error health effect: health_effect_failed'));
    } else if (health.kind === 'credential-rejected') {
      if (evidence.category === 'account-suspended') await service.suspendAccount(accountId);
      else service.markAsForbidden?.(accountId);
    } else if (health.kind === 'model-unrequestable') {
      service.markModelUnrequestable?.(accountId, health.effectiveModel);
    }
  } catch {
    logger.warn('[CloudCodeGateway] Failed to record account error health effect: health_effect_failed');
  }
}
