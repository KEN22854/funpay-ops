import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Card, Empty, NumberField, Page, Stat, Warning } from '../components/ui';
import { api, type BacktestParams, type Mode, type PolicyTier, type StrategyStats, type WilsonBound } from '../lib/api';
import { fmtDateTime, fmtPct, fmtRub } from '../lib/format';

const TABS = [
  { id: 'metrics', label: 'Метрики' },
  { id: 'risk', label: 'Капитал и риск' },
  { id: 'demand', label: 'Спрос' },
  { id: 'paper', label: 'Paper trading' },
  { id: 'backtest', label: 'Бэктест' },
  { id: 'sources', label: 'Источники' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`);
const STRAT: Record<string, string> = { fast: 'Быстрый оборот', balanced: 'Сбалансированная', max: 'Максимальная маржа' };

/** Обратная связь от реальных сделок: качество сигналов, капитал, спрос, стратегии. */
export default function Quality() {
  const [params] = useSearchParams();
  const fromUrl = params.get('tab');
  const valid = (t: string | null): t is Tab => TABS.some((x) => x.id === t);
  const [tab, setTab] = useState<Tab>(valid(fromUrl) ? fromUrl : 'metrics');
  useEffect(() => {
    if (valid(fromUrl)) setTab(fromUrl);
  }, [fromUrl]);
  return (
    <Page title="Качество и риск" subtitle="Насколько рекомендации подтверждаются фактом, где работает капитал, как быстро продаётся товар и какая стратегия цены лучше — по вашим данным, а не по впечатлению.">
      <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {TABS.map((t) => (
          <button key={t.id} className={`rounded-md px-3 py-1.5 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'metrics' && <Metrics />}
      {tab === 'risk' && <Risk />}
      {tab === 'demand' && <Demand />}
      {tab === 'paper' && <Paper />}
      {tab === 'backtest' && <Backtest />}
      {tab === 'sources' && <SourcesQuality />}
    </Page>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    fn()
      .then(setData)
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, load };
}

