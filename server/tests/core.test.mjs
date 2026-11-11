// Расчёты, сопоставление, compliance, движок — без базы данных.
import { describe, expect, it } from 'vitest';
import { extractAttrs, funpayAttrs, matchOffer } from '../core/attributes.mjs';
import { checkCompliance } from '../core/compliance.mjs';
import { forecast, platformFee, saleResult, solvePrice } from '../core/finance.mjs';
import { evaluate, STATUS } from '../core/engine.mjs';
import { DEFAULT_SETTINGS } from '../repo/settings.mjs';

const M = { ...DEFAULT_SETTINGS.costModel };
const fee5 = { pct: 5, fixed: 0 };
const fee0 = { pct: 0, fixed: 0 };

describe('финансовая модель', () => {
  it('строки прогноза в сумме дают чистую прибыль; X и Y перемножаются', () => {
    const f = forecast({ sellPrice: 1000, buyRub: 600, saleFee: fee5, sourceFee: { pct: 2, fixed: 10 }, m: { ...M, withdrawPct: 3, disputePct: 1, taxPct: 4 }, daysToSell: 3 });
    const sum = f.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBeCloseTo(f.net, 9);
    expect(f.payout).toBeCloseTo(1000 * 0.95 * 0.97, 9);
    // 921.5 − 600 − (12 + 10) − 10 (споры) − 4% от 921.5 налог
    expect(f.net).toBeCloseTo(921.5 - 600 - 22 - 10 - 921.5 * 0.04, 9);
    expect(f.roiPct).toBeCloseTo((f.net / 622) * 100, 9);
  });

  it('модель «комиссия сверху»: продавец получает P / (1 + X)', () => {
    expect(platformFee(105, 5, 'addon')).toBeCloseTo(5, 9);
    expect(platformFee(100, 5, 'deduct')).toBeCloseTo(5, 9);
  });

  it('налог с прибыли не берётся с убытка', () => {
    const f = forecast({ sellPrice: 100, buyRub: 200, saleFee: fee0, sourceFee: fee0, m: { ...M, taxPct: 6, taxBase: 'profit' }, daysToSell: 0 });
    expect(f.lines.find((l) => l.key === 'tax').amount).toBe(-0);
  });

  it('стоимость капитала: годовая ставка × срок', () => {
    const f = forecast({ sellPrice: 1000, buyRub: 365, saleFee: fee0, sourceFee: fee0, m: { ...M, capitalRatePct: 10 }, daysToSell: 10 });
    expect(f.lines.find((l) => l.key === 'capital').amount).toBeCloseTo(-365 * 0.1 * (10 / 365), 9);
  });

  it('solvePrice: найденная цена даёт цель, на копейку ниже — нет', () => {
    const args = { buyRub: 600, saleFee: fee5, sourceFee: { pct: 2, fixed: 10 }, m: { ...M, withdrawPct: 3, taxPct: 4, taxBase: 'profit', disputePct: 2 }, daysToSell: 5 };
    for (const target of [0, 100, 333.33]) {
      const p = solvePrice(args, target);
      expect(forecast({ ...args, sellPrice: p }).net).toBeGreaterThanOrEqual(target - 1e-9);
      expect(forecast({ ...args, sellPrice: p - 0.01 }).net).toBeLessThan(target);
    }
  });

  it('solvePrice: недостижимая цель → null', () => {
    expect(solvePrice({ buyRub: 100, saleFee: { pct: 99.99, fixed: 0 }, sourceFee: fee0, m: { ...M, withdrawPct: 99.99 }, daysToSell: 0 }, 1e9)).toBeNull();
  });

  it('фактический результат: возврат уменьшает выплату и налог', () => {
    const a = saleResult({ qty: 2, unitPrice: 500, saleFeePct: 5, withdrawPct: 0, cogs: 600, taxPct: 4 });
    expect(a.net).toBeCloseTo(950 - 600 - 38, 9);
    const b = saleResult({ qty: 2, unitPrice: 500, saleFeePct: 5, withdrawPct: 0, cogs: 600, taxPct: 4, refund: 950 });
    expect(b.tax).toBe(0);
    expect(b.net).toBeCloseTo(-600, 9);
  });
});

