import { describe, expect, it } from 'vitest';
import { migrateState, normalizeDeal } from './useStore';

describe('миграция v1 → v2', () => {
  it('dispute: boolean превращается в outcome', () => {
    const st = migrateState(
      {
        deals: [
          { id: '1', date: '2026-11-01', item: 'A', buy: 1, sell: 2, feePct: 5, withdrawPct: 0, dispute: false, disputeLoss: 0, note: '' },
          { id: '2', date: '2026-11-01', item: 'A', buy: 1, sell: 2, feePct: 5, withdrawPct: 0, dispute: true, disputeLoss: 0, note: '' },
          { id: '3', date: '2026-11-01', item: 'A', buy: 1, sell: 2, feePct: 5, withdrawPct: 0, dispute: true, disputeLoss: 1.5, note: '' },
        ],
      },
      1,
    ) as { deals: { outcome: string; qty: number; disputeLoss: number }[] };
    expect(st.deals.map((d) => d.outcome)).toEqual(['none', 'won', 'partial']);
    expect(st.deals.every((d) => d.qty === 1)).toBe(true);
    expect(st.deals[2].disputeLoss).toBe(1.5);
  });

  it('normalizeDeal чистит мусор', () => {
    const d = normalizeDeal({ item: '  X ', qty: 0, buy: -5, sell: NaN, feePct: 300, outcome: 'bogus' as never, disputeLoss: 50 });
    expect(d.item).toBe('X');
    expect(d.qty).toBe(1);
    expect(d.buy).toBe(0);
    expect(d.sell).toBe(0);
    expect(d.feePct).toBe(100);
    expect(d.outcome).toBe('none');
    expect(d.disputeLoss).toBe(0);
  });
});
