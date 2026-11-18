import { describe, expect, it } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

describe('ClaudeRequestMapper web_search tool classification', () => {
  it('preserves client web_search function tool and requested model without forcing gemini-3-flash', () => {
    const result = transformClaudeRequestIn({
      model: 'gemini-3.8-flash-high',
      messages: [{ role: 'user', content: 'search docs' }],
      tools: [
        {
          name: 'web_search',
          description: 'Local SearXNG search',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
        {
          name: 'read_file',
          description: 'Read local file',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
    });

    expect(result.model).toBe('gemini-3.8-flash-high');
    const declNames = (result.request.tools ?? [])
      .flatMap((t) => t.functionDeclarations ?? [])
      .map((d) => d.name);
    expect(declNames).toEqual(['web_search', 'read_file']);
    expect((result.request.tools ?? []).some((t) => 'googleSearch' in t)).toBe(false);
  });

  it('routes standalone server web_search_20250305 tool to gemini-3-flash googleSearch', () => {
    const result = transformClaudeRequestIn({
      model: 'claude-sonnet-4-6-thinking',
      messages: [{ role: 'user', content: 'latest news' }],
      tools: [
        {
          name: 'web_search',
          type: 'web_search_20250305',
        },
      ],
    });

    expect(result.model).toBe('gemini-3-flash');
    expect((result.request.tools ?? []).some((t) => 'googleSearch' in t)).toBe(true);
  });
});
