export type AccountLeaseSelectionMode = 'cache-first' | 'balance' | 'performance-first';
export type AccountLeaseSelectionEntry<T> = [string, T];

export interface AccountLeaseRateLimitReader {
  isRateLimited(accountId: string, model?: string): boolean;
  getRemainingWaitSeconds(accountId: string, model?: string): number;
}

export type SessionState = 'active' | 'migrating';

export interface MigrationCapability {
  sessionKey: string;
  generation: number;
  ownerRequestId: string;
  targetAccountId: string;
}

export interface CacheHintEntry {
  accountId: string;
  expiresAt: number;
}

export function isHintSessionKey(key: string | undefined): boolean {
  return typeof key === 'string' && (key.startsWith('hint:') || key.startsWith('cache-hint:'));
}

export function isVerifiedSessionKey(key: string | undefined): boolean {
  if (typeof key !== 'string' || !key.trim()) return false;
  if (isHintSessionKey(key)) return false;
  return true;
}

export interface SessionBindingEntry {
  accountId: string;
  generation: number;
  tableIncarnation: number;
  state: SessionState;
  migratingToAccountId?: string;
  migrationOwnerRequestId?: string;
  migrationExpiresAt?: number;
  expiresAt: number;
  lastActivityAt: number;
}

export interface AccountLeaseSelectionConfig {
  parityEnabled: boolean;
  parityShadowEnabled: boolean;
  schedulingMode: AccountLeaseSelectionMode;
  preferredAccountId?: string;
  maxWaitMs: number;
  noGoMismatchRateThreshold: number;
  noGoErrorRateThreshold: number;
  maxConcurrencyPerAccount?: number;
}

interface AccountLeaseSelectionLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface AccountLeaseSelectionRequest<T> {
  allTokens: Array<AccountLeaseSelectionEntry<T>>;
  getCurrentCandidates?: () => Promise<Array<AccountLeaseSelectionEntry<T>>>;
  sessionKey?: string;
  skipWait?: boolean;
  model?: string;
  getEffectiveModelForAccount?: (accountId: string) => string | undefined;
  getPerformanceScore?: (accountId: string, effectiveModel: string | undefined) => number;
  getInFlightCount?: (accountId: string) => number;
  now: number;
  accountCooldowns: Map<string, number>;
  rateLimitTracker: AccountLeaseRateLimitReader;
  config: AccountLeaseSelectionConfig;
  logger: AccountLeaseSelectionLogger;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class AccountLeaseSelectionPolicy {
  private currentIndex = 0;
  private tableIncarnation = 1;
  private sessionBindings: Map<string, SessionBindingEntry> = new Map();
  private cacheHintBindings: Map<string, CacheHintEntry> = new Map();
  private parityRequestCount = 0;
  private parityErrorCount = 0;
  private noGoBlocked = false;
  private shadowComparisonCount = 0;
  private shadowMismatchCount = 0;

  getShadowComparisonCount(): number {
    return this.shadowComparisonCount;
  }

  isNoGoBlocked(): boolean {
    return this.noGoBlocked;
  }

  clearSessions(): void {
    this.tableIncarnation++;
    this.sessionBindings.clear();
    this.cacheHintBindings.clear();
  }

  recordCacheHint(hintKey: string, accountId: string, ttlMs = 300000): void {
    const now = Date.now();
    if (this.cacheHintBindings.size >= 5000) {
      for (const [k, v] of this.cacheHintBindings.entries()) {
        if (v.expiresAt <= now) {
          this.cacheHintBindings.delete(k);
        }
      }
      if (this.cacheHintBindings.size >= 5000) {
        const oldestKey = this.cacheHintBindings.keys().next().value;
        if (oldestKey) this.cacheHintBindings.delete(oldestKey);
      }
    }
    this.cacheHintBindings.set(hintKey, {
      accountId,
      expiresAt: now + ttlMs,
    });
  }

  getCacheHint(hintKey: string): string | null {
    const entry = this.cacheHintBindings.get(hintKey);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.cacheHintBindings.delete(hintKey);
      return null;
    }
    return entry.accountId;
  }

