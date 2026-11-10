// Arbitrage Intelligence: превращает ценовую разницу в проверенную торговую гипотезу.
// Конвейер: сопоставление → compliance → свежесть → наличие → рынок FunPay → прибыль → бюджет → балл.
// Любой жёсткий блок отключает рекомендацию независимо от балла.
import { forecast, solvePrice } from './finance.mjs';
import { trimmedMedian, median } from '../repo/history.mjs';

const clamp = (v) => Math.max(0, Math.min(1, v));
const ageMin = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity);

export const STATUS = { RECOMMENDED: 'RECOMMENDED', REVIEW: 'REVIEW', BLOCKED: 'BLOCKED' };

/**
 * @param {object} p
 * @param {object} p.item         { name, category, watchId }
 * @param {object} p.buy          предложение источника: priceRub, sourceId, url, title, stock, fetchedAt, manual, match{status,source,reasons}
 * @param {object} p.market       FunPay: prices[], count, online, sellers, topSellerShare, fetchedAt, url, title
 * @param {object} p.settings     getSettings()
 * @param {object} p.saleFee      { pct, fixed, origin, source, assumed }
 * @param {object} p.sourceFee    { pct, fixed, source, assumed }
 * @param {object} p.health       healthSummary источника или null (ручной)
 * @param {object} p.liquidity    liquidity() или null
 * @param {object} p.ownSales     { count, medianDays }
 * @param {object} p.compliance   { level, hits }
 * @param {object} p.cash         { tracking, balance }
 */
export const LEGACY_MATCH = { status: 'REVIEW_REQUIRED', source: 'rules', reasons: [{ ok: null, text: 'совпадение не проверялось (данные прежней версии) — пересканируйте' }] };

