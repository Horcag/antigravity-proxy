import { BadRequestException, Body, Controller, Get, Header, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ConsoleConfigService } from './console-config.service';
import { ConsoleQuotaService } from './console-quota.service';
import { ConsoleGuard } from './session.service';

const quotaAnalyticsQuerySchema = z.object({
  from: z.string().refine((v) => Number.isFinite(Date.parse(v))).optional(),
  toExclusive: z.string().refine((v) => Number.isFinite(Date.parse(v))).optional(),
  preset: z.enum(['24h', '7d', '30d', 'cycle']).default('7d'),
  pool: z.enum(['all', 'gemini', 'argon', 'third_party']).default('all'),
  window: z.enum(['weekly', '5h']).default('weekly'),
  accountId: z.string().max(200).optional(),
  projectId: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  tier: z.string().max(100).optional(),
  splitAt: z.string().refine((v) => Number.isFinite(Date.parse(v))).optional(),
  idleGapMinutes: z.coerce.number().int().min(1).max(60).default(5),
  minDeltaPp: z.coerce.number().min(0.1).max(50).default(0.5),
}).strict();

const exportQuerySchema = quotaAnalyticsQuerySchema.extend({
  format: z.enum(['json', 'csv']).default('json'),
});

@Controller('admin/console')
@UseGuards(ConsoleGuard)
export class ConsoleQuotaController {
  constructor(
    private readonly quota: ConsoleQuotaService,
    private readonly config: ConsoleConfigService,
  ) {}

  @Get('quota-analytics')
  analytics(@Query() query: unknown) {
    const parsed = quotaAnalyticsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException('Invalid quota analytics query');
    }
    return this.quota.getAnalytics(parsed.data);
  }

  @Get('quota-pricing')
  getPricing() {
    return this.config.getQuotaPricing();
  }

  @Put('quota-pricing')
  putPricing(@Body() body: unknown) {
    return this.config.updateQuotaPricing(body);
  }

  @Get('quota-analytics/export')
  @Header('Cache-Control', 'no-store')
  async exportReport(@Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = exportQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException('Invalid quota export query');
    }
    const { format, ...rest } = parsed.data;
    const report = await this.quota.getAnalytics(rest);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="quota-analytics-${stamp}.csv"`);
      return this.quota.toCsv(report);
    }
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="quota-analytics-${stamp}.json"`);
    return JSON.stringify(report, null, 2);
  }
}
