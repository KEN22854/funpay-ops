import { motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, Page, Stat, Warning } from '../components/ui';
import { api, type Decision } from '../lib/api';
import { fmtRub } from '../lib/format';

type Data = Awaited<ReturnType<typeof api.decisions>>;

const PRIORITY: Record<Decision['priority'], { label: string; tone: 'bad' | 'warn' | 'muted' }> = {
  1: { label: 'сейчас', tone: 'bad' },
  2: { label: 'сегодня', tone: 'warn' },
  3: { label: 'при случае', tone: 'muted' },
};

const KIND: Record<Decision['kind'], string> = {
  buy: 'Купить',
  verify: 'Перепроверить',
  match: 'Сверить товар',
  fee: 'Комиссия',
  loss: 'Убыток',
  stale: 'Залежалось',
  transit: 'В пути',
  reserve: 'Резерв',
  source: 'Источник',
  data: 'Данные',
  capital: 'Капитал',
  strategy: 'Стратегия',
};

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'money', label: 'Деньги', kinds: ['buy', 'verify', 'match', 'loss'] },
  { id: 'stock', label: 'Склад', kinds: ['loss', 'stale', 'transit', 'reserve'] },
  { id: 'setup', label: 'Настройка и данные', kinds: ['fee', 'source', 'data', 'capital', 'strategy'] },
] as const;

/** Decision Center: что сделать прямо сейчас, по приоритету и эффекту в рублях. */
export default function Decisions() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem('funpay-ops:decisions-hidden') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.decisions());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  const hide = (id: string) => {
    const next = new Set(hidden).add(id);
    setHidden(next);
    try {
      sessionStorage.setItem('funpay-ops:decisions-hidden', JSON.stringify([...next]));
    } catch {
      /* noop */
    }
  };

  const f = FILTERS.find((x) => x.id === filter)!;
  const list = (data?.decisions ?? []).filter((d) => !hidden.has(d.id) && ('kinds' in f ? (f.kinds as readonly string[]).includes(d.kind) : true));
  const s = data?.summary;

  return (
    <Page title="Что делать" subtitle="Конкретные действия по вашим данным: что купить, что перепроверить, где теряются деньги. Сначала — то, что приносит или спасает деньги сейчас.">
      {error && <Warning tone="bad">{error}</Warning>}
      {s && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Можно купить сейчас" value={fmtRub(s.buyNowRub)} tone={s.buyNowRub > 0 ? 'good' : undefined} sub="ожидаемая прибыль исполнимых связок" />
          <Stat label="Ждёт перепроверки" value={fmtRub(s.unlockRub)} tone={s.unlockRub > 0 ? 'warn' : undefined} sub="потенциал кандидатов и сверок" />
          <Stat label="Под угрозой" value={fmtRub(s.atRiskRub)} tone={s.atRiskRub > 0 ? 'bad' : undefined} sub="убыток по складу при продаже по рынку" />
          <Stat label="Свободные деньги" value={s.freeCash === null ? 'не заданы' : fmtRub(s.freeCash)} sub="касса минус резервы" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
          {FILTERS.map((x) => (
            <button key={x.id} className={`rounded-md px-3 py-1.5 ${filter === x.id ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`} onClick={() => setFilter(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <button className="btn-ghost ml-auto" onClick={load} disabled={busy}>
          {busy ? 'Обновляю…' : 'Обновить'}
        </button>
      </div>
      {data && list.length === 0 && (
        <Empty>
          Сейчас действий нет. Добавьте товары в <Link to="/scanner?tab=watch" className="text-accent underline">каталог</Link> и дождитесь сканов — здесь появятся покупки, перепроверки и предупреждения.
        </Empty>
      )}
      <ul className="space-y-2">
        {list.map((d, i) => (
          <motion.li key={d.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.02 }}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={PRIORITY[d.priority].tone}>{PRIORITY[d.priority].label}</Badge>
                <span className="text-xs text-muted">{KIND[d.kind]}</span>
                {d.impactRub !== null && (
                  <span className={`num text-sm font-medium ${d.impactRub >= 0 ? 'text-good' : 'text-bad'}`}>
                    {d.impactRub > 0 ? '+' : ''}
                    {fmtRub(d.impactRub)}
                  </span>
                )}
              </div>
              <h2 className="mt-1 font-medium">{d.title}</h2>
              <p className="mt-1 text-sm text-muted">{d.detail}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Link to={d.action.to} className="btn-primary">
                {d.action.label}
              </Link>
              <button className="btn-ghost" onClick={() => hide(d.id)} title="Скрыть до перезапуска вкладки">
                Скрыть
              </button>
            </div>
          </motion.li>
        ))}
      </ul>
      <Card title="Как это работает">
        <p className="text-sm text-muted">
          Правила пересчитываются каждую минуту по текущим связкам, складу, кассе и качеству источников. Они только советуют: закупки, цены и продажи остаются вашим решением. «Купить» появляется лишь для связок,
          у которых цена и наличие перепроверены; при нехватке денег более выгодные покупки идут первыми. Та же сводка — командой <code>/todo</code> в Telegram.
        </p>
      </Card>
    </Page>
  );
}
