// Атрибуты товара и сопоставление: VERIFIED / REVIEW_REQUIRED / REJECTED с причинами.
// Правило: несовпадение обязательного атрибута → REJECTED; атрибут неизвестен → REVIEW_REQUIRED.
// Рекомендацию получает только VERIFIED (правилами или вручную).
import { norm } from '../lib/match.mjs';

export const PLATFORMS = ['pc', 'ps', 'xbox', 'switch', 'mobile'];
export const REGIONS = ['ru', 'cis', 'global', 'eu', 'us', 'tr', 'kz', 'ua', 'ar', 'in', 'cn', 'by'];
export const TYPES = ['key', 'gift', 'account', 'rent', 'topup', 'offline', 'item', 'currency', 'service'];
export const EDITIONS = ['standard', 'deluxe', 'ultimate', 'gold', 'premium', 'complete', 'goty', 'collector', 'definitive', 'legendary'];

export const LABELS = {
  platform: { pc: 'PC', ps: 'PlayStation', xbox: 'Xbox', switch: 'Switch', mobile: 'Mobile' },
  region: { ru: 'РФ', cis: 'СНГ', global: 'Global', eu: 'Европа', us: 'США', tr: 'Турция', kz: 'Казахстан', ua: 'Украина', ar: 'Аргентина', in: 'Индия', cn: 'Китай', by: 'Беларусь' },
  type: { key: 'ключ', gift: 'подарок', account: 'аккаунт', rent: 'аренда', topup: 'пополнение', offline: 'оффлайн-активация', item: 'предмет', currency: 'валюта', service: 'услуга' },
};

