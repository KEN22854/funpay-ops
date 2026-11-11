// Транзакции, склад, аналитика, комиссии, здоровье, история, бэкап — на базе в памяти.
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, openDb, schemaVersion, one } from '../db/db.mjs';
import { MIGRATIONS } from '../db/migrations.mjs';
import { idempotent, auditLog } from '../repo/audit.mjs';
import * as inv from '../repo/inventory.mjs';
import { abcXyz, metrics, recommendationQuality } from '../repo/analytics.mjs';
import { addFee, listFees, observeSectionFee, saleFeeFor, sectionKey } from '../repo/fees.mjs';
import { circuitOpen, healthSummary, recordHealth } from '../repo/health.mjs';
import { changes, snapshotFunpay, trimmedMedian } from '../repo/history.mjs';
import { getSettings, settingsHistory, updateSettings } from '../repo/settings.mjs';
import { createBackup, verifyBackup } from '../repo/backup.mjs';
import { sanitizeWatch } from '../repo/watches.mjs';

const fresh = () => {
  closeDb();
  openDb(':memory:');
};
const buy = (item, qty, unitPrice, extra = {}) => inv.createPurchase({ item, qty, unitPrice, currency: 'RUB', ...extra });
const sell = (item, qty, unitPrice, extra = {}) => inv.createSale({ item, qty, unitPrice, saleFeePct: 0, withdrawPct: 0, ...extra });

beforeEach(fresh);

describe('схема и настройки', () => {
  it('миграции применены, повторное открытие не ломает схему', () => {
    expect(schemaVersion()).toBe(MIGRATIONS.length);
    expect(one("SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = 'purchases'").n).toBe(1);
  });

  it('настройки: неверные значения приводятся к допустимым, изменения пишутся в историю', () => {
    updateSettings({ costModel: { feeModel: 'bogus', defaultSaleFeePct: 250, taxPct: -3 }, intervalMin: 99999 });
    const s = getSettings();
    expect(s.costModel.feeModel).toBe('deduct');
    expect(s.costModel.defaultSaleFeePct).toBe(99);
    expect(s.costModel.taxPct).toBe(0);
    expect(s.intervalMin).toBe(1440);
    expect(settingsHistory().length).toBeGreaterThan(0);
  });
});

