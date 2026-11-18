import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { consoleApi } from './api';
import type { Account } from './types';
import { formatConsoleValue, formatSamaraDateTime } from './time';
import { summarizeAccountQuota } from './quotaSummary';
import { AccessCheckProgress, AccessCheckStatus } from './AccountAccessCheck';
import { useAccessChecks } from './useAccessChecks';
import {
  Button,
  Card,
  DataTable,
  ErrorMessage,
  PageHeader,
  display,
  useMutation,
  useResource,
} from './shared';
export function Accounts() {
  const resource = useResource<Account[]>('/accounts');
  const stats = useResource<{
    accounts?: Array<{ account_id: string; success_attempts: number; failed_attempts: number }>;
  }>('/statistics');
  const mutation = useMutation(resource.refresh);
  const checks = useAccessChecks(resource.refresh);
  const [selected, setSelected] = useState<Account>();
  const [add, setAdd] = useState(false);
  const [confirm, setConfirm] = useState<{ account: Account; action: 'remove' | 'enable' }>();
  const [payload, setPayload] = useState('');
  const [oauth, setOauth] = useState<{ url: string; state: string; instructions: string }>();
  const [code, setCode] = useState('');
  const [oauthCopied, setOauthCopied] = useState(false);
  const [oauthStatus, setOauthStatus] = useState('');
  const refreshAccounts = resource.refresh;
  useEffect(() => {
    if (!oauth || !add) return;
    let cancelled = false;
    let timer: number | undefined;
    const deadline = Date.now() + 600_000;
    async function poll() {
      if (!oauth || cancelled) return;
      try {
        const result = await consoleApi<{ status: string; error: string | null }>(
          `/oauth/status?state=${encodeURIComponent(oauth.state)}`
        );
        if (cancelled) return;
        if (result.status === 'completed') {
          setOauth(undefined);
          setCode('');
          setPayload('');
          setAdd(false);
          setOauthStatus('Аккаунт добавлен через Google OAuth');
          await refreshAccounts();
          return;
        }
        if (result.status === 'error') {
          setOauthStatus(result.error ?? 'Авторизация не завершена');
          return;
        }
        setOauthStatus(
          result.status === 'processing' ? 'Сохранение аккаунта…' : 'Ожидание авторизации в Google…'
        );
        if (Date.now() < deadline) timer = window.setTimeout(() => void poll(), 2000);
        else setOauthStatus('Время авторизации истекло. Начните заново.');
      } catch (e) {
        if (!cancelled)
          setOauthStatus(e instanceof Error ? e.message : 'Не удалось проверить OAuth');
      }
    }
    timer = window.setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [oauth, add, refreshAccounts]);
  const [search, setSearch] = useState('');
  function closeAdd() {
    setAdd(false);
    setPayload('');
    setCode('');
    setOauth(undefined);
    setOauthCopied(false);
  }
  return (
    <>
      <PageHeader
        title="Аккаунты"
        resource={{
          ...resource,
          refresh: async () => {
            await Promise.all([resource.refresh(), stats.refresh()]);
          },
        }}
      >
        <Button
          loading={checks.busy}
          disabled={mutation.busy || resource.loading || !resource.data?.length}
          variant="secondary"
          onClick={() => void checks.run(resource.data ?? [])}
        >
          Проверить доступ всех
        </Button>
        <Button
          loading={mutation.busy}
          variant="secondary"
          onClick={() => void mutation.run(() => consoleApi('/accounts/refresh-quota', 'POST'))}
        >
          Обновить квоты
        </Button>
        <Button onClick={() => setAdd(true)}>Добавить аккаунт</Button>
      </PageHeader>
      <ErrorMessage error={mutation.error} />
      <p role="status">{mutation.success || oauthStatus}</p>
      <AccessCheckProgress checks={checks} />
      <Input
        label="Поиск по ID, имени или почте"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Card>
        <DataTable
          headers={['Аккаунт', 'Статус', 'Проверка доступа', 'Квота', 'Успешные / неудачные попытки', 'Действия']}
          rows={(resource.data ?? [])
            .filter((a) =>
              `${a.id} ${a.name} ${a.email}`.toLowerCase().includes(search.toLowerCase())
            )
            .map((a) => {
              const s = stats.data?.accounts?.find((s) => s.account_id === a.id);
              const localCheck = checks.results[a.id];
              const accessCheck = a.access_check && (!localCheck || a.access_check.checked_at >= localCheck.checked_at)
                ? a.access_check : localCheck;
              return [
                <>
                  <strong>{a.name || a.email}</strong>
                  <small>
                    {a.email}
                    <br />
                    {a.id}
                  </small>
                </>,
                <>
                  <span className={`agp-badge ${a.disabled ? 'agp-warning' : ''}`}>
                    {a.disabled ? 'Выключен' : a.status}
                  </span>
                  <small>{a.status_reason}</small>
                </>,
                <AccessCheckStatus result={accessCheck} />,
                (() => {
                  const summary = summarizeAccountQuota(a.quota);
                  return summary ? (
                    <>
                      <span>{summary.tierLabel}</span>
                      {summary.groups.map((group) => (
                        <small key={group.id}>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setSelected(a)}
                            aria-label={`Снимок квоты ${group.label} аккаунта ${a.name || a.email}: ${group.compactText}`}
                          >
                            {group.compactText}
                          </Button>
                        </small>
                      ))}
                    </>
                  ) : (
                    'Неизвестно'
                  );
                })(),
                <>
                  {stats.data ? (
                    <>
                      <Link
                        to={`/requests?accountId=${encodeURIComponent(a.id)}&attemptOutcome=success`}
                        aria-label={`Успешные попытки аккаунта ${a.name || a.email}: ${s?.success_attempts ?? 0}`}
                      >
                        {display(s?.success_attempts ?? 0)}
                      </Link>
                      {' / '}
                      <Link
                        to={`/requests?accountId=${encodeURIComponent(a.id)}&attemptOutcome=failure`}
                        aria-label={`Неудачные попытки аккаунта ${a.name || a.email}: ${s?.failed_attempts ?? 0}`}
                      >
                        {display(s?.failed_attempts ?? 0)}
                      </Link>
                    </>
                  ) : (
                    'Неизвестно'
                  )}
                </>,
                <div className="agp-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={checks.current === a.id}
                    disabled={checks.busy || mutation.busy}
                    onClick={() => void checks.run([a])}
                  >
                    Проверить доступ
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setSelected(a)}>
                    Подробнее
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={mutation.busy}
                    onClick={() =>
                      a.disabled
                        ? setConfirm({ account: a, action: 'enable' })
                        : void mutation.run(() =>
                            consoleApi(`/accounts/${encodeURIComponent(a.id)}`, 'PATCH', {
                              disabled: true,
                            })
                          )
                    }
                  >
                    {a.disabled ? 'Включить' : 'Выключить'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setConfirm({ account: a, action: 'remove' })}
                  >
                    Удалить
                  </Button>
                </div>,
              ];
            })}
        />
      </Card>
      <Modal open={!!selected} title="Аккаунт" onClose={() => setSelected(undefined)}>
        {selected && (
          <>
            <dl>
              {Object.entries(selected)
                .filter(([key]) => key !== 'quota')
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{formatConsoleValue(k, v)}</dd>
                  </div>
                ))}
            </dl>
            {selected.quota && (() => {
              const summary = summarizeAccountQuota(selected.quota);
              return (
                <>
                  <p>
                    Источник: сохранённый сервером снимок квоты Google. Последнее успешное обновление:{' '}
                    {formatSamaraDateTime(selected.quota.last_successful_refresh_at)}.
                  </p>
                  {summary && summary.groups.length > 0 && (
                    <DataTable
                      headers={['Группа лимита', '5 часов', 'Неделя', 'Модели']}
                      rows={summary.groups.map((g) => [
                        g.label,
                        g.fiveHour ? `${g.fiveHour.percentage}% (до ${formatSamaraDateTime(g.fiveHour.resetTime)})` : '—',
                        g.weekly ? `${g.weekly.percentage}% (до ${formatSamaraDateTime(g.weekly.resetTime)})` : '—',
                        g.modelsHint,
                      ])}
                    />
                  )}
                  <DataTable
                    headers={['Модель', 'ID', 'Осталось, %', 'Сброс квоты']}
                    rows={(summary?.models ?? []).map((m) => [
                      m.displayName,
                      m.modelId,
                      m.percentage,
                      formatSamaraDateTime(m.resetTime),
                    ])}
                  />
                </>
              );
            })()}
            <Link
              className="btn btn-secondary"
              to={`/requests?accountId=${encodeURIComponent(selected.id)}`}
            >
              История запросов аккаунта
            </Link>
          </>
        )}
      </Modal>
      <Modal
        open={!!confirm}
        title={confirm?.action === 'remove' ? 'Удалить аккаунт?' : 'Включить аккаунт?'}
        onClose={() => setConfirm(undefined)}
        footer={
          <Button
            variant={confirm?.action === 'remove' ? 'danger' : 'primary'}
            loading={mutation.busy}
            onClick={() => {
              if (!confirm) return;
              const { account, action } = confirm;
              void mutation
                .run(() =>
                  consoleApi(
                    `/accounts/${encodeURIComponent(account.id)}`,
                    action === 'remove' ? 'DELETE' : 'PATCH',
                    action === 'remove' ? undefined : { disabled: false, confirmReview: true }
                  )
                )
                .then((result) => {
                  if (result !== undefined) setConfirm(undefined);
                });
            }}
          >
            Подтвердить
          </Button>
        }
      >
        <p>{confirm?.account.email || confirm?.account.id}</p>
        {confirm?.account.review_required && (
          <p className="error-box">
            Аккаунт требует проверки условий Google. Подтверждайте включение только после завершения
            проверки и устранения причины блокировки.
          </p>
        )}
        <ErrorMessage error={mutation.error} />
      </Modal>
      <Modal
        open={add}
        title="Добавить аккаунт"
        onClose={closeAdd}
        closeDisabled={mutation.busy}
        width={680}
      >
        <p>
          Google OAuth или импорт JSON CPA / экспорта Antigravity Proxy. Данные отправляются только
          этому серверу.
        </p>
        <Button
          variant="secondary"
          loading={mutation.busy}
          onClick={() =>
            void mutation
              .run(() =>
                consoleApi<{ url: string; state: string; instructions: string }>('/oauth/start')
              )
              .then((v) => {
                if (v) {
                  setCode('');
                  setOauthCopied(false);
                  setOauthStatus('Откройте ссылку в профиле браузера с нужным Google-аккаунтом.');
                  setOauth(v);
                }
              })
          }
        >
          {oauth ? 'Получить новую ссылку' : 'Получить ссылку для входа Google'}
        </Button>
        {oauth && (
          <div className="agp-stack">
            <Input
              label="Ссылка для входа Google"
              value={oauth.url}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(oauth.url);
                  setOauthCopied(true);
                } catch {
                  mutation.setError('Не удалось скопировать. Выделите ссылку в поле и скопируйте вручную.');
                }
              }}
            >
              {oauthCopied ? 'Ссылка скопирована' : 'Копировать ссылку'}
            </Button>
            <p>
              Скопируйте ссылку и откройте её в профиле браузера с нужным Google-аккаунтом.
              Выполните вход и разрешите доступ. Ссылка действует 10 минут; оставьте это окно открытым.
            </p>
            <p>
              После входа аккаунт добавится автоматически. Если этого не произошло, скопируйте
              полный адрес страницы, на которую вернул Google (даже если она не открылась),
              и вставьте ниже. Если показан код авторизации, можно вставить только код.
            </p>
            <p role="status">{oauthStatus}</p>
            <Input
              label="Код или полный адрес после входа Google"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
            />
            <Button
              loading={mutation.busy}
              disabled={!code.trim()}
              onClick={() =>
                void mutation
                  .run(() => consoleApi('/oauth/exchange', 'POST', { state: oauth.state, code: code.trim() }))
                  .then((v) => {
                    if (v !== undefined) closeAdd();
                  })
              }
            >
              Завершить OAuth
            </Button>
          </div>
        )}
        <hr />
        <label className="agp-field">
          Файл JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                if (file.size > 2_000_000) {
                  mutation.setError('Файл превышает 2 МБ');
                  return;
                }
                void file.text().then(setPayload);
              }
              e.target.value = '';
            }}
          />
        </label>
        <label className="agp-field">
          JSON
          <textarea
            className="input agp-code"
            rows={7}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <ErrorMessage error={mutation.error} />
        <Button
          loading={mutation.busy}
          disabled={!payload.trim()}
          onClick={() =>
            void mutation
              .run(() => consoleApi('/accounts/import', 'POST', JSON.parse(payload)))
              .then((v) => {
                if (v !== undefined) closeAdd();
              })
          }
        >
          Импортировать
        </Button>
      </Modal>
    </>
  );
}
