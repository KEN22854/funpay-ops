// Arbitrage Intelligence + Profit Verification.
// Конвейер: сопоставление → качество данных → правила площадки → свежесть → наличие → рынок FunPay →
// прибыль (единый финансовый движок) → капитал и риск → балл → исполнимость.
//
// Статусы:
//   BLOCKED     — жёсткий блок (независимо от балла)
//   REVIEW      — нужно решение человека (совпадение, правила, качество данных, низкий балл)
//   CANDIDATE   — все проверки пройдены, но исполнимость не подтверждена (theoretical): наличие/цена не перепроверены
//   RECOMMENDED — исполнимо (executable): котировка перепроверена недавно и наличие подтверждено
// Уровень «подтверждено своей сделкой» (verified) присваивается в opportunities по журналу рекомендаций.
import { forecast, solvePrice } from './finance.mjs';
import { trimmedMedian, median } from '../repo/history.mjs';

const clamp = (v) => Math.max(0, Math.min(1, v));
const ageMin = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity);
const CONF = { none: 0.2, low: 0.5, medium: 0.8, high: 1 };

export const STATUS = { RECOMMENDED: 'RECOMMENDED', CANDIDATE: 'CANDIDATE', REVIEW: 'REVIEW', BLOCKED: 'BLOCKED' };

export const LEGACY_MATCH = { status: 'REVIEW_REQUIRED', source: 'rules', reasons: [{ ok: null, text: 'совпадение не проверялось (данные прежней версии) — пересканируйте' }] };

/**
 * @param {object} p
 * @param {object} p.item          { name, category, watchId }
 * @param {object} p.buy           предложение: priceRub, sourceId, url, title, stock, fetchedAt, manual, match, dq[]
 * @param {object} p.market        FunPay: prices[], count, online, sellers, topSellerShare, fetchedAt
 * @param {object} p.settings      getSettings()
 * @param {object} p.saleFee       { pct, fixed, origin, source, assumed }
 * @param {object} p.sourceFee     { pct, fixed, source, assumed }
 * @param {object} [p.health]      healthSummary источника (null для ручных)
 * @param {object} [p.liquidity]   наблюдаемые сигналы рынка + confidence
 * @param {object} [p.ownSales]    { count, medianDays }
 * @param {object} [p.demand]      sellProbability() по товару/категории
 * @param {object} [p.bands]       priceBands() — ценовые диапазоны своих продаж
 * @param {object} [p.learnedLoss] learnedLossPct() — потери на возвратах по своим сделкам
 * @param {object} [p.compliance]  { level, hits }
 * @param {object} [p.capital]     checkLimits() — { blocks, warnings }
 * @param {object} [p.verification] последняя перепроверка связки
 */
