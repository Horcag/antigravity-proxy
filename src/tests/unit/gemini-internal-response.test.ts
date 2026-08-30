import { describe, expect, it } from 'vitest';
import { unwrapInternalGeminiResponse } from '@/modules/proxy-gateway/server/clients/gemini.client';

describe('internal Gemini response normalization', () => {
  it('unwraps the response envelope used by the internal API', () => {
    const response = {
      candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' } }],
    };

    expect(unwrapInternalGeminiResponse({ response })).toBe(response);
  });

  it('preserves an unwrapped Gemini response', () => {
    const response = {
      candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' } }],
    };

    expect(unwrapInternalGeminiResponse(response)).toBe(response);
  });

  it('does not unwrap a non-object response field', () => {
    const payload = { error: { message: 'failed' }, response: null };

    expect(unwrapInternalGeminiResponse(payload)).toBe(payload);
  });
});
