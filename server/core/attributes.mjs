// Атрибуты товара и сопоставление: VERIFIED / REVIEW_REQUIRED / REJECTED с причинами.
// Правило: несовпадение обязательного атрибута → REJECTED; атрибут неизвестен → REVIEW_REQUIRED.
// Рекомендацию получает только VERIFIED (правилами или вручную).
import { norm, seriesNumbers } from '../lib/match.mjs';

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
  ['ps', W('ps4|ps5|playstation|psn|пс4|пс5|плейстейшн|плойк\\p{L}*|sony')],
  ['xbox', W('xbox|xbox one|series x|series s|иксбокс')],
  ['switch', W('switch|nintendo|свитч|нинтендо')],
  ['mobile', W('android|ios|iphone|мобильн')],
  ['pc', W('pc|пк|steam|стим|epic games|egs|gog|ubisoft connect|uplay|ea app|origin|battle net|microsoft store|windows')],
];

const REGION_RE = [
  ['ru', W('рф|росси\\p{L}{0,3}|russia|ru|rus|российск\\p{L}*')], // «рус/русский» — язык, а не регион
  ['cis', W('снг|cis')],
  ['global', W('global|глобал\\p{L}*|worldwide|весь мир|row|region free|без региона')],
  ['eu', W('eu|europe|европ\\p{L}{0,2}|европейск\\p{L}*')],
  ['us', W('us|usa|сша|na|north america')],
  ['tr', W('tr|турц\\p{L}{0,2}|турецк\\p{L}*|turkey|türkiye|turkish')],
  ['kz', W('kz|казахстан\\p{L}{0,2}|казахстанск\\p{L}*|kazakhstan|kzt')],
  ['ua', W('ua|украин\\p{L}{0,2}|украинск\\p{L}*|ukraine|uah')],
  ['ar', W('ar|аргентин\\p{L}{0,2}|argentina|ars')],
  ['in', W('india|инди\\p{L}|indian')],
  ['cn', W('cn|кита\\p{L}{1,2}|china|chinese')],
  ['by', W('рб|беларусь|belarus')],
];

const TYPE_RE = [
  ['rent', W('аренд\\p{L}{0,2}|rent|rental|прокат')],
  ['offline', W('offline|оффлайн|офлайн|офф лайн')],
  ['account', W('аккаунт\\p{L}{0,2}|акк|account|steam guard|общий|shared|с заходом на аккаунт|логин|login')],
  ['topup', W('пополнение|top up|topup|wallet')],
  ['gift', W('гифт\\p{L}{0,2}|gift|подар\\p{L}{0,4}')],
  ['key', W('ключ\\p{L}{0,2}|key|cd key|cdkey|код активации|activation code|redeem code')],
];

const EDITION_RE = [
  ['ultimate', W('ultimate|ультимейт')],
  ['deluxe', W('deluxe|делюкс|digital deluxe|расширенн\\p{L}* издани\\p{L}*')],
  ['gold', W('gold edition|голд|золот\\p{L}* издани\\p{L}*')],
  ['premium', W('premium')],
  ['complete', W('complete edition|complete|комплит|полн\\p{L}* издани\\p{L}*')],
  ['goty', W('goty|game of the year|издание игра года|игра года')],
  ['collector', W('collector|коллекционн')],
  ['definitive', W('definitive')],
  ['legendary', W('legendary')],
  ['standard', W('standard|стандарт\\p{L}*')],
];

/** признаки «это не сама игра»: DLC, наборы, бандлы */
const ADDON_RE = W('dlc|дополнени\\p{L}|season pass|сезонный пропуск|pack|набор|bundle|бандл|soundtrack|саундтрек|artbook|upgrade|апгрейд|expansion|addon|add on');
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

/** Ограничения активации ключа: [регэксп, описание, мешает ли активации в РФ/СНГ] */
const RESTRICTION_RE = [
  [W('нужен vpn|требуется vpn|vpn обязателен|через vpn|с vpn'), 'нужен VPN', true],
  [/не (?:активируется|работает|подходит)[^.]{0,20}(?:рф|росси|снг)/u, 'не активируется в РФ/СНГ', true],
  [/(?:рф|росси|снг)[^.]{0,15}не (?:активируется|работает|поддерживается)/u, 'не активируется в РФ/СНГ', true],
  [W('region locked|регион лок|региональная блокировка'), 'региональная блокировка', false],
  [W('смена региона|сменить регион|смены региона'), 'требует смены региона аккаунта', true],
];

