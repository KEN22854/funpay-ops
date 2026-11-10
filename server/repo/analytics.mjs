// BI: метрики периода, сравнение периодов, ABC/XYZ, качество рекомендаций (precision, MAE прогноза).
// Определения знаменателей заданы явно — см. README.
import { all, one } from '../db/db.mjs';
import { getSettings } from './settings.mjs';

const ACTIVE = "status != 'cancelled'";

/**
 * Метрики за период [from, to).
 * Gross Profit = выручка − себестоимость проданного (COGS).
 * Net Profit   = сумма чистого результата продаж (после комиссий, вывода, исполнения, возвратов, налога).
 * ROI          = Net Profit / COGS — доходность денег, вложенных в проданный товар.
 * Capital Turnover = COGS / средняя стоимость запасов (начало и конец периода).
 */
export function metrics({ from, to, mode = 'real' }) {
  const s = all(`SELECT * FROM sales WHERE mode = ? AND sold_at >= ? AND sold_at < ? AND ${ACTIVE}`, mode, from, to);
  const sum = (f) => s.reduce((a, x) => a + f(x), 0);
  const orders = s.length;
  const revenue = sum((x) => x.revenue_rub);
  const cogs = sum((x) => x.cogs_rub);
  const fees = sum((x) => x.platform_fee_rub + x.withdraw_fee_rub);
  const net = sum((x) => x.net_rub);
  const refunds = s.filter((x) => ['refunded', 'partial_refund'].includes(x.status)).length;
  const disputes = s.filter((x) => x.disputed).length;
  const invAt = (t) => one('SELECT coalesce(sum(qty * unit_cost_rub), 0) v FROM stock_movements WHERE mode = ? AND ts < ?', mode, t).v;
  const invStart = invAt(from);
  const invEnd = invAt(to);
  const avgInv = (invStart + invEnd) / 2;
  const cash = all('SELECT type, sum(amount_rub) s FROM cash_ledger WHERE mode = ? AND ts >= ? AND ts < ? GROUP BY type', mode, from, to);
  const cashIn = cash.filter((c) => c.s > 0).reduce((a, c) => a + c.s, 0);
  const cashOut = cash.filter((c) => c.s < 0).reduce((a, c) => a + c.s, 0);
  return {
    from,
    to,
    orders,
    units: sum((x) => x.qty),
    revenue,
    cogs,
    fees,
    grossProfit: revenue - cogs,
    netProfit: net,
    netMarginPct: revenue ? (net / revenue) * 100 : null,
    roiPct: cogs ? (net / cogs) * 100 : null,
    aov: orders ? revenue / orders : null,
    refundRatePct: orders ? (refunds / orders) * 100 : null,
    disputeRatePct: orders ? (disputes / orders) * 100 : null,
    inventoryStart: invStart,
    inventoryEnd: invEnd,
    capitalTurnover: avgInv > 0 ? cogs / avgInv : null,
    cashFlow: { in: cashIn, out: cashOut, net: cashIn + cashOut, byType: Object.fromEntries(cash.map((c) => [c.type, c.s])) },
  };
}

/** Текущий период и предыдущий такой же длины */
export function comparePeriods({ from, to, mode = 'real' }) {
  const len = new Date(to) - new Date(from);
  const prevFrom = new Date(new Date(from).getTime() - len).toISOString();
  const cur = metrics({ from, to, mode });
  const prev = metrics({ from: prevFrom, to: from, mode });
  const delta = {};
  for (const k of ['revenue', 'netProfit', 'grossProfit', 'orders', 'aov', 'netMarginPct', 'roiPct']) {
    delta[k] = prev[k] ? ((cur[k] - prev[k]) / Math.abs(prev[k])) * 100 : null;
  }
  return { current: cur, previous: prev, deltaPct: delta };
}

/**
 * ABC — вклад товаров в прибыль (по убыванию, накопительно): A до abcA%, B до abcB%, C — остальное.
 * XYZ — стабильность спроса: коэффициент вариации понедельных продаж (шт). Нужна история ≥ 4 недель.
 * Границы задаются в настройках, а не зашиты.
 */
