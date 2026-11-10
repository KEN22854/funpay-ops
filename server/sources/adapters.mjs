// Адаптеры источников. Каждый возвращает массив предложений:
//   { sourceId, title, price, currency, url, stock? }
// Перевод в рубли и фильтрация по словам — в scanner.mjs, чтобы логика была в одном месте.
import { fetchCached, SourceError } from '../lib/http.mjs';
import { norm } from '../lib/match.mjs';

const enc = encodeURIComponent;
const FEED_TTL = 15 * 60_000;

/* ─────────────── Ключи и игры ─────────────── */

async function steamStore({ query }) {
  const d = await fetchCached(`https://store.steampowered.com/api/storesearch/?term=${enc(query)}&cc=ru&l=russian`);
  return (d.items ?? [])
    .filter((i) => i.price && i.price.currency === 'RUB')
    .map((i) => ({
      sourceId: 'steam',
      title: i.name,
      price: i.price.final / 100,
      currency: 'RUB',
      url: `https://store.steampowered.com/${i.type === 'sub' ? 'sub' : 'app'}/${i.id}/`,
    }));
}

async function plati({ query }) {
  const d = await fetchCached(`https://plati.io/api/search.ashx?query=${enc(query)}&pagesize=100&response=json`);
  return (d.items ?? [])
    .filter((i) => Number(i.price_rur) > 0)
    .map((i) => ({ sourceId: 'plati', title: i.name, price: Number(i.price_rur), currency: 'RUB', url: i.url }));
}

async function gog({ query }) {
  const d = await fetchCached(
    `https://catalog.gog.com/v1/catalog?query=like:${enc(query)}&limit=48&countryCode=RU&currencyCode=RUB&locale=ru-RU&order=desc:score`,
  );
  return (d.products ?? [])
    .filter((p) => p.price?.finalMoney?.currency === 'RUB')
    .map((p) => ({
      sourceId: 'gog',
      title: p.title,
      price: Number(p.price.finalMoney.amount),
      currency: 'RUB',
      url: p.storeLink,
    }));
}

async function gabestore({ query }) {
  const d = await fetchCached(`https://gabestore.ru/search/next?ProductFilter%5Bsearch%5D=${enc(query)}&page=1`);
  const html = String(d.html ?? '');
  const out = [];
  for (const m of html.matchAll(/class="shop-item__name" href="([^"]+)">([^<]+)<\/a>[\s\S]*?shop-item__price-current">([\d\s]+)\s*₽/g)) {
    out.push({ sourceId: 'gabestore', title: m[2].trim(), price: Number(m[3].replace(/\s/g, '')), currency: 'RUB', url: `https://gabestore.ru${m[1]}` });
  }
  return out;
}

/** CheapShark — агрегатор цен ~десятка западных магазинов (цены в USD, регион США). */
async function cheapshark({ query }) {
  const games = await fetchCached(`https://www.cheapshark.com/api/1.0/games?title=${enc(query)}&limit=10`);
  if (!Array.isArray(games) || !games.length) return [];
  // берём игры, чьё название содержит все слова запроса (не больше 3 вызовов)
  const q = norm(query);
  const picked = games.filter((g) => norm(g.external).includes(q)).slice(0, 3);
  const list = picked.length ? picked : games.slice(0, 1);
  const out = [];
  for (const g of list) {
    const info = await fetchCached(`https://www.cheapshark.com/api/1.0/games?id=${g.gameID}`);
    for (const deal of info.deals ?? []) {
      out.push({
        sourceId: `cs-${deal.storeID}`,
        title: info.info?.title ?? g.external,
        price: Number(deal.price),
        currency: 'USD',
        url: `https://www.cheapshark.com/redirect?dealID=${deal.dealID}`,
      });
    }
  }
  return out;
}

/* ─────────────── Скины (выгрузки целиком) ─────────────── */

export const SKIN_GAMES = {
  cs2: { appid: 730, tm: 'https://market.csgo.com', lis: 'csgo', wax: 'csgo' },
  dota2: { appid: 570, tm: 'https://market.dota2.net', lis: 'dota2', wax: 'dota2' },
  rust: { appid: 252490, tm: 'https://rust.tm', lis: 'rust', wax: 'rust' },
};