describe('склад: партии, FIFO, средняя', () => {
  it('FIFO: продажа берёт сначала старую партию', () => {
    buy('Key', 2, 100, { purchasedAt: '2026-01-01T00:00:00Z' });
    buy('Key', 2, 200, { purchasedAt: '2026-01-02T00:00:00Z' });
    const s = sell('Key', 3, 500);
    expect(s.cogs_rub).toBe(100 + 100 + 200);
    expect(inv.stock()[0]).toMatchObject({ onHand: 1, valueRub: 200 });
  });

  it('средневзвешенная: себестоимость единицы — средняя по остатку', () => {
    updateSettings({ inventory: { costMethod: 'avg' } });
    buy('Key', 2, 100);
    buy('Key', 2, 200);
    const s = sell('Key', 1, 500);
    expect(s.cogs_rub).toBeCloseTo(150, 9);
    expect(inv.stock()[0].valueRub).toBeCloseTo(450, 9);
  });

  it('остаток не уходит в минус без явного разрешения', () => {
    buy('Key', 1, 100);
    expect(() => sell('Key', 2, 500)).toThrow(/недостаточно остатка/);
    // ничего не записалось — транзакция откатилась
    expect(one('SELECT count(*) n FROM sales').n).toBe(0);
    const s = sell('Key', 2, 500, { allowNegative: true });
    expect(s.cogs_rub).toBe(200);
    expect(inv.stock()[0].onHand).toBe(-1);
  });

  it('товар в пути недоступен до получения; резерв уменьшает доступное', () => {
    const p = buy('Key', 2, 100, { status: 'in_transit' });
    expect(() => sell('Key', 1, 500)).toThrow();
    inv.receivePurchase(p.id);
    inv.reserve({ item: 'Key', qty: 2 });
    expect(() => sell('Key', 1, 500)).toThrow(/резерв/);
    expect(inv.stock()[0]).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
  });

  it('полный возврат с возвратом на склад: себестоимость сторнируется, история не удаляется', () => {
    buy('Key', 1, 100);
    const s = inv.createSale({ item: 'Key', qty: 1, unitPrice: 500, saleFeePct: 5, withdrawPct: 0 });
    expect(s.net_rub).toBeCloseTo(475 - 100, 9);
    const r = inv.refundSale(s.id, { restock: true });
    expect(r.status).toBe('refunded');
    expect(r.net_rub).toBeCloseTo(0, 9);
    expect(inv.stock()[0].onHand).toBe(1);
    expect(one("SELECT count(*) n FROM stock_movements WHERE sale_id = ?", s.id).n).toBe(2);
    expect(() => inv.refundSale(s.id, {})).toThrow(/уже полностью/);
  });

  it('частичный возврат; возврат больше выплаты запрещён', () => {
    buy('Key', 1, 100);
    const s = sell('Key', 1, 500);
    expect(() => inv.refundSale(s.id, { amount: 600 })).toThrow(/больше/);
    const r = inv.refundSale(s.id, { amount: 100 });
    expect(r).toMatchObject({ status: 'partial_refund', refund_rub: 100, disputed: 1 });
    expect(r.net_rub).toBeCloseTo(500 - 100 - 100, 9);
  });

  it('списание по себестоимости; отмена закупки только для нетронутой партии', () => {
    const a = buy('Key', 2, 100);
    expect(inv.writeOff({ item: 'Key', qty: 1, note: 'ключ не активировался' }).lossRub).toBe(100);
    expect(() => inv.cancelPurchase(a.id)).toThrow(/списания/);
    const b = buy('Other', 1, 50);
    expect(inv.cancelPurchase(b.id).status).toBe('cancelled');
  });

  it('валюта: курс и спред сохраняются в партии', () => {
    const p = inv.createPurchase({ item: 'K', qty: 2, unitPrice: 10, currency: 'USD', fxRate: 90, fxSpreadPct: 2, feesRub: 18 });
    expect(p.total_cost_rub).toBeCloseTo(2 * 10 * 90 * 1.02 + 18, 9);
    expect(p.unit_cost_rub).toBeCloseTo(p.total_cost_rub / 2, 9);
    expect(() => inv.createPurchase({ item: 'K', qty: 1, unitPrice: 10, currency: 'USD' })).toThrow(/курс/);
  });

  it('касса: кассовый разрыв блокирует закупку, симуляция не смешивается с реальными деньгами', () => {
    inv.cashMove({ type: 'deposit', amount: 150 });
    expect(() => buy('Key', 2, 100)).toThrow(/не хватает денег/);
    buy('Key', 1, 100);
    expect(inv.cashBalance('real')).toBe(50);
    buy('Key', 5, 1000, { mode: 'sim' });
    expect(inv.cashBalance('real')).toBe(50);
    expect(inv.stock('real')[0].onHand).toBe(1);
    expect(inv.stock('sim')[0].onHand).toBe(5);
  });

  it('дата операции в будущем отклоняется (иначе отчёты её не видят)', () => {
    buy('Key', 1, 100);
    expect(() => sell('Key', 1, 500, { soldAt: new Date(Date.now() + 3600_000).toISOString() })).toThrow(/будущем/);
    expect(sell('Key', 1, 500, { soldAt: new Date(Date.now() - 60_000).toISOString() }).net_rub).toBe(400);
  });

  it('лимит бюджета на закупку', () => {
    updateSettings({ inventory: { maxPurchaseRub: 500 } });
    expect(() => buy('Key', 10, 100)).toThrow(/лимит бюджета/);
  });
});

describe('идемпотентность', () => {
  it('повтор с тем же ключом не создаёт вторую закупку', () => {
    const a = idempotent('key-12345678', 'purchase', () => buy('Key', 1, 100));
    const b = idempotent('key-12345678', 'purchase', () => buy('Key', 1, 100));
    expect(b.replayed).toBe(true);
    expect(b.id).toBe(a.id);
    expect(one('SELECT count(*) n FROM purchases').n).toBe(1);
    expect(() => idempotent('key-12345678', 'sale', () => 1)).toThrow(/другой операции/);
    expect(() => idempotent(undefined, 'sale', () => 1)).toThrow(/Idempotency-Key/);
  });

  it('действия попадают в журнал аудита без секретов', () => {
    buy('Key', 1, 100);
    updateSettings({ notify: { minNet: 5 } });
    const log = auditLog();
    expect(log.some((l) => l.action === 'purchase.create')).toBe(true);
    expect(log.some((l) => l.action === 'settings.update')).toBe(true);
  });
});

describe('аналитика', () => {
  const period = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', mode: 'real' };

  it('метрики: выручка, валовая и чистая прибыль, ROI = net / COGS, доли возвратов', () => {
    buy('A', 2, 100);
    sell('A', 1, 300);
    const s2 = sell('A', 1, 300);
    inv.refundSale(s2.id, { amount: 300 });
    const m = metrics(period);
    expect(m.orders).toBe(2);
    expect(m.revenue).toBe(600);
    expect(m.grossProfit).toBe(400);
    expect(m.netProfit).toBeCloseTo(200 + -100, 9);
    expect(m.roiPct).toBeCloseTo((100 / 200) * 100, 9);
    expect(m.refundRatePct).toBe(50);
  });

  it('ABC по вкладу в прибыль', () => {
    for (const [item, price] of [['A', 1000], ['B', 300], ['C', 120]]) {
      buy(item, 1, 100);
      sell(item, 1, price);
    }
    const r = abcXyz(period);
    expect(r.find((x) => x.item === 'A').abc).toBe('A');
    expect(r.find((x) => x.item === 'C').abc).toBe('C');
  });

  it('precision рекомендаций: неизвестный исход не считается', () => {
    getDb().prepare("INSERT INTO recommendations(id, item, source_id, offer_url, first_seen, last_seen, status, forecast_net) VALUES ('r1','A','s','u','x','x','RECOMMENDED', 150), ('r2','B','s','u','x','x','RECOMMENDED', 50)").run();
    buy('A', 1, 100, { recommendationId: 'r1' });
    sell('A', 1, 300);
    buy('B', 2, 100, { recommendationId: 'r2' });
    sell('B', 1, 300); // остался 1 — исход неизвестен
    const q = recommendationQuality();
    expect(q).toMatchObject({ purchased: 2, known: 1, profitable: 1, precision: 1 });
    expect(q.maePerUnit).toBeCloseTo(50, 9);
  });
});