  clearCacheHints(): void {
    this.cacheHintBindings.clear();
  }

  clearSessionBindingsForUnavailableAccounts(availableAccountIds: ReadonlySet<string>): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (!availableAccountIds.has(binding.accountId)) {
        this.sessionBindings.delete(sessionKey);
      }
    }
    for (const [hintKey, hint] of this.cacheHintBindings.entries()) {
      if (!availableAccountIds.has(hint.accountId)) {
        this.cacheHintBindings.delete(hintKey);
      }
    }
  }

  resetSelectionState(): void {
    this.currentIndex = 0;
  }

  recordParityError(
    config: AccountLeaseSelectionConfig,
    logger: AccountLeaseSelectionLogger,
  ): void {
    if (!this.isParitySchedulingEnabled(config)) {
      return;
    }

    this.parityErrorCount++;
    const errorRate = this.parityErrorCount / Math.max(1, this.parityRequestCount);
    if (errorRate > config.noGoErrorRateThreshold) {
      this.noGoBlocked = true;
      logger.error(
        `Parity no-go triggered by error threshold: rate=${errorRate.toFixed(4)}, requests=${this.parityRequestCount}, errors=${this.parityErrorCount}`,
      );
    }
  }

  isParitySchedulingEnabled(config: AccountLeaseSelectionConfig): boolean {
    if (this.noGoBlocked) {
      return false;
    }
    return config.parityEnabled;
  }

  shouldExecuteShadowComparison(config: AccountLeaseSelectionConfig): boolean {
    return config.parityShadowEnabled && !this.isParitySchedulingEnabled(config);
  }

  async selectCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): Promise<AccountLeaseSelectionEntry<T> | null> {
    this.clearExpiredSessionBindings(request.now);

    if (this.shouldExecuteShadowComparison(request.config)) {
      this.executeShadowComparison(request);
    }

    const selectedTokenEntry = this.isParitySchedulingEnabled(request.config)
      ? await this.selectParityTokenCandidate(request)
      : this.selectLegacyTokenCandidate(request);

    if (selectedTokenEntry && this.isParitySchedulingEnabled(request.config)) {
      this.parityRequestCount++;
    }

    return selectedTokenEntry;
  }

  bindSession(
    sessionKey: string | undefined,
    accountId: string,
    expiresAt: number,
    expectedGeneration?: number,
  ): boolean {
    if (!sessionKey || !accountId) {
      return false;
    }
    // Hard session bindings are ONLY for verified session keys (Gate 9, T12-F04)
    if (!isVerifiedSessionKey(sessionKey)) {
      if (isHintSessionKey(sessionKey)) {
        this.recordCacheHint(sessionKey, accountId, Math.max(0, expiresAt - Date.now()));
      }
      return false;
    }
    const current = this.sessionBindings.get(sessionKey);
    const now = Date.now();
    if (current && current.expiresAt > now && current.tableIncarnation === this.tableIncarnation) {
      // If session is currently migrating, ordinary bindSession must NOT overwrite it (T10-F03)
      if (current.state === 'migrating') {
        return false;
      }
      // Strict version fencing: expected generation must match current generation
      if (expectedGeneration !== undefined && expectedGeneration !== current.generation) {
        return false;
      }
      // Cannot flip an active binding to another account without explicit migration (Probe C26)
      if (expectedGeneration !== undefined && current.state === 'active' && current.accountId !== accountId) {
        return false;
      }
      this.sessionBindings.set(sessionKey, {
        ...current,
        accountId,
        tableIncarnation: this.tableIncarnation,
        state: 'active',
        expiresAt,
        lastActivityAt: now,
      });
      return true;
    }

    // New binding or expired session re-binding initialization
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== 1 &&
      (!current || current.tableIncarnation !== this.tableIncarnation || expectedGeneration !== current.generation)
    ) {
      return false;
    }

    this.sessionBindings.set(sessionKey, {
      accountId,
      generation: current && current.tableIncarnation === this.tableIncarnation ? current.generation : 1,
      tableIncarnation: this.tableIncarnation,
      state: 'active',
      expiresAt,
      lastActivityAt: now,
    });
    return true;
  }

  getSessionBinding(sessionKey: string | undefined): SessionBindingEntry | null {
    if (!sessionKey) return null;
    const binding = this.sessionBindings.get(sessionKey);
    if (!binding || binding.expiresAt <= Date.now()) {
      return null;
    }
    return binding;
  }

  startSessionMigration(
    sessionKey: string | undefined,
    currentGeneration: number,
    targetAccountId: string,
    ownerRequestId?: string,
  ): MigrationCapability | null {
    if (!sessionKey || !ownerRequestId || !targetAccountId) return null;
    if (!isVerifiedSessionKey(sessionKey)) return null;
    const current = this.sessionBindings.get(sessionKey);
    if (!current) {
      return null;
    }
    if (current.tableIncarnation !== this.tableIncarnation) {
      return null;
    }
    const now = Date.now();

    // If currently migrating:
    if (current.state === 'migrating') {
      const isMigrationExpired = current.migrationExpiresAt ? now > current.migrationExpiresAt : false;
      // Allow the same owner to update candidate if previous candidate failed during failover (A -> B -> C)
      if (current.migrationOwnerRequestId === ownerRequestId && current.generation === currentGeneration) {
        this.sessionBindings.set(sessionKey, {
          ...current,
          tableIncarnation: this.tableIncarnation,
          migratingToAccountId: targetAccountId,
          migrationExpiresAt: now + 60000,
          lastActivityAt: now,
        });
        return {
          sessionKey,
          generation: current.generation,
          ownerRequestId,
          targetAccountId,
        };
      }
      // If previous migration expired/abandoned, allow new owner to take over
      if (isMigrationExpired) {
        const newGen = current.generation + 1;
        this.sessionBindings.set(sessionKey, {
          ...current,
          state: 'migrating',
          generation: newGen,
          tableIncarnation: this.tableIncarnation,
          migratingToAccountId: targetAccountId,
          migrationOwnerRequestId: ownerRequestId,
          migrationExpiresAt: now + 60000,
          lastActivityAt: now,
        });
        return {
          sessionKey,
          generation: newGen,
          ownerRequestId,
          targetAccountId,
        };
      }
      // Active migration owned by another request; reject concurrent migration (Probe C05, C09)
      return null;
    }

    if (current.generation !== currentGeneration) {
      return null;
    }

    const newGen = currentGeneration + 1;
    this.sessionBindings.set(sessionKey, {
      ...current,
      state: 'migrating',
      generation: newGen,
      tableIncarnation: this.tableIncarnation,
      migratingToAccountId: targetAccountId,
      migrationOwnerRequestId: ownerRequestId,
      migrationExpiresAt: now + 60000,
      lastActivityAt: now,
    });
    return {
      sessionKey,
      generation: newGen,
      ownerRequestId,
      targetAccountId,
    };
  }

  renewSessionMigration(
    sessionKey: string | undefined,
    expectedGeneration: number,
    ownerRequestId?: string,
    extensionMs = 30000,
  ): boolean {
    if (!sessionKey || !ownerRequestId) return false;
    const current = this.sessionBindings.get(sessionKey);
    if (!current || current.state !== 'migrating') return false;
    if (current.tableIncarnation !== this.tableIncarnation) return false;
    if (current.generation !== expectedGeneration) return false;
    if (current.migrationOwnerRequestId !== ownerRequestId) return false;
    const now = Date.now();
    if (current.migrationExpiresAt && now > current.migrationExpiresAt) return false;
    this.sessionBindings.set(sessionKey, {
      ...current,
      migrationExpiresAt: now + extensionMs,
      lastActivityAt: now,
    });
    return true;
  }

  failSessionMigrationCandidate(
    sessionKey: string | undefined,
    expectedGeneration: number,
    failedAccountId: string,
    ownerRequestId?: string,
  ): boolean {
    if (!sessionKey || !failedAccountId || !ownerRequestId) return false;
    const current = this.sessionBindings.get(sessionKey);
    if (!current || current.state !== 'migrating') return false;
    if (current.tableIncarnation !== this.tableIncarnation) return false;
    if (current.generation !== expectedGeneration) return false;
    if (current.migrationOwnerRequestId !== ownerRequestId) return false;
    if (current.migratingToAccountId === failedAccountId) {
      this.sessionBindings.set(sessionKey, {
        ...current,
        migratingToAccountId: undefined,
        lastActivityAt: Date.now(),
      });
      return true;
    }
    return false;
  }

  confirmSessionMigration(
    sessionKey: string | undefined,
    expectedGeneration: number,
    targetAccountId: string,
    ownerRequestId?: string,
    expiresAt?: number,
  ): boolean {
    if (!sessionKey || !targetAccountId || !ownerRequestId) return false;
    const current = this.sessionBindings.get(sessionKey);
    if (!current) {
      return false;
    }
    if (current.tableIncarnation !== this.tableIncarnation) {
      return false;
    }
    const now = Date.now();
    // Must be in migrating state (Probe C20)
    if (current.state !== 'migrating') {
      return false;
    }
    // Migration must not be expired
    if (current.migrationExpiresAt && now > current.migrationExpiresAt) {
      return false;
    }
    // Exact generation match
    if (current.generation !== expectedGeneration) {
      return false;
    }
    // Candidate account must equal requested target (Probe C07, C21)
    if (current.migratingToAccountId !== targetAccountId) {
      return false;
    }
    // Owner request ID must be present and match exactly (Probe C08, C22)
    if (current.migrationOwnerRequestId !== ownerRequestId) {
      return false;
    }
    this.sessionBindings.set(sessionKey, {
      accountId: targetAccountId,
      generation: expectedGeneration,
      tableIncarnation: this.tableIncarnation,
      state: 'active',
      migratingToAccountId: undefined,
      migrationOwnerRequestId: undefined,
      migrationExpiresAt: undefined,
      expiresAt: expiresAt ?? current.expiresAt,
      lastActivityAt: now,
    });
    return true;
  }

  private collectEligibleTokens<T>(
    allTokens: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
    now: number,
  ): Array<AccountLeaseSelectionEntry<T>> {
    const maxConcurrency = request.config.maxConcurrencyPerAccount ?? 8;
    return this.collectRateLimitEligibleTokens(allTokens, request).filter(([accountId]) => {
      const cooldownUntil = request.accountCooldowns.get(accountId);
      if (cooldownUntil && cooldownUntil > now) {
        return false;
      }
      if (request.getInFlightCount) {
        const inFlight = request.getInFlightCount(accountId);
        if (inFlight >= maxConcurrency) {
          return false;
        }
      }
      return true;
    });
  }

  private collectRateLimitEligibleTokens<T>(
    allTokens: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
  ): Array<AccountLeaseSelectionEntry<T>> {
    return allTokens.filter(([accountId]) =>
      !request.rateLimitTracker.isRateLimited(
        accountId,
        this.getEffectiveModelForAccount(request, accountId),
      ),
    );
  }

  private getEffectiveModelForAccount<T>(
    request: AccountLeaseSelectionRequest<T>,
    accountId: string,
  ): string | undefined {
    return request.getEffectiveModelForAccount?.(accountId) ?? request.model;
  }

  private getValidSessionBinding(
    sessionKey: string | undefined,
    now: number,
  ): SessionBindingEntry | null {
    if (!sessionKey) {
      return null;
    }
    const stickyBinding = this.sessionBindings.get(sessionKey);
    if (!stickyBinding || stickyBinding.expiresAt <= now) {
      return null;
    }
    return stickyBinding;
  }

  private findStickySessionToken<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    sessionKey: string | undefined,
    now: number,
  ): AccountLeaseSelectionEntry<T> | null {
    if (!sessionKey) {
      return null;
    }

    // 1. Hard verified session binding
    if (isVerifiedSessionKey(sessionKey)) {
      const stickyBinding = this.getValidSessionBinding(sessionKey, now);
      if (stickyBinding) {
        // In migrating state, do not speculatively route followers to unconfirmed migratingToAccountId
        const targetAccountId = stickyBinding.accountId;
        return candidates.find(([accountId]) => accountId === targetAccountId) ?? null;
      }
    }

    // 2. Cache-hint placement locality (soft affinity, no migration state, bounded storage)
    if (isHintSessionKey(sessionKey)) {
      const hintAccountId = this.getCacheHint(sessionKey);
      if (hintAccountId) {
        const hintCandidate = candidates.find(([accountId]) => accountId === hintAccountId);
        if (hintCandidate) {
          return hintCandidate;
        }
      }
    }

    return null;
  }

  private pickRoundRobinEntry<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
  ): AccountLeaseSelectionEntry<T> | null {
    if (candidates.length === 0) {
      return null;
    }
    const picked = candidates[this.currentIndex % candidates.length];
    this.currentIndex++;
    return picked;
  }

  private peekRoundRobinCandidateAccountId<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
  ): string | null {
    if (candidates.length === 0) {
      return null;
    }
    return candidates[this.currentIndex % candidates.length][0];
  }

  private getActiveSessionCount(accountId: string, now: number): number {
    let count = 0;
    const recentDemandWindowMs = 5 * 60 * 1000;
    for (const binding of this.sessionBindings.values()) {
      if (
        binding.accountId === accountId &&
        binding.expiresAt > now &&
        now - binding.lastActivityAt <= recentDemandWindowMs
      ) {
        count++;
      }
    }
    return count;
  }

  private pickBalancedEntry<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    let minWorkload = Infinity;
    const workloadCounts = new Map<string, number>();
    for (const [accountId] of candidates) {
      const activeSessions = this.getActiveSessionCount(accountId, request.now);
      const inFlight = request.getInFlightCount?.(accountId) ?? 0;
      const totalWorkload = activeSessions + inFlight;
      workloadCounts.set(accountId, totalWorkload);
      if (totalWorkload < minWorkload) {
        minWorkload = totalWorkload;
      }
    }

    const leastLoaded = candidates.filter(
      ([accountId]) => (workloadCounts.get(accountId) ?? 0) <= minWorkload,
    );

    if (leastLoaded.length === 1) {
      return leastLoaded[0];
    }

    if (request.getPerformanceScore) {
      const candidatesWithScores = leastLoaded.map((entry) => {
        const id = entry[0];
        const score =
          request.getPerformanceScore!(
            id,
            this.getEffectiveModelForAccount(request, id),
          ) ?? 0;
        return { entry, id, score };
      });

      let topScore = -Infinity;
      for (const item of candidatesWithScores) {
        if (item.score > topScore) {
          topScore = item.score;
        }
      }

      const nearTop = candidatesWithScores
        .filter((item) => item.score >= topScore - 0.05)
        .map((item) => item.entry);

      if (nearTop.length === 1) {
        return nearTop[0];
      }
      if (nearTop.length > 1) {
        const picked = nearTop[this.currentIndex % nearTop.length];
        this.currentIndex++;
        return picked;
      }
    }

    const picked = leastLoaded[this.currentIndex % leastLoaded.length];
    this.currentIndex++;
    return picked;
  }

  private peekBalancedCandidateAccountId<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
  ): string | null {
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0][0];
    }

    let minWorkload = Infinity;
    const workloadCounts = new Map<string, number>();
    for (const [accountId] of candidates) {
      const activeSessions = this.getActiveSessionCount(accountId, request.now);
      const inFlight = request.getInFlightCount?.(accountId) ?? 0;
      const totalWorkload = activeSessions + inFlight;
      workloadCounts.set(accountId, totalWorkload);
      if (totalWorkload < minWorkload) {
        minWorkload = totalWorkload;
      }
    }

    const leastLoaded = candidates.filter(
      ([accountId]) => (workloadCounts.get(accountId) ?? 0) <= minWorkload,
    );

    if (leastLoaded.length === 1) {
      return leastLoaded[0][0];
    }

    if (request.getPerformanceScore) {
      const candidatesWithScores = leastLoaded.map((entry) => {
        const id = entry[0];
        const score =
          request.getPerformanceScore!(
            id,
            this.getEffectiveModelForAccount(request, id),
          ) ?? 0;
        return { entry, id, score };
      });

      let topScore = -Infinity;
      for (const item of candidatesWithScores) {
        if (item.score > topScore) {
          topScore = item.score;
        }
      }

      const nearTop = candidatesWithScores
        .filter((item) => item.score >= topScore - 0.05)
        .map((item) => item.entry);

      if (nearTop.length === 1) {
        return nearTop[0][0];
      }
      if (nearTop.length > 1) {
        return nearTop[this.currentIndex % nearTop.length][0];
      }
    }

    return leastLoaded[this.currentIndex % leastLoaded.length][0];
  }

  private selectLegacyTokenCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    const availableTokens = this.collectEligibleTokens(request.allTokens, request, request.now);
    if (availableTokens.length === 0) {
      return null;
    }

    const preferred = this.findPreferredToken(
      availableTokens,
      request.config.preferredAccountId,
    );
    if (preferred) {
      return preferred;
    }

    const stickyToken = this.findStickySessionToken(
      availableTokens,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken;
    }

    return this.pickRoundRobinEntry(availableTokens);
  }

  private async selectParityTokenCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): Promise<AccountLeaseSelectionEntry<T> | null> {
    const availableTokens = this.collectEligibleTokens(request.allTokens, request, request.now);
    const preferred = this.findPreferredToken(availableTokens, request.config.preferredAccountId);
    if (preferred) {
      return preferred;
    }

    if (request.config.schedulingMode !== 'balance') {
      const stickyToken = this.findStickySessionToken(
        availableTokens,
        request.sessionKey,
        request.now,
      );
      if (stickyToken) {
        return stickyToken;
      }
    }

    if (request.config.schedulingMode === 'performance-first') {
      return this.pickHighestPerformanceEntry(availableTokens, request);
    }

    const stickyBinding = this.getValidSessionBinding(request.sessionKey, request.now);
    const hasBoundCandidate = request.allTokens.some(
      ([accountId]) => accountId === stickyBinding?.accountId,
    );
    if (stickyBinding && hasBoundCandidate && request.config.schedulingMode === 'cache-first' && !request.skipWait) {
      const waitSec = request.rateLimitTracker.getRemainingWaitSeconds(
        stickyBinding.accountId,
        this.getEffectiveModelForAccount(request, stickyBinding.accountId),
      );
      const waitMs = waitSec * 1000;
      if (waitMs > 0 && waitMs <= request.config.maxWaitMs) {
        await delay(waitMs);
        const postWaitNow = Date.now();
        this.clearExpiredSessionBindings(postWaitNow);
        const currentCandidates = request.getCurrentCandidates
          ? await request.getCurrentCandidates()
          : request.allTokens;
        const refreshedAvailable = this.collectEligibleTokens(
          currentCandidates,
          request,
          postWaitNow,
        );
        const refreshedBinding = this.getValidSessionBinding(request.sessionKey, postWaitNow);
        const stickyAfterWait = refreshedBinding
          ? refreshedAvailable.find(([accountId]) => accountId === refreshedBinding.accountId) ?? null
          : null;
        if (stickyAfterWait) {
          return stickyAfterWait;
        }
        return this.pickBalancedEntry(refreshedAvailable, request);
      }
    }

    return request.config.schedulingMode === 'balance'
      ? this.pickRoundRobinEntry(availableTokens)
      : this.pickBalancedEntry(availableTokens, request);
  }

  private pickHighestPerformanceEntry<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    if (candidates.length === 0) {
      return null;
    }
    return [...candidates].sort(([leftAccountId], [rightAccountId]) => {
      const leftScore = request.getPerformanceScore?.(
        leftAccountId,
        this.getEffectiveModelForAccount(request, leftAccountId),
      ) ?? 0;
      const rightScore = request.getPerformanceScore?.(
        rightAccountId,
        this.getEffectiveModelForAccount(request, rightAccountId),
      ) ?? 0;
      return rightScore - leftScore || compareCodeUnits(leftAccountId, rightAccountId);
    })[0];
  }

  private findPreferredToken<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    preferredAccountId: string | undefined,
  ): AccountLeaseSelectionEntry<T> | null {
    if (!preferredAccountId) {
      return null;
    }
    return candidates.find(([accountId]) => accountId === preferredAccountId) ?? null;
  }

  private predictLegacyAccountCandidateId<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): string | null {
    const availableTokens = this.collectEligibleTokens(request.allTokens, request, request.now);
    const candidateAccountPool =
      availableTokens.length > 0
        ? availableTokens
        : this.collectRateLimitEligibleTokens(request.allTokens, request);
    if (candidateAccountPool.length === 0) {
      return null;
    }

    const preferred = this.findPreferredToken(
      candidateAccountPool,
      request.config.preferredAccountId,
    );
    if (preferred) {
      return preferred[0];
    }

    const stickyToken = this.findStickySessionToken(
      candidateAccountPool,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(candidateAccountPool);
  }

  private predictParityAccountCandidateId<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): string | null {
    const availableTokens = this.collectEligibleTokens(request.allTokens, request, request.now);
    if (availableTokens.length === 0) {
      return null;
    }

    const preferred = this.findPreferredToken(availableTokens, request.config.preferredAccountId);
    if (preferred) {
      return preferred[0];
    }

    if (request.config.schedulingMode !== 'balance') {
      const stickyToken = this.findStickySessionToken(
        availableTokens,
        request.sessionKey,
        request.now,
      );
      if (stickyToken) {
        return stickyToken[0];
      }
    }

    if (request.config.schedulingMode === 'performance-first') {
      return this.pickHighestPerformanceEntry(availableTokens, request)?.[0] ?? null;
    }

    return request.config.schedulingMode === 'balance'
      ? this.peekRoundRobinCandidateAccountId(availableTokens)
      : this.peekBalancedCandidateAccountId(availableTokens, request);
  }

  private executeShadowComparison<T>(request: AccountLeaseSelectionRequest<T>): void {
    const legacyAccountId = this.predictLegacyAccountCandidateId(request);
    const parityAccountId = this.predictParityAccountCandidateId(request);

    this.updateShadowStats(legacyAccountId, parityAccountId, request);
  }

  private updateShadowStats<T>(
    legacyId: string | null,
    parityId: string | null,
    request: AccountLeaseSelectionRequest<T>,
  ): void {
    this.shadowComparisonCount++;

    if (legacyId !== parityId) {
      this.shadowMismatchCount++;
      request.logger.warn(
        `Parity shadow mismatch detected: legacy_candidate=${legacyId !== null}, parity_candidate=${parityId !== null}`,
      );
    }

    const mismatchRate = this.shadowMismatchCount / Math.max(1, this.shadowComparisonCount);
    if (mismatchRate > request.config.noGoMismatchRateThreshold) {
      this.noGoBlocked = true;
      request.logger.error(
        `Parity no-go triggered by mismatch threshold: rate=${mismatchRate.toFixed(4)}, comparisons=${this.shadowComparisonCount}`,
      );
    }
  }

  private clearExpiredSessionBindings(now: number): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (binding.expiresAt <= now) {
        this.sessionBindings.delete(sessionKey);
      }
    }
  }
}
