import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { accountAccessCheckIdentity, type AccountAccessCheck } from '@/modules/cloud-account/access-check';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';
import { buildUserAgent, FALLBACK_VERSION, resolveLocalInstalledVersion } from '@/modules/proxy-gateway/server/request-user-agent';
import { classifyUpstreamFailure } from '@/modules/proxy-gateway/server/upstream-failure';

type ProbeResult = Pick<AccountAccessCheck, 'outcome' | 'reason' | 'message' | 'evidence'>;
const MAX_BODY_BYTES = 65536;
const CHECK_TIMEOUT_MS = 24000;

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function hasGeneratedText(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as { response?: unknown; candidates?: unknown; error?: unknown };
  if (record.error) return false;
  if (record.response !== undefined) return hasGeneratedText(record.response);
  return Array.isArray(record.candidates) && record.candidates.some((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const content = (candidate as { content?: { role?: unknown; parts?: unknown } }).content;
    if (content?.role !== undefined && content.role !== 'model') return false;
    const parts = content?.parts;
    return Array.isArray(parts) && parts.some((part: unknown) => Boolean(part && typeof part === 'object'
      && typeof (part as { text?: unknown }).text === 'string' && (part as { thought?: unknown }).thought !== true && (part as { text: string }).text.trim()));
  });
}

export class AccountAccessCheckService {
  private readonly pending = new Map<string, Promise<AccountAccessCheck>>();
  private batch?: Promise<{ results: AccountAccessCheck[] }>;

