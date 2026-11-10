import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { getServerConfig } from '@/server/server-config';
import { AccountLeaseService } from '../account-lease.service';
import { fetchNativeSpeechModels } from './native-speech-catalog';

export interface NativeSpeechAuthorization {
  accountId: string;
  accessToken: string;
  projectId?: string;
  upstreamProxyUrl?: string;
  models: string[];
  release: () => void;
}

export class NativeSpeechAuthorizationError extends HttpException {
  constructor(readonly code: 'account_unavailable' | 'catalog_unavailable' | 'model_unavailable') {
    const message = code === 'account_unavailable'
      ? 'No eligible account is available for native speech'
      : code === 'catalog_unavailable'
        ? 'Native speech model catalog could not be read'
        : 'The selected account does not advertise the requested native speech model';
    super({ error: { code, message } }, code === 'model_unavailable' ? 400 : code === 'catalog_unavailable' ? 502 : 503);
  }
}

@Injectable()
export class NativeSpeechAuth {
  private cached?: { accountId: string; accessToken: string; expiresAt: number; models: string[] };

  constructor(@Inject(AccountLeaseService) private readonly leases: AccountLeaseService) {}

  async resolve(signal?: AbortSignal, requestedModel?: string): Promise<NativeSpeechAuthorization> {
    const lease = await this.leases.acquireAttemptLease({ signal });
    if (!lease) throw new NativeSpeechAuthorizationError('account_unavailable');
    const { account } = lease;
    const accountId = account.id;
    if (signal?.aborted) { lease.releaseReservation(); throw new NativeSpeechAuthorizationError('account_unavailable'); }

    const token = account.token.access_token;
    let models: string[];
    if (this.cached?.accountId === accountId && this.cached.accessToken === token && this.cached.expiresAt > Date.now()) {
      models = this.cached.models;
    } else {
      try {
        models = await this.fetchCatalog(account, signal);
        this.cached = { accountId, accessToken: token, expiresAt: Date.now() + 5 * 60_000, models };
      } catch (error) {
        lease.releaseReservation();
        throw error;
      }
    }
    if (requestedModel && !models.includes(requestedModel)) {
      lease.releaseReservation();
      throw new NativeSpeechAuthorizationError('model_unavailable');
    }
    return {
      accountId,
      accessToken: token,
      // CloudCode's companion project is not a consumer speech billing project.
      projectId: account.token.is_gcp_tos ? account.token.project_id : undefined,
      upstreamProxyUrl: this.resolveProxyUrl(account),
      models,
      release: lease.releaseReservation,
    };
  }

  async suspend(accountId: string): Promise<void> {
    if (!accountId) throw new NativeSpeechAuthorizationError('account_unavailable');
    this.leases.markAsForbidden(accountId, 'tos_violation');
    await this.leases.waitForAccountSuspension(accountId);
    if (this.cached?.accountId === accountId) this.cached = undefined;
  }

  private async fetchCatalog(account: CloudAccount, signal?: AbortSignal): Promise<string[]> {
    try {
      return await fetchNativeSpeechModels(
        account.token.access_token,
        account.token.project_id,
        this.resolveProxyUrl(account),
        signal,
      );
    } catch {
      throw new NativeSpeechAuthorizationError('catalog_unavailable');
    }
  }

  private resolveProxyUrl(account: CloudAccount): string | undefined {
    const accountProxy = account.token.upstream_proxy_url || account.proxy_url;
    if (accountProxy) return accountProxy;
    const configured = getServerConfig()?.upstream_proxy;
    if (configured?.enabled && configured.url) return configured.url;
    return process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim() || process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim() || undefined;
  }
}
