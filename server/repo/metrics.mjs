// Метрики продукта (раздел 7 аудита): качество сигналов, финансовый результат, ликвидность, капитал, источники.
import { all, one } from '../db/db.mjs';
import { metrics, recommendationQuality } from './analytics.mjs';
import { sellProbability } from './demand.mjs';
import { median } from './history.mjs';
import { paperStats } from './paper.mjs';
import { capitalSnapshot } from './risk.mjs';
import { sourceQuality } from './quality.mjs';

export function productMetrics({ from, to, mode = 'real' }) {
  const m = metrics({ from, to, mode });
  const q = recommendationQuality();
  // ошибка прогноза срока продажи: прогноз рекомендации против фактического срока её продаж
  const timeErr = all(
    `SELECT r.forecast_days f, avg(julianday(mv.ts) - julianday(p.received_at)) a
       FROM recommendations r JOIN purchases p ON p.recommendation_id = r.id JOIN stock_movements mv ON mv.purchase_id = p.id
      WHERE mv.type = 'sale' AND r.forecast_days IS NOT NULL AND p.received_at IS NOT NULL GROUP BY r.id`,
  );
  const received = one("SELECT coalesce(sum(qty), 0) q FROM stock_movements WHERE type = 'receive' AND mode = ? AND ts >= ? AND ts < ?", mode, from, to).q;
  const sold = one("SELECT coalesce(-sum(qty), 0) q FROM stock_movements WHERE type = 'sale' AND mode = ? AND ts >= ? AND ts < ?", mode, from, to).q;
  const cap = capitalSnapshot(mode);
  const sources = all('SELECT DISTINCT source_id FROM execution_attempts').map((r) => sourceQuality(r.source_id));
  const lastBacktest = one('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1');
  const sell = sellProbability({});
  return {
    period: { from, to },
    precision: { value: q.precision, known: q.known, profitable: q.profitable, purchased: q.purchased },
    falsePositiveRate: q.known ? 1 - q.profitable / q.known : null,
    netPnL: m.netProfit,
    forecastError: {
      profitMaePerUnit: q.maePerUnit,
      daysMae: timeErr.length ? timeErr.reduce((s, r) => s + Math.abs(r.f - r.a), 0) / timeErr.length : null,
      samples: timeErr.length,
    },
    sellThrough: received ? sold / received : null,
    timeToSale: { medianDays: sell.medianDays, enough: sell.enough, events: sell.events, censored: sell.censored },
    capitalUtilization: cap.utilization,
    refundRatePct: m.refundRatePct,
    disputeRatePct: m.disputeRatePct,
    sources: sources.map((s) => ({ sourceId: s.sourceId, priceAccuracy: s.price.accuracy, priceAttempts: s.price.attempts, stockAccuracy: s.stock.accuracy, stockAttempts: s.stock.attempts, problemRate: s.fulfillment.problemRate })),
    paper: paperStats().byStrategy,
    backtest: lastBacktest ? { ts: lastBacktest.ts, params: JSON.parse(lastBacktest.params), strategies: JSON.parse(lastBacktest.result).strategies } : null,
    medianDaysPerSale: median(timeErr.map((r) => r.a)),
  };
}
