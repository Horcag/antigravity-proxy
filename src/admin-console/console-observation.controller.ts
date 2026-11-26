import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { getAccountStats, getRequestHistory, getUsageSummary } from '@/observability/request-history';
import { ConsoleGuard } from './session.service';
const filtersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  accountId: z.string().max(200).optional(), projectId: z.string().max(200).optional(), model: z.string().max(200).optional(),
  finalAccountId: z.string().max(200).optional(),
  sessionKey: z.string().max(200).optional(),
  attemptOutcome: z.enum(['success', 'failure', 'unknown']).optional(),
  metric: z.enum(['input_tokens', 'output_tokens', 'cache_tokens', 'ttft_ms', 'duration_ms']).optional(),
  missingModel: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  result: z.enum(['success', 'failure', 'none']).optional(),
  status: z.union([z.enum(['success', 'error', 'failure']), z.string().regex(/^[1-5][0-9]{2}$/)]).optional(),
  from: z.string().refine((v) => Number.isFinite(Date.parse(v))).optional(),
  to: z.string().refine((v) => Number.isFinite(Date.parse(v))).optional(),
  toExclusive: z.string().refine((v) => Number.isFinite(Date.parse(v))).optional(),
}).strict();
const statisticsSchema = filtersSchema.extend({ granularity: z.enum(['minute', 'five_minutes', 'hour', 'day']).default('hour') });
function filters(query: unknown) {
  const parsed = filtersSchema.safeParse(query);
  if (!parsed.success) throw new BadRequestException('Invalid request history filters');
  return parsed.data;
}
@Controller('admin/console')
@UseGuards(ConsoleGuard)
export class ConsoleObservationController {
  @Get('requests') requests(@Query() query: unknown) { return getRequestHistory(filters(query)); }
  @Get('statistics') statistics(@Query() query: unknown) {
    const parsed = statisticsSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid request history filters');
    const { granularity, ...selected } = parsed.data;
    return { ...getUsageSummary(selected, granularity), accounts: getAccountStats(selected) };
  }
  @Get('account-stats') accountStats(@Query() query: unknown) { return getAccountStats(filters(query)); }
  @Get('metadata') metadata() {
    return { backend: 'antigravity-proxy', api_version: 1,
      capabilities: ['accounts', 'oauth_callback', 'oauth_manual_callback', 'quota_refresh', 'quota_analytics', 'quota_pricing', 'models', 'aliases', 'projects', 'settings', 'requests', 'statistics', 'account_stats'],
      unsupported: ['external_api_call', 'plugins', 'arbitrary_config', 'provider_keys'],
      statistics: { source: 'persistent_request_metadata', retention_days: 7, max_entries: 100_000,
        historical_backfill: false, missing_token_counts: null, missing_ttft: null } };
  }
}
