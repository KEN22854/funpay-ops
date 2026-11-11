import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Card, Empty, NumberField } from '../../components/ui';
import { api, type Category, type Opportunity, type OppStatus, type VerifyResult } from '../../lib/api';
import { fmtDateTime, fmtPct, fmtRub } from '../../lib/format';
import { useStore } from '../../store/useStore';
import { ageText, CATEGORY_LABEL, STATUS_HINT, STATUS_LABEL, STATUS_TONE, type ScannerState } from './useScanner';

type Sort = 'perDay' | 'score' | 'net' | 'roi' | 'fresh';
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
const RANK: Record<OppStatus, number> = { RECOMMENDED: 3, CANDIDATE: 2, REVIEW: 1, BLOCKED: 0 };
const ORDER: OppStatus[] = ['RECOMMENDED', 'CANDIDATE', 'REVIEW', 'BLOCKED'];

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
  const [sort, setSort] = useState<Sort>('perDay');
  const [open, setOpen] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<Opportunity | null>(null);
  const [failing, setFailing] = useState<Opportunity | null>(null);

  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);
  const counts = useMemo(() => {
    const c: Record<OppStatus, number> = { RECOMMENDED: 0, CANDIDATE: 0, REVIEW: 0, BLOCKED: 0 };
    for (const o of sc.opps) c[o.eval.status]++;
    return c;
  }, [sc.opps]);

  // при первом появлении данных — открыть первую непустую вкладку из «исполнимо → кандидаты»
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || !sc.opps.length) return;
    picked.current = true;
    if (!counts.RECOMMENDED && counts.CANDIDATE) setStatus('CANDIDATE');
  }, [sc.opps, counts]);

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
      for (const o of list) {
        const k = o.kind === 'watch' ? `w|${o.watchId}` : `d|${o.game}|${o.name}`;
        const p = m.get(k);
        if (!p || RANK[o.eval.status] > RANK[p.eval.status] || (RANK[o.eval.status] === RANK[p.eval.status] && (o.eval.netPerDay ?? -1e9) > (p.eval.netPerDay ?? -1e9))) m.set(k, o);
      }
      list = [...m.values()];
    }
    const key = (o: Opportunity) =>
      sort === 'perDay' ? (o.eval.netPerDay ?? -1e9) : sort === 'score' ? o.eval.score : sort === 'net' ? (o.eval.forecast?.net ?? -1e9) : sort === 'roi' ? (o.eval.forecast?.roiPct ?? -1e9) : -o.eval.ages.sourceMin;
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
      disputeValue: o.eval.model?.disputePct ?? s.costModel.disputePct,
      minutesPerOrder: s.costModel.minutesPerOrder,
      hourlyRate: s.costModel.hourlyRate,
    });
    navigate('/calculator');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {[...ORDER, 'all' as const].map((s) => (
          <button
            key={s}
            title={s === 'all' ? '' : STATUS_HINT[s]}
            className={`rounded-md px-3 py-1.5 ${status === s ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`}
            onClick={() => setStatus(s)}
          >
            {s === 'all' ? 'Все' : STATUS_LABEL[s]} <span className="num opacity-70">{s === 'all' ? sc.opps.length : counts[s]}</span>
          </button>
        ))}
      </div>
      {status !== 'all' && <p className="text-xs text-muted">{STATUS_HINT[status]}</p>}

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
              <option value="perDay">прибыль в день оборота</option>
              <option value="score">балл</option>
              <option value="net">чистая прибыль</option>
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
            ? 'Пока нет данных. Добавьте товары в «Каталог» и просканируйте их или запустите «Автопоиск скинов».'
            : status === 'RECOMMENDED'
              ? 'Исполнимых связок нет. Посмотрите «Кандидат» — их нужно перепроверить перед покупкой («Проверить сейчас»).'
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
                const reasons = o.eval.status === 'BLOCKED' ? o.eval.blocks : o.eval.status === 'REVIEW' ? o.eval.reviews : o.eval.status === 'CANDIDATE' ? o.eval.executionGaps : [];
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
                          {o.verifiedByTransaction && <Badge tone="good">подтверждено сделкой</Badge>}
                        </div>
                        {reasons.length > 0 && (
                          <p className={`mt-1 max-w-sm text-xs ${o.eval.status === 'BLOCKED' ? 'text-bad' : o.eval.status === 'REVIEW' ? 'text-warn' : 'text-muted'}`}>
                            {reasons[0]}
                            {reasons.length > 1 && ` (+${reasons.length - 1})`}
                          </p>
                        )}
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
                        {o.buy.currency !== 'RUB' && (
                          <div className="text-xs text-muted">
                            {o.buy.price} {o.buy.currency}
                          </div>
                        )}
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
                        {f && (
                          <div className="text-xs font-normal">
                            {o.eval.netPerDay !== null && `≈${fmtRub(o.eval.netPerDay)}/день · `}ROI {f.roiPct === null ? '—' : fmtPct(f.roiPct)}
                          </div>
                        )}
                      </td>
                      <td className="num text-right">{o.eval.score.toFixed(0)}</td>
                      <td className="whitespace-nowrap text-right text-xs">
                        <button className="text-accent hover:underline" onClick={() => setOpen(isOpen ? null : o.id)}>
                          {isOpen ? 'скрыть' : 'разбор'}
                        </button>
                        {o.eval.status === 'CANDIDATE' && (
                          <button className="ml-3 font-medium text-accent hover:underline" onClick={() => setVerifying(o)}>
                            проверить сейчас
                          </button>
                        )}
                        {o.eval.status === 'RECOMMENDED' && (
                          <button className="ml-3 font-medium text-good hover:underline" onClick={() => onBuy(o)}>
                            купил
                          </button>
                        )}
                        {['RECOMMENDED', 'CANDIDATE'].includes(o.eval.status) && (
                          <button className="ml-3 text-muted hover:text-bad" title="Отметить неудачную попытку закупки — это улучшает оценку источника" onClick={() => setFailing(o)}>
                            не вышло
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
      {verifying && (
        <VerifyDialog
          o={verifying}
          onClose={async () => {
            setVerifying(null);
            await sc.loadOpps();
          }}
          onBuy={(o) => {
            setVerifying(null);
            onBuy(o);
          }}
        />
      )}
      {failing && (
        <FailDialog
          o={failing}
          onClose={async () => {
            setFailing(null);
            await sc.loadOpps();
          }}
        />
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Card
          title={title}
          right={
            <button className="text-muted hover:text-fg" onClick={onClose}>
              ✕
            </button>
          }
        >
          {children}
        </Card>
      </div>
    </div>
  );
}

/** Перепроверка перед закупкой: свежая котировка мимо кэша + подтверждение наличия */
function VerifyDialog({ o, onClose, onBuy }: { o: Opportunity; onClose: () => void; onBuy: (o: Opportunity) => void }) {
  const auto = o.kind === 'watch' && !o.buy.manual;
  const [stockOk, setStockOk] = useState(false);
  const [price, setPrice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.verify(o.id, { userConfirmedStock: stockOk, actualPriceRub: price > 0 ? price : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const after = res?.opportunity;
  return (
    <Modal title={`Проверить сейчас: ${o.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Откройте{' '}
          <a href={o.buy.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            страницу товара ↗
          </a>{' '}
          и убедитесь, что он в наличии и это именно тот товар. Котировка: <span className="num">{fmtRub(o.buy.priceRub)}</span>.
        </p>
        {auto ? (
          <p className="text-xs text-muted">Сервер заново запросит цену у источника (мимо кэша) и пересчитает связку.</p>
        ) : (
          <NumberField label="Цена, которую вы видите сейчас" suffix="₽" value={price} onChange={setPrice} hint="Для этого источника цена проверяется вручную" />
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={stockOk} onChange={(e) => setStockOk(e.target.checked)} />
          Товар в наличии — я проверил на сайте
        </label>
        {error && <p className="text-bad">{error}</p>}
        {res && (
          <div className={`rounded-lg border p-3 ${res.ok ? 'border-good/40 bg-good/10' : 'border-bad/40 bg-bad/10'}`}>
            <p className="font-medium">{res.ok ? 'Котировка подтверждена' : 'Перепроверка не прошла'}</p>
            <p className="text-xs">
              было {fmtRub(res.quoted)} → сейчас {res.fresh === null ? '—' : fmtRub(res.fresh)}
              {res.notes.length > 0 && ` · ${res.notes.join('; ')}`}
            </p>
            {after && (
              <p className="mt-1 text-xs">
                Статус: <b>{STATUS_LABEL[after.eval.status]}</b>
                {after.eval.status === 'CANDIDATE' && after.eval.executionGaps.length > 0 && ` — ${after.eval.executionGaps.join('; ')}`}
                {after.eval.status === 'BLOCKED' && ` — ${after.eval.blocks[0]}`}
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Закрыть
          </button>
          {after?.eval.status === 'RECOMMENDED' ? (
            <button className="btn-primary" onClick={() => onBuy(after)}>
              Купил — записать партию
            </button>
          ) : (
            <button className="btn-primary" disabled={busy || (!auto && !(price > 0))} onClick={run}>
              {busy ? 'Проверяю…' : 'Проверить'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Неудачная попытка закупки — источник точности цены и остатка у источника */
function FailDialog({ o, onClose }: { o: Opportunity; onClose: () => void }) {
  const [outcome, setOutcome] = useState('out_of_stock');
  const [actual, setActual] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      await api.attempt({ oppId: o.id, watchId: o.watchId, sourceId: o.buy.sourceId, offerUrl: o.buy.url, quotedRub: o.buy.priceRub, actualRub: actual > 0 ? actual : undefined, quotedStock: o.buy.stock ?? null, outcome, note });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Не получилось купить: ${o.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="label">Что случилось</span>
          <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="out_of_stock">нет в наличии</option>
            <option value="price_changed">цена другая</option>
            <option value="not_found">товар/страница не найдены</option>
            <option value="failed">другая ошибка</option>
          </select>
        </label>
        {outcome === 'price_changed' && <NumberField label="Фактическая цена" suffix="₽" value={actual} onChange={setActual} />}
        <label className="block">
          <span className="label">Комментарий</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="text-xs text-muted">Отметки складываются в точность цены и остатка у источника («Качество и риск → Источники») и снижают его оценку.</p>
        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn-primary" onClick={submit}>
            Записать
          </button>
        </div>
      </div>
    </Modal>
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
        <div className="flex flex-wrap gap-1 text-xs">
          <Badge tone={e.verification === 'executable' ? 'good' : 'muted'}>{e.verification === 'executable' ? 'исполнимо' : 'теоретически (по котировкам)'}</Badge>
          {o.verifiedByTransaction && <Badge tone="good">подтверждено своей сделкой</Badge>}
        </div>
        <List title="Блокирует" items={e.blocks} cls="text-bad" />
        <List title="Требует решения" items={e.reviews} cls="text-warn" />
        <List title="Не подтверждено для покупки" items={e.executionGaps} cls="text-accent" />
        <List title="Предупреждения" items={e.warnings} cls="text-warn/90" />
        <List title="Допущения" items={e.assumptions} cls="text-muted" />
        {o.buy.dq && o.buy.dq.length > 0 && <List title="Качество данных котировки" items={o.buy.dq} cls="text-warn" />}
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
          Комиссия FunPay {o.saleFee.pct}% — {o.saleFee.source}. Срок продажи {e.daysToSell.toFixed(1)} дн.
          {e.sellProb7 && ` Вероятность продажи за 7 дн. по вашим продажам: ${Math.round(e.sellProb7.p * 100)}% (${Math.round(e.sellProb7.lo * 100)}–${Math.round(e.sellProb7.hi * 100)}%).`}
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
              {e.prices.optimal && (
                <tr>
                  <td className="text-xs">
                    Оптимальная по вашим продажам
                    <div className="text-muted">{e.prices.optimal.band}</div>
                  </td>
                  <td className="num text-right text-xs">
                    {fmtRub(e.prices.optimal.price)}
                    <div className="text-good">{e.prices.optimal.forecast ? fmtRub(e.prices.optimal.forecast.net) : ''}</div>
                  </td>
                </tr>
              )}
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
          <p className="mt-1 text-xs text-muted">Ликвидность: {e.liquidityBasis}.</p>
        </div>
        <button className="btn-ghost text-xs" onClick={toCalc}>
          → открыть в калькуляторе
        </button>
        <p className="text-xs text-muted">
          Данные: источник {ageText(e.ages.sourceMin)}, FunPay {ageText(e.ages.funpayMin)}
          {Number.isFinite(e.ages.verificationMin) && `, перепроверка ${ageText(e.ages.verificationMin)}`}.
        </p>
      </div>
    </div>
  );
}
