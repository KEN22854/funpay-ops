import { describe, expect, it } from 'vitest';
import type { Offer, ScanResult, Watch } from './api';
import { bestPerItem, DEFAULT_ARB, evaluate, fromWatches, sellPriceFor } from './arbitrage';

const offer = (sourceId: string, priceRub: number, extra: Partial<Offer> = {}): Offer => ({
  sourceId,
  title: 'X',
  price: priceRub,
  currency: 'RUB',
  priceRub,
  url: `https://src/${sourceId}`,
  ...extra,
});

describe('sellPriceFor', () => {
  it('подрезка в % и ₽, не ниже нуля', () => {
    expect(sellPriceFor(1000, { ...DEFAULT_ARB, undercutPct: 0, undercutRub: 1 })).toBe(999);
    expect(sellPriceFor(1000, { ...DEFAULT_ARB, undercutPct: 2, undercutRub: 0 })).toBe(980);
    expect(sellPriceFor(0.5, { ...DEFAULT_ARB, undercutRub: 1 })).toBe(0);
  });
});

describe('evaluate', () => {
  it('та же формула, что в калькуляторе, + комиссия источника к закупке', () => {
    const s = { ...DEFAULT_ARB, undercutRub: 0, sellFeePct: 5, withdrawPct: 3, disputePct: 1, sourceFees: { plati: 2 } };
    const e = evaluate(offer('plati', 500), { min: 1000, count: 10, online: 3 }, s);
    expect(e.cost).toBeCloseTo(510, 10);
    // 1000 × 0.95 × 0.97 − 510 − 10 = 401.5
    expect(e.margin.net).toBeCloseTo(401.5, 10);
  });
});

describe('fromWatches', () => {
  const watch = { id: 'w1', name: 'Game', category: 'keys' } as Watch;
  const result = {
    watchId: 'w1',
    finishedAt: '2026-11-11T00:00:00Z',
    sources: [
      { sourceId: 'steam', status: 'ok', offers: [offer('steam', 900)], error: null },
      { sourceId: 'cs-2', status: 'ok', offers: [offer('cs-2', 600)], error: null },
      { sourceId: 'gog', status: 'error', offers: [], error: 'x' },
    ],
    manual: [offer('g2a', 700, { manual: true, updatedAt: '2000-01-01T00:00:00Z' })],
    funpay: { status: 'ok', title: '', url: 'https://funpay.com/lots/1/', pricePer: 1, total: 5, count: 2, online: 1, min: 1000, median10: 1000, top: [] },
  } as unknown as ScanResult;

  it('строит связку по каждой закупке и выбирает лучшую', () => {
    const all = fromWatches([watch], { w1: result }, DEFAULT_ARB);
    expect(all.map((o) => o.buy.sourceId).sort()).toEqual(['cs-2', 'g2a', 'steam']);
    const [best] = bestPerItem(all);
    expect(best.buy.sourceId).toBe('cs-2');
  });

  it('предупреждения: мало конкурентов, регион США, устаревшая ручная цена', () => {
    const all = fromWatches([watch], { w1: result }, DEFAULT_ARB);
    const cs = all.find((o) => o.buy.sourceId === 'cs-2')!;
    expect(cs.warnings.some((w) => w.includes('США'))).toBe(true);
    expect(cs.warnings.some((w) => w.includes('всего 2'))).toBe(true);
    expect(all.find((o) => o.buy.sourceId === 'g2a')!.warnings.some((w) => w.includes('устарела'))).toBe(true);
  });

  it('подозрительно дешёвая закупка помечается (аккаунт за 100 ₽ вместо ключа за 3000)', () => {
    const r = { ...result, sources: [{ sourceId: 'plati', status: 'ok', offers: [offer('plati', 100)], error: null }], manual: [] } as unknown as ScanResult;
    const [o] = fromWatches([watch], { w1: r }, DEFAULT_ARB);
    expect(o.suspicious).toBe(true);
    expect(o.warnings.some((w) => w.includes('не тот товар'))).toBe(true);
    expect(fromWatches([watch], { w1: r }, { ...DEFAULT_ARB, suspiciousPct: 0 })[0].suspicious).toBe(false);
  });

  it('без цены на FunPay связки нет', () => {
    const r = { ...result, funpay: { status: 'error', error: 'x', url: '' } } as unknown as ScanResult;
    expect(fromWatches([watch], { w1: r }, DEFAULT_ARB)).toEqual([]);
  });
});
