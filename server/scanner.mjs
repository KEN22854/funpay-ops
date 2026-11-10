// Сканер: собирает цены закупки у источников и цены конкурентов на FunPay.
// Прибыль НЕ считается здесь — фронтенд считает её той же формулой, что и калькулятор,
// с настройками пользователя (комиссии, споры, время, подрезка цены).
import { getOffers, summarize } from './lib/funpay.mjs';
import { passes, queryTokens, skinInText, tokens, norm } from './lib/match.mjs';
import { getRates, toRub } from './lib/rates.mjs';
import { ADAPTERS, FEED_IDS, feedIndex, SKIN_GAMES } from './sources/adapters.mjs';
import { SOURCE_BY_ID, SOURCES } from './sources/registry.mjs';

const TOP_PER_SOURCE = 5;

/** Какие автоматические источники участвуют в скане товара */
export function autoSourcesFor(watch) {
  const chosen = watch.sources?.length ? watch.sources.map((id) => SOURCE_BY_ID[id]).filter(Boolean) : SOURCES;
  return chosen.filter((s) => s.adapter && s.categories.includes(watch.category));
}

function funpayFilter(watch) {
  const inc = tokens(watch.funpay?.include);
  const exc = tokens(watch.funpay?.exclude);
  const facets = Object.entries(watch.funpay?.facets ?? {}).filter(([, v]) => v.length);
  return (o) => {
    // фильтры самого FunPay: значение лота должно входить в выбранные
    for (const [k, vals] of facets) if (!vals.includes(o.filters[k])) return false;
    if (watch.funpay?.onlineOnly && !o.online) return false;
    if (watch.funpay?.minReviews && o.reviews < watch.funpay.minReviews) return false;
    // для скинов продажа, а не аренда
    if (watch.category === 'skins' && o.filters.type2 && o.filters.type2 !== 'продажа') return false;
    const text = [o.desc, o.server, o.side, ...Object.values(o.filters)].join(' ');
    if (watch.category === 'skins' && !inc.length) return skinInText(watch.query, text) && passes(text, [], exc);
    return passes(text, inc, exc);
  };
}

export async function scanWatch(watch) {
  const startedAt = new Date().toISOString();
  const { rates, date: ratesDate } = await getRates();
  const include = watch.include?.length ? tokens(watch.include) : queryTokens(watch.query);
  const exclude = tokens(watch.exclude);
  const isSkin = watch.category === 'skins';
  const ignored = new Set(watch.ignore ?? []);

  // ── источники: один вызов адаптера на группу (CheapShark отдаёт сразу много магазинов)
  const auto = autoSourcesFor(watch);
  const byAdapter = new Map();
  for (const s of auto) {
    if (!byAdapter.has(s.adapter)) byAdapter.set(s.adapter, []);
    byAdapter.get(s.adapter).push(s.id);
  }
  const perSource = Object.fromEntries(auto.map((s) => [s.id, { sourceId: s.id, status: 'empty', offers: [], error: null }]));

  await Promise.all(
    [...byAdapter.entries()].map(async ([adapter, ids]) => {
      try {
        const offers = await ADAPTERS[adapter]({ query: watch.query, game: watch.game, category: watch.category });
        for (const o of offers) {
          const slot = perSource[o.sourceId];
          if (!slot) continue; // магазин агрегатора, не выбранный пользователем
          if (!isSkin && !passes(o.title, include, exclude)) continue;
          if (ignored.has(o.url)) continue;
          const priceRub = toRub(o.price, o.currency, rates);
          if (priceRub === null || !(priceRub > 0)) continue;
          slot.offers.push({ ...o, priceRub });
        }
      } catch (e) {
        for (const id of ids) Object.assign(perSource[id], { status: 'error', error: e.message });
      }
    }),
  );

  for (const slot of Object.values(perSource)) {
    if (slot.status === 'error') continue;
    slot.offers.sort((a, b) => a.priceRub - b.priceRub);
    slot.offers = slot.offers.slice(0, TOP_PER_SOURCE);
    slot.status = slot.offers.length ? 'ok' : 'empty';
  }

  // ── ручные цены
  const manual = (watch.manual ?? [])
    .map((m) => {
      const priceRub = toRub(Number(m.price), m.currency || 'RUB', rates);
      return priceRub && priceRub > 0
        ? { sourceId: m.sourceId, title: m.note || watch.name, price: Number(m.price), currency: m.currency || 'RUB', priceRub, url: m.url || SOURCE_BY_ID[m.sourceId]?.url, manual: true, updatedAt: m.updatedAt }
        : null;
    })
    .filter(Boolean);

  // ── FunPay
  let funpay = null;
  if (watch.funpay?.url) {
    try {
      const page = await getOffers(watch.funpay.url);
      const keep = funpayFilter(watch);
      const filtered = page.offers.filter((o) => keep(o) && !ignored.has(o.url));
      funpay = { status: 'ok', title: page.title, url: page.url, pricePer: page.pricePer, total: page.offers.length, ...summarize(filtered) };
    } catch (e) {
      funpay = { status: 'error', error: e.message, url: watch.funpay.url };
    }
  }

  return {
    watchId: watch.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    ratesDate,
    usdRub: rates.USD,
    eurRub: rates.EUR,
    sources: Object.values(perSource),
    manual,
    funpay,
  };
}