function Metrics() {
  const [days, setDays] = useState(30);
  const { data: m, error } = useLoad(() => api.productMetrics(`days=${days}`), [days]);
  if (error) return <Warning tone="bad">{error}</Warning>;
  if (!m) return null;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {[7, 30, 90, 365].map((x) => (
          <button key={x} className={`rounded-md px-3 py-1.5 ${days === x ? 'bg-accent text-white' : 'text-muted'}`} onClick={() => setDays(x)}>
            {x} дн
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Precision рекомендаций" value={pct(m.precision.value)} sub={`${m.precision.profitable} прибыльных из ${m.precision.known} с известным исходом`} />
        <Stat label="Ложные срабатывания" value={pct(m.falsePositiveRate)} tone={m.falsePositiveRate && m.falsePositiveRate > 0.3 ? 'bad' : undefined} sub="рекомендация → убыток" />
        <Stat label="Net P&L" value={fmtRub(m.netPnL)} tone={m.netPnL >= 0 ? 'good' : 'bad'} sub="чистая прибыль за период" />
        <Stat label="Ошибка прогноза прибыли" value={m.forecastError.profitMaePerUnit === null ? '—' : fmtRub(m.forecastError.profitMaePerUnit)} sub="MAE на 1 шт" />
        <Stat label="Ошибка прогноза срока" value={m.forecastError.daysMae === null ? '—' : `${m.forecastError.daysMae.toFixed(1)} дн.`} sub={`по ${m.forecastError.samples} рекомендациям`} />
        <Stat label="Sell-through" value={pct(m.sellThrough)} sub="продано / получено за период" />
        <Stat label="Срок продажи (медиана)" value={m.timeToSale.medianDays === null ? '—' : `${m.timeToSale.medianDays.toFixed(1)} дн.`} sub={m.timeToSale.enough ? `${m.timeToSale.events} продаж, ${m.timeToSale.censored} в остатке` : 'мало своих продаж'} />
        <Stat label="Загрузка капитала" value={pct(m.capitalUtilization)} sub="доля денег в товаре" />
        <Stat label="Возвраты / споры" value={`${m.refundRatePct === null ? '—' : fmtPct(m.refundRatePct)} / ${m.disputeRatePct === null ? '—' : fmtPct(m.disputeRatePct)}`} />
      </div>
      {m.precision.purchased === 0 && (
        <Warning>
          <p>
            Пока нет покупок по рекомендациям — метрики качества пустые. Покупайте через кнопку «купил» в сканере: так партия связывается с рекомендацией, и после продажи появятся precision и ошибка прогноза. До этого
            ориентируйтесь на paper trading и бэктест.
          </p>
        </Warning>
      )}
      <Card title="Paper trading по стратегиям">
        <StrategyTable stats={m.paper} paper />
      </Card>
      {m.backtest && (
        <Card title={`Последний бэктест · ${fmtDateTime(m.backtest.ts)} · горизонт ${m.backtest.params.horizonDays} дн.`}>
          <StrategyTable stats={m.backtest.strategies} />
        </Card>
      )}
    </div>
  );
}

function StrategyTable({ stats, paper = false }: { stats: Record<string, StrategyStats>; paper?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Стратегия</th>
            <th className="text-right">{paper ? 'Закрыто / открыто' : 'Сделок'}</th>
            <th className="text-right">Чистыми</th>
            <th className="text-right">ROI</th>
            <th className="text-right">Win rate</th>
            <th className="text-right">Ложные</th>
            {!paper && <th className="text-right">Просадка</th>}
            {!paper && <th className="text-right">Загрузка капитала</th>}
            <th className="text-right">Ошибка прогноза</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(stats).map(([k, s]) => {
            const net = paper ? s.totalNet : s.netProfit;
            return (
              <tr key={k}>
                <td>{STRAT[k] ?? k}</td>
                <td className="num text-right">{paper ? `${s.closed} / ${s.open}` : s.trades}</td>
                <td className={`num text-right ${(net ?? 0) >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(net ?? 0)}</td>
                <td className="num text-right">{s.roiPct === null ? '—' : fmtPct(s.roiPct)}</td>
                <td className="num text-right">{pct(s.winRate)}</td>
                <td className="num text-right">{pct(s.falsePositiveRate)}</td>
                {!paper && <td className="num text-right">{fmtRub(s.maxDrawdown ?? 0)}</td>}
                {!paper && <td className="num text-right">{pct(s.capitalUtilization)}</td>}
                <td className="num text-right">{s.forecastMae === null ? '—' : fmtRub(s.forecastMae)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Risk() {
  const [mode, setMode] = useState<Mode>('real');
  const { data: r, error, load } = useLoad(() => api.risk(mode), [mode]);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <Warning tone="bad">{error}</Warning>;
  if (!r) return null;
  const c = r.capital;
  const share = (v: number) => (c.total > 0 ? `${((v / c.total) * 100).toFixed(0)}%` : '—');
  const top = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  return (
    <div className="space-y-4">
      <div className="flex w-fit rounded-lg border border-line bg-surface p-0.5 text-sm">
        {(['real', 'sim'] as const).map((m) => (
          <button key={m} className={`rounded-md px-3 py-1 ${mode === m ? 'bg-accent text-white' : 'text-muted'}`} onClick={() => setMode(m)}>
            {m === 'real' ? 'Реальные деньги' : 'Симуляция'}
          </button>
        ))}
      </div>
      {!c.tracking && <Warning>Касса не ведётся — капитал неизвестен, поэтому лимиты долей не проверяются. Задайте стартовый капитал в «Настройки → Склад и капитал».</Warning>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Капитал" value={fmtRub(c.total)} />
        <Stat label="Свободные деньги" value={c.freeCash === null ? '—' : fmtRub(c.freeCash)} sub={`резерв ${fmtRub(c.reserved)}`} />
        <Stat label="В товаре" value={fmtRub(c.inventory)} sub={share(c.inventory)} />
        <Stat label="В пути" value={fmtRub(c.inTransit)} />
        <Stat label={`Заморожено > ${r.aging.staleDays} дн.`} value={fmtRub(r.aging.frozen)} tone={r.aging.frozen > 0 ? 'warn' : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {(
          [
            ['По товарам', c.byItem, r.limits.maxItemSharePct],
            ['По источникам', c.bySource, r.limits.maxSourceSharePct],
            ['По категориям', c.byCategory, r.limits.maxCategorySharePct],
          ] as const
        ).map(([title, data, limit]) => (
          <Card key={title} title={`${title} · лимит ${limit}%`}>
            {top(data).length === 0 ? (
              <Empty>Нет вложений.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {top(data).map(([k, v]) => {
                  const s = c.total > 0 ? (v / c.total) * 100 : 0;
                  return (
                    <li key={k} className="flex justify-between gap-2">
                      <span className="truncate">{k || '—'}</span>
                      <span className={`num ${s > limit ? 'text-bad' : s > limit * 0.8 ? 'text-warn' : ''}`}>
                        {fmtRub(v)} · {share(v)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Старение запасов">
          <div className="overflow-x-auto">
          <table className="table">
            <tbody>
              {r.aging.buckets.map((b) => (
                <tr key={b.key}>
                  <td>{b.key} дн.</td>
                  <td className="num text-right">{b.qty} шт</td>
                  <td className="num text-right">{fmtRub(b.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {r.aging.items.filter((i) => i.stale).length > 0 && (
            <p className="mt-2 text-xs text-warn">
              Залежалось: {r.aging.items.filter((i) => i.stale).map((i) => `${i.item} (${i.ageDays.toFixed(0)} дн.)`).join(', ')}
            </p>
          )}
        </Card>
        <Card title="Прогноз денежного потока">
          <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Горизонт</th>
                <th className="text-right">Поступления</th>
                <th className="text-right">Резервы</th>
                <th className="text-right">Итого</th>
              </tr>
            </thead>
            <tbody>
              {r.cashFlow.map((f) => (
                <tr key={f.days}>
                  <td>{f.days} дн.</td>
                  <td className="num text-right">{fmtRub(f.inflow)}</td>
                  <td className="num text-right">{fmtRub(-f.outflow)}</td>
                  <td className={`num text-right ${f.net >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(f.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="mt-2 text-xs text-muted">Поступления = остатки × ожидаемая выплата × вероятность продажи к сроку (по вашим продажам; без них — допущение из параметров).</p>
        </Card>
      </div>
      <Card title="Резерв денег под плановые закупки">
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="Сумма" suffix="₽" value={amount} onChange={setAmount} />
          <label className="block sm:col-span-2">
            <span className="label">На что</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="партия ключей на выходные" />
          </label>
        </div>
        {msg && <p className="mt-2 text-sm text-bad">{msg}</p>}
        <div className="mt-3 flex justify-end">
          <button
            className="btn-primary"
            disabled={amount <= 0}
            onClick={async () => {
              setMsg(null);
              try {
                await api.reserveCash({ amount, note, mode });
                setAmount(0);
                setNote('');
                load();
              } catch (e) {
                setMsg((e as Error).message);
              }
            }}
          >
            Зарезервировать
          </button>
        </div>
        {r.reservations.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {r.reservations.map((x) => (
              <li key={x.id} className="flex items-center gap-3">
                <span className="num">{fmtRub(x.amount_rub)}</span>
                <span className="text-muted">{x.note}</span>
                <button className="ml-auto text-xs text-accent hover:underline" onClick={() => api.releaseCash(x.id).then(load)}>
                  снять
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Demand() {
  const [item, setItem] = useState('');
  const [query, setQuery] = useState('');
  const { data: d, error } = useLoad(() => api.demand(query ? `item=${encodeURIComponent(query)}` : ''), [query]);
  const W = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-sm" placeholder="Товар (пусто — все продажи)" value={item} onChange={(e) => setItem(e.target.value)} />
          <button className="btn-primary" onClick={() => setQuery(item.trim())}>
            Показать
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Основа — ваши продажи: каждая проданная единица — событие, непроданные остатки учитываются как «ещё не продано» (метод Каплана–Мейера), поэтому залежалый товар не завышает скорость. Исчезновения лотов
          конкурентов сюда не входят: это не продажи.
        </p>
      </Card>
      {error && <Warning tone="bad">{error}</Warning>}
      {d && (
        <>
          <Card title="Вероятность продажи">
            {d.sell.enough && d.sell.probs ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {Object.entries(d.sell.probs).map(([h, p]) => (
                  <Stat key={h} label={`за ${h} дн.`} value={pct(p.p)} sub={`95%: ${pct(p.lo)}–${pct(p.hi)}`} />
                ))}
              </div>
            ) : (
              <Empty>{d.sell.note}</Empty>
            )}
            <p className="mt-2 text-xs text-muted">
              Продано единиц: {d.sell.events}, в остатке: {d.sell.censored}. Медиана срока: {d.sell.medianDays === null ? '—' : `${d.sell.medianDays.toFixed(1)} дн.`}
            </p>
          </Card>
          <Card title="Ценовые диапазоны (ваши продажи относительно минимума FunPay)">
            <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Диапазон</th>
                  <th className="text-right">Продаж</th>
                  <th className="text-right">Срок (медиана)</th>
                  <th className="text-right">Чистыми / шт</th>
                  <th className="text-right">В день</th>
                </tr>
              </thead>
              <tbody>
                {d.bands.bands.map((b) => (
                  <tr key={b.key}>
                    <td>
                      {b.label} {d.bands.best?.label === b.label && <Badge tone="good">лучший</Badge>}
                    </td>
                    <td className="num text-right">{b.n}</td>
                    <td className="num text-right">{b.medianDays === null ? '—' : `${b.medianDays.toFixed(1)} дн.`}</td>
                    <td className="num text-right">{b.avgNetPerUnit === null ? '—' : fmtRub(b.avgNetPerUnit)}</td>
                    <td className="num text-right">{b.netPerDay === null ? '—' : fmtRub(b.netPerDay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {d.bands.note && <p className="mt-2 text-xs text-muted">{d.bands.note}</p>}
          </Card>
          <Card title="Продажи по дням недели">
            <div className="grid grid-cols-7 gap-2 text-center text-sm">
              {d.weekdays.map((v, i) => (
                <div key={i} className="rounded-lg border border-line p-2">
                  <div className="text-xs text-muted">{W[i]}</div>
                  <div className="num">{v}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Paper() {
  const { data: p, error } = useLoad(() => api.paper());
  if (error) return <Warning tone="bad">{error}</Warning>;
  if (!p) return null;
  return (
    <div className="space-y-4">
      <Card title="Как это работает">
        <p className="text-sm text-muted">
          По каждому кандидату и исполнимой связке открываются «бумажные» позиции по трём стратегиям цены. Через горизонт (параметр «Paper trading») позиция закрывается по рыночной переоценке — минимальной цене FunPay
          минус подрезка в тот момент. Это проверка сигналов без риска капиталом, а не факт продажи.
        </p>
      </Card>
      <Card title="Итоги по стратегиям">
        <StrategyTable stats={p.byStrategy} paper />
      </Card>
      <Card title="Последние позиции">
        {p.recent.length === 0 ? (
          <Empty>Позиций пока нет — они появятся после сканов, когда будут кандидаты.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Открыта</th>
                  <th>Товар</th>
                  <th>Стратегия</th>
                  <th className="text-right">План</th>
                  <th className="text-right">Прогноз</th>
                  <th className="text-right">Выход</th>
                  <th className="text-right">Итог</th>
                </tr>
              </thead>
              <tbody>
                {p.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="num whitespace-nowrap text-xs text-muted">{fmtDateTime(r.opened_at)}</td>
                    <td>{r.item}</td>
                    <td className="text-xs">{STRAT[r.strategy]}</td>
                    <td className="num text-right">{fmtRub(r.planned_price)}</td>
                    <td className="num text-right">{fmtRub(r.forecast_net)}</td>
                    <td className="num text-right">{r.exit_price === null ? (r.status === 'open' ? 'открыта' : 'нет данных') : fmtRub(r.exit_price)}</td>
                    <td className={`num text-right ${(r.exit_net ?? 0) >= 0 ? 'text-good' : 'text-bad'}`}>{r.exit_net === null ? '—' : fmtRub(r.exit_net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

type BtResult = Awaited<ReturnType<typeof api.backtest>>;
type Group = Record<string, { trades: number; net: number; invested: number; roiPct: number | null; winRate: number | null }>;

const BREAKDOWN: { key: 'byItem' | 'bySource' | 'byCategory' | 'byRegime'; label: string }[] = [
  { key: 'byItem', label: 'Товар' },
  { key: 'bySource', label: 'Источник' },
  { key: 'byCategory', label: 'Категория' },
  { key: 'byRegime', label: 'Режим рынка' },
];

function GroupTable({ g }: { g: Group }) {
  const rows = Object.entries(g).sort((a, b) => b[1].net - a[1].net);
  if (!rows.length) return <Empty>Нет сделок.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Группа</th>
            <th className="text-right">Сделок</th>
            <th className="text-right">Чистыми</th>
            <th className="text-right">ROI</th>
            <th className="text-right">Win rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num text-right">{v.trades}</td>
              <td className={`num text-right ${v.net >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(v.net)}</td>
              <td className="num text-right">{v.roiPct === null ? '—' : `${v.roiPct.toFixed(1)}%`}</td>
              <td className="num text-right">{pct(v.winRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Backtest() {
  const [f, setF] = useState<BacktestParams>({
    horizonDays: 7,
    minNet: 50,
    minRoiPct: 5,
    sinceDays: 90,
    mode: 'historical',
    simulation: 'realistic',
    budgetRub: 0,
    maxConcurrent: 0,
    deliveryDelayH: 1,
    refundPct: 0,
  });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<BtResult | null>(null);
  const [strat, setStrat] = useState<'fast' | 'balanced' | 'max'>('fast');
  const [dim, setDim] = useState<(typeof BREAKDOWN)[number]['key']>('bySource');
  const [replay, setReplay] = useState<{ id: number; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: runs, load } = useLoad(() => api.backtestRuns());
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.backtest(f));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const doReplay = async (id: number) => {
    setError(null);
    try {
      const r = await api.backtestReplay(id);
      setReplay({ id, ok: r.reproducible });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <Card title="Параметры">
        <div className="grid gap-3 sm:grid-cols-4">
          <NumberField label="Горизонт" suffix="дн." value={f.horizonDays} onChange={(v) => setF({ ...f, horizonDays: Math.max(1, v) })} />
          <NumberField label="Вход от (чистыми)" suffix="₽" value={f.minNet} onChange={(v) => setF({ ...f, minNet: v })} />
          <NumberField label="Вход от ROI" suffix="%" value={f.minRoiPct} onChange={(v) => setF({ ...f, minRoiPct: v })} />
          <NumberField label="Глубина истории" suffix="дн." value={f.sinceDays} onChange={(v) => setF({ ...f, sinceDays: Math.max(1, v) })} />
          <NumberField label="Бюджет (0 — без лимита)" suffix="₽" value={f.budgetRub} onChange={(v) => setF({ ...f, budgetRub: Math.max(0, v) })} />
          <NumberField label="Позиций одновременно (0 — без лимита)" value={f.maxConcurrent} onChange={(v) => setF({ ...f, maxConcurrent: Math.max(0, Math.round(v)) })} />
          <NumberField label="Задержка поставки" suffix="ч" value={f.deliveryDelayH} onChange={(v) => setF({ ...f, deliveryDelayH: Math.max(0, v) })} />
          <NumberField label="Возвраты сверх параметров" suffix="%" value={f.refundPct} onChange={(v) => setF({ ...f, refundPct: Math.max(0, v) })} />
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            Параметры:
            <select className="input w-auto min-w-0 max-w-full" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as BacktestParams['mode'] })}>
              <option value="historical">исторические (как было на момент решения)</option>
              <option value="current">текущие (что было бы с сегодняшними)</option>
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            Симуляция:
            <select className="input w-auto min-w-0 max-w-full" value={f.simulation} onChange={(e) => setF({ ...f, simulation: e.target.value as BacktestParams['simulation'] })}>
              <option value="realistic">реалистичная</option>
              <option value="proxy">прокси (выход по рынку через горизонт)</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">
          В момент t решение принимается только по снимкам до t, по комиссии и параметрам, известным тогда. «Реалистичная» симуляция учитывает задержку поставки, вероятность продажи (только пока ваша цена не выше рынка),
          бюджет, число позиций и возвраты; непроданное в конце горизонта уходит по рынку. Результат — ожидаемое значение модели, а не факт продаж. Каждый прогон сохраняет отпечаток входных данных и воспроизводится.
        </p>
        {error && <p className="mt-2 text-sm text-bad">{error}</p>}
        <div className="mt-3 flex justify-end">
          <button className="btn-primary" disabled={busy} onClick={run}>
            {busy ? 'Считаю…' : 'Запустить бэктест'}
          </button>
        </div>
      </Card>
      {res && (
        <Card title={`Результат · движок ${res.engineVersion} · ${res.params.mode === 'historical' ? 'исторические параметры' : `параметры ${res.settingsHash}`} · данные ${res.inputFingerprint}`}>
          {Object.values(res.strategies).every((s) => !s.trades) ? (
            <Empty>Сделок не найдено: мало истории снимков или пороги входа слишком высокие. История копится с каждым сканом.</Empty>
          ) : (
            <>
              <StrategyTable stats={res.strategies} />
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Разбивка:</span>
                <select className="input w-auto" value={strat} onChange={(e) => setStrat(e.target.value as typeof strat)}>
                  {(['fast', 'balanced', 'max'] as const).map((s) => (
                    <option key={s} value={s}>
                      {STRAT[s]}
                    </option>
                  ))}
                </select>
                {BREAKDOWN.map((b) => (
                  <button key={b.key} className={dim === b.key ? 'btn-primary' : 'btn-ghost'} onClick={() => setDim(b.key)}>
                    {b.label}
                  </button>
                ))}
              </div>
              <div className="mt-2">
                <GroupTable g={res.breakdown[strat][dim]} />
              </div>
            </>
          )}
          <p className="mt-2 text-xs text-muted">
            Пропущено: без данных для выхода {res.skippedNoExit} · устаревшая котировка {res.skippedStale} · нет в наличии {res.skippedOutOfStock} · не хватило бюджета {res.skippedBudget[strat] ?? 0} · лимит позиций{' '}
            {res.skippedConcurrency[strat] ?? 0}
          </p>
        </Card>
      )}
      {runs && runs.length > 0 && (
        <Card title="Прошлые прогоны">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Версия / данные</th>
                  <th>Параметры</th>
                  <th className="text-right">Быстрый</th>
                  <th className="text-right">Сбаланс.</th>
                  <th className="text-right">Макс.</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="num whitespace-nowrap text-xs text-muted">{fmtDateTime(r.ts)}</td>
                    <td className="num text-xs">
                      {r.engine_version} / {r.input_fingerprint ?? r.settings_hash}
                    </td>
                    <td className="text-xs text-muted">
                      {r.params.horizonDays} дн., от {r.params.minNet} ₽, ROI {r.params.minRoiPct}% · {!r.params.mode ? 'до 2.2: текущие, прокси' : `${r.params.mode === 'current' ? 'текущие' : 'исторические'} · ${r.params.simulation === 'proxy' ? 'прокси' : 'реалист.'}`}
                    </td>
                    {['fast', 'balanced', 'max'].map((k) => (
                      <td key={k} className="num text-right">
                        {fmtRub(r.result.strategies[k]?.netProfit ?? 0)} <span className="text-xs text-muted">({r.result.strategies[k]?.trades ?? 0})</span>
                      </td>
                    ))}
                    <td className="whitespace-nowrap text-right">
                      {r.input_fingerprint && (
                        <button className="btn-ghost text-xs" onClick={() => doReplay(r.id)} title="Повторить прогон на тех же данных и проверить, что результат совпал">
                          {replay?.id === r.id ? (replay.ok ? '✓ совпало' : '✕ отличается') : 'повторить'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

const TIER: Record<PolicyTier, { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  trusted: { label: 'надёжный', tone: 'good' },
  normal: { label: 'обычный', tone: 'muted' },
  probation: { label: 'испытательный', tone: 'warn' },
  blocked: { label: 'заблокирован', tone: 'bad' },
};

/** доля с 95% интервалом Уилсона */
function Ci({ w }: { w: WilsonBound }) {
  if (!w.n) return <span className="text-muted">—</span>;
  return (
    <span title={`${w.k} из ${w.n}; 95% интервал Уилсона`}>
      {pct(w.p)}{' '}
      <span className="text-xs text-muted">
        ({pct(w.lo)}–{pct(w.hi)}, n={w.n})
      </span>
    </span>
  );
}

function SourcesQuality() {
  const { data: q, error } = useLoad(() => api.qualitySources());
  const [onlyActive, setOnlyActive] = useState(true);
  if (error) return <Warning tone="bad">{error}</Warning>;
  if (!q) return null;
  const all = Object.values(q).sort((a, b) => ['blocked', 'probation', 'normal', 'trusted'].indexOf(a.policy.tier) - ['blocked', 'probation', 'normal', 'trusted'].indexOf(b.policy.tier) || b.data.checked - a.data.checked);
  const rows = onlyActive ? all.filter((s) => s.data.checked > 0 || s.policy.bounds.stock.n > 0 || s.policy.bounds.price.n > 0) : all;
  const count = (t: PolicyTier) => all.filter((s) => s.policy.tier === t).length;
  return (
    <div className="space-y-4">
      <Card title="Политики качества">
        <p className="text-sm text-muted">
          Уровень доверия считается по <b>границам 95% интервала Уилсона</b>, а не по средней: 3 удачные закупки из 3 ещё не доказывают надёжность. Испытательный срок и «обычный» уровень сужают лимиты доли капитала и
          суммы сделки и требуют запас маржи; «заблокирован» — связки не рекомендуются. Если по категории товара данных достаточно, решение принимается отдельно по категории. Пороги — в «Параметрах».
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {(['trusted', 'normal', 'probation', 'blocked'] as const).map((t) => (
            <Badge key={t} tone={TIER[t].tone}>
              {TIER[t].label}: {count(t)}
            </Badge>
          ))}
        </div>
      </Card>
      <Card title="Источники">
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          только источники с данными
        </label>
        {rows.length === 0 ? (
          <Empty>Данных ещё нет: они копятся при сканах и по вашим кнопкам «купил» / «не вышло».</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Источник</th>
                  <th>Уровень</th>
                  <th className="text-right">Данные без проблем</th>
                  <th className="text-right">Цена в допуске</th>
                  <th className="text-right">Было в наличии</th>
                  <th className="text-right">Возвраты/споры</th>
                  <th className="text-right">Лимиты / буфер</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.sourceId}>
                    <td>{s.sourceId}</td>
                    <td title={s.policy.reasons.join('\n')}>
                      <Badge tone={TIER[s.policy.tier].tone}>{TIER[s.policy.tier].label}</Badge>
                      {s.policy.reasons[0] && <div className="mt-1 max-w-xs text-xs text-muted">{s.policy.reasons[0]}</div>}
                    </td>
                    <td className="num text-right">
                      {pct(s.data.okShare)} <span className="text-xs text-muted">({s.data.checked})</span>
                    </td>
                    <td className="num text-right">
                      <Ci w={s.policy.bounds.price} />
                    </td>
                    <td className="num text-right">
                      <Ci w={s.policy.bounds.stock} />
                    </td>
                    <td className="num text-right">
                      <Ci w={s.policy.bounds.problems} />
                    </td>
                    <td className="num text-right text-xs">
                      {s.policy.tier === 'blocked' ? '—' : `×${s.policy.limitFactor} / +${s.policy.marginBufferPct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
