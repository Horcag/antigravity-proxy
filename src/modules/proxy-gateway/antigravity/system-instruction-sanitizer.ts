const UPSTREAM_BLOCKED_SYSTEM_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /You are a personal assistant running inside OpenClaw\./g,
    'You are a helpful AI assistant running inside the local runtime.',
  ],
];

/**
 * Rewrites upstream-blocked runtime identity banners while preserving client system instructions.
 */
export function sanitizeUpstreamBlockedSystemText(text: string): string {
  let sanitized = text;
  for (const [pattern, replacement] of UPSTREAM_BLOCKED_SYSTEM_PHRASES) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

/**
 * Applies blocked-banner sanitization to any normalized part carrying string text.
 */
export function sanitizeSystemPartText<T extends Record<string, unknown>>(part: T): T {
  if (typeof part.text !== 'string') {
    return part;
  }
  return { ...part, text: sanitizeUpstreamBlockedSystemText(part.text) };
}
