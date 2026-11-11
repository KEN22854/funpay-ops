// Capital & Risk Manager: капитал, резервы, концентрация по товару/источнику/категории,
// старение запасов, прогноз денежного потока, обученные по своим сделкам потери на возвратах.
import { randomUUID } from 'node:crypto';
import { all, nowIso, one, run } from '../db/db.mjs';
import { audit } from './audit.mjs';
import { cashBalance, cashTracking } from './inventory.mjs';
import { getSettings } from './settings.mjs';
import { sellProbability } from './demand.mjs';

/* ───────────── резерв денег под плановые закупки ───────────── */

export function reservedCash(mode = 'real') {
  return one('SELECT coalesce(sum(amount_rub), 0) s FROM cash_reservations WHERE mode = ? AND released_at IS NULL', mode).s;
}

export function reserveCash({ amount, item, sourceId, oppId, note, mode = 'real' }) {
  const a = Number(amount);
  if (!(a > 0)) throw Object.assign(new Error('сумма резерва должна быть больше 0'), { status: 400 });
  const m = mode === 'sim' ? 'sim' : 'real';
  if (cashTracking(m) && a > cashBalance(m) - reservedCash(m)) throw Object.assign(new Error('нельзя зарезервировать больше свободных денег'), { status: 409 });
  const id = randomUUID();
  run('INSERT INTO cash_reservations(id, mode, amount_rub, item, source_id, opp_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, m, a, item ?? null, sourceId ?? null, oppId ?? null, note ?? null, nowIso());
  audit('cash.reserve', 'cash', id, { amount: a, item, oppId });
  return { id };
}

export function releaseCash(id) {
  const r = run('UPDATE cash_reservations SET released_at = ? WHERE id = ? AND released_at IS NULL', nowIso(), id);
  if (!r.changes) throw Object.assign(new Error('резерв не найден или уже снят'), { status: 404 });
  audit('cash.release', 'cash', id);
  return { ok: true };
}

export const listCashReservations = (mode = 'real') => all('SELECT * FROM cash_reservations WHERE mode = ? AND released_at IS NULL ORDER BY created_at DESC', mode);

/* ───────────── капитал и концентрация ───────────── */

const sumBy = (rows, key) => rows.reduce((m, r) => ((m[r[key] ?? '—'] = (m[r[key] ?? '—'] ?? 0) + r.v), m), {});

/** Где сейчас деньги: касса, резерв, запасы (по себестоимости), товар в пути */
export function capitalSnapshot(mode = 'real') {
  const stockRows = all(
    `SELECT m.item, p.source_id, coalesce(p.category, '') category, sum(m.qty * m.unit_cost_rub) v
       FROM stock_movements m LEFT JOIN purchases p ON p.id = m.purchase_id
      WHERE m.mode = ? GROUP BY m.item, p.source_id, p.category`,
    mode,
  ).filter((r) => r.v > 0.005);
  const transit = all("SELECT item, source_id, coalesce(category, '') category, total_cost_rub v FROM purchases WHERE mode = ? AND status = 'in_transit'", mode);
  const inventory = stockRows.reduce((s, r) => s + r.v, 0);
  const inTransit = transit.reduce((s, r) => s + r.v, 0);
  const tracking = cashTracking(mode);
  const cash = tracking ? cashBalance(mode) : null;
  const reserved = reservedCash(mode);
  const total = (cash ?? 0) + inventory + inTransit;
  const both = [...stockRows, ...transit];
  return {
    tracking,
    cash,
    reserved,
    freeCash: cash === null ? null : cash - reserved,
    inventory,
    inTransit,
    total,
    /** доля капитала, работающая в товаре (Capital utilization) */
    utilization: total > 0 ? (inventory + inTransit) / total : null,
    byItem: sumBy(both, 'item'),
    bySource: sumBy(both, 'source_id'),
    byCategory: sumBy(both, 'category'),
  };
}

/**
 * Проверка лимитов для новой закупки стоимостью cost.
 * @returns {{ blocks: string[], warnings: string[] }}
 */
export function checkLimits({ cost, item, sourceId, category, limitFactor = 1 }, snap = capitalSnapshot('real')) {
  const R = getSettings().risk;
  // политика источника сужает лимиты: испытательный срок — половина обычной доли и суммы сделки
  const k = Math.max(0, Math.min(1, Number(limitFactor)));
  const blocks = [];
  const warnings = [];
  const maxDeal = getSettings().inventory.maxPurchaseRub * k;
  if (maxDeal > 0 && cost > maxDeal) blocks.push(`сделка ${cost.toFixed(0)} ₽ больше лимита на сделку ${maxDeal.toFixed(0)} ₽${k < 1 ? ` (×${k} по политике источника)` : ''}`);
  if (snap.freeCash !== null && cost > snap.freeCash) blocks.push(`не хватает свободных денег: ${snap.freeCash.toFixed(0)} ₽ (с учётом резерва ${snap.reserved.toFixed(0)} ₽)`);
  // доли считаются от известного капитала (касса + запасы); без кассы капитал неизвестен — только предупреждение
  const total = snap.total;
  if (!snap.tracking || total <= 0) {
    warnings.push('капитал не задан — доли по товару/источнику не проверяются (задайте стартовый капитал)');
    return { blocks, warnings };
  }
  const share = (cur) => ((cur + cost) / total) * 100;
  const checks = [
    ['товар', item, snap.byItem[item] ?? 0, R.maxItemSharePct * k],
    ['источник', sourceId, snap.bySource[sourceId] ?? 0, R.maxSourceSharePct * k],
    ['категория', category, snap.byCategory[category ?? ''] ?? 0, R.maxCategorySharePct],
  ];
  for (const [label, key, cur, limit] of checks) {
    if (!limit || !key) continue;
    const s = share(cur);
    if (s > limit) blocks.push(`доля капитала в ${label === 'категория' ? 'категории' : label === 'источник' ? 'источнике' : 'товаре'} «${key}» станет ${s.toFixed(0)}% (лимит ${+limit.toFixed(1)}%)`);
    else if (s > limit * 0.8) warnings.push(`доля капитала в «${key}» приближается к лимиту: ${s.toFixed(0)}% из ${limit}%`);
  }
  return { blocks, warnings };
}

/* ───────────── старение запасов ───────────── */

const AGE_BUCKETS = [
  { key: '0-7', max: 7 },
  { key: '8-30', max: 30 },
  { key: '31-90', max: 90 },
  { key: '90+', max: Infinity },
];

export function aging(mode = 'real') {
  const rows = all(
    `SELECT p.id, p.item, p.received_at, p.unit_cost_rub,
            (SELECT coalesce(sum(qty), 0) FROM stock_movements m WHERE m.purchase_id = p.id) AS remaining
       FROM purchases p WHERE p.mode = ? AND p.status = 'received'`,
    mode,
  ).filter((r) => r.remaining > 0);
  const stale = getSettings().risk.staleStockDays;
  const buckets = AGE_BUCKETS.map((b) => ({ key: b.key, qty: 0, value: 0 }));
  const items = rows.map((r) => {
    const age = (Date.now() - new Date(r.received_at).getTime()) / 86400_000;
    const bi = AGE_BUCKETS.findIndex((b) => age <= b.max);
    buckets[bi].qty += r.remaining;
    buckets[bi].value += r.remaining * r.unit_cost_rub;
    return { purchaseId: r.id, item: r.item, ageDays: age, qty: r.remaining, value: r.remaining * r.unit_cost_rub, stale: age > stale };
  });
  return { buckets, items: items.sort((a, b) => b.ageDays - a.ageDays), frozen: items.filter((i) => i.stale).reduce((s, i) => s + i.value, 0), staleDays: stale };
}

/**
 * Прогноз денежного потока на 7/14/30 дней: ожидаемые поступления от продажи остатков
 * (по вероятности продажи из своих данных, иначе — допущение) минус резервы плановых закупок.
 */
export function cashFlowForecast(mode = 'real') {
  const S = getSettings();
  const stockItems = all(
    `SELECT m.item, sum(m.qty) qty, sum(m.qty * m.unit_cost_rub) v FROM stock_movements m WHERE m.mode = ? GROUP BY m.item HAVING sum(m.qty) > 0`,
    mode,
  );
  const horizons = [7, 14, 30];
  const out = horizons.map((h) => ({ days: h, inflow: 0, outflow: reservedCash(mode), basis: [] }));
  for (const it of stockItems) {
    // ожидаемая цена продажи: последняя продажа товара или себестоимость (консервативно)
    const last = one("SELECT unit_price FROM sales WHERE item = ? AND mode = 'real' AND status != 'cancelled' ORDER BY sold_at DESC LIMIT 1", it.item)?.unit_price;
    const unitPayout = (last ?? it.v / it.qty) * (1 - S.costModel.defaultSaleFeePct / 100) * (1 - S.costModel.withdrawPct / 100);
    const sp = sellProbability({ item: it.item });
    for (const o of out) {
      // P(продано ≤ h): из собственной статистики, иначе равномерно за допущенный срок продажи
      const p = sp.enough ? (o.days >= 14 ? sp.probs[14].p : sp.probs[7].p) : Math.min(1, o.days / Math.max(1, S.costModel.expectedDaysToSell * 2));
      o.inflow += it.qty * unitPayout * p;
      o.basis.push({ item: it.item, qty: it.qty, p, fromOwnData: sp.enough });
    }
  }
  return out.map((o) => ({ ...o, net: o.inflow - o.outflow }));
}

/* ───────────── обученные потери на возвратах и спорах ───────────── */

/**
 * Ожидаемые потери в % от цены для категории/источника по своим продажам,
 * сглаженные к значению из параметров (prior) — малое число сделок не дёргает модель.
 */
export function learnedLossPct({ category, sourceId }) {
  const S = getSettings();
  const prior = S.costModel.disputePct;
  const k = S.risk.lossPriorWeight;
  const rows = sourceId
    ? all(
        `SELECT DISTINCT s.id, s.revenue_rub, s.refund_rub FROM sales s JOIN stock_movements m ON m.sale_id = s.id JOIN purchases p ON p.id = m.purchase_id
          WHERE s.mode = 'real' AND s.status != 'cancelled' AND p.source_id = ?`,
        sourceId,
      )
    : all(
        `SELECT s.id, s.revenue_rub, s.refund_rub FROM sales s LEFT JOIN purchases p ON p.watch_id = s.watch_id
          WHERE s.mode = 'real' AND s.status != 'cancelled' AND coalesce(p.category, '') = ? GROUP BY s.id`,
        category ?? '',
      );
  const n = rows.length;
  const revenue = rows.reduce((a, r) => a + r.revenue_rub, 0);
  const lost = rows.reduce((a, r) => a + r.refund_rub, 0);
  const observed = revenue > 0 ? (lost / revenue) * 100 : null;
  const pct = observed === null ? prior : (prior * k + observed * n) / (k + n);
  return { pct, prior, observed, n, scope: sourceId ? `источник ${sourceId}` : `категория ${category || '—'}` };
}
