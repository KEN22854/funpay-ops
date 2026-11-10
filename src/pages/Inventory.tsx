import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Card, Empty, NumberField, Page, Stat, Warning } from '../components/ui';
import { api, type Metrics, type Mode, type Purchase, type Sale, type StockRow, type Watch } from '../lib/api';
import { fmtDate, fmtDateTime, fmtPct, fmtRub, todayISO } from '../lib/format';
import { useStore } from '../store/useStore';

const TABS = [
  { id: 'stock', label: 'Остатки' },
  { id: 'purchases', label: 'Закупки' },
  { id: 'sales', label: 'Продажи' },
  { id: 'cash', label: 'Касса' },
  { id: 'analytics', label: 'Аналитика' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** дата из поля: сегодня — текущий момент; прошлый день — полдень этого дня */
const dateToIso = (d: string) => (d === todayISO() ? new Date().toISOString() : new Date(d + 'T12:00:00').toISOString());

const SALE_STATUS: Record<Sale['status'], { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  completed: { label: 'завершена', tone: 'good' },
  disputed_won: { label: 'спор выигран', tone: 'muted' },
  partial_refund: { label: 'частичный возврат', tone: 'warn' },
  refunded: { label: 'возврат', tone: 'bad' },
  cancelled: { label: 'отменена', tone: 'muted' },
};

/** Склад, продажи и финансы — данные на сервере (SQLite), операции идемпотентны. */
export default function Inventory() {
  const [tab, setTab] = useState<Tab>('stock');
  const [mode, setMode] = useState<Mode>('real');
  const [stock, setStock] = useState<StockRow[]>([]);
  const [cash, setCash] = useState<{ tracking: boolean; balance: number }>({ tracking: false, balance: 0 });
  const [reservations, setReservations] = useState<{ id: string; item: string; qty: number; created_at: string; note: string | null }[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p, sl, w] = await Promise.all([api.stock(mode), api.purchases(mode), api.sales(mode), api.watches()]);
      setStock(s.items);
      setCash(s.cash);
      setReservations(s.reservations);
      setPurchases(p);
      setSales(sl);
      setWatches(w.watches);
      setOffline(false);
    } catch (e) {
      setOffline(true);
      setError((e as Error).message);
    }
  }, [mode]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const items = useMemo(() => [...new Set([...watches.map((w) => w.name), ...stock.map((s) => s.item)])].sort(), [watches, stock]);
  const invValue = stock.reduce((s, x) => s + Math.max(0, x.valueRub), 0);

  return (
    <Page
      title="Склад и финансы"
      subtitle="Партии закупок, себестоимость по FIFO или средней, продажи с фактической прибылью, возвраты, касса и аналитика. История не удаляется — только корректирующие записи."
      actions={
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-sm">
          {(['real', 'sim'] as const).map((m) => (
            <button key={m} className={`rounded-md px-3 py-1 ${mode === m ? (m === 'sim' ? 'bg-warn text-black' : 'bg-accent text-white') : 'text-muted'}`} onClick={() => setMode(m)}>
              {m === 'real' ? 'Реальные деньги' : 'Симуляция'}
            </button>
          ))}
        </div>
      }
    >
      {offline ? (
        <Warning tone="bad">Сервер не отвечает — запустите npm run dev.</Warning>
      ) : (
        <>
          {mode === 'sim' && <Warning>Режим симуляции: закупки и продажи учитываются отдельно и не влияют на реальную кассу, остатки и отчёты.</Warning>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Стоимость запасов" value={fmtRub(invValue)} sub={`${stock.filter((s) => s.onHand > 0).length} позиций`} />
            <Stat label="В пути" value={stock.reduce((s, x) => s + x.inTransit, 0)} sub="шт, ещё не получено" />
            <Stat label="Касса" value={cash.tracking ? fmtRub(cash.balance) : '—'} sub={cash.tracking ? 'доступно' : 'не ведётся (внесите стартовый капитал)'} tone={cash.tracking && cash.balance < 0 ? 'bad' : undefined} />
            <Stat label="Низкий остаток" value={stock.filter((s) => s.low && s.onHand > 0).length} tone={stock.some((s) => s.low && s.onHand > 0) ? 'warn' : undefined} />
          </div>
          <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
            {TABS.map((t) => (
              <button key={t.id} className={`rounded-md px-3 py-1.5 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          {error && <Warning tone="bad">{error}</Warning>}
          {tab === 'stock' && <StockTab stock={stock} reservations={reservations} mode={mode} run={run} />}
          {tab === 'purchases' && <PurchasesTab purchases={purchases} items={items} mode={mode} run={run} />}
          {tab === 'sales' && <SalesTab sales={sales} items={items} watches={watches} mode={mode} run={run} />}
          {tab === 'cash' && <CashTab mode={mode} cash={cash} run={run} />}
          {tab === 'analytics' && <AnalyticsTab mode={mode} />}
          <datalist id="inv-items">
            {items.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
        </>
      )}
    </Page>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

function StockTab({ stock, reservations, mode, run }: { stock: StockRow[]; reservations: { id: string; item: string; qty: number; created_at: string; note: string | null }[]; mode: Mode; run: Run }) {
  const [act, setAct] = useState<{ item: string; kind: 'writeoff' | 'reserve' } | null>(null);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  return (
    <div className="space-y-4">
      {stock.length === 0 ? (
        <Empty>Склад пуст. Закупки добавляются во вкладке «Закупки» или кнопкой «купил» в сканере.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="text-right">На складе</th>
                <th className="text-right">Резерв</th>
                <th className="text-right">Доступно</th>
                <th className="text-right">В пути</th>
                <th className="text-right">Себестоимость ед.</th>
                <th className="text-right">Стоимость</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stock.map((s) => (
                <tr key={s.item}>
                  <td>
                    {s.item} {s.low && s.onHand > 0 && <Badge tone="warn">мало</Badge>} {s.onHand < 0 && <Badge tone="bad">минус</Badge>}
                    <div className="text-xs text-muted">партий: {s.batches}</div>
                  </td>
                  <td className="num text-right">{s.onHand}</td>
                  <td className="num text-right">{s.reserved}</td>
                  <td className="num text-right font-semibold">{s.available}</td>
                  <td className="num text-right">{s.inTransit}</td>
                  <td className="num text-right">{s.avgCostRub === null ? '—' : fmtRub(s.avgCostRub)}</td>
                  <td className="num text-right">{fmtRub(s.valueRub)}</td>
                  <td className="whitespace-nowrap text-right text-xs">
                    <button className="text-accent hover:underline" onClick={() => setAct({ item: s.item, kind: 'reserve' })}>
                      резерв
                    </button>
                    <button className="ml-3 text-bad hover:underline" onClick={() => setAct({ item: s.item, kind: 'writeoff' })}>
                      списать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {act && (
        <Card title={`${act.kind === 'writeoff' ? 'Списание' : 'Резерв'}: ${act.item}`} right={<button onClick={() => setAct(null)}>✕</button>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField label="Количество" value={qty} min={1} onChange={(v) => setQty(Math.max(1, Math.floor(v)))} />
            <label className="block sm:col-span-2">
              <span className="label">Причина</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={act.kind === 'writeoff' ? 'ключ не активировался, брак…' : 'заказ №…'} />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              className={act.kind === 'writeoff' ? 'btn-danger' : 'btn-primary'}
              onClick={async () => {
                const ok = await run(() => (act.kind === 'writeoff' ? api.writeOff({ item: act.item, qty, note, mode }) : api.reserve({ item: act.item, qty, note, mode })));
                if (ok) setAct(null);
              }}
            >
              {act.kind === 'writeoff' ? 'Списать по себестоимости' : 'Зарезервировать'}
            </button>
          </div>
        </Card>
      )}
      {reservations.length > 0 && (
        <Card title="Резервы">
          <ul className="space-y-1 text-sm">
            {reservations.map((r) => (
              <li key={r.id} className="flex items-center gap-3">
                <span>
                  {r.item} × {r.qty}
                </span>
                <span className="text-xs text-muted">
                  {fmtDateTime(r.created_at)} {r.note}
                </span>
                <button className="ml-auto text-xs text-accent hover:underline" onClick={() => run(() => api.release(r.id))}>
                  снять
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function PurchasesTab({ purchases, items, mode, run }: { purchases: Purchase[]; items: string[]; mode: Mode; run: Run }) {
  const [f, setF] = useState({ item: '', sourceId: '', qty: 1, unitPrice: 0, currency: 'RUB', feesRub: 0, status: 'received', purchasedAt: todayISO() });
  const [key, setKey] = useState(api.newKey);
  void items;
  return (
    <div className="space-y-4">
      <Card title="Новая закупка (партия)">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block lg:col-span-2">
            <span className="label">Товар</span>
            <input className="input" list="inv-items" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="как в каталоге — чтобы связать с историей" />
          </label>
          <label className="block">
            <span className="label">Где куплено</span>
            <input className="input" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })} placeholder="plati, g2a…" />
          </label>
          <label className="block">
            <span className="label">Дата</span>
            <input type="date" className="input num" max={todayISO()} value={f.purchasedAt} onChange={(e) => setF({ ...f, purchasedAt: e.target.value })} />
          </label>
          <NumberField label="Количество" value={f.qty} min={1} onChange={(v) => setF({ ...f, qty: Math.max(1, Math.floor(v)) })} />
          <NumberField label="Цена за шт" value={f.unitPrice} onChange={(v) => setF({ ...f, unitPrice: v })} />
          <label className="block">
            <span className="label">Валюта</span>
            <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'TRY', 'CNY'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <NumberField label="Комиссии при покупке, всего" suffix="₽" value={f.feesRub} onChange={(v) => setF({ ...f, feesRub: v })} />
          <label className="block">
            <span className="label">Статус</span>
            <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="received">получено</option>
              <option value="in_transit">в пути</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">Валюта переводится по курсу ЦБ на сегодня + спред из параметров. Если ведётся касса — закупка больше остатка денег блокируется.</p>
        <div className="mt-3 flex justify-end">
          <button
            className="btn-primary"
            disabled={!f.item.trim() || f.unitPrice < 0}
            onClick={async () => {
              const ok = await run(() => api.createPurchase({ ...f, mode, purchasedAt: dateToIso(f.purchasedAt) }, key));
              if (ok) {
                setF({ ...f, item: '', unitPrice: 0, feesRub: 0, qty: 1 });
                setKey(api.newKey());
              }
            }}
          >
            Записать партию
          </button>
        </div>
      </Card>
      {purchases.length === 0 ? (
        <Empty>Закупок нет.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Товар</th>
                <th className="text-right">Шт</th>
                <th className="text-right">Цена</th>
                <th className="text-right">Себест. ед.</th>
                <th className="text-right">Всего</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id} className={p.status === 'cancelled' ? 'opacity-50' : ''}>
                  <td className="num whitespace-nowrap text-muted">{fmtDate(p.purchased_at)}</td>
                  <td>
                    {p.item}
                    <div className="text-xs text-muted">
                      {p.source_id}
                      {p.recommendation_id && ' · по рекомендации'}
                    </div>
                  </td>
                  <td className="num text-right">{p.qty}</td>
                  <td className="num text-right">
                    {p.unit_price} {p.currency}
                    {p.currency !== 'RUB' && <div className="text-xs text-muted">курс {p.fx_rate.toFixed(2)}{p.fx_spread_pct ? ` +${p.fx_spread_pct}%` : ''}</div>}
                  </td>
                  <td className="num text-right">{fmtRub(p.unit_cost_rub)}</td>
                  <td className="num text-right">{fmtRub(p.total_cost_rub)}</td>
                  <td>
                    <Badge tone={p.status === 'received' ? 'good' : p.status === 'in_transit' ? 'warn' : 'muted'}>{p.status === 'received' ? 'получено' : p.status === 'in_transit' ? 'в пути' : 'отменено'}</Badge>
                  </td>
                  <td className="whitespace-nowrap text-right text-xs">
                    {p.status === 'in_transit' && (
                      <button className="text-accent hover:underline" onClick={() => run(() => api.receive(p.id))}>
                        получено
                      </button>
                    )}
                    {p.status !== 'cancelled' && (
                      <button className="ml-3 text-bad hover:underline" onClick={() => confirm('Отменить закупку? Деньги вернутся в кассу; если из партии уже продавали — отмена невозможна.') && run(() => api.cancelPurchase(p.id))}>
                        отменить
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SalesTab({ sales, items, watches, mode, run }: { sales: Sale[]; items: string[]; watches: Watch[]; mode: Mode; run: Run }) {
  void items;
  const deals = useStore((s) => s.deals);
  const [f, setF] = useState({ item: '', qty: 1, unitPrice: 0, saleFeePct: '', withdrawPct: '', fulfillmentRub: 0, status: 'completed', soldAt: todayISO(), note: '' });
  const [key, setKey] = useState(api.newKey);
  const [refund, setRefund] = useState<Sale | null>(null);
  const [rAmount, setRAmount] = useState(0);
  const [restock, setRestock] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const sectionUrl = watches.find((w) => w.name === f.item)?.funpay.url;

  const importJournal = async () => {
    if (!deals.length) return;
    if (!confirm(`Перенести ${deals.length} сделок из старого журнала как исторические продажи (без движения склада)?`)) return;
    const ok = await run(() =>
      api
        .importSales(
          deals.map((d) => ({
            item: d.item,
            qty: d.qty || 1,
            unitPrice: d.sell / (d.qty || 1),
            saleFeePct: d.feePct,
            withdrawPct: d.withdrawPct,
            cogsRub: d.buy,
            soldAt: dateToIso(d.date),
            outcome: d.outcome,
            disputeLoss: d.disputeLoss,
            note: d.note,
            mode,
          })),
          `journal-import-${mode}-${deals.length}-${deals[0]?.id ?? ''}`,
        )
        .then((r) => setImportMsg(r.replayed ? 'Этот журнал уже был импортирован — повтор не выполнен.' : `Импортировано: ${r.imported}`)),
    );
    void ok;
  };

  return (
    <div className="space-y-4">
      <Card title="Новая продажа" right={deals.length > 0 && <button className="btn-ghost text-xs" onClick={importJournal}>Импорт из старого журнала ({deals.length})</button>}>
        {importMsg && <p className="mb-2 text-sm text-muted">{importMsg}</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block lg:col-span-2">
            <span className="label">Товар</span>
            <input className="input" list="inv-items" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} />
            <span className="mt-1 block text-xs text-muted">{sectionUrl ? 'комиссия возьмётся из профиля раздела FunPay этого товара' : 'товара нет в каталоге — комиссия по умолчанию, если не указать вручную'}</span>
          </label>
          <label className="block">
            <span className="label">Дата</span>
            <input type="date" className="input num" max={todayISO()} value={f.soldAt} onChange={(e) => setF({ ...f, soldAt: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">Итог</span>
            <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="completed">завершена</option>
              <option value="disputed_won">был спор, выигран</option>
            </select>
          </label>
          <NumberField label="Количество" value={f.qty} min={1} onChange={(v) => setF({ ...f, qty: Math.max(1, Math.floor(v)) })} />
          <NumberField label="Цена лота за шт" suffix="₽" value={f.unitPrice} onChange={(v) => setF({ ...f, unitPrice: v })} />
          <label className="block">
            <span className="label">Комиссия FunPay, % (необяз.)</span>
            <input className="input num" value={f.saleFeePct} onChange={(e) => setF({ ...f, saleFeePct: e.target.value })} placeholder="из профиля" />
          </label>
          <label className="block">
            <span className="label">Вывод, % (необяз.)</span>
            <input className="input num" value={f.withdrawPct} onChange={(e) => setF({ ...f, withdrawPct: e.target.value })} placeholder="из параметров" />
          </label>
          <NumberField label="Расходы на исполнение" suffix="₽" value={f.fulfillmentRub} onChange={(v) => setF({ ...f, fulfillmentRub: v })} />
          <label className="block sm:col-span-2 lg:col-span-3">
            <span className="label">Заметка / номер заказа</span>
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">Себестоимость спишется с партий склада (FIFO или средняя — в параметрах). Если остатка нет — продажа будет отклонена.</p>
        <div className="mt-3 flex justify-end">
          <button
            className="btn-primary"
            disabled={!f.item.trim() || f.unitPrice <= 0}
            onClick={async () => {
              const ok = await run(() =>
                api.createSale(
                  {
                    ...f,
                    mode,
                    sectionUrl,
                    watchId: watches.find((w) => w.name === f.item)?.id,
                    saleFeePct: f.saleFeePct === '' ? undefined : Number(f.saleFeePct.replace(',', '.')),
                    withdrawPct: f.withdrawPct === '' ? undefined : Number(f.withdrawPct.replace(',', '.')),
                    soldAt: dateToIso(f.soldAt),
                  },
                  key,
                ),
              );
              if (ok) {
                setF({ ...f, item: '', unitPrice: 0, note: '', qty: 1 });
                setKey(api.newKey());
              }
            }}
          >
            Записать продажу
          </button>
        </div>
      </Card>

      {refund && (
        <Card title={`Возврат: ${refund.item}`} right={<button onClick={() => setRefund(null)}>✕</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label={`Сумма возврата (выплата ${fmtRub(refund.payout_rub)})`} suffix="₽" value={rAmount} onChange={setRAmount} />
            <label className="mt-6 flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> товар вернулся на склад (только при полном возврате)
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button className="btn-danger" onClick={async () => (await run(() => api.refund(refund.id, { amount: rAmount || undefined, restock }))) && setRefund(null)}>
              Оформить возврат
            </button>
          </div>
        </Card>
      )}

      {sales.length === 0 ? (
        <Empty>Продаж нет.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Товар</th>
                <th className="text-right">Выручка</th>
                <th className="text-right">Комиссии</th>
                <th className="text-right">Себест.</th>
                <th className="text-right">Возврат</th>
                <th className="text-right">Чистыми</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id}>
                  <td className="num whitespace-nowrap text-muted">{fmtDate(s.sold_at)}</td>
                  <td>
                    {s.item} × {s.qty}
                    <div className="text-xs text-muted" title={s.sale_fee_source ?? ''}>
                      комиссия {s.sale_fee_pct}% · {s.cost_method === 'imported' ? 'импорт' : s.cost_method.toUpperCase()}
                      {s.note && ` · ${s.note}`}
                    </div>
                  </td>
                  <td className="num text-right">{fmtRub(s.revenue_rub)}</td>
                  <td className="num text-right">{fmtRub(s.platform_fee_rub + s.withdraw_fee_rub)}</td>
                  <td className="num text-right">{fmtRub(s.cogs_rub)}</td>
                  <td className="num text-right">{s.refund_rub ? fmtRub(s.refund_rub) : '—'}</td>
                  <td className={`num text-right font-medium ${s.net_rub >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(s.net_rub)}</td>
                  <td>
                    <Badge tone={SALE_STATUS[s.status].tone}>{SALE_STATUS[s.status].label}</Badge>
                  </td>
                  <td className="whitespace-nowrap text-right text-xs">
                    {!['refunded', 'cancelled'].includes(s.status) && (
                      <button
                        className="text-bad hover:underline"
                        onClick={() => {
                          setRefund(s);
                          setRAmount(s.payout_rub - s.refund_rub);
                          setRestock(false);
                        }}
                      >
                        возврат
                      </button>
                    )}
                    {s.status === 'completed' && (
                      <button className="ml-3 text-muted hover:text-fg" onClick={() => run(() => api.dispute(s.id))}>
                        был спор
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CashTab({ mode, cash, run }: { mode: Mode; cash: { tracking: boolean; balance: number }; run: Run }) {
  const [ledger, setLedger] = useState<{ id: number; ts: string; type: string; amount_rub: number; note: string | null }[]>([]);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  useEffect(() => {
    api.ledger(mode).then(setLedger);
  }, [mode, cash.balance]);
  const T: Record<string, string> = { deposit: 'внесение', withdraw: 'изъятие', purchase: 'закупка', purchase_cancel: 'отмена закупки', sale: 'выплата за продажу', refund: 'возврат покупателю', tax: 'налог', fulfillment: 'исполнение' };
  return (
    <div className="space-y-4">
      <Card title={cash.tracking ? `Остаток: ${fmtRub(cash.balance)}` : 'Касса не ведётся'}>
        <p className="mb-3 text-xs text-muted">Касса включается, когда задан стартовый капитал (Настройки → Параметры склада) или внесены деньги. Тогда закупка больше остатка блокируется — защита от кассового разрыва.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="Сумма" suffix="₽" value={amount} onChange={setAmount} />
          <label className="block sm:col-span-2">
            <span className="label">Комментарий</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-ghost" disabled={amount <= 0} onClick={() => run(() => api.cash({ type: 'withdraw', amount, note, mode }))}>
            Изъять
          </button>
          <button className="btn-primary" disabled={amount <= 0} onClick={() => run(() => api.cash({ type: 'deposit', amount, note, mode }))}>
            Внести
          </button>
        </div>
      </Card>
      <Card
        title="Движение денег"
        right={
          <div className="flex gap-3 text-xs">
            {(['sales', 'purchases', 'ledger'] as const).map((k) => (
              <a key={k} className="text-accent hover:underline" href={`/api/export/${k}?mode=${mode}`}>
                CSV: {k === 'sales' ? 'продажи' : k === 'purchases' ? 'закупки' : 'касса'}
              </a>
            ))}
          </div>
        }
      >
        {ledger.length === 0 ? (
          <Empty>Движений нет.</Empty>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="table">
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td className="num whitespace-nowrap text-xs text-muted">{fmtDateTime(l.ts)}</td>
                    <td className="text-sm">{T[l.type] ?? l.type}</td>
                    <td className="text-xs text-muted">{l.note}</td>
                    <td className={`num text-right ${l.amount_rub >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(l.amount_rub)}</td>
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

function AnalyticsTab({ mode }: { mode: Mode }) {
  const [days, setDays] = useState(30);
  const [cmp, setCmp] = useState<{ current: Metrics; previous: Metrics; deltaPct: Record<string, number | null> } | null>(null);
  const [abc, setAbc] = useState<Awaited<ReturnType<typeof api.abcxyz>>>([]);
  const [rq, setRq] = useState<Awaited<ReturnType<typeof api.recQuality>> | null>(null);
  useEffect(() => {
    const q = `days=${days}&mode=${mode}`;
    api.compare(q).then(setCmp);
    api.abcxyz(q).then(setAbc);
    api.recQuality().then(setRq);
  }, [days, mode]);
  const m = cmp?.current;
  const d = (k: string) => {
    const v = cmp?.deltaPct[k];
    return v === null || v === undefined ? 'нет базы для сравнения' : `${v > 0 ? '+' : ''}${v.toFixed(0)}% к прошлому периоду`;
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {[7, 30, 90, 365].map((x) => (
          <button key={x} className={`rounded-md px-3 py-1.5 ${days === x ? 'bg-accent text-white' : 'text-muted'}`} onClick={() => setDays(x)}>
            {x} дн
          </button>
        ))}
      </div>
      {m && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Выручка" value={fmtRub(m.revenue)} sub={d('revenue')} />
          <Stat label="Валовая прибыль" value={fmtRub(m.grossProfit)} sub="выручка − себестоимость" />
          <Stat label="Чистая прибыль" value={fmtRub(m.netProfit)} tone={m.netProfit >= 0 ? 'good' : 'bad'} sub={d('netProfit')} />
          <Stat label="Чистая маржа" value={m.netMarginPct === null ? '—' : fmtPct(m.netMarginPct)} sub="чистая прибыль / выручка" />
          <Stat label="ROI" value={m.roiPct === null ? '—' : fmtPct(m.roiPct)} sub="чистая прибыль / себестоимость проданного" />
          <Stat label="Средний чек" value={m.aov === null ? '—' : fmtRub(m.aov)} sub={`${m.orders} заказов, ${m.units} шт`} />
          <Stat label="Возвраты / споры" value={`${m.refundRatePct === null ? '—' : fmtPct(m.refundRatePct)} / ${m.disputeRatePct === null ? '—' : fmtPct(m.disputeRatePct)}`} />
          <Stat label="Оборачиваемость капитала" value={m.capitalTurnover === null ? '—' : `${m.capitalTurnover.toFixed(2)}×`} sub="себестоимость / средние запасы" />
          <Stat label="Деньги: приход" value={fmtRub(m.cashFlow.in)} />
          <Stat label="Деньги: расход" value={fmtRub(m.cashFlow.out)} />
          <Stat label="Денежный поток" value={fmtRub(m.cashFlow.net)} tone={m.cashFlow.net >= 0 ? 'good' : 'bad'} />
          <Stat label="Запасы на конец" value={fmtRub(m.inventoryEnd)} sub={`на начало ${fmtRub(m.inventoryStart)}`} />
        </div>
      )}
      <Card title="ABC / XYZ">
        <p className="mb-2 text-xs text-muted">ABC — вклад в чистую прибыль (A — первые 80%, B — до 95%). XYZ — стабильность понедельных продаж (нужно ≥ 4 недель). Границы — в настройках.</p>
        {abc.length === 0 ? (
          <Empty>Нет продаж за период.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>ABC</th>
                <th>XYZ</th>
                <th className="text-right">Прибыль</th>
                <th className="text-right">Доля</th>
                <th className="text-right">Шт</th>
              </tr>
            </thead>
            <tbody>
              {abc.map((r) => (
                <tr key={r.item}>
                  <td>{r.item}</td>
                  <td>
                    <Badge tone={r.abc === 'A' ? 'good' : r.abc === 'B' ? 'accent' : 'muted'}>{r.abc}</Badge>
                  </td>
                  <td>{r.xyz ? <Badge tone={r.xyz === 'X' ? 'good' : r.xyz === 'Y' ? 'warn' : 'bad'}>{r.xyz}</Badge> : <span className="text-xs text-muted">мало данных</span>}</td>
                  <td className={`num text-right ${r.net >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(r.net)}</td>
                  <td className="num text-right">{fmtPct(r.sharePct)}</td>
                  <td className="num text-right">{r.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {rq && (
        <Card title="Качество рекомендаций (по фактическим исходам)">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Рекомендаций всего" value={rq.total} />
            <Stat label="Куплено по ним" value={rq.purchased} />
            <Stat label="Precision" value={rq.precision === null ? '—' : fmtPct(rq.precision * 100)} sub={`прибыльных ${rq.profitable} из ${rq.known} с известным исходом`} />
            <Stat label="Ошибка прогноза (MAE)" value={rq.maePerUnit === null ? '—' : fmtRub(rq.maePerUnit)} sub="на 1 шт: прогноз vs факт" />
          </div>
          <p className="mt-2 text-xs text-muted">Исход известен, когда вся партия, купленная по рекомендации, продана или списана. Неизвестный исход не считается ни успехом, ни провалом.</p>
        </Card>
      )}
    </div>
  );
}
