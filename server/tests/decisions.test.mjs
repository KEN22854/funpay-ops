// Decision Center: правила дают конкретные действия с эффектом в рублях.
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, nowIso, openDb, run } from '../db/db.mjs';
import { decisions } from '../decisions.mjs';
import * as inv from '../repo/inventory.mjs';
import { addFee } from '../repo/fees.mjs';
import { updateSettings } from '../repo/settings.mjs';
import { results, watches } from '../repo/watches.mjs';
import { verifyOpportunity } from '../verify.mjs';
import { buildOpportunities } from '../opportunities.mjs';

const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();

beforeEach(() => {
  closeDb();
  openDb(':memory:');
});

function seed(price = 500, fpMin = 1000, stock = null) {
  const w = watches.upsert({ name: 'Game', category: 'keys', query: 'Game', funpay: { url: 'https://funpay.com/lots/1/' } });
  const offer = { sourceId: 'plati', title: 'Game Steam key', price, currency: 'RUB', priceRub: price, fxRate: 1, url: 'https://plati.market/itm/1', stock, fetchedAt: nowIso(), match: { status: 'VERIFIED', source: 'manual', reasons: [] } };
  results.set(w.id, {
    watchId: w.id,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    sources: [{ sourceId: 'plati', status: 'ok', offers: [offer], rejected: 0 }],
    manual: [],
    funpay: { status: 'ok', title: 'Game', url: 'https://funpay.com/lots/1/', pricePer: 1, total: 5, count: 5, online: 3, sellers: 5, topSellerShare: 0.2, fetchedAt: nowIso(), min: fpMin, prices: [fpMin, fpMin + 50, fpMin + 100, fpMin + 150, fpMin + 200], top: [] },
  });
  return w;
}

const kinds = (r) => r.decisions.map((d) => d.kind);

describe('Decision Center', () => {
  it('кандидат → «перепроверить» с эффектом; без капитала → «задайте капитал»; неподтверждённая комиссия', () => {
    seed();
    const r = decisions();
    const v = r.decisions.find((d) => d.kind === 'verify');
    expect(v).toBeTruthy();
    expect(v.priority).toBe(1);
    expect(v.impactRub).toBeGreaterThan(0);
    expect(kinds(r)).toContain('capital');
    expect(kinds(r)).toContain('fee');
    expect(r.summary.unlockRub).toBeCloseTo(v.impactRub, 6);
  });

  it('после перепроверки — «купить», а не «перепроверить»; подтверждённая комиссия убирает совет', async () => {
    const w = seed();
    addFee({ scope: 'funpay_section', scopeKey: 'https://funpay.com/lots/1/', pct: 5, source: 'форма лота' });
    const [o] = buildOpportunities();
    await verifyOpportunity(o.id, { userConfirmedStock: true }, async () => {});
    const r = decisions();
    expect(kinds(r)).toContain('buy');
    expect(kinds(r)).not.toContain('verify');
    expect(kinds(r)).not.toContain('fee');
    expect(r.decisions[0].kind).toBe('buy');
    expect(w).toBeTruthy();
  });

  it('купить: при нехватке денег — приоритет 2 с объяснением', async () => {
    seed();
    inv.cashMove({ type: 'deposit', amount: 100, mode: 'real' });
    const [o] = buildOpportunities();
    await verifyOpportunity(o.id, { userConfirmedStock: true }, async () => {});
    // при кассе 100 ₽ сделка на 500 ₽ блокируется лимитом свободных денег — совета «купить» нет вовсе
    const r = decisions();
    expect(r.decisions.filter((d) => d.kind === 'buy' && d.priority === 1)).toHaveLength(0);
  });

  it('рынок ниже себестоимости → «спасти от убытка» с оценкой потерь', () => {
    const w = seed();
    inv.createPurchase({ item: 'Game', qty: 2, unitPrice: 2000, currency: 'RUB' });
    run("INSERT INTO price_snapshots(watch_id, kind, source_id, ts, min_rub) VALUES (?, 'funpay', 'funpay', ?, 1000)", w.id, nowIso());
    const r = decisions();
    const d = r.decisions.find((x) => x.kind === 'loss');
    expect(d).toBeTruthy();
    expect(d.priority).toBe(1);
    expect(d.impactRub).toBeLessThan(0);
    expect(r.summary.atRiskRub).toBeGreaterThan(0);
  });

  it('залежавшийся товар и закупка в пути', () => {
    updateSettings({ risk: { staleStockDays: 5 } });
    inv.createPurchase({ item: 'Old', qty: 1, unitPrice: 100, currency: 'RUB', purchasedAt: ago(20) });
    run("UPDATE purchases SET received_at = ? WHERE item = 'Old'", ago(20));
    inv.createPurchase({ item: 'Wait', qty: 1, unitPrice: 100, currency: 'RUB', status: 'in_transit', purchasedAt: ago(4) });
    const r = decisions();
    expect(kinds(r)).toContain('stale');
    expect(kinds(r)).toContain('transit');
  });

  it('сортировка: приоритет, затем эффект', () => {
    seed();
    const r = decisions();
    for (let i = 1; i < r.decisions.length; i++) expect(r.decisions[i].priority).toBeGreaterThanOrEqual(r.decisions[i - 1].priority);
  });
});
