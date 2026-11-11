// Сопоставление RU/EN, номер части серии, срок подписки, CS2: paint seed и наклейки, схемы категорий.
import { describe, expect, it } from 'vitest';
import { CATEGORY_SCHEMAS, extractAttrs, matchOffer, parseDurationDays, parsePaintSeed, parseStickers, schemaGaps } from '../core/attributes.mjs';
import { normSkin, seriesNumbers, skinInText } from '../lib/match.mjs';

const m = (title, req, ctx = {}) => matchOffer(extractAttrs(title), req, { category: 'keys', side: 'source', title, ...ctx });

describe('RU/EN словоформы', () => {
  it.each([
    ['Ключ Steam для России', { types: ['key'], platforms: ['pc'], regions: ['ru'] }],
    ['Ключи для Турции (TR)', { types: ['key'], regions: ['tr'] }],
    ['Подарком на аккаунт, Казахстан', { types: ['gift'], regions: ['kz'] }],
    ['Steam gift Turkey', { types: ['gift'], regions: ['tr'] }],
    ['Плейстейшн 5, европейский регион', { platforms: ['ps'], regions: ['eu'] }],
    ['Нинтендо Switch', { platforms: ['switch'] }],
    ['Аренда аккаунта', { types: ['rent', 'account'] }],
    ['Region free key', { types: ['key'], regions: ['global'] }],
  ])('%s', (title, want) => {
    const a = extractAttrs(title);
    for (const [k, v] of Object.entries(want)) for (const x of v) expect(a[k]).toContain(x);
  });

  it('издания на русском', () => {
    expect(extractAttrs('Расширенное издание').editions).toContain('deluxe');
    expect(extractAttrs('Полное издание').editions).toContain('complete');
    expect(extractAttrs('Золотое издание').editions).toContain('gold');
    expect(extractAttrs('Издание «Игра года»').editions).toContain('goty');
    expect(extractAttrs('Дополнения к игре').addon).toBe(true);
  });

  it('русский язык ≠ регион РФ', () => {
    expect(extractAttrs('Русская озвучка').regions).toEqual([]);
  });
});

describe('номер части серии', () => {
  it('извлечение номеров: годы, PS5, количества не считаются', () => {
    expect(seriesNumbers('Dying Light 2 Stay Human')).toEqual([2]);
    expect(seriesNumbers('Far Cry VI')).toEqual([6]);
    expect(seriesNumbers('Cyberpunk 2077')).toEqual([]);
    expect(seriesNumbers('Game PS5 4K')).toEqual([]);
    expect(seriesNumbers('Xbox Game Pass 3 месяца')).toEqual([]);
    expect(seriesNumbers('1000 V-Bucks')).toEqual([]);
    expect(seriesNumbers('Diablo IV')).toEqual([4]);
  });

  it('«Dying Light» ≠ «Dying Light 2»', () => {
    expect(m('Dying Light 2 Steam key', { type: 'key' }, { watchName: 'Dying Light' }).status).toBe('REVIEW_REQUIRED');
    expect(m('Dying Light Steam key', { type: 'key' }, { watchName: 'Dying Light 2' }).status).toBe('REVIEW_REQUIRED');
    expect(m('Dying Light 1 Steam key', { type: 'key' }, { watchName: 'Dying Light 2' }).status).toBe('REJECTED');
    expect(m('Dying Light 2 Stay Human Steam key', { type: 'key' }, { watchName: 'Dying Light 2' }).status).toBe('VERIFIED');
  });

  it('лоты FunPay без номера не уходят на проверку (не обедняем цены конкурентов)', () => {
    const r = m('Dying Light ключ', { type: 'key' }, { watchName: 'Dying Light 2', side: 'funpay' });
    expect(r.status).toBe('VERIFIED');
  });
});

describe('срок подписки', () => {
  it.each([
    ['Game Pass Ultimate 1 месяц', 30],
    ['PS Plus 12 months', 360],
    ['Подписка на 3 мес', 90],
    ['Spotify Premium 1 год', 365],
    ['Nitro 30 дней', 30],
    ['monthly subscription', 30],
    ['Без срока', null],
  ])('%s → %s', (t, d) => expect(parseDurationDays(t)).toBe(d));

  it('несовпадение срока — блок; 12 месяцев ≈ 1 год', () => {
    const ctx = { category: 'subscriptions' };
    expect(m('Game Pass 1 месяц', { durationDays: 90 }, ctx).status).toBe('REJECTED');
    expect(m('Game Pass 3 месяца', { durationDays: 90 }, ctx).status).toBe('VERIFIED');
    expect(m('PS Plus 12 месяцев', { durationDays: 365 }, ctx).status).toBe('VERIFIED');
    expect(m('PS Plus', { durationDays: 365 }, ctx).status).toBe('REVIEW_REQUIRED');
  });
});

