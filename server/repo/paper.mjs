// Paper trading: «бумажная» позиция открывается по каждой рекомендации (кандидату) и закрывается
// через горизонт по рыночной переоценке — минимальной цене FunPay − подрезка в момент закрытия.
// Это прокси качества сигналов до реальных денег, а не факт продажи.
import { randomUUID } from 'node:crypto';
import { all, nowIso, one, run } from '../db/db.mjs';
import { ENGINE_VERSION, forecast } from '../core/finance.mjs';
import { getSettings, settingsHash } from './settings.mjs';

const undercut = (x, P) => Math.max(0, Math.round((x * (1 - P.undercutPct / 100) - P.undercutRub) * 100) / 100);

/** Открыть бумажные позиции по сценариям fast/balanced/max (если по этой связке ещё нет открытой) */
export function openPaper(o) {
  const S = getSettings();
  if (!S.paper.enabled || !o.watchId) return 0;
  let n = 0;
  for (const sc of o.eval.prices.scenarios) {
    if (!sc.forecast || sc.forecast.net <= 0) continue;
    if (one("SELECT 1 FROM paper_positions WHERE opp_id = ? AND strategy = ? AND status = 'open'", o.id, sc.key)) continue;
    const params = { buyRub: o.buy.priceRub, saleFee: o.saleFee, sourceFee: o.sourceFee ?? { pct: 0, fixed: 0 }, m: o.eval.model ?? S.costModel, daysToSell: o.eval.daysToSell, pricing: S.pricing };
    run(
      `INSERT INTO paper_positions(id, opp_id, watch_id, item, category, source_id, strategy, opened_at, horizon_days, entry_cost, planned_price, forecast_net, engine_version, settings_hash, status, params)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      randomUUID(),
      o.id,
      o.watchId,
      o.name,
      o.category,
      o.buy.sourceId,
      sc.key,
      nowIso(),
      S.paper.horizonDays,
      sc.forecast.invested,
      sc.price,
      sc.forecast.net,
      ENGINE_VERSION,
      settingsHash(S),
      JSON.stringify(params),
    );
    n++;
  }
  return n;
}

/** Закрыть позиции, у которых истёк горизонт и есть снимок рынка после него */
export function closeDuePaper(now = Date.now()) {
  let closed = 0;
  for (const p of all("SELECT * FROM paper_positions WHERE status = 'open'")) {
    const due = new Date(p.opened_at).getTime() + p.horizon_days * 86400_000;
    if (due > now) continue;
    const snap = one("SELECT min_rub, ts FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' AND ts >= ? AND min_rub IS NOT NULL ORDER BY ts LIMIT 1", p.watch_id, new Date(due).toISOString());
    if (!snap) {
      // нет наблюдений после горизонта дольше ещё одного горизонта — результат неизвестен
      if (now > due + p.horizon_days * 86400_000) {
        run("UPDATE paper_positions SET status = 'expired_no_data', closed_at = ? WHERE id = ?", nowIso(), p.id);
        closed++;
      }
      continue;
    }
    const params = JSON.parse(p.params ?? '{}');
    const exit = undercut(snap.min_rub, params.pricing ?? { undercutPct: 0, undercutRub: 1 });
    const f = forecast({ ...params, sellPrice: exit });
    run("UPDATE paper_positions SET status = 'closed', closed_at = ?, exit_price = ?, exit_net = ? WHERE id = ?", snap.ts, exit, f.net, p.id);
    closed++;
  }
  return closed;
}

export function paperStats() {
  const rows = all('SELECT * FROM paper_positions');
  const by = {};
  for (const s of ['fast', 'balanced', 'max']) {
    const list = rows.filter((r) => r.strategy === s);
    const closed = list.filter((r) => r.status === 'closed');
    const wins = closed.filter((r) => r.exit_net > 0);
    const total = closed.reduce((a, r) => a + r.exit_net, 0);
    const invested = closed.reduce((a, r) => a + r.entry_cost, 0);
    by[s] = {
      open: list.filter((r) => r.status === 'open').length,
      closed: closed.length,
      noData: list.filter((r) => r.status === 'expired_no_data').length,
      winRate: closed.length ? wins.length / closed.length : null,
      falsePositiveRate: closed.length ? 1 - wins.length / closed.length : null,
      totalNet: total,
      roiPct: invested ? (total / invested) * 100 : null,
      forecastMae: closed.length ? closed.reduce((a, r) => a + Math.abs(r.forecast_net - r.exit_net), 0) / closed.length : null,
    };
  }
  return { byStrategy: by, recent: rows.sort((a, b) => b.opened_at.localeCompare(a.opened_at)).slice(0, 50) };
}
