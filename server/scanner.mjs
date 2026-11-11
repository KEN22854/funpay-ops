// Сканер: собирает цены источников и FunPay, сопоставляет атрибуты, пишет здоровье источников и историю.
// Оценка прибыли и статус рекомендации — в core/engine.mjs (opportunities.mjs).
import { funpayAttrs, extractAttrs, matchOffer } from './core/attributes.mjs';
import { getOffers, summarize } from './lib/funpay.mjs';
import { SourceError } from './lib/http.mjs';
import { norm, passes, queryTokens, skinInText, tokens } from './lib/match.mjs';
import { getRates, toRub } from './lib/rates.mjs';
import { observeSectionFee } from './repo/fees.mjs';
import { circuitOpen, recordHealth } from './repo/health.mjs';
import { assessOffers } from './repo/quality.mjs';
import { snapshotFunpay, snapshotSource } from './repo/history.mjs';
import { decisions } from './repo/watches.mjs';
import { getSettings } from './repo/settings.mjs';
import { ADAPTERS, FEED_IDS, feedIndex, SKIN_GAMES } from './sources/adapters.mjs';
import { SOURCE_BY_ID, SOURCES } from './sources/registry.mjs';

const TOP_PER_SOURCE = 8;

/** ключи фильтров FunPay, которые описывают способ/регион/платформу, а не вариант товара */
const NON_VARIANT = new Set(['server', 'type', 'region', 'region2', 'auto', 'method', 'quantity', 'side']);

export function variantExclusions(facets = [], selected = {}) {
  const out = [];
  for (const f of facets) {
    const chosen = selected?.[f.key];
    if (NON_VARIANT.has(f.key) || !chosen?.length) continue;
    for (const o of f.options) {
      const n = norm(o.label);
      // «Standard Edition» не исключаем: слово standard встречается в названиях любых изданий
      if (!chosen.includes(o.value) && n.length >= 4 && !/^standard|стандарт/.test(n)) out.push({ label: o.label, norm: n });
    }
  }
  return out;
}

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
    for (const [k, vals] of facets) if (!vals.includes(o.filters[k])) return false;
    if (watch.funpay?.onlineOnly && !o.online) return false;
    if (watch.funpay?.minReviews && o.reviews < watch.funpay.minReviews) return false;
    if (watch.category === 'skins' && o.filters.type2 && o.filters.type2 !== 'продажа') return false;
    const text = [o.desc, o.server, o.side, ...Object.values(o.filters)].join(' ');
    if (watch.category === 'skins' && !inc.length) return skinInText(watch.query, text) && passes(text, [], exc);
    return passes(text, inc, exc);
  };
}

const errClass = (e) => (e instanceof SourceError ? e.code : 'unknown');

/** Сопоставление предложения источника с карточкой */
function matchSourceOffer(watch, o, dec) {
  const src = SOURCE_BY_ID[o.sourceId] ?? {};
  const attrs = extractAttrs(o.title);
  const known = src.known ?? {};
  const merged = {
    ...attrs,
    knownType: o.knownType ?? known.type,
    knownPlatform: o.knownPlatform ?? (attrs.platforms.length ? null : known.platform),
    knownRegion: o.knownRegion ?? (attrs.regions.length ? null : known.region),
  };
  return matchOffer(merged, watch.attrs ?? {}, {
    category: watch.category,
    side: 'source',
    title: o.title,
    nameExact: watch.category === 'skins' ? norm(o.title) === norm(watch.query) : undefined,
    phase: o.phase,
    float: o.float ?? attrs.float ?? null,
    paintSeed: o.paintSeed ?? attrs.paintSeed ?? null,
    stickers: o.stickers ?? attrs.stickers ?? null,
    watchName: watch.category === 'skins' ? undefined : watch.name || watch.query,
    decision: dec[o.url],
    skinsStrict: getSettings().matching.skinsStrict,
  });
}

