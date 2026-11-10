export interface Account {
  id: string;
  name: string;
  email: string;
  provider: string;
  status: string;
  status_reason?: string;
  disabled: boolean;
  review_required: boolean;
  quota?: {
    models: Record<string, { percentage: number; resetTime: string }>;
    last_successful_refresh_at?: number;
    subscription_tier?: string;
  };
  created_at?: string;
  last_used?: string;
}
export interface Project {
  id: string;
  name: string;
  enabled: boolean;
  model_mapping?: Record<string, string>;
  api_key?: string;
}
export interface Settings {
  scheduling_mode: string;
  max_wait_seconds: number;
  max_concurrency_per_account: number;
  request_timeout: number;
  custom_mapping: Record<string, string>;
  anthropic_mapping: Record<string, string>;
}
export interface Aliases {
  custom_mapping: Record<string, string>;
  anthropic_mapping: Record<string, string>;
}
export interface RequestEntry {
  id: string;
  request_id: string;
  time: string;
  protocol: string;
  request_kind?: 'inference' | 'service' | 'probe' | 'unknown';
  authorization_source?: 'client' | 'pool' | 'unknown';
  route: string;
  model: string | null;
  requested_model: string | null;
  effective_model: string | null;
  project_id: string;
  project_name: string;
  account_id: string | null;
  status: number;
  grpc_status: string | null;
  error_category: string | null;
  duration_ms: number;
  ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  attempts: Array<{
    account_id: string;
    effective_model?: string | null;
    outcome: string;
    error_category?: string | null;
    ttft_ms?: number | null;
  }>;
}
export interface Metric {
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  avg_duration_ms: number | null;
  avg_ttft_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
}
export interface AccountMetric {
  account_id: string;
  success_attempts: number;
  failed_attempts: number;
  unknown_attempts: number;
  logical_requests: number;
  avg_ttft_ms: number | null;
  avg_duration_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}
export type StatisticsGranularity = 'minute' | 'five_minutes' | 'hour' | 'day';
export interface StatisticsBucket {
  start: string;
  end: string;
  total_requests: number;
  failed_requests: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
}
export interface Statistics extends Metric {
  buckets: StatisticsBucket[];
  granularity: StatisticsGranularity;
  time_zone: string;
  range: { from: string | null; toExclusive: string | null };
  accounts: AccountMetric[];
  by_model: Array<Metric & { model: string | null }>;
  by_hour: Array<{ hour: string; total_requests: number; failed_requests: number }>;
  by_day: Array<{ date: string; total_requests: number; failed_requests: number }>;
  retention_days: number;
  max_entries: number;
}
