export type QuotaPoolFilter = 'all' | 'gemini' | 'argon' | 'third_party';
export type QuotaPoolId = 'gemini' | 'argon' | 'third_party';
export type QuotaWindowKind = '5h' | 'weekly';
export type QuotaPreset = '24h' | '7d' | '30d' | 'cycle';
export type ShiftVerdict = 'possible_nerf' | 'improved' | 'stable' | 'insufficient_data';
export type PaceStatus = 'ok' | 'tight' | 'will_exhaust' | 'unknown';

export interface QuotaResetEvent {
  observed_at: string;
  observed_ms: number;
  account_id: string;
  account_label: string;
  pool: QuotaPoolId;
  window: QuotaWindowKind;
  from_pct: number;
  to_pct: number;
  delta_pct: number;
  new_reset_time: string | null;
  boundary_accuracy: 'exact' | 'inferred';
}

export interface QuotaTimelinePoint {
  time: string;
  time_ms: number;
  pool_remaining_pct: number | null;
  pool_account_equivalents: number;
  active_accounts_count: number;
  stale_accounts_count: number;
  api_usd: number;
  requests: number;
  by_account: Record<string, number | null>;
  resets: QuotaResetEvent[];
}

export interface PeriodEfficiencyStats {
  from: string;
  to_exclusive: string;
  matched_api_usd: number;
  matched_tokens: number;
  sample_drain_pct: number;
  interval_count: number;
  usd_per_1pct: number | null;
  tokens_per_1pct: number | null;
  implied_100pct_usd: number | null;
  implied_monthly_usd: number | null;
  priced_coverage_pct: number | null;
  cache_hit_pct: number | null;
}

export interface EfficiencyComparison {
  verdict: ShiftVerdict;
  reason: string;
  usd_per_1pct_delta_pct: number | null;
  tokens_per_1pct_delta_pct: number | null;
  current: PeriodEfficiencyStats;
  baseline: PeriodEfficiencyStats;
}

export interface SessionUsageRow {
  session_key: string | null;
  label: string;
  requests: number;
  failed_requests: number;
  project_name: string;
  primary_model: string | null;
  accounts: string[];
  input_tokens: number;
  cache_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  cache_hit_pct: number | null;
  api_usd: number | null;
  cost_share_pct: number | null;
  estimated_quota_share_pct: number | null;
  first_seen: string;
  last_seen: string;
}

export interface ModelCostRow {
  model: string;
  canonical_model: string | null;
  pool: QuotaPoolId | 'other';
  requests: number;
  failed_requests: number;
  input_tokens: number;
  cache_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  api_usd: number | null;
  cache_savings_usd: number;
  cost_share_pct: number | null;
  priced: boolean;
}

export interface AccountQuotaCostRow {
  account_id: string;
  label: string;
  subscription_tier: string | null;
  monthly_usd: number | null;
  weekly_pct: number | null;
  weekly_reset_time: string | null;
  five_hour_pct: number | null;
  five_hour_reset_time: string | null;
  last_refresh_at: string | null;
  stale: boolean;
  requests: number;
  failed_requests: number;
  api_usd: number | null;
  roi_ratio: number | null;
  drain_pct: number;
  usd_per_1pct: number | null;
}

export interface OptimizationHint {
  id: string;
  severity: 'info' | 'warn';
  title: string;
  detail: string;
}

export interface QuotaAnalyticsResponse {
  range: { from: string; to_exclusive: string; preset: QuotaPreset; time_zone: 'Europe/Samara' };
  filters: {
    pool: QuotaPoolFilter;
    window: QuotaWindowKind;
    account_id: string | null;
    project_id: string | null;
    model: string | null;
    tier: string | null;
    split_at: string | null;
    idle_gap_minutes: number;
    min_delta_pp: number;
  };
  data_quality: {
    raw_retention_days: number;
    snapshot_retention_days: number;
    using_hourly_rollups: boolean;
    snapshots_count: number;
    priced_coverage_pct: number | null;
    unpriced_models: string[];
    heterogeneous_tiers: boolean;
    tier_breakdown: Array<{ tier: string; accounts: number }>;
  };
  summary: {
    api_usd: number;
    api_multiplier: number;
    cache_savings_usd: number;
    total_requests: number;
    measured_requests: number;
    failed_requests: number;
    input_tokens: number;
    cache_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    thought_tokens: number;
    cache_hit_pct: number | null;
    subscription_monthly_usd: number | null;
    period_subscription_usd: number | null;
    roi_ratio: number | null;
    pool_weekly_pct: number | null;
    pool_5h_pct: number | null;
    pool_account_equivalents: number;
    eligible_accounts: number;
    stale_accounts: number;
    nearest_reset_time: string | null;
    pace_delta_pct: number | null;
    elapsed_window_pct: number | null;
    active_minutes: number;
    active_hours: number;
    wall_hours: number;
    active_share_pct: number;
    burst_count: number;
    api_usd_per_active_hour: number | null;
    api_usd_per_active_minute: number | null;
    tokens_per_active_minute: number | null;
    quota_pct_per_active_hour: number | null;
    runway_active_hours: number | null;
    pace_status: PaceStatus;
    usd_per_1pct: number | null;
    tokens_per_1pct: number | null;
    implied_100pct_usd: number | null;
    implied_monthly_usd: number | null;
    verdict: ShiftVerdict;
    verdict_delta_pct: number | null;
  };
  timeline: QuotaTimelinePoint[];
  resets: QuotaResetEvent[];
  efficiency: EfficiencyComparison;
  sessions: SessionUsageRow[];
  by_model: ModelCostRow[];
  by_account: AccountQuotaCostRow[];
  spikes: Array<{ start: string; end: string; requests: number; api_usd: number; top_model: string | null }>;
  hints: OptimizationHint[];
}

export interface QuotaPricingPayload {
  config: {
    api_multiplier: number;
    tier_monthly_usd: Record<string, number>;
    account_monthly_usd: Record<string, number>;
    model_overrides: Record<string, { input: number; cached_input: number; cache_write?: number; output: number }>;
  };
  defaults: {
    tier_monthly_usd: Record<string, number>;
    models: Array<{
      canonical_model: string;
      input: number;
      cached_input: number;
      cache_write?: number;
      output: number;
      long_context_threshold?: number;
      long_input?: number;
      long_output?: number;
      source_label: string;
      as_of: string;
      note?: string;
    }>;
  };
}
