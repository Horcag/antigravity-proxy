import { isEmpty, isNumber, isString } from 'lodash-es';
import type { CloudQuotaData } from '@/modules/cloud-account/types';
import type { AccountLeaseTokenData } from './account-lease-token-types';
import type { PoolAccountQuotaProjection, PoolModelQuotaEntry, PoolQuotaProjectionSnapshot } from './cloudcode-quota-projection';

const THIRD_PARTY_QUOTA_GROUP_PATTERN = /claude|gpt|3p/i;
const ARGON_QUOTA_GROUP_PATTERN = /argon/i;
const GEMINI_QUOTA_GROUP_PATTERN = /gemini/i;

export interface AccountLeaseQuotaSnapshot {
  modelQuotas: Record<string, number>;
  modelLimits: Record<string, number>;
  modelResetTimes: Record<string, string>;
  modelForwardingRules: Record<string, string>;
}

function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }
  const normalized = modelId.replace(/^models\//i, '').trim();
  return normalized !== '' ? normalized : undefined;
}

export type QuotaPoolKind = 'third_party' | 'argon' | 'gemini';

export function classifyModelQuotaPool(modelName: string): QuotaPoolKind | null {
  const normalized = modelName.toLowerCase();
  if (normalized.includes('claude') || normalized.includes('gpt')) {
    return 'third_party';
  }
  if (normalized.includes('argon')) {
    return 'argon';
  }
  if (normalized.startsWith('gemini') && !normalized.includes('image') && !normalized.endsWith('-sonar')) {
    return 'gemini';
  }
  return null;
}

export function classifyQuotaBucketPool(groupText: string, bucketText: string): QuotaPoolKind | null {
  if (THIRD_PARTY_QUOTA_GROUP_PATTERN.test(groupText) || THIRD_PARTY_QUOTA_GROUP_PATTERN.test(bucketText)) {
    return 'third_party';
  }
  if (ARGON_QUOTA_GROUP_PATTERN.test(groupText) || ARGON_QUOTA_GROUP_PATTERN.test(bucketText)) {
    return 'argon';
  }
  if (GEMINI_QUOTA_GROUP_PATTERN.test(groupText) || GEMINI_QUOTA_GROUP_PATTERN.test(bucketText)) {
    return 'gemini';
  }
  return null;
}

function extractQuotaPoolFloors(
  quota: CloudQuotaData | undefined,
): Partial<Record<QuotaPoolKind, { percentage: number; resetTime: string }>> {
  const floors: Partial<Record<QuotaPoolKind, { percentage: number; resetTime: string }>> = {};

  for (const group of quota?.quota_groups ?? []) {
    const groupText = [group.display_name, group.description].filter(Boolean).join(' ');

    for (const bucket of group.buckets) {
      const bucketText = [bucket.bucket_id, bucket.window, bucket.display_name, bucket.description]
        .filter(Boolean)
        .join(' ');
      const pool = classifyQuotaBucketPool(groupText, bucketText);
      if (!pool) {
        continue;
      }

      const percentage = Math.floor(bucket.remaining_fraction * 100);
      if (!Number.isFinite(percentage)) {
        continue;
      }

      const current = floors[pool];
      if (
        !current ||
        percentage < current.percentage ||
        (percentage === current.percentage && bucket.reset_time < current.resetTime)
      ) {
        floors[pool] = {
          percentage,
          resetTime: bucket.reset_time,
        };
      }
    }
  }

  return floors;
}