describe('сопоставление товаров (эталонные пары)', () => {
  const req = { platform: 'pc', regions: ['ru'], type: 'key', edition: 'standard' };
  const m = (title, extra = {}, r = req) => matchOffer({ ...extractAttrs(title), ...extra }, r, { category: 'keys', side: 'source', title }).status;

  it.each([
    ['ELDEN RING | STEAM КЛЮЧ | РФ+СНГ', 'VERIFIED'],
    ['Elden Ring Steam Key GLOBAL', 'VERIFIED'],
    ['Elden Ring PS5 ключ РФ', 'REJECTED'],
    ['Elden Ring Deluxe Edition Steam key RU', 'REJECTED'],
    ["👑 BALDUR'S GATE 3 🎀 +ELDEN RING АВТО STEAM GUARD", 'REJECTED'],
    ['ELDEN RING Tarnished Pack Steam key RU', 'REJECTED'],
    ['Elden Ring Steam key TR Турция', 'REJECTED'],
    ['Elden Ring аренда 30 дней', 'REJECTED'],
    ['Elden Ring ключ Steam', 'REVIEW_REQUIRED'],
  ])('%s → %s', (title, status) => {
    expect(m(title)).toBe(status);
  });

  it('известный тип источника: Steam продаёт подарок, а нужен ключ → REJECTED', () => {
    expect(m('ELDEN RING', { knownType: 'gift', knownPlatform: 'pc', knownRegion: 'ru' })).toBe('REJECTED');
    expect(m('ELDEN RING', { knownType: 'key', knownPlatform: 'pc', knownRegion: 'ru' })).toBe('VERIFIED');
  });

  it('лот FunPay: структурированные фильтры важнее текста', () => {
    const fp = funpayAttrs({ desc: 'Elden Ring ключ', filters: { type: 'подарком', region: 'турция', server: '7027' } });
    expect(matchOffer(fp, req, { category: 'keys', side: 'funpay' }).status).toBe('REJECTED');
    const ok = funpayAttrs({ desc: 'Elden Ring', filters: { type: 'цифровой ключ', region2: 'russia', server: '7027' } });
    expect(matchOffer(ok, req, { category: 'keys', side: 'funpay' }).status).toBe('VERIFIED');
  });

  it('ручное решение перекрывает правила', () => {
    const r = matchOffer(extractAttrs('Elden Ring PS5'), req, { category: 'keys', decision: { status: 'VERIFIED', reason: 'проверил' } });
    expect(r).toMatchObject({ status: 'VERIFIED', source: 'manual' });
  });

  it('скины: фаза Doppler и float', () => {
    // режим pattern: строгость только для скинов, где цена зависит от фазы/паттерна
    const sk = (title, phase, r = {}) => matchOffer({}, r, { category: 'skins', title, nameExact: true, phase, skinsStrict: 'pattern' }).status;
    expect(sk('AK-47 | Redline (Field-Tested)')).toBe('VERIFIED');
    expect(sk('★ Karambit | Doppler (Factory New)', null)).toBe('REVIEW_REQUIRED');
    expect(sk('★ Karambit | Doppler (Factory New)', 'Phase 2', { phase: 'Phase 2' })).toBe('VERIFIED');
    expect(sk('★ Karambit | Doppler (Factory New)', 'Phase 1', { phase: 'Phase 2' })).toBe('REJECTED');
    expect(sk('AK-47 | Redline (Field-Tested)', null, { requireFloat: true })).toBe('REVIEW_REQUIRED');
    expect(matchOffer({}, {}, { category: 'skins', title: 'x', nameExact: false }).status).toBe('REJECTED');
  });

  it('причины совпадения и расхождения сохраняются', () => {
    const r = matchOffer(extractAttrs('Elden Ring PS5 ключ РФ'), req, { category: 'keys' });
    expect(r.reasons.some((x) => x.ok === false && x.text.includes('PlayStation'))).toBe(true);
    expect(r.reasons.some((x) => x.ok === true && x.text.includes('регион'))).toBe(true);
  });
});

describe('compliance', () => {
  it.each([
    ['Прочитайте инструкцию, читать обязательно', 'ok'],
    ['Like a Dragon: Pirate Yakuza in Hawaii', 'ok'],
    ['Скрипт активации', 'ok'],
    ['Читы для CS2', 'warn'],
    ['Ключ на рандом игру', 'warn'],
    ['Пополнение казино', 'block'],
    ['Аккаунты после брута', 'block'],
    ['оплата напрямую на карту, дешевле', 'block'],
  ])('%s → %s', (text, level) => {
    expect(checkCompliance({ texts: [text] }).level).toBe(level);
  });

  it('раздел оффлайн-активаций — предупреждение', () => {
    expect(checkCompliance({ texts: ['Elden Ring'], sectionTitle: 'Elden Ring Оффлайн активации' }).level).toBe('warn');
  });
});


