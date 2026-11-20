import { describe, expect, it } from 'vitest';
import {
  calculateRequestCost,
  classifyModelPool,
  normalizePricingConfig,
  resolveAccountMonthlyUsd,
  resolveModelRateCard,
} from '@/observability/pricing-catalog';

describe('pricing-catalog', () => {
  const defaults = normalizePricingConfig();

  it('classifies pools consistently with proxy quota policies', () => {
    expect(classifyModelPool('gemini-4-neon-high')).toBe('gemini');
    expect(classifyModelPool('gemini-4-argon-medium')).toBe('argon');
    expect(classifyModelPool('claude-opus-5-5-high')).toBe('third_party');
    expect(classifyModelPool('gpt-oss-120b-medium')).toBe('third_party');
    expect(classifyModelPool('gemini-3-pro-image')).toBe('other');
    expect(classifyModelPool('gemini-4-hydrogen-sonar')).toBe('other');
  });

  it('computes Gemini, Anthropic and OpenAI billing without double-counting reasoning or cache', () => {
    // Gemini: input includes cachedContentTokenCount; output excludes thoughtsTokenCount
    const gem = calculateRequestCost(
      {
        model: 'gemini-4-neon-high',
        usage_schema: 'gemini',
        input_tokens: 1_000_000,
        cache_tokens: 600_000,
        output_tokens: 100_000,
        thought_tokens: 50_000,
      },
      defaults,
    );
    expect(gem.priced).toBe(true);
    // (400k * 3.0 + 600k * 0.15 + 150k * 15.0) / 1M = 1.2 + 0.09 + 2.25 = 3.54
    expect(gem.total_usd).toBeCloseTo(3.54, 6);
    expect(gem.cache_savings_usd).toBeCloseTo(0.6 * (3.0 - 0.15), 6);

    // Anthropic: input_tokens is uncached; cache_read and cache_write separate; output already includes thinking
    const claude = calculateRequestCost(
      {
        model: 'claude-opus-5-5-high',
        usage_schema: 'anthropic',
        input_tokens: 500_000,
        cache_tokens: 1_000_000,
        cache_write_tokens: 200_000,
        output_tokens: 100_000,
        thought_tokens: 40_000,
      },
      defaults,
    );
    // 0.5*4.0 + 1.0*0.2 + 0.2*5.0 + 0.1*20.0 = 2.0 + 0.2 + 1.0 + 2.0 = 5.2
    expect(claude.total_usd).toBeCloseTo(5.2, 6);

    // OpenAI: output_tokens already includes reasoning_tokens
    const openai = calculateRequestCost(
      {
        model: 'gemini-4-hydrogen-medium',
        usage_schema: 'openai',
        input_tokens: 1_000_000,
        cache_tokens: 200_000,
        output_tokens: 200_000,
        thought_tokens: 80_000,
      },
      defaults,
    );
    // 0.8*1.5 + 0.2*0.075 + 0.2*7.5 = 1.2 + 0.015 + 1.5 = 2.715
    expect(openai.total_usd).toBeCloseTo(2.715, 6);
  });

  it('applies long-context tier for gemini-3.1-pro and leaves unpriced models unpriced unless overridden', () => {
    const longGem = calculateRequestCost(
      {
        model: 'gemini-3.1-pro-high',
        usage_schema: 'gemini',
        input_tokens: 250_000,
        cache_tokens: 0,
        output_tokens: 100_000,
      },
      defaults,
    );
    // >= 200_001 -> input $4, output $18 => 0.25*4 + 0.1*18 = 2.8
    expect(longGem.total_usd).toBeCloseTo(2.8, 6);

    expect(resolveModelRateCard('gpt-oss-120b-medium', defaults)).toMatchObject({
      canonical_model: 'gpt-oss-120b', input: 0.15, cached_input: 0.075, output: 0.60,
    });
    const unpriced = calculateRequestCost(
      { model: 'gpt-unknown-model', input_tokens: 1000, output_tokens: 200 },
      defaults,
    );
    expect(unpriced.priced).toBe(false);
    expect(unpriced.total_usd).toBeNull();

    const custom = normalizePricingConfig({
      api_multiplier: 0.5,
      model_overrides: { 'gpt-oss-120b-medium': { input: 2, cached_input: 0.2, output: 8 } },
    });
    const over = calculateRequestCost(
      { model: 'gpt-oss-120b-medium', usage_schema: 'openai', input_tokens: 1_000_000, output_tokens: 500_000 },
      custom,
    );
    // (1.0*2 + 0.5*8) * 0.5 = 3.0
    expect(over.priced).toBe(true);
    expect(over.total_usd).toBeCloseTo(3.0, 6);
  });

  it('resolves subscription tier and per-account monthly pricing conservatively', () => {
    const cfg = normalizePricingConfig({
      tier_monthly_usd: { 'Google AI Pro': 25 },
      account_monthly_usd: { 'acc-special': 12 },
    });
    expect(resolveAccountMonthlyUsd('acc-special', 'Google AI Ultra', cfg)).toBe(12);
    expect(resolveAccountMonthlyUsd('acc-1', 'Google AI Pro', cfg)).toBe(25);
    expect(resolveAccountMonthlyUsd('acc-2', 'g1-ultra-tier', cfg)).toBe(250);
    expect(resolveAccountMonthlyUsd('acc-3', 'Standard', cfg)).toBe(0);
    expect(resolveAccountMonthlyUsd('acc-4', null, cfg)).toBeNull();
  });
});
