import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Card, Empty, NumberField } from '../../components/ui';
import type { Category } from '../../lib/api';
import { bestPerItem, fromDiscovery, fromWatches, type Opportunity } from '../../lib/arbitrage';
import { fmtDateTime, fmtPct, fmtRub } from '../../lib/format';
import { useStore } from '../../store/useStore';
import { CATEGORY_LABEL, type ScannerState } from './useScanner';

type Sort = 'net' | 'pct' | 'roi';

export function Opportunities({ sc }: { sc: ScannerState }) {
  const arb = useStore((s) => s.arb);
  const setCalcDraft = useStore((s) => s.setCalcDraft);
  const navigate = useNavigate();
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [src, setSrc] = useState('all');
  const [q, setQ] = useState('');
  const [minNet, setMinNet] = useState(0);
  const [minRoi, setMinRoi] = useState(0);
  const [onlyProfit, setOnlyProfit] = useState(true);
  const [hideRisky, setHideRisky] = useState(false);
  const [bestOnly, setBestOnly] = useState(true);
  const [hideSuspicious, setHideSuspicious] = useState(true);
  const [sort, setSort] = useState<Sort>('net');
  const [busy, setBusy] = useState<string | null>(null);

  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);

  const all = useMemo(() => {
    const list = [...fromWatches(sc.watches, sc.results, arb), ...Object.values(sc.discoveries).flatMap((d) => fromDiscovery(d, arb))];
    return list;
  }, [sc.watches, sc.results, sc.discoveries, arb]);

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let list = all.filter(
      (o) =>
        (cat === 'all' || o.category === cat) &&
        (src === 'all' || o.buy.sourceId === src) &&
        (!qq || o.name.toLowerCase().includes(qq)) &&
        (!onlyProfit || o.margin.net > 0) &&
        o.margin.net >= minNet &&
        (minRoi <= 0 || (o.margin.roiPct ?? 0) >= minRoi) &&
        (!hideRisky || o.fpCount >= arb.minCompetitors) &&
        (!hideSuspicious || !o.suspicious),
    );
    if (bestOnly) list = bestPerItem(list);
    const key = (o: Opportunity) => (sort === 'net' ? o.margin.net : sort === 'pct' ? o.margin.netPct : (o.margin.roiPct ?? -Infinity));
    return list.sort((a, b) => key(b) - key(a));
  }, [all, cat, src, q, onlyProfit, minNet, minRoi, hideRisky, hideSuspicious, bestOnly, sort, arb.minCompetitors]);

  const usedSources = useMemo(() => [...new Set(all.map((o) => o.buy.sourceId))].sort(), [all]);
  const totalNet = rows.reduce((s, o) => s + Math.max(0, o.margin.net), 0);

  const hideOffer = async (o: Opportunity) => {
    const w = sc.watches.find((x) => x.id === o.watchId);
    if (!w) return;
    setBusy(o.key);
    try {
      await sc.saveWatch({ ...w, ignore: [...w.ignore, o.buy.url] });
      await sc.scan(w.id);
    } finally {
      setBusy(null);
    }
  };

  const toCalc = (o: Opportunity) => {
    setCalcDraft({
      price: o.sellPrice,
      cost: Math.round(o.cost * 100) / 100,
      platformFeePct: arb.sellFeePct,
      withdrawFeePct: arb.withdrawPct,
      disputeMode: 'percent',
      disputeValue: arb.disputePct,
      minutesPerOrder: arb.minutesPerOrder,
      hourlyRate: arb.hourlyRate,
    });
    navigate('/calculator');
  };

  return (
    <div className="space-y-4">
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
          <NumberField label="Маржа от" suffix="₽" value={minNet} onChange={setMinNet} />
          <NumberField label="ROI от" suffix="%" value={minRoi} onChange={setMinRoi} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <input className="input max-w-xs" placeholder="Поиск по товару" value={q} onChange={(e) => setQ(e.target.value)} />
          <Check label="Только в плюс" v={onlyProfit} set={setOnlyProfit} />
          <Check label={`Скрыть, если конкурентов < ${arb.minCompetitors}`} v={hideRisky} set={setHideRisky} />
          <Check label={`Скрыть подозрительно дешёвые (< ${arb.suspiciousPct}% цены FunPay)`} v={hideSuspicious} set={setHideSuspicious} />
          <Check label="Лучшая закупка по товару" v={bestOnly} set={setBestOnly} />
          <label className="flex items-center gap-2 text-muted">
            Сортировка
            <select className="input w-auto py-1" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="net">маржа ₽</option>
              <option value="pct">маржа %</option>
              <option value="roi">ROI</option>
            </select>
          </label>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span>
          Связок: <span className="num text-fg">{rows.length}</span> из <span className="num">{all.length}</span>
          {rows.length > 0 && (
            <>
              {' '}
              · сумма маржи по 1 шт: <span className="num text-good">{fmtRub(totalNet)}</span>
            </>
          )}
        </span>
        <span className="text-xs">
          Продажа = мин. цена на FunPay − подрезка; X {arb.sellFeePct}%, Y {arb.withdrawPct}%, R {arb.disputePct}% — меняется во вкладке «Параметры».
        </span>
      </div>

      {rows.length === 0 ? (
        <Empty>
          {all.length === 0
            ? 'Пока нет данных. Добавь товары во вкладке «Отслеживание» и нажми «Сканировать», или запусти «Автопоиск скинов».'
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
                <th className="text-right">Продать на FunPay</th>
                <th className="text-right">Маржа</th>
                <th className="text-right">ROI</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((o) => {
                const tone = o.margin.net > 0 ? 'text-good' : 'text-bad';
                return (
                  <tr key={o.key}>
                    <td className="min-w-[200px]">
                      <div className="font-medium">{o.name}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        <Badge tone="muted">{CATEGORY_LABEL[o.category]}</Badge>
                        {o.kind === 'discovery' && <Badge tone="accent">автопоиск</Badge>}
                        {o.warnings.length > 0 && (
                          <span title={o.warnings.join('\n')}>
                            <Badge tone="warn">⚠ {o.warnings.length}</Badge>
                          </span>
                        )}
                      </div>
                      {o.warnings.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs text-warn/90">
                          {o.warnings.map((w) => (
                            <li key={w}>· {w}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="min-w-[180px]">
                      <a href={o.buy.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        {srcName[o.buy.sourceId] ?? o.buy.sourceId} ↗
                      </a>
                      {o.buy.manual && <span className="ml-1 text-xs text-muted">(вручную)</span>}
                      <div className="max-w-[260px] truncate text-xs text-muted" title={o.buy.title}>
                        {o.buy.title}
                      </div>
                    </td>
                    <td className="num text-right">
                      {fmtRub(o.cost)}
                      <div className="text-xs text-muted">
                        {o.buy.currency !== 'RUB' && `${o.buy.price} ${o.buy.currency}`}
                        {o.sourceFeePct > 0 && ` +${o.sourceFeePct}%`}
                      </div>
                    </td>
                    <td className="num text-right">
                      <a href={o.fpUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        {fmtRub(o.sellPrice)}
                      </a>
                      <div className="text-xs text-muted">
                        мин. {fmtRub(o.fpMin)} · {o.fpCount} предл. ({o.fpOnline} онлайн)
                        {o.pricePer !== 1 && ` · за ${o.pricePer} ед.`}
                      </div>
                    </td>
                    <td className={`num text-right font-semibold ${tone}`}>
                      {fmtRub(o.margin.net)}
                      <div className="text-xs font-normal">{fmtPct(o.margin.netPct)}</div>
                    </td>
                    <td className={`num text-right ${tone}`}>{o.margin.roiPct === null ? '—' : fmtPct(o.margin.roiPct)}</td>
                    <td className="whitespace-nowrap text-right text-xs">
                      <button className="text-accent hover:underline" onClick={() => toCalc(o)}>
                        → расчёт
                      </button>
                      {o.kind === 'watch' && !o.buy.manual && (
                        <button
                          className="ml-3 text-muted hover:text-bad"
                          disabled={busy === o.key}
                          title="Не тот товар — больше не учитывать это предложение"
                          onClick={() => hideOffer(o)}
                        >
                          {busy === o.key ? '…' : 'не тот товар'}
                        </button>
                      )}
                      <div className="mt-1 text-muted">{fmtDateTime(o.scannedAt)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 500 && <p className="p-3 text-xs text-muted">Показаны первые 500 — сузь фильтры.</p>}
        </div>
      )}
    </div>
  );
}

function Check({ label, v, set }: { label: string; v: boolean; set: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-muted">
      <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={v} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
}