/* ───────────── Автопоиск скинов: весь раздел FunPay × выгрузки площадок ───────────── */

const MAX_NGRAM = 10;

/** самое длинное название из индекса, найденное в тексте */
function findSkin(text, index) {
  const words = norm(text).split(' ');
  let best = null;
  for (let i = 0; i < words.length; i++) {
    for (let len = Math.min(MAX_NGRAM, words.length - i); len >= 2; len--) {
      const key = words.slice(i, i + len).join(' ');
      if (index.has(key)) {
        if (!best || key.length > best.length) best = key;
        break;
      }
    }
  }
  return best;
}

export async function discoverSkins({ game = 'cs2', funpayUrl, onlineOnly = false, feeds = FEED_IDS }) {
  if (!SKIN_GAMES[game]) throw new Error('game: cs2 | dota2 | rust');
  const { rates } = await getRates();

  const feedErrors = {};
  const indexes = {};
  await Promise.all(
    feeds.map(async (f) => {
      try {
        indexes[f] = await feedIndex(f, game);
      } catch (e) {
        feedErrors[f] = e.message;
      }
    }),
  );
  // общий словарь названий
  const names = new Map();
  for (const idx of Object.values(indexes)) for (const [k, o] of idx) if (!names.has(k)) names.set(k, o.title);
  if (!names.size) throw new Error('ни одна выгрузка скинов не загрузилась: ' + JSON.stringify(feedErrors));

  const page = await getOffers(funpayUrl);
  const groups = new Map();
  let matched = 0;
  let considered = 0;
  for (const o of page.offers) {
    if (o.filters.type2 && o.filters.type2 !== 'продажа') continue;
    if (onlineOnly && !o.online) continue;
    considered++;
    const key = findSkin(o.desc, names);
    if (!key || !skinInText(names.get(key), o.desc)) continue;
    matched++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const items = [];
  for (const [key, offers] of groups) {
    const buys = [];
    for (const [f, idx] of Object.entries(indexes)) {
      const hit = idx.get(key);
      if (!hit) continue;
      const priceRub = toRub(hit.price, hit.currency, rates);
      if (priceRub > 0) buys.push({ ...hit, priceRub });
    }
    if (!buys.length) continue;
    buys.sort((a, b) => a.priceRub - b.priceRub);
    items.push({ name: names.get(key), funpay: summarize(offers), buys });
  }

  return {
    game,
    funpay: { url: page.url, title: page.title, total: page.offers.length, considered, matched },
    feedErrors,
    usdRub: rates.USD,
    items,
    scannedAt: new Date().toISOString(),
  };
}
