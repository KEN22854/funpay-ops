import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, Empty, NumberField, Page, Stat } from '../components/ui';
import { fmtDateTime, fmtInt, fmtPct, fmtRub } from '../lib/format';
import { calcMargin, effectiveWithdrawPct, priceTargets, verdictOf, type DisputeMode } from '../lib/margin';
import { useStore } from '../store/useStore';

const fmtPct2 = (v: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v)} %`;

const DISPUTE_MODES: { id: DisputeMode; label: string; title: string; hint: string }[] = [
  {
    id: 'rub',
    label: '₽',
    title: 'Средняя потеря в ₽ на заказ',
    hint: 'Сумма всех потерь по спорам ÷ число всех заказов. Точная цифра по товару — кнопка «→ расчёт» в журнале.',
  },
  { id: 'percent', label: '% от P', title: 'Потеря в % от цены лота', hint: 'Средняя потеря в процентах от цены лота.' },
  {
    id: 'rate',
    label: 'доля споров',
    title: 'Доля проигранных споров',
    hint: 'R = доля проигранных споров × доля возврата × выплата. Закупка C при этом уже потрачена — она в формуле отдельно.',
  },
];

const VERDICT_TEXT = {
  good: 'Сделка в плюсе выше твоего порога',
  warn: 'В плюсе, но ниже твоего порога маржи',
  bad: 'Убыток — сделка не окупается',
} as const;

export default function Calculator() {
  const draft = useStore((s) => s.calcDraft);
  const set = useStore((s) => s.setCalcDraft);
  const reset = useStore((s) => s.resetCalcDraft);
  const threshold = useStore((s) => s.settings.warnThresholdPct);
  const calcs = useStore((s) => s.calcs);
  const saveCalc = useStore((s) => s.saveCalc);
  const removeCalc = useStore((s) => s.removeCalc);
  const loadCalc = useStore((s) => s.loadCalc);
  const [name, setName] = useState('');
  const [showY, setShowY] = useState(false);
  const [yCalc, setYCalc] = useState({ amount: 0, pct: 0, fixed: 0 });
  const effY = effectiveWithdrawPct(yCalc.amount, yCalc.pct, yCalc.fixed);

  const r = useMemo(() => calcMargin(draft), [draft]);
  const targets = useMemo(() => priceTargets(draft), [draft]);
  const verdict = verdictOf(r.netPct, r.net, threshold);
  const hasInput = r.price > 0;

  const chart = [
    { k: 'Комиссия X', v: r.platformFee, c: 'rgb(var(--muted))' },
    { k: 'Вывод Y', v: r.withdrawFee, c: 'rgb(var(--muted))' },
    { k: 'Закупка C', v: r.cost, c: 'rgb(var(--accent))' },
    { k: 'Споры R', v: r.disputeLoss, c: 'rgb(var(--warn))' },
    { k: 'Время T', v: r.timeCost, c: 'rgb(var(--warn))' },
    { k: 'Маржа', v: r.net, c: r.net >= 0 ? 'rgb(var(--good))' : 'rgb(var(--bad))' },
  ];

  const tone = verdict === 'good' ? 'good' : verdict === 'warn' ? 'warn' : 'bad';

  return (
    <Page
      title="Калькулятор маржи"
      subtitle={
        <>
          <span className="num">Маржа = P × (1 − X%) × (1 − Y%) − C − R − T</span>. Комиссия площадки и вывода перемножаются: X берётся с суммы заказа, Y — с
          остатка.
        </>
      }
      actions={
        <button className="btn-ghost" onClick={reset}>
          Очистить поля
        </button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <Card title="Входные данные">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label="P — цена лота" suffix="₽" value={draft.price} onChange={(v) => set({ price: v })} hint="Сколько платит покупатель" />
            <NumberField label="C — закупка" suffix="₽" value={draft.cost} onChange={(v) => set({ cost: v })} hint="Себестоимость одной единицы" />
            <NumberField
              label="X — комиссия площадки"
              suffix="%"
              value={draft.platformFeePct}
              onChange={(v) => set({ platformFeePct: Math.min(99.99, v) })}
              hint="Проверь актуальную комиссию в своём разделе"
            />
            <div>
              <NumberField
                label="Y — стоимость вывода"
                suffix="%"
                value={draft.withdrawFeePct}
                onChange={(v) => set({ withdrawFeePct: Math.min(99.99, v) })}
                hint={
                  <button type="button" className="text-accent hover:underline" onClick={() => setShowY((v) => !v)}>
                    {showY ? 'Скрыть расчёт' : 'Посчитать с фикс. платой'}
                  </button>
                }
              />
            </div>

            {showY && (
              <div className="rounded-lg border border-line bg-raised/40 p-3 sm:col-span-2">
                <p className="mb-3 text-xs text-muted">
                  Эффективный Y = 1 − (S × (1 − p) − F) ÷ S. Фиксированная плата за вывод сильнее бьёт по маленьким суммам — считай по сумме, которую реально
                  выводишь за раз.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <NumberField label="Сумма вывода S" suffix="₽" value={yCalc.amount} onChange={(v) => setYCalc((s) => ({ ...s, amount: v }))} />
                  <NumberField label="Комиссия p" suffix="%" value={yCalc.pct} onChange={(v) => setYCalc((s) => ({ ...s, pct: v }))} />
                  <NumberField label="Фикс. плата F" suffix="₽" value={yCalc.fixed} onChange={(v) => setYCalc((s) => ({ ...s, fixed: v }))} />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm">
                    Эффективный Y: <span className="num font-semibold">{effY === null ? '—' : fmtPct2(effY)}</span>
                  </span>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={effY === null}
                    onClick={() => effY !== null && set({ withdrawFeePct: Math.round(effY * 100) / 100 })}
                  >
                    Подставить в Y
                  </button>
                </div>
              </div>
            )}

            <div className="sm:col-span-2">
              <span className="label">R — потери на возвратах и спорах (на заказ)</span>
              <div className="flex gap-2">
                <div className="flex-1">
                  <NumberField
                    label=""
                    suffix={draft.disputeMode === 'rub' ? '₽' : draft.disputeMode === 'percent' ? '% от P' : '% заказов'}
                    value={draft.disputeValue}
                    onChange={(v) => set({ disputeValue: draft.disputeMode === 'rub' ? v : Math.min(100, v) })}
                  />
                </div>
                <div className="mt-1 flex rounded-lg border border-line bg-raised p-0.5 text-xs">
                  {DISPUTE_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      title={m.title}
                      className={`rounded-md px-3 ${draft.disputeMode === m.id ? 'bg-accent text-white' : 'text-muted'}`}
                      onClick={() => set({ disputeMode: m.id })}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              {draft.disputeMode === 'rate' && (
                <div className="mt-3">
                  <NumberField
                    label="Сколько теряешь в споре"
                    suffix="% выплаты"
                    value={draft.disputeRefundPct}
                    onChange={(v) => set({ disputeRefundPct: Math.min(100, v) })}
                    hint="100 % — полный возврат: деньги ушли покупателю, товар уже выдан (закупка C учтена отдельно)"
                  />
                </div>
              )}
              <span className="mt-1 block text-xs text-muted">{DISPUTE_MODES.find((m) => m.id === draft.disputeMode)?.hint}</span>
            </div>

            <NumberField label="T — минут на заказ" suffix="мин" value={draft.minutesPerOrder} onChange={(v) => set({ minutesPerOrder: v })} />
            <NumberField label="T — ставка часа" suffix="₽/ч" value={draft.hourlyRate} onChange={(v) => set({ hourlyRate: v })} />
            <NumberField
              label="Стартовые вложения"
              suffix="₽"
              value={draft.investment}
              onChange={(v) => set({ investment: v })}
              hint="Софт, подписки, разовые траты — то, что нужно отбить"
            />
            <NumberField
              label="Цель прибыли в месяц"
              suffix="₽"
              value={draft.monthlyGoal}
              onChange={(v) => set({ monthlyGoal: v })}
              hint="Сколько заказов нужно продать"
            />
          </div>
        </Card>

        <div className="space-y-6">
          <Card
            title="Результат на один заказ"
            right={hasInput && <Badge tone={tone}>{verdict === 'good' ? 'Зелёный' : verdict === 'warn' ? 'Жёлтый' : 'Красный'}</Badge>}
          >
            {!hasInput ? (
              <Empty>Введи цену лота P, чтобы получить расчёт.</Empty>
            ) : (
              <div className="space-y-4">
                <motion.div
                  key={verdict}
                  initial={{ opacity: 0.4 }}
                  animate={{ opacity: 1 }}
                  className={`rounded-lg border p-4 ${
                    tone === 'good' ? 'border-good/40 bg-good/10' : tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-bad/40 bg-bad/10'
                  }`}
                >
                  <div className="text-xs text-muted">Чистая маржа</div>
                  <div className={`num text-3xl font-semibold text-${tone}`}>{fmtRub(r.net)}</div>
                  <div className="mt-1 text-sm">
                    <span className="num">{fmtPct(r.netPct)}</span> от цены · {VERDICT_TEXT[verdict]}
                    <span className="text-muted"> (порог {fmtPct(threshold)})</span>
                  </div>
                </motion.div>

                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Выплата после X и Y" value={fmtRub(r.payout)} />
                  <Stat label="ROI на закупку" value={r.roiPct === null ? '—' : fmtPct(r.roiPct)} />
                  <Stat
                    label="Заказов до окупаемости"
                    value={r.breakEvenOrders === null ? '—' : fmtInt(r.breakEvenOrders)}
                    sub={draft.investment <= 0 ? 'введи вложения' : r.net <= 0 ? 'не окупится' : `вложения ${fmtRub(draft.investment)}`}
                    tone={draft.investment > 0 && r.net <= 0 ? 'bad' : undefined}
                  />
                  <Stat
                    label="Заказов в месяц для цели"
                    value={r.ordersForMonthlyGoal === null ? '—' : fmtInt(r.ordersForMonthlyGoal)}
                    sub={
                      draft.monthlyGoal <= 0
                        ? 'введи цель'
                        : r.net <= 0
                          ? 'недостижимо при убытке'
                          : `≈ ${fmtInt(Math.ceil(r.ordersForMonthlyGoal! / 30))} в день · оборот ${fmtRub(r.ordersForMonthlyGoal! * r.price)}`
                    }
                    tone={draft.monthlyGoal > 0 && r.net <= 0 ? 'bad' : undefined}
                  />
                </div>

                <table className="table">
                  <tbody>
                    <Row k="P — цена лота" v={r.price} />
                    <Row k={`− комиссия площадки (${fmtPct(draft.platformFeePct)} от P)`} v={-r.platformFee} />
                    <Row k={`− вывод (${fmtPct(draft.withdrawFeePct)} от остатка)`} v={-r.withdrawFee} />
                    <Row k="− C — закупка" v={-r.cost} />
                    <Row k="− R — споры и возвраты" v={-r.disputeLoss} />
                    <Row k={`− T — время (${draft.minutesPerOrder} мин × ${draft.hourlyRate} ₽/ч)`} v={-r.timeCost} />
                    <tr>
                      <td className="font-semibold">= Маржа</td>
                      <td className={`num text-right font-semibold text-${tone}`}>{fmtRub(r.net)}</td>
                    </tr>
                  </tbody>
                </table>

                {Math.abs(r.additionError) >= 0.005 && (
                  <p className="text-xs text-muted">
                    Если ошибочно сложить X + Y, получится <span className="num">{fmtRub(r.netIfAdded)}</span> — занижение на{' '}
                    <span className="num">{fmtRub(r.additionError)}</span> на каждом заказе.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="Какую цену ставить">
            <p className="mb-4 text-xs text-muted">
              Обратный расчёт по тем же C, X, Y, R, T. Цена округлена вверх до копейки — цель выполняется гарантированно.
            </p>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <NumberField label="Целевая маржа" suffix="% от P" value={draft.targetMarginPct} onChange={(v) => set({ targetMarginPct: Math.min(99, v) })} />
              <NumberField label="Целевая маржа" suffix="₽ / заказ" value={draft.targetMarginRub} onChange={(v) => set({ targetMarginRub: v })} />
            </div>
            <table className="table">
              <tbody>
                <TargetRow
                  label="Минимальная цена (маржа = 0)"
                  price={targets.breakEvenPrice}
                  current={r.price}
                  onApply={(p) => set({ price: p })}
                  empty="недостижимо: комиссии и споры съедают всю цену"
                />
                <TargetRow
                  label={`Цена под ${fmtPct(draft.targetMarginPct)} маржи`}
                  price={targets.priceForPct}
                  current={r.price}
                  onApply={(p) => set({ price: p })}
                  empty={draft.targetMarginPct > 0 ? `недостижимо: максимум ${fmtPct(targets.maxPossiblePct)} при любой цене` : 'введи целевой %'}
                />
                <TargetRow
                  label={`Цена под ${fmtRub(draft.targetMarginRub)} с заказа`}
                  price={targets.priceForRub}
                  current={r.price}
                  onApply={(p) => set({ price: p })}
                  empty={draft.targetMarginRub > 0 ? 'недостижимо при этих комиссиях' : 'введи целевую сумму'}
                />
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted">
              Потолок маржи при этих комиссиях и спорах — <span className="num">{fmtPct(targets.maxPossiblePct)}</span> от цены (даже при бесплатной закупке).
            </p>
          </Card>

          {hasInput && (
            <Card title="Куда уходит цена лота">
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ left: 8, right: 8 }}>
                    <XAxis dataKey="k" tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                    <Tooltip
                      cursor={{ fill: 'rgb(var(--raised))' }}
                      contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))', borderRadius: 8 }}
                      labelStyle={{ color: 'rgb(var(--fg))' }}
                      itemStyle={{ color: 'rgb(var(--fg))' }}
                      formatter={(v: number) => [fmtRub(v), '']}
                    />
                    <Bar dataKey="v" radius={[4, 4, 0, 0]}>
                      {chart.map((d) => (
                        <Cell key={d.k} fill={d.c} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
        </div>
      </div>

      <Card title="Сохранённые расчёты">
        <form
          className="mb-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !hasInput) return;
            saveCalc(name, r);
            setName('');
          }}
        >
          <input className="input max-w-sm flex-1" placeholder="Название товара" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" disabled={!name.trim() || !hasInput}>
            Сохранить текущий расчёт
          </button>
        </form>
        {calcs.length === 0 ? (
          <Empty>Сохранённых расчётов пока нет.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Товар</th>
                  <th className="text-right">P</th>
                  <th className="text-right">C</th>
                  <th className="text-right">X / Y</th>
                  <th className="text-right">Маржа</th>
                  <th className="text-right">%</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {calcs.map((c) => {
                  const v = verdictOf(c.netPct, c.net, threshold);
                  return (
                    <tr key={c.id}>
                      <td className="num whitespace-nowrap text-muted">{fmtDateTime(c.createdAt)}</td>
                      <td>{c.name}</td>
                      <td className="num text-right">{fmtRub(c.input.price)}</td>
                      <td className="num text-right">{fmtRub(c.input.cost)}</td>
                      <td className="num text-right text-muted">
                        {c.input.platformFeePct} / {c.input.withdrawFeePct}
                      </td>
                      <td className={`num text-right text-${v}`}>{fmtRub(c.net)}</td>
                      <td className={`num text-right text-${v}`}>{fmtPct(c.netPct)}</td>
                      <td className="whitespace-nowrap text-right">
                        <button className="text-xs text-accent hover:underline" onClick={() => loadCalc(c.id)}>
                          Открыть
                        </button>
                        <button className="ml-3 text-xs text-bad hover:underline" onClick={() => removeCalc(c.id)}>
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
    </Page>
  );
}

function TargetRow({
  label,
  price,
  current,
  onApply,
  empty,
}: {
  label: string;
  price: number | null;
  current: number;
  onApply: (p: number) => void;
  empty: string;
}) {
  return (
    <tr>
      <td className="text-muted">{label}</td>
      {price === null ? (
        <td colSpan={2} className="text-right text-xs text-muted">
          {empty}
        </td>
      ) : (
        <>
          <td className={`num text-right font-semibold ${current > 0 && current < price ? 'text-warn' : ''}`}>{fmtRub(price)}</td>
          <td className="w-24 text-right">
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => onApply(price)} disabled={Math.abs(current - price) < 0.005}>
              {Math.abs(current - price) < 0.005 ? 'текущая' : 'в P'}
            </button>
          </td>
        </>
      )}
    </tr>
  );
}

function Row({ k, v }: { k: string; v: number }) {
  return (
    <tr>
      <td className="text-muted">{k}</td>
      <td className="num text-right">{fmtRub(v)}</td>
    </tr>
  );
}
