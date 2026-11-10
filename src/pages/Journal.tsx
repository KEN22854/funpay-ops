import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, Empty, NumberField, Page, Stat } from '../components/ui';
import { fmtDate, fmtPct, fmtRub, parseNum, todayISO } from '../lib/format';
import { dealDisputeLoss, dealPayout, dealResult, isDisputed, isLost, itemStats, type DisputeOutcome } from '../lib/margin';
import { downloadText } from '../lib/storage';
import { normalizeDeal, useStore, type Deal } from '../store/useStore';

type Form = Omit<Deal, 'id'>;
type Period = 'all' | '7' | '30' | 'month' | 'prevMonth';

const OUTCOME_LABEL: Record<DisputeOutcome, string> = {
  none: 'Без спора',
  won: 'Спор выигран',
  refund: 'Полный возврат',
  partial: 'Частичный возврат',
};
const OUTCOME_HINT: Record<DisputeOutcome, string> = {
  none: '',
  won: 'Деньги получены — итог как у обычной сделки, но сделка учитывается в доле споров.',
  refund: 'Деньги вернулись покупателю, выплаты нет. Итог = −закупка (товар уже выдан).',
  partial: 'Укажи, сколько ₽ ты недополучил из-за спора.',
};

const PERIOD_LABEL: Record<Period, string> = {
  all: 'Всё время',
  '7': '7 дней',
  '30': '30 дней',
  month: 'Этот месяц',
  prevMonth: 'Прошлый месяц',
};

