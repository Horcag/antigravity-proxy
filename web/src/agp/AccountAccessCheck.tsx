import { Button, ErrorMessage } from './shared';
import { formatSamaraDateTime } from './time';
import type { AccessCheck } from './types';
import type { useAccessChecks } from './useAccessChecks';

export function AccessCheckStatus({ result }: { result?: AccessCheck | null }) {
  if (!result) return <small>Доступ ещё не проверен</small>;
  const title = result.outcome === 'working'
    ? result.comparison === 'restored' ? 'Доступ восстановлен' : 'Генерация работает'
    : result.outcome === 'banned' ? 'Блокировка подтверждена' : 'Результат не определён';
  return (
    <div>
      <span className={`agp-badge ${result.outcome === 'working' ? '' : 'agp-warning'}`}>{title}</span>
      <small>Проверено: {formatSamaraDateTime(result.checked_at)}</small>
      <small>Длительность: {result.duration_ms === undefined ? 'не измерена' : `${result.duration_ms} мс`}</small>
      <small>{result.evidence.http_status !== undefined
        ? `Ответ Google (генерация): HTTP ${result.evidence.http_status}`
        : result.evidence.stage === 'oauth'
          ? 'Проверка остановилась на OAuth: ответ генерации не получен.'
          : 'HTTP-ответ генерации не получен.'}</small>
      <small>{result.message}</small>
      <small>
        {result.comparison === 'same' ? 'Та же причина, что в прошлый раз.'
          : result.comparison === 'changed' ? 'Результат изменился.'
            : result.comparison === 'first' ? 'Первая проверка.' : 'Ранее блокировка была подтверждена.'}
        {result.previous_reason && ` Предыдущая причина: ${result.previous_reason}.`}
      </small>
      <details>
        <summary>Диагностика проверки</summary>
        <small>Причина: {result.reason}. Этап: {result.evidence.stage}.</small>
        {result.evidence.model && <small>Модель: {result.evidence.model}</small>}
        {result.evidence.rule_id && <small>Признак: {result.evidence.rule_id}</small>}
        {result.previous_checked_at && <small>Прошлая проверка: {formatSamaraDateTime(result.previous_checked_at)}</small>}
      </details>
    </div>
  );
}

export function AccessCheckProgress({ checks }: { checks: ReturnType<typeof useAccessChecks> }) {
  return <>
    <p>Проверка делает короткий запрос к модели от выбранного аккаунта, включая выключенные. Расходуется небольшая часть квоты. Результат относится к указанной модели и времени; включение аккаунта остаётся ручным.</p>
    <p role="status">{checks.progress}</p>
    <ErrorMessage error={checks.error} />
    {checks.busy && <Button variant="secondary" onClick={checks.cancel}>Остановить после текущего аккаунта</Button>}
  </>;
}
