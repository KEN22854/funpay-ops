import { describe, expect, it } from 'vitest';
import {
  calcMargin,
  dealDisputeLoss,
  dealResult,
  effectiveWithdrawPct,
  itemStats,
  priceTargets,
  verdictOf,
  type MarginInput,
} from './margin';

const base: MarginInput = {
  price: 1000,
  platformFeePct: 5,
  withdrawFeePct: 3,
  cost: 600,
  disputeValue: 20,
  disputeMode: 'rub',
  disputeRefundPct: 100,
  minutesPerOrder: 6,
  hourlyRate: 300,
  investment: 3000,
  targetMarginPct: 10,
  targetMarginRub: 100,
  monthlyGoal: 10000,
};

describe('calcMargin', () => {
  it('перемножает X и Y, а не складывает', () => {
    const r = calcMargin(base);
    expect(r.payout).toBeCloseTo(1000 * 0.95 * 0.97, 10); // 921.5
    expect(r.timeCost).toBeCloseTo(30, 10);
    expect(r.net).toBeCloseTo(921.5 - 600 - 20 - 30, 10); // 271.5
    expect(r.netPct).toBeCloseTo(27.15, 10);
    expect(r.netIfAdded).toBeCloseTo(920 - 650, 10);
    expect(r.additionError).toBeCloseTo(1.5, 10);
  });

  it('окупаемость и цель по месяцу округляются вверх, точное деление не даёт лишний заказ', () => {
    const r = calcMargin(base);
    expect(r.breakEvenOrders).toBe(Math.ceil(3000 / 271.5)); // 12
    expect(r.ordersForMonthlyGoal).toBe(Math.ceil(10000 / 271.5)); // 37
    const exact = calcMargin({ ...base, platformFeePct: 0, withdrawFeePct: 0, cost: 0, disputeValue: 0, minutesPerOrder: 0, price: 100, investment: 300 });
    expect(exact.breakEvenOrders).toBe(3);
  });

  it('при убытке окупаемость и цель недостижимы', () => {
    const r = calcMargin({ ...base, cost: 2000 });
    expect(r.net).toBeLessThan(0);
    expect(r.breakEvenOrders).toBeNull();
    expect(r.ordersForMonthlyGoal).toBeNull();
  });

  it('R в % от P', () => {
    const r = calcMargin({ ...base, disputeMode: 'percent', disputeValue: 2 });
    expect(r.disputeLoss).toBeCloseTo(20, 10);
  });

  it('R по доле споров = доля × доля возврата × выплата', () => {
    const r = calcMargin({ ...base, disputeMode: 'rate', disputeValue: 4, disputeRefundPct: 50 });
    expect(r.disputeLoss).toBeCloseTo(921.5 * 0.04 * 0.5, 10);
  });

  it('отрицательные и мусорные значения не ломают расчёт', () => {
    const r = calcMargin({ ...base, price: -5, cost: NaN, platformFeePct: 250 });
    expect(r.price).toBe(0);
    expect(Number.isFinite(r.net)).toBe(true);
    expect(r.netPct).toBe(0);
  });
});

