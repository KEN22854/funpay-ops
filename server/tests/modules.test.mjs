// Новые модули аудита: спрос, капитал и риск, paper trading, бэктест, качество источников, перепроверка.
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, nowIso, openDb, run } from '../db/db.mjs';
import * as inv from '../repo/inventory.mjs';
import { kaplanMeier, priceBands, sellProbability } from '../repo/demand.mjs';
import { aging, capitalSnapshot, cashFlowForecast, checkLimits, learnedLossPct, releaseCash, reserveCash } from '../repo/risk.mjs';
import { closeDuePaper, openPaper, paperStats } from '../repo/paper.mjs';
import { runBacktest } from '../repo/backtest.mjs';
import { recordAttempt, sourceQuality } from '../repo/quality.mjs';
import { updateSettings, settingsHash } from '../repo/settings.mjs';
import { results, watches } from '../repo/watches.mjs';
import { verifyOpportunity } from '../verify.mjs';
import { buildOpportunities } from '../opportunities.mjs';

const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();

beforeEach(() => {
  closeDb();
  openDb(':memory:');
});

describe('Demand Intelligence: Каплан–Мейер', () => {
  it('цензурированные остатки не завышают скорость продаж', () => {
    // 10 единиц: 4 проданы за 1, 2, 3, 5 дней; 6 лежат 10 дней — вероятность продажи за 7 дней должна быть 40%, а не 100%
    const curve = kaplanMeier({ events: [1, 2, 3, 5].map((d) => ({ d, n: 1 })), censored: [{ d: 10, n: 6 }] });
    const at7 = curve.filter((c) => c.t <= 7).at(-1);
    expect(1 - at7.S).toBeCloseTo(0.4, 9);
  });

  it('по складу: вероятности за 1/3/7/14 дней с интервалом; мало данных — честный отказ', () => {
    updateSettings({ demand: { minOwnSales: 3 } });
    inv.createPurchase({ item: 'K', qty: 5, unitPrice: 100, currency: 'RUB', purchasedAt: ago(10) });
    expect(sellProbability({ item: 'K' }, { minEvents: 3 }).enough).toBe(false);
    for (const d of [9, 8, 6]) inv.createSale({ item: 'K', qty: 1, unitPrice: 300, saleFeePct: 0, soldAt: ago(d) });
    const sp = sellProbability({ item: 'K' }, { minEvents: 3 });
    expect(sp.enough).toBe(true);
    expect(sp.events).toBe(3);
    expect(sp.censored).toBe(2);
    expect(sp.probs[7].p).toBeCloseTo(0.6, 6);
    expect(sp.probs[7].lo).toBeLessThanOrEqual(sp.probs[7].p);
    expect(sp.probs[7].hi).toBeGreaterThanOrEqual(sp.probs[7].p);
  });

  it('ценовые диапазоны: без достаточной истории оптимальная цена не выдумывается', () => {
    const b = priceBands({});
    expect(b.best).toBeNull();
    expect(b.note).toMatch(/≥ 10/);
  });
});

