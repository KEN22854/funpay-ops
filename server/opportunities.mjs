// Сборка торговых возможностей: результаты сканов × движок оценки × история × склад × риск × спрос.
import { createHash } from 'node:crypto';
import { checkCompliance } from './core/compliance.mjs';
import { matchOffer } from './core/attributes.mjs';
import { evaluate, LEGACY_MATCH, STATUS } from './core/engine.mjs';
import { ENGINE_VERSION } from './core/finance.mjs';
import { all, nowIso, one, run } from './db/db.mjs';
import { saleFeeFor, sourceFeeFor } from './repo/fees.mjs';
import { healthSummary } from './repo/health.mjs';
import { anomalies, changes, liquidity, series } from './repo/history.mjs';
import { ownSalesStats } from './repo/inventory.mjs';
import { capitalSnapshot, checkLimits, learnedLossPct } from './repo/risk.mjs';
import { priceBands, sellProbability } from './repo/demand.mjs';
import { sourceQuality } from './repo/quality.mjs';
import { openPaper } from './repo/paper.mjs';
import { getSettings, settingsHash } from './repo/settings.mjs';
import { discoveries, results, watches } from './repo/watches.mjs';

export const oppId = (watchId, sourceId, url) => createHash('sha1').update(`${watchId ?? 'd'}|${sourceId}|${url}`).digest('hex').slice(0, 20);

function offersOf(r) {
  return [...r.sources.flatMap((s) => (s.status === 'error' ? [] : s.offers)), ...r.manual];
}

const memo = (fn) => {
  const m = new Map();
  return (k) => {
    if (!m.has(k)) m.set(k, fn(k));
    return m.get(k);
  };
};

/**
 * @param {{ log?: boolean, only?: string }} opt
 * log  — записать кандидатов/рекомендации в журнал и открыть бумажные позиции (после скана, не при просмотре)
 * only — пересчитать одну связку (для перепроверки)
 */
