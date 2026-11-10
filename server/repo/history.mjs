// История рынка: временные ряды цен, изменения за 1ч/24ч/7д/30д, аномалии, сигналы ликвидности.
// Важно: исчезновение лота — НАБЛЮДАЕМЫЙ СИГНАЛ, а не подтверждённая продажа (лот могли снять, удалить, изменить).
import { all, nowIso, one, run, tx } from '../db/db.mjs';

export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** медиана после отбрасывания по 10% самых дешёвых и дорогих (не меньше 1 с каждой стороны при n ≥ 5) */
export function trimmedMedian(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length < 5) return median(s);
  const k = Math.max(1, Math.floor(s.length * 0.1));
  return median(s.slice(k, s.length - k));
}

const offerId = (url) => String(url).match(/[?&]id=([\w-]+)/)?.[1] ?? url;

/**
 * Сохранить снимок FunPay: цены подходящих лотов, продавцы, концентрация, появившиеся/исчезнувшие лоты.
 * @param offers подходящие (не REJECTED) лоты FunPay
 */
export function snapshotFunpay(watchId, offers, { expectedGapMin = 60 } = {}) {
  const ts = nowIso();
  const prices = offers.map((o) => o.price);
  const bySeller = new Map();
  for (const o of offers) bySeller.set(o.seller, (bySeller.get(o.seller) ?? 0) + 1);
  const topShare = offers.length ? Math.max(...bySeller.values()) / offers.length : null;

  return tx(() => {
    const prevScan = one("SELECT ts FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' ORDER BY ts DESC LIMIT 1", watchId)?.ts;
    // если прошлый скан был давно — исчезновения не считаем (пропуск наблюдений, а не продажи)
    const comparable = prevScan && Date.now() - new Date(prevScan).getTime() <= expectedGapMin * 3 * 60_000;
    const current = new Set(offers.map((o) => offerId(o.url)));
    let appeared = 0;
    let disappeared = null;
    if (comparable) {
      const prevIds = all('SELECT offer_id FROM funpay_lots_seen WHERE watch_id = ? AND last_seen = ?', watchId, prevScan).map((r) => r.offer_id);
      disappeared = prevIds.filter((id) => !current.has(id)).length;
    }
    for (const o of offers) {
      const id = offerId(o.url);
      const existed = one('SELECT 1 FROM funpay_lots_seen WHERE watch_id = ? AND offer_id = ?', watchId, id);
      if (!existed && prevScan) appeared++;
      run(
        'INSERT INTO funpay_lots_seen(watch_id, offer_id, seller, first_seen, last_seen, last_price) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(watch_id, offer_id) DO UPDATE SET last_seen = excluded.last_seen, last_price = excluded.last_price, seller = excluded.seller',
        watchId,
        id,
        o.seller,
        ts,
        ts,
        o.price,
      );
    }
    run(
      "INSERT INTO price_snapshots(watch_id, kind, source_id, ts, currency, fx_rate, min_rub, median_rub, trimmed_rub, count, sellers, online, top_seller_share, appeared, disappeared, best_url) VALUES (?, 'funpay', 'funpay', ?, 'RUB', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      watchId,
      ts,
      prices.length ? Math.min(...prices) : null,
      median(prices),
      trimmedMedian(prices),
      offers.length,
      bySeller.size,
      offers.filter((o) => o.online).length,
      topShare,
      comparable || !prevScan ? (prevScan ? appeared : null) : null,
      disappeared,
      [...offers].sort((a, b) => a.price - b.price)[0]?.url ?? null,
    );
    return { ts, comparable: Boolean(comparable) };
  });
}

/** Снимок источника: лучшая цена подходящих предложений с исходной валютой и курсом */
export function snapshotSource(watchId, sourceId, offers) {
  if (!offers.length) return;
  const best = [...offers].sort((a, b) => a.priceRub - b.priceRub)[0];
  const rubs = offers.map((o) => o.priceRub);
  run(
    "INSERT INTO price_snapshots(watch_id, kind, source_id, ts, currency, fx_rate, min_rub, median_rub, trimmed_rub, count, stock, best_url) VALUES (?, 'source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    watchId,
    sourceId,
    best.fetchedAt ?? nowIso(),
    best.currency,
    best.fxRate ?? (best.price > 0 ? best.priceRub / best.price : null),
    best.priceRub,
    median(rubs),
    trimmedMedian(rubs),
    offers.length,
    best.stock ?? null,
    best.url,
  );
}

