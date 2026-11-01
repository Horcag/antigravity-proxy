export interface AccountPoolCapacityCandidate {
  availability: 'available' | 'unknown' | 'unavailable';
  blocks: ReadonlyArray<{ reason: string; unavailableUntil: number }>;
}

export interface AccountPoolCapacityFailure {
  reason: 'quota_exhausted' | 'rate_limited';
  retryAfterSeconds: number;
  retryAt: string;
}

export function resolveAccountPoolCapacityFailure(
  candidates: readonly AccountPoolCapacityCandidate[],
  now = Date.now(),
): AccountPoolCapacityFailure | undefined {
  // Unknown catalog entries can become fallback accounts after blocked available accounts
  // are filtered out, so every potentially usable account must have a precise capacity block.
  const pool = candidates.filter((candidate) => candidate.availability !== 'unavailable');
  if (pool.length === 0) return undefined;

  let retryAt = Infinity;
  let allQuotaExhausted = true;
  for (const candidate of pool) {
    const activeBlocks = candidate.blocks.filter((block) =>
      Number.isFinite(block.unavailableUntil) &&
      block.unavailableUntil > now &&
      !Number.isNaN(new Date(block.unavailableUntil).getTime()),
    );
    if (activeBlocks.length === 0 || activeBlocks.some((block) =>
      block.reason !== 'quota_exhausted' && block.reason !== 'rate_limited',
    )) {
      return undefined;
    }

    allQuotaExhausted &&= activeBlocks.some((block) => block.reason === 'quota_exhausted');
    const accountReadyAt = activeBlocks.reduce(
      (latest, block) => Math.max(latest, block.unavailableUntil),
      now,
    );
    retryAt = Math.min(retryAt, accountReadyAt);
  }

  return {
    reason: allQuotaExhausted ? 'quota_exhausted' : 'rate_limited',
    retryAfterSeconds: Math.ceil((retryAt - now) / 1000),
    retryAt: new Date(retryAt).toISOString(),
  };
}
