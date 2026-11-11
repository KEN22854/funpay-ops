import { useState } from 'react';
import { Card, NumberField, Page, Warning } from '../components/ui';
import { api, type Mode, type Opportunity } from '../lib/api';
import { fmtRub } from '../lib/format';
import { Discover } from './scanner/Discover';
import { Fees } from './scanner/Fees';
import { Market } from './scanner/Market';
import { Opportunities } from './scanner/Opportunities';
import { Params } from './scanner/Params';
import { Sources } from './scanner/Sources';
import { useScanner } from './scanner/useScanner';
import { Watches } from './scanner/Watches';

const TABS = [
  { id: 'opps', label: 'Возможности' },
  { id: 'market', label: 'Рынок' },
  { id: 'watch', label: 'Каталог' },
  { id: 'discover', label: 'Автопоиск скинов' },
  { id: 'sources', label: 'Источники' },
  { id: 'fees', label: 'Комиссии' },
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
  const [buying, setBuying] = useState<Opportunity | null>(null);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem('funpay-ops:scanner-tab', t);
    } catch {
      /* noop */
    }
  };
  const busy = Boolean(sc.health?.working) || (sc.health?.queue.length ?? 0) > 0;

  return (
    <Page
      title="Сканер выгоды"
      subtitle="Проверенные торговые гипотезы: товар сопоставлен по характеристикам, данные свежие, прибыль посчитана со всеми расходами. Рекомендация — не гарантия сделки."
      actions={
        <span className={`flex items-center gap-2 text-xs ${sc.offline ? 'text-bad' : 'text-good'}`}>
          <span className={`h-2 w-2 rounded-full ${sc.offline ? 'bg-bad' : 'bg-good'}`} />
          {sc.offline ? 'сервер не запущен' : busy ? 'сканирую…' : `сервер работает · схема v${sc.health?.schema ?? '?'}`}
        </span>
      }
    >
      {sc.offline ? (
        <Warning tone="bad">
          <p className="font-medium">Сервер не отвечает.</p>
          <p>
            Запустите в папке проекта <span className="num">npm run dev</span>.
          </p>
          <p className="text-xs text-muted">{sc.offline}</p>
        </Warning>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
            {TABS.map((t) => (
              <button key={t.id} className={`rounded-md px-3 py-1.5 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'watch' && sc.watches.length > 0 && <span className="num ml-1 opacity-70">{sc.watches.length}</span>}
                {t.id === 'sources' && sc.sources.length > 0 && <span className="num ml-1 opacity-70">{sc.sources.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'opps' && <Opportunities sc={sc} onBuy={setBuying} />}
          {tab === 'market' && <Market sc={sc} />}
          {tab === 'watch' && <Watches sc={sc} />}
          {tab === 'discover' && <Discover sc={sc} />}
          {tab === 'sources' && <Sources sc={sc} />}
          {tab === 'fees' && <Fees sc={sc} />}
          {tab === 'params' && <Params sc={sc} />}
          {buying && <BuyDialog o={buying} onClose={() => setBuying(null)} />}
        </>
      )}
    </Page>
  );
}

/** Закупка по рекомендации: партия попадает на склад и связывается с рекомендацией (для оценки точности). */
function BuyDialog({ o, onClose }: { o: Opportunity; onClose: () => void }) {
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(o.buy.price);
  const [fees, setFees] = useState(0);
  const [mode, setMode] = useState<Mode>('real');
  const [status, setStatus] = useState<'received' | 'in_transit'>('received');
  const [key] = useState(api.newKey);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.createPurchase(
        { item: o.name, watchId: o.watchId, recommendationId: o.id, sourceId: o.buy.sourceId, category: o.category, qty, unitPrice: price, currency: o.buy.currency, fxRate: o.buy.fxRate, feesRub: fees, mode, status, note: o.buy.url },
        key,
      );
      // фактическая цена против котировки — точность источника (только для реальных денег)
      if (mode === 'real' && !p.replayed) {
        const actualRub = price * (o.buy.fxRate ?? 1);
        const changed = Math.abs(actualRub - o.buy.priceRub) / o.buy.priceRub > 0.005;
        await api
          .attempt({ oppId: o.id, watchId: o.watchId, sourceId: o.buy.sourceId, offerUrl: o.buy.url, quotedRub: o.buy.priceRub, actualRub, quotedStock: o.buy.stock ?? null, outcome: changed ? 'price_changed' : 'ok', purchaseId: p.id })
          .catch(() => {});
      }
      setDone(`Партия записана: ${p.qty} шт по ${fmtRub(p.unit_cost_rub)} (всего ${fmtRub(p.total_cost_rub)})`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Card title={`Купил: ${o.name}`} right={<button className="text-muted hover:text-fg" onClick={onClose}>✕</button>}>
          {done ? (
            <div className="space-y-3">
              <p className="text-sm text-good">{done}</p>
              <p className="text-xs text-muted">Продажу внесите в «Склад и финансы» — себестоимость спишется по {''}партии автоматически.</p>
              <button className="btn-primary" onClick={onClose}>
                Готово
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Количество" suffix="шт" value={qty} min={1} onChange={(v) => setQty(Math.max(1, Math.floor(v)))} />
                <NumberField label={`Цена за шт (${o.buy.currency})`} value={price} onChange={setPrice} />
                <NumberField label="Комиссии при покупке, всего" suffix="₽" value={fees} onChange={setFees} />
                <label className="block">
                  <span className="label">Статус</span>
                  <select className="input" value={status} onChange={(e) => setStatus(e.target.value as 'received' | 'in_transit')}>
                    <option value="received">получен</option>
                    <option value="in_transit">в пути (ещё не выдан)</option>
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={mode === 'sim'} onChange={(e) => setMode(e.target.checked ? 'sim' : 'real')} />
                Симуляция (без реальных денег — отдельный учёт)
              </label>
              {o.buy.currency !== 'RUB' && <p className="text-xs text-muted">Курс {o.buy.currency}: {o.buy.fxRate?.toFixed(4)} (ЦБ). Спред из параметров добавится к закупке.</p>}
              {error && <p className="text-sm text-bad">{error}</p>}
              <div className="flex justify-end gap-2">
                <button className="btn-ghost" onClick={onClose}>
                  Отмена
                </button>
                <button className="btn-primary" disabled={busy} onClick={submit}>
                  Записать партию
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