describe('CS2: износ на русском, paint seed, наклейки', () => {
  it('русские названия износа', () => {
    expect(normSkin('AK-47 | Redline (После полевых испытаний)')).toBe(normSkin('AK-47 | Redline (Field-Tested)'));
    expect(skinInText('AK-47 | Redline (Field-Tested)', 'Продаю AK-47 | Redline (После полевых испытаний), float 0.2')).toBe(true);
    expect(skinInText('AK-47 | Redline (Field-Tested)', 'StatTrak™ AK-47 | Redline (После полевых испытаний)')).toBe(false);
  });

  it('парсинг paint seed и наклеек', () => {
    expect(parsePaintSeed('Pattern: 661, float 0.12')).toBe(661);
    expect(parsePaintSeed('паттерн 151')).toBe(151);
    expect(parsePaintSeed('paint seed #387')).toBe(387);
    expect(parsePaintSeed('float 0.661')).toBe(null);
    expect(parseStickers('Stickers: iBUYPOWER (Holo) Katowice 2014, Titan Katowice 2014')).toEqual(['ibuypower (holo) katowice 2014', 'titan katowice 2014']);
    expect(parseStickers('без наклеек')).toEqual([]);
    expect(parseStickers('AK-47 Redline')).toBe(null);
  });

  const skin = (title, req, extra = {}) => matchOffer(extractAttrs(title), req, { category: 'skins', side: 'source', title, nameExact: true, ...extra });

  it('paint seed из списка — совпадение; другой — блок; не указан — проверка', () => {
    expect(skin('AK-47 | Case Hardened', { paintSeeds: [661], phase: '' }, { skinsStrict: 'pattern', paintSeed: 661 }).reasons.some((r) => r.ok && /661/.test(r.text))).toBe(true);
    expect(skin('AK-47 | Case Hardened', { paintSeeds: [661] }, { skinsStrict: 'pattern', paintSeed: 12 }).status).toBe('REJECTED');
    expect(skin('AK-47 | Case Hardened', { paintSeeds: [661] }, { skinsStrict: 'pattern' }).status).toBe('REVIEW_REQUIRED');
  });

  it('наклейки: все нужные есть — ок; нет — блок', () => {
    const req = { stickers: ['Titan Katowice 2014'] };
    expect(skin('AWP | Asiimov', req, { skinsStrict: 'pattern', stickers: ['titan (holo) katowice 2014'] }).status).toBe('REJECTED'); // нужна именно «titan katowice 2014»
    expect(skin('AWP | Asiimov', req, { skinsStrict: 'pattern', stickers: ['titan katowice 2014', 'navi'] }).status).toBe('VERIFIED');
    expect(skin('AWP | Asiimov', req, { skinsStrict: 'pattern', stickers: [] }).status).toBe('REJECTED');
  });

  it('строгий режим снимается, если источник передал float, paint seed и наклейки', () => {
    expect(skin('AWP | Asiimov', {}, { skinsStrict: 'all' }).status).toBe('REVIEW_REQUIRED');
    expect(skin('AWP | Asiimov', {}, { skinsStrict: 'all', float: 0.2, paintSeed: 5, stickers: [] }).status).toBe('VERIFIED');
  });
});

describe('схемы категорий', () => {
  it('у каждой категории есть схема; пробелы карточки видны', () => {
    for (const c of ['keys', 'subscriptions', 'currency', 'skins', 'accounts', 'items', 'services']) expect(CATEGORY_SCHEMAS[c]).toBeTruthy();
    expect(schemaGaps('keys', { type: 'key' })).toEqual(['platform', 'regions']);
    expect(schemaGaps('keys', { type: 'key', platform: 'pc', regions: ['ru'] })).toEqual([]);
    expect(m('Game key', {}).schemaGaps).toEqual(['type', 'platform', 'regions']);
  });
});