export function evaluate(p) {
  const { item, market, settings: S, saleFee, sourceFee, health, liquidity, ownSales, compliance, cash } = p;
  const buy = p.buy.match ? p.buy : { ...p.buy, match: LEGACY_MATCH };
  const blocks = [];
  const reviews = [];
  const warnings = [];
  const assumptions = [];

  // ── 1. сопоставление
  const ms = buy.match?.status ?? 'REVIEW_REQUIRED';
  if (ms === 'REJECTED') blocks.push(`товар не совпадает: ${(buy.match.reasons ?? []).filter((r) => r.ok === false).map((r) => r.text).join('; ') || 'отклонено'}`);
  else if (ms === 'REVIEW_REQUIRED') reviews.push(`нужна проверка совпадения: ${(buy.match.reasons ?? []).filter((r) => r.ok === null).map((r) => r.text).join('; ')}`);

  // ── 2. правила площадки
  for (const h of compliance?.hits ?? []) {
    const t = `п. ${h.clause}: ${h.text}${h.match ? ` («${h.match}»)` : ''}`;
    if (h.level === 'block') blocks.push(t);
    else reviews.push(t);
  }

  // ── 3. свежесть
  const F = S.freshness;
  const srcTtl = buy.manual ? F.manualTtlH * 60 : F.sourceTtlMin;
  const srcAge = ageMin(buy.fetchedAt);
  const fpAge = ageMin(market?.fetchedAt);
  if (srcAge > srcTtl) blocks.push(`цена источника устарела: ${Math.round(srcAge)} мин (допустимо ${srcTtl})`);
  if (market && fpAge > F.funpayTtlMin) blocks.push(`цены FunPay устарели: ${Math.round(fpAge)} мин (допустимо ${F.funpayTtlMin})`);

  // ── 4. наличие
  if (buy.stock === 0) blocks.push('у источника нет в наличии');
  else if (buy.stock === null || buy.stock === undefined) {
    if (S.scoring.requireKnownStock) blocks.push('наличие у источника неизвестно (включена обязательная проверка)');
    else assumptions.push('наличие у источника не подтверждено');
  }

  // ── 5. рынок FunPay
  const prices = (market?.prices ?? []).filter((x) => x > 0).sort((a, b) => a - b);
  if (!prices.length) blocks.push('на FunPay нет подходящих предложений для сравнения');

  // ── источник: здоровье
  if (health?.status === 'circuit_open') blocks.push(`источник отключён после серии ошибок до ${health.circuitOpenUntil}`);
  else if (health && health.calls >= 3 && health.successRate < 0.5) warnings.push(`источник нестабилен: успешно ${Math.round(health.successRate * 100)}% запросов`);

  // ── допущения финансовой модели
  if (saleFee.assumed) assumptions.push(`комиссия FunPay ${saleFee.pct}% не подтверждена для раздела (${saleFee.source})`);
  if (sourceFee.assumed) assumptions.push('комиссия при покупке у источника не задана — принята 0');
  const daysToSell = ownSales?.medianDays ?? S.costModel.expectedDaysToSell;
  if (ownSales?.medianDays === null || ownSales?.medianDays === undefined) assumptions.push(`срок продажи ${daysToSell} дн. — допущение (своих продаж нет)`);
  if (buy.currency && buy.currency !== 'RUB') assumptions.push(`цена в ${buy.currency}, перевод по курсу ЦБ ${buy.fxRate ? buy.fxRate.toFixed(4) : ''}${S.costModel.fxSpreadPct ? ` + спред ${S.costModel.fxSpreadPct}%` : ' без спреда'}`);

  // ── цены продажи
  const P = S.pricing;
  const undercut = (x) => Math.max(0, Math.round((x * (1 - P.undercutPct / 100) - P.undercutRub) * 100) / 100);
  const base = { buyRub: buy.priceRub, saleFee, sourceFee, m: S.costModel, daysToSell };
  const fc = (price) => (price > 0 ? forecast({ ...base, sellPrice: price }) : null);
  const min = prices[0] ?? null;
  const top10 = prices.slice(0, 10);
  const breakEven = solvePrice(base, 0);
  const scenarios = [];
  if (min) {
    const fast = undercut(min);
    scenarios.push({ key: 'fast', label: 'Быстрый оборот', price: fast, why: `на ${P.undercutPct ? `${P.undercutPct}% и ` : ''}${P.undercutRub} ₽ ниже самого дешёвого конкурента (${min} ₽)` });
    const tm = trimmedMedian(top10);
    if (tm && top10.length >= 3) scenarios.push({ key: 'balanced', label: 'Сбалансированная', price: Math.max(fast, undercut(tm)), why: `усечённая медиана 10 самых дешёвых лотов (${Math.round(tm)} ₽)` });
    const md = median(top10);
    if (md && prices.length >= P.minCompetitors) scenarios.push({ key: 'max', label: 'Максимальная маржа (риск)', price: Math.max(fast, undercut(md)), why: `медиана 10 самых дешёвых (${Math.round(md)} ₽); продаётся дольше` });
  }
  for (const s of scenarios) s.forecast = fc(s.price);
  const decisionScenario = scenarios[0] ?? null; // решение принимается по самой консервативной цене
  const f = decisionScenario?.forecast ?? null;

  // ── 6. прибыль
  if (f && f.net <= 0) blocks.push(`отрицательная чистая прибыль: ${f.net.toFixed(2)} ₽ при цене ${decisionScenario.price} ₽`);

  // ── 7. бюджет и касса
  const cost = f ? f.invested : buy.priceRub;
  if (S.inventory.maxPurchaseRub > 0 && cost > S.inventory.maxPurchaseRub) blocks.push(`закупка ${cost.toFixed(0)} ₽ больше лимита ${S.inventory.maxPurchaseRub} ₽`);
  if (cash?.tracking && cost > cash.balance) blocks.push(`не хватает денег: в кассе ${cash.balance.toFixed(0)} ₽`);

  // ── подозрительно дёшево
  if (min && S.scoring.suspiciousPct > 0 && buy.priceRub < (min * S.scoring.suspiciousPct) / 100 && buy.match?.source !== 'manual') {
    reviews.push(`закупка дешевле ${S.scoring.suspiciousPct}% от цены FunPay — скорее всего не тот товар`);
  }

  // ── предупреждения по категории
  if (buy.sourceId?.startsWith('cs-')) warnings.push('цена региона США (CheapShark) — проверьте регион активации');
  if (item.category === 'skins') warnings.push('трейд-холд/защита сделок Steam: предмет и деньги могут быть заморожены до 7 дней');
  if (market && market.count < P.minCompetitors) warnings.push(`мало конкурентов (${market.count}) — их цена не доказывает спрос`);
  if (market && market.online === 0) warnings.push('ни одного продавца онлайн');

  // ── 8. балл
  const W = S.scoring.weights;
  const lq = liquidity?.observed;
  const liqScore =
    ownSales?.count >= 3 && ownSales.medianDays !== null
      ? clamp(1 - (ownSales.medianDays - 1) / 13)
      : lq
        ? clamp(0.6 * clamp(Math.log10((lq.activeLots ?? 0) + 1) / Math.log10(21)) + 0.4 * clamp((lq.disappearPerLotDay ?? 0) / 0.5))
        : market
          ? 0.6 * clamp(Math.log10(market.count + 1) / Math.log10(21))
          : 0;
  const components = {
    match: ms === 'VERIFIED' ? (buy.match.source === 'manual' ? 1 : 0.9) : ms === 'REVIEW_REQUIRED' ? 0.4 : 0,
    margin: f ? clamp(f.netPct / 30) : 0,
    liquidity: liqScore,
    reliability: health?.calls ? health.reliability : 0.5,
    competition: market ? clamp((market.topSellerShare === null || market.topSellerShare === undefined ? 0.5 : 1 - market.topSellerShare) * (market.count >= P.minCompetitors ? 1 : 0.5)) : 0,
    freshness: clamp(1 - Math.max(srcAge / srcTtl, market ? fpAge / F.funpayTtlMin : 1)),
    risk: clamp(1 - 0.2 * warnings.length - 0.1 * assumptions.length),
    availability: buy.stock > 0 ? 1 : buy.stock === 0 ? 0 : 0.5,
  };
  const wsum = Object.values(W).reduce((a, x) => a + x, 0) || 1;
  const score = (Object.entries(components).reduce((a, [k, v]) => a + (W[k] ?? 0) * v, 0) / wsum) * 100;

  let status = blocks.length ? STATUS.BLOCKED : reviews.length ? STATUS.REVIEW : STATUS.RECOMMENDED;
  if (status === STATUS.RECOMMENDED && score < S.scoring.minScore) {
    status = STATUS.REVIEW;
    reviews.push(`балл ${score.toFixed(0)} ниже порога ${S.scoring.minScore}`);
  }

  return {
    status,
    score,
    components,
    blocks,
    reviews,
    warnings,
    assumptions,
    prices: {
      breakEven,
      scenarios,
      decision: decisionScenario?.key ?? null,
      highCompetition: scenarios.find((s) => s.key === 'fast')?.price ?? null,
      lowCompetition: (scenarios.find((s) => s.key === 'max') ?? scenarios.find((s) => s.key === 'balanced'))?.price ?? null,
      optimal: null,
      optimalNote:
        (ownSales?.count ?? 0) < 10
          ? 'оптимальная цена по ожидаемой прибыли появится после ≥ 10 собственных продаж товара: без них модель спроса не откалибрована'
          : 'см. сценарии: собственные продажи есть, но эластичность спроса по цене ещё не моделируется',
    },
    forecast: f,
    ages: { sourceMin: srcAge, funpayMin: fpAge },
    daysToSell,
  };
}
