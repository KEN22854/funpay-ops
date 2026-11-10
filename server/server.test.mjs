import { describe, expect, it } from 'vitest';
import { normalizeCategoryUrl, parsePrice, summarize } from './lib/funpay.mjs';
import { norm, passes, queryTokens, skinInText, tokens } from './lib/match.mjs';
import { toRub } from './lib/rates.mjs';
import { sanitizeWatch } from './lib/store.mjs';
import { SOURCES } from './sources/registry.mjs';
import { ADAPTERS } from './sources/adapters.mjs';

describe('реестр источников', () => {
  it('не меньше 50 источников, id уникальны, у автоматических есть адаптер', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
    for (const s of SOURCES) {
      if (s.method !== 'manual') expect(ADAPTERS[s.adapter], s.id).toBeTypeOf('function');
      expect(s.categories.length, s.id).toBeGreaterThan(0);
      expect(s.url).toMatch(/^https:\/\//);
    }
  });
});

describe('сопоставление', () => {
  it('include/exclude по нормализованному тексту', () => {
    expect(passes('ELDEN RING — Steam Ключ', queryTokens('Elden Ring'), tokens('аренда'))).toBe(true);
    expect(passes('ELDEN RING PS4 Аренда', queryTokens('Elden Ring'), tokens('аренда'))).toBe(false);
    expect(norm('Ёжик™')).toBe('ежик');
  });

  it('скин: точное имя, StatTrak и Souvenir не путаются', () => {
    const n = 'AK-47 | Redline (Field-Tested)';
    expect(skinInText(n, '🟨AK-47 | Redline (Field-Tested) [Красная линия] АВТОВЫДАЧА')).toBe(true);
    expect(skinInText(n, 'StatTrak™ AK-47 | Redline (Field-Tested)')).toBe(false);
    expect(skinInText('StatTrak™ AK-47 | Redline (Field-Tested)', 'StatTrak AK-47 | Redline (Field-Tested)')).toBe(true);
    expect(skinInText(n, 'AK-47 | Redline (Minimal Wear)')).toBe(false);
  });
});

describe('FunPay', () => {
  it('цена и ссылка раздела', () => {
    expect(parsePrice('<div>1 234.50 <span class="unit">₽</span></div>')).toBe(1234.5);
    expect(parsePrice('0.0051 ₽')).toBe(0.0051);
    expect(normalizeCategoryUrl('https://funpay.com/en/chips/2/?x=1')).toEqual({ kind: 'chips', id: 2, url: 'https://funpay.com/chips/2/' });
    expect(() => normalizeCategoryUrl('https://evil.example/lots/1/')).toThrow();
  });

  it('сводка: минимум и медиана 10 самых дешёвых', () => {
    const s = summarize([5, 1, 3, 2, 4].map((price, i) => ({ price, online: i % 2 === 0 })));
    expect(s.min).toBe(1);
    expect(s.median10).toBe(3);
    expect(s.online).toBe(3);
  });
});

describe('валюта и проверка ввода', () => {
  it('toRub', () => {
    expect(toRub(10, 'usd', { USD: 90, RUB: 1 })).toBe(900);
    expect(toRub(10, 'XXX', { RUB: 1 })).toBeNull();
  });

  it('sanitizeWatch чистит мусор и требует запрос', () => {
    expect(() => sanitizeWatch({ query: '  ' })).toThrow();
    const w = sanitizeWatch({ query: 'Elden Ring', category: 'bogus', include: 'a, b,,', manual: [{ sourceId: 'g2a', price: '-5', currency: 'BTC', url: 'javascript:alert(1)' }] });
    expect(w.category).toBe('keys');
    expect(w.include).toEqual(['a', 'b']);
    expect(w.manual[0]).toMatchObject({ price: 0, currency: 'RUB', url: '' });
  });
});