export function buildAccountLeaseQuotaSnapshot(
  quota: CloudQuotaData | undefined,
): AccountLeaseQuotaSnapshot {
  const modelQuotas: Record<string, number> = {};
  const modelLimits: Record<string, number> = {};
  const modelResetTimes: Record<string, string> = {};
  const modelForwardingRules: Record<string, string> = {};

  for (const [modelName, modelInfo] of Object.entries(quota?.models ?? {})) {
    const normalizedModel = normalizeModelId(modelName);
    if (!normalizedModel) {
      continue;
    }

    if (Number.isFinite(modelInfo.percentage)) {
      modelQuotas[normalizedModel] = Math.floor(modelInfo.percentage);
    }

    const limitCandidate = modelInfo.max_output_tokens ?? modelInfo.max_tokens;
    if (isNumber(limitCandidate) && Number.isFinite(limitCandidate) && limitCandidate > 0) {
      modelLimits[normalizedModel] = Math.floor(limitCandidate);
    }

    if (isString(modelInfo.resetTime) && !isEmpty(modelInfo.resetTime.trim())) {
      modelResetTimes[normalizedModel] = modelInfo.resetTime;
    }
  }

  const poolFloors = extractQuotaPoolFloors(quota);
  for (const modelName of Object.keys(modelQuotas)) {
    const pool = classifyModelQuotaPool(modelName);
    const floor = pool ? poolFloors[pool] : undefined;
    if (!floor) {
      continue;
    }

    if (floor.percentage < modelQuotas[modelName]) {
      modelQuotas[modelName] = floor.percentage;
      if (!isEmpty(floor.resetTime)) {
        modelResetTimes[modelName] = floor.resetTime;
      }
    }
  }

  for (const [oldModel, newModel] of Object.entries(quota?.model_forwarding_rules ?? {})) {
    const normalizedOld = normalizeModelId(oldModel);
    const normalizedNew = normalizeModelId(newModel);
    if (!normalizedOld || !normalizedNew) {
      continue;
    }
    modelForwardingRules[normalizedOld] = normalizedNew;
  }

  return {
    modelQuotas,
    modelLimits,
    modelResetTimes,
    modelForwardingRules,
  };
}

export function buildPoolQuotaProjectionSnapshot(params: {
  tokens: Map<string, AccountLeaseTokenData>;
  availabilityEntries: Array<{ accountId: string; modelId: string; unavailableUntil: number }>;
  lockouts: Array<{ accountId: string; modelId?: string; unavailableUntil: number }>;
  accountCooldownIds: Iterable<string>;
}): PoolQuotaProjectionSnapshot {
  const availabilityByAccountModel = new Map(
    params.availabilityEntries.map((entry) => [`${entry.accountId}:${entry.modelId.toLowerCase()}`, entry] as const),
  );
  const modelLockouts = new Map(
    params.lockouts
      .filter((entry) => entry.modelId)
      .map((entry) => [`${entry.accountId}:${(entry.modelId as string).toLowerCase()}`, entry] as const),
  );
  const accountCooldowns = new Set(params.accountCooldownIds);
  const accountLockouts = new Set(
    params.lockouts.filter((entry) => !entry.modelId).map((entry) => entry.accountId),
  );

  const accounts: PoolAccountQuotaProjection[] = [];
  for (const [accountId, tokenData] of params.tokens.entries()) {
    if (tokenData.status === 'expired' || accountCooldowns.has(accountId) || accountLockouts.has(accountId)) {
      continue;
    }

    const models: Record<string, PoolModelQuotaEntry> = {};
    for (const [rawModelId, pct] of Object.entries(tokenData.model_quotas ?? {})) {
      const normalized = normalizeModelId(rawModelId);
      if (!normalized) continue;
      const lower = normalized.toLowerCase();
      const block =
        modelLockouts.get(`${accountId}:${lower}`) ??
        availabilityByAccountModel.get(`${accountId}:${lower}`);
      if (block) {
        models[lower] = {
          remainingFraction: 0,
          resetTime: new Date(block.unavailableUntil).toISOString(),
        };
        continue;
      }
      const resetTime = tokenData.model_reset_times?.[rawModelId] ?? tokenData.model_reset_times?.[normalized];
      models[lower] = {
        remainingFraction: Math.max(0, Math.min(1, pct / 100)),
        ...(resetTime ? { resetTime } : {}),
      };
    }

    accounts.push({
      accountId,
      models,
      quotaGroups: tokenData.quota?.quota_groups ?? [],
    });
  }

  return { accounts };
}
