// Чтение публичных страниц FunPay: каталог игр и таблица предложений раздела.
// Без авторизации и golden_key — только то, что видит любой посетитель. Цены в рублях через cookie cy=rub.
import { fetchCached, SourceError } from './http.mjs';

const BASE = 'https://funpay.com';
const HEADERS = { Cookie: 'cy=rub' };

const decode = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** "1 234,50 ₽" → 1234.5 */
export function parsePrice(s) {
  const t = decode(s).replace(/[^\d.,]/g, '').replace(',', '.');
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

/** Только разделы FunPay: /lots/<id>/ или /chips/<id>/ */
export function normalizeCategoryUrl(u) {
  const m = String(u ?? '').match(/funpay\.com\/(?:[a-z]{2}\/)?(lots|chips)\/(\d+)/);
  if (!m) throw new SourceError('нужна ссылка на раздел FunPay вида https://funpay.com/lots/1234/ или /chips/12/', 'input');
  return { kind: m[1], id: Number(m[2]), url: `${BASE}/${m[1]}/${m[2]}/` };
}

/** Каталог: игры и их подразделы с главной страницы */
export async function getCatalog() {
  const html = await fetchCached(`${BASE}/`, { as: 'text', headers: HEADERS, ttl: 12 * 3600_000 });
  const games = [];
  const blockRe = /<div class="game-title"[^>]*data-id="(\d+)"[^>]*>\s*<a href="([^"]+)">([^<]+)<\/a>\s*<\/div>\s*<ul class="list-inline"[^>]*>([\s\S]*?)<\/ul>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const sections = [...m[4].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((s) => ({ url: s[1], name: decode(s[2]) }));
    games.push({ id: Number(m[1]), name: decode(m[3]), url: m[2], sections });
  }
  if (!games.length) throw new SourceError('не удалось разобрать каталог FunPay — возможно, изменилась вёрстка', 'format');
  // одна игра может встречаться в нескольких блоках главной
  const uniq = new Map();
  for (const g of games) if (!uniq.has(g.id)) uniq.set(g.id, g);
  return [...uniq.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Предложения раздела.
 * Для /lots/ цена — за 1 шт. Для /chips/ цена указана за единицу из заголовка колонки (например «Цена/1000»).
 */
export async function getOffers(categoryUrl) {
  const { kind, url } = normalizeCategoryUrl(categoryUrl);
  const html = await fetchCached(url, { as: 'text', headers: HEADERS, ttl: 5 * 60_000 });
  const title = decode((html.match(/<title>([^<]+)<\/title>/) || [])[1]);

  const header = decode((html.match(/<div class="tc-header">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1]);
  const per = Number(((header.match(/Цена\s*\/\s*([\d\s]+)/) || [])[1] || '1').replace(/\s/g, '')) || 1;

  const offers = [];
  const rowRe = /<a href="([^"]+)" class="tc-item[^"]*"([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const attrs = m[2];
    const body = m[3];
    const price = parsePrice((body.match(/class="tc-price"[^>]*>\s*<div>([\s\S]*?)<\/div>/) || [])[1]);
    if (price === null) continue;
    const filters = {};
    for (const f of attrs.matchAll(/data-f-([\w-]+)="([^"]*)"/g)) filters[f[1]] = decode(f[2]).toLowerCase();
    const serverAttr = (attrs.match(/data-server="([^"]*)"/) || [])[1];
    if (kind === 'lots' && serverAttr) filters.server = serverAttr; // платформа (PC/PS/Xbox) в разделах лотов
    if (/data-auto="1"/.test(attrs)) filters.auto = '1';
    const amountRaw = (body.match(/class="tc-amount"[^>]*>([^<]*)</) || [])[1];
    offers.push({
      url: m[1],
      online: /data-online="1"/.test(attrs),
      desc: decode((body.match(/class="tc-desc-text">([\s\S]*?)<\/div>/) || [])[1]),
      server: decode((body.match(/class="tc-server[^"]*">([^<]*)</) || [])[1]),
      side: decode((body.match(/class="tc-side[^"]*">([^<]*)</) || [])[1]),
      seller: decode((body.match(/class="media-user-name">([\s\S]*?)<\/div>/) || [])[1]),
      reviews: Number((body.match(/rating-mini-count">(\d+)/) || [])[1] || 0),
      amount: amountRaw ? Number(decode(amountRaw).replace(/\s/g, '')) || null : null,
      price,
      filters,
    });
  }
  if (!offers.length && !/tc-item/.test(html)) throw new SourceError('на странице нет таблицы предложений', 'format');
  return { kind, url, title, pricePer: kind === 'chips' ? per : 1, offers, facets: parseFacets(html, kind, offers) };
}

/**
 * Фильтры раздела FunPay (платформа, издание, способ получения, регион…) с количеством лотов по каждому значению.
 * Значения приводятся к нижнему регистру — так они записаны в data-f-* у лотов.
 */
export function parseFacets(html, kind, offers) {
  const form = (html.match(/class="showcase-filters">([\s\S]*?)<\/form>/) || [])[1] ?? '';
  const facets = [];
  const push = (key, label, opts) => {
    const counts = {};
    for (const o of offers) {
      const v = o.filters[key];
      if (v !== undefined) counts[v] = (counts[v] ?? 0) + 1;
    }
    const options = opts
      .map(([value, text]) => ({ value: kind === 'lots' && key === 'server' ? value : value.toLowerCase(), label: decode(text), count: 0 }))
      .map((o) => ({ ...o, count: counts[o.value] ?? 0 }))
      .filter((o) => o.value && o.count > 0);
    if (options.length) facets.push({ key, label: decode(label), options });
  };
  // селекты: <select name="f-type"> / <select name="server">
  for (const m of form.matchAll(/<select[^>]*name="(f-[\w-]+|server)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const key = m[1].replace(/^f-/, '');
    if (kind === 'chips' && key === 'server') continue; // в разделах валюты сервер — колонка таблицы, не фильтр data-f
    const opts = [...m[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)];
    const label = opts.find((o) => o[1] === '')?.[2] ?? key;
    push(key, label, opts.filter((o) => o[1] !== '').map((o) => [o[1], o[2]]));
  }
  // кнопки-переключатели: <div data-id="type2"> <button value="Standard Edition">
  for (const m of form.matchAll(/data-id="([\w-]+)">\s*<div class="lot-field-radio-box">([\s\S]*?)<\/div>/g)) {
    const opts = [...m[2].matchAll(/<button[^>]*value="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map((o) => [o[1], o[2]]);
    push(m[1], 'Вариант', opts);
  }
  if (offers.some((o) => o.filters.auto === '1')) {
    facets.push({ key: 'auto', label: 'Автовыдача', options: [{ value: '1', label: 'с автовыдачей', count: offers.filter((o) => o.filters.auto === '1').length }] });
  }
  return facets;
}

/** Сводка по отфильтрованным предложениям: минимальная цена, медиана первых 10, количество */
export function summarize(offers) {
  const sorted = [...offers].sort((a, b) => a.price - b.price);
  const top = sorted.slice(0, 10).map((o) => o.price);
  const median = top.length ? (top.length % 2 ? top[(top.length - 1) / 2] : (top[top.length / 2 - 1] + top[top.length / 2]) / 2) : null;
  return {
    count: sorted.length,
    online: sorted.filter((o) => o.online).length,
    min: sorted[0]?.price ?? null,
    median10: median,
    top: sorted.slice(0, 10),
  };
}
