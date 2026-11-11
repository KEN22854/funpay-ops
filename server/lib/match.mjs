// Нормализация текста и сопоставление названий товаров.

export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}|()]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Слова через запятую/пробел → массив нормализованных токенов */
export function tokens(list) {
  if (Array.isArray(list)) return list.map(norm).filter(Boolean);
  return String(list ?? '')
    .split(',')
    .map(norm)
    .filter(Boolean);
}

/**
 * Проходит ли название фильтр: все include-фразы есть, ни одной exclude.
 * Фразы сравниваются как подстроки нормализованного текста.
 */
export function passes(title, include = [], exclude = []) {
  const t = norm(title);
  return include.every((w) => t.includes(w)) && !exclude.some((w) => w && t.includes(w));
}

/** Слова запроса как include-фильтр по умолчанию (короткие предлоги отбрасываются) */
export function queryTokens(q) {
  return norm(q)
    .split(' ')
    .filter((w) => w.length > 1);
}

const WEAR = ['factory new', 'minimal wear', 'field tested', 'well worn', 'battle scarred'];

/** Русские названия износа и качества в Steam → английские (лоты FunPay часто на русском) */
const RU_SKIN = [
  [/прямо с завода/g, 'factory new'],
  [/немного поношенн\p{L}*/gu, 'minimal wear'],
  [/после полевых испытаний/g, 'field tested'],
  [/поношенн\p{L}*/gu, 'well worn'],
  [/закал[её]нн\p{L}* в боях/gu, 'battle scarred'],
  [/сувенирн\p{L}*/gu, 'souvenir'],
];
export function normSkin(s) {
  let t = norm(s);
  for (const [re, en] of RU_SKIN) t = t.replace(re, en);
  return t;
}

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
/**
 * Номера частей серии в названии: «Dying Light 2», «Far Cry VI», «Часть 3».
 * Годы (1990–2099), числа, приклеенные к буквам (PS5, 4K), и количества («2 месяца», «1000 V-Bucks») не считаются.
 */
export function seriesNumbers(title) {
  const t = norm(title);
  const words = t.split(' ');
  const out = new Set();
  const unit = /^(мес|month|дн|day|год|year|лет|шт|pcs|v|vb|bucks|gold|голд|монет|coins|gems|uc|robux|gb|гб|tb|hours|час|minutes|мин|lvl|уровн|level|x|х)/;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1] ?? '';
    let n = null;
    if (/^\d{1,2}$/.test(w)) n = Number(w);
    else if (ROMAN[w] && i > 0) n = ROMAN[w];
    if (n === null || n === 0) continue;
    if (unit.test(next)) continue;
    out.add(n);
  }
  return [...out];
}

/**
 * Скин в описании лота FunPay: точное английское market_hash_name.
 * StatTrak/Souvenir/★ должны совпадать: «AK-47 | Redline» не равен «StatTrak AK-47 | Redline».
 */
export function skinInText(marketName, text) {
  const n = normSkin(marketName);
  const t = normSkin(text);
  if (!t.includes(n)) return false;
  const st = n.includes('stattrak');
  const sv = n.includes('souvenir');
  if (!st && /stattrak/.test(t)) return false;
  if (!sv && /souvenir|сувенир/.test(t)) return false;
  return true;
}

export const isWearName = (n) => WEAR.some((w) => norm(n).includes(w));
