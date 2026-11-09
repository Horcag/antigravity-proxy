import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { consoleApi } from './api';
import type { Project } from './types';
import {
  Button,
  Card,
  DataTable,
  ErrorMessage,
  PageHeader,
  useMutation,
  useResource,
} from './shared';
export function Projects() {
  const resource = useResource<Project[]>('/projects');
  const mutation = useMutation(resource.refresh);
  const [add, setAdd] = useState(false);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<{ project: Project; action: 'rotate' | 'delete' }>();
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  function reveal(v: Project | undefined) {
    if (v?.api_key) {
      setSecret(v.api_key);
      setCopied(false);
    }
    if (v) {
      setConfirm(undefined);
      setAdd(false);
      setName('');
    }
  }
  return (
    <>
      <PageHeader title="Проекты и ключи" resource={resource}>
        <Button onClick={() => setAdd(true)}>Создать проект</Button>
      </PageHeader>
      <p>Существующие ключи скрыты. Новый ключ показывается один раз после создания или ротации.</p>
      <ErrorMessage error={mutation.error} />
      <p role="status">{mutation.success}</p>
      <Card>
        <DataTable
          headers={['Проект', 'ID', 'Доступ', 'Действия']}
          rows={(resource.data ?? []).map((p) => [
            p.name,
            p.id,
            p.enabled ? 'Включён' : 'Выключен',
            <div className="agp-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(() =>
                    consoleApi(`/projects/${encodeURIComponent(p.id)}`, 'PATCH', {
                      enabled: !p.enabled,
                    })
                  )
                }
              >
                {p.enabled ? 'Выключить' : 'Включить'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirm({ project: p, action: 'rotate' })}
              >
                Сменить ключ
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirm({ project: p, action: 'delete' })}
              >
                Удалить
              </Button>
            </div>,
          ])}
        />
      </Card>
      <Modal
        open={add}
        title="Новый проект"
        onClose={() => setAdd(false)}
        footer={
          <Button
            loading={mutation.busy}
            disabled={!name.trim()}
            onClick={() =>
              void mutation
                .run(() => consoleApi<Project>('/projects', 'POST', { name: name.trim() }))
                .then(reveal)
            }
          >
            Создать
          </Button>
        }
      >
        <Input
          label="Название проекта"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
        <ErrorMessage error={mutation.error} />
      </Modal>
      <Modal
        open={!!confirm}
        title={confirm?.action === 'rotate' ? 'Заменить ключ проекта?' : 'Удалить проект?'}
        onClose={() => setConfirm(undefined)}
        footer={
          <Button
            variant="danger"
            loading={mutation.busy}
            onClick={() => {
              if (!confirm) return;
              const path = `/projects/${encodeURIComponent(confirm.project.id)}`;
              void mutation
                .run(() =>
                  consoleApi<Project>(
                    confirm.action === 'rotate' ? `${path}/rotate` : path,
                    confirm.action === 'rotate' ? 'POST' : 'DELETE'
                  )
                )
                .then(reveal);
            }}
          >
            Подтвердить
          </Button>
        }
      >
        <p>{confirm?.project.name}. Прежний ключ перестанет работать.</p>
        <ErrorMessage error={mutation.error} />
      </Modal>
      <Modal
        open={!!secret}
        title="Сохраните новый ключ"
        onClose={() => {
          setSecret('');
          setCopied(false);
        }}
      >
        <p>После закрытия ключ больше не отображается. Храните его в защищённом месте.</p>
        <code className="agp-secret">{secret}</code>
        <Button
          onClick={() =>
            void navigator.clipboard
              .writeText(secret)
              .then(() => setCopied(true))
              .catch(() => mutation.setError('Не удалось скопировать. Скопируйте ключ вручную.'))
          }
        >
          {copied ? 'Скопировано' : 'Копировать'}
        </Button>
        <ErrorMessage error={mutation.error} />
      </Modal>
    </>
  );
}
