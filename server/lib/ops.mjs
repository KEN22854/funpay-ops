// Наблюдаемость API: метрики по маршрутам (в памяти) и журнал ошибок (в базе, без тел запросов и секретов).
import { all, nowIso, run } from '../db/db.mjs';

const WINDOW = 500; // последних замеров на маршрут для перцентилей
const started = Date.now();
/** @type {Map<string, { count: number, errors: number, clientErrors: number, lat: number[], last: string|null }>} */
const stats = new Map();

/** /api/verify/abc123 → /api/verify/:id — чтобы маршрут не размножался по идентификаторам */
export function routeKey(method, path) {
  const p = path
    .split('/')
    .map((seg, i) => (i > 2 && (/\d/.test(seg) || seg.length > 24) ? ':id' : seg))
    .join('/');
  return `${method} ${p}`;
}

const scrub = (s) =>
  String(s ?? '')
    .replace(/bot\d+:[\w-]+/gi, 'bot***') // токен Telegram в URL
    .replace(/\b(token|golden_key|password|authorization|cookie|key)\b\s*[:=]?\s*[^\s,;]+/gi, '$1=***')
    .slice(0, 500);

export function recordRequest(method, path, status, ms, message) {
  const k = routeKey(method, path);
  const s = stats.get(k) ?? { count: 0, errors: 0, clientErrors: 0, lat: [], last: null };
  s.count++;
  if (status >= 500) s.errors++;
  else if (status >= 400) s.clientErrors++;
  s.lat.push(ms);
  if (s.lat.length > WINDOW) s.lat.shift();
  s.last = nowIso();
  stats.set(k, s);
  if (status >= 500) {
    try {
      run('INSERT INTO error_log(ts, method, route, status, message) VALUES (?, ?, ?, ?, ?)', nowIso(), method, k.slice(method.length + 1), status, scrub(message));
    } catch {
      /* журнал ошибок не должен ронять запрос */
    }
  }
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export function apiMetrics() {
  const routes = [...stats.entries()]
    .map(([route, s]) => ({ route, count: s.count, errors: s.errors, clientErrors: s.clientErrors, errorRate: s.count ? s.errors / s.count : 0, p50: pct(s.lat, 50), p95: pct(s.lat, 95), max: s.lat.length ? Math.max(...s.lat) : null, last: s.last }))
    .sort((a, b) => b.count - a.count);
  const total = routes.reduce((a, r) => a + r.count, 0);
  const errors = routes.reduce((a, r) => a + r.errors, 0);
  return { since: new Date(started).toISOString(), uptimeSec: Math.round((Date.now() - started) / 1000), total, errors, errorRate: total ? errors / total : 0, memoryMb: Math.round(process.memoryUsage().rss / 1048576), routes };
}

export function errorLog(limit = 100) {
  return all('SELECT * FROM error_log ORDER BY id DESC LIMIT ?', Math.min(500, limit));
}

export function pruneErrors(days = 30) {
  run('DELETE FROM error_log WHERE ts < ?', new Date(Date.now() - days * 86400_000).toISOString());
}

/** только для тестов */
export const _resetOps = () => stats.clear();
