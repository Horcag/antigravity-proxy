const FAILURE_EWMA_ALPHA = 0.2;
const TTFT_MAX_MS = 30_000;
const COOLDOWN_MAX_MS = 300_000;
const STALE_ENTRY_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1_000;

interface PerformanceState {
  failureEwma: number;
  lastUpdatedAt: number;
  ttftMs?: number;
}

export interface AccountPerformanceScoreInput {
  accountId: string;
  effectiveModel: string;
  remainingQuotaPercent?: number;
  remainingCooldownMs?: number;
}

export interface AccountPerformancePolicyOptions {
  now?: () => number;
  maxEntries?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRemainingQuota(remainingQuotaPercent: number | undefined): number {
  if (!Number.isFinite(remainingQuotaPercent)) {
    return 0;
  }
  return clamp((remainingQuotaPercent as number) / 100, 0, 1);
}

export class AccountPerformancePolicy {
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly state = new Map<string, PerformanceState>();

  constructor(options: AccountPerformancePolicyOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
  }

  recordSuccess(accountId: string, effectiveModel: string, ttftMs?: number): void {
    const now = this.now();
    const key = this.key(accountId, effectiveModel);
    this.prune(now);
    const current = this.state.get(key);
    this.state.set(key, {
      failureEwma: this.nextFailureEwma(current?.failureEwma, 0),
      lastUpdatedAt: now,
      ...(Number.isFinite(ttftMs) ? { ttftMs: Math.max(0, ttftMs as number) } : current?.ttftMs !== undefined
        ? { ttftMs: current.ttftMs }
        : {}),
    });
    this.prune(now);
  }

  recordFailure(accountId: string, effectiveModel: string): void {
    const now = this.now();
    const key = this.key(accountId, effectiveModel);
    this.prune(now);
    const current = this.state.get(key);
    this.state.set(key, {
      failureEwma: this.nextFailureEwma(current?.failureEwma, 1),
      lastUpdatedAt: now,
      ...(current?.ttftMs !== undefined ? { ttftMs: current.ttftMs } : {}),
    });
    this.prune(now);
  }

  score(input: AccountPerformanceScoreInput): number {
    const now = this.now();
    const current = this.getFreshState(this.state.get(this.key(input.accountId, input.effectiveModel)), now);
    const quota = normalizeRemainingQuota(input.remainingQuotaPercent);
    const latency = current?.ttftMs === undefined
      ? 0.5
      : 1 - clamp(current.ttftMs / TTFT_MAX_MS, 0, 1);
    const failures = clamp(current?.failureEwma ?? 0, 0, 1);
    const cooldown = Number.isFinite(input.remainingCooldownMs)
      ? clamp((input.remainingCooldownMs as number) / COOLDOWN_MAX_MS, 0, 1)
      : 0;
    return 0.45 * quota + 0.35 * latency + 0.2 * (1 - failures) - 0.05 * cooldown;
  }

  resetAccounts(accountIds: ReadonlySet<string>): void {
    const normalizedAccountIds = new Set([...accountIds].map(normalizeKeyPart));
    for (const key of this.state.keys()) {
      const accountId = key.slice(0, key.indexOf('\u0000'));
      if (!normalizedAccountIds.has(accountId)) {
        this.state.delete(key);
      }
    }
  }

  reset(): void {
    this.state.clear();
  }

  get size(): number {
    return this.state.size;
  }

  private key(accountId: string, effectiveModel: string): string {
    return `${normalizeKeyPart(accountId)}\u0000${normalizeKeyPart(effectiveModel)}`;
  }

  private nextFailureEwma(current: number | undefined, sample: 0 | 1): number {
    return clamp((current ?? 0) * (1 - FAILURE_EWMA_ALPHA) + sample * FAILURE_EWMA_ALPHA, 0, 1);
  }

  private getFreshState(state: PerformanceState | undefined, now: number): PerformanceState | undefined {
    return state && now - state.lastUpdatedAt <= STALE_ENTRY_MS ? state : undefined;
  }

  private prune(now: number): void {
    for (const [key, value] of this.state) {
      if (now - value.lastUpdatedAt > STALE_ENTRY_MS) {
        this.state.delete(key);
      }
    }
    if (this.state.size <= this.maxEntries) {
      return;
    }
    const ordered = [...this.state.entries()].sort(
      ([leftKey, left], [rightKey, right]) =>
        left.lastUpdatedAt - right.lastUpdatedAt || compareCodeUnits(leftKey, rightKey),
    );
    for (const [key] of ordered.slice(0, this.state.size - this.maxEntries)) {
      this.state.delete(key);
    }
  }
}
