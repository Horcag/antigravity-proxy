import type { MigrationAuthorizationReason } from './cache-affinity-coordinator.js';
import type { FailureEvidence } from './upstream-failure.js';

export type RecoveryAction =
  | { kind: 'commit-error' }
  | { kind: 'retry-same-account'; repair: 'project-context' | 'model-alias' }
  | { kind: 'migrate-account'; reason: MigrationAuthorizationReason }
  | { kind: 'retry-transient' };

export type HealthEffect =
  | { kind: 'none' }
  | { kind: 'model-unrequestable'; effectiveModel: string }
  | { kind: 'project-capability-rejected' }
  | { kind: 'credential-rejected' }
  | { kind: 'rate-limited'; isQuota: boolean };

export interface RetryDecisionResult {
  action: RecoveryAction;
  healthEffect: HealthEffect;
}

export interface EvaluateRetryParams {
  evidence: FailureEvidence;
  attempt: number;
  maxAttempts: number;
  downstreamCommitted: boolean;
  isReplaySafe: boolean;
  ambiguityProbesUsed: number;
  maxAmbiguityProbes?: number;
  projectCorrectionsUsed: number;
  maxProjectCorrections?: number;
  quotaHeaderMode?: 'with-quota-header' | 'without-quota-header';
  hasAlternativeAccounts: boolean;
  effectiveModel?: string;
}

function deriveTerminalHealthEffect(evidence: FailureEvidence, effectiveModel?: string): HealthEffect {
  switch (evidence.category) {
    case 'quota':
      return { kind: 'rate-limited', isQuota: evidence.isQuota };
    case 'authentication':
      return { kind: 'credential-rejected' };
    case 'model-capability':
      return { kind: 'model-unrequestable', effectiveModel: effectiveModel || '' };
    case 'project-context':
      return { kind: 'project-capability-rejected' };
    default:
      return { kind: 'none' };
  }
}

export function evaluateRetryDecision(params: EvaluateRetryParams): RetryDecisionResult {
  const {
    evidence,
    attempt,
    maxAttempts,
    downstreamCommitted,
    isReplaySafe,
    ambiguityProbesUsed,
    maxAmbiguityProbes = 1,
    projectCorrectionsUsed,
    maxProjectCorrections = 1,
    quotaHeaderMode = 'with-quota-header',
    hasAlternativeAccounts,
    effectiveModel,
  } = params;

  // Invariant 1: If response was already committed downstream, never retry or splice streams
  if (downstreamCommitted) {
    return {
      action: { kind: 'commit-error' },
      healthEffect: { kind: 'none' },
    };
  }

  // Invariant 2: If attempt budget is exhausted, commit terminal error with applicable health effect
  if (attempt >= maxAttempts) {
    return {
      action: { kind: 'commit-error' },
      healthEffect: deriveTerminalHealthEffect(evidence, effectiveModel),
    };
  }

  // Invariant 3: Universal replay guard (R5). Non-replay-safe operations must never be retried.
  if (!isReplaySafe) {
    return {
      action: { kind: 'commit-error' },
      healthEffect: deriveTerminalHealthEffect(evidence, effectiveModel),
    };
  }

  switch (evidence.category) {
    case 'quota':
      return {
        action: hasAlternativeAccounts
          ? { kind: 'migrate-account', reason: evidence.isQuota ? 'quota-exhausted' : 'account-cooldown' }
          : { kind: 'commit-error' },
        healthEffect: { kind: 'rate-limited', isQuota: evidence.isQuota },
      };

    case 'authentication':
      return {
        action: hasAlternativeAccounts
          ? { kind: 'migrate-account', reason: 'authentication-failure' }
          : { kind: 'commit-error' },
        healthEffect: { kind: 'credential-rejected' },
      };

    case 'model-capability':
      return {
        action: hasAlternativeAccounts
          ? { kind: 'migrate-account', reason: 'model-incompatible' }
          : { kind: 'commit-error' },
        healthEffect: { kind: 'model-unrequestable', effectiveModel: effectiveModel || '' },
      };

    case 'project-context':
      if (quotaHeaderMode === 'with-quota-header' && projectCorrectionsUsed < maxProjectCorrections) {
        return {
          action: { kind: 'retry-same-account', repair: 'project-context' },
          healthEffect: { kind: 'none' },
        };
      }
      if (hasAlternativeAccounts) {
        return {
          action: { kind: 'migrate-account', reason: 'project-rejected' },
          healthEffect: { kind: 'project-capability-rejected' },
        };
      }
      return {
        action: { kind: 'commit-error' },
        healthEffect: { kind: 'project-capability-rejected' },
      };

    case 'ambiguous-invalid-argument':
      // One guarded alternate-account probe for ambiguous 400 when replay-safe and alternative exists
      if (ambiguityProbesUsed < maxAmbiguityProbes && hasAlternativeAccounts) {
        return {
          action: { kind: 'migrate-account', reason: 'ambiguity-probe' },
          healthEffect: { kind: 'none' }, // Crucial: zero account penalty for ambiguous 400!
        };
      }
      return {
        action: { kind: 'commit-error' },
        healthEffect: { kind: 'none' },
      };

    case 'invalid-request':
      // Explicit client errors are deterministic and not fixable across accounts
      return {
        action: { kind: 'commit-error' },
        healthEffect: { kind: 'none' },
      };

    case 'transient':
      return {
        action: hasAlternativeAccounts
          ? { kind: 'migrate-account', reason: 'upstream-transient' }
          : { kind: 'retry-transient' },
        healthEffect: { kind: 'none' },
      };

    default:
      return {
        action: { kind: 'commit-error' },
        healthEffect: { kind: 'none' },
      };
  }
}
