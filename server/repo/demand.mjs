// Demand Intelligence: скорость продаж по СОБСТВЕННЫМ продажам (факт) — основной сигнал ликвидности.
// Оценка Каплана–Мейера: проданные единицы — события, непроданные остатки — цензурированные наблюдения,
// поэтому залежавшийся товар не «улучшает» статистику. Доверительный интервал — по формуле Гринвуда.
import { all, one } from '../db/db.mjs';
import { median } from './history.mjs';

export const HORIZONS = [1, 3, 7, 14];

/**
 * Длительности (дни) от поступления партии до продажи каждой единицы + цензурированные остатки.
 * @param {{ item?: string, category?: string }} f
 */
export function durations({ item, category } = {}) {
  const where = [];
  const p = [];
  if (item) {
    where.push('p.item = ?');
    p.push(item);
  }
  if (category) {
    where.push('coalesce(p.category, ?) = ?');
    p.push('', category);
  }
  const w = where.length ? `AND ${where.join(' AND ')}` : '';
  const events = all(
    `SELECT (julianday(m.ts) - julianday(p.received_at)) AS d, -m.qty AS n
       FROM stock_movements m JOIN purchases p ON p.id = m.purchase_id
      WHERE m.type = 'sale' AND p.mode = 'real' AND p.received_at IS NOT NULL ${w}`,
    ...p,
  );
  const censored = all(
    `SELECT (julianday('now') - julianday(p.received_at)) AS d,
            (SELECT coalesce(sum(qty), 0) FROM stock_movements x WHERE x.purchase_id = p.id) AS n
       FROM purchases p
      WHERE p.mode = 'real' AND p.status = 'received' ${w}`,
    ...p,
  ).filter((r) => r.n > 0);
  return { events: events.map((r) => ({ d: Math.max(0, r.d), n: r.n })), censored: censored.map((r) => ({ d: Math.max(0, r.d), n: r.n })) };
}

/** Каплан–Мейер: S(t) — доля единиц, НЕ проданных к моменту t. */
export function kaplanMeier({ events, censored }) {
  const pts = [...events.map((e) => ({ ...e, ev: true })), ...censored.map((c) => ({ ...c, ev: false }))].sort((a, b) => a.d - b.d || (a.ev ? -1 : 1));
  let atRisk = pts.reduce((s, x) => s + x.n, 0);
  let S = 1;
  let gw = 0; // сумма для дисперсии Гринвуда
  const curve = [{ t: 0, S: 1, var: 0 }];
  for (let i = 0; i < pts.length; ) {
    const t = pts[i].d;
    let d = 0;
    let c = 0;
    while (i < pts.length && pts[i].d === t) {
      if (pts[i].ev) d += pts[i].n;
      else c += pts[i].n;
      i++;
    }
    if (d > 0 && atRisk > 0) {
      S *= 1 - d / atRisk;
      if (atRisk > d) gw += d / (atRisk * (atRisk - d));
      curve.push({ t, S, var: S * S * gw });
    }
    atRisk -= d + c;
  }
  return curve;
}

const at = (curve, t) => {
  let p = curve[0];
  for (const c of curve) {
    if (c.t <= t) p = c;
    else break;
  }
  return p;
};

/**
 * Вероятность продажи за 1/3/7/14 дней с 95% интервалом. null — мало данных (minEvents).
 */
export function sellProbability(f = {}, { minEvents = 5 } = {}) {
  const ds = durations(f);
  const nEvents = ds.events.reduce((s, e) => s + e.n, 0);
  const nCens = ds.censored.reduce((s, e) => s + e.n, 0);
  const base = { events: nEvents, censored: nCens, minEvents };
  if (nEvents < minEvents) return { ...base, enough: false, probs: null, medianDays: null, note: `нужно ≥ ${minEvents} собственных продаж, сейчас ${nEvents}` };
  const curve = kaplanMeier(ds);
  const probs = Object.fromEntries(
    HORIZONS.map((h) => {
      const p = at(curve, h);
      const se = Math.sqrt(p.var);
      return [h, { p: 1 - p.S, lo: Math.max(0, 1 - (p.S + 1.96 * se)), hi: Math.min(1, 1 - (p.S - 1.96 * se)) }];
    }),
  );
  const med = curve.find((c) => c.S <= 0.5);
  return { ...base, enough: true, probs, medianDays: med ? med.t : null, note: med ? null : 'половина единиц ещё не продана — медиана не достигнута' };
}