export function buildOpportunities({ log = false, only = null } = {}) {
  const S = getSettings();
  const hash = settingsHash(S);
  const snap = capitalSnapshot('real');
  const health = memo((id) => ({ ...healthSummary(id), ...sourceQuality(id) }));
  const demandItem = memo((item) => sellProbability({ item }, { minEvents: S.demand.minOwnSales }));
  const demandCat = memo((cat) => sellProbability({ category: cat }, { minEvents: S.demand.minOwnSales }));
  const bandsItem = memo((item) => priceBands({ item }));
  const lossSrc = memo((src) => learnedLossPct({ sourceId: src }));
  const lossCat = memo((cat) => learnedLossPct({ category: cat }));
  // последняя перепроверка по каждой связке — одним запросом
  const verif = new Map(all('SELECT v.* FROM verifications v JOIN (SELECT opp_id, max(id) id FROM verifications GROUP BY opp_id) x ON x.id = v.id').map((v) => [v.opp_id, v]));
  // связки, подтверждённые своей сделкой: куплено по рекомендации и есть продажа
  const verifiedByTx = new Set(
    all("SELECT DISTINCT p.recommendation_id id FROM purchases p JOIN stock_movements m ON m.purchase_id = p.id WHERE m.type = 'sale' AND p.mode = 'real' AND p.recommendation_id IS NOT NULL").map((r) => r.id),
  );
  const out = [];

  const decide = ({ id, item, buy, market, saleFee, liq, own }) => {
    const bySrc = lossSrc(buy.sourceId);
    const learned = bySrc.n > 0 ? bySrc : lossCat(item.category);
    const di = demandItem(item.name);
    const demand = di.enough ? di : demandCat(item.category);
    return evaluate({
      item,
      buy,
      market,
      settings: S,
      saleFee,
      sourceFee: sourceFeeFor(buy.sourceId),
      health: buy.manual ? null : health(buy.sourceId),
      liquidity: liq,
      ownSales: own,
      demand,
      bands: bandsItem(item.name),
      learnedLoss: learned,
      compliance: item.compliance,
      capital: checkLimits({ cost: buy.priceRub, item: item.name, sourceId: buy.sourceId, category: item.category }, snap),
      verification: verif.get(id) ?? null,
    });
  };

  const push = (o) => {
    o.sourceFee = sourceFeeFor(o.buy.sourceId);
    o.verifiedByTransaction = verifiedByTx.has(o.id);
    out.push(o);
    if (!log || ![STATUS.RECOMMENDED, STATUS.CANDIDATE].includes(o.eval.status)) return;
    const f = o.eval.forecast;
    const now = nowIso();
    run(
      `INSERT INTO recommendations(id, watch_id, item, source_id, offer_url, first_seen, last_seen, status, score, forecast_net, forecast_price, buy_cost, data, engine_version, settings_hash, category, forecast_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, status = excluded.status, score = excluded.score, forecast_net = excluded.forecast_net,
         forecast_price = excluded.forecast_price, buy_cost = excluded.buy_cost, data = excluded.data, engine_version = excluded.engine_version,
         settings_hash = excluded.settings_hash, category = excluded.category, forecast_days = excluded.forecast_days`,
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
      JSON.stringify({ blocks: o.eval.blocks, assumptions: o.eval.assumptions, gaps: o.eval.executionGaps }),
      ENGINE_VERSION,
      hash,
      o.category,
      o.eval.daysToSell,
    );
    openPaper(o);
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
      const id = oppId(w.id, buy.sourceId, buy.url);
      if (only && id !== only) continue;
      const compliance = checkCompliance({ texts: [w.name, buy.title], sectionTitle: fp.title, category: w.category, buyType: buy.knownType });
      const item = { name: w.name, category: w.category, watchId: w.id, compliance };
      push({
        id,
        kind: 'watch',
        watchId: w.id,
        name: w.name,
        category: w.category,
        buy,
        market: { min: fp.min, count: fp.count, online: fp.online, sellers: fp.sellers, url: fp.top[0]?.url ?? fp.url, sectionUrl: fp.url, pricePer: fp.pricePer, fetchedAt: fp.fetchedAt },
        saleFee,
        liquidity: liq,
        compliance,
        eval: decide({ id, item, buy, market: fp, saleFee, liq, own }),
      });
    }
  }

  for (const d of Object.values(discoveries.all())) {
    const saleFee = saleFeeFor(d.funpay.url, S.costModel.defaultSaleFeePct);
    for (const it of d.items) {
      const own = ownSalesStats(it.name);
      for (const raw of it.buys) {
        const id = oppId(null, raw.sourceId, `${d.game}|${it.name}`);
        if (only && id !== only) continue;
        // сопоставление пересчитывается с текущей строгостью; данные прежней версии — на проверку
        const match = raw.match ? matchOffer({}, {}, { category: 'skins', title: it.name, nameExact: true, phase: raw.phase, skinsStrict: S.matching.skinsStrict }) : LEGACY_MATCH;
        const buy = { ...raw, fetchedAt: raw.fetchedAt ?? d.scannedAt, match };
        const fp = { ...it.funpay, fetchedAt: it.funpay.fetchedAt ?? d.scannedAt };
        const compliance = { level: 'ok', hits: [] };
        push({
          id,
          kind: 'discovery',
          name: it.name,
          category: 'skins',
          game: d.game,
          buy,
          market: { min: fp.min, count: fp.count, online: fp.online, sellers: fp.sellers, url: fp.top?.[0]?.url ?? d.funpay.url, sectionUrl: d.funpay.url, pricePer: 1, fetchedAt: fp.fetchedAt },
          saleFee,
          liquidity: null,
          compliance,
          eval: decide({ id, item: { name: it.name, category: 'skins', compliance }, buy, market: fp, saleFee, liq: null, own }),
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
