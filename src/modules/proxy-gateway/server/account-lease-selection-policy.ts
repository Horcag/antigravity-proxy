export type AccountLeaseSelectionMode = 'cache-first' | 'balance' | 'performance-first';
export type AccountLeaseSelectionEntry<T> = [string, T];

export interface AccountLeaseRateLimitReader {
  isRateLimited(accountId: string, model?: string): boolean;
  getRemainingWaitSeconds(accountId: string, model?: string): number;
}

export interface AccountLeaseSelectionConfig {
  parityEnabled: boolean;
  parityShadowEnabled: boolean;
  schedulingMode: AccountLeaseSelectionMode;
  preferredAccountId?: string;
  maxWaitMs: number;
  noGoMismatchRateThreshold: number;
  noGoErrorRateThreshold: number;
}

interface AccountLeaseSelectionLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface AccountLeaseSelectionRequest<T> {
  allTokens: Array<AccountLeaseSelectionEntry<T>>;
  getCurrentCandidates?: () => Promise<Array<AccountLeaseSelectionEntry<T>>>;
  sessionKey?: string;
  model?: string;
  getEffectiveModelForAccount?: (accountId: string) => string | undefined;
  getPerformanceScore?: (accountId: string, effectiveModel: string | undefined) => number;
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
  private sessionBindings: Map<string, { accountId: string; expiresAt: number }> = new Map();
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
    this.sessionBindings.clear();
  }

  clearSessionBindingsForUnavailableAccounts(availableAccountIds: ReadonlySet<string>): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (!availableAccountIds.has(binding.accountId)) {
        this.sessionBindings.delete(sessionKey);
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

  bindSession(sessionKey: string | undefined, accountId: string, expiresAt: number): void {
    if (!sessionKey) {
      return;
    }
    this.sessionBindings.set(sessionKey, {
      accountId,
      expiresAt,
    });
  }

  private collectEligibleTokens<T>(
    allTokens: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
    now: number,
  ): Array<AccountLeaseSelectionEntry<T>> {
    return this.collectRateLimitEligibleTokens(allTokens, request).filter(([accountId]) => {
      const cooldownUntil = request.accountCooldowns.get(accountId);
      return !cooldownUntil || cooldownUntil <= now;
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
  ): { accountId: string; expiresAt: number } | null {
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
    const stickyBinding = this.getValidSessionBinding(sessionKey, now);
    if (!stickyBinding) {
      return null;
    }

    return candidates.find(([accountId]) => accountId === stickyBinding.accountId) ?? null;
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

  private selectLegacyTokenCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    const availableTokens = this.collectEligibleTokens(request.allTokens, request, request.now);
    const candidateAccountPool =
      availableTokens.length > 0
        ? availableTokens
        : this.collectRateLimitEligibleTokens(request.allTokens, request);
    if (candidateAccountPool.length === 0) {
      return null;
    }

    if (availableTokens.length === 0) {
      request.logger.warn(
        'All accounts are cooling down; temporarily bypassing cooldown gate to preserve availability',
      );
    }

    const preferred = this.findPreferredToken(
      candidateAccountPool,
      request.config.preferredAccountId,
    );
    if (preferred) {
      return preferred;
    }

    const stickyToken = this.findStickySessionToken(
      candidateAccountPool,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken;
    }

    return this.pickRoundRobinEntry(candidateAccountPool);
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
    if (stickyBinding && hasBoundCandidate && request.config.schedulingMode === 'cache-first') {
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
        return this.pickRoundRobinEntry(refreshedAvailable);
      }
    }

    return this.pickRoundRobinEntry(availableTokens);
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

    return this.peekRoundRobinCandidateAccountId(availableTokens);
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
