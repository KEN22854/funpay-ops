import { Card, NumberField } from '../../components/ui';
import { DEFAULT_ARB } from '../../lib/arbitrage';
import { useStore } from '../../store/useStore';

export function Params() {
  const a = useStore((s) => s.arb);
  const set = useStore((s) => s.setArb);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Цена продажи на FunPay">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Подрезка" suffix="%" value={a.undercutPct} onChange={(v) => set({ undercutPct: Math.min(90, v) })} hint="Ниже минимальной цены конкурента" />
          <NumberField label="Подрезка" suffix="₽" value={a.undercutRub} onChange={(v) => set({ undercutRub: v })} hint="Применяется после %" />
          <NumberField label="Мин. число конкурентов" value={a.minCompetitors} onChange={(v) => set({ minCompetitors: Math.floor(v) })} hint="Меньше — пометка о низкой ликвидности" />
          <NumberField label="Ручная цена устаревает через" suffix="ч" value={a.manualMaxAgeH} onChange={(v) => set({ manualMaxAgeH: v })} />
          <NumberField
            label="«Подозрительно дёшево», если закупка <"
            suffix="% цены FunPay"
            value={a.suspiciousPct}
            onChange={(v) => set({ suspiciousPct: Math.min(100, v) })}
            hint="0 — выключить. Ловит аккаунты, аренду и наборы, попавшие в поиск"
          />
        </div>
      </Card>
      <Card title="Комиссии и потери (формула калькулятора)">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="X — комиссия FunPay" suffix="%" value={a.sellFeePct} onChange={(v) => set({ sellFeePct: Math.min(99, v) })} hint="Проверь в своём разделе — у разных разделов она разная" />
          <NumberField label="Y — вывод" suffix="%" value={a.withdrawPct} onChange={(v) => set({ withdrawPct: Math.min(99, v) })} />
          <NumberField label="R — потери на спорах" suffix="% от цены" value={a.disputePct} onChange={(v) => set({ disputePct: Math.min(100, v) })} hint="Фактическая цифра — в журнале, кнопка «→ расчёт»" />
          <div />
          <NumberField label="T — минут на заказ" suffix="мин" value={a.minutesPerOrder} onChange={(v) => set({ minutesPerOrder: v })} />
          <NumberField label="T — ставка часа" suffix="₽/ч" value={a.hourlyRate} onChange={(v) => set({ hourlyRate: v })} />
        </div>
        <button className="btn-ghost mt-4 text-xs" onClick={() => set({ ...DEFAULT_ARB, sourceFees: a.sourceFees })}>
          Сбросить к значениям по умолчанию
        </button>
      </Card>
    </div>
  );
}