const has = (t, re) => re.test(t);
const W = (s) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${s})(?:$|[^\\p{L}\\p{N}])`, 'u');

const PLATFORM_RE = [
  ['ps', W('ps4|ps5|playstation|psn|пс4|пс5')],
  ['xbox', W('xbox|xbox one|series x|series s|иксбокс')],
  ['switch', W('switch|nintendo|свитч')],
  ['mobile', W('android|ios|iphone|мобильн')],
  ['pc', W('pc|пк|steam|стим|epic games|egs|gog|ubisoft connect|uplay|ea app|origin|battle net|microsoft store|windows')],
];

const REGION_RE = [
  ['ru', W('рф|россия|russia|ru|rus')], // «рус/русский» — язык, а не регион
  ['cis', W('снг|cis')],
  ['global', W('global|глобал|worldwide|весь мир|row')],
  ['eu', W('eu|europe|европа')],
  ['us', W('us|usa|сша|na|north america')],
  ['tr', W('tr|турция|turkey|türkiye')],
  ['kz', W('kz|казахстан|kazakhstan|kzt')],
  ['ua', W('ua|украина|ukraine|uah')],
  ['ar', W('ar|аргентина|argentina')],
  ['in', W('india|индия')],
  ['cn', W('cn|китай|china')],
  ['by', W('рб|беларусь|belarus')],
];

const TYPE_RE = [
  ['rent', W('аренда|аренду|rent|прокат')],
  ['offline', W('offline|оффлайн|офлайн|офф лайн')],
  ['account', W('аккаунт|акк|account|steam guard|общий|shared|с заходом на аккаунт|логин|login')],
  ['topup', W('пополнение|top up|topup|wallet')],
  ['gift', W('гифт|gift|подарок|подарком')],
  ['key', W('ключ|key|cd key|cdkey|код активации|activation code')],
];

const EDITION_RE = [
  ['ultimate', W('ultimate|ультимейт')],
  ['deluxe', W('deluxe|делюкс|digital deluxe')],
  ['gold', W('gold edition|голд')],
  ['premium', W('premium')],
  ['complete', W('complete edition|complete|комплит')],
  ['goty', W('goty|game of the year')],
  ['collector', W('collector|коллекционн')],
  ['definitive', W('definitive')],
  ['legendary', W('legendary')],
  ['standard', W('standard|стандарт')],
];

/** признаки «это не сама игра»: DLC, наборы, бандлы */
const ADDON_RE = W('dlc|дополнение|season pass|сезонный пропуск|pack|набор|bundle|бандл|soundtrack|саундтрек|artbook|upgrade|апгрейд');
const COMBO_RE = /\+\s*([\p{L}\p{N}][\p{L}\p{N}'’]*)/gu; // «Игра A + Игра B»

/** «A + B» — набор; но «РФ+СНГ», «PC + Xbox», «+ бонус» — нет */
function isCombo(raw) {
  for (const m of raw.matchAll(COMBO_RE)) {
    const word = norm(m[1]);
    const benign = [...REGION_RE, ...PLATFORM_RE].some(([, re]) => re.test(word)) || /^(бонус|bonus|подарок|гарантия|dlc|автовыдача)/.test(word);
    if (!benign) return true;
  }
  return false;
}

/** Предметы, цена которых зависит от фазы/паттерна/float — по одному названию не сопоставить */
const PATTERN_SENSITIVE = /doppler|case hardened|fade|marble fade|crimson web|slaughter|heat treated|blue gem|ruby|sapphire|emerald|black pearl/i;

/** Извлечь атрибуты из текста. Возвращает только то, что удалось распознать. */
export function extractAttrs(text) {
  const t = norm(text);
  const out = { platforms: [], regions: [], types: [], editions: [], addon: false, combo: false };
  for (const [k, re] of PLATFORM_RE) if (has(t, re)) out.platforms.push(k);
  for (const [k, re] of REGION_RE) if (has(t, re)) out.regions.push(k);
  for (const [k, re] of TYPE_RE) if (has(t, re)) out.types.push(k);
  for (const [k, re] of EDITION_RE) if (has(t, re)) out.editions.push(k);
  out.addon = has(t, ADDON_RE);
  out.combo = isCombo(String(text ?? ''));
  return out;
}

/** Атрибуты лота FunPay из его собственных фильтров (структурированные) + текст описания */
const FP_TYPE = { 'цифровой ключ': 'key', ключ: 'key', подарком: 'gift', подарок: 'gift', 'с заходом на аккаунт': 'account', аккаунт: 'account', пополнение: 'topup', 'оффлайн активация': 'offline' };
const FP_PLATFORM_SERVER = { 7027: 'pc', 7028: 'ps', 7029: 'xbox' };

export function funpayAttrs(offer) {
  const a = extractAttrs([offer.desc, offer.server, offer.side].join(' '));
  const f = offer.filters ?? {};
  // структурированные фильтры FunPay надёжнее текста продавца — перекрывают его
  for (const [k, v] of Object.entries(f)) {
    if (FP_TYPE[v]) a.types = [FP_TYPE[v]];
    if (/region/.test(k)) {
      const r = extractAttrs(v).regions;
      if (r.length) a.regions = r;
    }
  }
  if (f.server && FP_PLATFORM_SERVER[f.server]) a.platforms = [FP_PLATFORM_SERVER[f.server]];
  return a;
}

/** «РФ+СНГ» покрывает ru и cis; «Global» покрывает всё */
function regionOk(offerRegions, accepted) {
  if (!accepted.length) return { ok: true };
  if (!offerRegions.length) return { ok: null };
  if (offerRegions.includes('global')) return { ok: true };
  return accepted.some((r) => offerRegions.includes(r)) ? { ok: true } : { ok: false };
}

/**
 * Сопоставить предложение с карточкой.
 * @param offerAttrs  результат extractAttrs/funpayAttrs (+ known: атрибуты, заданные источником явно)
 * @param req         watch.attrs
 * @param ctx         { category, side, title, decision }
 */
export function matchOffer(offerAttrs, req = {}, ctx = {}) {
  const reasons = [];
  let status = 'VERIFIED';
  const reject = (r) => {
    reasons.push({ ok: false, text: r });
    status = 'REJECTED';
  };
  const review = (r) => {
    reasons.push({ ok: null, text: r });
    if (status !== 'REJECTED') status = 'REVIEW_REQUIRED';
  };
  const pass = (r) => reasons.push({ ok: true, text: r });

  if (ctx.decision) {
    return {
      status: ctx.decision.status,
      source: 'manual',
      reasons: [{ ok: ctx.decision.status === 'VERIFIED', text: `решение вручную${ctx.decision.reason ? `: ${ctx.decision.reason}` : ''}` }],
    };
  }

  const cat = ctx.category;
  if (cat === 'skins') {
    if (ctx.nameExact) pass('название совпадает точно (market_hash_name)');
    else reject('название не совпадает точно');
    const name = ctx.title ?? '';
    if (PATTERN_SENSITIVE.test(name)) {
      if (req.phase) {
        if (ctx.phase && norm(ctx.phase) === norm(req.phase)) pass(`фаза ${ctx.phase}`);
        else if (ctx.phase) reject(`фаза ${ctx.phase}, нужна ${req.phase}`);
        else review(`фаза/паттерн не указаны у источника (нужна ${req.phase})`);
      } else review('цена зависит от фазы/паттерна/float — подтвердите предмет вручную');
    }
    if (req.requireFloat) review('float/paint seed источником не передаются — проверьте вручную');
    return { status, source: 'rules', reasons };
  }

  // ── тип товара
  const types = offerAttrs.types ?? [];
  if (req.type) {
    const bad = types.filter((t) => t !== req.type && ['rent', 'account', 'offline', 'topup'].includes(t));
    if (bad.length) reject(`тип «${bad.map((t) => LABELS.type[t]).join(', ')}», нужен «${LABELS.type[req.type]}»`);
    else if (types.includes(req.type)) pass(`тип «${LABELS.type[req.type]}»`);
    else if (offerAttrs.knownType && offerAttrs.knownType !== req.type && !types.length)
      reject(`источник продаёт «${LABELS.type[offerAttrs.knownType]}», нужен «${LABELS.type[req.type]}»`);
    else if (types.length && !types.includes(req.type)) reject(`тип «${types.map((t) => LABELS.type[t]).join(', ')}», нужен «${LABELS.type[req.type]}»`);
    else if (offerAttrs.knownType === req.type) pass(`тип «${LABELS.type[req.type]}» (по источнику)`);
    else review(`тип товара не указан (нужен «${LABELS.type[req.type]}»)`);
  } else if (cat === 'keys' && types.some((t) => ['rent', 'account', 'offline'].includes(t))) {
    reject(`похоже на «${types.map((t) => LABELS.type[t]).join(', ')}», а не на ключ/подарок`);
  }

  // ── платформа
  const platforms = offerAttrs.knownPlatform ? [offerAttrs.knownPlatform] : (offerAttrs.platforms ?? []);
  if (req.platform) {
    if (!platforms.length) review(`платформа не указана (нужна ${LABELS.platform[req.platform]})`);
    else if (platforms.includes(req.platform)) pass(`платформа ${LABELS.platform[req.platform]}`);
    else reject(`платформа ${platforms.map((p) => LABELS.platform[p]).join('/')}, нужна ${LABELS.platform[req.platform]}`);
  }

  // ── регион
  const regions = offerAttrs.knownRegion ? [offerAttrs.knownRegion] : (offerAttrs.regions ?? []);
  const accepted = req.regions ?? [];
  if (accepted.length) {
    const r = regionOk(regions, accepted);
    if (r.ok === null) review(`регион не указан (нужен ${accepted.map((x) => LABELS.region[x]).join('/')})`);
    else if (r.ok) pass(`регион ${regions.map((x) => LABELS.region[x]).join('+')}`);
    else reject(`регион ${regions.map((x) => LABELS.region[x]).join('+')}, нужен ${accepted.map((x) => LABELS.region[x]).join('/')}`);
  }

  // ── издание и «не сама игра»
  const eds = offerAttrs.editions ?? [];
  if (cat === 'keys' || cat === 'subscriptions') {
    if (offerAttrs.addon) reject('похоже на DLC/набор/бандл, а не на основную игру');
    if (offerAttrs.combo && ctx.side === 'source') reject('несколько товаров в одном предложении («A + B»)');
  }
  if (req.edition) {
    const other = eds.filter((e) => e !== req.edition && e !== 'standard');
    if (req.edition === 'standard') {
      if (other.length) reject(`издание ${other.join('/')}, нужно standard`);
      else pass('издание standard (или не указано — считается стандартным)');
    } else if (eds.includes(req.edition)) pass(`издание ${req.edition}`);
    else if (other.length) reject(`издание ${other.join('/')}, нужно ${req.edition}`);
    else review(`издание не указано (нужно ${req.edition})`);
  }

  if (cat === 'currency' && req.server) {
    const t = norm(ctx.title ?? '');
    if (t.includes(norm(req.server))) pass(`сервер ${req.server}`);
    else review(`сервер не указан (нужен ${req.server})`);
  }

  if (!reasons.length) review('обязательные атрибуты не заданы в карточке — проверка только по названию');
  return { status, source: 'rules', reasons };
}

export const isPatternSensitive = (name) => PATTERN_SENSITIVE.test(name ?? '');
