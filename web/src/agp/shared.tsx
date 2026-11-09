/* eslint-disable react-refresh/only-export-components -- Shared console primitives and hooks intentionally share this adapter module. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/Table';
import { consoleApi, display } from './api';
export { Card, Button, display };
export function useResource<T>(path: string) {
  const requestVersion = useRef(0);
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState('');
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    try {
      const result = await consoleApi<T>(path);
      if (version !== requestVersion.current) return;
      setData(result);
      setUpdated(new Date().toLocaleTimeString('ru'));
    } catch (e) {
      if (version === requestVersion.current)
        setError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [path]);
  const invalidate = useCallback(() => {
    requestVersion.current++;
  }, []);
  useEffect(() => {
    setData(undefined);
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  return { data, error, loading, updated, refresh };
}
export function ResourceState({
  resource,
}: {
  resource: { loading: boolean; error: string; updated: string };
}) {
  return (
    <div aria-live="polite" className="agp-resource">
      {resource.loading ? (
        'Загрузка…'
      ) : resource.error ? (
        <span role="alert" className="error-box">
          {resource.error}
        </span>
      ) : resource.updated ? (
        `Обновлено ${resource.updated}`
      ) : (
        ''
      )}
    </div>
  );
}
export function PageHeader({
  title,
  resource,
  children,
}: {
  title: string;
  resource: { refresh: () => Promise<void>; loading: boolean; error: string; updated: string };
  children?: ReactNode;
}) {
  return (
    <>
      <div className="agp-page-heading">
        <h1>{title}</h1>
        <div className="agp-actions">
          {children}
          <Button
            variant="secondary"
            loading={resource.loading}
            onClick={() => void resource.refresh()}
          >
            Обновить
          </Button>
        </div>
      </div>
      <ResourceState resource={resource} />
    </>
  );
}
export function DataTable({
  headers,
  rows,
  empty = 'Данных пока нет',
}: {
  headers: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {headers.map((h) => (
            <TableHead key={h} scope="col">
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length ? (
          rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j}>{cell}</TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={headers.length}>{empty}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
export function JsonEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="agp-field">
      {label}
      <textarea
        className="input agp-code"
        rows={9}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}
export function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <p className="error-box" role="alert">
      {error}
    </p>
  ) : null;
}
export function useMutation(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await action();
      setSuccess('Изменения сохранены');
      await refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Операция не выполнена');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, success, run, setError };
}
