import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';

const NAV = [
  { to: '/decisions', label: 'Что делать' },
  { to: '/scanner', label: 'Сканер выгоды' },
  { to: '/inventory', label: 'Склад и финансы' },
  { to: '/quality', label: 'Качество и риск' },
  { to: '/calculator', label: 'Калькулятор' },
  { to: '/journal', label: 'Журнал' },
  { to: '/auto-delivery', label: 'Автовыдача' },
  { to: '/rules', label: 'Правила' },
  { to: '/tools', label: 'Инструменты' },
  { to: '/start', label: 'Как начать' },
  { to: '/settings', label: 'Настройки' },
];

export function Layout() {
  const theme = useStore((s) => s.settings.theme);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => setOpen(false), [pathname]);
  // серверный режим (VPS): API ответил «нужен вход» — показываем форму ключа доступа
  const [needLogin, setNeedLogin] = useState(false);
  useEffect(() => {
    const h = () => setNeedLogin(true);
    window.addEventListener('fpo:auth-required', h);
    return () => window.removeEventListener('fpo:auth-required', h);
  }, []);

  const link = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:bg-raised hover:text-fg'}`;

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-4">
          <NavLink to="/calculator" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold text-white">FP</span>
            FunPay Ops
          </NavLink>
          <button className="btn-ghost px-2 py-1 md:hidden" onClick={() => setOpen((v) => !v)} aria-label="Меню">
            ☰
          </button>
        </div>
        <nav className={`${open ? 'block' : 'hidden'} space-y-1 px-3 pb-4 md:block`}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={link}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-6 sm:px-6 md:py-8">
        <Outlet />
      </main>
      {needLogin && <LoginDialog />}
    </div>
  );
}

function LoginDialog() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <form
        className="card w-full max-w-sm space-y-3 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.login(token);
            location.reload();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h2 className="font-semibold">Вход в FunPay Ops</h2>
        <p className="text-xs text-muted">Сервер открыт в сеть и защищён ключом доступа (FPO_AUTH_TOKEN).</p>
        <input className="input" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="ключ доступа" />
        {error && <p className="text-sm text-bad">{error}</p>}
        <button className="btn-primary w-full" disabled={!token}>
          Войти
        </button>
      </form>
    </div>
  );
}