describe('строгое сопоставление', () => {
  it('скины в строгом режиме: любой предмет подтверждается вручную', () => {
    const r = matchOffer({}, {}, { category: 'skins', title: 'AK-47 | Redline (Field-Tested)', nameExact: true, skinsStrict: 'all' });
    expect(r.status).toBe('REVIEW_REQUIRED');
    expect(r.reasons.at(-1).text).toMatch(/float, paint seed/);
  });

  it('диапазон float: лот FunPay вне диапазона отклоняется, без float — проверить', () => {
    const req = { floatMin: 0.15, floatMax: 0.18 };
    const fp = (desc) => {
      const a = extractAttrs(desc);
      return matchOffer(a, req, { category: 'skins', side: 'funpay', title: desc, nameExact: true, float: a.float }).status;
    };
    expect(fp('AK-47 | Redline (Field-Tested) Float: 0.16')).toBe('VERIFIED');
    expect(fp('AK-47 | Redline (Field-Tested) флоат 0,35')).toBe('REJECTED');
    expect(fp('AK-47 | Redline (Field-Tested)')).toBe('REVIEW_REQUIRED');
  });

  it('ограничения активации ключа', () => {
    const req = { platform: 'pc', regions: ['ru'], type: 'key' };
    const st = (t) => matchOffer(extractAttrs(t), req, { category: 'keys', title: t }).status;
    expect(st('Elden Ring Steam ключ GLOBAL, нужен VPN для активации')).toBe('REJECTED');
    expect(st('Elden Ring Steam key Global — не активируется в РФ')).toBe('REJECTED');
    expect(st('Elden Ring Steam ключ РФ, region locked')).toBe('REVIEW_REQUIRED');
  });
});