describe('Capital & Risk', () => {
  it('доли капитала по товару/источнику и свободные деньги с учётом резерва', () => {
    updateSettings({ inventory: { startingCapital: 10000 }, risk: { maxItemSharePct: 30, maxSourceSharePct: 50 } });
    inv.createPurchase({ item: 'A', qty: 2, unitPrice: 1000, currency: 'RUB', sourceId: 'plati' });
    const r = reserveCash({ amount: 3000, item: 'B' });
    const snap = capitalSnapshot();
    expect(snap).toMatchObject({ cash: 8000, reserved: 3000, freeCash: 5000, inventory: 2000, total: 10000 });
    expect(snap.utilization).toBeCloseTo(0.2, 9);
    // ещё 1500 в товар A → 35% > 30%
    expect(checkLimits({ cost: 1500, item: 'A', sourceId: 'gog', category: 'keys' }, snap).blocks.join()).toMatch(/товаре «A»/);
    // 6000 > свободных 5000
    expect(checkLimits({ cost: 6000, item: 'C', sourceId: 'gog', category: 'keys' }, snap).blocks.join()).toMatch(/свободных денег/);
    releaseCash(r.id);
    expect(capitalSnapshot().freeCash).toBe(8000);
  });

  it('старение запасов и замороженный капитал', () => {
    updateSettings({ risk: { staleStockDays: 30 } });
    inv.createPurchase({ item: 'Old', qty: 1, unitPrice: 500, currency: 'RUB', purchasedAt: ago(45) });
    inv.createPurchase({ item: 'New', qty: 1, unitPrice: 200, currency: 'RUB', purchasedAt: ago(2) });
    const a = aging();
    expect(a.frozen).toBe(500);
    expect(a.buckets.find((b) => b.key === '31-90').value).toBe(500);
    expect(a.buckets.find((b) => b.key === '0-7').value).toBe(200);
  });

  it('прогноз денежного потока: поступления растут с горизонтом, резерв — расход', () => {
    inv.createPurchase({ item: 'A', qty: 2, unitPrice: 100, currency: 'RUB' });
    reserveCash({ amount: 50 });
    const f = cashFlowForecast();
    expect(f.map((x) => x.days)).toEqual([7, 14, 30]);
    expect(f[2].inflow).toBeGreaterThanOrEqual(f[0].inflow);
    expect(f[0].outflow).toBe(50);
  });

  it('обученные потери сглаживаются к значению из параметров', () => {
    updateSettings({ costModel: { disputePct: 2 }, risk: { lossPriorWeight: 10 } });
    expect(learnedLossPct({ sourceId: 'x' })).toMatchObject({ pct: 2, n: 0 });
    inv.createPurchase({ item: 'A', qty: 10, unitPrice: 10, currency: 'RUB', sourceId: 'x' });
    for (let i = 0; i < 10; i++) {
      const s = inv.createSale({ item: 'A', qty: 1, unitPrice: 100, saleFeePct: 0 });
      if (i < 2) inv.refundSale(s.id, { amount: 100 }); // 20% выручки возвращено
    }
    const l = learnedLossPct({ sourceId: 'x' });
    expect(l.n).toBe(10);
    expect(l.observed).toBeCloseTo(20, 9);
    expect(l.pct).toBeCloseTo((2 * 10 + 20 * 10) / 20, 9);
  });
});

describe('частичное исполнение закупки', () => {
  it('получено меньше заказанного: возврат за товар в кассу, комиссия ложится на полученное', () => {
    inv.cashMove({ type: 'deposit', amount: 10000 });
    const p = inv.createPurchase({ item: 'K', qty: 5, unitPrice: 100, currency: 'RUB', feesRub: 30, status: 'in_transit' });
    expect(inv.cashBalance()).toBe(10000 - 530);
    const r = inv.receivePurchase(p.id, { qty: 3 });
    expect(r.received_qty).toBe(3);
    expect(inv.cashBalance()).toBe(10000 - 330);
    expect(inv.stock()[0]).toMatchObject({ onHand: 3, valueRub: 330 });
    expect(() => inv.receivePurchase(p.id, { qty: 1 })).toThrow(/уже получена/);
  });
});

describe('качество источников по попыткам закупки', () => {
  it('точность цены и остатка', () => {
    recordAttempt({ sourceId: 's', quotedRub: 100, actualRub: 100, outcome: 'ok' });
    recordAttempt({ sourceId: 's', quotedRub: 100, actualRub: 110, outcome: 'price_changed' });
    recordAttempt({ sourceId: 's', quotedRub: 100, outcome: 'out_of_stock' });
    recordAttempt({ sourceId: 's', quotedRub: 100, actualRub: 102, outcome: 'ok' });
    const q = sourceQuality('s');
    expect(q.price.attempts).toBe(3);
    expect(q.price.medianDeviationPct).toBeCloseTo(2, 9);
    expect(q.stock.accuracy).toBeCloseTo(3 / 4, 9);
    expect(() => recordAttempt({ sourceId: 's', outcome: 'maybe' })).toThrow();
  });
});

/** карточка товара + результат скана с одним предложением Plati без остатка */
function seedWatch(price = 500, fpMin = 1000) {
  const w = watches.upsert({ name: 'Game', category: 'keys', query: 'Game', funpay: { url: 'https://funpay.com/lots/1/' } });
  const offer = { sourceId: 'plati', title: 'Game Steam key', price, currency: 'RUB', priceRub: price, fxRate: 1, url: 'https://plati.market/itm/1', stock: null, fetchedAt: nowIso(), match: { status: 'VERIFIED', source: 'manual', reasons: [] } };
  results.set(w.id, {
    watchId: w.id,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    sources: [{ sourceId: 'plati', status: 'ok', offers: [offer], rejected: 0 }],
    manual: [],
    funpay: { status: 'ok', title: 'Game', url: 'https://funpay.com/lots/1/', pricePer: 1, total: 5, count: 5, online: 3, sellers: 5, topSellerShare: 0.2, fetchedAt: nowIso(), min: fpMin, prices: [fpMin, fpMin + 50, fpMin + 100, fpMin + 150, fpMin + 200], top: [] },
  });
  return { w, offer };
}

