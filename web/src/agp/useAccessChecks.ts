import { useEffect, useRef, useState } from 'react';
import { consoleApi } from './api';
import type { AccessCheck, Account } from './types';

export function useAccessChecks(refresh: () => Promise<void>) {
  const running = useRef(false);
  const stop = useRef(false);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<Record<string, AccessCheck>>({});
  useEffect(() => () => { stop.current = true; }, []);
  async function run(accounts: Account[]) {
    if (running.current || accounts.length === 0) return;
    running.current = true;
    stop.current = false;
    setBusy(true);
    setError('');
    let completed = 0;
    let failures = 0;
    try {
      for (const account of accounts) {
        if (stop.current) break;
        setCurrent(account.id);
        setProgress(`Проверка ${completed + 1} из ${accounts.length}: ${account.email}`);
        try {
          const result = await consoleApi<AccessCheck>(
            `/accounts/${encodeURIComponent(account.id)}/check-access`, 'POST', undefined, 65000
          );
          setResults((previous) => ({ ...previous, [account.id]: result }));
        } catch (e) {
          failures++;
          setError(`${account.email}: ${e instanceof Error ? e.message : 'Проверка не завершена'}. Предыдущий результат не является новой проверкой.`);
        }
        completed++;
      }
      setProgress(`${stop.current ? 'Остановлено' : 'Проверка завершена'}: ${completed} из ${accounts.length}. Ошибок выполнения: ${failures}.`);
      await refresh();
    } finally {
      running.current = false;
      setBusy(false);
      setCurrent('');
    }
  }
  return { busy, current, progress, error, results, run, cancel: () => { stop.current = true; } };
}

