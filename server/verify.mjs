// Profit Verification: перепроверка связки непосредственно перед закупкой.
// theoretical → executable: свежая котировка (мимо кэша), цена не выросла сверх допуска, наличие подтверждено.
import { nowIso, run } from './db/db.mjs';
import { withFresh } from './lib/http.mjs';
import { buildOpportunities } from './opportunities.mjs';
import { audit } from './repo/audit.mjs';
import { getSettings } from './repo/settings.mjs';
import { watches } from './repo/watches.mjs';

/**
 * @param {string} id                         id связки
 * @param {{ userConfirmedStock?: boolean, actualPriceRub?: number }} input
 * @param {(watchId: string) => Promise<unknown>} rescan  пересканировать товар (сохраняет результат)
 */
export async function verifyOpportunity(id, input, rescan) {
  const before = buildOpportunities({ only: id })[0];
  if (!before) throw Object.assign(new Error('связка не найдена — пересканируйте товар'), { status: 404 });
  const S = getSettings();
  const quoted = before.buy.priceRub;
  const autoRefetch = before.kind === 'watch' && !before.buy.manual;
  let fresh = null;
  let stock = null;
  const notes = [];

  if (autoRefetch) {
    const w = watches.get(before.watchId);
    if (!w) throw Object.assign(new Error('товар удалён из каталога'), { status: 404 });
    await withFresh(() => rescan(w.id));
    const after = buildOpportunities({ only: id })[0];
    if (!after) notes.push('предложение больше не найдено у источника');
    else {
      fresh = after.buy.priceRub;
      stock = after.buy.stock ?? null;
    }
  }
  // ручная проверка на сайте: пользователь вводит цену, которую видит сейчас
  const actual = Number(input.actualPriceRub);
  if (Number.isFinite(actual) && actual > 0) {
    fresh = actual;
    notes.push('цена подтверждена вручную');
  }
  if (fresh === null && !notes.length) notes.push(autoRefetch ? 'не удалось получить свежую котировку' : 'для этого источника введите цену, которую видите на сайте сейчас');

  const tol = S.verification.priceTolerancePct;
  const userStock = Boolean(input.userConfirmedStock);
  const { result, priceOk, reasons } = decideVerification({ quoted, fresh, stock, userConfirmedStock: userStock, tolerancePct: tol });
  if (reasons.includes('price_rose')) notes.push(`цена выросла: ${quoted.toFixed(2)} → ${fresh.toFixed(2)} ₽ (допуск ${tol}%)`);
  if (reasons.includes('out_of_stock')) notes.push('нет в наличии у источника');
  if (reasons.includes('stock_unknown')) notes.push('наличие не подтверждено: источник не сообщает остаток — подтвердите вручную');
  const ok = result === 'ok';

  run(
    'INSERT INTO verifications(opp_id, watch_id, source_id, offer_url, ts, quoted_rub, fresh_rub, stock, user_confirmed_stock, ok, detail, result, price_ok, reasons) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    before.watchId ?? null,
    before.buy.sourceId,
    before.buy.url ?? '',
    nowIso(),
    quoted,
    fresh,
    stock,
    userStock ? 1 : 0,
    ok ? 1 : 0,
    notes.join('; ') || null,
    result,
    priceOk ? 1 : 0,
    JSON.stringify(reasons),
  );
  audit('opportunity.verify', 'opportunity', id, { ok, result, reasons, quoted, fresh, stock, userStock });
  const final = buildOpportunities({ only: id })[0] ?? null;
  return { ok, result, reasons, priceOk, quoted, fresh, stock, userConfirmedStock: userStock, notes, opportunity: final };
}

/**
 * Решение перепроверки (чистая функция, таблица из аудита 2026-11-12):
 * | цена                | наличие                          | исход      |
 * | подтверждена        | stock > 0 или подтвердил человек | ok         |
 * | подтверждена        | неизвестно                       | incomplete |
 * | не получена         | любое                            | failed     |
 * | выше допуска        | любое                            | failed     |
 * | любая               | stock = 0                        | blocked    |
 * Успех — только цена И наличие. stock = 0 от источника важнее отметки человека.
 * @returns {{ result: 'ok'|'incomplete'|'failed'|'blocked', priceOk: boolean, stockOk: boolean, reasons: string[] }}
 */
export function decideVerification({ quoted, fresh, stock, userConfirmedStock, tolerancePct }) {
  const reasons = [];
  const priceKnown = fresh !== null && fresh !== undefined && Number.isFinite(fresh) && fresh > 0;
  const priceOk = priceKnown && fresh <= quoted * (1 + tolerancePct / 100);
  if (!priceKnown) reasons.push('price_unknown');
  else if (!priceOk) reasons.push('price_rose');
  const outOfStock = stock === 0;
  const stockOk = !outOfStock && ((typeof stock === 'number' && stock > 0) || Boolean(userConfirmedStock));
  if (outOfStock) reasons.push('out_of_stock');
  else if (!stockOk) reasons.push('stock_unknown');
  const result = outOfStock ? 'blocked' : !priceOk ? 'failed' : !stockOk ? 'incomplete' : 'ok';
  return { result, priceOk, stockOk, reasons };
}