  check(id: string): Promise<AccountAccessCheck> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const operation = this.run(id).finally(() => this.pending.delete(id));
    this.pending.set(id, operation);
    return operation;
  }

  checkAll(): Promise<{ results: AccountAccessCheck[] }> {
    if (this.batch) return this.batch;
    this.batch = (async () => {
      const results: AccountAccessCheck[] = [];
      for (const account of await CloudAccountRepo.getAccounts()) {
        try { results.push(await this.check(account.id)); }
        catch (error) { if (!(error instanceof NotFoundException)) throw error; }
      }
      return { results };
    })().finally(() => { this.batch = undefined; });
    return this.batch;
  }

  private async run(id: string): Promise<AccountAccessCheck> {
    const account = await CloudAccountRepo.getAccount(id);
    if (!account) throw new NotFoundException('Account not found');
    const previous = CloudAccountRepo.getAccessCheck(id);
    const baselineBan = /^(?:gcp_)?tos_violation$/i.test(account.status_reason ?? '');
    const priorBan = previous?.outcome === 'banned' || (previous?.outcome !== 'working' && baselineBan);
    const identity = { value: accountAccessCheckIdentity(account) };
    const probe = await this.probe(account, identity);
    const previousReason = previous?.reason ?? (baselineBan ? 'tos_violation' : undefined);
    const sameEvidence = !previous || (previous.message === probe.message && (['stage', 'model', 'http_status', 'rule_id'] as const)
      .every((key) => previous.evidence[key] === probe.evidence[key]));
    const result: AccountAccessCheck = {
      account_id: id, ...probe, checked_at: new Date().toISOString(),
      comparison: probe.outcome === 'working' && priorBan ? 'restored'
        : previousReason === undefined ? 'first'
        : previousReason === probe.reason && sameEvidence && (!previous || previous.outcome === probe.outcome) ? 'same' : 'changed',
      ...(previousReason ? { previous_reason: previousReason } : {}),
      ...(previous ? { previous_checked_at: previous.checked_at } : {}),
    };
    if (!CloudAccountRepo.saveAccessCheck(result, identity.value)) {
      return { account_id: id, outcome: 'inconclusive', reason: 'account_changed', checked_at: result.checked_at,
        comparison: 'changed', message: 'Учётные данные аккаунта изменились во время проверки. Повторите проверку.', evidence: result.evidence };
    }
    return result;
  }

  private async probe(account: CloudAccount, identity: { value: string }): Promise<ProbeResult> {
    if (account.provider !== 'google') return { outcome: 'inconclusive', reason: 'unsupported_provider', message: 'Проверка доступа поддерживает только аккаунты Google.', evidence: { stage: 'configuration' } };
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const proxyUrl = account.token.upstream_proxy_url || account.proxy_url;
    let token = account.token;
    let stage: 'oauth' | 'generation' = 'oauth';
    // Use the account's existing text model when known; no model/account fallback occurs.
    const models = Object.keys(account.quota?.models ?? {})
      .map((name) => account.quota?.model_forwarding_rules?.[name] || name)
      .filter((name) => /^gemini.*flash/i.test(name) && !/image/i.test(name))
      .sort((a, b) => Number(!/flash-lite/i.test(a)) - Number(!/flash-lite/i.test(b)) || b.localeCompare(a, 'en', { numeric: true }));
    const model = models.includes('gemini-3.5-flash-lite') ? 'gemini-3.5-flash-lite' : models[0] ?? 'gemini-3.5-flash-lite';
    try {
      const refresh = async () => {
        const refreshed = await GoogleAPIService.refreshAccessToken(token.refresh_token, proxyUrl, token.oauth_client_key, { signal, reportInvalidGrant: true });
        if (!refreshed.access_token || !Number.isFinite(refreshed.expires_in) || refreshed.expires_in <= 0) throw new Error('MALFORMED_OAUTH');
        token = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token,
          oauth_client_key: GoogleAPIService.normalizeRefreshedOAuthClientKey(token, refreshed.oauth_client_key),
          expiry_timestamp: Math.floor(Date.now() / 1000) + refreshed.expires_in };
        if (!CloudAccountRepo.updateTokenIfCurrent(account.id, token,
          () => CloudAccountRepo.getAccessCheckIdentity(account.id) === identity.value)) throw new Error('ACCOUNT_CHANGED');
        identity.value = accountAccessCheckIdentity({ ...account, token });
      };
      if (!token.access_token || token.expiry_timestamp <= Date.now() / 1000 + 30) await refresh();
      const userAgent = buildUserAgent(resolveLocalInstalledVersion() ?? FALLBACK_VERSION);
      const endpoint = new GeminiClient().getOrderedInternalBaseUrls()[0];
      const generate = () => fetch(`${endpoint}:generateContent`, {
        method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
        body: JSON.stringify({ requestId: randomUUID(), model, userAgent, requestType: 'agent',
          ...(token.project_id ? { project: token.project_id } : {}), enabledCreditTypes: ['GOOGLE_ONE_AI'],
          request: { contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }], generationConfig: { maxOutputTokens: 16, temperature: 0 } } }),
        signal, ...GoogleAPIService.getFetchOptions(proxyUrl),
      });
      stage = 'generation';
      let response = await generate();
      if (response.status === 401) {
        await response.body?.cancel();
        stage = 'oauth';
        await refresh();
        stage = 'generation';
        response = await generate();
      }
      const text = await readBoundedBody(response);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { /* Invalid success is inconclusive. */ }
      if (response.ok && hasGeneratedText(payload)) return { outcome: 'working', reason: 'generation_succeeded', message: 'Генерация выбранной моделью прошла успешно. Состояние аккаунта сохранено.', evidence: { stage, model, http_status: response.status } };
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const evidence = classifyUpstreamFailure({ statusCode: response.status, headers, errorText: text, modelName: model });
      const banned = evidence.ruleId === 'google.tos.violation' && evidence.confidence === 'explicit';
      return { outcome: banned ? 'banned' : 'inconclusive', reason: banned ? 'tos_violation' : response.ok && evidence.category === 'unknown' ? 'invalid_generation_response' : evidence.category,
        message: banned ? 'Google явно сообщает об ограничении аккаунта за нарушение условий использования.' : `Доступ к генерации не подтверждён. ${evidence.safeMessage}`,
        evidence: { stage, model, http_status: response.status, rule_id: evidence.ruleId } };
    } catch (error) {
      const revoked = stage === 'oauth' && error instanceof Error && error.message === 'OAUTH_INVALID_GRANT';
      return { outcome: 'inconclusive', reason: signal.aborted ? 'timeout' : revoked ? 'oauth_revoked' : stage === 'oauth' ? 'oauth_failed' : 'request_failed',
        message: revoked ? 'Обновление OAuth отклонено (invalid_grant); проверить генерацию не удалось.' : 'Проверка не подтвердила доступ к генерации. Состояние аккаунта сохранено.', evidence: { stage, model } };
    }
  }
}