/**
 * Ценовые диапазоны: как отклонение цены продажи от минимальной цены FunPay в момент продажи
 * влияет на срок продажи и прибыль. Основа для «оптимальной» цены, когда данных достаточно.
 */
export const BANDS = [
  { key: 'below5', label: 'ниже рынка > 5%', lo: -Infinity, hi: -0.05, mid: -0.07 },
  { key: 'below', label: 'ниже рынка до 5%', lo: -0.05, hi: 0, mid: -0.02 },
  { key: 'at', label: 'на уровне рынка (до +5%)', lo: 0, hi: 0.05, mid: 0.02 },
  { key: 'above', label: 'выше рынка > 5%', lo: 0.05, hi: Infinity, mid: 0.08 },
];

export function priceBands({ item, minPerBand = 3, minTotal = 10 } = {}) {
  const sales = all(
    `SELECT s.id, s.unit_price, s.qty, s.net_rub, s.sold_at, s.watch_id FROM sales s
      WHERE s.mode = 'real' AND s.status != 'cancelled' AND s.watch_id IS NOT NULL ${item ? 'AND s.item = ?' : ''}`,
    ...(item ? [item] : []),
  );
  const rows = [];
  for (const s of sales) {
    // рынок в момент продажи: последний снимок FunPay не старше суток до продажи
    const snap = one(
      "SELECT min_rub FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' AND ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1",
      s.watch_id,
      s.sold_at,
      new Date(new Date(s.sold_at).getTime() - 86400_000).toISOString(),
    );
    if (!snap?.min_rub) continue;
    const days = one(
      `SELECT avg(julianday(m.ts) - julianday(p.received_at)) d FROM stock_movements m JOIN purchases p ON p.id = m.purchase_id WHERE m.sale_id = ? AND p.received_at IS NOT NULL`,
      s.id,
    )?.d;
    rows.push({ dev: s.unit_price / snap.min_rub - 1, days: days ?? null, netPerUnit: s.net_rub / s.qty });
  }
  const bands = BANDS.map((b) => {
    const r = rows.filter((x) => x.dev >= b.lo && x.dev < b.hi);
    const days = median(r.map((x) => x.days).filter((x) => x !== null));
    const net = r.length ? r.reduce((a, x) => a + x.netPerUnit, 0) / r.length : null;
    return { ...b, n: r.length, medianDays: days, avgNetPerUnit: net, netPerDay: net !== null && days !== null ? net / Math.max(0.5, days) : null };
  });
  const eligible = bands.filter((b) => b.n >= minPerBand && b.netPerDay !== null);
  const best = rows.length >= minTotal && eligible.length ? eligible.sort((a, b) => b.netPerDay - a.netPerDay)[0] : null;
  return {
    observations: rows.length,
    bands,
    best: best ? { key: best.key, label: best.label, mid: best.mid } : null,
    note: best ? null : `оптимальная цена появится при ≥ ${minTotal} своих продажах с известным рынком и ≥ ${minPerBand} в диапазоне (сейчас ${rows.length})`,
  };
}

/** Распределение собственных продаж по дням недели (сезонность внутри недели) */
export function weekdayProfile(item) {
  const rows = all(`SELECT strftime('%w', sold_at) w, sum(qty) q FROM sales WHERE mode = 'real' AND status != 'cancelled' ${item ? 'AND item = ?' : ''} GROUP BY w`, ...(item ? [item] : []));
  const out = Array(7).fill(0);
  for (const r of rows) out[Number(r.w)] = r.q;
  return out; // 0 = воскресенье
}