describe('движок: статусы и Profit Verification', () => {
  const now = new Date().toISOString();
  const S = structuredClone(DEFAULT_SETTINGS);
  const base = (over = {}) => ({
    item: { name: 'Game', category: 'keys' },
    buy: { sourceId: 'gabestore', priceRub: 500, url: 'https://x', title: 'Game key', stock: null, fetchedAt: now, match: { status: 'VERIFIED', source: 'rules', reasons: [] }, ...over.buy },
    market: { prices: [1000, 1050, 1100, 1200, 1300], count: 5, online: 3, sellers: 5, topSellerShare: 0.2, fetchedAt: now, ...over.market },
    settings: over.settings ?? S,
    saleFee: { pct: 5, fixed: 0, source: 'тест', assumed: false },
    sourceFee: { pct: 0, fixed: 0, source: 'тест', assumed: false },
    health: { calls: 10, reliability: 0.9, successRate: 1, status: 'ok' },
    liquidity: null,
    ownSales: { count: 0, medianDays: null },
    compliance: { level: 'ok', hits: [] },
    capital: { blocks: [], warnings: [] },
    verification: over.verification ?? null,
  });

  it('все проверки пройдены, но наличие не подтверждено → CANDIDATE (theoretical)', () => {
    const e = evaluate(base());
    expect(e.status).toBe(STATUS.CANDIDATE);
    expect(e.verification).toBe('theoretical');
    expect(e.executionGaps.join()).toMatch(/наличие/);
    expect(e.prices.scenarios.map((s) => s.key)).toEqual(['fast', 'balanced', 'max']);
    expect(e.netPerDay).toBeCloseTo(e.forecast.net / S.costModel.expectedDaysToSell, 9);
  });

  it('перепроверка с подтверждённым наличием → RECOMMENDED (executable); устаревшая — снова кандидат', () => {
    const fresh = { ts: now, ok: 1, stock: null, user_confirmed_stock: 1 };
    expect(evaluate(base({ verification: fresh })).status).toBe(STATUS.RECOMMENDED);
    const old = { ...fresh, ts: new Date(Date.now() - 60 * 60_000).toISOString() };
    expect(evaluate(base({ verification: old, buy: { fetchedAt: new Date(Date.now() - 30 * 60_000).toISOString() } })).status).toBe(STATUS.CANDIDATE);
  });

  it('источник со свежим подтверждённым остатком (выгрузка) → исполнимо без ручной проверки', () => {
    expect(evaluate(base({ buy: { stock: 3 } })).status).toBe(STATUS.RECOMMENDED);
  });

  it('неудачная перепроверка (цена выросла) → блок', () => {
    const e = evaluate(base({ verification: { ts: now, ok: 0, stock: null, user_confirmed_stock: 0, detail: 'цена выросла' } }));
    expect(e.status).toBe(STATUS.BLOCKED);
  });

  it('жёсткие блоки: несовпадение, устаревшие данные, нет в наличии, убыток, капитал, правила', () => {
    const old = new Date(Date.now() - 10 * 3600_000).toISOString();
    expect(evaluate(base({ buy: { match: { status: 'REJECTED', reasons: [{ ok: false, text: 'регион' }] } } })).status).toBe(STATUS.BLOCKED);
    expect(evaluate(base({ buy: { fetchedAt: old } })).blocks.join()).toMatch(/устарела/);
    expect(evaluate(base({ market: { fetchedAt: old } })).blocks.join()).toMatch(/FunPay устарели/);
    expect(evaluate(base({ buy: { stock: 0 } })).status).toBe(STATUS.BLOCKED);
    expect(evaluate(base({ buy: { priceRub: 2000 } })).blocks.join()).toMatch(/отрицательная/);
    expect(evaluate({ ...base(), capital: { blocks: ['доля капитала в товаре «Game» станет 45% (лимит 30%)'], warnings: [] } }).status).toBe(STATUS.BLOCKED);
    expect(evaluate({ ...base(), compliance: { level: 'block', hits: [{ clause: '2.2.10', level: 'block', text: 'казино', match: 'казино' }] } }).status).toBe(STATUS.BLOCKED);
  });

  it('неизвестный критичный атрибут и проблемы данных → REVIEW, а не кандидат', () => {
    expect(evaluate(base({ buy: { match: { status: 'REVIEW_REQUIRED', reasons: [{ ok: null, text: 'регион не указан' }] } } })).status).toBe(STATUS.REVIEW);
    expect(evaluate(base({ buy: { dq: ['цена отличается от истории источника на 80%'] } })).status).toBe(STATUS.REVIEW);
    expect(evaluate(base({ buy: { priceRub: 100 } })).reviews.join()).toMatch(/не тот товар/);
  });

  it('потери на возвратах берутся из своих продаж, если они есть', () => {
    const e = evaluate({ ...base(), learnedLoss: { pct: 4, prior: 0, observed: 8, n: 10, scope: 'источник gabestore' } });
    expect(e.model.disputePct).toBe(4);
    expect(e.forecast.losses).toBeCloseTo(e.forecast.price * 0.04, 9);
    expect(e.assumptions.join()).toMatch(/по 10 своим продажам/);
  });

  it('спрос из своих продаж задаёт срок продажи и ликвидность', () => {
    const demand = { enough: true, medianDays: 2, probs: { 1: { p: 0.3, lo: 0.1, hi: 0.5 }, 3: { p: 0.6, lo: 0.4, hi: 0.8 }, 7: { p: 0.9, lo: 0.8, hi: 1 }, 14: { p: 1, lo: 1, hi: 1 } } };
    const e = evaluate({ ...base(), demand });
    expect(e.daysToSell).toBe(2);
    expect(e.components.liquidity).toBe(0.9);
    expect(e.sellProb7.p).toBe(0.9);
  });

  it('мало наблюдений рынка — ликвидность ограничена и есть предупреждение', () => {
    const liq = { observed: { activeLots: 50, disappearPerLotDay: 1, snapshots: 2, observationDays: 0.1 }, confidence: 'low' };
    const e = evaluate({ ...base(), liquidity: liq });
    expect(e.components.liquidity).toBeLessThanOrEqual(0.3);
    expect(e.warnings.join()).toMatch(/мало наблюдений/);
  });
});

describe('срок продажи не берётся из единичных продаж', () => {
  it('две свои продажи за 0.4 дня не задают срок — используется допущение', () => {
    const S = structuredClone(DEFAULT_SETTINGS);
    const now = new Date().toISOString();
    const e = evaluate({
      item: { name: 'G', category: 'keys' },
      buy: { sourceId: 's', priceRub: 500, url: 'u', title: 't', stock: 1, fetchedAt: now, match: { status: 'VERIFIED', source: 'manual', reasons: [] } },
      market: { prices: [1000, 1100, 1200], count: 3, online: 1, fetchedAt: now },
      settings: S,
      saleFee: { pct: 5, assumed: false },
      sourceFee: { pct: 0, assumed: false },
      ownSales: { count: 2, medianDays: 0.4 },
      capital: { blocks: [], warnings: [] },
    });
    expect(e.daysToSell).toBe(S.costModel.expectedDaysToSell);
    expect(e.assumptions.join()).toMatch(/своих продаж меньше/);
  });
});