/** float скина из текста лота: «Float: 0.153», «флоат 0,07» */
export function parseFloatValue(text) {
  const m = String(text ?? '').match(/(?:float|флоат|флот)\s*[:=-]?\s*(0[.,]\d{2,})/i);
  return m ? Number(m[1].replace(',', '.')) : null;
}

/** paint seed / паттерн: «Pattern: 661», «paint seed 387», «паттерн 151», «seed: 55» */
export function parsePaintSeed(text) {
  const m = String(text ?? '').match(/(?:paint\s*seed|pattern(?:\s*(?:id|template|index))?|seed|паттерн|сид)\s*[:#№=-]?\s*(\d{1,4})(?!\d|[.,]\d)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 1000 ? n : null;
}

/**
 * Наклейки: «Stickers: iBUYPOWER (Holo) | Katowice 2014, Titan», «Наклейки: …».
 * Возвращает null, если о наклейках ничего не сказано; [] — «без наклеек».
 */
export function parseStickers(text) {
  const s = String(text ?? '');
  if (/(?:без наклеек|no stickers|stickers?\s*:\s*(?:нет|none|no)\b)/i.test(s)) return [];
  const m = s.match(/(?:stickers?|наклейк\p{L}*)\s*[:-]\s*([^\n;]{2,300})/iu);
  if (!m) return null;
  return m[1]
    .split(/[,;]/)
    .map((x) => norm(x).replace(/^sticker\s+/, ''))
    .filter((x) => x.length > 1)
    .slice(0, 6);
}

/** Срок подписки/аренды в днях: «1 месяц», «12 months», «3 мес», «1 год», «30 дней» */
export function parseDurationDays(text) {
  const t = norm(text);
  const m = t.match(/(\d{1,3})\s*(мес\p{L}*|month\p{L}*|mo|m|дн\p{L}*|day\p{L}*|d|год\p{L}*|лет|year\p{L}*|y|недел\p{L}*|week\p{L}*|w)(?![\p{L}\p{N}])/u);
  if (!m) {
    if (/(?:^|\s)(?:месяц|month|monthly)(?:$|\s)/u.test(t)) return 30;
    if (/(?:^|\s)(?:год|year|yearly|annual|годовая)(?:$|\s)/u.test(t)) return 365;
    return null;
  }
  const n = Number(m[1]);
  const u = m[2];
  if (/^(мес|month|mo$|m$)/.test(u)) return n * 30;
  if (/^(год|лет|year|y$)/.test(u)) return n * 365;
  if (/^(недел|week|w$)/.test(u)) return n * 7;
  return n;
}

/**
 * Схемы атрибутов по категориям: что определяет «тот же товар».
 * required — без этого атрибута в карточке пара проверяется только по названию (подсказка в интерфейсе);
 * fromText — что парсер умеет достать из текста лота.
 */
export const CATEGORY_SCHEMAS = {
  keys: { required: ['type', 'platform', 'regions'], optional: ['edition'], note: 'тип (ключ/подарок), платформа и регион активации; издание — если цена зависит' },
  subscriptions: { required: ['durationDays', 'regions'], optional: ['type'], note: 'срок подписки и регион; аккаунт или код — тип' },
  currency: { required: ['server'], optional: [], note: 'сервер/регион игры' },
  skins: { required: [], optional: ['phase', 'floatMin', 'floatMax', 'paintSeeds', 'stickers'], note: 'точное название, фаза, float, paint seed и наклейки — если влияют на цену' },
  accounts: { required: ['platform', 'regions'], optional: [], note: 'платформа и регион аккаунта' },
  items: { required: ['server'], optional: [], note: 'сервер игры' },
  services: { required: [], optional: [], note: 'проверка по названию' },
};

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
  out.restrictions = RESTRICTION_RE.filter(([re]) => re.test(t)).map(([, text, blocksRu]) => ({ text, blocksRu }));
  out.float = parseFloatValue(text);
  out.paintSeed = parsePaintSeed(text);
  out.stickers = parseStickers(text);
  out.durationDays = parseDurationDays(text);
  out.series = seriesNumbers(text);
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
    // float: у лотов FunPay он бывает указан в описании; у площадок-источников в выгрузках его нет
    const fl = ctx.float ?? null;
    const hasRange = req.floatMin !== undefined && req.floatMin !== null && req.floatMax !== undefined && req.floatMax !== null && req.floatMax > 0;
    if (hasRange) {
      if (fl === null) review(`float не указан (нужен ${req.floatMin}–${req.floatMax})`);
      else if (fl < req.floatMin || fl > req.floatMax) reject(`float ${fl}, нужен ${req.floatMin}–${req.floatMax}`);
      else pass(`float ${fl}`);
    } else if (req.requireFloat && fl === null) review('float/paint seed источником не передаются — проверьте вручную');
    // paint seed: список допустимых паттернов (blue gem, fire & ice и т.п.)
    const seed = ctx.paintSeed ?? offerAttrs.paintSeed ?? null;
    const seeds = req.paintSeeds ?? [];
    if (seeds.length) {
      if (seed === null) review(`paint seed не указан (нужен ${seeds.join(', ')})`);
      else if (seeds.includes(seed)) pass(`paint seed ${seed}`);
      else reject(`paint seed ${seed}, нужен ${seeds.join(', ')}`);
    }
    // наклейки: все требуемые должны быть у предмета; «без наклеек» — пустой список
    const st = ctx.stickers ?? offerAttrs.stickers ?? null;
    const need = (req.stickers ?? []).map(norm).filter(Boolean);
    if (need.length) {
      if (st === null) review(`наклейки не указаны (нужны: ${need.join(', ')})`);
      else {
        const missing = need.filter((n) => !st.some((x) => x.includes(n)));
        if (missing.length) reject(`нет наклеек: ${missing.join(', ')}`);
        else pass(`наклейки: ${need.join(', ')}`);
      }
    }
    // строгая идентификация: float, паттерн и наклейки влияют на цену любого скина.
    // Если источник передал все три — подтверждать вручную не нужно.
    if (ctx.side !== 'funpay' && ctx.skinsStrict !== 'pattern' && status === 'VERIFIED') {
      if (fl !== null && seed !== null && st !== null) pass('float, paint seed и наклейки переданы источником');
      else review('float, paint seed, паттерн и наклейки источник не передаёт — подтвердите предмет вручную (строгий режим)');
    }
    return { status, source: 'rules', reasons };
  }

  // ── ограничения активации (ключ «не для РФ», «нужен VPN»)
  const restr = offerAttrs.restrictions ?? [];
  if (restr.length) {
    const needsRuCis = (req.regions ?? []).some((r) => ['ru', 'cis', 'by', 'kz'].includes(r));
    if (needsRuCis && restr.some((x) => x.blocksRu)) reject(`ограничение активации: ${restr.map((x) => x.text).join(', ')}`);
    else review(`есть ограничения активации: ${restr.map((x) => x.text).join(', ')}`);
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

  // ── номер части серии: «Dying Light» ≠ «Dying Light 2»
  if ((cat === 'keys' || cat === 'accounts') && ctx.watchName && offerAttrs.series) {
    const want = seriesNumbers(ctx.watchName);
    const got = offerAttrs.series;
    const extra = got.filter((n) => !want.includes(n));
    if (want.length && want.every((n) => got.includes(n))) pass(`часть ${want.join(', ')}`);
    else if (want.length && extra.length) reject(`другая часть серии: ${extra.join(', ')} вместо ${want.join(', ')}`);
    else if (want.length && ctx.side !== 'funpay') review(`номер части (${want.join(', ')}) не указан в названии`);
    else if (extra.length && ctx.side !== 'funpay') review(`в названии номер ${extra.join(', ')} — возможно, другая часть серии`);
  }

  // ── срок подписки
  if (req.durationDays) {
    const d = offerAttrs.durationDays ?? null;
    const label = (x) => (x % 365 === 0 ? `${x / 365} г.` : x % 30 === 0 ? `${x / 30} мес.` : `${x} дн.`);
    if (d === null) review(`срок не указан (нужен ${label(req.durationDays)})`);
    else if (Math.abs(d - req.durationDays) <= Math.max(1, req.durationDays * 0.04)) pass(`срок ${label(d)}`);
    else reject(`срок ${label(d)}, нужен ${label(req.durationDays)}`);
  }

  if (cat === 'currency' && req.server) {
    const t = norm(ctx.title ?? '');
    if (t.includes(norm(req.server))) pass(`сервер ${req.server}`);
    else review(`сервер не указан (нужен ${req.server})`);
  }

  if (!reasons.length) review('обязательные атрибуты не заданы в карточке — проверка только по названию');
  return { status, source: 'rules', reasons, schemaGaps: schemaGaps(cat, req) };
}

/** какие атрибуты схемы категории не заданы в карточке */
export function schemaGaps(category, req = {}) {
  const s = CATEGORY_SCHEMAS[category];
  if (!s) return [];
  return s.required.filter((k) => {
    const v = req[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  });
}

export const isPatternSensitive = (name) => PATTERN_SENSITIVE.test(name ?? '');
