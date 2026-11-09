import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AttemptRecord } from './request-history';
import { safeLabel, nullableCount, errorCategory } from './metadata';

export interface RequestObservation {
  request_id: string;
  requested_model?: string;
  effective_model?: string;
  account_id?: string;
  attempts: AttemptRecord[];
  ttft_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_tokens?: number | null;
  upstream_failed?: boolean;
  finished: boolean;
}
const observations = new AsyncLocalStorage<RequestObservation>();
export function createRequestObservation(): RequestObservation { return { request_id: randomUUID(), attempts: [], finished: false }; }
export function runWithRequestObservation<T>(observation: RequestObservation, work: () => T): T { return observations.run(observation, work); }
export function getRequestObservation(): RequestObservation | undefined { return observations.getStore(); }

export function observeSelectedAccount(accountId: string): void {
  const context = observations.getStore();
  if (!context || context.finished) return;
  context.account_id = safeLabel(accountId);
  context.attempts.push({ account_id: context.account_id, outcome: 'unknown' });
}
export function observeAttemptStart(accountId: string | undefined, model: string | undefined): void {
  const context = observations.getStore();
  if (!context || context.finished || !accountId) return;
  const current = context.attempts.at(-1);
  if (!current || current.account_id !== accountId || current.outcome !== 'unknown') observeSelectedAccount(accountId);
  context.effective_model = safeLabel(model, '') || undefined;
  const attempt = context.attempts.at(-1);
  if (attempt) attempt.effective_model = context.effective_model;
}
export function observeAccountOutcome(accountId: string, model: string | undefined, outcome: 'success' | 'failure', ttftMs?: number, status?: number): void {
  const context = observations.getStore();
  if (!context || context.finished) return;
  const attempt = context.attempts.at(-1);
  // Performance callbacks are idempotent for an acquired account; only selection/start creates a new attempt.
  if (!attempt || attempt.account_id !== accountId) observeSelectedAccount(accountId);
  const selected = context.attempts.at(-1)!;
  if (selected.outcome !== 'unknown') return;
  selected.outcome = outcome;
  selected.effective_model = safeLabel(model, '') || selected.effective_model || null;
  selected.error_category = outcome === 'failure' ? errorCategory(status ?? 502) : null;
  selected.ttft_ms = typeof ttftMs === 'number' && Number.isFinite(ttftMs) ? Math.max(0, Math.round(ttftMs)) : null;
  context.effective_model = selected.effective_model ?? undefined;
  if (outcome === 'success') context.ttft_ms = selected.ttft_ms;
}

/** Read numeric usage fields only, retaining no payload text or response structure. */
export function observeResponseUsage(payload: unknown): void {
  const context = observations.getStore();
  if (!context || context.finished || !payload || typeof payload !== 'object') return;
  const object = payload as Record<string, unknown>;
  const nested = object.response && typeof object.response === 'object' ? object.response as Record<string, unknown> : object;
  const usage = (nested.usageMetadata ?? nested.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return;
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object' ? usage.prompt_tokens_details as Record<string, unknown> : undefined;
  context.input_tokens = nullableCount(usage.promptTokenCount ?? usage.input_tokens ?? usage.prompt_tokens);
  context.output_tokens = nullableCount(usage.candidatesTokenCount ?? usage.output_tokens ?? usage.completion_tokens);
  context.cache_tokens = nullableCount(usage.cachedContentTokenCount ?? usage.cache_read_input_tokens ?? details?.cached_tokens);
}

/** A validated first frame is not proof that an upstream stream completed. */
export function observeUpstreamStreamFailure(accountId?: string, model?: string): void {
  const context = observations.getStore();
  if (!context || context.finished) return;
  const attempt = context.attempts.at(-1);
  if (!attempt || (accountId && attempt.account_id !== accountId)) return;
  attempt.outcome = 'failure';
  attempt.error_category = 'upstream_error';
  if (model) attempt.effective_model = safeLabel(model, '') || null;
  context.upstream_failed = true;
}