export function evaluate(p) {
  const { item, market, settings: S, saleFee, sourceFee, health, liquidity, ownSales, demand, bands, learnedLoss, compliance, capital, verification } = p;
  const buy = p.buy.match ? p.buy : { ...p.buy, match: LEGACY_MATCH };
  const blocks = [];
  const reviews = [];
  const warnings = [];
  const assumptions = [];
  const executionGaps = [];

  // ── 1. сопоставление: неизвестный критичный атрибут — решение человека, а не снижение балла
  const ms = buy.match?.status ?? 'REVIEW_REQUIRED';
  if (ms === 'REJECTED') blocks.push(`товар не совпадает: ${(buy.match.reasons ?? []).filter((r) => r.ok === false).map((r) => r.text).join('; ') || 'отклонено'}`);
  else if (ms === 'REVIEW_REQUIRED') reviews.push(`нужна проверка совпадения: ${(buy.match.reasons ?? []).filter((r) => r.ok === null).map((r) => r.text).join('; ')}`);

  // ── 2. качество данных котировки (HTTP 200 ≠ правильная цена)
  if (buy.dq?.length) reviews.push(`качество данных: ${buy.dq.join('; ')}`);
  if (health?.data?.okShare !== null && health?.data?.okShare !== undefined && health.data.checked >= 20 && health.data.okShare < 0.8)
    warnings.push(`у источника ${Math.round((1 - health.data.okShare) * 100)}% котировок с проблемами данных`);
  if (health?.price?.accuracy !== null && health?.price?.accuracy !== undefined && health.price.attempts >= 3 && health.price.accuracy < 0.95)
    warnings.push(`фактическая цена у источника отличалась от котировки в среднем на ${health.price.medianDeviationPct.toFixed(1)}%`);
  if (health?.stock?.accuracy !== null && health?.stock?.accuracy !== undefined && health.stock.attempts >= 3 && health.stock.accuracy < 0.8)
    warnings.push(`у источника товар часто отсутствовал при покупке (в наличии ${Math.round(health.stock.accuracy * 100)}% попыток)`);

  // ── 3. правила площадки
  for (const h of compliance?.hits ?? []) {
    const t = `п. ${h.clause}: ${h.text}${h.match ? ` («${h.match}»)` : ''}`;
    if (h.level === 'block') blocks.push(t);
    else reviews.push(t);
  }

  // ── 4. свежесть
  const F = S.freshness;
  const srcTtl = buy.manual ? F.manualTtlH * 60 : F.sourceTtlMin;
  const srcAge = ageMin(buy.fetchedAt);
  const fpAge = ageMin(market?.fetchedAt);
  if (srcAge > srcTtl) blocks.push(`цена источника устарела: ${Math.round(srcAge)} мин (допустимо ${srcTtl})`);
  if (market && fpAge > F.funpayTtlMin) blocks.push(`цены FunPay устарели: ${Math.round(fpAge)} мин (допустимо ${F.funpayTtlMin})`);

  // ── 5. наличие
  if (buy.stock === 0) blocks.push('у источника нет в наличии');
  else if ((buy.stock === null || buy.stock === undefined) && S.scoring.requireKnownStock) blocks.push('наличие у источника неизвестно (включена обязательная проверка)');

  // ── 6. рынок FunPay
  const prices = (market?.prices ?? []).filter((x) => x > 0).sort((a, b) => a - b);
  if (!prices.length) blocks.push('на FunPay нет подходящих предложений для сравнения');

  // ── транспорт источника
  if (health?.status === 'circuit_open') blocks.push(`источник отключён после серии ошибок до ${health.circuitOpenUntil}`);
  else if (health && health.calls >= 3 && health.successRate < 0.5) warnings.push(`источник нестабилен: успешно ${Math.round(health.successRate * 100)}% запросов`);

  // ── модель затрат: потери на возвратах — по своим сделкам, если есть
  const m = { ...S.costModel };
  if (learnedLoss && learnedLoss.n > 0) {
    m.disputePct = learnedLoss.pct;
    assumptions.push(`потери на возвратах ${learnedLoss.pct.toFixed(2)}% цены — по ${learnedLoss.n} своим продажам (${learnedLoss.scope}), сглажено к ${learnedLoss.prior}%`);
  } else if (m.disputePct > 0) assumptions.push(`потери на возвратах ${m.disputePct}% — из параметров (своих продаж нет)`);
  if (saleFee.assumed) assumptions.push(`комиссия FunPay ${saleFee.pct}% не подтверждена для раздела (${saleFee.source})`);
  if (sourceFee.assumed) assumptions.push('комиссия при покупке у источника не задана — принята 0');
  // срок продажи: статистика своих продаж (Каплан–Мейер) → медиана своих продаж при достаточном их числе → допущение.
  // одна-две продажи не задают срок: иначе «прибыль в день» завышается многократно
  const ownEnough = (ownSales?.count ?? 0) >= S.demand.minOwnSales && ownSales?.medianDays !== null && ownSales?.medianDays !== undefined;
  const fromDemand = demand?.enough && demand.medianDays !== null;
  const daysToSell = fromDemand ? demand.medianDays : ownEnough ? ownSales.medianDays : S.costModel.expectedDaysToSell;
  if (!fromDemand && !ownEnough) assumptions.push(`срок продажи ${daysToSell} дн. — допущение (своих продаж меньше ${S.demand.minOwnSales})`);
  if (buy.currency && buy.currency !== 'RUB') assumptions.push(`цена в ${buy.currency}, перевод по курсу ЦБ ${buy.fxRate ? buy.fxRate.toFixed(4) : ''}${m.fxSpreadPct ? ` + спред ${m.fxSpreadPct}%` : ' без спреда'}`);

  // ── 7. цены продажи
  const P = S.pricing;
  const undercut = (x) => Math.max(0, Math.round((x * (1 - P.undercutPct / 100) - P.undercutRub) * 100) / 100);
  const base = { buyRub: buy.priceRub, saleFee, sourceFee, m, daysToSell };
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
  // оптимальная цена — только из своих продаж по ценовым диапазонам
  let optimal = null;
  if (bands?.best && min) {
    const price = Math.round(min * (1 + bands.best.mid) * 100) / 100;
    optimal = { price, band: bands.best.label, forecast: fc(price) };
  }
  const decisionScenario = scenarios[0] ?? null; // решение — по самой консервативной цене
  const f = decisionScenario?.forecast ?? null;

  // ── 8. прибыль
  if (f && f.net <= 0) blocks.push(`отрицательная чистая прибыль: ${f.net.toFixed(2)} ₽ при цене ${decisionScenario.price} ₽`);

  // ── 9. капитал и риск
  for (const b of capital?.blocks ?? []) blocks.push(b);
  for (const w of capital?.warnings ?? []) warnings.push(w);

  // ── подозрительно дёшево
  if (min && S.scoring.suspiciousPct > 0 && buy.priceRub < (min * S.scoring.suspiciousPct) / 100 && buy.match?.source !== 'manual') {
    reviews.push(`закупка дешевле ${S.scoring.suspiciousPct}% от цены FunPay — скорее всего не тот товар`);
  }

  // ── предупреждения
  if (buy.sourceId?.startsWith('cs-')) warnings.push('цена региона США (CheapShark) — проверьте регион активации');
  if (item.category === 'skins') warnings.push('трейд-холд/защита сделок Steam: предмет и деньги могут быть заморожены до 7 дней');
  if (market && market.count < P.minCompetitors) warnings.push(`мало конкурентов (${market.count}) — их цена не доказывает спрос`);
  if (market && market.online === 0) warnings.push('ни одного продавца онлайн');

  // ── 10. ликвидность: собственные продажи — основной сигнал; косвенные — с поправкой на уверенность
  const lq = liquidity?.observed;
  const D = S.demand;
  let liqScore;
  let liqBasis;
  if (demand?.enough) {
    liqScore = demand.probs[7].p;
    liqBasis = `вероятность продажи за 7 дн. по своим продажам: ${Math.round(demand.probs[7].p * 100)}% (${Math.round(demand.probs[7].lo * 100)}–${Math.round(demand.probs[7].hi * 100)}%)`;
  } else if (lq) {
    const enoughObs = lq.snapshots >= D.minSnapshots && lq.observationDays * 24 >= D.minObservationHours;
    const raw = 0.6 * clamp(Math.log10((lq.activeLots ?? 0) + 1) / Math.log10(21)) + 0.4 * clamp((lq.disappearPerLotDay ?? 0) / 0.5);
    liqScore = Math.min(enoughObs ? 1 : 0.3, raw * (CONF[liquidity.confidence] ?? 0.2));
    liqBasis = `наблюдаемый сигнал (не продажи), уверенность ${liquidity.confidence}`;
    if (!enoughObs) warnings.push(`мало наблюдений рынка (${lq.snapshots} снимков за ${(lq.observationDays * 24).toFixed(0)} ч) — ликвидность не оценена`);
  } else {
    liqScore = market ? 0.3 * clamp(Math.log10(market.count + 1) / Math.log10(21)) : 0;
    liqBasis = 'только число лотов — истории наблюдений нет';
  }

  // ── 11. балл
  const W = S.scoring.weights;
  const components = {
    match: ms === 'VERIFIED' ? (buy.match.source === 'manual' ? 1 : 0.9) : ms === 'REVIEW_REQUIRED' ? 0.4 : 0,
    margin: f ? clamp(f.netPct / 30) : 0,
    liquidity: liqScore,
    reliability: health?.calls ? health.reliability * (health?.price?.accuracy ?? 1) * (health?.stock?.accuracy ?? 1) : 0.5,
    competition: market ? clamp((market.topSellerShare === null || market.topSellerShare === undefined ? 0.5 : 1 - market.topSellerShare) * (market.count >= P.minCompetitors ? 1 : 0.5)) : 0,
    freshness: clamp(1 - Math.max(srcAge / srcTtl, market ? fpAge / F.funpayTtlMin : 1)),
    risk: clamp(1 - 0.2 * warnings.length - 0.1 * assumptions.length),
    availability: buy.stock > 0 ? 1 : buy.stock === 0 ? 0 : 0.5,
  };
  const wsum = Object.values(W).reduce((a, x) => a + x, 0) || 1;
  const score = (Object.entries(components).reduce((a, [k, v]) => a + (W[k] ?? 0) * v, 0) / wsum) * 100;

  // ── 12. исполнимость (Profit Verification)
  const V = S.verification;
  const vAge = verification ? ageMin(verification.ts) : Infinity;
  const verifiedRecently = verification?.ok && vAge <= V.executableTtlMin;
  const stockConfirmed = (verification && (verification.stock > 0 || verification.user_confirmed_stock)) || (buy.stock > 0 && !buy.manual && srcAge <= V.executableTtlMin);
  const priceConfirmed = verifiedRecently || (!buy.manual && srcAge <= V.executableTtlMin);
  if (!priceConfirmed) executionGaps.push(`цена не перепроверена за последние ${V.executableTtlMin} мин`);
  if (!stockConfirmed) executionGaps.push('наличие у источника не подтверждено');
  if (verification && !verification.ok && vAge <= V.executableTtlMin) blocks.push(`перепроверка не прошла: ${verification.detail ?? 'котировка изменилась'}`);

  let status = blocks.length ? STATUS.BLOCKED : reviews.length ? STATUS.REVIEW : STATUS.CANDIDATE;
  if (status === STATUS.CANDIDATE && score < S.scoring.minScore) {
    status = STATUS.REVIEW;
    reviews.push(`балл ${score.toFixed(0)} ниже порога ${S.scoring.minScore}`);
  }
  if (status === STATUS.CANDIDATE && !executionGaps.length) status = STATUS.RECOMMENDED;

  return {
    status,
    verification: status === STATUS.RECOMMENDED ? 'executable' : 'theoretical',
    executionGaps,
    score,
    components,
    liquidityBasis: liqBasis,
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
      optimal,
      optimalNote: optimal ? `диапазон «${optimal.band}» дал лучшую прибыль в день по вашим продажам` : (bands?.note ?? 'нет своих продаж для оценки оптимальной цены'),
    },
    forecast: f,
    /** ожидаемая прибыль в день оборота — главный критерий ранжирования (не % маржи) */
    netPerDay: f ? f.net / Math.max(0.5, daysToSell) : null,
    sellProb7: demand?.enough ? demand.probs[7] : null,
    model: m,
    ages: { sourceMin: srcAge, funpayMin: fpAge, verificationMin: vAge },
    daysToSell,
  };
}
