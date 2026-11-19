import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { missingMeasurement, requestAccountLabel, requestModelLabel } from './api';
import {
  formatConsoleValue,
  formatSamaraDateTime,
  localDateTimeValue,
  samaraDateTimeToIso,
} from './time';
import { formatMetric, historyParams, metricLabels, requestsHref } from './trafficNavigation';
import type { Account, Project, RequestEntry, Statistics } from './types';
import { Button, Card, DataTable, PageHeader, display, useResource } from './shared';

export function Requests() {
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<RequestEntry>();
  const [search, setSearch] = useState('');
  const accounts = useResource<Account[]>('/accounts');
  const projects = useResource<Project[]>('/projects');
  const filters = historyParams(params);
  const rawOffset = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const resource = useResource<{
    items: RequestEntry[];
    total: number;
    matching_attempts?: number;
  }>(`/requests?${filters}&limit=50&offset=${offset}`);
  const summary = useResource<Statistics>(`/statistics?${filters}&granularity=hour`);
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'model' && value) next.delete('missingModel');
    if (key === 'missingModel' && value === 'true') next.delete('model');
    if (key === 'toExclusive') next.delete('to');
    next.delete('offset');
    setParams(next);
  }
  function page(value: number) {
    const next = new URLSearchParams(params);
    if (value) next.set('offset', String(value));
    else next.delete('offset');
    setParams(next);
  }
  function accountSelect(key: 'accountId' | 'finalAccountId', label: string) {
    return (
      <label className="agp-field">
        {label}
        <select
          className="input"
          value={params.get(key) ?? ''}
          onChange={(e) => change(key, e.target.value)}
        >
          <option value="">Все аккаунты</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.email || a.name || a.id}
            </option>
          ))}
        </select>
      </label>
    );
  }
  function detail(
    value: number | null | undefined,
    row: RequestEntry,
    label: string,
    metric: string
  ) {
    const missing = missingMeasurement(row, metric);
    return value === null || value === undefined ? (
      <span className="agp-muted" title={missing.reason}>
        {missing.label}
      </span>
    ) : (
      <button
        type="button"
        className="agp-number-link"
        onClick={() => setSelected(row)}
        aria-label={`${label}: ${formatMetric(value)}. Открыть запрос`}
      >
        {formatMetric(value)}
      </button>
    );
  }
  const metric = params.get('metric');
  const metricValue = metric
    ? summary.data?.[
        metric === 'duration_ms'
          ? 'avg_duration_ms'
          : metric === 'ttft_ms'
            ? 'avg_ttft_ms'
            : (metric as 'input_tokens' | 'output_tokens' | 'cache_tokens')
      ]
    : undefined;
  return (
    <>
      <PageHeader
        title="Журнал запросов"
        resource={{
          ...resource,
          refresh: async () => {
            await Promise.all([resource.refresh(), summary.refresh()]);
          },
        }}
      />
      <Card title="Фильтры">
        <p className="agp-muted">
          Время по Самаре (UTC+4). Конец интервала не включается: соседние интервалы не
          пересекаются.
        </p>
        <div className="agp-filters">
          <Input
            label="Поиск в загруженной странице"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {accountSelect('accountId', 'Участие аккаунта')}
          {accountSelect('finalAccountId', 'Итоговый аккаунт (измерения)')}
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
          <Input
            label="Сессия (серверный фильтр)"
            value={params.get('sessionKey') ?? ''}
            onChange={(e) => change('sessionKey', e.target.value)}
          />
          <label className="agp-field">
            Наличие модели
            <select
              className="input"
              value={params.get('missingModel') ?? ''}
              onChange={(e) => change('missingModel', e.target.value)}
            >
              <option value="">Все</option>
              <option value="true">Без записанной модели</option>
              <option value="false">С записанной моделью</option>
            </select>
          </label>
          <label className="agp-field">
            Результат запроса
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
          <label className="agp-field">
            Группа показателя
            <select
              className="input"
              value={params.get('result') ?? ''}
              onChange={(e) => change('result', e.target.value)}
            >
              <option value="">Все результаты</option>
              <option value="success">Успешные запросы</option>
              <option value="failure">Запросы с ошибкой</option>
              <option value="none">Пустое пересечение фильтров</option>
            </select>
          </label>
          <label className="agp-field">
            Исход попытки
            <select
              className="input"
              value={params.get('attemptOutcome') ?? ''}
              onChange={(e) => change('attemptOutcome', e.target.value)}
            >
              <option value="">Все</option>
              <option value="success">Успешная попытка</option>
              <option value="failure">Ошибка попытки</option>
              <option value="unknown">Исход неизвестен</option>
            </select>
          </label>
          <label className="agp-field">
            Измеренный показатель
            <select
              className="input"
              value={metric ?? ''}
              onChange={(e) => change('metric', e.target.value)}
            >
              <option value="">Все запросы</option>
              {Object.entries(metricLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="С (Самара)"
            type="datetime-local"
            step="1"
            value={localDateTimeValue(params.get('from'))}
            onChange={(e) => change('from', samaraDateTimeToIso(e.target.value))}
          />
          <Input
            label="До, не включая (Самара)"
            type="datetime-local"
            step="1"
            value={localDateTimeValue(params.get('toExclusive') ?? params.get('to'))}
            onChange={(e) => change('toExclusive', samaraDateTimeToIso(e.target.value))}
          />
          <Button
            variant="secondary"
            onClick={() => {
              setParams({});
              setSearch('');
            }}
          >
            Сбросить фильтры
          </Button>
        </div>
      </Card>
      <Card title="Состав показателя">
        <p>
          <Link className="agp-number-link" to={requestsHref(filters)}>
            {formatMetric(resource.data?.total)} запросов
          </Link>
          {metric ? (
            <>
              {' '}
              · {metricLabels[metric]}: <strong>{formatMetric(metricValue)}</strong> · показаны
              только запросы с измерением
            </>
          ) : null}
        </p>
        {params.get('attemptOutcome') && (
          <p className="agp-muted">
            Совпавших попыток: {formatMetric(resource.data?.matching_attempts)}. Один запрос может
            содержать несколько попыток; итог запроса может быть успешным после ошибки аккаунта.
            Попытки видны в деталях каждого запроса.
          </p>
        )}
        {(params.get('from') || params.get('toExclusive') || params.get('to')) && (
          <p className="agp-muted">
            {params.get('from')
              ? formatSamaraDateTime(params.get('from'))
              : 'Начало сохранённой истории'}{' '}
            —{' '}
            {params.get('toExclusive') || params.get('to')
              ? formatSamaraDateTime(params.get('toExclusive') ?? params.get('to'))
              : 'Настоящее время'}
          </p>
        )}
        {summary.error && (
          <p className="error-box" role="alert">
            {summary.error}
          </p>
        )}
      </Card>
      <Card>
        <p className="agp-muted">
          «—» — показатель не применяется к служебному обращению. «Не передано» — нет измерения в
          ответе. «Не сохранено» — измерения нет в записи. Наведите на значение для пояснения.
        </p>
        <DataTable
          headers={[
            'Время (Самара)',
            'Проект / аккаунт',
            'Модель → фактическая',
            'Результат',
            'Время, мс',
            'TTFT, мс',
            'Входные токены',
            'Выходные токены',
            'Кэш',
            'Детали',
          ]}
          rows={(resource.data?.items ?? [])
            .filter((r) =>
              `${r.request_id} ${r.session_key ?? ''} ${r.project_name} ${requestAccountLabel(r, accounts.data ?? [])} ${r.requested_model} ${r.effective_model} ${r.route}`
                .toLowerCase()
                .includes(search.toLowerCase())
            )
            .map((r) => [
              formatSamaraDateTime(r.time),
              <>
                {r.project_name}
                <small>{requestAccountLabel(r, accounts.data ?? [])}</small>
              </>,
              <>
                {requestModelLabel(r)}
                <small>{r.route}</small>
              </>,
              <button
                type="button"
                className={`agp-badge agp-number-link ${r.status >= 400 || (r.grpc_status && r.grpc_status !== '0') ? 'agp-warning' : ''}`}
                onClick={() => setSelected(r)}
                aria-label={`Результат ${r.status}. Открыть запрос`}
              >
                {r.status}
                {r.grpc_status ? ` / gRPC ${r.grpc_status}` : ''}
              </button>,
              detail(r.duration_ms, r, 'Время ответа', 'duration_ms'),
              detail(r.ttft_ms, r, 'TTFT', 'ttft_ms'),
              detail(r.input_tokens, r, 'Входные токены', 'input_tokens'),
              detail(r.output_tokens, r, 'Выходные токены', 'output_tokens'),
              detail(r.cache_tokens, r, 'Кэш', 'cache_tokens'),
              <Button variant="secondary" size="sm" onClick={() => setSelected(r)}>
                Открыть
              </Button>,
            ])}
        />
        <div className="agp-actions agp-pagination">
          <Button
            variant="secondary"
            disabled={!offset || resource.loading}
            onClick={() => page(Math.max(0, offset - 50))}
          >
            Назад
          </Button>
          <span>
            {resource.data?.total ? offset + 1 : 0}–
            {Math.min(offset + 50, resource.data?.total ?? 0)} из{' '}
            {formatMetric(resource.data?.total)}
          </span>
          <Button
            variant="secondary"
            disabled={resource.loading || offset + 50 >= (resource.data?.total ?? 0)}
            onClick={() => page(offset + 50)}
          >
            Далее
          </Button>
        </div>
      </Card>
      <Modal
        open={!!selected}
        title="Метаданные запроса"
        onClose={() => setSelected(undefined)}
        width={900}
      >
        {selected && (
          <>
            <p>
              Время по Самаре (UTC+4). Сохраняются только метаданные. Тела запросов, ответов и ключи
              отсутствуют.
            </p>
            <dl>
              {Object.entries(selected)
                .filter(([key]) => key !== 'attempts')
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{formatConsoleValue(key, value)}</dd>
                  </div>
                ))}
            </dl>
            <h3>Попытки по аккаунтам</h3>
            <DataTable
              headers={['Аккаунт', 'Модель', 'Исход', 'Категория', 'TTFT, мс']}
              rows={selected.attempts.map((a) => [
                requestAccountLabel({ ...selected, account_id: a.account_id }, accounts.data ?? []),
                display(a.effective_model),
                a.outcome,
                display(a.error_category),
                formatMetric(a.ttft_ms),
              ])}
            />
          </>
        )}
      </Modal>
    </>
  );
}
