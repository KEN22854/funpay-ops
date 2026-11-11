// Доступ к API, когда сервер открыт в сеть (VPS). Локально (127.0.0.1) вход не нужен.
// FPO_AUTH_TOKEN — длинный секрет; вход выдаёт cookie сессии (HttpOnly, SameSite=Strict).
import { randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 30 * 86400_000;
const sessions = new Map(); // id → expiresAt
const attempts = new Map(); // ip → { n, resetAt }

export const authEnabled = () => Boolean(process.env.FPO_AUTH_TOKEN);

function tokenOk(t) {
  const want = Buffer.from(process.env.FPO_AUTH_TOKEN ?? '');
  const got = Buffer.from(String(t ?? ''));
  return want.length > 0 && got.length === want.length && timingSafeEqual(want, got);
}

const cookieOf = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((x) => x.length === 2));

export function checkAuth(req) {
  if (!authEnabled()) return true;
  const h = String(req.headers.authorization ?? '');
  if (h.startsWith('Bearer ') && tokenOk(h.slice(7))) return true;
  const sid = cookieOf(req).fpo_session;
  const exp = sid && sessions.get(sid);
  if (exp && exp > Date.now()) return true;
  if (sid) sessions.delete(sid);
  return false;
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
  sessions.set(sid, Date.now() + TTL_MS);
  const secure = process.env.FPO_SECURE_COOKIE === '1' ? '; Secure' : '';
  return { ok: true, cookie: `fpo_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}${secure}` };
}

export function logout(req) {
  const sid = cookieOf(req).fpo_session;
  if (sid) sessions.delete(sid);
  return 'fpo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
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
