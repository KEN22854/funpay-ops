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
  const priceOk = fresh !== null && fresh <= quoted * (1 + tol / 100);
  if (fresh !== null && !priceOk) notes.push(`цена выросла: ${quoted.toFixed(2)} → ${fresh.toFixed(2)} ₽ (допуск ${tol}%)`);
  if (stock === 0) notes.push('нет в наличии');
  const userStock = Boolean(input.userConfirmedStock);
  const ok = priceOk && stock !== 0;

  run(
    'INSERT INTO verifications(opp_id, watch_id, source_id, offer_url, ts, quoted_rub, fresh_rub, stock, user_confirmed_stock, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
  );
  audit('opportunity.verify', 'opportunity', id, { ok, quoted, fresh, stock, userStock });
  const final = buildOpportunities({ only: id })[0] ?? null;
  return { ok, quoted, fresh, stock, userConfirmedStock: userStock, notes, opportunity: final };
}
