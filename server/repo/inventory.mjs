// Склад: партии закупок, FIFO / средневзвешенная себестоимость, продажи, возвраты, списания, резерв, касса.
// Все движения — только добавлением; история не удаляется. Остаток не уходит в минус без явного разрешения.
import { randomUUID } from 'node:crypto';
import { all, nowIso, one, run, tx } from '../db/db.mjs';
import { saleResult } from '../core/finance.mjs';
import { audit } from './audit.mjs';
import { saleFeeFor } from './fees.mjs';
import { getSettings } from './settings.mjs';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MODES = ['real', 'sim'];
const r2 = (v) => Math.round(v * 100) / 100;
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const num = (v, name, { min = 0, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw err(`${name}: нужно ${int ? 'целое ' : ''}число ≥ ${min}`);
  return n;
};
/** дата операции: пусто — сейчас; в будущем (больше 5 минут) — ошибка, иначе отчёты за период её не увидят */
const iso = (v) => {
  if (!v || Number.isNaN(Date.parse(v))) return nowIso();
  const t = new Date(v).getTime();
  if (t > Date.now() + 5 * 60_000) throw err('дата операции в будущем');
  return new Date(t).toISOString();
};
const modeOf = (m) => (MODES.includes(m) ? m : 'real');

/* ───────────── касса ───────────── */

function ledger(mode, type, amount, refId, note) {
  run('INSERT INTO cash_ledger(ts, mode, type, amount_rub, ref_id, note) VALUES (?, ?, ?, ?, ?, ?)', nowIso(), mode, type, amount, refId, note ?? null);
}

/** касса ведётся, если задан стартовый капитал или есть хотя бы одно внесение */
export function cashTracking(mode = 'real') {
  return getSettings().inventory.startingCapital > 0 || !!one("SELECT 1 FROM cash_ledger WHERE mode = ? AND type IN ('deposit','withdraw') LIMIT 1", mode);
}

export function cashBalance(mode = 'real') {
  // симуляция стартует с того же капитала, но её движения не смешиваются с реальными
  return getSettings().inventory.startingCapital + (one('SELECT coalesce(sum(amount_rub), 0) s FROM cash_ledger WHERE mode = ?', mode)?.s ?? 0);
}

export function cashMove({ type, amount, note, mode }) {
  if (!['deposit', 'withdraw'].includes(type)) throw err('type: deposit | withdraw');
  const a = num(amount, 'сумма', { min: 0.01 });
  const m = modeOf(mode);
  ledger(m, type, type === 'deposit' ? a : -a, null, str(note));
  audit(`cash.${type}`, 'cash', null, { amount: a, mode: m });
  return { balance: cashBalance(m) };
}

/* ───────────── партии и остатки ───────────── */

/** открытые партии товара с остатком (FIFO-порядок) */
export function batches(item, mode = 'real') {
  return all(
    `SELECT p.id, p.unit_cost_rub, p.received_at, p.source_id, p.qty,
            coalesce((SELECT sum(qty) FROM stock_movements m WHERE m.purchase_id = p.id), 0) AS remaining
       FROM purchases p
      WHERE p.item = ? AND p.mode = ? AND p.status = 'received'
      ORDER BY p.received_at, p.id`,
    item,
    mode,
  ).filter((b) => b.remaining > 0);
}

export function stockValue(item, mode = 'real', at = null) {
  return at
    ? one('SELECT coalesce(sum(qty * unit_cost_rub), 0) v FROM stock_movements WHERE item = ? AND mode = ? AND ts <= ?', item, mode, at).v
    : one('SELECT coalesce(sum(qty * unit_cost_rub), 0) v FROM stock_movements WHERE item = ? AND mode = ?', item, mode).v;
}

export function reservedQty(item, mode = 'real') {
  return one('SELECT coalesce(sum(qty), 0) q FROM reservations WHERE item = ? AND mode = ? AND released_at IS NULL', item, mode).q;
}

export function stock(mode = 'real') {
  const items = all('SELECT DISTINCT item FROM purchases WHERE mode = ? UNION SELECT DISTINCT item FROM stock_movements WHERE mode = ?', mode, mode).map((r) => r.item);
  const low = getSettings().inventory.lowStockQty;
  return items
    .map((item) => {
      const onHand = one('SELECT coalesce(sum(qty), 0) q FROM stock_movements WHERE item = ? AND mode = ?', item, mode).q;
      const bs = batches(item, mode);
      // стоимость остатка = сумма движений по их себестоимости: верно и для FIFO, и для средней
      const value = stockValue(item, mode);
      const inTransit = one("SELECT coalesce(sum(qty), 0) q FROM purchases WHERE item = ? AND mode = ? AND status = 'in_transit'", item, mode).q;
      const reserved = reservedQty(item, mode);
      return {
        item,
        onHand,
        reserved,
        available: onHand - reserved,
        inTransit,
        valueRub: value,
        avgCostRub: onHand > 0 ? value / onHand : null,
        batches: bs.length,
        low: onHand - reserved <= low,
      };
    })
    .sort((a, b) => b.valueRub - a.valueRub);
}

/**
 * Распределить списание qty по партиям. FIFO — по партиям в порядке поступления;
 * avg — количество по партиям в том же порядке, а себестоимость единицы — средневзвешенная по всем открытым партиям.
 */
export function allocate(item, mode, qty, method, { allowNegative = false } = {}) {
  const bs = batches(item, mode);
  const available = bs.reduce((s, b) => s + b.remaining, 0) - reservedQty(item, mode);
  if (qty > available && !allowNegative) throw err(`недостаточно остатка «${item}»: доступно ${available}, нужно ${qty} (резерв учтён)`, 409);
  const onHand = bs.reduce((s, b) => s + b.remaining, 0);
  const avg = onHand > 0 ? stockValue(item, mode) / onHand : 0;
  const out = [];
  let left = qty;
  for (const b of bs) {
    if (left <= 0) break;
    const take = Math.min(left, b.remaining);
    out.push({ purchaseId: b.id, qty: take, unitCost: method === 'avg' ? avg : b.unit_cost_rub });
    left -= take;
  }
  if (left > 0) {
    // разрешённый минус: себестоимость по последней известной закупке, отмечается явно
    const lastCost = one("SELECT unit_cost_rub c FROM purchases WHERE item = ? AND mode = ? AND status != 'cancelled' ORDER BY purchased_at DESC LIMIT 1", item, mode)?.c ?? 0;
    out.push({ purchaseId: null, qty: left, unitCost: method === 'avg' && avg ? avg : lastCost, negative: true });
  }
  return out;
}

/* ───────────── закупки ───────────── */

export function createPurchase(b) {
  const s = getSettings();
  const item = str(b.item, 160);
  if (!item) throw err('нужно название товара');
  const qty = num(b.qty, 'количество', { min: 1, int: true });
  const unitPrice = num(b.unitPrice, 'цена');
  const currency = str(b.currency || 'RUB', 3).toUpperCase();
  const fx = currency === 'RUB' ? 1 : num(b.fxRate, `курс ${currency}`, { min: 0.000001 });
  const spread = currency === 'RUB' ? 0 : Math.min(50, Math.max(0, Number(b.fxSpreadPct ?? s.costModel.fxSpreadPct) || 0));
  const fees = num(b.feesRub ?? 0, 'комиссии при покупке');
  const total = qty * unitPrice * fx * (1 + spread / 100) + fees;
  const mode = modeOf(b.mode);
  const status = b.status === 'in_transit' ? 'in_transit' : 'received';

  if (s.inventory.maxPurchaseRub > 0 && total > s.inventory.maxPurchaseRub && !b.overrideBudget) {
    throw err(`закупка ${r2(total)} ₽ превышает лимит бюджета на одну закупку ${s.inventory.maxPurchaseRub} ₽`, 409);
  }
  if (mode === 'real' && cashTracking(mode) && total > cashBalance(mode) && !b.allowNegativeCash) {
    throw err(`не хватает денег: в кассе ${r2(cashBalance(mode))} ₽, нужно ${r2(total)} ₽ (кассовый разрыв)`, 409);
  }

  const id = randomUUID();
  const at = iso(b.purchasedAt);
  return tx(() => {
    run(
      `INSERT INTO purchases(id, item, watch_id, recommendation_id, source_id, qty, unit_price, currency, fx_rate, fx_spread_pct, fees_rub, total_cost_rub, unit_cost_rub, status, mode, purchased_at, received_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      item,
      b.watchId || null,
      b.recommendationId || null,
      str(b.sourceId, 60) || null,
      qty,
      unitPrice,
      currency,
      fx,
      spread,
      fees,
      total,
      total / qty,
      status,
      mode,
      at,
      status === 'received' ? at : null,
      str(b.note) || null,
    );
    if (b.category) run('UPDATE purchases SET category = ? WHERE id = ?', str(b.category, 30), id);
    if (status === 'received') run("INSERT INTO stock_movements(item, mode, purchase_id, type, qty, unit_cost_rub, ts) VALUES (?, ?, ?, 'receive', ?, ?, ?)", item, mode, id, qty, total / qty, at);
    ledger(mode, 'purchase', -total, id, item);
    audit('purchase.create', 'purchase', id, { item, qty, total, mode, status });
    return one('SELECT * FROM purchases WHERE id = ?', id);
  });
}

/**
 * Получение партии. qty меньше заказанного — частичное исполнение: недопоставленные единицы
 * возвращаются в кассу по цене товара (комиссии покупки не возвращаются и ложатся на полученные единицы).
 */
export function receivePurchase(id, { qty } = {}) {
  return tx(() => {
    const p = one('SELECT * FROM purchases WHERE id = ?', id);
    if (!p) throw err('закупка не найдена', 404);
    if (p.status !== 'in_transit') throw err('закупка уже получена или отменена', 409);
    const got = qty === undefined || qty === null || qty === '' ? p.qty : num(qty, 'получено', { min: 1, int: true });
    if (got > p.qty) throw err(`получено больше заказанного (${p.qty})`);
    const at = nowIso();
    const missing = p.qty - got;
    const refund = missing * p.unit_price * p.fx_rate * (1 + p.fx_spread_pct / 100);
    const unitCost = (p.total_cost_rub - refund) / got;
    run("UPDATE purchases SET status = 'received', received_at = ?, received_qty = ? WHERE id = ?", at, got, id);
    run("INSERT INTO stock_movements(item, mode, purchase_id, type, qty, unit_cost_rub, ts) VALUES (?, ?, ?, 'receive', ?, ?, ?)", p.item, p.mode, id, got, unitCost, at);
    if (missing > 0) ledger(p.mode, 'purchase_partial_refund', refund, id, `${p.item}: недопоставка ${missing} шт`);
    audit('purchase.receive', 'purchase', id, { ordered: p.qty, received: got, refund });
    return one('SELECT * FROM purchases WHERE id = ?', id);
  });
}

/** Отмена закупки: только целиком непроданная партия; деньги возвращаются в кассу */
export function cancelPurchase(id, note) {
  return tx(() => {
    const p = one('SELECT * FROM purchases WHERE id = ?', id);
    if (!p) throw err('закупка не найдена', 404);
    if (p.status === 'cancelled') throw err('закупка уже отменена', 409);
    const remaining = one('SELECT coalesce(sum(qty), 0) q FROM stock_movements WHERE purchase_id = ?', id).q;
    if (p.status === 'received' && remaining !== p.qty) throw err('из партии уже были продажи или списания — отменить нельзя, используйте списание', 409);
    if (p.status === 'received') run("INSERT INTO stock_movements(item, mode, purchase_id, type, qty, unit_cost_rub, ts, note) VALUES (?, ?, ?, 'adjust', ?, ?, ?, 'отмена закупки')", p.item, p.mode, id, -p.qty, p.unit_cost_rub, nowIso());
    run("UPDATE purchases SET status = 'cancelled', note = coalesce(note, '') || ? WHERE id = ?", note ? ` [отмена: ${str(note)}]` : ' [отмена]', id);
    ledger(p.mode, 'purchase_cancel', p.total_cost_rub, id, p.item);
    audit('purchase.cancel', 'purchase', id, { note });
    return one('SELECT * FROM purchases WHERE id = ?', id);
  });
}

/* ───────────── продажи ───────────── */

export function createSale(b) {
  const s = getSettings();
  const item = str(b.item, 160);
  if (!item) throw err('нужно название товара');
  const qty = num(b.qty, 'количество', { min: 1, int: true });
  const unitPrice = num(b.unitPrice, 'цена продажи');
  const mode = modeOf(b.mode);
  const soldAt = iso(b.soldAt);
  const method = s.inventory.costMethod;
  const fee =
    b.saleFeePct !== undefined && b.saleFeePct !== null && b.saleFeePct !== ''
      ? { pct: num(b.saleFeePct, 'комиссия'), fixed: 0, source: 'указана в продаже вручную' }
      : saleFeeFor(b.sectionUrl, s.costModel.defaultSaleFeePct, soldAt);
  const withdrawPct = b.withdrawPct !== undefined && b.withdrawPct !== '' && b.withdrawPct !== null ? num(b.withdrawPct, 'вывод') : s.costModel.withdrawPct;
  const fulfillment = num(b.fulfillmentRub ?? 0, 'расходы на исполнение');
  const imported = Boolean(b.imported);
  const status = ['completed', 'disputed_won'].includes(b.status) ? b.status : 'completed';

  return tx(() => {
    let cogs;
    let allocations = [];
    if (imported) cogs = num(b.cogsRub ?? 0, 'себестоимость');
    else {
      allocations = allocate(item, mode, qty, method, { allowNegative: s.inventory.allowNegative || b.allowNegative === true });
      cogs = allocations.reduce((sum, a) => sum + a.qty * a.unitCost, 0);
    }
    const res = saleResult({ qty, unitPrice, saleFeePct: fee.pct, saleFeeFixed: fee.fixed, feeModel: s.costModel.feeModel, withdrawPct, cogs, fulfillment, taxPct: s.costModel.taxPct, taxBase: s.costModel.taxBase });
    const id = randomUUID();
    run(
      `INSERT INTO sales(id, item, watch_id, qty, unit_price, revenue_rub, sale_fee_pct, sale_fee_source, platform_fee_rub, withdraw_pct, withdraw_fee_rub, payout_rub, cogs_rub, cost_method,
                         fulfillment_rub, tax_rub, refund_rub, net_rub, status, disputed, mode, imported, recommendation_id, sold_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      item,
      b.watchId || null,
      qty,
      unitPrice,
      res.revenue,
      fee.pct,
      fee.source ?? null,
      res.platformFee,
      withdrawPct,
      res.withdrawFee,
      res.payout,
      cogs,
      imported ? 'imported' : method,
      fulfillment,
      res.tax,
      res.net,
      status,
      status === 'disputed_won' ? 1 : 0,
      mode,
      imported ? 1 : 0,
      b.recommendationId || null,
      soldAt,
      str(b.note) || null,
    );
    for (const a of allocations) {
      run("INSERT INTO stock_movements(item, mode, purchase_id, sale_id, type, qty, unit_cost_rub, ts, note) VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?)", item, mode, a.purchaseId, id, -a.qty, a.unitCost, soldAt, a.negative ? 'отрицательный остаток (разрешено)' : null);
    }
    if (b.reservationId) run('UPDATE reservations SET released_at = ? WHERE id = ? AND released_at IS NULL', nowIso(), b.reservationId);
    if (!imported) {
      ledger(mode, 'sale', res.payout, id, item);
      if (res.tax) ledger(mode, 'tax', -res.tax, id, item);
      if (fulfillment) ledger(mode, 'fulfillment', -fulfillment, id, item);
    }
    audit('sale.create', 'sale', id, { item, qty, unitPrice, net: res.net, mode, imported, fee: fee.pct, feeSource: fee.source });
    return { ...one('SELECT * FROM sales WHERE id = ?', id), allocations };
  });
}

/**
 * Возврат покупателю. amount — сколько вернули (≤ выплаты). restock — товар вернулся на склад
 * (только при полном возврате; себестоимость сторнируется).
 */
export function refundSale(id, { amount, restock = false, dispute = true, note } = {}) {
  const s = getSettings();
  return tx(() => {
    const sale = one('SELECT * FROM sales WHERE id = ?', id);
    if (!sale) throw err('продажа не найдена', 404);
    if (['refunded', 'cancelled'].includes(sale.status)) throw err('продажа уже полностью возвращена', 409);
    const a = amount === undefined || amount === null || amount === '' ? sale.payout_rub - sale.refund_rub : num(amount, 'сумма возврата', { min: 0.01 });
    const totalRefund = sale.refund_rub + a;
    if (totalRefund > sale.payout_rub + 0.005) throw err(`возврат больше полученной выплаты (${r2(sale.payout_rub)} ₽)`, 409);
    const full = totalRefund >= sale.payout_rub - 0.005;
    if (restock && !full) throw err('вернуть товар на склад можно только при полном возврате', 400);

    let cogs = sale.cogs_rub;
    if (restock) {
      for (const m of all("SELECT * FROM stock_movements WHERE sale_id = ? AND type = 'sale'", id)) {
        run("INSERT INTO stock_movements(item, mode, purchase_id, sale_id, type, qty, unit_cost_rub, ts, note) VALUES (?, ?, ?, ?, 'return', ?, ?, ?, 'возврат на склад')", m.item, m.mode, m.purchase_id, id, -m.qty, m.unit_cost_rub, nowIso());
      }
      cogs = 0;
    }
    const res = saleResult({
      qty: sale.qty,
      unitPrice: sale.unit_price,
      saleFeePct: sale.sale_fee_pct,
      feeModel: s.costModel.feeModel,
      withdrawPct: sale.withdraw_pct,
      cogs,
      fulfillment: sale.fulfillment_rub,
      refund: totalRefund,
      taxPct: s.costModel.taxPct,
      taxBase: s.costModel.taxBase,
    });
    run(
      'UPDATE sales SET refund_rub = ?, cogs_rub = ?, tax_rub = ?, net_rub = ?, status = ?, disputed = ?, closed_at = ?, note = coalesce(note, \'\') || ? WHERE id = ?',
      totalRefund,
      cogs,
      res.tax,
      res.net,
      full ? 'refunded' : 'partial_refund',
      dispute ? 1 : sale.disputed,
      nowIso(),
      note ? ` [возврат: ${str(note)}]` : '',
      id,
    );
    if (!sale.imported) {
      ledger(sale.mode, 'refund', -a, id, sale.item);
      const taxDiff = sale.tax_rub - res.tax;
      if (Math.abs(taxDiff) > 0.004) ledger(sale.mode, 'tax', taxDiff, id, 'перерасчёт налога после возврата');
    }
    audit('sale.refund', 'sale', id, { amount: a, restock, full });
    return one('SELECT * FROM sales WHERE id = ?', id);
  });
}

export function markDispute(id, won = true) {
  const sale = one('SELECT * FROM sales WHERE id = ?', id);
  if (!sale) throw err('продажа не найдена', 404);
  run('UPDATE sales SET disputed = 1, status = ? WHERE id = ?', won && sale.status === 'completed' ? 'disputed_won' : sale.status, id);
  audit('sale.dispute', 'sale', id, { won });
  return one('SELECT * FROM sales WHERE id = ?', id);
}

export function writeOff({ item, qty, note, mode }) {
  const s = getSettings();
  const m = modeOf(mode);
  const q = num(qty, 'количество', { min: 1, int: true });
  return tx(() => {
    const alloc = allocate(str(item, 160), m, q, s.inventory.costMethod);
    const at = nowIso();
    for (const a of alloc) run("INSERT INTO stock_movements(item, mode, purchase_id, type, qty, unit_cost_rub, ts, note) VALUES (?, ?, ?, 'writeoff', ?, ?, ?, ?)", str(item, 160), m, a.purchaseId, -a.qty, a.unitCost, at, str(note) || null);
    const loss = alloc.reduce((sum, a) => sum + a.qty * a.unitCost, 0);
    audit('stock.writeoff', 'stock', str(item, 160), { qty: q, loss, note });
    return { item, qty: q, lossRub: loss };
  });
}

export function reserve({ item, qty, note, mode }) {
  const m = modeOf(mode);
  const q = num(qty, 'количество', { min: 1, int: true });
  const i = str(item, 160);
  return tx(() => {
    const onHand = one('SELECT coalesce(sum(qty), 0) q FROM stock_movements WHERE item = ? AND mode = ?', i, m).q;
    if (onHand - reservedQty(i, m) < q) throw err(`нельзя зарезервировать ${q}: доступно ${onHand - reservedQty(i, m)}`, 409);
    const id = randomUUID();
    run('INSERT INTO reservations(id, item, mode, qty, created_at, note) VALUES (?, ?, ?, ?, ?, ?)', id, i, m, q, nowIso(), str(note) || null);
    audit('stock.reserve', 'stock', i, { qty: q, id });
    return { id, item: i, qty: q };
  });
}

export function release(id) {
  const r = run('UPDATE reservations SET released_at = ? WHERE id = ? AND released_at IS NULL', nowIso(), id);
  if (!r.changes) throw err('резерв не найден или уже снят', 404);
  audit('stock.release', 'stock', id);
  return { ok: true };
}

export const lists = {
  purchases: (mode = 'real', limit = 500) => all('SELECT * FROM purchases WHERE mode = ? ORDER BY purchased_at DESC LIMIT ?', mode, limit),
  sales: (mode = 'real', limit = 500) => all('SELECT * FROM sales WHERE mode = ? ORDER BY sold_at DESC LIMIT ?', mode, limit),
  reservations: (mode = 'real') => all('SELECT * FROM reservations WHERE mode = ? AND released_at IS NULL ORDER BY created_at DESC', mode),
  ledger: (mode = 'real', limit = 500) => all('SELECT * FROM cash_ledger WHERE mode = ? ORDER BY id DESC LIMIT ?', mode, limit),
};

/** Свои продажи товара: число и медианный срок от поступления партии до продажи (факт, а не сигнал) */
export function ownSalesStats(item) {
  const rows = all(
    `SELECT (julianday(m.ts) - julianday(p.received_at)) AS days
       FROM stock_movements m JOIN purchases p ON p.id = m.purchase_id
      WHERE m.type = 'sale' AND m.item = ? AND p.mode = 'real' AND p.received_at IS NOT NULL`,
    item,
  ).map((r) => Math.max(0, r.days));
  rows.sort((a, b) => a - b);
  const count = one("SELECT count(*) n FROM sales WHERE item = ? AND mode = 'real' AND status != 'cancelled'", item).n;
  return { count, medianDays: rows.length ? rows[Math.floor(rows.length / 2)] : null };
}
