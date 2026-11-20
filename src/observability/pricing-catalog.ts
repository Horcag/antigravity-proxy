import type { ModelRateCard, QuotaPoolId, QuotaPricingConfig, UsageSchema } from './quota-analytics-types';

export const BUILTIN_CATALOG_AS_OF = '2026-11-19';

export const DEFAULT_TIER_MONTHLY_USD: Record<string, number> = {
  'Google AI Pro': 20,
  'g1-pro-tier': 20,
  'Google AI Ultra': 250,
  'g1-ultra-tier': 250,
  Standard: 0,
  Free: 0,
};

interface BuiltinRateRule {
  canonical: string;
  prefixes: string[];
  card: Omit<ModelRateCard, 'canonical_model' | 'source_label' | 'as_of'>;
  source: string;
}

const RATE_RULES: BuiltinRateRule[] = [
  {
    canonical: 'gemini-4-neon',
    prefixes: ['gemini-4-neon', 'gemini-pro-orchestrator-neon'],
    card: { input: 3.0, cached_input: 0.15, output: 15.0 },
    source: 'Google AI Studio / Vertex AI',
  },
  {
    canonical: 'gemini-4-hydrogen',
    prefixes: ['gemini-4-hydrogen'],
    card: { input: 1.5, cached_input: 0.075, output: 7.5 },
    source: 'Google AI Studio / Vertex AI',
  },
  {
    canonical: 'gemini-4-argon',
    prefixes: ['gemini-4-argon', 'gemini-pro-orchestrator-argon'],
    card: { input: 2.0, cached_input: 0.1, output: 10.0, note: 'Вводная цена до 2026-11-30' },
    source: 'Google AI Studio / Vertex AI',
  },
  {
    canonical: 'gemini-3.8-flash',
    prefixes: ['gemini-3.8-flash'],
    card: { input: 0.75, cached_input: 0.075, output: 3.75, note: 'Вводная цена до 2026-12-31' },
    source: 'Google AI Studio',
  },
  {
    canonical: 'gemini-3.1-pro',
    prefixes: ['gemini-3.1-pro', 'gemini-pro-orchestrator'],
    card: {
      input: 2.0, cached_input: 0.2, output: 12.0,
      long_context_threshold: 200_001, long_input: 4.0, long_cached_input: 0.4, long_output: 18.0,
    },
    source: 'Google AI Studio',
  },
  {
    canonical: 'gemini-3.5-flash',
    prefixes: ['gemini-3.5-flash', 'gemini-3-flash'],
    card: { input: 0.5, cached_input: 0.05, output: 3.0 },
    source: 'Google AI Studio',
  },
  {
    canonical: 'gpt-oss-120b',
    prefixes: ['gpt-oss-120b', 'openai/gpt-oss-120b'],
    card: { input: 0.15, cached_input: 0.075, output: 0.60 },
    source: 'Groq API · https://console.groq.com/docs/model/openai/gpt-oss-120b',
  },
  {
    canonical: 'claude-opus-5-5',
    prefixes: ['claude-opus-5-5', 'claude-opus-5'],
    card: { input: 4.0, cached_input: 0.2, cache_write: 5.0, output: 20.0 },
    source: 'Anthropic API',
  },
  {
    canonical: 'claude-sonnet-5-5',
    prefixes: ['claude-sonnet-5-5', 'claude-sonnet-5'],
    card: { input: 2.0, cached_input: 0.1, cache_write: 2.5, output: 10.0 },
    source: 'Anthropic API',
  },
  {
    canonical: 'claude-opus-4-6',
    prefixes: ['claude-opus-4-6', 'claude-opus-4-5'],
    card: { input: 5.0, cached_input: 0.5, cache_write: 6.25, output: 25.0 },
    source: 'Anthropic API',
  },
  {
    canonical: 'claude-sonnet-4-6',
    prefixes: ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet'],
    card: { input: 3.0, cached_input: 0.3, cache_write: 3.75, output: 15.0 },
    source: 'Anthropic API',
  },
];

export const BUILTIN_MODEL_RATES: ModelRateCard[] = RATE_RULES.map((rule) => ({
  canonical_model: rule.canonical,
  ...rule.card,
  source_label: rule.source,
  as_of: BUILTIN_CATALOG_AS_OF,
}));

export function normalizePricingConfig(input?: Partial<QuotaPricingConfig>): QuotaPricingConfig {
  return {
    api_multiplier: typeof input?.api_multiplier === 'number' && Number.isFinite(input.api_multiplier) && input.api_multiplier > 0 ? input.api_multiplier : 1,
    tier_monthly_usd: { ...(input?.tier_monthly_usd ?? {}) },
    account_monthly_usd: { ...(input?.account_monthly_usd ?? {}) },
    model_overrides: { ...(input?.model_overrides ?? {}) },
  };
}

