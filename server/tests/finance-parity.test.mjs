// Единый источник истины: калькулятор, журнал, сканер (прогноз) и склад (факт) обязаны давать одинаковую прибыль.
import { describe, expect, it } from 'vitest';
import { forecast, saleResult, solvePrice } from '../../shared/finance.mjs';
import { calcMargin, dealResult, priceTargets } from '../../src/lib/margin';
import { forecast as serverForecast } from '../core/finance.mjs';

// детерминированный генератор, чтобы прогон был воспроизводимым
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe('паритет финансовых расчётов', () => {
  const r = rng(42);
  const cases = Array.from({ length: 300 }, () => ({
    price: Math.round(r() * 10000 * 100) / 100,
    cost: Math.round(r() * 8000 * 100) / 100,
    fee: Math.round(r() * 20 * 10) / 10,
    wd: Math.round(r() * 10 * 10) / 10,
    disputePct: Math.round(r() * 10 * 10) / 10,
    minutes: Math.round(r() * 30),
    hourly: Math.round(r() * 1000),
  }));

  it('калькулятор = сканер = сервер (300 случайных сделок)', () => {
    for (const c of cases) {
      const calc = calcMargin({
        price: c.price,
        platformFeePct: c.fee,
        withdrawFeePct: c.wd,
        cost: c.cost,
        disputeValue: c.disputePct,
        disputeMode: 'percent',
        disputeRefundPct: 100,
        minutesPerOrder: c.minutes,
        hourlyRate: c.hourly,
        investment: 0,
        targetMarginPct: 0,
        targetMarginRub: 0,
        monthlyGoal: 0,
      });
      const args = { sellPrice: c.price, buyRub: c.cost, saleFee: { pct: c.fee }, sourceFee: { pct: 0 }, m: { withdrawPct: c.wd, disputePct: c.disputePct, minutesPerOrder: c.minutes, hourlyRate: c.hourly } };
      expect(calc.net).toBeCloseTo(forecast(args).net, 9);
      expect(serverForecast(args).net).toBe(forecast(args).net);
      // контрольная формула из ТЗ: P(1−X)(1−Y) − C − R − T
      const manual = c.price * (1 - c.fee / 100) * (1 - c.wd / 100) - c.cost - (c.price * c.disputePct) / 100 - (c.minutes / 60) * c.hourly;
      expect(calc.net).toBeCloseTo(manual, 9);
    }
  });

  it('журнал = продажа на складе', () => {
    for (const c of cases.slice(0, 100)) {
      for (const outcome of ['none', 'won', 'refund', 'partial']) {
        const loss = Math.min(c.price * 0.3, 500);
        const j = dealResult({ sell: c.price, buy: c.cost, feePct: c.fee, withdrawPct: c.wd, outcome, disputeLoss: loss });
        const payout = c.price * (1 - c.fee / 100) * (1 - c.wd / 100);
        const refund = outcome === 'refund' ? payout : outcome === 'partial' ? loss : 0;
        const s = saleResult({ unitPrice: c.price, saleFeePct: c.fee, withdrawPct: c.wd, cogs: c.cost, refund });
        expect(j).toBeCloseTo(s.net, 9);
      }
    }
  });

  it('прогноз на 1 шт = факт продажи при тех же условиях (без допущений прогноза)', () => {
    for (const c of cases.slice(0, 100)) {
      const f = forecast({ sellPrice: c.price, buyRub: c.cost, saleFee: { pct: c.fee }, m: { withdrawPct: c.wd, taxPct: 4 } });
      const s = saleResult({ unitPrice: c.price, saleFeePct: c.fee, withdrawPct: c.wd, cogs: c.cost, taxPct: 4 });
      expect(f.net).toBeCloseTo(s.net, 9);
    }
  });

  it('обратный расчёт калькулятора = solvePrice движка', () => {
    const i = { price: 0, platformFeePct: 5, withdrawFeePct: 3, cost: 600, disputeValue: 20, disputeMode: 'rub', disputeRefundPct: 100, minutesPerOrder: 6, hourlyRate: 300, investment: 0, targetMarginPct: 10, targetMarginRub: 100, monthlyGoal: 0 };
    const t = priceTargets(i);
    const args = { buyRub: 600, saleFee: { pct: 5 }, m: { withdrawPct: 3, minutesPerOrder: 6, hourlyRate: 300, losses: { mode: 'rub', value: 20 } } };
    expect(t.breakEvenPrice).toBe(solvePrice(args, 0));
    expect(t.priceForRub).toBe(solvePrice(args, 100));
    expect(t.priceForPct).toBe(solvePrice(args, 0, 10));
  });

  it('граничные значения курса и спреда', () => {
    const base = { sellPrice: 1000, saleFee: { pct: 0 }, m: { fxSpreadPct: 0 } };
    expect(forecast({ ...base, buyRub: 0 }).invested).toBe(0);
    expect(forecast({ ...base, buyRub: 100, m: { fxSpreadPct: 2.5 } }).purchase).toBeCloseTo(102.5, 9);
    expect(forecast({ ...base, buyRub: 100, m: { fxSpreadPct: 150 } }).purchase).toBeCloseTo(199.99, 9); // спред ограничен 99.99%
    expect(forecast({ ...base, buyRub: -5 }).purchase).toBe(0);
    expect(forecast({ ...base, buyRub: Number.NaN }).purchase).toBe(0);
  });

  it('комиссии: процентная, фиксированная, сверху', () => {
    expect(forecast({ sellPrice: 1000, buyRub: 0, saleFee: { pct: 5, fixed: 10 } }).platformFee).toBe(60);
    expect(forecast({ sellPrice: 1050, buyRub: 0, saleFee: { pct: 5 }, m: { feeModel: 'addon' } }).platformFee).toBeCloseTo(50, 9);
    expect(forecast({ sellPrice: 1000, buyRub: 100, sourceFee: { pct: 2, fixed: 15 } }).payment).toBeCloseTo(17, 9);
  });
});
