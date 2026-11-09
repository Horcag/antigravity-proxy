import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AdminService } from '@/admin/admin.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountExportSchema, type CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';

export function needsAccountReview(account: Pick<CloudAccount, 'status_reason' | 'quota'>): boolean {
  return Boolean(account.quota?.is_forbidden || account.quota?.isForbidden || (account.status_reason !== 'operator_disabled' && /tos|terms|banned|disabled|forbidden|violation|suspend|3501/i.test(account.status_reason ?? '')));
}
const cpaAccount = z.object({
  type: z.literal('antigravity').optional(), provider: z.literal('google').optional(),
  email: z.string().trim().min(1), name: z.string().optional(),
  refresh_token: z.string().min(1), access_token: z.string().optional(),
  expiry: z.string().datetime({ offset: true }).optional(), expired: z.string().datetime({ offset: true }).optional(),
  project_id: z.string().optional(), disabled: z.boolean().optional(),
});
@Injectable()
export class ConsoleAccountsService {
  constructor(private readonly admin: AdminService, private readonly leases: AccountLeaseService) {}
  async list() {
    return (await this.admin.listAccounts()).map((account) => ({
      id: account.id, name: account.name ?? account.email, email: account.email, provider: account.provider,
      status: account.status, status_reason: account.status_reason, disabled: account.status === 'expired',
      review_required: needsAccountReview(account), quota: account.quota, created_at: account.created_at,
      last_used: account.last_used,
    }));
  }
  async setDisabled(id: string, body: unknown) {
    const result = z.object({ disabled: z.boolean(), confirmReview: z.boolean().optional() }).strict().safeParse(body);
    if (!result.success) throw new BadRequestException('Expected disabled boolean');
    const account = await CloudAccountRepo.getAccount(id);
    if (!account) throw new NotFoundException('Account not found');
    if (!result.data.disabled && needsAccountReview(account) && result.data.confirmReview !== true) {
      throw new ConflictException('Account requires explicit review confirmation before enabling');
    }
    await CloudAccountRepo.updateStatus(id, result.data.disabled ? 'expired' : 'active',
      result.data.disabled ? account.status_reason ?? 'operator_disabled' : undefined);
    await this.leases.reloadAllAccounts();
    return (await this.list()).find((a) => a.id === id);
  }
  async import(body: unknown) {
    let candidate = body;
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (record && 'refresh_token' in record) {
      const parsed = cpaAccount.safeParse(record);
      if (!parsed.success) throw new BadRequestException('Invalid Antigravity auth file');
      const input = parsed.data;
      const expiry = input.expiry ?? input.expired;
      candidate = { version: '1.0', exportedAt: Math.floor(Date.now() / 1000), accounts: [{
        provider: 'google', email: input.email, name: input.name,
        token: { access_token: input.access_token ?? '', refresh_token: input.refresh_token, token_type: 'Bearer',
          expires_in: 3600, expiry_timestamp: expiry ? Math.floor(Date.parse(expiry) / 1000) : 0,
          email: input.email, project_id: input.project_id },
        ...(input.disabled ? { status: 'expired', status_reason: 'operator_disabled' } : {}),
      }] };
    } else if (record && !('version' in record)) {
      candidate = { version: '1.0', exportedAt: Math.floor(Date.now() / 1000), accounts: record.accounts };
    }
    const parsed = CloudAccountExportSchema.safeParse(candidate);
    if (!parsed.success) throw new BadRequestException('Invalid account import payload');
    // Validate and inspect the complete payload before AdminService can write its first entry.
    for (const account of parsed.data.accounts) {
      if (!account.token?.refresh_token || !account.email.trim()) throw new BadRequestException('Every imported account requires email and refresh token');
      const existing = await CloudAccountRepo.getAccountByEmail(account.email);
      if (existing && (existing.status === 'expired' || needsAccountReview(existing))) {
        account.status = existing.status;
        account.status_reason = existing.status_reason;
        account.quota = existing.quota;
      }
    }
    const result = await this.admin.importAccounts(parsed.data);
    return { imported: result.imported, skipped: result.skipped, accounts: await this.list() };
  }
}
