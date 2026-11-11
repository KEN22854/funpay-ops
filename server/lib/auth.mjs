// Доступ к API, когда сервер открыт в сеть (VPS). Локально (127.0.0.1) вход не нужен.
// FPO_AUTH_TOKEN — длинный секрет; вход выдаёт cookie сессии (HttpOnly, SameSite=Strict).
// Сессии хранятся в базе (переживают перезапуск): только SHA-256 от идентификатора, сам идентификатор — лишь в cookie.
// Политика: абсолютный срок FPO_SESSION_TTL_DAYS (30), простой FPO_SESSION_IDLE_DAYS (7); список и отзыв — в настройках.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, nowIso, one, run } from '../db/db.mjs';

const days = (env, def) => Math.max(0.01, Number(process.env[env]) || def) * 86400_000;
const ttlMs = () => days('FPO_SESSION_TTL_DAYS', 30);
const idleMs = () => days('FPO_SESSION_IDLE_DAYS', 7);
const attempts = new Map(); // ip → { n, resetAt }

export const authEnabled = () => Boolean(process.env.FPO_AUTH_TOKEN);
const hash = (sid) => createHash('sha256').update(sid).digest('hex');

function tokenOk(t) {
  const want = Buffer.from(process.env.FPO_AUTH_TOKEN ?? '');
  const got = Buffer.from(String(t ?? ''));
  return want.length > 0 && got.length === want.length && timingSafeEqual(want, got);
}

const cookieOf = (req) =>
  Object.fromEntries(
    String(req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((x) => x.length === 2)
      .map(([k, v]) => {
        try {
          return [k, decodeURIComponent(v)];
        } catch {
          return [k, ''];
        }
      }),
  );

/** действующая сессия запроса или null */
function sessionOf(req) {
  const sid = cookieOf(req).fpo_session;
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const s = one('SELECT * FROM sessions WHERE id = ?', hash(sid));
  if (!s || s.revoked_at) return null;
  const now = Date.now();
  if (new Date(s.expires_at).getTime() <= now || new Date(s.last_seen).getTime() + idleMs() <= now) return null;
  // last_seen обновляем не чаще раза в минуту — без записи в базу на каждый запрос
  if (now - new Date(s.last_seen).getTime() > 60_000) run('UPDATE sessions SET last_seen = ? WHERE id = ?', nowIso(), s.id);
  return s;
}

export function checkAuth(req) {
  if (!authEnabled()) return true;
  const h = String(req.headers.authorization ?? '');
  if (h.startsWith('Bearer ') && tokenOk(h.slice(7))) return true;
  return Boolean(sessionOf(req));
}

/** @returns {{ ok: boolean, cookie?: string, error?: string, status?: number }} */
export function login(req, token) {
  const ip = req.socket?.remoteAddress ?? '?';
  const a = attempts.get(ip) ?? { n: 0, resetAt: Date.now() + 60_000 };
  if (a.resetAt < Date.now()) Object.assign(a, { n: 0, resetAt: Date.now() + 60_000 });
  a.n++;
  attempts.set(ip, a);
  if (a.n > 5) return { ok: false, status: 429, error: 'слишком много попыток входа, подождите минуту' };
  if (!tokenOk(token)) return { ok: false, status: 401, error: 'неверный ключ доступа' };
  const sid = randomBytes(32).toString('hex');
  const now = nowIso();
  run(
    'INSERT INTO sessions(id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    hash(sid),
    now,
    now,
    new Date(Date.now() + ttlMs()).toISOString(),
    String(ip).slice(0, 60),
    String(req.headers['user-agent'] ?? '').slice(0, 200),
  );
  const secure = process.env.FPO_SECURE_COOKIE === '1' ? '; Secure' : '';
  return { ok: true, cookie: `fpo_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(ttlMs() / 1000)}${secure}` };
}

export function logout(req) {
  const s = sessionOf(req);
  if (s) run('UPDATE sessions SET revoked_at = ? WHERE id = ?', nowIso(), s.id);
  return 'fpo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}

/** список активных сессий; id — короткий префикс хэша (полный хэш наружу не отдаём) */
export function listSessions(req) {
  const cur = sessionOf(req)?.id ?? null;
  const now = Date.now();
  return {
    enabled: authEnabled(),
    policy: { ttlDays: ttlMs() / 86400_000, idleDays: idleMs() / 86400_000 },
    sessions: all('SELECT * FROM sessions WHERE revoked_at IS NULL ORDER BY last_seen DESC')
      .filter((s) => new Date(s.expires_at).getTime() > now && new Date(s.last_seen).getTime() + idleMs() > now)
      .map((s) => ({ id: s.id.slice(0, 12), created_at: s.created_at, last_seen: s.last_seen, expires_at: s.expires_at, ip: s.ip, user_agent: s.user_agent, current: s.id === cur })),
  };
}

export function revokeSession(shortId) {
  if (!/^[0-9a-f]{12}$/.test(String(shortId))) throw Object.assign(new Error('неверный id сессии'), { status: 400 });
  const r = run('UPDATE sessions SET revoked_at = ? WHERE substr(id, 1, 12) = ? AND revoked_at IS NULL', nowIso(), shortId);
  if (!r.changes) throw Object.assign(new Error('сессия не найдена'), { status: 404 });
  return { ok: true };
}

/** выйти везде, кроме текущей сессии */
export function revokeOthers(req) {
  const cur = sessionOf(req)?.id ?? '';
  const r = run('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id != ?', nowIso(), cur);
  return { revoked: Number(r.changes) };
}

export function pruneSessions() {
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', nowIso(), cutoff);
}

/** Ограничение частоты для дорогих операций: не больше max за окно windowMs на маршрут */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) ?? { n: 0, resetAt: now + windowMs };
  if (b.resetAt < now) Object.assign(b, { n: 0, resetAt: now + windowMs });
  b.n++;
  buckets.set(key, b);
  return b.n <= max ? null : Math.ceil((b.resetAt - now) / 1000);
}
