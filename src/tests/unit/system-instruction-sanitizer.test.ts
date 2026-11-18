import { describe, expect, it } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { sanitizeUpstreamBlockedSystemText } from '@/modules/proxy-gateway/antigravity/system-instruction-sanitizer';
import { preflightNativeGeminiRequest } from '@/modules/proxy-gateway/server/native-gemini-request';

describe('system-instruction-sanitizer', () => {
  it('rewrites OpenClaw runtime banner in Claude and OpenAI-converted system prompts', () => {
    const result = transformClaudeRequestIn({
      model: 'gemini-3.8-flash-tiered',
      system:
        'You are a personal assistant running inside OpenClaw.\n\n## Tooling\nUse exact tool names.',
      messages: [{ role: 'user', content: 'ping' }],
    });

    const texts = (result.request.systemInstruction?.parts ?? []).map((p) => p.text).join('\n');
    expect(texts).not.toContain('You are a personal assistant running inside OpenClaw.');
    expect(texts).toContain('You are a helpful AI assistant running inside the local runtime.');
    expect(texts).toContain('## Tooling\nUse exact tool names.');
  });

  it('rewrites OpenClaw runtime banner in Claude array system blocks and native Gemini preflight', () => {
    const claudeResult = transformClaudeRequestIn({
      model: 'gemini-4-hydrogen-sonar',
      system: [{ type: 'text', text: 'You are a personal assistant running inside OpenClaw.' }],
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(
      (claudeResult.request.systemInstruction?.parts ?? []).some(
        (p) => p.text === 'You are a helpful AI assistant running inside the local runtime.',
      ),
    ).toBe(true);

    const nativeResult = preflightNativeGeminiRequest({
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      systemInstruction: {
        parts: [{ text: 'You are a personal assistant running inside OpenClaw.\nKeep tools.' }],
      },
    });
    const nativeText = String(nativeResult.systemInstruction?.parts[0]?.text ?? '');
    expect(nativeText).not.toContain('running inside OpenClaw.');
    expect(nativeText).toContain(
      'You are a helpful AI assistant running inside the local runtime.\nKeep tools.',
    );
  });

  it('leaves unrelated system instructions completely untouched (negative control)', () => {
    const original = 'You are Arina. OpenClaw tools stay available cleanly.';
    expect(sanitizeUpstreamBlockedSystemText(original)).toBe(original);
  });
});
