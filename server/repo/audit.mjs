// Журнал действий и защита от повторного выполнения (идемпотентность).
import { all, nowIso, one, run } from '../db/db.mjs';

const SECRET_KEYS = /token|secret|password|golden/i;

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '***' : scrub(x)]));
  return v;
}

export function audit(action, entity, entityId = null, details = null) {
  run(
    'INSERT INTO audit_log(ts, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    nowIso(),
    action,
    entity,
    entityId,
    details === null ? null : JSON.stringify(scrub(details)).slice(0, 4000),
  );
}

export function auditLog({ limit = 200, entity } = {}) {
  const rows = entity
    ? all('SELECT * FROM audit_log WHERE entity = ? ORDER BY id DESC LIMIT ?', entity, limit)
    : all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

/**
 * Выполняет fn один раз на ключ. Повтор с тем же ключом возвращает сохранённый ответ,
 * а не выполняет операцию заново (нет двойного списания/закупки).
 */
export function idempotent(key, route, fn) {
  if (!key) throw Object.assign(new Error('нужен заголовок Idempotency-Key для финансовой операции'), { status: 400 });
  if (!/^[\w-]{8,100}$/.test(key)) throw Object.assign(new Error('некорректный Idempotency-Key'), { status: 400 });
  const prev = one('SELECT route, response FROM idempotency WHERE key = ?', key);
  if (prev) {
    if (prev.route !== route) throw Object.assign(new Error('Idempotency-Key уже использован для другой операции'), { status: 409 });
    return { ...JSON.parse(prev.response), replayed: true };
  }
  const result = fn();
  run('INSERT INTO idempotency(key, route, response, created_at) VALUES (?, ?, ?, ?)', key, route, JSON.stringify(result), nowIso());
  return result;
}
