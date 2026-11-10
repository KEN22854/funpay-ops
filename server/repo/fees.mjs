// Профили комиссий: у каждой ставки есть источник, дата начала действия и история (записи не изменяются).
import { all, nowIso, one, run } from '../db/db.mjs';
import { audit } from './audit.mjs';

const SCOPES = ['funpay_section', 'funpay_default', 'source'];

export function sectionKey(url) {
  const m = String(url ?? '').match(/funpay\.com\/(?:[a-z]{2}\/)?(lots|chips)\/(\d+)/);
  return m ? `${m[1]}/${m[2]}` : '';
}

export function addFee({ scope, scopeKey = '', pct, fixedRub = 0, source, validFrom, note }, { silent = false } = {}) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error('scope: funpay_section | funpay_default | source'), { status: 400 });
  const p = Number(pct);
  if (!Number.isFinite(p) || p < 0 || p >= 100) throw Object.assign(new Error('процент комиссии должен быть от 0 до 99.99'), { status: 400 });
  const src = String(source ?? '').trim().slice(0, 300);
  if (!src) throw Object.assign(new Error('укажите источник ставки (ссылка, «форма лота», «поддержка» и т.п.)'), { status: 400 });
  const key = scope === 'funpay_section' ? sectionKey(scopeKey) || String(scopeKey).slice(0, 40) : scope === 'source' ? String(scopeKey).slice(0, 60) : '';
  if (scope !== 'funpay_default' && !key) throw Object.assign(new Error('нужен раздел FunPay или источник'), { status: 400 });
  const from = validFrom && !Number.isNaN(Date.parse(validFrom)) ? new Date(validFrom).toISOString() : nowIso();
  const fixed = Math.max(0, Number(fixedRub) || 0);
  const r = run(
    'INSERT INTO fee_profiles(scope, scope_key, pct, fixed_rub, source, valid_from, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    scope,
    key,
    p,
    fixed,
    src,
    from,
    nowIso(),
    note ? String(note).slice(0, 300) : null,
  );
  if (!silent) audit('fee.add', 'fee', String(r.lastInsertRowid), { scope, key, pct: p, fixed, source: src, validFrom: from });
  return one('SELECT * FROM fee_profiles WHERE id = ?', Number(r.lastInsertRowid));
}

/** действующая ставка на момент at */
export function currentFee(scope, scopeKey = '', at = nowIso()) {
  return one('SELECT * FROM fee_profiles WHERE scope = ? AND scope_key = ? AND valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1', scope, scopeKey, at) ?? null;
}

/**
 * Комиссия FunPay для раздела: профиль раздела → профиль по умолчанию → настройка по умолчанию (как допущение).
 * Возвращает и происхождение, чтобы отчёт показывал, откуда цифра.
 */
export function saleFeeFor(sectionUrl, fallbackPct, at) {
  const key = sectionKey(sectionUrl);
  const sec = key ? currentFee('funpay_section', key, at) : null;
  if (sec) return { pct: sec.pct, fixed: sec.fixed_rub, origin: 'section', source: sec.source, validFrom: sec.valid_from, assumed: false };
  const def = currentFee('funpay_default', '', at);
  if (def) return { pct: def.pct, fixed: def.fixed_rub, origin: 'default', source: def.source, validFrom: def.valid_from, assumed: true };
  return { pct: fallbackPct, fixed: 0, origin: 'setting', source: 'настройка по умолчанию (не подтверждена)', validFrom: null, assumed: true };
}

export function sourceFeeFor(sourceId, at) {
  const f = currentFee('source', sourceId, at);
  return f ? { pct: f.pct, fixed: f.fixed_rub, source: f.source, assumed: false } : { pct: 0, fixed: 0, source: 'не задана — принята 0', assumed: true };
}

export function listFees() {
  const rows = all('SELECT * FROM fee_profiles ORDER BY scope, scope_key, valid_from DESC, id DESC');
  const now = nowIso();
  const seen = new Set();
  return rows.map((r) => {
    const k = `${r.scope}|${r.scope_key}`;
    const active = r.valid_from <= now && !seen.has(k);
    if (active) seen.add(k);
    return { ...r, active, future: r.valid_from > now };
  });
}

/**
 * Ставка, которую FunPay сам пишет в заголовке раздела (например «Пополнение Steam - комиссия 2%»).
 * Записывается как отдельный профиль, только если отличается от действующего.
 */
export function observeSectionFee(sectionUrl, title) {
  const m = String(title ?? '').match(/комисси[яи]\s*(\d+(?:[.,]\d+)?)\s*%/i);
  const key = sectionKey(sectionUrl);
  if (!m || !key) return null;
  const pct = Number(m[1].replace(',', '.'));
  const cur = currentFee('funpay_section', key);
  if (cur && Math.abs(cur.pct - pct) < 1e-9) return cur;
  if (cur && !/заголовок раздела/.test(cur.source)) return cur; // ручная ставка пользователя приоритетнее
  return addFee({ scope: 'funpay_section', scopeKey: key, pct, source: `заголовок раздела FunPay: «${String(title).slice(0, 120)}»`, note: 'обнаружено автоматически при скане' });
}
