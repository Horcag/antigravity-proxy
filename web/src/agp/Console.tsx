import { useEffect, useState, type FormEvent } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SidebarNavigation } from '@/components/layout/SidebarNavigation';
import type { SidebarNavGroup } from '@/components/layout/sidebarNavigationModel';
import {
  IconSidebarDashboard,
  IconSidebarAuthFiles,
  IconModelCluster,
  IconSidebarUsage,
  IconSidebarLogs,
  IconSlidersHorizontal,
  IconNetwork,
  IconSidebarSystem,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Button, Card, ErrorMessage } from './shared';
import { api, setCsrf } from './api';
import { Accounts } from './Accounts';
import { Projects } from './Projects';
import { Models, SettingsPage } from './Configuration';
import { Requests, StatisticsPage } from './Traffic';
import license from '../../LICENSE?raw';
import './console.scss';
const nav: SidebarNavGroup[] = [
  {
    id: 'console',
    label: 'Управление прокси',
    items: [
      {
        kind: 'link',
        path: '/',
        end: true,
        label: 'Обзор',
        icon: <IconSidebarDashboard size={20} />,
      },
      {
        kind: 'link',
        path: '/accounts',
        label: 'Аккаунты',
        icon: <IconSidebarAuthFiles size={20} />,
      },
      { kind: 'link', path: '/models', label: 'Модели', icon: <IconModelCluster size={20} /> },
      { kind: 'link', path: '/projects', label: 'Проекты', icon: <IconNetwork size={20} /> },
      { kind: 'link', path: '/requests', label: 'Запросы', icon: <IconSidebarLogs size={20} /> },
      {
        kind: 'link',
        path: '/statistics',
        label: 'Статистика',
        icon: <IconSidebarUsage size={20} />,
      },
      {
        kind: 'link',
        path: '/settings',
        label: 'Настройки',
        icon: <IconSlidersHorizontal size={20} />,
      },
    ],
  },
  {
    id: 'about',
    label: 'Интерфейс',
    placement: 'bottom',
    items: [
      {
        kind: 'link',
        path: '/about',
        label: 'Об интерфейсе',
        icon: <IconSidebarSystem size={20} />,
      },
    ],
  },
];
function Attribution() {
  return (
    <Card title="Открытый исходный интерфейс">
      <p>
        Основано на{' '}
        <a href="https://github.com/BlueSkyXN/CPA-Panel-LTS" target="_blank" rel="noreferrer">
          BlueSkyXN / CPA Panel LTS
        </a>
        , ревизия <code>72247c812be814f2158927c2f8d3ffded7c688c1</code>.
      </p>
      <p>
        Переиспользованы навигация, формы, карточки, таблицы, модальные окна, график потока,
        глобальные стили и русская локализация. Адаптер подключает их к Antigravity Proxy.
      </p>
      <pre className="agp-license">{license}</pre>
    </Card>
  );
}
function Shell({ logout }: { logout: () => Promise<void> }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="app-shell agp-shell">
      <a
        href="#main"
        className="agp-skip"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        К содержимому
      </a>
      <aside className={`sidebar agp-sidebar ${menu ? 'agp-menu-open' : ''}`}>
        <div className="sidebar-brand">
          <strong>Antigravity Proxy</strong>
          <small>Административная панель</small>
        </div>
        <SidebarNavigation
          groups={nav}
          collapsed={false}
          showLabels
          showMeta
          ariaLabel="Главная навигация"
          onNavigate={() => setMenu(false)}
          onRequestExpand={() => setMenu(true)}
        />
        <div className="agp-sidebar-foot">
          <small>CPA Panel LTS · MIT</small>
          <Button variant="secondary" onClick={() => void logout()}>
            Выйти
          </Button>
        </div>
      </aside>
      <div className="content">
        <header className="agp-toolbar">
          <Button
            variant="secondary"
            className="agp-mobile-toggle"
            onClick={() => setMenu(!menu)}
            aria-expanded={menu}
          >
            Меню
          </Button>
          <span>
            Antigravity Proxy <span className="agp-muted">/ консоль</span>
          </span>
          <span className="agp-badge">Сессия защищена</span>
        </header>
        <main id="main" tabIndex={-1} className="main-content agp-main">
          <Routes>
            <Route path="/" element={<StatisticsPage overview />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/models" element={<Models />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/statistics" element={<StatisticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/about" element={<Attribution />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <footer className="agp-footer">
            Интерфейс на основе CPA Panel LTS · <a href="#/about">MIT и авторы</a>
          </footer>
        </main>
      </div>
    </div>
  );
}
export default function Console() {
  const [session, setSession] = useState<'loading' | 'login' | 'ready'>('loading');
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const expired = () => {
      setCsrf('');
      setSession('login');
    };
    window.addEventListener('agp-session-expired', expired);
    void api<{ loggedIn: boolean; csrfToken?: string }>('/admin/session')
      .then((s) => {
        setCsrf(s.csrfToken ?? '');
        setSession(s.loggedIn ? 'ready' : 'login');
      })
      .catch((e) => {
        setError(e.message);
        setSession('login');
      });
    return () => window.removeEventListener('agp-session-expired', expired);
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ csrfToken: string }>('/admin/session', 'POST', { key, remember });
      setKey('');
      setCsrf(result.csrfToken);
      setSession('ready');
    } catch (e) {
      setKey('');
      setError(e instanceof Error ? e.message : 'Вход не выполнен');
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api('/admin/session', 'DELETE');
      setCsrf('');
      setSession('login');
      setKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось завершить сессию');
    }
  }
  if (session === 'loading')
    return (
      <div className="agp-login" role="status">
        Проверка сессии…
      </div>
    );
  if (session === 'login')
    return (
      <div className="agp-login">
        <Card title="Antigravity Proxy">
          <p className="agp-eyebrow">АДМИНИСТРАТИВНАЯ ПАНЕЛЬ</p>
          <h1>Вход в консоль</h1>
          <p>
            Введите пароль администратора из настройки <code>AG_PROXY_ADMIN_API_KEY</code> на
            сервере. Если вы его не настраивали, получите его у администратора установки.
          </p>
          <form onSubmit={(e) => void login(e)} className="agp-stack">
            <Input
              label="Пароль администратора"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
            <label className="agp-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Запомнить вход на 7 дней
            </label>
            <ErrorMessage error={error} />
            <Button type="submit" loading={busy} disabled={!key}>
              Войти
            </Button>
          </form>
          <p className="agp-muted">
            Пароль проверяется только этим сервером. Сессия сохраняется защищённой cookie.
          </p>
          <small>CPA Panel LTS · MIT</small>
        </Card>
      </div>
    );
  return (
    <HashRouter>
      <ErrorMessage error={error} />
      <Shell logout={logout} />
    </HashRouter>
  );
}