const WINDOWS = { '1h': 3600_000, '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };

/** Ряд снимков и изменения минимальной цены за окна */
export function series(watchId, kind, sourceId, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return all('SELECT * FROM price_snapshots WHERE watch_id = ? AND kind = ? AND source_id = ? AND ts >= ? ORDER BY ts', watchId, kind, sourceId, since);
}

export function changes(rows, field = 'min_rub') {
  if (!rows.length) return {};
  const last = rows[rows.length - 1];
  const out = {};
  for (const [k, ms] of Object.entries(WINDOWS)) {
    const target = new Date(last.ts).getTime() - ms;
    // ближайший снимок не позже начала окна
    let base = null;
    for (const r of rows) {
      if (new Date(r.ts).getTime() <= target) base = r;
      else break;
    }
    out[k] = base && base[field] > 0 && last[field] !== null ? ((last[field] - base[field]) / base[field]) * 100 : null;
  }
  return out;
}

/** Аномалии: скачок > threshold% от медианы предыдущих 10 точек; пропуски наблюдений > 3× ожидаемого интервала */
export function anomalies(rows, { field = 'min_rub', threshold = 30, expectedGapMin = 60 } = {}) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows.slice(Math.max(0, i - 10), i).map((r) => r[field]);
    const m = median(prev);
    const v = rows[i][field];
    if (m && v !== null && Math.abs(v - m) / m > threshold / 100) out.push({ ts: rows[i].ts, type: 'jump', value: v, baseline: m, pct: ((v - m) / m) * 100 });
    const gap = (new Date(rows[i].ts) - new Date(rows[i - 1].ts)) / 60000;
    if (gap > expectedGapMin * 3) out.push({ ts: rows[i].ts, type: 'gap', minutes: Math.round(gap) });
  }
  return out;
}

/**
 * Сигналы ликвидности. Разделены: наблюдаемый сигнал (лоты, исчезновения) vs факт (свои продажи).
 * confidence зависит от длительности наблюдения и числа собственных продаж.
 */
export function liquidity(watchId, ownSales = { count: 0, medianDays: null }) {
  const rows = series(watchId, 'funpay', 'funpay', 30);
  if (!rows.length) return { observed: null, fact: ownSales, confidence: 'none', note: 'нет истории наблюдений' };
  const last = rows[rows.length - 1];
  const spanDays = (new Date(last.ts) - new Date(rows[0].ts)) / 86400_000;
  const comparable = rows.filter((r) => r.disappeared !== null);
  const avgLots = median(rows.map((r) => r.count)) || 0;
  const dis = comparable.reduce((s, r) => s + r.disappeared, 0);
  const comparableSpanDays = comparable.length ? Math.max(1 / 24, spanDays) : 0;
  const mins = rows.map((r) => r.min_rub).filter((x) => x > 0);
  const mean = mins.reduce((s, x) => s + x, 0) / (mins.length || 1);
  const cv = mins.length > 1 ? Math.sqrt(mins.reduce((s, x) => s + (x - mean) ** 2, 0) / (mins.length - 1)) / mean : null;
  const confidence = ownSales.count >= 10 && spanDays >= 7 ? 'high' : ownSales.count >= 3 || spanDays >= 3 ? 'medium' : 'low';
  return {
    observed: {
      activeLots: last.count,
      sellers: last.sellers,
      online: last.online,
      topSellerShare: last.top_seller_share,
      /** исчезновений лотов в сутки на один активный лот — НЕ продажи */
      disappearPerLotDay: comparable.length && avgLots ? dis / avgLots / comparableSpanDays : null,
      disappearedTotal: comparable.length ? dis : null,
      priceVolatilityCv: cv,
      observationDays: spanDays,
      snapshots: rows.length,
    },
    fact: ownSales,
    confidence,
    note: 'исчезновение лота ≠ продажа: лот могли снять, удалить или изменить',
  };
}

export function prunesnapshots(days = 120) {
  run('DELETE FROM price_snapshots WHERE ts < ?', new Date(Date.now() - days * 86400_000).toISOString());
  run('DELETE FROM funpay_lots_seen WHERE last_seen < ?', new Date(Date.now() - days * 86400_000).toISOString());
}
