import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import type { AccountQuotaCostRow, QuotaPricingPayload } from './quotaAnalyticsTypes';
import { consoleApi } from './api';
import { Button, Card, DataTable, ErrorMessage, useMutation, useResource } from './shared';

type Props = {
  accounts: AccountQuotaCostRow[];
  onSaved: () => Promise<void>;
};

export function QuotaPricingEditor({ accounts, onSaved }: Props) {
  const pricing = useResource<QuotaPricingPayload>('/quota-pricing');
  const [draftMultiplier, setDraftMultiplier] = useState<string | null>(null);
  const [draftTiers, setDraftTiers] = useState<Record<string, string> | null>(null);
  const [draftAccounts, setDraftAccounts] = useState<Record<string, string> | null>(null);
  const [draftOverrides, setDraftOverrides] = useState<
    Record<string, { input: number; cached_input: number; cache_write?: number; output: number }> | null
  >(null);

  const clearDrafts = () => {
    setDraftMultiplier(null);
    setDraftTiers(null);
    setDraftAccounts(null);
    setDraftOverrides(null);
  };

  const mutation = useMutation(async () => {
    clearDrafts();
    await pricing.refresh();
    await onSaved();
  });

  const [overrideModel, setOverrideModel] = useState('');
  const [overrideIn, setOverrideIn] = useState('');
  const [overrideCached, setOverrideCached] = useState('');
  const [overrideWrite, setOverrideWrite] = useState('');
  const [overrideOut, setOverrideOut] = useState('');

  const cfg = pricing.data?.config;
  const baseTiers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...(pricing.data?.defaults.tier_monthly_usd ?? {}),
    ...(cfg?.tier_monthly_usd ?? {}),
  })) {
    baseTiers[k] = String(v);
  }
  const baseAccounts: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg?.account_monthly_usd ?? {})) {
    baseAccounts[k] = String(v);
  }

  const multiplier = draftMultiplier ?? String(cfg?.api_multiplier ?? 1);
  const tierPrices = draftTiers ?? baseTiers;
  const accountPrices = draftAccounts ?? baseAccounts;
  const modelOverrides = draftOverrides ?? cfg?.model_overrides ?? {};

  async function save(reset = false) {
    if (reset) {
      await mutation.run(() =>
        consoleApi('/quota-pricing', 'PUT', {
          api_multiplier: 1,
          tier_monthly_usd: {},
          account_monthly_usd: {},
          model_overrides: {},
        })
      );
      return;
    }
    const multNum = Number(multiplier);
    if (!Number.isFinite(multNum) || multNum <= 0) {
      mutation.setError('Множитель API должен быть больше 0');
      return;
    }
    const nextTiers: Record<string, number> = {};
    for (const [k, v] of Object.entries(tierPrices)) {
      const n = Number(v);
      if (v.trim() !== '' && Number.isFinite(n) && n >= 0) nextTiers[k] = n;
    }
    const nextAccs: Record<string, number> = {};
    for (const [k, v] of Object.entries(accountPrices)) {
      const n = Number(v);
      if (v.trim() !== '' && Number.isFinite(n) && n >= 0) nextAccs[k] = n;
    }
    await mutation.run(() =>
      consoleApi('/quota-pricing', 'PUT', {
        api_multiplier: multNum,
        tier_monthly_usd: nextTiers,
        account_monthly_usd: nextAccs,
        model_overrides: modelOverrides,
      })
    );
  }

  function addModelOverride() {
    const model = overrideModel.trim();
    const input = Number(overrideIn);
    const cached_input = Number(overrideCached || '0');
    const output = Number(overrideOut);
    const writeRaw = overrideWrite.trim();
    if (!model || !Number.isFinite(input) || !Number.isFinite(cached_input) || !Number.isFinite(output)) {
      mutation.setError('Заполните модель, цену input и output ($/1M токенов).');
      return;
    }
    setDraftOverrides({
      ...modelOverrides,
      [model]: {
        input,
        cached_input,
        ...(writeRaw !== '' && Number.isFinite(Number(writeRaw)) ? { cache_write: Number(writeRaw) } : {}),
        output,
      },
    });
    setOverrideModel('');
    setOverrideIn('');
    setOverrideCached('');
    setOverrideWrite('');
    setOverrideOut('');
  }

  return (
    <Card title="Калибровка тарифов API и стоимости подписок (Pro-настройки)">
      <ErrorMessage error={pricing.error || mutation.error} />
      {mutation.success && <p role="status">{mutation.success}</p>}
      <div className="agp-stack">
        <div className="agp-filters">
          <Input
            label="Множитель API (1.0 = официальный, 0.35 = условный реселлер/A6API)"
            type="number"
            step="0.05"
            min="0.01"
            max="20"
            value={multiplier}
            onChange={(e) => setDraftMultiplier(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => setDraftMultiplier('1')}>
            Официальный 1.0×
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setDraftMultiplier('0.5')}>
            0.5×
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setDraftMultiplier('0.2')}>
            0.2×
          </Button>
        </div>

        <div className="agp-filters">
          {Object.entries(tierPrices).map(([tier, val]) => (
            <Input
              key={tier}
              label={`Подписка ${tier} ($/мес)`}
              type="number"
              min="0"
              step="1"
              value={val}
              onChange={(e) => setDraftTiers({ ...tierPrices, [tier]: e.target.value })}
            />
          ))}
        </div>

        {accounts.length > 0 && (
          <details>
            <summary>Индивидуальная цена аккаунта ($/мес, необязательно)</summary>
            <div className="agp-filters" style={{ marginTop: 12 }}>
              {accounts.map((acc) => (
                <Input
                  key={acc.account_id}
                  label={acc.label}
                  type="number"
                  min="0"
                  step="1"
                  placeholder={acc.monthly_usd !== null ? String(acc.monthly_usd) : 'По тарифу'}
                  value={accountPrices[acc.account_id] ?? ''}
                  onChange={(e) => setDraftAccounts({ ...accountPrices, [acc.account_id]: e.target.value })}
                />
              ))}
            </div>
          </details>
        )}

        <details>
          <summary>
            Переопределение тарифов моделей ($ за 1M токенов) и встроенная сетка ({pricing.data?.defaults.models.length ?? 0} моделей)
          </summary>
          <div className="agp-stack" style={{ marginTop: 12 }}>
            <div className="agp-filters">
              <Input
                label="Префикс / ID модели"
                placeholder="gpt-oss-120b-medium"
                value={overrideModel}
                onChange={(e) => setOverrideModel(e.target.value)}
              />
              <Input label="Вход $/1M" type="number" step="0.01" value={overrideIn} onChange={(e) => setOverrideIn(e.target.value)} />
              <Input label="Кэш чтение $/1M" type="number" step="0.01" value={overrideCached} onChange={(e) => setOverrideCached(e.target.value)} />
              <Input label="Кэш запись $/1M" type="number" step="0.01" value={overrideWrite} onChange={(e) => setOverrideWrite(e.target.value)} />
              <Input label="Выход $/1M" type="number" step="0.01" value={overrideOut} onChange={(e) => setOverrideOut(e.target.value)} />
              <Button variant="secondary" size="sm" onClick={addModelOverride}>
                Добавить тариф
              </Button>
            </div>
            {Object.keys(modelOverrides).length > 0 && (
              <DataTable
                headers={['Пользовательский тариф', 'Вход', 'Кэш чтение', 'Кэш запись', 'Выход', '']}
                rows={Object.entries(modelOverrides).map(([m, r]) => [
                  m,
                  `$${r.input}`,
                  `$${r.cached_input}`,
                  r.cache_write !== undefined ? `$${r.cache_write}` : '—',
                  `$${r.output}`,
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const copy = { ...modelOverrides };
                      delete copy[m];
                      setDraftOverrides(copy);
                    }}
                  >
                    Удалить
                  </Button>,
                ])}
              />
            )}
            <DataTable
              headers={['Встроенный эталон', 'Вход $/1M', 'Кэш $/1M', 'Выход $/1M', 'Источник / дата']}
              rows={(pricing.data?.defaults.models ?? []).map((m) => [
                m.canonical_model,
                `$${m.input}${m.long_input ? ` (>200K: $${m.long_input})` : ''}`,
                `$${m.cached_input}`,
                `$${m.output}${m.long_output ? ` (>200K: $${m.long_output})` : ''}`,
                `${m.source_label} · ${m.as_of}${m.note ? ` (${m.note})` : ''}`,
              ])}
            />
          </div>
        </details>

        <div className="agp-actions">
          <Button loading={mutation.busy} onClick={() => void save(false)}>
            Сохранить тарифы
          </Button>
          <Button variant="secondary" loading={mutation.busy} onClick={() => void save(true)}>
            Сбросить к официальным
          </Button>
        </div>
      </div>
    </Card>
  );
}