export function classifyModelPool(modelName: string | null | undefined): QuotaPoolId | 'other' {
  if (!modelName) return 'other';
  const normalized = modelName.replace(/^models\//i, '').trim().toLowerCase();
  if (!normalized) return 'other';
  if (normalized.includes('claude') || normalized.includes('gpt')) return 'third_party';
  if (normalized.includes('argon')) return 'argon';
  if (normalized.startsWith('gemini') && !normalized.includes('image') && !normalized.endsWith('-sonar')) return 'gemini';
  return 'other';
}

export function resolveModelRateCard(model: string | null | undefined, config: QuotaPricingConfig): ModelRateCard | null {
  if (!model) return null;
  const clean = model.replace(/^models\//i, '').trim().toLowerCase();
  if (!clean) return null;
  const mult = config.api_multiplier;
  for (const [key, ov] of Object.entries(config.model_overrides)) {
    const ovKey = key.toLowerCase();
    if (clean === ovKey || clean.startsWith(`${ovKey}-`)) {
      return {
        canonical_model: key,
        input: ov.input * mult,
        cached_input: ov.cached_input * mult,
        ...(ov.cache_write !== undefined ? { cache_write: ov.cache_write * mult } : {}),
        output: ov.output * mult,
        source_label: 'Пользовательский тариф',
        as_of: 'override',
      };
    }
  }
  const matched = RATE_RULES.find((rule) => rule.prefixes.some((p) => clean === p || clean.startsWith(`${p}-`) || clean.startsWith(p)));
  if (!matched) return null;
  const c = matched.card;
  return {
    canonical_model: matched.canonical,
    input: c.input * mult,
    cached_input: c.cached_input * mult,
    ...(c.cache_write !== undefined ? { cache_write: c.cache_write * mult } : {}),
    output: c.output * mult,
    ...(c.long_context_threshold !== undefined ? {
      long_context_threshold: c.long_context_threshold,
      long_input: (c.long_input ?? c.input) * mult,
      long_cached_input: (c.long_cached_input ?? c.cached_input) * mult,
      long_output: (c.long_output ?? c.output) * mult,
    } : {}),
    source_label: matched.source,
    as_of: BUILTIN_CATALOG_AS_OF,
    note: c.note,
  };
}

export interface TokenUsageInput {
  model: string | null | undefined;
  route?: string | null;
  usage_schema?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thought_tokens?: number | null;
  cache_tokens?: number | null;
  cache_write_tokens?: number | null;
}

export interface RequestCostResult {
  priced: boolean;
  canonical_model: string | null;
  total_usd: number | null;
  input_usd: number;
  cached_input_usd: number;
  cache_write_usd: number;
  output_usd: number;
  cache_savings_usd: number;
}

function inferUsageSchema(row: TokenUsageInput): UsageSchema {
  if (row.usage_schema === 'gemini' || row.usage_schema === 'anthropic' || row.usage_schema === 'openai') {
    return row.usage_schema;
  }
  if (row.route === '/v1/messages') return 'anthropic';
  if (row.route?.startsWith('/v1/')) return 'openai';
  return 'gemini';
}

export function calculateRequestCost(row: TokenUsageInput, config: QuotaPricingConfig): RequestCostResult {
  const card = resolveModelRateCard(row.model, config);
  if (!card || row.input_tokens === null || row.output_tokens === null) {
    return { priced: false, canonical_model: card?.canonical_model ?? null, total_usd: null, input_usd: 0, cached_input_usd: 0, cache_write_usd: 0, output_usd: 0, cache_savings_usd: 0 };
  }
  const schema = inferUsageSchema(row);
  const rawInput = Math.max(0, row.input_tokens);
  const rawOutput = Math.max(0, row.output_tokens);
  const rawCached = Math.max(0, row.cache_tokens ?? 0);
  const rawCacheWrite = Math.max(0, row.cache_write_tokens ?? 0);
  const rawThoughts = Math.max(0, row.thought_tokens ?? 0);

  const cached = schema === 'anthropic' ? rawCached : Math.min(rawCached, rawInput);
  const uncachedInput = schema === 'anthropic' ? rawInput : Math.max(0, rawInput - cached);
  const billableOutput = schema === 'gemini' ? rawOutput + rawThoughts : rawOutput;
  const totalContextTokens = schema === 'anthropic' ? rawInput + cached + rawCacheWrite : rawInput;
  const longBand = Boolean(card.long_context_threshold && totalContextTokens >= card.long_context_threshold);

  const inputRate = longBand ? (card.long_input ?? card.input) : card.input;
  const cachedRate = longBand ? (card.long_cached_input ?? card.cached_input) : card.cached_input;
  const outputRate = longBand ? (card.long_output ?? card.output) : card.output;
  const cacheWriteRate = card.cache_write ?? inputRate;

  const inputUsd = (uncachedInput * inputRate) / 1_000_000;
  const cachedUsd = (cached * cachedRate) / 1_000_000;
  const cacheWriteUsd = (rawCacheWrite * cacheWriteRate) / 1_000_000;
  const outputUsd = (billableOutput * outputRate) / 1_000_000;
  const cacheSavingsUsd = Math.max(0, (cached * (inputRate - cachedRate)) / 1_000_000);
  return {
    priced: true,
    canonical_model: card.canonical_model,
    total_usd: inputUsd + cachedUsd + cacheWriteUsd + outputUsd,
    input_usd: inputUsd,
    cached_input_usd: cachedUsd,
    cache_write_usd: cacheWriteUsd,
    output_usd: outputUsd,
    cache_savings_usd: cacheSavingsUsd,
  };
}

export function resolveAccountMonthlyUsd(accountId: string, tier: string | null | undefined, config: QuotaPricingConfig): number | null {
  if (Object.prototype.hasOwnProperty.call(config.account_monthly_usd, accountId)) {
    return config.account_monthly_usd[accountId];
  }
  const merged = { ...DEFAULT_TIER_MONTHLY_USD, ...config.tier_monthly_usd };
  if (!tier) return null;
  const norm = tier.trim().toLowerCase();
  for (const [k, price] of Object.entries(merged)) {
    if (k.toLowerCase() === norm) return price;
  }
  if (norm.includes('ultra')) return merged['Google AI Ultra'] ?? 250;
  if (norm.includes('pro')) return merged['Google AI Pro'] ?? 20;
  if (norm.includes('standard') || norm.includes('free')) return merged.Standard ?? 0;
  return null;
}
