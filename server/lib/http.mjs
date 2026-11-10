// HTTP-клиент сканера: кэш, вежливая очередь на каждый хост, таймауты.
// Никаких обходов защиты: если сайт отвечает 403/Cloudflare — это ошибка источника, а не повод маскироваться.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FunPayOps/1.0 (personal price monitor)';

/** минимальный интервал между запросами к одному хосту, мс */
const HOST_GAP = {
  'steamcommunity.com': 3500,
  'api.skinport.com': 40000, // публичный лимит Skinport: 8 запросов / 5 минут
  default: 1200,
};

const cache = new Map(); // url → { at, ttl, value }
const inflight = new Map(); // url → Promise
const hostNext = new Map(); // host → timestamp, когда можно следующий запрос

export class SourceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function waitForHost(host) {
  const gap = HOST_GAP[host] ?? HOST_GAP.default;
  const now = Date.now();
  const at = Math.max(now, hostNext.get(host) ?? 0);
  hostNext.set(host, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/**
 * @param {string} url
 * @param {{ ttl?: number, as?: 'json'|'text', headers?: Record<string,string>, timeout?: number }} opt
 */
export async function fetchCached(url, opt = {}) {
  const { ttl = 10 * 60_000, as = 'json', headers = {}, timeout = 25_000 } = opt;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    const host = new URL(url).host;
    await waitForHost(host);
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8', ...headers },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new SourceError(`нет соединения (${e.cause?.code || e.name})`, 'network');
    }
    const body = await res.text();
    if (/cf-chl|challenge-platform|Just a moment\.\.\./i.test(body.slice(0, 20000))) {
      throw new SourceError('сайт закрыт проверкой Cloudflare', 'blocked');
    }
    if (res.status === 429) throw new SourceError('лимит запросов источника (429), повтор позже', 'ratelimit');
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`, res.status === 403 ? 'blocked' : 'http');
    let value = body;
    if (as === 'json') {
      try {
        value = JSON.parse(body);
      } catch {
        throw new SourceError('источник вернул не JSON', 'format');
      }
    }
    cache.set(url, { at: Date.now(), ttl, value });
    return value;
  })();

  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

export function cacheStats() {
  return { entries: cache.size };
}

export function clearCache() {
  cache.clear();
}
