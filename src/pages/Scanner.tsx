import { useState } from 'react';
import { Page, Warning } from '../components/ui';
import { Discover } from './scanner/Discover';
import { Opportunities } from './scanner/Opportunities';
import { Params } from './scanner/Params';
import { Sources } from './scanner/Sources';
import { useScanner } from './scanner/useScanner';
import { Watches } from './scanner/Watches';

const TABS = [
  { id: 'opps', label: 'Возможности' },
  { id: 'watch', label: 'Отслеживание' },
  { id: 'discover', label: 'Автопоиск скинов' },
  { id: 'sources', label: 'Источники' },
  { id: 'params', label: 'Параметры' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const readTab = (): Tab => {
  try {
    const t = localStorage.getItem('funpay-ops:scanner-tab') as Tab | null;
    return TABS.some((x) => x.id === t) ? t! : 'opps';
  } catch {
    return 'opps';
  }
};

export default function Scanner() {
  const sc = useScanner();
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem('funpay-ops:scanner-tab', t);
    } catch {
      /* noop */
    }
  };

  return (
    <Page
      title="Сканер выгоды"
      subtitle="Где купить дешевле и почём продать на FunPay — с комиссиями, выводом, спорами и подрезкой цены. Цены собирает локальный сервер с публичных страниц и API."
      actions={
        <span className={`flex items-center gap-2 text-xs ${sc.offline ? 'text-bad' : 'text-good'}`}>
          <span className={`h-2 w-2 rounded-full ${sc.offline ? 'bg-bad' : 'bg-good'}`} />
          {sc.offline ? 'сервер не запущен' : sc.health?.allRunning ? 'сканирую…' : 'сервер работает'}
        </span>
      }
    >
      {sc.offline ? (
        <Warning tone="bad">
          <p className="font-medium">Сервер сканера не отвечает.</p>
          <p>
            Запусти в папке проекта <span className="num">npm run dev</span> (поднимает и интерфейс, и сервер) или отдельно <span className="num">npm run server</span>.
          </p>
          <p className="text-xs text-muted">{sc.offline}</p>
        </Warning>
      ) : (
        <>
          <Warning>
            <p>
              Это оценка, а не гарантия. Цена конкурента на FunPay — не цена продажи: проверь спрос и правила раздела (перепродажа офлайн-активаций, гифтов и
              аккаунтов может быть запрещена — см. «Правила»). Перед покупкой открой обе ссылки и сверь товар, регион и платформу.
            </p>
          </Warning>
          <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`rounded-md px-3 py-1.5 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'watch' && sc.watches.length > 0 && <span className="num ml-1 opacity-70">{sc.watches.length}</span>}
                {t.id === 'sources' && sc.sources.length > 0 && <span className="num ml-1 opacity-70">{sc.sources.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'opps' && <Opportunities sc={sc} />}
          {tab === 'watch' && <Watches sc={sc} />}
          {tab === 'discover' && <Discover sc={sc} />}
          {tab === 'sources' && <Sources sc={sc} />}
          {tab === 'params' && <Params />}
        </>
      )}
    </Page>
  );
}
