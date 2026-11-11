// Качество данных источников — отдельно от транспортного здоровья (HTTP 200 ≠ правильная цена).
//   transport   — источник отвечает (repo/health.mjs)
//   data        — полнота и правдоподобие котировок при каждом скане
//   price       — котировка против фактической цены закупки (execution_attempts)
//   stock       — заявленная доступность против факта при попытке купить
//   fulfillment — возвраты и споры по товарам, купленным у источника
import { all, nowIso, one, run } from '../db/db.mjs';
import { median, trimmedMedian } from './history.mjs';
import { audit } from './audit.mjs';

const KNOWN_CURRENCIES = new Set(['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'TRY', 'CNY', 'BYN', 'GBP']);

/**
 * Проверка котировок одного источника в одном скане.
 * Возвращает проблемы по каждому предложению (по индексу) и сводку.
 * @param {{priceRub:number, price:number, currency:string, title:string, url:string}[]} offers
 * @param {{ watchId?: string, sourceId: string, ratesDate?: string, jumpPct?: number }} ctx
 */
export function assessOffers(offers, ctx) {
  const issues = offers.map(() => []);
  const hist = ctx.watchId
    ? all("SELECT min_rub FROM price_snapshots WHERE watch_id = ? AND kind = 'source' AND source_id = ? ORDER BY ts DESC LIMIT 10", ctx.watchId, ctx.sourceId).map((r) => r.min_rub)
    : [];
  const base = hist.length >= 3 ? trimmedMedian(hist) : null;
  const jump = ctx.jumpPct ?? 60;
  const ratesAgeDays = ctx.ratesDate ? (Date.now() - new Date(ctx.ratesDate).getTime()) / 86400_000 : 0;
  offers.forEach((o, i) => {
    if (!o.title || String(o.title).trim().length < 2) issues[i].push('нет названия');
    if (!/^https?:\/\//.test(o.url ?? '')) issues[i].push('нет ссылки на товар');
    if (!(o.price > 0)) issues[i].push('цена не распознана');
    if (!KNOWN_CURRENCIES.has(String(o.currency).toUpperCase())) issues[i].push(`неизвестная валюта ${o.currency}`);
    if (o.currency !== 'RUB' && ratesAgeDays > 4) issues[i].push(`курс ЦБ устарел (${ratesAgeDays.toFixed(0)} дн.)`);
    if (base && o.priceRub > 0) {
      const d = ((o.priceRub - base) / base) * 100;
      // резкое отклонение от собственной истории источника — возможная ошибка парсинга/валюты
      if (Math.abs(d) > jump && i === 0) issues[i].push(`цена отличается от истории источника на ${d.toFixed(0)}%`);
    }
  });
  return { issues, checked: offers.length, withIssues: issues.filter((x) => x.length).length };
}

/** Записать попытку закупки — источник истины для точности цены и остатка */
export function recordAttempt({ oppId, watchId, sourceId, offerUrl, quotedRub, actualRub, quotedStock, outcome, purchaseId, note }) {
  const allowed = ['ok', 'price_changed', 'out_of_stock', 'not_found', 'failed'];
  if (!allowed.includes(outcome)) throw Object.assign(new Error(`outcome: ${allowed.join(' | ')}`), { status: 400 });
  if (!sourceId) throw Object.assign(new Error('нужен источник'), { status: 400 });
  const r = run(
    'INSERT INTO execution_attempts(ts, opp_id, watch_id, source_id, offer_url, quoted_rub, actual_rub, quoted_stock, outcome, purchase_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    nowIso(),
    oppId ?? null,
    watchId ?? null,
    String(sourceId).slice(0, 60),
    offerUrl ? String(offerUrl).slice(0, 500) : null,
    Number.isFinite(Number(quotedRub)) ? Number(quotedRub) : null,
    Number.isFinite(Number(actualRub)) && Number(actualRub) > 0 ? Number(actualRub) : null,
    quotedStock === null || quotedStock === undefined ? null : Number(quotedStock),
    outcome,
    purchaseId ?? null,
    note ? String(note).slice(0, 300) : null,
  );
  audit('execution.attempt', 'source', sourceId, { outcome, quotedRub, actualRub });
  return { id: Number(r.lastInsertRowid) };
}

/** Сводка качества источника за окно */
export function sourceQuality(sourceId, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const dq = one('SELECT coalesce(sum(dq_checked), 0) c, coalesce(sum(dq_issues), 0) i FROM source_health WHERE source_id = ? AND ts >= ? AND ok = 1', sourceId, since);
  const attempts = all('SELECT * FROM execution_attempts WHERE source_id = ? AND ts >= ?', sourceId, since);
  const priced = attempts.filter((a) => a.quoted_rub > 0 && a.actual_rub > 0);
  const devs = priced.map((a) => Math.abs(a.actual_rub - a.quoted_rub) / a.quoted_rub);
  const stockKnown = attempts.filter((a) => a.outcome !== 'failed');
  const available = stockKnown.filter((a) => !['out_of_stock', 'not_found'].includes(a.outcome));
  // исполнение: продажи товаров из партий этого источника
  const sales = all(
    `SELECT DISTINCT s.id, s.status, s.disputed FROM sales s
       JOIN stock_movements m ON m.sale_id = s.id JOIN purchases p ON p.id = m.purchase_id
      WHERE p.source_id = ? AND s.sold_at >= ? AND s.mode = 'real'`,
    sourceId,
    since,
  );
  const problem = sales.filter((s) => s.disputed || ['refunded', 'partial_refund'].includes(s.status)).length;
  return {
    sourceId,
    data: { checked: dq.c, withIssues: dq.i, okShare: dq.c ? 1 - dq.i / dq.c : null },
    price: { attempts: priced.length, medianDeviationPct: devs.length ? median(devs) * 100 : null, accuracy: devs.length ? Math.max(0, 1 - median(devs)) : null },
    stock: { attempts: stockKnown.length, accuracy: stockKnown.length ? available.length / stockKnown.length : null },
    fulfillment: { sales: sales.length, problemRate: sales.length ? problem / sales.length : null },
    note: 'точность цены и остатка считается по вашим попыткам закупки — отмечайте результат кнопкой «купил / не получилось»',
  };
}