export function abcXyz({ from, to, mode = 'real' }) {
  const { abcA, abcB, xyzX, xyzY } = getSettings().analytics;
  const rows = all(`SELECT item, sum(net_rub) net, sum(revenue_rub) revenue, sum(qty) qty, count(*) orders, min(sold_at) first FROM sales WHERE mode = ? AND sold_at >= ? AND sold_at < ? AND ${ACTIVE} GROUP BY item`, mode, from, to);
  const positive = rows.filter((r) => r.net > 0).sort((a, b) => b.net - a.net);
  const total = positive.reduce((s, r) => s + r.net, 0);
  const weeks = Math.max(1, Math.round((new Date(to) - new Date(from)) / (7 * 86400_000)));
  const abc = new Map();
  let acc = 0;
  for (const r of positive) {
    const before = total ? (acc / total) * 100 : 0;
    acc += r.net;
    abc.set(r.item, before < abcA ? 'A' : before < abcB ? 'B' : 'C');
  }
  return rows
    .map((r) => {
      const weekly = new Array(weeks).fill(0);
      for (const s of all(`SELECT sold_at, qty FROM sales WHERE mode = ? AND item = ? AND sold_at >= ? AND sold_at < ? AND ${ACTIVE}`, mode, r.item, from, to)) {
        const w = Math.min(weeks - 1, Math.floor((new Date(s.sold_at) - new Date(from)) / (7 * 86400_000)));
        weekly[w] += s.qty;
      }
      const mean = weekly.reduce((a, x) => a + x, 0) / weeks;
      const sd = Math.sqrt(weekly.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, weeks - 1));
      const cv = mean > 0 ? sd / mean : null;
      return {
        item: r.item,
        net: r.net,
        revenue: r.revenue,
        qty: r.qty,
        sharePct: total && r.net > 0 ? (r.net / total) * 100 : 0,
        abc: r.net > 0 ? abc.get(r.item) : 'C',
        cv,
        // XYZ имеет смысл, только если товар наблюдается в продажах ≥ 4 недель и продан хотя бы 4 раза
        xyz: weeks < 4 || cv === null || r.orders < 4 || (new Date(to) - new Date(r.first)) / (7 * 86400_000) < 4 ? null : cv <= xyzX ? 'X' : cv <= xyzY ? 'Y' : 'Z',
      };
    })
    .sort((a, b) => b.net - a.net);
}

/**
 * Качество рекомендаций по фактическим исходам.
 * Исход известен, только когда вся партия, купленная по рекомендации, продана или списана.
 * Неизвестный исход не считается ни успехом, ни провалом.
 */
export function recommendationQuality() {
  const recs = all('SELECT * FROM recommendations');
  const out = { total: recs.length, purchased: 0, known: 0, profitable: 0, precision: null, maePerUnit: null, items: [] };
  const errors = [];
  for (const r of recs) {
    const ps = all("SELECT * FROM purchases WHERE recommendation_id = ? AND mode = 'real' AND status != 'cancelled'", r.id);
    if (!ps.length) continue;
    out.purchased++;
    const qty = ps.reduce((s, p) => s + p.qty, 0);
    const remaining = ps.reduce((s, p) => s + one('SELECT coalesce(sum(qty), 0) q FROM stock_movements WHERE purchase_id = ?', p.id).q, 0);
    const inTransit = ps.some((p) => p.status === 'in_transit');
    const saleIds = new Set(all(`SELECT DISTINCT sale_id FROM stock_movements WHERE sale_id IS NOT NULL AND purchase_id IN (${ps.map(() => '?').join(',')})`, ...ps.map((p) => p.id)).map((x) => x.sale_id));
    const sales = [...saleIds].map((id) => one('SELECT * FROM sales WHERE id = ?', id)).filter(Boolean);
    const soldQty = sales.reduce((s, x) => s + x.qty, 0);
    const net = sales.reduce((s, x) => s + x.net_rub, 0);
    const known = !inTransit && remaining === 0;
    if (known) {
      out.known++;
      const writtenOff = ps.reduce((s, p) => s + Math.abs(one("SELECT coalesce(sum(qty * unit_cost_rub), 0) v FROM stock_movements WHERE purchase_id = ? AND type = 'writeoff'", p.id).v), 0);
      const outcome = net - writtenOff;
      if (outcome > 0) out.profitable++;
      if (soldQty > 0 && r.forecast_net !== null) errors.push(Math.abs(outcome / soldQty - r.forecast_net));
    }
    out.items.push({ id: r.id, item: r.item, sourceId: r.source_id, forecastNet: r.forecast_net, qty, soldQty, actualNet: net, known });
  }
  out.precision = out.known ? out.profitable / out.known : null;
  out.maePerUnit = errors.length ? errors.reduce((a, x) => a + x, 0) / errors.length : null;
  return out;
}

export function exportCsv(kind, mode = 'real') {
  const tables = {
    sales: `SELECT sold_at, item, qty, unit_price, revenue_rub, sale_fee_pct, platform_fee_rub, withdraw_fee_rub, payout_rub, cogs_rub, fulfillment_rub, tax_rub, refund_rub, net_rub, status, disputed, cost_method, note FROM sales WHERE mode = ? ORDER BY sold_at`,
    purchases: `SELECT purchased_at, item, source_id, qty, unit_price, currency, fx_rate, fx_spread_pct, fees_rub, total_cost_rub, unit_cost_rub, status, received_at, note FROM purchases WHERE mode = ? ORDER BY purchased_at`,
    ledger: `SELECT ts, type, amount_rub, ref_id, note FROM cash_ledger WHERE mode = ? ORDER BY id`,
  };
  if (!tables[kind]) throw Object.assign(new Error('kind: sales | purchases | ledger'), { status: 400 });
  const rows = all(tables[kind], mode);
  if (!rows.length) return '﻿';
  const cell = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return '﻿' + [Object.keys(rows[0]).join(';'), ...rows.map((r) => Object.values(r).map(cell).join(';'))].join('\n');
}
