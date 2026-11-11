// Интеграционные тесты адаптеров на фикстурах: сеть не используется, fetch подменяется.
// Проверяется: нормальный ответ, пустой ответ, изменение формата, лимит 429, Cloudflare, классификация ошибок.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS, feedIndex } from '../sources/adapters.mjs';
import { clearCache, SourceError } from '../lib/http.mjs';
import { getOffers, normalizeCategoryUrl } from '../lib/funpay.mjs';
import { assessOffers } from '../repo/quality.mjs';
import { closeDb, openDb } from '../db/db.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** routes: [[RegExp, status, body, headers?]] */
function mockFetch(routes) {
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    calls.push(String(url));
    const r = routes.find(([re]) => re.test(String(url)));
    if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const [, status, body, headers = {}] = r;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  });
  return calls;
}

beforeEach(() => {
  clearCache();
  closeDb();
  openDb(':memory:');
});
afterEach(() => vi.unstubAllGlobals());

describe('Steam Store', () => {
  it('нормальный ответ: цена в копейках → рубли, ссылка на приложение', async () => {
    mockFetch([[/storesearch/, 200, { total: 1, items: [{ type: 'app', name: 'ELDEN RING', id: 1245620, price: { currency: 'RUB', initial: 359900, final: 359900 } }] }]]);
    const r = await ADAPTERS.steam({ query: 'Elden Ring' });
    expect(r).toEqual([{ sourceId: 'steam', title: 'ELDEN RING', price: 3599, currency: 'RUB', url: 'https://store.steampowered.com/app/1245620/' }]);
  });
  it('пустой ответ и бесплатные игры без цены', async () => {
    mockFetch([[/storesearch/, 200, { total: 0, items: [{ type: 'app', name: 'Free', id: 1 }] }]]);
    expect(await ADAPTERS.steam({ query: 'x' })).toEqual([]);
  });
  it('смена формата (HTML вместо JSON) → ошибка класса format', async () => {
    mockFetch([[/storesearch/, 200, '<html>maintenance</html>']]);
    await expect(ADAPTERS.steam({ query: 'x' })).rejects.toMatchObject({ code: 'format' });
  });
  it('лимит 429 → ratelimit; Cloudflare → blocked; 503 → server', async () => {
    mockFetch([[/storesearch/, 429, 'slow down', { 'retry-after': '1' }]]);
    await expect(ADAPTERS.steam({ query: 'a' })).rejects.toMatchObject({ code: 'ratelimit' });
    clearCache();
    mockFetch([[/storesearch/, 403, '<title>Just a moment...</title><div id="cf-chl">']]);
    await expect(ADAPTERS.steam({ query: 'b' })).rejects.toMatchObject({ code: 'blocked' });
    clearCache();
    mockFetch([[/storesearch/, 503, 'down']]);
    await expect(ADAPTERS.steam({ query: 'c' })).rejects.toMatchObject({ code: 'server' });
  });
  it('нет сети → network', async () => {
    mockFetch([]);
    const e = await ADAPTERS.steam({ query: 'z' }).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.code).toBe('network');
  });
});

describe('Plati, GOG, GabeStore, CheapShark', () => {
  it('Plati: price_rur, позиции с нулевой ценой отброшены', async () => {
    mockFetch([[/plati\.io/, 200, { items: [{ name: 'Elden Ring ключ', price_rur: 2439, url: 'https://plati.market/itm/1' }, { name: 'free', price_rur: 0, url: 'u' }] }]]);
    expect(await ADAPTERS.plati({ query: 'Elden Ring' })).toEqual([{ sourceId: 'plati', title: 'Elden Ring ключ', price: 2439, currency: 'RUB', url: 'https://plati.market/itm/1' }]);
  });
  it('Plati: изменилась структура (нет items) → пусто, не падение', async () => {
    mockFetch([[/plati\.io/, 200, { results: [] }]]);
    expect(await ADAPTERS.plati({ query: 'x' })).toEqual([]);
  });
  it('GOG: только цены в RUB', async () => {
    mockFetch([[/catalog\.gog\.com/, 200, { products: [{ title: 'Witcher 3', storeLink: 'https://gog.com/w3', price: { finalMoney: { amount: '352', currency: 'RUB' } } }, { title: 'X', price: { finalMoney: { amount: '5', currency: 'USD' } } }] }]]);
    expect(await ADAPTERS.gog({ query: 'witcher' })).toEqual([{ sourceId: 'gog', title: 'Witcher 3', price: 352, currency: 'RUB', url: 'https://gog.com/w3' }]);
  });
  it('GabeStore: разбор HTML карточек', async () => {
    const html = '<div class="shop-item"><a class="shop-item__name" href="/game/elden-ring">ELDEN RING</a><div class="shop-item__price"><div class="shop-item__price-current">2 739 ₽</div></div></div>';
    mockFetch([[/gabestore/, 200, { page: 1, html }]]);
    expect(await ADAPTERS.gabestore({ query: 'elden' })).toEqual([{ sourceId: 'gabestore', title: 'ELDEN RING', price: 2739, currency: 'RUB', url: 'https://gabestore.ru/game/elden-ring' }]);
  });
  it('GabeStore: вёрстка изменилась → 0 предложений (здоровье покажет «пустые ответы подряд»)', async () => {
    mockFetch([[/gabestore/, 200, { page: 1, html: '<div class="new-card">ELDEN RING 2739</div>' }]]);
    expect(await ADAPTERS.gabestore({ query: 'elden' })).toEqual([]);
  });
  it('CheapShark: сделки магазинов в USD, ссылка-редирект', async () => {
    mockFetch([
      [/games\?title=/, 200, [{ gameID: '1', external: 'ELDEN RING' }]],
      [/games\?id=1/, 200, { info: { title: 'ELDEN RING' }, deals: [{ storeID: '15', dealID: 'abc', price: '53.88' }] }],
    ]);
    expect(await ADAPTERS.cheapshark({ query: 'elden ring' })).toEqual([{ sourceId: 'cs-15', title: 'ELDEN RING', price: 53.88, currency: 'USD', url: 'https://www.cheapshark.com/redirect?dealID=abc' }]);
  });
});

