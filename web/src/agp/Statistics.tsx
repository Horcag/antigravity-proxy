import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { TrafficChart } from './TrafficChart';
import {
  bucketRequestHref,
  formatMetric,
  historyParams,
  metricLabels,
  modelRequestFilters,
  requestsHref,
} from './trafficNavigation';
import { formatSamaraDateTime, localDateValue, samaraDayBoundary } from './time';
import type { Account, Project, Statistics, StatisticsGranularity } from './types';
import { Button, Card, DataTable, PageHeader, useResource } from './shared';

const groupLabels: Record<StatisticsGranularity, string> = {
  minute: 'По минутам',
  five_minutes: 'По 5 минут',
  hour: 'По часам',
  day: 'По дням',
};
function MetricLink({
  value,
  to,
  label,
  large = false,
}: {
  value: number | null | undefined;
  to: string;
  label: string;
  large?: boolean;
}) {
  return value === null || value === undefined ? (
    <span title="В выбранной группе нет запросов с этим измерением">Нет измерений</span>
  ) : (
    <Link
      className={`agp-number-link ${large ? 'agp-metric' : ''}`}
      to={to}
      aria-label={`${label}: ${formatMetric(value)}. Посмотреть состав`}
    >
      {formatMetric(value)}
    </Link>
  );
}
export function StatisticsPage({ overview = false }: { overview?: boolean }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const candidate = params.get('granularity') as StatisticsGranularity;
  const granularity = Object.prototype.hasOwnProperty.call(groupLabels, candidate)
    ? candidate
    : overview
      ? 'five_minutes'
      : 'day';
  const filters = historyParams(params);
  const resource = useResource<Statistics>(`/statistics?${filters}&granularity=${granularity}`);
  const accounts = useResource<Account[]>('/accounts');
  const projects = useResource<Project[]>('/projects');
  const s = resource.data;
  const from = localDateValue(params.get('from'));
  const end = params.get('toExclusive');
  const to = localDateValue(end ? new Date(Date.parse(end) - 1).toISOString() : params.get('to'));
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'toExclusive') next.delete('to');
    if (key === 'model' && value) next.delete('missingModel');
    setParams(next);
  }
  const totals = overview
    ? [
        { title: 'Аккаунты', value: accounts.data?.length, to: '/accounts' },
        { title: 'Проекты', value: projects.data?.length, to: '/projects' },
        { title: 'Запросы', value: s?.total_requests, to: requestsHref(filters) },
        {
          title: 'Ошибки',
          value: s?.failed_requests,
          to: requestsHref(filters, { result: 'failure' }),
        },
      ]
    : [
        { title: 'Запросы', value: s?.total_requests, to: requestsHref(filters) },
        {
          title: 'Успех',
          value: s?.success_requests,
          to: requestsHref(filters, { result: 'success' }),
        },
        {
          title: 'Ошибки',
          value: s?.failed_requests,
          to: requestsHref(filters, { result: 'failure' }),
        },
        {
          title: 'Среднее время, мс',
          value: s?.avg_duration_ms,
          to: requestsHref(filters, { metric: 'duration_ms' }),
        },
      ];
  return (
    <>
      <PageHeader title={overview ? 'Обзор' : 'Статистика'} resource={resource} />
      <div className="agp-filters">
        <Input
          label="С даты (Самара)"
          type="date"
          value={from}
          onChange={(e) => change('from', samaraDayBoundary(e.target.value))}
        />
        <Input
          label="По дату (Самара)"
          type="date"
          value={to}
          onChange={(e) =>
            change(
              'toExclusive',
              e.target.value
                ? new Date(Date.parse(samaraDayBoundary(e.target.value)) + 86_400_000).toISOString()
                : ''
            )
          }
        />
        <label className="agp-field">
          Группировка
          <select
            className="input"
            value={granularity}
            onChange={(e) => change('granularity', e.target.value)}
          >
            {Object.entries(groupLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={() => setParams({ granularity })}>
          Сбросить фильтры
        </Button>
      </div>
      <div className="agp-filters">
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
          label="Модель"
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
      </div>
      <p className="agp-muted">
        Всё время по Самаре (UTC+4). Нажмите на число или интервал, чтобы открыть составляющие его
        запросы. Фильтры сохраняются при переходе и возврате.
      </p>
      <div className="agp-metrics">
        {totals.map((m) => (
          <Card key={m.title} title={m.title}>
            <MetricLink value={m.value} to={m.to} label={m.title} large />
          </Card>
        ))}
      </div>
      <Card title={`Запросы ${groupLabels[granularity].toLowerCase()} · Самара`}>
        {s ? (
          <TrafficChart
            key={granularity}
            buckets={s?.buckets ?? []}
            formatTime={formatSamaraDateTime}
            onSelect={(bucket, status) => navigate(bucketRequestHref(filters, bucket, status))}
            onTotal={(status) => navigate(requestsHref(filters, status ? { result: status } : {}))}
          />
        ) : (
          <p className="agp-muted">
            {resource.loading ? 'Загрузка интервалов…' : 'Интервалы не загружены'}
          </p>
        )}
      </Card>
      {s && (
        <>
          <Card title="Измеренные показатели">
            <DataTable
              headers={['Показатель', 'Значение']}
              rows={Object.entries(metricLabels).map(([metric, label]) => [
                metric === 'duration_ms'
                  ? 'Среднее время, мс'
                  : metric === 'ttft_ms'
                    ? 'Средний TTFT, мс'
                    : label,
                <MetricLink
                  value={
                    s[
                      metric === 'duration_ms'
                        ? 'avg_duration_ms'
                        : metric === 'ttft_ms'
                          ? 'avg_ttft_ms'
                          : (metric as 'input_tokens' | 'output_tokens' | 'cache_tokens')
                    ]
                  }
                  to={requestsHref(filters, { metric })}
                  label={label}
                />,
              ])}
            />
            <p className="agp-muted">
              При переходе к токенам и среднему времени показываются только запросы с
              соответствующим измерением. Неизвестно означает отсутствие измерения, а не ноль.
              Хранение: до {s.retention_days} дней / {formatMetric(s.max_entries)} записей.
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
                <Link to={requestsHref(filters, { accountId: a.account_id })}>
                  {accounts.data?.find((account) => account.id === a.account_id)?.email ||
                    a.account_id}
                </Link>,
                <MetricLink
                  value={a.logical_requests}
                  to={requestsHref(filters, { accountId: a.account_id })}
                  label="Запросы аккаунта"
                />,
                <MetricLink
                  value={a.success_attempts}
                  to={requestsHref(filters, { accountId: a.account_id, attemptOutcome: 'success' })}
                  label="Успешные попытки"
                />,
                <MetricLink
                  value={a.failed_attempts}
                  to={requestsHref(filters, { accountId: a.account_id, attemptOutcome: 'failure' })}
                  label="Ошибки попыток"
                />,
                <MetricLink
                  value={a.avg_duration_ms}
                  to={requestsHref(filters, {
                    finalAccountId: a.account_id,
                    metric: 'duration_ms',
                  })}
                  label="Среднее время аккаунта"
                />,
                <>
                  <MetricLink
                    value={a.input_tokens}
                    to={requestsHref(filters, {
                      finalAccountId: a.account_id,
                      metric: 'input_tokens',
                    })}
                    label="Входные токены аккаунта"
                  />{' '}
                  /{' '}
                  <MetricLink
                    value={a.output_tokens}
                    to={requestsHref(filters, {
                      finalAccountId: a.account_id,
                      metric: 'output_tokens',
                    })}
                    label="Выходные токены аккаунта"
                  />
                </>,
              ])}
            />
            <p className="agp-muted">
              Попытки включают повторы до итогового ответа. Токены и время ответа отнесены к
              итоговому аккаунту.
            </p>
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
              rows={(s.by_model ?? []).map((m) => {
                const model = modelRequestFilters(m.model);
                return [
                  <Link to={requestsHref(filters, model)}>
                    {m.model ?? 'Без записанной модели'}
                  </Link>,
                  <MetricLink
                    value={m.total_requests}
                    to={requestsHref(filters, model)}
                    label="Запросы модели"
                  />,
                  <MetricLink
                    value={m.total_requests - m.failed_requests}
                    to={requestsHref(filters, { ...model, result: 'success' })}
                    label="Успех модели"
                  />,
                  <MetricLink
                    value={m.failed_requests}
                    to={requestsHref(filters, { ...model, result: 'failure' })}
                    label="Ошибки модели"
                  />,
                  <MetricLink
                    value={m.avg_duration_ms}
                    to={requestsHref(filters, { ...model, metric: 'duration_ms' })}
                    label="Среднее время модели"
                  />,
                  <>
                    <MetricLink
                      value={m.input_tokens}
                      to={requestsHref(filters, { ...model, metric: 'input_tokens' })}
                      label="Входные токены модели"
                    />{' '}
                    /{' '}
                    <MetricLink
                      value={m.output_tokens}
                      to={requestsHref(filters, { ...model, metric: 'output_tokens' })}
                      label="Выходные токены модели"
                    />
                  </>,
                ];
              })}
            />
          </Card>
        </>
      )}
    </>
  );
}
