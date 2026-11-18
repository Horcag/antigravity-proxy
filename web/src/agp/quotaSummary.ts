import type { Account } from './types';

export interface QuotaWindowInfo {
  percentage: number;
  resetTime: string;
}

export interface QuotaGroupSummaryRow {
  id: 'gemini' | 'argon' | 'third_party';
  label: string;
  modelsHint: string;
  fiveHour: QuotaWindowInfo | null;
  weekly: QuotaWindowInfo | null;
  compactText: string;
  lowestPercentage: number;
}

export interface DisplayQuotaModelRow {
  modelId: string;
  displayName: string;
  percentage: number;
  resetTime: string;
}

export interface AccountQuotaSummary {
  tierLabel: string;
  hasArgon: boolean;
  hasHydrogen: boolean;
  groups: QuotaGroupSummaryRow[];
  models: DisplayQuotaModelRow[];
}

const HIDDEN_MODEL_PATTERNS = [
  /^gemini-2\.5-/i,
  /^gemini-2\.0-/i,
  /^gemini-3\.1-flash-lite$/i,
  /-tiered(?:-|$)/i,
  /-sonar$/i,
  /-disabled$/i,
  /^chat_/i,
  /^tab_/i,
];

function toPercentage(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

function findLowestModelWindow(
  models: NonNullable<Account['quota']>['models'],
  predicate: (modelId: string) => boolean,
): QuotaWindowInfo | null {
  let best: QuotaWindowInfo | null = null;
  for (const [modelId, info] of Object.entries(models)) {
    if (!predicate(modelId.toLowerCase()) || !Number.isFinite(info.percentage)) continue;
    const pct = Math.max(0, Math.min(100, Math.floor(info.percentage)));
    if (!best || pct < best.percentage || (pct === best.percentage && info.resetTime < best.resetTime)) {
      best = { percentage: pct, resetTime: info.resetTime || '' };
    }
  }
  return best;
}

function formatCompactWindows(fiveHour: QuotaWindowInfo | null, weekly: QuotaWindowInfo | null): string {
  const parts: string[] = [];
  if (fiveHour) parts.push(`5ч ${fiveHour.percentage}%`);
  if (weekly) parts.push(`Нед ${weekly.percentage}%`);
  return parts.join(' · ') || '—';
}

function buildGroupRow(
  id: QuotaGroupSummaryRow['id'],
  label: string,
  modelsHint: string,
  fiveHour: QuotaWindowInfo | null,
  weekly: QuotaWindowInfo | null,
): QuotaGroupSummaryRow | null {
  if (!fiveHour && !weekly) return null;
  const candidates = [fiveHour?.percentage, weekly?.percentage].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const lowestPercentage = candidates.length > 0 ? Math.min(...candidates) : 0;
  return {
    id,
    label,
    modelsHint,
    fiveHour,
    weekly,
    compactText: `${label}: ${formatCompactWindows(fiveHour, weekly)}`,
    lowestPercentage,
  };
}

export function listDisplayQuotaModels(quota: Account['quota']): DisplayQuotaModelRow[] {
  if (!quota?.models) return [];
  const entries = Object.entries(quota.models);
  const filtered = entries.filter(
    ([modelId]) => !HIDDEN_MODEL_PATTERNS.some((pattern) => pattern.test(modelId)),
  );
  const source = filtered.length > 0 ? filtered : entries.filter(([id]) => !id.endsWith('-sonar') && !id.endsWith('-disabled'));

  const rankModel = (modelId: string): number => {
    const id = modelId.toLowerCase();
    if (id.startsWith('gemini-4-argon-high')) return 10;
    if (id.startsWith('gemini-4-argon-medium')) return 11;
    if (id.startsWith('gemini-4-argon-low')) return 12;
    if (id.startsWith('gemini-4-argon')) return 15;
    if (id.startsWith('gemini-4-hydrogen-xhigh')) return 20;
    if (id.startsWith('gemini-4-hydrogen-high')) return 21;
    if (id.startsWith('gemini-4-hydrogen-medium')) return 22;
    if (id.startsWith('gemini-4-hydrogen-low')) return 23;
    if (id.startsWith('gemini-4-hydrogen')) return 25;
    if (id.startsWith('gemini-3.8-flash-high')) return 30;
    if (id.startsWith('gemini-3.8-flash-medium')) return 31;
    if (id.startsWith('gemini-3.8-flash-low')) return 32;
    if (id.startsWith('gemini-3')) return 35;
    if (id.startsWith('claude-opus-5-5')) return 40;
    if (id.startsWith('claude-sonnet-5-5')) return 41;
    if (id.startsWith('claude-')) return 45;
    if (id.startsWith('gpt-')) return 50;
    return 90;
  };

  return source
    .map(([modelId, info]) => ({
      modelId,
      displayName: info.display_name || modelId,
      percentage: Math.floor(info.percentage),
      resetTime: info.resetTime || '',
    }))
    .sort((a, b) => rankModel(a.modelId) - rankModel(b.modelId) || a.modelId.localeCompare(b.modelId));
}

export function summarizeAccountQuota(quota: Account['quota']): AccountQuotaSummary | null {
  if (!quota) return null;
  const models = quota.models ?? {};
  const modelKeys = Object.keys(models).map((k) => k.toLowerCase());
  const hasArgonModel = modelKeys.some((k) => k.startsWith('gemini-4-argon') && !k.endsWith('-disabled'));
  const hasHydrogenModel = modelKeys.some(
    (k) => k.startsWith('gemini-4-hydrogen') && !k.endsWith('-sonar') && !k.endsWith('-disabled'),
  );

  let gemini5h: QuotaWindowInfo | null = null;
  let geminiWeekly: QuotaWindowInfo | null = null;
  let argon5h: QuotaWindowInfo | null = null;
  let argonWeekly: QuotaWindowInfo | null = null;
  let thirdParty5h: QuotaWindowInfo | null = null;
  let thirdPartyWeekly: QuotaWindowInfo | null = null;

  for (const group of quota.quota_groups ?? []) {
    const groupText = `${group.display_name} ${group.description ?? ''}`.toLowerCase();
    for (const bucket of group.buckets ?? []) {
      const bucketId = (bucket.bucket_id || '').toLowerCase();
      const win = (bucket.window || '').toLowerCase();
      const info: QuotaWindowInfo = {
        percentage: toPercentage(bucket.remaining_fraction),
        resetTime: bucket.reset_time || '',
      };

      if (bucketId.includes('argon') || groupText.includes('argon')) {
        if (win === '5h') argon5h = info;
        else argonWeekly = info;
      } else if (bucketId.includes('3p') || groupText.includes('claude') || groupText.includes('gpt')) {
        if (win === '5h') thirdParty5h = info;
        else if (win === 'weekly') thirdPartyWeekly = info;
      } else if (bucketId.includes('gemini') || groupText.includes('gemini')) {
        if (win === '5h') gemini5h = info;
        else if (win === 'weekly') geminiWeekly = info;
      }
    }
  }

  if (!gemini5h && !geminiWeekly) {
    gemini5h = findLowestModelWindow(
      models,
      (id) =>
        id.startsWith('gemini-') &&
        !id.includes('argon') &&
        !id.includes('image') &&
        !id.endsWith('-sonar') &&
        !id.startsWith('gemini-2.5-'),
    );
  }
  if (!argonWeekly && hasArgonModel) {
    argonWeekly = findLowestModelWindow(models, (id) => id.startsWith('gemini-4-argon'));
  }
  if (!thirdParty5h && !thirdPartyWeekly) {
    thirdParty5h = findLowestModelWindow(models, (id) => id.includes('claude') || id.includes('gpt'));
  }

  const hasArgon = Boolean(argonWeekly || argon5h || hasArgonModel);
  const hasHydrogen = hasHydrogenModel;

  const geminiLabel = hasHydrogen ? 'Gemini (Hydrogen / 3.8)' : 'Gemini (3.8 Flash)';
  const geminiModelsHint = hasHydrogen ? 'Gemini 4 Hydrogen, Gemini 3.8 Flash' : 'Gemini 3.8 Flash';
  const claudeModelsHint = modelKeys.some((k) => k.includes('5-5'))
    ? 'Claude 5.5, GPT-OSS 120B'
    : 'Claude 4.6, GPT-OSS 120B';

  const groups = [
    buildGroupRow('gemini', geminiLabel, geminiModelsHint, gemini5h, geminiWeekly),
    hasArgon ? buildGroupRow('argon', 'Gemini 4 Argon', 'Gemini 4 Argon (Low / Medium / High)', argon5h, argonWeekly) : null,
    buildGroupRow('third_party', 'Claude / GPT', claudeModelsHint, thirdParty5h, thirdPartyWeekly),
  ].filter((row): row is QuotaGroupSummaryRow => row !== null);

  const baseTier = quota.subscription_tier ?? 'Квота по группам';
  const capabilityTags = [hasArgon ? 'Argon' : null, hasHydrogen ? 'Hydrogen' : null].filter(Boolean);
  const tierLabel = capabilityTags.length > 0 ? `${baseTier} · ${capabilityTags.join(' + ')}` : baseTier;

  return {
    tierLabel,
    hasArgon,
    hasHydrogen,
    groups,
    models: listDisplayQuotaModels(quota),
  };
}
