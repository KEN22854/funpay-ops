// Strategy Backtesting: воспроизведение истории снимков без заглядывания в будущее.
// В момент t решение принимается ТОЛЬКО по снимкам ≤ t, по комиссии и параметрам, действовавшим (и известным) на t.
//
// Режимы параметров:
//   historical — параметры на момент каждого решения (из истории изменений). Поздние изменения настроек
//                не меняют результат старого периода: прогон воспроизводим.
//   current    — сегодняшние параметры на всей истории («что было бы, если бы я торговал так»).
// Симуляция:
//   realistic  — задержка поставки, вероятность продажи (пока наша цена конкурентна), бюджет,
//                число одновременных позиций, ожидаемые возвраты, принудительный выход по рынку в конце горизонта.
//   proxy      — выход по рыночной переоценке через горизонт (как в 2.1).
import { createHash } from 'node:crypto';
import { all, nowIso, run } from '../db/db.mjs';
import { ENGINE_VERSION, forecast } from '../core/finance.mjs';
import { saleFeeFor, sourceFeeFor } from './fees.mjs';
import { getSettings, settingsHash, settingsTimeline } from './settings.mjs';
import { watches } from './watches.mjs';

export const STRATEGIES = ['fast', 'balanced', 'max'];
const DAY = 86400_000;
const ms = (iso) => new Date(iso).getTime();

/** рыночный режим в момент t: изменение минимальной цены FunPay за предыдущие 7 дней */
function regimeAt(fp, i) {
  const t = ms(fp[i].ts);
  let ref = null;
  for (let j = i - 1; j >= 0; j--) {
    if (t - ms(fp[j].ts) >= 7 * DAY) {
      ref = fp[j];
      break;
    }
    ref = fp[j];
  }
  if (!ref || ms(fp[i].ts) - ms(ref.ts) < DAY) return 'мало истории';
  const ch = (fp[i].min_rub - ref.min_rub) / ref.min_rub;
  return ch > 0.05 ? 'рост' : ch < -0.05 ? 'падение' : 'флэт';
}

function group(list, key) {
  const out = {};
  for (const x of list) {
    const k = x[key] ?? '—';
    const g = (out[k] ??= { trades: 0, net: 0, invested: 0, wins: 0 });
    g.trades++;
    g.net += x.net;
    g.invested += x.invested;
    if (x.net > 0) g.wins++;
  }
  for (const g of Object.values(out)) {
    g.roiPct = g.invested ? (g.net / g.invested) * 100 : null;
    g.winRate = g.trades ? g.wins / g.trades : null;
    delete g.wins;
  }
  return out;
}

function stats(list) {
  const sorted = [...list].sort((a, b) => a.exit.localeCompare(b.exit));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of sorted) {
    cum += x.net;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const invested = sorted.reduce((a, x) => a + x.invested, 0);
  const events = sorted.flatMap((x) => [
    { t: x.entry, d: x.invested },
    { t: x.exit, d: -x.invested },
  ]).sort((a, b) => a.t.localeCompare(b.t) || a.d - b.d);
  let open = 0;
  let peakOpen = 0;
  let area = 0;
  for (let i = 0; i < events.length; i++) {
    open += events[i].d;
    peakOpen = Math.max(peakOpen, open);
    if (i + 1 < events.length) area += open * (ms(events[i + 1].t) - ms(events[i].t));
  }
  const span = events.length ? ms(events.at(-1).t) - ms(events[0].t) : 0;
  const wins = sorted.filter((x) => x.net > 0).length;
  return {
    trades: sorted.length,
    netProfit: cum,
    roiPct: invested ? (cum / invested) * 100 : null,
    winRate: sorted.length ? wins / sorted.length : null,
    falsePositiveRate: sorted.length ? 1 - wins / sorted.length : null,
    maxDrawdown: dd,
    turnover: peakOpen ? invested / peakOpen : null,
    capitalUtilization: peakOpen && span ? area / span / peakOpen : null,
    forecastMae: sorted.length ? sorted.reduce((a, x) => a + Math.abs(x.forecastNet - x.net), 0) / sorted.length : null,
    peakCapital: peakOpen,
  };
}

