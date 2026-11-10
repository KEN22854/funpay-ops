import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Card, Empty, NumberField } from '../../components/ui';
import type { Category, Opportunity, OppStatus } from '../../lib/api';
import { fmtDateTime, fmtPct, fmtRub } from '../../lib/format';
import { useStore } from '../../store/useStore';
import { ageText, CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE, type ScannerState } from './useScanner';

type Sort = 'score' | 'net' | 'pct' | 'roi' | 'fresh';
const COMP_LABEL: Record<string, string> = {
  match: 'совпадение',
  margin: 'маржа',
  liquidity: 'ликвидность',
  reliability: 'надёжность источника',
  competition: 'конкуренция',
  freshness: 'свежесть',
  risk: 'риск',
  availability: 'наличие',
};

export function Opportunities({ sc, onBuy }: { sc: ScannerState; onBuy: (o: Opportunity) => void }) {
  const setCalcDraft = useStore((s) => s.setCalcDraft);
  const navigate = useNavigate();
  const [status, setStatus] = useState<OppStatus | 'all'>('RECOMMENDED');
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [src, setSrc] = useState('all');
  const [q, setQ] = useState('');
  const [minNet, setMinNet] = useState(0);
  const [minRoi, setMinRoi] = useState(0);
  const [bestOnly, setBestOnly] = useState(true);
  const [sort, setSort] = useState<Sort>('score');
  const [open, setOpen] = useState<string | null>(null);

  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);
  const counts = useMemo(() => {
    const c = { RECOMMENDED: 0, REVIEW: 0, BLOCKED: 0 } as Record<OppStatus, number>;
    for (const o of sc.opps) c[o.eval.status]++;
    return c;
  }, [sc.opps]);

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let list = sc.opps.filter(
      (o) =>
        (status === 'all' || o.eval.status === status) &&
        (cat === 'all' || o.category === cat) &&
        (src === 'all' || o.buy.sourceId === src) &&
        (!qq || o.name.toLowerCase().includes(qq)) &&
        (o.eval.forecast?.net ?? -Infinity) >= minNet &&
        (minRoi <= 0 || (o.eval.forecast?.roiPct ?? -Infinity) >= minRoi),
    );
    if (bestOnly) {
      const m = new Map<string, Opportunity>();
      const rank = { RECOMMENDED: 2, REVIEW: 1, BLOCKED: 0 };
      for (const o of list) {
        const k = o.kind === 'watch' ? `w|${o.watchId}` : `d|${o.game}|${o.name}`;
        const p = m.get(k);
        if (!p || rank[o.eval.status] > rank[p.eval.status] || (rank[o.eval.status] === rank[p.eval.status] && (o.eval.forecast?.net ?? -1e9) > (p.eval.forecast?.net ?? -1e9))) m.set(k, o);
      }
      list = [...m.values()];
    }
    const key = (o: Opportunity) =>
      sort === 'score' ? o.eval.score : sort === 'net' ? (o.eval.forecast?.net ?? -1e9) : sort === 'pct' ? (o.eval.forecast?.netPct ?? -1e9) : sort === 'roi' ? (o.eval.forecast?.roiPct ?? -1e9) : -o.eval.ages.sourceMin;
    return list.sort((a, b) => key(b) - key(a));
  }, [sc.opps, status, cat, src, q, minNet, minRoi, bestOnly, sort]);

  const usedSources = useMemo(() => [...new Set(sc.opps.map((o) => o.buy.sourceId))].sort(), [sc.opps]);

  const toCalc = (o: Opportunity) => {
    const f = o.eval.forecast;
    const s = sc.settings;
    if (!f || !s) return;
    setCalcDraft({
      price: f.price,
      cost: Math.round(f.invested * 100) / 100,
      platformFeePct: o.saleFee.pct,
      withdrawFeePct: s.costModel.withdrawPct,
      disputeMode: 'percent',
      disputeValue: s.costModel.disputePct,
      minutesPerOrder: s.costModel.minutesPerOrder,
      hourlyRate: s.costModel.hourlyRate,
    });
    navigate('/calculator');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {(['RECOMMENDED', 'REVIEW', 'BLOCKED', 'all'] as const).map((s) => (
          <button key={s} className={`rounded-md px-3 py-1.5 ${status === s ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`} onClick={() => setStatus(s)}>
            {s === 'all' ? 'Все' : STATUS_LABEL[s]} <span className="num opacity-70">{s === 'all' ? sc.opps.length : counts[s]}</span>
          </button>
        ))}
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="label">Категория</span>
            <select className="input" value={cat} onChange={(e) => setCat(e.target.value as Category | 'all')}>
              <option value="all">Все</option>
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Где покупать</span>
            <select className="input" value={src} onChange={(e) => setSrc(e.target.value)}>
              <option value="all">Все источники</option>
              {usedSources.map((s) => (
                <option key={s} value={s}>
                  {srcName[s] ?? s}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Чистыми от" suffix="₽" value={minNet} onChange={setMinNet} />
          <NumberField label="ROI от" suffix="%" value={minRoi} onChange={setMinRoi} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <input className="input max-w-xs" placeholder="Поиск по товару" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={bestOnly} onChange={(e) => setBestOnly(e.target.checked)} />
            Лучшая закупка по товару
          </label>
          <label className="flex items-center gap-2 text-muted">
            Сортировка
            <select className="input w-auto py-1" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="score">балл</option>
              <option value="net">чистая прибыль</option>
              <option value="pct">маржа %</option>
              <option value="roi">ROI</option>
              <option value="fresh">свежесть</option>
            </select>
          </label>
          <span className="ml-auto text-xs text-muted">расчёт: {sc.oppsAt ? fmtDateTime(sc.oppsAt) : '—'}</span>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Empty>
          {sc.opps.length === 0
            ? 'Пока нет данных. Добавьте товары во вкладке «Отслеживание» и просканируйте их или запустите «Автопоиск скинов».'
            : status === 'RECOMMENDED'
              ? 'Нет связок, прошедших все проверки. Посмотрите «Проверить» — там связки, которым не хватает подтверждения.'
              : 'Под фильтры ничего не подходит.'}
        </Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>Купить</th>
                <th className="text-right">Закупка</th>
                <th className="text-right">Продать</th>
                <th className="text-right">Чистыми</th>
                <th className="text-right">Балл</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((o) => {
                const f = o.eval.forecast;
                const isOpen = open === o.id;
                const tone = (f?.net ?? 0) > 0 ? 'text-good' : 'text-bad';
                const reasons = o.eval.status === 'BLOCKED' ? o.eval.blocks : o.eval.status === 'REVIEW' ? o.eval.reviews : [];
                return (
                  <Fragment key={o.id}>
                    <tr className={isOpen ? 'bg-raised/40' : ''}>
                      <td className="min-w-[200px]">
                        <button className="text-left font-medium hover:underline" onClick={() => setOpen(isOpen ? null : o.id)}>
                          {o.name}
                        </button>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge tone={STATUS_TONE[o.eval.status]}>{STATUS_LABEL[o.eval.status]}</Badge>
                          <Badge tone="muted">{CATEGORY_LABEL[o.category]}</Badge>
                          {o.kind === 'discovery' && <Badge tone="accent">автопоиск</Badge>}
                        </div>
                        {reasons.length > 0 && <p className={`mt-1 max-w-sm text-xs ${o.eval.status === 'BLOCKED' ? 'text-bad' : 'text-warn'}`}>{reasons[0]}{reasons.length > 1 && ` (+${reasons.length - 1})`}</p>}
                      </td>
                      <td className="min-w-[170px]">
                        <a href={o.buy.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                          {srcName[o.buy.sourceId] ?? o.buy.sourceId} ↗
                        </a>
                        {o.buy.manual && <span className="ml-1 text-xs text-muted">(вручную)</span>}
                        <div className="max-w-[240px] truncate text-xs text-muted" title={o.buy.title}>
                          {o.buy.title}
                        </div>
                        <div className="text-xs text-muted">{ageText(o.eval.ages.sourceMin)}</div>
                      </td>
                      <td className="num text-right">
                        {fmtRub(f?.invested ?? o.buy.priceRub)}
                        {o.buy.currency !== 'RUB' && <div className="text-xs text-muted">{o.buy.price} {o.buy.currency}</div>}
                      </td>
                      <td className="num text-right">
                        <a href={o.market.url} target="_blank" rel="noreferrer" className="hover:underline">
                          {f ? fmtRub(f.price) : '—'}
                        </a>
                        <div className="text-xs text-muted">
                          мин. {o.market.min === null ? '—' : fmtRub(o.market.min)} · {o.market.count} лот.
                        </div>
                      </td>
                      <td className={`num text-right font-semibold ${tone}`}>
                        {f ? fmtRub(f.net) : '—'}
                        {f && <div className="text-xs font-normal">{fmtPct(f.netPct)} · ROI {f.roiPct === null ? '—' : fmtPct(f.roiPct)}</div>}
                      </td>
                      <td className="num text-right">{o.eval.score.toFixed(0)}</td>
                      <td className="whitespace-nowrap text-right text-xs">
                        <button className="text-accent hover:underline" onClick={() => setOpen(isOpen ? null : o.id)}>
                          {isOpen ? 'скрыть' : 'разбор'}
                        </button>
                        {o.eval.status === 'RECOMMENDED' && (
                          <button className="ml-3 text-accent hover:underline" onClick={() => onBuy(o)}>
                            купил
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} className="bg-raised/30">
                          <Detail o={o} toCalc={() => toCalc(o)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Detail({ o, toCalc }: { o: Opportunity; toCalc: () => void }) {
  const e = o.eval;
  const List = ({ title, items, cls }: { title: string; items: string[]; cls: string }) =>
    items.length ? (
      <div>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</h4>
        <ul className={`space-y-0.5 text-xs ${cls}`}>
          {items.map((x) => (
            <li key={x}>· {x}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="grid gap-5 p-2 lg:grid-cols-3">
      <div className="space-y-3">
        <List title="Блокирует" items={e.blocks} cls="text-bad" />
        <List title="Требует проверки" items={e.reviews} cls="text-warn" />
        <List title="Предупреждения" items={e.warnings} cls="text-warn/90" />
        <List title="Допущения" items={e.assumptions} cls="text-muted" />
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Совпадение товара ({o.buy.match.source === 'manual' ? 'вручную' : 'правила'})</h4>
          <ul className="space-y-0.5 text-xs">
            {o.buy.match.reasons.map((r) => (
              <li key={r.text} className={r.ok === true ? 'text-good' : r.ok === false ? 'text-bad' : 'text-warn'}>
                {r.ok === true ? '✓' : r.ok === false ? '✕' : '?'} {r.text}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Прогноз на 1 шт (цена «{e.prices.scenarios.find((s) => s.key === e.prices.decision)?.label ?? '—'}»)</h4>
        {e.forecast ? (
          <table className="table">
            <tbody>
              {e.forecast.lines
                .filter((l) => Math.abs(l.amount) >= 0.005 || l.key === 'revenue')
                .map((l) => (
                  <tr key={l.key}>
                    <td className="text-xs text-muted">{l.label}</td>
                    <td className="num text-right text-xs">{fmtRub(l.amount)}</td>
                  </tr>
                ))}
              <tr>
                <td className="text-xs font-semibold">= Чистая прибыль</td>
                <td className={`num text-right text-xs font-semibold ${e.forecast.net > 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(e.forecast.net)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted">Нет цены FunPay для расчёта.</p>
        )}
        <p className="mt-2 text-xs text-muted">
          Комиссия FunPay {o.saleFee.pct}% — {o.saleFee.source}. Срок продажи {e.daysToSell} дн.
        </p>
      </div>
      <div className="space-y-3">
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Цена продажи</h4>
          <table className="table">
            <tbody>
              <tr>
                <td className="text-xs text-muted">Без убытка (минимум)</td>
                <td className="num text-right text-xs">{e.prices.breakEven === null ? 'недостижимо' : fmtRub(e.prices.breakEven)}</td>
              </tr>
              {e.prices.scenarios.map((s) => (
                <tr key={s.key}>
                  <td className="text-xs">
                    {s.label}
                    <div className="text-muted">{s.why}</div>
                  </td>
                  <td className="num text-right text-xs">
                    {fmtRub(s.price)}
                    <div className={s.forecast && s.forecast.net > 0 ? 'text-good' : 'text-bad'}>{s.forecast ? fmtRub(s.forecast.net) : ''}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">{e.prices.optimalNote}</p>
        </div>
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Балл {e.score.toFixed(0)} из 100</h4>
          <ul className="grid grid-cols-2 gap-x-3 text-xs">
            {Object.entries(e.components).map(([k, v]) => (
              <li key={k} className="flex justify-between">
                <span className="text-muted">{COMP_LABEL[k] ?? k}</span>
                <span className="num">{Math.round(v * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
        {o.liquidity?.observed && (
          <div className="text-xs text-muted">
            <h4 className="mb-1 font-medium uppercase tracking-wide">Ликвидность (сигнал, уверенность: {o.liquidity.confidence})</h4>
            лотов {o.liquidity.observed.activeLots}, продавцов {o.liquidity.observed.sellers}
            {o.liquidity.observed.disappearPerLotDay !== null && `, исчезает ${o.liquidity.observed.disappearPerLotDay.toFixed(2)} лота/сутки на лот`}
            , наблюдение {o.liquidity.observed.observationDays.toFixed(1)} дн. Своих продаж: {o.liquidity.fact.count}. <span className="italic">{o.liquidity.note}</span>
          </div>
        )}
        <button className="btn-ghost text-xs" onClick={toCalc}>
          → открыть в калькуляторе
        </button>
        <p className="text-xs text-muted">
          Данные: источник {ageText(e.ages.sourceMin)}, FunPay {ageText(e.ages.funpayMin)}.
        </p>
      </div>
    </div>
  );
}
