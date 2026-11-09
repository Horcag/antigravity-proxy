import { Injectable } from '@nestjs/common';
import { CloudAccountRepo } from '../modules/cloud-account/persistence/cloudHandler';
import { AccountLeaseService } from '../modules/proxy-gateway/server/account-lease.service';
import { getServerConfig } from '../server/server-config';
import { requestJournal, safeLabel } from './request-journal';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function block(value: { reason: string; remaining_seconds: number; unavailable_until: string } | undefined) {
  return value ? { remaining_seconds: finite(value.remaining_seconds), until: safeDate(value.unavailable_until) } : null;
}

@Injectable()
export class DashboardService {
  constructor(private readonly leases: AccountLeaseService) {}

  async snapshot() {
    const accounts = await CloudAccountRepo.getAccounts();
    const privateValues = accounts.flatMap((account) => [account.token.access_token, account.token.refresh_token, account.token.id_token ?? '']);
    const label = (value: unknown, fallback = 'unknown') => safeLabel(value, fallback, privateValues);
    const diagnostics = this.leases.getQuotaDiagnostics();
    const journal = requestJournal.snapshot();
    return {
      updated_at: new Date().toISOString(),
      accounts: accounts.map((account, index) => {
        const quota = Object.entries(account.quota?.models ?? {}).map(([model, item]) => ({
          model: label(model), remaining_percentage: finite(item.percentage), reset_time: safeDate(item.resetTime),
        }));
        const forbidden = Boolean(account.quota?.is_forbidden || account.quota?.isForbidden);
        const tosBlocked = account.status_reason === 'TOS_VIOLATION';
        const status = forbidden || tosBlocked ? 'disabled' : account.status === 'expired' ? 'expired' : account.status === 'rate_limited' ? 'rate_limited' : 'active';
        return {
          label: `account-${index + 1}`, name: label(account.name || account.email, `account-${index + 1}`),
          provider: account.provider === 'anthropic' ? 'anthropic' : 'google', status,
          availability: status !== 'active' ? 'unavailable' : quota.length === 0 ? 'unknown' : quota.some((item) => (item.remaining_percentage ?? 0) > 0) ? 'available' : 'unavailable',
          reason: tosBlocked ? 'Блокировка сервиса (ToS)' : forbidden ? 'Доступ запрещён' : status === 'expired' ? 'Требуется авторизация' : status === 'rate_limited' ? 'Ограничение частоты' : null,
          quota,
        };
      }),
      runtime: diagnostics.accounts.map((account) => ({
        label: label(account.account_label), status: label(account.status),
        refresh_state: label(account.refresh_state), cooldown: block(account.account_cooldown),
        models: account.models.map((model) => ({
          model: label(model.public_model_id), requestable: model.requestable,
          remaining_percentage: finite(model.remaining_percentage), cooldown: block(model.temporary_block),
        })),
      })),
      projects: (getServerConfig()?.projects ?? []).map((project) => ({
        id: label(project.id), name: label(project.name), enabled: project.enabled,
        recent_requests: journal.entries.filter((entry) => entry.project_id === project.id).length,
        recent_errors: journal.entries.filter((entry) => entry.project_id === project.id && entry.status >= 400).length,
      })),
      journal,
    };
  }
}
