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

/**
 * Скин в описании лота FunPay: точное английское market_hash_name.
 * StatTrak/Souvenir/★ должны совпадать: «AK-47 | Redline» не равен «StatTrak AK-47 | Redline».
 */
export function skinInText(marketName, text) {
  const n = norm(marketName);
  const t = norm(text);
  if (!t.includes(n)) return false;
  const st = n.includes('stattrak');
  const sv = n.includes('souvenir');
  if (!st && /stattrak/.test(t)) return false;
  if (!sv && /souvenir|сувенир/.test(t)) return false;
  return true;
}

export const isWearName = (n) => WEAR.some((w) => norm(n).includes(w));