/**
 * @param {object} p
 * @param {number} [p.horizonDays=7]   максимум дней в позиции; дальше — выход по рынку
 * @param {number} [p.minNet=0]        порог чистой прибыли для входа
 * @param {number} [p.minRoiPct=0]     порог ROI для входа
 * @param {number} [p.sinceDays=90]    глубина истории
 * @param {'historical'|'current'} [p.mode='historical']
 * @param {'realistic'|'proxy'} [p.simulation='realistic']
 * @param {number} [p.budgetRub=0]     стартовый капитал стратегии (0 — без ограничения)
 * @param {number} [p.maxConcurrent=0] одновременных позиций (0 — без ограничения)
 * @param {number} [p.deliveryDelayH=1] задержка поставки: продавать можно только после неё
 * @param {number} [p.refundPct=0]     ожидаемые возвраты сверх параметров, % от закупки
 * @param {string} [p.asOf]            учитывать только данные, известные на этот момент (воспроизведение прогона)
 */
export function runBacktest(p = {}) {
  const horizonDays = Math.max(0.1, Number(p.horizonDays ?? 7));
  const minNet = Number(p.minNet ?? 0) || 0;
  const minRoiPct = Number(p.minRoiPct ?? 0) || 0;
  const sinceDays = Math.max(1, Number(p.sinceDays ?? 90));
  const mode = p.mode === 'current' ? 'current' : 'historical';
  const simulation = p.simulation === 'proxy' ? 'proxy' : 'realistic';
  const budgetRub = Math.max(0, Number(p.budgetRub ?? 0) || 0);
  const maxConcurrent = Math.max(0, Math.round(Number(p.maxConcurrent ?? 0) || 0));
  const deliveryDelayH = Math.max(0, Number(p.deliveryDelayH ?? 1) || 0);
  const refundPct = Math.min(100, Math.max(0, Number(p.refundPct ?? 0) || 0));
  const asOf = p.asOf && !Number.isNaN(Date.parse(p.asOf)) ? new Date(p.asOf).toISOString() : nowIso();
  const save = p.save !== false;

  const current = getSettings();
  const timeline = settingsTimeline(asOf);
  const settingsFor = (ts) => (mode === 'current' ? current : timeline.at(ts));
  const knownAt = (ts) => (mode === 'current' ? asOf : ts);

  const since = new Date(ms(asOf) - sinceDays * DAY).toISOString();
  const H = horizonDays * DAY;
  const delay = deliveryDelayH * 3600_000;
  const fingerprint = createHash('sha1');
  const candidates = [];
  let skippedNoExit = 0;
  let skippedStale = 0;
  let skippedOutOfStock = 0;

  for (const w of watches.list()) {
    const fp = all(
      "SELECT id, ts, min_rub, median_rub, trimmed_rub, count FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' AND ts >= ? AND ts <= ? AND min_rub IS NOT NULL ORDER BY ts, id",
      w.id,
      since,
      asOf,
    );
    if (fp.length < 2) continue;
    for (const x of fp) fingerprint.update(`${x.id}|${x.ts}|${x.min_rub}|${x.median_rub}|${x.trimmed_rub}|${x.count};`);
    const sources = all("SELECT DISTINCT source_id FROM price_snapshots WHERE watch_id = ? AND kind = 'source' AND ts <= ?", w.id, asOf).map((r) => r.source_id);
    for (const src of sources) {
      const ss = all(
        "SELECT id, ts, min_rub, stock FROM price_snapshots WHERE watch_id = ? AND kind = 'source' AND source_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, id",
        w.id,
        src,
        new Date(ms(since) - DAY).toISOString(),
        asOf,
      );
      for (const x of ss) fingerprint.update(`${x.id}|${x.ts}|${x.min_rub}|${x.stock};`);
      const busyUntil = Object.fromEntries(STRATEGIES.map((s) => [s, 0]));
      let qi = -1;
      for (let i = 0; i < fp.length; i++) {
        const t = ms(fp[i].ts);
        while (qi + 1 < ss.length && ms(ss[qi + 1].ts) <= t) qi++;
        const quote = qi >= 0 ? ss[qi] : null;
        if (!quote || quote.min_rub == null) continue;
        const S = settingsFor(fp[i].ts);
        const P = S.pricing;
        if (t - ms(quote.ts) > S.freshness.sourceTtlMin * 60_000) {
          skippedStale++;
          continue;
        }
        if (quote.stock === 0) {
          skippedOutOfStock++;
          continue;
        }
        const undercut = (x) => Math.max(0, Math.round((x * (1 - P.undercutPct / 100) - P.undercutRub) * 100) / 100);
        const fee = saleFeeFor(w.funpay?.url, S.costModel.defaultSaleFeePct, fp[i].ts, knownAt(fp[i].ts));
        const args = { buyRub: quote.min_rub, saleFee: fee, sourceFee: sourceFeeFor(src, fp[i].ts, knownAt(fp[i].ts)), m: S.costModel, daysToSell: S.costModel.expectedDaysToSell };
        const fast = undercut(fp[i].min_rub);
        const prices = {
          fast,
          balanced: fp[i].trimmed_rub ? Math.max(fast, undercut(fp[i].trimmed_rub)) : null,
          max: fp[i].median_rub && fp[i].count >= P.minCompetitors ? Math.max(fast, undercut(fp[i].median_rub)) : null,
        };
        const exitIdx = fp.findIndex((x, k) => k > i && ms(x.ts) >= t + H);
        const regime = regimeAt(fp, i);
        for (const s of STRATEGIES) {
          if (t < busyUntil[s] || !prices[s]) continue;
          const f = forecast({ ...args, sellPrice: prices[s] });
          if (f.net < Math.max(minNet, 0.01) || (f.roiPct ?? -Infinity) < minRoiPct) continue;
          busyUntil[s] = t + H; // одна открытая позиция на связку и стратегию
          if (exitIdx < 0) {
            skippedNoExit++;
            continue;
          }
          const exitSnap = fp[exitIdx];
          const liqPrice = Math.min(prices[s], undercut(exitSnap.min_rub));
          const liq = forecast({ ...args, sellPrice: liqPrice });
          let net;
          let fillProbability = null;
          let competitiveDays = null;
          let exitTs = exitSnap.ts;
          let exitPrice = liqPrice;
          if (simulation === 'proxy') net = liq.net;
          else {
            // время, когда наша цена не выше рынка (после поставки): только тогда возможна продажа
            const start = t + delay;
            let comp = 0;
            let firstComp = null;
            for (let k = i; k < exitIdx; k++) {
              const a = Math.max(ms(fp[k].ts), start);
              const b = Math.min(ms(fp[k + 1].ts), t + H);
              if (b <= a) continue;
              if (undercut(fp[k].min_rub) >= prices[s]) {
                comp += b - a;
                firstComp ??= a;
              }
            }
            competitiveDays = comp / DAY;
            const meanDays = Math.max(0.1, S.costModel.expectedDaysToSell);
            fillProbability = 1 - Math.exp(-competitiveDays / meanDays);
            const refund = (refundPct / 100) * f.invested;
            net = fillProbability * f.net + (1 - fillProbability) * liq.net - refund;
            exitPrice = fillProbability * prices[s] + (1 - fillProbability) * liqPrice;
            // капитал возвращается: при вероятной продаже — через ожидаемый срок, иначе — в конце горизонта
            if (fillProbability >= 0.5 && firstComp !== null) exitTs = new Date(Math.min(firstComp + meanDays * DAY, t + H)).toISOString();
          }
          candidates.push({
            watch: w.name,
            category: w.category ?? '—',
            source: src,
            strategy: s,
            regime,
            entry: fp[i].ts,
            exit: exitTs,
            invested: f.invested,
            plannedPrice: prices[s],
            exitPrice: Math.round(exitPrice * 100) / 100,
            forecastNet: f.net,
            net,
            fillProbability,
            competitiveDays,
            settingsHash: settingsHash(S),
          });
        }
      }
    }
  }

  // портфель: бюджет и число одновременных позиций, решения в хронологическом порядке
  const trades = [];
  const skippedBudget = {};
  const skippedConcurrency = {};
  for (const s of STRATEGIES) {
    skippedBudget[s] = 0;
    skippedConcurrency[s] = 0;
    let cash = budgetRub;
    let open = [];
    for (const c of candidates.filter((x) => x.strategy === s).sort((a, b) => a.entry.localeCompare(b.entry))) {
      const still = [];
      for (const o of open) {
        if (o.exit <= c.entry) cash += o.invested + o.net;
        else still.push(o);
      }
      open = still;
      if (maxConcurrent && open.length >= maxConcurrent) {
        skippedConcurrency[s]++;
        continue;
      }
      if (budgetRub && cash < c.invested) {
        skippedBudget[s]++;
        continue;
      }
      if (budgetRub) cash -= c.invested;
      open.push(c);
      trades.push(c);
    }
  }

  // отпечаток входных данных: снимки + комиссии + история параметров + параметры прогона
  for (const r of all('SELECT id, scope, scope_key, pct, fixed_rub, valid_from, created_at FROM fee_profiles WHERE created_at <= ? ORDER BY id', asOf)) fingerprint.update(JSON.stringify(r));
  for (const r of all('SELECT id, key, value, changed_at FROM settings_history WHERE changed_at <= ? ORDER BY id', asOf)) fingerprint.update(JSON.stringify(r));
  const params = { horizonDays, minNet, minRoiPct, sinceDays, mode, simulation, budgetRub, maxConcurrent, deliveryDelayH, refundPct, asOf };
  fingerprint.update(JSON.stringify({ ...params, engine: ENGINE_VERSION, current: mode === 'current' ? settingsHash(current) : null }));
  const inputFingerprint = fingerprint.digest('hex').slice(0, 16);

  const result = {
    strategies: {},
    breakdown: {},
    trades: trades.slice(-200),
    skippedNoExit,
    skippedStale,
    skippedOutOfStock,
    skippedBudget,
    skippedConcurrency,
    note:
      simulation === 'proxy'
        ? 'выход по рыночной переоценке через горизонт — прокси, не подтверждённая продажа'
        : 'ожидаемый результат: вероятность продажи × цена + остаток по рынку в конце горизонта − возвраты; это модель, а не факт продаж',
  };
  for (const s of STRATEGIES) {
    const list = trades.filter((x) => x.strategy === s);
    result.strategies[s] = stats(list);
    result.breakdown[s] = { byItem: group(list, 'watch'), bySource: group(list, 'source'), byCategory: group(list, 'category'), byRegime: group(list, 'regime') };
  }
  const hash = mode === 'current' ? settingsHash(current) : 'historical';
  if (save)
    run(
      'INSERT INTO backtest_runs(ts, engine_version, settings_hash, params, result, mode, input_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)',
      nowIso(),
      ENGINE_VERSION,
      hash,
      JSON.stringify(params),
      JSON.stringify(result),
      mode,
      inputFingerprint,
    );
  return { params, engineVersion: ENGINE_VERSION, settingsHash: hash, inputFingerprint, settingsChanges: timeline.changes, ...result };
}

export function backtestRuns(limit = 20) {
  return all('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, params: JSON.parse(r.params), result: JSON.parse(r.result) }));
}

/** повторить сохранённый прогон с теми же параметрами и тем же asOf: отпечаток и результат должны совпасть */
export function replayBacktest(id) {
  const r = all('SELECT * FROM backtest_runs WHERE id = ?', Number(id))[0];
  if (!r) throw Object.assign(new Error('прогон не найден'), { status: 404 });
  const params = JSON.parse(r.params);
  const again = runBacktest({ ...params, save: false });
  return { original: { id: r.id, inputFingerprint: r.input_fingerprint, strategies: JSON.parse(r.result).strategies }, replay: again, reproducible: r.input_fingerprint === again.inputFingerprint && JSON.stringify(JSON.parse(r.result).strategies) === JSON.stringify(again.strategies) };
}