describe('priceTargets', () => {
  const modes: MarginInput[] = [
    base,
    { ...base, disputeMode: 'percent', disputeValue: 3 },
    { ...base, disputeMode: 'rate', disputeValue: 5, disputeRefundPct: 100 },
  ];

  it.each(modes)('найденные цены действительно дают целевую маржу (режим $disputeMode)', (m) => {
    const t = priceTargets(m);
    expect(t.breakEvenPrice).not.toBeNull();
    const be = calcMargin({ ...m, price: t.breakEvenPrice! });
    expect(be.net).toBeGreaterThanOrEqual(-1e-9);
    expect(calcMargin({ ...m, price: t.breakEvenPrice! - 0.01 }).net).toBeLessThan(0);

    const pct = calcMargin({ ...m, price: t.priceForPct! });
    expect(pct.netPct).toBeGreaterThanOrEqual(m.targetMarginPct - 1e-9);
    expect(calcMargin({ ...m, price: t.priceForPct! - 0.01 }).netPct).toBeLessThan(m.targetMarginPct);

    const rub = calcMargin({ ...m, price: t.priceForRub! });
    expect(rub.net).toBeGreaterThanOrEqual(m.targetMarginRub - 1e-9);
    expect(calcMargin({ ...m, price: t.priceForRub! - 0.01 }).net).toBeLessThan(m.targetMarginRub);
  });

  it('целевой % выше потолка — недостижимо', () => {
    const t = priceTargets({ ...base, targetMarginPct: 95 });
    expect(t.maxPossiblePct).toBeCloseTo(92.15, 10);
    expect(t.priceForPct).toBeNull();
  });

  it('споры съедают всю выплату — даже безубыточность недостижима', () => {
    const t = priceTargets({ ...base, disputeMode: 'percent', disputeValue: 100 });
    expect(t.breakEvenPrice).toBeNull();
  });
});

describe('verdictOf', () => {
  it('красный / жёлтый / зелёный', () => {
    expect(verdictOf(-1, -10, 10)).toBe('bad');
    expect(verdictOf(0, 0, 10)).toBe('bad');
    expect(verdictOf(5, 50, 10)).toBe('warn');
    expect(verdictOf(10, 100, 10)).toBe('good');
  });
});

describe('effectiveWithdrawPct', () => {
  it('процент + фикс. плата', () => {
    // 1000 ₽, 2 % и 30 ₽: на руки 950 → эффективно 5 %
    expect(effectiveWithdrawPct(1000, 2, 30)).toBeCloseTo(5, 10);
    expect(effectiveWithdrawPct(0, 2, 30)).toBeNull();
    expect(effectiveWithdrawPct(10, 0, 50)).toBe(100);
  });
});

describe('журнал', () => {
  const d = { sell: 500, buy: 300, feePct: 5, withdrawPct: 0, outcome: 'none' as const, disputeLoss: 0 };

  it('обычная сделка и выигранный спор', () => {
    expect(dealResult(d)).toBeCloseTo(175, 10);
    expect(dealResult({ ...d, outcome: 'won' })).toBeCloseTo(175, 10);
    expect(dealDisputeLoss({ ...d, outcome: 'won' })).toBe(0);
  });

  it('полный возврат: выплаты нет, закупка потеряна', () => {
    expect(dealResult({ ...d, outcome: 'refund' })).toBe(-300);
    expect(dealDisputeLoss({ ...d, outcome: 'refund' })).toBeCloseTo(475, 10);
  });

  it('частичный возврат: минус указанная потеря, потеря у других исходов игнорируется', () => {
    expect(dealResult({ ...d, outcome: 'partial', disputeLoss: 100 })).toBeCloseTo(75, 10);
    expect(dealResult({ ...d, outcome: 'none', disputeLoss: 100 })).toBeCloseTo(175, 10);
  });

  it('itemStats: R по журналу = суммарная потеря на спорах ÷ число сделок', () => {
    const s = itemStats([
      { ...d, item: 'A' },
      { ...d, item: 'A', outcome: 'refund' },
      { ...d, item: 'B', sell: 100, buy: 300 }, // 95 − 300 = −205 < −125 у A
    ]);
    expect(s[0].item).toBe('B'); // сортировка: самый убыточный первым
    const a = s.find((x) => x.item === 'A')!;
    expect(a.count).toBe(2);
    expect(a.net).toBeCloseTo(175 - 300, 10);
    expect(a.disputes).toBe(1);
    expect(a.lost).toBe(1);
    expect(a.avgDisputeLoss).toBeCloseTo(475 / 2, 10);
    // проверка: средняя маржа без споров − R = фактическая средняя маржа
    expect(175 - a.avgDisputeLoss).toBeCloseTo(a.avgNet, 10);
  });
});
