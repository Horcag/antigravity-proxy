import { localDateValue } from './api';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ThroughputChart } from '@/features/dashboard/components/ThroughputChart';
import type { TrafficWindow } from '@/features/dashboard/types';
import type { Account, Project, RequestEntry, Statistics } from './types';
import { Button, Card, DataTable, PageHeader, display, useResource } from './shared';
function queryDates(from: string, to: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
  return params;
}
function Dates({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string;
  to: string;
  setFrom: (s: string) => void;
  setTo: (s: string) => void;
}) {
  return (
    <>
      <Input label="С даты" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <Input label="По дату" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
    </>
  );
}
export function Requests() {
  const [params, setParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<RequestEntry>();
  const [search, setSearch] = useState('');
  const accounts = useResource<Account[]>('/accounts');
  const projects = useResource<Project[]>('/projects');
  const filter = params.toString();
  const resource = useResource<{ items: RequestEntry[]; total: number }>(
    `/requests?${filter}&limit=50&offset=${offset}`
  );
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setOffset(0);
    setParams(next);
  }
  return (
    <>
      <PageHeader title="Журнал запросов" resource={resource} />
      <Card title="Фильтры">
        <div className="agp-filters">
          <Input
            label="Поиск в загруженной странице"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="agp-field">
            Участие аккаунта
            <select
              className="input"
              value={params.get('accountId') ?? ''}
              onChange={(e) => change('accountId', e.target.value)}
            >
              <option value="">Все аккаунты</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email || a.name || a.id}
                </option>
              ))}
            </select>
          </label>
          <label className="agp-field">
            Проект
            <select
              className="input"
              value={params.get('projectId') ?? ''}
              onChange={(e) => change('projectId', e.target.value)}
            >
              <option value="">Все проекты</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Модель (серверный фильтр)"
            value={params.get('model') ?? ''}
            onChange={(e) => change('model', e.target.value)}
          />
          <label className="agp-field">
            Результат
            <select
              className="input"
              value={params.get('status') ?? ''}
              onChange={(e) => change('status', e.target.value)}
            >
              <option value="">Все</option>
              <option value="success">Успех</option>
              <option value="failure">Ошибка</option>
            </select>
          </label>
          <Dates
            from={localDateValue(params.get('from'))}
            to={localDateValue(params.get('to'))}
            setFrom={(v) => change('from', v ? new Date(`${v}T00:00:00`).toISOString() : '')}
            setTo={(v) => change('to', v ? new Date(`${v}T23:59:59.999`).toISOString() : '')}
          />
          <Button
            variant="secondary"
            onClick={() => {
              setParams({});
              setSearch('');
              setOffset(0);
            }}
          >
            Сбросить фильтры
          </Button>
        </div>
      </Card>
      <Card>
        <DataTable
          headers={[
            'Время',
            'Проект / аккаунт',
            'Модель → фактическая',
            'Результат',
            'Время, мс',
            'Детали',
          ]}
          rows={(resource.data?.items ?? [])
            .filter((r) =>
              `${r.request_id} ${r.project_name} ${r.account_id} ${r.requested_model} ${r.effective_model} ${r.route}`
                .toLowerCase()
                .includes(search.toLowerCase())
            )
            .map((r) => [
              new Date(r.time).toLocaleString('ru'),
              <>
                {r.project_name}
                <small>{r.account_id ?? 'Аккаунт неизвестен'}</small>
              </>,
              `${display(r.requested_model)} → ${display(r.effective_model)}`,
              <span
                className={`agp-badge ${r.status >= 400 || (r.grpc_status && r.grpc_status !== '0') ? 'agp-warning' : ''}`}
              >
                {r.status}
                {r.grpc_status ? ` / gRPC ${r.grpc_status}` : ''}
              </span>,
              r.duration_ms,
              <Button variant="secondary" size="sm" onClick={() => setSelected(r)}>
                Открыть
              </Button>,
            ])}
        />
        <div className="agp-actions agp-pagination">
          <Button
            variant="secondary"
            disabled={!offset || resource.loading}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Назад
          </Button>
          <span>
            {resource.data?.total ? offset + 1 : 0}–
            {Math.min(offset + 50, resource.data?.total ?? 0)} из {resource.data?.total ?? 0}
          </span>
          <Button
            variant="secondary"
            disabled={resource.loading || offset + 50 >= (resource.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Далее
          </Button>
        </div>
      </Card>
      <Modal
        open={!!selected}
        title="Метаданные запроса"
        onClose={() => setSelected(undefined)}
        width={800}
      >
        {selected && (
          <>
            <p>Сохраняются только метаданные. Тела запросов, ответов и ключи отсутствуют.</p>
            <dl>
              {Object.entries(selected)
                .filter(([key]) => key !== 'attempts')
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{display(value)}</dd>
                  </div>
                ))}
            </dl>
            <h3>Попытки по аккаунтам</h3>
            <DataTable
              headers={['Аккаунт', 'Модель', 'Исход', 'Категория', 'TTFT, мс']}
              rows={selected.attempts.map((a) => [
                a.account_id,
                display(a.effective_model),
                a.outcome,
                display(a.error_category),
                display(a.ttft_ms),
              ])}
            />
          </>
        )}
      </Modal>
    </>
  );
}
export function StatisticsPage({ overview = false }: { overview?: boolean }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const resource = useResource<Statistics>(`/statistics?${queryDates(from, to)}`);
  const accounts = useResource<Account[]>('/accounts');
  const projects = useResource<Project[]>('/projects');
  const s = resource.data;
  const buckets = (s?.by_day ?? []).map((day) => ({
    time: day.date.replace(/-/g, '.'),
    success: day.total_requests - day.failed_requests,
    failed: day.failed_requests,
  }));
  const peak = Math.max(0, ...buckets.map((b) => b.success + b.failed));
  const traffic: TrafficWindow = {
    buckets,
    totalSuccess: s?.success_requests ?? 0,
    totalFailure: s?.failed_requests ?? 0,
    total: s?.total_requests ?? 0,
    successRate: s?.total_requests ? (s.success_requests / s.total_requests) * 100 : null,
    peakTotal: peak,
    peakIndex: buckets.findIndex((b) => b.success + b.failed === peak),
    activeBuckets: buckets.filter((b) => b.success + b.failed > 0).length,
    windowMinutes: buckets.length * 1440,
  };
  return (
    <>
      <PageHeader title={overview ? 'Обзор' : 'Статистика'} resource={resource} />
      <div className="agp-filters">
        <Dates from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <Button
          variant="secondary"
          onClick={() => {
            setFrom('');
            setTo('');
          }}
        >
          Сбросить период
        </Button>
      </div>
      <div className="agp-metrics">
        {(overview
          ? [
              ['Аккаунты', accounts.data?.length],
              ['Проекты', projects.data?.length],
              ['Запросы', s?.total_requests],
              ['Ошибки', s?.failed_requests],
            ]
          : [
              ['Запросы', s?.total_requests],
              ['Успех', s?.success_requests],
              ['Ошибки', s?.failed_requests],
              ['Среднее время, мс', s?.avg_duration_ms],
            ]
        ).map(([title, value]) => (
          <Card key={String(title)} title={String(title)}>
            <strong className="agp-metric">{display(value)}</strong>
          </Card>
        ))}
      </div>
      <Card title="Запросы по дням (UTC)">
        <ThroughputChart traffic={traffic} />
      </Card>
      {s && (
        <>
          <Card title="Измеренные показатели">
            <DataTable
              headers={['Показатель', 'Значение']}
              rows={[
                ['Входные токены', display(s.input_tokens)],
                ['Выходные токены', display(s.output_tokens)],
                ['Кэшированные токены', display(s.cache_tokens)],
                ['Среднее время, мс', display(s.avg_duration_ms)],
                ['Средний TTFT, мс', display(s.avg_ttft_ms)],
              ]}
            />
            <p className="agp-muted">
              Неизвестно означает, что сервер не получил измерение. Хранение: до {s.retention_days}{' '}
              дней / {s.max_entries} записей.
            </p>
          </Card>
          <Card title="По аккаунтам">
            <DataTable
              headers={[
                'Аккаунт',
                'Запросы',
                'Успешные попытки',
                'Ошибки попыток',
                'Среднее время, мс',
                'Вход / выход токенов',
              ]}
              rows={(s.accounts ?? []).map((a) => [
                <Link to={`/requests?accountId=${encodeURIComponent(a.account_id)}`}>
                  {accounts.data?.find((account) => account.id === a.account_id)?.email ||
                    a.account_id}
                </Link>,
                a.logical_requests,
                a.success_attempts,
                a.failed_attempts,
                display(a.avg_duration_ms),
                `${display(a.input_tokens)} / ${display(a.output_tokens)}`,
              ])}
            />
          </Card>
          <Card title="По моделям">
            <DataTable
              headers={[
                'Модель',
                'Запросы',
                'Успех',
                'Ошибки',
                'Среднее время, мс',
                'Вход / выход токенов',
              ]}
              rows={(s.by_model ?? []).map((m) => [
                display(m.model),
                m.total_requests,
                m.total_requests - m.failed_requests,
                m.failed_requests,
                display(m.avg_duration_ms),
                `${display(m.input_tokens)} / ${display(m.output_tokens)}`,
              ])}
            />
          </Card>
        </>
      )}
    </>
  );
}
