import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStore } from '../store/useStore';

const NAV = [
  { to: '/scanner', label: 'Сканер выгоды' },
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
    </div>
  );
}
