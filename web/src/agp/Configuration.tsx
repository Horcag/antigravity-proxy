import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { consoleApi, mapping } from './api';
import type { Aliases, Settings } from './types';
import { formatSamaraDateTime } from './time';
import {
  Button,
  Card,
  DataTable,
  ErrorMessage,
  JsonEditor,
  PageHeader,
  display,
  useMutation,
  useResource,
} from './shared';
export function Models() {
  const resource = useResource<{ models: string[] }>('/models');
  const aliases = useResource<Aliases>('/aliases');
  const diagnostics = useResource<{
    accounts: Array<{
      last_successful_refresh_at: string | null;
      refresh_state: string;
      models: Array<{
        public_model_id: string;
        physical_model_id: string;
        requestable: boolean;
        remaining_percentage: number | null;
      }>;
    }>;
  }>('/accounts/quota-diagnostics');
  async function refreshAll() {
    await Promise.all([resource.refresh(), aliases.refresh(), diagnostics.refresh()]);
  }
  function runtimeStatus(model: string) {
    const matched = (diagnostics.data?.accounts ?? []).filter((a) =>
      a.models.some((m) => m.public_model_id === model || m.physical_model_id === model)
    );
    const requestable = matched.some((a) =>
      a.models.some(
        (m) => (m.public_model_id === model || m.physical_model_id === model) && m.requestable
      )
    );
    return [
      matched.length ? (requestable ? 'Доступна сейчас' : 'Недоступна сейчас') : 'Неизвестно',
      matched.length
        ? matched
            .map((a) => `${a.refresh_state}: ${formatSamaraDateTime(a.last_successful_refresh_at)}`)
            .join('; ')
        : 'Нет снимка квоты',
    ];
  }
  const mutation = useMutation(async () => {
    await resource.refresh();
    await aliases.refresh();
  });
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [anthropic, setAnthropic] = useState('');
  function edit() {
    setCustom(JSON.stringify(aliases.data?.custom_mapping ?? {}, null, 2));
    setAnthropic(JSON.stringify(aliases.data?.anthropic_mapping ?? {}, null, 2));
    setOpen(true);
  }
  const rows = (resource.data?.models ?? []).map((model) => [
    model,
    model,
    ...runtimeStatus(model),
  ]);
  for (const items of Object.values(aliases.data ?? {}))
    for (const [requested, physical] of Object.entries(items))
      rows.push([requested, String(physical), ...runtimeStatus(String(physical))]);
  return (
    <>
      <PageHeader title="Модели и псевдонимы" resource={{ ...resource, refresh: refreshAll }}>
        <Button variant="secondary" disabled={!aliases.data} onClick={edit}>
          Изменить псевдонимы
        </Button>
      </PageHeader>
      <p>
        Доступность рассчитана сервером по текущим аккаунтам, квотам и временным блокировкам. Старый
        снимок квоты помечается stale; отсутствие измерения — «Неизвестно».
      </p>
      <ErrorMessage error={aliases.error || diagnostics.error || mutation.error} />
      <Card>
        <DataTable
          headers={[
            'Запрошенная модель',
            'Физическая модель',
            'Доступность сейчас',
            'Свежесть квоты',
          ]}
          rows={rows}
        />
      </Card>
      <Modal
        open={open}
        title="Сопоставления моделей"
        onClose={() => setOpen(false)}
        width={760}
        footer={
          <Button
            loading={mutation.busy}
            onClick={() =>
              void mutation
                .run(() =>
                  consoleApi('/aliases', 'PUT', {
                    custom_mapping: mapping(custom),
                    anthropic_mapping: mapping(anthropic),
                  })
                )
                .then((v) => {
                  if (v !== undefined) setOpen(false);
                })
            }
          >
            Сохранить
          </Button>
        }
      >
        <JsonEditor label="Общие псевдонимы" value={custom} onChange={setCustom} />
        <JsonEditor label="Anthropic" value={anthropic} onChange={setAnthropic} />
        <ErrorMessage error={mutation.error} />
      </Modal>
    </>
  );
}
export function SettingsPage() {
  const resource = useResource<Settings>('/settings');
  const mutation = useMutation(resource.refresh);
  return (
    <>
      <PageHeader title="Настройки" resource={resource} />
      <ErrorMessage error={mutation.error} />
      <p role="status">{mutation.success}</p>
      {resource.data && (
        <SettingsForm key={resource.updated} initial={resource.data} mutation={mutation} />
      )}
    </>
  );
}
function SettingsForm({
  initial,
  mutation,
}: {
  initial: Settings;
  mutation: ReturnType<typeof useMutation>;
}) {
  const [draft, setDraft] = useState(initial);
  const [custom, setCustom] = useState(JSON.stringify(initial.custom_mapping, null, 2));
  const [anthropic, setAnthropic] = useState(JSON.stringify(initial.anthropic_mapping, null, 2));
  return (
    <Card title="Планировщик и лимиты">
      <form
        className="agp-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void mutation.run(() =>
            consoleApi('/settings', 'PATCH', {
              ...draft,
              custom_mapping: mapping(custom),
              anthropic_mapping: mapping(anthropic),
            })
          );
        }}
      >
        <label className="agp-field">
          Режим планировщика
          <select
            className="input"
            value={draft.scheduling_mode}
            onChange={(e) => setDraft({ ...draft, scheduling_mode: e.target.value })}
          >
            {['cache-first', 'balance', 'performance-first'].map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ['max_wait_seconds', 'Максимальное ожидание, секунды'],
            ['max_concurrency_per_account', 'Параллельные запросы на аккаунт'],
            ['request_timeout', 'Тайм-аут запроса, секунды'],
          ] as const
        ).map(([key, label]) => (
          <Input
            key={key}
            label={label}
            type="number"
            min={key === 'max_wait_seconds' ? 0 : 1}
            required
            value={display(draft[key])}
            onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
          />
        ))}
        <JsonEditor label="Общие сопоставления моделей" value={custom} onChange={setCustom} />
        <JsonEditor label="Сопоставления Anthropic" value={anthropic} onChange={setAnthropic} />
        <Button type="submit" loading={mutation.busy}>
          Сохранить настройки
        </Button>
      </form>
    </Card>
  );
}
