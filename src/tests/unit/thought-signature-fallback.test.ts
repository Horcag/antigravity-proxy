import { describe, expect, it } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

describe('Gemini Flash thought-signature fallback', () => {
  it('marks reconstructed OpenAI tool calls when no exact signature is available', () => {
    const request = transformClaudeRequestIn({
      model: 'gemini-3.7-flash-high',
      max_tokens: 1024,
      metadata: { source: 'openai' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-read',
              name: 'default_api:read',
              input: { path: 'BOOTSTRAP.md' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-read',
              content: 'not found',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'default_api:read',
          input_schema: { type: 'object' },
        },
      ],
    });

    const functionCallPart = request.request.contents[0].parts.find(
      (part) => part.functionCall?.id === 'call-read',
    );

    expect(request.request.generationConfig?.thinkingConfig).toBeUndefined();
    expect(functionCallPart).toMatchObject({
      thoughtSignature: 'skip_thought_signature_validator',
      thought_signature: 'skip_thought_signature_validator',
    });
  });
});
