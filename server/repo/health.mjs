// Наблюдаемость источников: каждый вызов адаптера записывается; из истории считаются
// success rate, задержка, свежесть, классы ошибок и надёжность. Circuit breaker изолирует сломанный адаптер.
import { all, nowIso, one, run } from '../db/db.mjs';

const CB_FAILS = 3; // подряд неудачных вызовов → размыкание
const CB_COOLDOWN_MS = 15 * 60_000;

export function recordHealth(sourceId, { ok, errorClass = null, httpStatus = null, latencyMs = null, items = null, detail = null, dqChecked = null, dqIssues = null, dqDetail = null }) {
  run(
    'INSERT INTO source_health(source_id, ts, ok, error_class, http_status, latency_ms, items, detail, dq_checked, dq_issues, dq_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    nowIso(),
    ok ? 1 : 0,
    errorClass,
    httpStatus,
    latencyMs,
    items,
    detail ? String(detail).slice(0, 800) : null,
    dqChecked,
    dqIssues,
    dqDetail ? String(dqDetail).slice(0, 800) : null,
  );
}

/** Разомкнут ли «предохранитель»: N последних вызовов подряд — ошибки, и с последней прошло меньше паузы */
export function circuitOpen(sourceId) {
  const last = all('SELECT ok, ts FROM source_health WHERE source_id = ? ORDER BY id DESC LIMIT ?', sourceId, CB_FAILS);
  if (last.length < CB_FAILS || last.some((r) => r.ok)) return null;
  const until = new Date(last[0].ts).getTime() + CB_COOLDOWN_MS;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

/** Сводка по источнику за окно (по умолчанию 7 дней) */
export function healthSummary(sourceId, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = all('SELECT ok, error_class, latency_ms, items, ts, detail, http_status FROM source_health WHERE source_id = ? AND ts >= ? ORDER BY id DESC', sourceId, since);
  if (!rows.length) return { sourceId, calls: 0, status: 'unknown' };
  const okRows = rows.filter((r) => r.ok);
  const errors = {};
  for (const r of rows) if (!r.ok) errors[r.error_class ?? 'unknown'] = (errors[r.error_class ?? 'unknown'] ?? 0) + 1;
  const lat = okRows.map((r) => r.latency_ms).filter((x) => x !== null).sort((a, b) => a - b);
  const lastOk = okRows[0]?.ts ?? null;
  const lastErr = rows.find((r) => !r.ok) ?? null;
  const successRate = okRows.length / rows.length;
  const cb = circuitOpen(sourceId);
  // надёжность: успешность с поправкой на малое число наблюдений (сглаживание Лапласа)
  const reliability = (okRows.length + 1) / (rows.length + 2);
  const recent = rows.slice(0, 5);
  const status = cb ? 'circuit_open' : recent[0]?.ok ? (recent.every((r) => r.ok) ? 'ok' : 'degraded') : 'failing';
  return {
    sourceId,
    calls: rows.length,
    successRate,
    errorRate: 1 - successRate,
    errors,
    latencyMedianMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    lastSuccess: lastOk,
    freshnessMin: lastOk ? Math.round((Date.now() - new Date(lastOk).getTime()) / 60000) : null,
    lastError: lastErr ? { ts: lastErr.ts, class: lastErr.error_class, http: lastErr.http_status, detail: lastErr.detail } : null,
    /** сколько вызовов подряд отдали 0 предложений (подозрение на изменение формата) */
    emptyStreak: (() => {
      let n = 0;
      for (const r of rows) {
        if (r.ok && r.items === 0) n++;
        else break;
      }
      return n;
    })(),
    reliability,
    circuitOpenUntil: cb,
    status,
  };
}

export function allHealth(sourceIds) {
  return Object.fromEntries(sourceIds.map((id) => [id, healthSummary(id)]));
}

/** Как долго источник непрерывно падает (минуты), для уведомлений */
export function downtimeMin(sourceId) {
  const lastOk = one('SELECT ts FROM source_health WHERE source_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1', sourceId)?.ts;
  const lastAny = one('SELECT ok, ts FROM source_health WHERE source_id = ? ORDER BY id DESC LIMIT 1', sourceId);
  if (!lastAny || lastAny.ok) return 0;
  const firstFail = one('SELECT ts FROM source_health WHERE source_id = ? AND ok = 0 AND ts > ? ORDER BY id ASC LIMIT 1', sourceId, lastOk ?? '');
  return firstFail ? Math.round((Date.now() - new Date(firstFail.ts).getTime()) / 60000) : 0;
}

export function pruneHealth(days = 30) {
  run('DELETE FROM source_health WHERE ts < ?', new Date(Date.now() - days * 86400_000).toISOString());
}
