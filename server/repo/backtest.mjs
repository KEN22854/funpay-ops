// Strategy Backtesting: воспроизведение истории снимков без заглядывания в будущее.
// В момент t решение принимается ТОЛЬКО по снимкам ≤ t и по ставке комиссии, действовавшей на t.
// Результат сделки — рыночная переоценка через горизонт (минимальная цена FunPay − подрезка), это прокси.
import { all, nowIso, run } from '../db/db.mjs';
import { ENGINE_VERSION, forecast } from '../core/finance.mjs';
import { saleFeeFor, sourceFeeFor } from './fees.mjs';
import { getSettings, settingsHash } from './settings.mjs';
import { watches } from './watches.mjs';

const STRATEGIES = ['fast', 'balanced', 'max'];

/**
 * @param {object} p
 * @param {number} p.horizonDays   через сколько дней «продаём» по рынку
 * @param {number} p.minNet        порог чистой прибыли для входа
 * @param {number} p.minRoiPct     порог ROI для входа
 * @param {number} p.sinceDays     глубина истории
 */
export function runBacktest({ horizonDays = 7, minNet = 0, minRoiPct = 0, sinceDays = 90, save = true } = {}) {
  const S = getSettings();
  const P = S.pricing;
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const H = horizonDays * 86400_000;
  const undercut = (x) => Math.max(0, Math.round((x * (1 - P.undercutPct / 100) - P.undercutRub) * 100) / 100);
  const trades = [];
  let skippedNoExit = 0;

  for (const w of watches.list()) {
    const fp = all("SELECT ts, min_rub, median_rub, trimmed_rub, count FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' AND ts >= ? AND min_rub IS NOT NULL ORDER BY ts", w.id, since);
    if (fp.length < 2) continue;
    const sources = all("SELECT DISTINCT source_id FROM price_snapshots WHERE watch_id = ? AND kind = 'source'", w.id).map((r) => r.source_id);
    for (const src of sources) {
      const ss = all("SELECT ts, min_rub FROM price_snapshots WHERE watch_id = ? AND kind = 'source' AND source_id = ? AND ts >= ? ORDER BY ts", w.id, src, new Date(new Date(since).getTime() - 86400_000).toISOString());
      const busyUntil = Object.fromEntries(STRATEGIES.map((s) => [s, 0]));
      for (let i = 0; i < fp.length; i++) {
        const t = new Date(fp[i].ts).getTime();
        // последняя котировка источника не позже t и не старше допустимого срока
        let quote = null;
        for (const q of ss) {
          if (new Date(q.ts).getTime() <= t) quote = q;
          else break;
        }
        if (!quote || t - new Date(quote.ts).getTime() > S.freshness.sourceTtlMin * 60_000) continue;
        const fee = saleFeeFor(w.funpay.url, S.costModel.defaultSaleFeePct, fp[i].ts);
        const args = { buyRub: quote.min_rub, saleFee: fee, sourceFee: sourceFeeFor(src, fp[i].ts), m: S.costModel, daysToSell: S.costModel.expectedDaysToSell };
        const fast = undercut(fp[i].min_rub);
        const prices = {
          fast,
          balanced: fp[i].trimmed_rub ? Math.max(fast, undercut(fp[i].trimmed_rub)) : null,
          max: fp[i].median_rub && fp[i].count >= P.minCompetitors ? Math.max(fast, undercut(fp[i].median_rub)) : null,
        };
        // выход: первый снимок после горизонта (будущее используется только для оценки)
        const exitSnap = fp.slice(i + 1).find((x) => new Date(x.ts).getTime() >= t + H);
        for (const s of STRATEGIES) {
          if (t < busyUntil[s] || !prices[s]) continue;
          const f = forecast({ ...args, sellPrice: prices[s] });
          if (f.net < Math.max(minNet, 0.01) || (f.roiPct ?? -Infinity) < minRoiPct) continue;
          busyUntil[s] = t + H; // одна открытая позиция на связку и стратегию
          if (!exitSnap) {
            skippedNoExit++;
            continue;
          }
          // продаём по нашей цене, если рынок не опустился ниже неё; иначе — по рыночной цене (переоценка вниз)
          const exitPrice = Math.min(prices[s], undercut(exitSnap.min_rub));
          const fx = forecast({ ...args, sellPrice: exitPrice });
          trades.push({ watch: w.name, source: src, strategy: s, entry: fp[i].ts, exit: exitSnap.ts, invested: f.invested, plannedPrice: prices[s], exitPrice, forecastNet: f.net, net: fx.net });
        }
      }
    }
  }

  const result = { strategies: {}, trades: trades.slice(-200), skippedNoExit, note: 'выход по рыночной переоценке через горизонт — прокси, не подтверждённая продажа' };
  for (const s of STRATEGIES) {
    const list = trades.filter((x) => x.strategy === s).sort((a, b) => a.exit.localeCompare(b.exit));
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (const x of list) {
      cum += x.net;
      peak = Math.max(peak, cum);
      dd = Math.max(dd, peak - cum);
    }
    const invested = list.reduce((a, x) => a + x.invested, 0);
    // загрузка капитала: средняя сумма в открытых позициях относительно пиковой
    const events = list.flatMap((x) => [
      { t: x.entry, d: x.invested },
      { t: x.exit, d: -x.invested },
    ]).sort((a, b) => a.t.localeCompare(b.t));
    let open = 0;
    let peakOpen = 0;
    let area = 0;
    for (let i = 0; i < events.length; i++) {
      open += events[i].d;
      peakOpen = Math.max(peakOpen, open);
      if (i + 1 < events.length) area += open * (new Date(events[i + 1].t) - new Date(events[i].t));
    }
    const span = events.length ? new Date(events.at(-1).t) - new Date(events[0].t) : 0;
    const wins = list.filter((x) => x.net > 0).length;
    result.strategies[s] = {
      trades: list.length,
      netProfit: cum,
      roiPct: invested ? (cum / invested) * 100 : null,
      winRate: list.length ? wins / list.length : null,
      falsePositiveRate: list.length ? 1 - wins / list.length : null,
      maxDrawdown: dd,
      turnover: peakOpen ? invested / peakOpen : null,
      capitalUtilization: peakOpen && span ? area / span / peakOpen : null,
      forecastMae: list.length ? list.reduce((a, x) => a + Math.abs(x.forecastNet - x.net), 0) / list.length : null,
    };
  }
  const params = { horizonDays, minNet, minRoiPct, sinceDays };
  if (save) run('INSERT INTO backtest_runs(ts, engine_version, settings_hash, params, result) VALUES (?, ?, ?, ?, ?)', nowIso(), ENGINE_VERSION, settingsHash(S), JSON.stringify(params), JSON.stringify(result));
  return { params, engineVersion: ENGINE_VERSION, settingsHash: settingsHash(S), ...result };
}

export function backtestRuns(limit = 20) {
  return all('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, params: JSON.parse(r.params), result: JSON.parse(r.result) }));
}