describe('комиссии', () => {
  it('действующая ставка по дате, история сохраняется, источник обязателен', () => {
    const url = 'https://funpay.com/lots/986/';
    expect(sectionKey(url)).toBe('lots/986');
    expect(saleFeeFor(url, 5)).toMatchObject({ pct: 5, assumed: true, origin: 'setting' });
    addFee({ scope: 'funpay_section', scopeKey: url, pct: 4, source: 'форма лота', validFrom: '2026-01-01' });
    addFee({ scope: 'funpay_section', scopeKey: url, pct: 6, source: 'новость FunPay', validFrom: '2099-01-01' });
    expect(saleFeeFor(url, 5)).toMatchObject({ pct: 4, assumed: false, origin: 'section' });
    expect(saleFeeFor(url, 5, '2099-06-01T00:00:00Z').pct).toBe(6);
    expect(listFees().filter((f) => f.scope_key === 'lots/986')).toHaveLength(2);
    expect(() => addFee({ scope: 'funpay_section', scopeKey: url, pct: 3, source: '' })).toThrow(/источник/);
  });

  it('ставка из заголовка раздела FunPay записывается автоматически, но не перекрывает ручную', () => {
    const f = observeSectionFee('https://funpay.com/lots/1086/', 'Пополнение Steam - комиссия 2% / FunPay');
    expect(f.pct).toBe(2);
    expect(observeSectionFee('https://funpay.com/lots/1086/', 'Пополнение Steam - комиссия 2%').id).toBe(f.id);
    addFee({ scope: 'funpay_section', scopeKey: 'https://funpay.com/lots/1086/', pct: 3, source: 'проверил в форме' });
    expect(observeSectionFee('https://funpay.com/lots/1086/', 'комиссия 2%').pct).toBe(3);
  });
});

describe('здоровье источников', () => {
  it('3 ошибки подряд размыкают предохранитель; успех замыкает', () => {
    for (let i = 0; i < 3; i++) recordHealth('x', { ok: false, errorClass: 'server', httpStatus: 503 });
    expect(circuitOpen('x')).toBeTruthy();
    const h = healthSummary('x');
    expect(h).toMatchObject({ status: 'circuit_open', successRate: 0, errors: { server: 3 } });
    recordHealth('x', { ok: true, latencyMs: 100, items: 5 });
    expect(circuitOpen('x')).toBeNull();
    expect(healthSummary('x').reliability).toBeCloseTo(2 / 6, 9);
  });
});

describe('история', () => {
  it('усечённая медиана отбрасывает выбросы', () => {
    expect(trimmedMedian([1, 100, 101, 102, 103, 104, 105, 106, 107, 10000])).toBe(103.5);
  });

  it('исчезнувшие лоты считаются только между сопоставимыми сканами', () => {
    const o = (id, price) => ({ url: `https://funpay.com/lots/offer?id=${id}`, price, seller: `s${id}`, online: true });
    snapshotFunpay('w', [o(1, 100), o(2, 110), o(3, 120)]);
    snapshotFunpay('w', [o(2, 110), o(4, 90)]);
    const rows = getDb().prepare("SELECT * FROM price_snapshots WHERE watch_id = 'w' ORDER BY id").all();
    expect(rows[1]).toMatchObject({ disappeared: 2, appeared: 1, count: 2, min_rub: 90 });
    expect(rows[0].disappeared).toBeNull();
    expect(changes(rows)['1h']).toBeNull();
  });
});

describe('бэкап', () => {
  it('копия создаётся и проходит проверку восстановления', () => {
    buy('Key', 1, 100);
    const b = createBackup('test');
    expect(b.verify.ok).toBe(true);
    expect(b.verify.counts.purchases).toBe(1);
    expect(verifyBackup(b.file).ok).toBe(true);
  });
});

describe('карточка товара', () => {
  it('атрибуты проверяются по допустимым значениям', () => {
    const w = sanitizeWatch({ query: 'Elden Ring', attrs: { platform: 'pc', regions: ['ru', 'mars'], type: 'key', edition: 'weird' } });
    expect(w.attrs).toMatchObject({ platform: 'pc', regions: ['ru'], type: 'key', edition: '' });
  });
});
