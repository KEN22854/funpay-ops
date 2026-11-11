// HTTP-клиент сканера: кэш, очередь на каждый хост, таймауты, повторы с экспоненциальной паузой.
// Никаких обходов защиты: 403/Cloudflare — это ошибка источника, а не повод маскироваться.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FunPayOps/2.0 (personal price monitor)';

/** минимальный интервал между запросами к одному хосту, мс */
const HOST_GAP = {
  'steamcommunity.com': 3500,
  'api.skinport.com': 40000, // публичный лимит Skinport: 8 запросов / 5 минут
  'funpay.com': 2000,
  default: 1200,
};

const RETRYABLE = new Set(['ratelimit', 'server', 'network', 'timeout']);
const MAX_RETRIES = Number(process.env.FPO_HTTP_RETRIES ?? 2);
const BASE_DELAY = Number(process.env.FPO_HTTP_BACKOFF_MS ?? 2000);

const cache = new Map(); // url → { at, ttl, value, fetchedAt }
const inflight = new Map();
const hostNext = new Map();

/**
 * Классы ошибок: blocked (403/Cloudflare), ratelimit (429), server (5xx), http (прочие 4xx),
 * network, timeout, format (ответ не той структуры), input (ошибка запроса).
 */
export class SourceError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function waitForHost(host) {
  // FPO_HTTP_NO_GAP — только для тестов на фикстурах (сеть не используется)
  const gap = process.env.FPO_HTTP_NO_GAP ? 0 : (HOST_GAP[host] ?? HOST_GAP.default);
  const now = Date.now();
  const at = Math.max(now, hostNext.get(host) ?? 0);
  hostNext.set(host, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** обрезанный безопасный образец ответа для диагностики (без cookie и заголовков) */
const sampleOf = (body) => String(body ?? '').slice(0, 600);

async function fetchOnce(url, { as, headers, timeout }) {
  const host = new URL(url).host;
  await waitForHost(host);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8', ...headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    throw new SourceError(isTimeout ? `таймаут ${timeout / 1000} с` : `нет соединения (${e.cause?.code || e.name})`, isTimeout ? 'timeout' : 'network', {
      latencyMs: Date.now() - started,
    });
  }
  const body = await res.text();
  const latencyMs = Date.now() - started;
  const base = { status: res.status, latencyMs };
  if (/cf-chl|challenge-platform|Just a moment\.\.\./i.test(body.slice(0, 20000))) throw new SourceError('сайт закрыт проверкой Cloudflare', 'blocked', base);
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new SourceError('лимит запросов источника (429)', 'ratelimit', { ...base, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : null });
  }
  if (res.status === 403) throw new SourceError('доступ запрещён (403)', 'blocked', base);
  if (res.status >= 500) throw new SourceError(`ошибка сервера источника (${res.status})`, 'server', base);
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`, 'http', base);
  if (as !== 'json') return { value: body, latencyMs };
  try {
    return { value: JSON.parse(body), latencyMs };
  } catch {
    throw new SourceError('источник вернул не JSON — возможно, изменился формат', 'format', { ...base, sample: sampleOf(body) });
  }
}

/**
 * @param {string} url
 * @param {{ ttl?: number, as?: 'json'|'text', headers?: Record<string,string>, timeout?: number, retries?: number }} opt
 */
export async function fetchCached(url, opt = {}) {
  const { ttl = 10 * 60_000, as = 'json', headers = {}, timeout = 25_000, retries = MAX_RETRIES } = opt;
  const hit = cache.get(url);
  if (!freshDepth && hit && Date.now() - hit.at < hit.ttl) return hit.value;
  if (!freshDepth && inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { value } = await fetchOnce(url, { as, headers, timeout });
        cache.set(url, { at: Date.now(), ttl, value });
        return value;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof SourceError) || !RETRYABLE.has(e.code) || attempt === retries) break;
        const delay = e.retryAfterMs ?? BASE_DELAY * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(delay, 60_000)));
      }
    }
    if (lastErr instanceof SourceError) lastErr.attempts = retries + 1;
    throw lastErr;
  })();

  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

let freshDepth = 0;
/** Выполнить fn с запросами мимо кэша — для перепроверки связки перед закупкой */
export async function withFresh(fn) {
  freshDepth++;
  try {
    return await fn();
  } finally {
    freshDepth--;
  }
}

export function cacheStats() {
  return { entries: cache.size };
}

export function clearCache() {
  cache.clear();
}
