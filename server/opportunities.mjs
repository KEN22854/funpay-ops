// Сборка торговых возможностей: результаты сканов × движок оценки × история × склад.
import { createHash } from 'node:crypto';
import { checkCompliance } from './core/compliance.mjs';
import { evaluate, LEGACY_MATCH, STATUS } from './core/engine.mjs';
import { all, nowIso, one, run } from './db/db.mjs';
import { saleFeeFor, sourceFeeFor } from './repo/fees.mjs';
import { healthSummary } from './repo/health.mjs';
import { anomalies, changes, liquidity, series } from './repo/history.mjs';
import { cashBalance, cashTracking, ownSalesStats } from './repo/inventory.mjs';
import { getSettings } from './repo/settings.mjs';
import { discoveries, results, watches } from './repo/watches.mjs';

const recId = (watchId, sourceId, url) => createHash('sha1').update(`${watchId ?? 'd'}|${sourceId}|${url}`).digest('hex').slice(0, 20);

function offersOf(r) {
  return [...r.sources.flatMap((s) => (s.status === 'error' ? [] : s.offers)), ...r.manual];
}

/**
 * @param {{ includeBlocked?: boolean, log?: boolean }} opt
 * log — записать RECOMMENDED в журнал рекомендаций (вызывается после скана, а не при каждом просмотре)
 */
export function buildOpportunities({ log = false } = {}) {
  const S = getSettings();
  const cash = { tracking: cashTracking('real'), balance: cashBalance('real') };
  const healthCache = new Map();
  const health = (id) => {
    if (!healthCache.has(id)) healthCache.set(id, healthSummary(id));
    return healthCache.get(id);
  };
  const out = [];

  const push = (o) => {
    out.push(o);
    if (log && o.eval.status === STATUS.RECOMMENDED) {
      const f = o.eval.forecast;
      const now = nowIso();
      run(
        `INSERT INTO recommendations(id, watch_id, item, source_id, offer_url, first_seen, last_seen, status, score, forecast_net, forecast_price, buy_cost, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, status = excluded.status, score = excluded.score, forecast_net = excluded.forecast_net, forecast_price = excluded.forecast_price, buy_cost = excluded.buy_cost, data = excluded.data`,
        o.id,
        o.watchId ?? null,
        o.name,
        o.buy.sourceId,
        o.buy.url ?? '',
        now,
        now,
        o.eval.status,
        o.eval.score,
        f?.net ?? null,
        f?.price ?? null,
        f?.invested ?? null,
        JSON.stringify({ blocks: o.eval.blocks, assumptions: o.eval.assumptions }),
      );
    }
  };

  const allResults = results.all();
  for (const w of watches.list()) {
    const r = allResults[w.id];
    if (!r || !r.funpay || r.funpay.status !== 'ok') continue;
    const fp = r.funpay;
    const saleFee = saleFeeFor(fp.url, S.costModel.defaultSaleFeePct);
    const own = ownSalesStats(w.name);
    const liq = liquidity(w.id, own);
    for (const buy of offersOf(r)) {
      const compliance = checkCompliance({ texts: [w.name, buy.title], sectionTitle: fp.title, category: w.category, buyType: buy.knownType });
      const ev = evaluate({
        item: { name: w.name, category: w.category, watchId: w.id },
        buy,
        market: fp,
        settings: S,
        saleFee,
        sourceFee: sourceFeeFor(buy.sourceId),
        health: buy.manual ? null : health(buy.sourceId),
        liquidity: liq,
        ownSales: own,
        compliance,
        cash,
      });
      push({
        id: recId(w.id, buy.sourceId, buy.url),
        kind: 'watch',
        watchId: w.id,
        name: w.name,
        category: w.category,
        buy,
        market: { min: fp.min, count: fp.count, online: fp.online, sellers: fp.sellers, url: fp.top[0]?.url ?? fp.url, sectionUrl: fp.url, pricePer: fp.pricePer, fetchedAt: fp.fetchedAt },
        saleFee,
        liquidity: liq,
        compliance,
        eval: ev,
      });
    }
  }

  for (const d of Object.values(discoveries.all())) {
    const saleFee = saleFeeFor(d.funpay.url, S.costModel.defaultSaleFeePct);
    for (const it of d.items) {
      const own = ownSalesStats(it.name);
      for (const raw of it.buys) {
        // данные автопоиска прежней версии — без времени и сопоставления
        const buy = { ...raw, fetchedAt: raw.fetchedAt ?? d.scannedAt, match: raw.match ?? LEGACY_MATCH };
        const fp = { ...it.funpay, fetchedAt: it.funpay.fetchedAt ?? d.scannedAt };
        const ev = evaluate({
          item: { name: it.name, category: 'skins' },
          buy,
          market: fp,
          settings: S,
          saleFee,
          sourceFee: sourceFeeFor(buy.sourceId),
          health: health(buy.sourceId),
          liquidity: null,
          ownSales: own,
          compliance: { level: 'ok', hits: [] },
          cash,
        });
        push({
          id: recId(null, buy.sourceId, `${d.game}|${it.name}`),
          kind: 'discovery',
          name: it.name,
          category: 'skins',
          game: d.game,
          buy,
          market: { min: fp.min, count: fp.count, online: fp.online, sellers: fp.sellers, url: fp.top?.[0]?.url ?? d.funpay.url, sectionUrl: d.funpay.url, pricePer: 1, fetchedAt: fp.fetchedAt },
          saleFee,
          liquidity: null,
          compliance: { level: 'ok', hits: [] },
          eval: ev,
        });
      }
    }
  }
  return out;
}