function inPeriod(dateISO: string, p: Period): boolean {
  if (p === 'all') return true;
  const d = new Date(dateISO + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === '7' || p === '30') {
    const from = new Date(today);
    from.setDate(from.getDate() - (Number(p) - 1));
    return d >= from && d <= today;
  }
  if (p === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return d.getFullYear() === pm.getFullYear() && d.getMonth() === pm.getMonth();
}

const CSV_HEAD = ['date', 'item', 'qty', 'buy', 'sell', 'feePct', 'withdrawPct', 'outcome', 'disputeLoss', 'result', 'note'];

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export default function Journal() {
  const deals = useStore((s) => s.deals);
  const settings = useStore((s) => s.settings);
  const addDeal = useStore((s) => s.addDeal);
  const updateDeal = useStore((s) => s.updateDeal);
  const removeDeal = useStore((s) => s.removeDeal);
  const importDeals = useStore((s) => s.importDeals);
  const setCalcDraft = useStore((s) => s.setCalcDraft);
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const [importMsg, setImportMsg] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const blank = (): Form => ({
    date: todayISO(),
    item: '',
    qty: 1,
    buy: 0,
    sell: 0,
    feePct: settings.defaultFeePct,
    withdrawPct: settings.defaultWithdrawPct,
    outcome: 'none',
    disputeLoss: 0,
    note: '',
  });
  const [f, setF] = useState<Form>(blank);
  const upd = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const preview = dealResult(f);
  const canSubmit = f.item.trim().length > 0 && f.sell > 0 && !!f.date;

  /** сделки за период (без фильтра по товару) — для аналитики по товарам */
  const periodDeals = useMemo(() => deals.filter((d) => inPeriod(d.date, period)), [deals, period]);
  /** то, что видно в таблице и в сводке */
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? periodDeals.filter((d) => d.item.toLowerCase().includes(q)) : periodDeals;
    return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [periodDeals, filter]);

  const totals = useMemo(() => {
    let revenue = 0;
    let payout = 0;
    let cost = 0;
    let net = 0;
    let disputes = 0;
    let lost = 0;
    let lossSum = 0;
    for (const d of visible) {
      revenue += d.sell;
      payout += dealPayout(d);
      cost += d.buy;
      net += dealResult(d);
      lossSum += dealDisputeLoss(d);
      if (isDisputed(d.outcome)) disputes++;
      if (isLost(d.outcome)) lost++;
    }
    const count = visible.length;
    return {
      count,
      revenue,
      fees: revenue - payout,
      cost,
      net,
      netPct: revenue > 0 ? (net / revenue) * 100 : 0,
      disputes,
      lost,
      lossSum,
      disputeRate: count ? (disputes / count) * 100 : 0,
      lostRate: count ? (lost / count) * 100 : 0,
    };
  }, [visible]);

  const byItem = useMemo(() => itemStats(periodDeals), [periodDeals]);
  const allItems = useMemo(() => [...new Set(deals.map((d) => d.item))].sort(), [deals]);
  const losers = byItem.filter((x) => x.net < 0);

  const toCalculator = (item: string) => {
    const s = byItem.find((x) => x.item === item);
    if (!s) return;
    // всё в расчёте на 1 штуку
    setCalcDraft({
      price: Math.round((s.revenue / s.qty) * 100) / 100,
      cost: Math.round((s.cost / s.qty) * 100) / 100,
      platformFeePct: Math.round(s.avgFeePct * 100) / 100,
      withdrawFeePct: Math.round(s.avgWithdrawPct * 100) / 100,
      disputeMode: 'rub',
      disputeValue: Math.round((s.disputeLossTotal / s.qty) * 100) / 100,
    });
    navigate('/calculator');
  };

  const startEdit = (d: Deal) => {
    const { id, ...rest } = d;
    setEditingId(id);
    setF(rest);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setF(blank());
  };

  const submit = () => {
    if (!canSubmit) return;
    if (editingId) {
      updateDeal(editingId, f);
      setEditingId(null);
      setF(blank());
    } else {
      addDeal(f);
      // оставляем дату и комиссии — следующая сделка чаще всего из того же дня и раздела
      setF({ ...blank(), date: f.date, feePct: f.feePct, withdrawPct: f.withdrawPct });
    }
  };

  const exportCsv = () => {
    const lines = [
      CSV_HEAD.join(';'),
      ...deals.map((d) =>
        [d.date, d.item, d.qty, d.buy, d.sell, d.feePct, d.withdrawPct, d.outcome, d.disputeLoss, dealResult(d).toFixed(2), d.note].map(csvCell).join(';'),
      ),
    ];
    downloadText(`funpay-journal-${todayISO()}.csv`, '﻿' + lines.join('\n'), 'text/csv');
  };

  const onImport = async (file: File) => {
    const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
    const [head, ...body] = rows;
    const idx = (k: string) => (head ?? []).findIndex((h) => h.trim() === k);
    if (!head || idx('date') < 0 || idx('sell') < 0) {
      setImportMsg('Не тот формат: ожидается CSV, выгруженный из этого журнала (разделитель «;»).');
      return;
    }
    const get = (r: string[], k: string) => (idx(k) >= 0 ? (r[idx(k)] ?? '').trim() : '');
    const keys = new Set(deals.map((d) => `${d.date}|${d.item}|${d.sell}|${d.buy}`));
    let skipped = 0;
    const parsed: Deal[] = [];
    for (const r of body) {
      // совместимость с v1: колонка dispute = 1/0
      let outcome = get(r, 'outcome') as DisputeOutcome;
      const loss = parseNum(get(r, 'disputeLoss'));
      if (!outcome) outcome = get(r, 'dispute') === '1' ? (loss > 0 ? 'partial' : 'won') : 'none';
      const d = normalizeDeal({
        date: /^\d{4}-\d{2}-\d{2}$/.test(get(r, 'date')) ? get(r, 'date') : todayISO(),
        item: get(r, 'item'),
        qty: parseNum(get(r, 'qty')) || 1,
        buy: parseNum(get(r, 'buy')),
        sell: parseNum(get(r, 'sell')),
        feePct: parseNum(get(r, 'feePct')),
        withdrawPct: parseNum(get(r, 'withdrawPct')),
        outcome,
        disputeLoss: loss,
        note: get(r, 'note'),
      });
      const key = `${d.date}|${d.item}|${d.sell}|${d.buy}`;
      if (!d.item || d.sell <= 0 || keys.has(key)) {
        skipped++;
        continue;
      }
      keys.add(key);
      parsed.push(d);
    }
    importDeals(parsed);
    setImportMsg(`Импортировано сделок: ${parsed.length}${skipped ? `, пропущено (дубли или пустые): ${skipped}` : ''}`);
  };

  return (
    <Page
      title="Журнал сделок"
      subtitle="Ручной учёт. Итог = продажа × (1 − комиссия) × (1 − вывод) − закупка, с поправкой на исход спора. Суммы — за всю сделку."
      actions={
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
            Импорт CSV
          </button>
          <button className="btn-ghost" onClick={exportCsv} disabled={!deals.length}>
            Экспорт CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImport(file);
              e.target.value = '';
            }}
          />
        </div>
      }
    >
      {importMsg && <p className="text-sm text-muted">{importMsg}</p>}

      <div ref={formRef}>
        <Card
          title={editingId ? 'Редактирование сделки' : 'Новая сделка'}
          right={
            editingId && (
              <button className="text-xs text-muted hover:text-fg" onClick={cancelEdit}>
                Отменить
              </button>
            )
          }
          className={editingId ? 'border-accent/60' : ''}
        >
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="block">
              <span className="label">Дата</span>
              <input type="date" className="input num" value={f.date} max={todayISO()} onChange={(e) => upd({ date: e.target.value })} />
            </label>
            <label className="block sm:col-span-1 lg:col-span-2">
              <span className="label">Товар</span>
              <input className="input" value={f.item} onChange={(e) => upd({ item: e.target.value })} placeholder="Как называешь товар у себя" list="journal-items" />
              <datalist id="journal-items">
                {allItems.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
            </label>
            <NumberField label="Количество" suffix="шт" value={f.qty} min={1} onChange={(v) => upd({ qty: Math.max(1, Math.floor(v)) })} />
            <NumberField label="Закупка (за сделку)" suffix="₽" value={f.buy} onChange={(v) => upd({ buy: v })} />
            <NumberField label="Продажа (за сделку)" suffix="₽" value={f.sell} onChange={(v) => upd({ sell: v })} hint="Сколько заплатил покупатель" />
            <NumberField label="Комиссия площадки" suffix="%" value={f.feePct} onChange={(v) => upd({ feePct: Math.min(100, v) })} />
            <NumberField label="Вывод" suffix="%" value={f.withdrawPct} onChange={(v) => upd({ withdrawPct: Math.min(100, v) })} />

            <label className="block lg:col-span-2">
              <span className="label">Спор</span>
              <select className="input" value={f.outcome} onChange={(e) => upd({ outcome: e.target.value as DisputeOutcome })}>
                {(Object.keys(OUTCOME_LABEL) as DisputeOutcome[]).map((o) => (
                  <option key={o} value={o}>
                    {OUTCOME_LABEL[o]}
                  </option>
                ))}
              </select>
              {OUTCOME_HINT[f.outcome] && <span className="mt-1 block text-xs text-muted">{OUTCOME_HINT[f.outcome]}</span>}
            </label>
            {f.outcome === 'partial' ? (
              <NumberField label="Потеря по спору" suffix="₽" value={f.disputeLoss} onChange={(v) => upd({ disputeLoss: v })} />
            ) : (
              <label className="block">
                <span className="label">Заметка</span>
                <input className="input" value={f.note} onChange={(e) => upd({ note: e.target.value })} />
              </label>
            )}
            <div className="flex items-end justify-between gap-3">
              <div>
                <span className="label">Итог</span>
                <span className={`num text-lg font-semibold ${preview >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(preview)}</span>
                {f.qty > 1 && <span className="num block text-xs text-muted">{fmtRub(preview / f.qty)} / шт</span>}
              </div>
              <button className="btn-primary" disabled={!canSubmit}>
                {editingId ? 'Сохранить' : 'Добавить'}
              </button>
            </div>
            {f.outcome === 'partial' && (
              <label className="block sm:col-span-2 lg:col-span-4">
                <span className="label">Заметка</span>
                <input className="input" value={f.note} onChange={(e) => upd({ note: e.target.value })} />
              </label>
            )}
          </form>
        </Card>
      </div>

      {deals.length === 0 ? (
        <Empty>Журнал пуст. Добавь первую сделку — сводка и анализ по товарам появятся здесь.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <button
                key={p}
                className={`rounded-md px-3 py-1.5 ${period === p ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label={filter ? 'Сделок (фильтр)' : 'Сделок'} value={totals.count} />
            <Stat label="Оборот" value={fmtRub(totals.revenue)} />
            <Stat label="Комиссии X+Y" value={fmtRub(totals.fees)} sub={totals.revenue ? fmtPct((totals.fees / totals.revenue) * 100) : undefined} />
            <Stat label="Закупка" value={fmtRub(totals.cost)} />
            <Stat label="Чистая маржа" value={fmtRub(totals.net)} tone={totals.net >= 0 ? 'good' : 'bad'} sub={fmtPct(totals.netPct) + ' от оборота'} />
            <Stat
              label="Споры"
              value={fmtPct(totals.disputeRate)}
              sub={`${totals.disputes} из ${totals.count}, проиграно ${totals.lost} (−${fmtRub(totals.lossSum)})`}
              tone={totals.lost ? 'warn' : undefined}
            />
          </div>

          {byItem.length === 0 ? (
            <Empty>За выбранный период сделок нет.</Empty>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card title="Маржа по товарам" right={losers.length > 0 && <Badge tone="bad">Убыточных: {losers.length}</Badge>}>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Товар</th>
                        <th className="text-right">Шт</th>
                        <th className="text-right">Споры</th>
                        <th className="text-right">Маржа</th>
                        <th className="text-right">%</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {byItem.map((x) => (
                        <tr key={x.item} className={x.net < 0 ? 'bg-bad/5' : ''}>
                          <td>
                            {x.item} {x.net < 0 && <Badge tone="bad">убыток</Badge>}
                            <div className="num text-xs text-muted">
                              {x.count} сд. · {fmtRub(x.net / x.qty)}/шт
                            </div>
                          </td>
                          <td className="num text-right">{x.qty}</td>
                          <td className="num text-right" title={`Проиграно: ${x.lost}, потери ${fmtRub(x.disputeLossTotal)}`}>
                            {x.disputes}
                            {x.lost > 0 && <span className="text-warn"> ({x.lost})</span>}
                          </td>
                          <td className={`num text-right ${x.net >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(x.net)}</td>
                          <td className={`num text-right ${x.net >= 0 ? 'text-good' : 'text-bad'}`}>{fmtPct(x.netPct)}</td>
                          <td className="text-right">
                            <button className="whitespace-nowrap text-xs text-accent hover:underline" onClick={() => toCalculator(x.item)} title="Подставить средние цифры товара в калькулятор">
                              → расчёт
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-muted">
                  «→ расчёт» переносит в калькулятор средние цифры товара на 1 шт, а R — фактическую потерю на спорах по журналу.
                </p>
              </Card>
              <Card title="График маржи по товарам">
                <div style={{ height: Math.max(160, byItem.length * 32) }}>
                  <ResponsiveContainer>
                    <BarChart data={byItem} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <XAxis
                        type="number"
                        domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                        tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis type="category" dataKey="item" width={110} tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        cursor={{ fill: 'rgb(var(--raised))' }}
                        contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))', borderRadius: 8 }}
                        labelStyle={{ color: 'rgb(var(--fg))' }}
                        itemStyle={{ color: 'rgb(var(--fg))' }}
                        formatter={(v: number) => [fmtRub(v), 'Маржа']}
                      />
                      <Bar dataKey="net" radius={[0, 4, 4, 0]}>
                        {byItem.map((x) => (
                          <Cell key={x.item} fill={x.net >= 0 ? 'rgb(var(--good))' : 'rgb(var(--bad))'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>
          )}

          <Card title="Сделки" right={<input className="input w-56" placeholder="Фильтр по товару" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
            {visible.length === 0 ? (
              <Empty>Нет сделок под фильтр.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Товар</th>
                      <th className="text-right">Шт</th>
                      <th className="text-right">Закупка</th>
                      <th className="text-right">Продажа</th>
                      <th className="text-right">Ком. / вывод</th>
                      <th>Спор</th>
                      <th className="text-right">Итог</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((d) => {
                      const res = dealResult(d);
                      return (
                        <tr key={d.id} className={editingId === d.id ? 'bg-accent/10' : ''}>
                          <td className="num whitespace-nowrap text-muted">{fmtDate(d.date)}</td>
                          <td>
                            {d.item}
                            {d.note && <div className="text-xs text-muted">{d.note}</div>}
                          </td>
                          <td className="num text-right">{d.qty}</td>
                          <td className="num text-right">{fmtRub(d.buy)}</td>
                          <td className="num text-right">{fmtRub(d.sell)}</td>
                          <td className="num text-right text-muted">
                            {d.feePct}% / {d.withdrawPct}%
                          </td>
                          <td className="whitespace-nowrap">
                            {d.outcome === 'none' ? (
                              <span className="text-muted">—</span>
                            ) : (
                              <Badge tone={d.outcome === 'won' ? 'muted' : 'warn'}>
                                {OUTCOME_LABEL[d.outcome]}
                                {d.outcome === 'partial' && ` −${fmtRub(d.disputeLoss)}`}
                              </Badge>
                            )}
                          </td>
                          <td className={`num text-right font-medium ${res >= 0 ? 'text-good' : 'text-bad'}`}>{fmtRub(res)}</td>
                          <td className="whitespace-nowrap text-right">
                            <button className="text-xs text-accent hover:underline" onClick={() => startEdit(d)}>
                              Изменить
                            </button>
                            <button
                              className="ml-3 text-xs text-bad hover:underline"
                              onClick={() => {
                                if (confirm(`Удалить сделку «${d.item}» от ${fmtDate(d.date)}?`)) {
                                  removeDeal(d.id);
                                  if (editingId === d.id) cancelEdit();
                                }
                              }}
                            >
                              Удалить
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
