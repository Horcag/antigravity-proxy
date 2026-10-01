interface NegativeProjectCapabilityEntry {
  accountKey: string;
  project: string;
  cachedAt: number;
  expiresAt: number;
}

export interface NegativeProjectCapabilitySnapshot {
  cachedAt: number;
  expiresAt: number;
}

export const DEFAULT_PROJECT_CAPABILITY_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class UserProjectCapabilityCache {
  private readonly entries = new Map<string, NegativeProjectCapabilityEntry>();
  private readonly maxEntries = 1000;

  private createKey(accountKey: string, project: string): string | null {
    const safeAccount = accountKey?.trim();
    const safeProject = project?.trim();
    if (!safeAccount || !safeProject) {
      return null;
    }
    // Never key by token: reject any token-like value
    if (
      safeAccount.startsWith('ya29.') ||
      safeAccount.toLowerCase().startsWith('bearer ') ||
      safeAccount.length > 256
    ) {
      return null;
    }
    return `${safeAccount}:${safeProject}`;
  }

  hasNegativeCapability(accountKey: string, project: string, now = Date.now()): boolean {
    const key = this.createKey(accountKey, project);
    if (!key) {
      return false;
    }
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  recordNegativeCapability(
    accountKey: string,
    project: string,
    ttlMs = DEFAULT_PROJECT_CAPABILITY_TTL_MS,
    now = Date.now(),
  ): void {
    const key = this.createKey(accountKey, project);
    if (!key) {
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      this.pruneExpired(now);
      if (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey) {
          this.entries.delete(oldestKey);
        }
      }
    }
    this.entries.set(key, {
      accountKey: accountKey.trim(),
      project: project.trim(),
      cachedAt: now,
      expiresAt: now + ttlMs,
    });
  }

  clearNegativeCapability(accountKey: string, project: string): void {
    const key = this.createKey(accountKey, project);
    if (!key) {
      return;
    }
    this.entries.delete(key);
  }

  clearAll(): void {
    this.entries.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  getSnapshot(): NegativeProjectCapabilitySnapshot[] {
    const now = Date.now();
    this.pruneExpired(now);
    return [...this.entries.values()].map(({ cachedAt, expiresAt }) => ({ cachedAt, expiresAt }));
  }
}