const indexCache = new WeakMap();
/** индекс выгрузки: нормализованное имя → предложение */
function indexOf(raw, build) {
  let idx = indexCache.get(raw);
  if (!idx) {
    idx = new Map();
    for (const o of build(raw)) {
      const k = norm(o.title);
      const prev = idx.get(k);
      if (!prev || o.price < prev.price) idx.set(k, o);
    }
    indexCache.set(raw, idx);
  }
  return idx;
}

const feeds = {
  async skinport(game) {
    const raw = await fetchCached(`https://api.skinport.com/v1/items?app_id=${SKIN_GAMES[game].appid}&currency=RUB&tradable=0`, {
      ttl: FEED_TTL,
      headers: { 'Accept-Encoding': 'br' },
    });
    return indexOf(raw, (r) =>
      r
        .filter((i) => i.min_price > 0)
        .map((i) => ({ sourceId: 'skinport', title: i.market_hash_name, price: i.min_price, currency: 'RUB', url: i.item_page, stock: i.quantity })),
    );
  },
  async tm(game) {
    const base = SKIN_GAMES[game].tm;
    const raw = await fetchCached(`${base}/api/v2/prices/RUB.json`, { ttl: FEED_TTL });
    return indexOf(raw, (r) =>
      (r.items ?? []).map((i) => ({
        sourceId: 'tm',
        title: i.market_hash_name,
        price: Number(i.price),
        currency: 'RUB',
        url: `${base}/?search=${enc(i.market_hash_name)}`,
        stock: i.volume,
      })),
    );
  },
  async lis(game) {
    const raw = await fetchCached(`https://lis-skins.com/market_export_json/${SKIN_GAMES[game].lis}.json`, { ttl: FEED_TTL });
    // unlocked_price — цена предметов без трейд-лока (их можно сразу передать покупателю)
    return indexOf(raw, (r) =>
      r
        .map((i) => ({ sourceId: 'lis', title: i.name, price: Number(i.unlocked_price ?? i.price), currency: 'USD', url: i.url, stock: i.count }))
        .filter((o) => o.price > 0),
    );
  },
  async waxpeer(game) {
    const raw = await fetchCached(`https://api.waxpeer.com/v1/prices?game=${SKIN_GAMES[game].wax}&minified=1`, { ttl: FEED_TTL });
    // min — в тысячных долях доллара
    return indexOf(raw, (r) =>
      (r.items ?? [])
        .filter((i) => i.min > 0)
        .map((i) => ({ sourceId: 'waxpeer', title: i.name, price: i.min / 1000, currency: 'USD', url: `https://waxpeer.com/?search=${enc(i.name)}`, stock: i.count })),
    );
  },
};

export const FEED_IDS = Object.keys(feeds);

export async function feedIndex(feedId, game) {
  if (!SKIN_GAMES[game]) throw new SourceError(`неизвестная игра для скинов: ${game}`, 'input');
  return feeds[feedId](game);
}

function feedAdapter(feedId) {
  return async ({ query, game }) => {
    const idx = await feedIndex(feedId, game || 'cs2');
    const hit = idx.get(norm(query));
    return hit ? [hit] : [];
  };
}

async function steamMarket({ query, game }) {
  const appid = SKIN_GAMES[game || 'cs2'].appid;
  const d = await fetchCached(
    `https://steamcommunity.com/market/priceoverview/?appid=${appid}&currency=5&market_hash_name=${enc(query)}`,
    { ttl: 30 * 60_000 },
  );
  if (!d.success || !d.lowest_price) return [];
  const price = parseFloat(d.lowest_price.replace(/[^\d,.]/g, '').replace(',', '.'));
  return [
    {
      sourceId: 'steam-market',
      title: query,
      price,
      currency: 'RUB',
      url: `https://steamcommunity.com/market/listings/${appid}/${enc(query)}`,
      stock: Number(String(d.volume ?? '').replace(/\D/g, '')) || null,
    },
  ];
}

export const ADAPTERS = {
  steam: steamStore,
  plati,
  gog,
  gabestore,
  cheapshark,
  skinport: feedAdapter('skinport'),
  tm: feedAdapter('tm'),
  lis: feedAdapter('lis'),
  waxpeer: feedAdapter('waxpeer'),
  'steam-market': steamMarket,
};
