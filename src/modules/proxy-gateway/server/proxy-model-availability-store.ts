export type ProxyModelAvailabilityReason =
  | 'model_not_supported'
  | 'model_forbidden'
  | 'quota_exhausted'
  | 'rate_limited';

const HARD_CAPABILITY_FAILURE_REASONS = new Set<ProxyModelAvailabilityReason>([
  'model_not_supported',
  'model_forbidden',
]);

export interface ProxyModelAvailability {
  accountId: string;
  modelId: string;
  reason: ProxyModelAvailabilityReason;
  unavailableUntil: number;
}

const MODEL_UNAVAILABLE_CACHE_MS = 20 * 60 * 1000;
const DEFAULT_RATE_LIMIT_CACHE_MS = 5 * 60 * 1000;

function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

function createKey(accountId: string, modelId: string): string {
  return `${accountId}:${normalizeModelId(modelId)}`;
}

export class ProxyModelAvailabilityStore {
  private readonly entries = new Map<string, ProxyModelAvailability>();

  mark(
    accountId: string,
    modelId: string,
    reason: ProxyModelAvailabilityReason,
    unavailableUntil?: number,
  ): void {
    if (!accountId || !modelId) {
      return;
    }
    const timeout = HARD_CAPABILITY_FAILURE_REASONS.has(reason)
      ? MODEL_UNAVAILABLE_CACHE_MS
      : DEFAULT_RATE_LIMIT_CACHE_MS;
    this.entries.set(createKey(accountId, modelId), {
      accountId,
      modelId: normalizeModelId(modelId),
      reason,
      unavailableUntil: unavailableUntil ?? Date.now() + timeout,
    });
  }

  clearAccount(accountId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.accountId === accountId) {
        this.entries.delete(key);
      }
    }
  }

  clearModel(accountId: string, modelId: string): void {
    this.entries.delete(createKey(accountId, modelId));
  }

  clearCapabilityFailures(accountId: string): void {
    for (const [key, entry] of this.entries) {
      if (
        entry.accountId === accountId &&
        HARD_CAPABILITY_FAILURE_REASONS.has(entry.reason)
      ) {
        this.entries.delete(key);
      }
    }
  }

  clearCapabilityFailuresForModels(accountId: string, modelIds: Iterable<string>): void {
    const normalizedModelIds = new Set(
      [...modelIds].filter(Boolean).map((modelId) => normalizeModelId(modelId)),
    );
    for (const [key, entry] of this.entries) {
      if (
        entry.accountId === accountId &&
        normalizedModelIds.has(entry.modelId) &&
        HARD_CAPABILITY_FAILURE_REASONS.has(entry.reason)
      ) {
        this.entries.delete(key);
      }
    }
  }

  isAvailable(accountId: string, modelId: string, now = Date.now()): boolean {
    return this.getActiveEntry(accountId, modelId, now) === null;
  }

  peekIsAvailable(accountId: string, modelId: string, now = Date.now()): boolean {
    return this.peekActiveEntry(accountId, modelId, now) === null;
  }

  isCapabilityAvailable(accountId: string, modelId: string, now = Date.now()): boolean {
    return !this.hasHardCapabilityFailure(accountId, modelId, now);
  }

  hasHardCapabilityFailure(accountId: string, modelId: string, now = Date.now()): boolean {
    const entry = this.getActiveEntry(accountId, modelId, now);
    return entry !== null && HARD_CAPABILITY_FAILURE_REASONS.has(entry.reason);
  }

  peekHasHardCapabilityFailure(accountId: string, modelId: string, now = Date.now()): boolean {
    const entry = this.peekActiveEntry(accountId, modelId, now);
    return entry !== null && HARD_CAPABILITY_FAILURE_REASONS.has(entry.reason);
  }

  private getActiveEntry(
    accountId: string,
    modelId: string,
    now: number,
  ): ProxyModelAvailability | null {
    const key = createKey(accountId, modelId);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.unavailableUntil <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  private peekActiveEntry(
    accountId: string,
    modelId: string,
    now: number,
  ): ProxyModelAvailability | null {
    const entry = this.entries.get(createKey(accountId, modelId));
    return entry && entry.unavailableUntil > now ? entry : null;
  }

  getSnapshot(now = Date.now()): ProxyModelAvailability[] {
    for (const [key, entry] of this.entries) {
      if (entry.unavailableUntil <= now) {
        this.entries.delete(key);
      }
    }
    return [...this.entries.values()];
  }

  peekSnapshot(now = Date.now()): ProxyModelAvailability[] {
    return [...this.entries.values()].filter((entry) => entry.unavailableUntil > now);
  }
}

export const proxyModelAvailabilityStore = new ProxyModelAvailabilityStore();