describe('выгрузки скинов', () => {
  it('Skinport: точное имя, фаза из version, без цены — не в индексе', async () => {
    mockFetch([[/skinport/, 200, [
      { market_hash_name: '★ Karambit | Doppler (Factory New)', version: 'Phase 2', min_price: 50000, quantity: 1, item_page: 'https://skinport.com/k' },
      { market_hash_name: 'AK-47 | Redline (Field-Tested)', version: null, min_price: null, quantity: 0, item_page: 'x' },
    ]]]);
    const idx = await feedIndex('skinport', 'cs2');
    expect(idx.size).toBe(1);
    expect([...idx.values()][0]).toMatchObject({ price: 50000, phase: 'Phase 2', stock: 1 });
  });
  it('Waxpeer: min в тысячных долях доллара', async () => {
    mockFetch([[/waxpeer/, 200, { success: true, items: [{ name: 'AK-47 | Redline (Field-Tested)', count: 5, min: 25350 }] }]]);
    const idx = await feedIndex('waxpeer', 'cs2');
    expect([...idx.values()][0]).toMatchObject({ price: 25.35, currency: 'USD' });
  });
  it('LIS-SKINS: цена без трейд-лока', async () => {
    mockFetch([[/lis-skins/, 200, [{ name: 'AK-47 | Redline (Field-Tested)', price: 20, unlocked_price: 25.1, url: 'https://lis-skins.com/a', count: 3 }]]]);
    const idx = await feedIndex('lis', 'cs2');
    expect([...idx.values()][0].price).toBe(25.1);
  });
});

describe('FunPay', () => {
  const html = readFileSync(join(FIX, 'funpay-lots.html'), 'utf8');
  it('таблица лотов: цены в ₽, продавцы, онлайн, фильтры, платформа', async () => {
    mockFetch([[/funpay\.com\/lots\/986/, 200, html]]);
    const p = await getOffers('https://funpay.com/lots/986/');
    expect(p.offers.map((o) => o.price)).toEqual([2957, 1500, 2100.5]);
    expect(p.offers[0]).toMatchObject({ seller: 'SellerA', online: true, reviews: 120, filters: { type: 'цифровой ключ', type2: 'standard edition', server: '7027' } });
    expect(p.facets.map((f) => f.key).sort()).toEqual(['server', 'type', 'type2']);
  });
  it('FunPay без таблицы (смена вёрстки) → ошибка format', async () => {
    mockFetch([[/funpay\.com\/lots\/1\//, 200, '<html><body>новый дизайн</body></html>']]);
    await expect(getOffers('https://funpay.com/lots/1/')).rejects.toMatchObject({ code: 'format' });
  });
  it('SSRF: принимается только хост funpay.com, чужие и внутренние адреса не запрашиваются', async () => {
    const calls = mockFetch([[/^https:\/\/funpay\.com\/lots\/5\/$/, 200, html]]);
    for (const u of [
      'https://evil.example/funpay.com/lots/5/',
      'http://127.0.0.1/?x=funpay.com/lots/5',
      'https://funpay.com.evil.example/lots/5/',
      'https://user:pass@funpay.com/lots/5/',
      'http://169.254.169.254/latest/meta-data/funpay.com/lots/5/',
      'file:///etc/passwd',
      'javascript:alert(1)//funpay.com/lots/5/',
    ]) {
      expect(() => normalizeCategoryUrl(u), u).toThrow();
      await expect(getOffers(u)).rejects.toMatchObject({ code: 'input' });
    }
    expect(normalizeCategoryUrl('https://funpay.com/en/lots/5/?x=1').url).toBe('https://funpay.com/lots/5/');
    await getOffers('https://www.funpay.com/lots/5');
    expect(calls).toEqual(['https://funpay.com/lots/5/']);
  });
});

describe('качество данных', () => {
  it('неполные котировки и неизвестная валюта помечаются', () => {
    const q = assessOffers(
      [
        { title: 'Game', url: 'https://a', price: 100, priceRub: 100, currency: 'RUB' },
        { title: '', url: 'nope', price: 0, priceRub: 0, currency: 'XYZ' },
      ],
      { sourceId: 's' },
    );
    expect(q.withIssues).toBe(1);
    expect(q.issues[1]).toEqual(expect.arrayContaining(['нет названия', 'нет ссылки на товар', 'цена не распознана', 'неизвестная валюта XYZ']));
  });
  it('устаревший курс ЦБ для валютных цен', () => {
    const q = assessOffers([{ title: 'Game', url: 'https://a', price: 10, priceRub: 900, currency: 'USD' }], { sourceId: 's', ratesDate: '2020-01-01T00:00:00Z' });
    expect(q.issues[0][0]).toMatch(/курс ЦБ устарел/);
  });
});
