import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AttemptRecord } from './request-history';
import { safeLabel, nullableCount, errorCategory } from './metadata';

export type UsageSchema = 'gemini' | 'anthropic' | 'openai';

export interface RequestObservation {
  request_id: string;
  requested_model?: string;
  effective_model?: string;
  account_id?: string;
  session_key?: string | null;
  attempts: AttemptRecord[];
  ttft_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  thought_tokens?: number | null;
  cache_tokens?: number | null;
  cache_write_tokens?: number | null;
  usage_schema?: UsageSchema | null;
  upstream_failed?: boolean;
  finished: boolean;
}
const observations = new AsyncLocalStorage<RequestObservation>();
export function createRequestObservation(): RequestObservation { return { request_id: randomUUID(), attempts: [], finished: false }; }
export function runWithRequestObservation<T>(observation: RequestObservation, work: () => T): T { return observations.run(observation, work); }
export function getRequestObservation(): RequestObservation | undefined { return observations.getStore(); }

export function observeSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return sessionKey;
  const context = observations.getStore();
  if (!context || context.finished) return sessionKey;
  const trimmed = sessionKey.trim();
  if (!trimmed) return sessionKey;
  const safe = safeLabel(trimmed.slice(0, 100), '');
  if (safe) context.session_key = safe;
  return sessionKey;
}

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

export type ResponseUsage = Partial<
  Pick<
    RequestObservation,
    'input_tokens' | 'output_tokens' | 'thought_tokens' | 'cache_tokens' | 'cache_write_tokens' | 'usage_schema'
  >
>;

/** Read numeric usage fields only, retaining no payload text or response structure. */
export function extractResponseUsage(payload: unknown): ResponseUsage {
  if (!payload || typeof payload !== 'object') return {};
  const object = payload as Record<string, unknown>;
  if (object.error) return {};
  const nested = object.response && typeof object.response === 'object'
    ? object.response as Record<string, unknown>
    : object.message && typeof object.message === 'object'
      ? object.message as Record<string, unknown>
      : object;
  if (nested.error) return {};
  const isGeminiMeta = Boolean(nested.usageMetadata && typeof nested.usageMetadata === 'object');
  const usage = (isGeminiMeta ? nested.usageMetadata : nested.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return {};
  const promptDetails = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const completionDetails = (usage.completion_tokens_details ?? usage.output_tokens_details) as Record<string, unknown> | undefined;
  const isAnthropic = !isGeminiMeta && (
    object.type === 'message' || object.type === 'message_start' || object.type === 'message_delta'
    || 'cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage
  );
  const schema: UsageSchema = isGeminiMeta ? 'gemini' : isAnthropic ? 'anthropic' : 'openai';
  const result: ResponseUsage = {};
  for (const [key, value] of [
    ['input_tokens', usage.promptTokenCount ?? usage.input_tokens ?? usage.prompt_tokens],
    ['output_tokens', usage.candidatesTokenCount ?? usage.output_tokens ?? usage.completion_tokens],
    ['thought_tokens', usage.thoughtsTokenCount ?? completionDetails?.reasoning_tokens],
    ['cache_tokens', usage.cachedContentTokenCount ?? usage.cache_read_input_tokens ?? promptDetails?.cached_tokens],
    ['cache_write_tokens', usage.cache_creation_input_tokens],
  ] as const) {
    const count = nullableCount(value);
    if (count !== null) result[key] = count;
  }
  if (Object.keys(result).length > 0) result.usage_schema = schema;
  return result;
}
export function mergeStreamResponseUsage(target: ResponseUsage, incoming: ResponseUsage): void {
  for (const key of ['input_tokens', 'output_tokens', 'thought_tokens', 'cache_tokens', 'cache_write_tokens'] as const) {
    const next = incoming[key];
    if (typeof next !== 'number') continue;
    const prev = target[key];
    target[key] = typeof prev === 'number' ? Math.max(prev, next) : next;
  }
  if (incoming.usage_schema) target.usage_schema = incoming.usage_schema;
}
export function observeResponseUsage(payload: unknown): void {
  const context = observations.getStore();
  if (context && !context.finished) Object.assign(context, extractResponseUsage(payload));
}

/** A validated first frame is not proof that an upstream stream completed. */
export function observeUpstreamStreamFailure(accountId?: string, model?: string): void {
  const context = observations.getStore();
  if (!context || context.finished) return;
  const attempt = context.attempts.at(-1);
  if (attempt && accountId && attempt.account_id !== accountId) return;
  context.upstream_failed = true;
  if (!attempt) return;
  attempt.outcome = 'failure';
  attempt.error_category = 'upstream_error';
  if (model) attempt.effective_model = safeLabel(model, '') || null;
}