describe('Profit Verification: перепроверка', () => {
  it('кандидат → перепроверка (цена та же, наличие подтверждено) → исполнимо', async () => {
    const { w } = seedWatch();
    const [o] = buildOpportunities();
    expect(o.eval.status).toBe('CANDIDATE');
    const r = await verifyOpportunity(o.id, { userConfirmedStock: true }, async () => {}); // повторный скан даёт ту же цену
    expect(r.ok).toBe(true);
    expect(r.opportunity.eval.status).toBe('RECOMMENDED');
    expect(r.opportunity.eval.verification).toBe('executable');
    expect(watches.get(w.id)).toBeTruthy();
  });

  it('цена выросла сверх допуска при повторном скане → блок', async () => {
    const { w } = seedWatch();
    const [o] = buildOpportunities();
    const r = await verifyOpportunity(o.id, { userConfirmedStock: true }, async () => {
      const res = results.get(w.id);
      res.sources[0].offers[0] = { ...res.sources[0].offers[0], price: 600, priceRub: 600 };
      results.set(w.id, res);
    });
    expect(r.ok).toBe(false);
    expect(r.notes.join()).toMatch(/цена выросла/);
    expect(r.opportunity.eval.status).toBe('BLOCKED');
  });
});

describe('журнал рекомендаций и paper trading', () => {
  it('кандидат пишется с версией движка и настроек и открывает бумажные позиции по сценариям', () => {
    seedWatch();
    buildOpportunities({ log: true });
    const rec = getDb().prepare('SELECT * FROM recommendations').get();
    expect(rec).toMatchObject({ status: 'CANDIDATE', engine_version: '2.1.0', settings_hash: settingsHash() });
    const paper = getDb().prepare('SELECT strategy FROM paper_positions ORDER BY strategy').all().map((r) => r.strategy);
    expect(paper).toEqual(['balanced', 'fast', 'max']);
    // повторный проход не дублирует открытые позиции
    buildOpportunities({ log: true });
    expect(getDb().prepare('SELECT count(*) n FROM paper_positions').get().n).toBe(3);
  });

  it('закрытие по рыночной переоценке после горизонта', () => {
    const { w } = seedWatch();
    const [o] = buildOpportunities();
    updateSettings({ paper: { horizonDays: 1 } });
    openPaper(o);
    getDb().prepare("UPDATE paper_positions SET opened_at = ?").run(ago(2));
    // рынок через день упал до 520 — сделка «fast» стала убыточной (519 × 0.95 < 500)
    run("INSERT INTO price_snapshots(watch_id, kind, source_id, ts, min_rub) VALUES (?, 'funpay', 'funpay', ?, 520)", w.id, ago(0.5));
    expect(closeDuePaper()).toBeGreaterThan(0);
    const st = paperStats().byStrategy.fast;
    expect(st.closed).toBe(1);
    expect(st.winRate).toBe(0);
    expect(st.falsePositiveRate).toBe(1);
  });
});

describe('бэктест без заглядывания в будущее', () => {
  it('решение в момент t не видит будущих цен; результат — по снимку после горизонта', () => {
    const w = watches.upsert({ name: 'G', category: 'keys', query: 'G', funpay: { url: 'https://funpay.com/lots/2/' } });
    const snap = (ts, kind, src, min, extra = '') => run(`INSERT INTO price_snapshots(watch_id, kind, source_id, ts, min_rub, median_rub, trimmed_rub, count) VALUES (?, ?, ?, ?, ?, ?, ?, 5)`, w.id, kind, src, ts, min, min * 1.1, min * 1.05);
    // день 10: источник 500, FunPay 1000 — выгодно; через 7 дней FunPay 520 — фактически убыток
    snap(ago(10), 'source', 'plati', 500);
    snap(ago(10), 'funpay', 'funpay', 1000);
    snap(ago(5), 'funpay', 'funpay', 1000);
    snap(ago(2.9), 'funpay', 'funpay', 520);
    const r = runBacktest({ horizonDays: 7, sinceDays: 30, save: false });
    const fast = r.strategies.fast;
    expect(fast.trades).toBe(1);
    expect(fast.winRate).toBe(0);
    expect(fast.falsePositiveRate).toBe(1);
    expect(fast.forecastMae).toBeGreaterThan(0);
    expect(r.trades[0].exitPrice).toBe(519); // 520 − 1 ₽ подрезки
  });
});