/** Рыночная сводка по товарам: тренды, предложение, концентрация, аномалии — для режимов Market/Trend/Stock/Competitor/Demand */
export function marketOverview() {
  const S = getSettings();
  return watches.list().map((w) => {
    const fp = series(w.id, 'funpay', 'funpay', 30);
    const last = fp[fp.length - 1] ?? null;
    const srcIds = all("SELECT DISTINCT source_id FROM price_snapshots WHERE watch_id = ? AND kind = 'source'", w.id).map((r) => r.source_id);
    const sources = srcIds.map((id) => {
      const rows = series(w.id, 'source', id, 30);
      const l = rows[rows.length - 1];
      const ch = changes(rows);
      // «недооценённость»: текущая цена ниже своей усечённой медианы за 7 дней
      const week = rows.filter((r) => new Date(r.ts) > Date.now() - 7 * 86400_000).map((r) => r.min_rub);
      const base = week.length >= 3 ? week.slice().sort((a, b) => a - b)[Math.floor(week.length / 2)] : null;
      return { sourceId: id, last: l?.min_rub ?? null, ts: l?.ts ?? null, changes: ch, vs7dMedianPct: base && l ? ((l.min_rub - base) / base) * 100 : null, points: rows.length };
    });
    return {
      watchId: w.id,
      name: w.name,
      category: w.category,
      funpay: last
        ? {
            min: last.min_rub,
            median: last.median_rub,
            trimmed: last.trimmed_rub,
            count: last.count,
            sellers: last.sellers,
            online: last.online,
            topSellerShare: last.top_seller_share,
            changes: changes(fp),
            countChanges: changes(fp, 'count'),
            anomalies: anomalies(fp, { expectedGapMin: S.intervalMin || 60 }).slice(-5),
            points: fp.length,
            ts: last.ts,
          }
        : null,
      liquidity: liquidity(w.id, ownSalesStats(w.name)),
      sources,
    };
  });
}

export function historyFor(watchId, days = 30) {
  const fp = series(watchId, 'funpay', 'funpay', days);
  const srcIds = all("SELECT DISTINCT source_id FROM price_snapshots WHERE watch_id = ? AND kind = 'source'", watchId).map((r) => r.source_id);
  return {
    funpay: fp,
    sources: Object.fromEntries(srcIds.map((id) => [id, series(watchId, 'source', id, days)])),
    anomalies: anomalies(fp),
    lastScan: one("SELECT max(ts) ts FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay'", watchId)?.ts ?? null,
  };
}