export async function scanWatch(watch) {
  const startedAt = new Date().toISOString();
  const S = getSettings();
  const { rates, date: ratesDate } = await getRates();
  const include = watch.include?.length ? tokens(watch.include) : queryTokens(watch.query);
  const exclude = tokens(watch.exclude);
  const isSkin = watch.category === 'skins';
  const ignored = new Set(watch.ignore ?? []);
  const dec = decisions.forWatch(watch.id);

  // ── источники: один вызов адаптера на группу; сбой одного адаптера не ломает остальные
  const auto = autoSourcesFor(watch);
  const byAdapter = new Map();
  for (const s of auto) {
    if (!byAdapter.has(s.adapter)) byAdapter.set(s.adapter, []);
    byAdapter.get(s.adapter).push(s.id);
  }
  const perSource = Object.fromEntries(auto.map((s) => [s.id, { sourceId: s.id, status: 'empty', offers: [], rejected: 0, error: null, errorClass: null }]));

  await Promise.all(
    [...byAdapter.entries()].map(async ([adapter, ids]) => {
      const open = ids.map((id) => circuitOpen(id)).find(Boolean);
      if (open) {
        for (const id of ids) Object.assign(perSource[id], { status: 'error', errorClass: 'circuit_open', error: `отключён до ${open} после серии ошибок` });
        return;
      }
      const t0 = Date.now();
      try {
        const offers = await ADAPTERS[adapter]({ query: watch.query, game: watch.game, category: watch.category });
        const fetchedAt = new Date().toISOString();
        const raw = Object.fromEntries(ids.map((id) => [id, []]));
        for (const o of offers) if (raw[o.sourceId]) raw[o.sourceId].push({ ...o, priceRub: toRub(o.price, o.currency, rates) ?? 0 });
        for (const id of ids) {
          const slot = perSource[id];
          // качество данных — по всем ответам источника, до фильтрации по словам
          const list = raw[id].sort((a, b) => (a.priceRub || Infinity) - (b.priceRub || Infinity));
          const q = assessOffers(list, { watchId: watch.id, sourceId: id, ratesDate });
          list.forEach((o, i) => {
            if (!isSkin && !passes(o.title, include, exclude)) return;
            if (ignored.has(o.url)) return;
            if (!(o.priceRub > 0)) return;
            const fxRate = o.currency === 'RUB' ? 1 : rates[o.currency];
            const match = matchSourceOffer(watch, o, dec);
            if (match.status === 'REJECTED') slot.rejected++;
            slot.offers.push({ ...o, fxRate, fetchedAt, match, dq: q.issues[i] });
          });
          recordHealth(id, {
            ok: true,
            latencyMs: Date.now() - t0,
            items: list.length,
            dqChecked: q.checked,
            dqIssues: q.withIssues,
            dqDetail: q.withIssues ? JSON.stringify([...new Set(q.issues.flat())].slice(0, 5)) : null,
          });
        }
      } catch (e) {
        for (const id of ids) {
          Object.assign(perSource[id], { status: 'error', error: e.message, errorClass: errClass(e) });
          recordHealth(id, { ok: false, errorClass: errClass(e), httpStatus: e.status ?? null, latencyMs: e.latencyMs ?? Date.now() - t0, detail: e.sample ?? e.message });
        }
      }
    }),
  );

  // ── ручные цены: время цены = время ввода; атрибуты — указанные пользователем
  const manual = (watch.manual ?? [])
    .map((m) => {
      const priceRub = toRub(Number(m.price), m.currency || 'RUB', rates);
      if (!(priceRub > 0)) return null;
      const o = {
        sourceId: m.sourceId,
        title: m.note || watch.name,
        price: Number(m.price),
        currency: m.currency || 'RUB',
        priceRub,
        fxRate: (m.currency || 'RUB') === 'RUB' ? 1 : rates[m.currency],
        url: m.url || SOURCE_BY_ID[m.sourceId]?.url,
        manual: true,
        stock: m.stock ?? null,
        fetchedAt: m.updatedAt,
        knownRegion: m.region || undefined,
        knownPlatform: m.platform || undefined,
        knownType: m.type || undefined,
      };
      return { ...o, match: matchSourceOffer(watch, o, dec) };
    })
    .filter(Boolean);

  // ── FunPay
  let funpay = null;
  /** невыбранные варианты издания из фильтров раздела FunPay — признаки другого товара */
  let variantExcludes = [];
  if (watch.funpay?.url) {
    const t0 = Date.now();
    try {
      const page = await getOffers(watch.funpay.url);
      recordHealth('funpay', { ok: true, latencyMs: Date.now() - t0, items: page.offers.length });
      const fetchedAt = new Date().toISOString();
      const fee = observeSectionFee(page.url, page.title);
      variantExcludes = variantExclusions(page.facets, watch.funpay?.facets);
      const keep = funpayFilter(watch);
      const candidates = page.offers.filter((o) => keep(o) && !ignored.has(o.url));
      // конкуренты тоже сверяются по атрибутам: чужое издание/регион не должно задавать цену
      const matched = candidates.map((o) => ({
        ...o,
        match: (() => {
          const fa = funpayAttrs(o);
          return matchOffer(fa, watch.attrs ?? {}, { category: watch.category, side: 'funpay', title: o.desc, nameExact: isSkin ? true : undefined, decision: dec[o.url], float: fa.float, paintSeed: fa.paintSeed, stickers: fa.stickers, watchName: isSkin ? undefined : watch.name || watch.query });
        })(),
      }));
      const market = matched.filter((o) => o.match.status !== 'REJECTED');
      snapshotFunpay(watch.id, market, { expectedGapMin: S.intervalMin || 60 });
      const sum = summarize(market);
      funpay = {
        status: 'ok',
        title: page.title,
        url: page.url,
        pricePer: page.pricePer,
        total: page.offers.length,
        filtered: candidates.length,
        rejected: matched.length - market.length,
        fetchedAt,
        prices: market.map((o) => o.price).sort((a, b) => a - b).slice(0, 50),
        sellers: new Set(market.map((o) => o.seller)).size,
        topSellerShare: market.length ? Math.max(...Object.values(market.reduce((m, o) => ((m[o.seller] = (m[o.seller] ?? 0) + 1), m), {}))) / market.length : null,
        observedFee: fee ? { pct: fee.pct, source: fee.source } : null,
        ...sum,
        top: [...matched].sort((a, b) => a.price - b.price).slice(0, 12),
      };
    } catch (e) {
      recordHealth('funpay', { ok: false, errorClass: errClass(e), httpStatus: e.status ?? null, latencyMs: Date.now() - t0, detail: e.sample ?? e.message });
      funpay = { status: 'error', error: e.message, errorClass: errClass(e), url: watch.funpay.url };
    }
  }

  // вариант издания, не выбранный в разделе FunPay (например DLC «Shadow of the Erdtree» при выбранном Standard), — другой товар
  if (variantExcludes.length) {
    for (const slot of Object.values(perSource)) {
      for (const o of slot.offers) {
        if (o.match.status === 'REJECTED' || o.match.source === 'manual') continue;
        const t = norm(o.title);
        const hit = variantExcludes.find((v) => t.includes(v.norm));
        if (hit) {
          o.match = { ...o.match, status: 'REJECTED', reasons: [...o.match.reasons, { ok: false, text: `вариант «${hit.label}» не выбран в фильтрах раздела FunPay` }] };
          slot.rejected++;
        }
      }
    }
  }

  const rank = { VERIFIED: 0, REVIEW_REQUIRED: 1, REJECTED: 2 };
  for (const slot of Object.values(perSource)) {
    if (slot.status === 'error') continue;
    slot.offers.sort((a, b) => rank[a.match.status] - rank[b.match.status] || a.priceRub - b.priceRub);
    const usable = slot.offers.filter((o) => o.match.status !== 'REJECTED');
    snapshotSource(watch.id, slot.sourceId, usable);
    slot.offers = slot.offers.slice(0, TOP_PER_SOURCE);
    slot.status = usable.length ? 'ok' : slot.offers.length ? 'rejected' : 'empty';
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
  if (!SKIN_GAMES[game]) throw Object.assign(new Error('game: cs2 | dota2 | rust'), { status: 400 });
  const { rates } = await getRates();

  const feedErrors = {};
  const indexes = {};
  await Promise.all(
    feeds.map(async (f) => {
      if (circuitOpen(f)) {
        feedErrors[f] = 'отключён после серии ошибок';
        return;
      }
      const t0 = Date.now();
      try {
        indexes[f] = await feedIndex(f, game);
        recordHealth(f, { ok: true, latencyMs: Date.now() - t0, items: indexes[f].size });
      } catch (e) {
        feedErrors[f] = e.message;
        recordHealth(f, { ok: false, errorClass: errClass(e), httpStatus: e.status ?? null, latencyMs: Date.now() - t0, detail: e.sample ?? e.message });
      }
    }),
  );
  const fetchedAt = new Date().toISOString();
  const names = new Map();
  for (const idx of Object.values(indexes)) for (const [k, o] of idx) if (!names.has(k)) names.set(k, o.title);
  if (!names.size) throw new Error('ни одна выгрузка скинов не загрузилась: ' + JSON.stringify(feedErrors));

  const t0 = Date.now();
  let page;
  try {
    page = await getOffers(funpayUrl);
    recordHealth('funpay', { ok: true, latencyMs: Date.now() - t0, items: page.offers.length });
  } catch (e) {
    recordHealth('funpay', { ok: false, errorClass: errClass(e), httpStatus: e.status ?? null, latencyMs: Date.now() - t0, detail: e.message });
    throw e;
  }
  observeSectionFee(page.url, page.title);
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
    const name = names.get(key);
    const buys = [];
    for (const idx of Object.values(indexes)) {
      const hit = idx.get(key);
      if (!hit) continue;
      const priceRub = toRub(hit.price, hit.currency, rates);
      if (!(priceRub > 0)) continue;
      const match = matchOffer({}, {}, { category: 'skins', side: 'source', title: name, nameExact: true, phase: hit.phase });
      buys.push({ ...hit, priceRub, fxRate: hit.currency === 'RUB' ? 1 : rates[hit.currency], fetchedAt, match });
    }
    if (!buys.length) continue;
    buys.sort((a, b) => a.priceRub - b.priceRub);
    const prices = offers.map((o) => o.price).sort((a, b) => a - b);
    const bySeller = offers.reduce((m, o) => ((m[o.seller] = (m[o.seller] ?? 0) + 1), m), {});
    items.push({
      name,
      funpay: { ...summarize(offers), prices: prices.slice(0, 50), sellers: Object.keys(bySeller).length, topSellerShare: Math.max(...Object.values(bySeller)) / offers.length, fetchedAt },
      buys,
    });
  }

  return {
    game,
    funpay: { url: page.url, title: page.title, total: page.offers.length, considered, matched },
    feedErrors,
    usdRub: rates.USD,
    items,
    scannedAt: fetchedAt,
  };
}
