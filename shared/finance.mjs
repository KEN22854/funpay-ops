// ЕДИНЫЙ финансовый движок FunPay Ops — один источник истины для калькулятора, журнала,
// сканера, склада и бэктеста. Сервер и интерфейс импортируют этот файл; дублировать формулы запрещено.
//
//   выплата   = P − комиссия FunPay − вывод
//   прибыль   = выплата − закупка(×(1+спред)) − комиссия покупки − исполнение − потери − капитал − налог
//
// Все суммы — в рублях за 1 единицу. Внутри нет округлений: округляет только интерфейс.

export const ENGINE_VERSION = '2.2.0';
const MAX_PRICE = 1e8;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);
const pos = (v) => Math.max(0, num(v));
/** процент → доля, ограничено [0; 0.9999]: 100 % и выше делают продажу бессмысленной */
const share = (pct) => Math.min(pos(pct), 99.99) / 100;

/** Комиссия FunPay: deduct — из цены (P×X); addon — сверху (продавец получает P/(1+X)) */
export function platformFee(price, feePct, feeModel = 'deduct') {
  const P = pos(price);
  const x = share(feePct);
  return feeModel === 'addon' ? P - P / (1 + x) : P * x;
}

/** Доля цены, доходящая до продавца после комиссии и вывода: (1 − X)(1 − Y) для модели deduct */
export function payoutFactor(feePct, withdrawPct, feeModel = 'deduct') {
  return feeModel === 'addon' ? (1 / (1 + share(feePct))) * (1 - share(withdrawPct)) : (1 - share(feePct)) * (1 - share(withdrawPct));
}

/**
 * Потери на спорах и возвратах на 1 шт.
 * pct  — % от цены лота;
 * rub  — фиксированная сумма на заказ;
 * rate — доля проигранных споров × доля возврата × выплата (закупка уже потрачена и учтена отдельно).
 */
export function lossesOf(losses, price, payout) {
  const l = losses ?? { mode: 'pct', value: 0 };
  switch (l.mode) {
    case 'rub':
      return pos(l.value);
    case 'rate':
      return pos(payout) * share(l.value) * share(l.refundPct ?? 100);
    default:
      return pos(price) * share(l.value);
  }
}

/**
 * Прогноз на 1 шт.
 * @param {object} p
 * @param {number} p.sellPrice   цена лота P
 * @param {number} p.buyRub      закупка в ₽ по курсу (без спреда)
 * @param {{pct:number, fixed?:number}} [p.saleFee]
 * @param {{pct:number, fixed?:number}} [p.sourceFee]
 * @param {object} p.m           модель: feeModel, withdrawPct, fxSpreadPct, taxPct, taxBase, minutesPerOrder, hourlyRate, extraFulfillmentRub, capitalRatePct, losses | disputePct
 * @param {number} [p.daysToSell]
 */
export function forecast({ sellPrice, buyRub, saleFee = { pct: 0 }, sourceFee = { pct: 0 }, m = {}, daysToSell = 0 }) {
  const P = pos(sellPrice);
  const feeModel = m.feeModel === 'addon' ? 'addon' : 'deduct';
  const fee = platformFee(P, saleFee.pct, feeModel) + pos(saleFee.fixed);
  const afterFee = Math.max(0, P - fee);
  const withdraw = afterFee * share(m.withdrawPct);
  const payout = afterFee - withdraw;
  const purchase = pos(buyRub) * (1 + share(m.fxSpreadPct));
  const payment = purchase * share(sourceFee.pct) + pos(sourceFee.fixed);
  const fulfillment = (pos(m.minutesPerOrder) / 60) * pos(m.hourlyRate) + pos(m.extraFulfillmentRub);
  const lossSpec = m.losses ?? { mode: 'pct', value: m.disputePct };
  const losses = lossesOf(lossSpec, P, payout);
  const days = pos(daysToSell);
  const capital = (purchase + payment) * (pos(m.capitalRatePct) / 100) * (days / 365);
  const preTax = payout - purchase - payment - fulfillment - losses - capital;
  const tax = m.taxBase === 'profit' ? Math.max(0, preTax) * share(m.taxPct) : payout * share(m.taxPct);
  const net = preTax - tax;
  const invested = purchase + payment;
  const lossLabel = lossSpec.mode === 'rub' ? `${pos(lossSpec.value)} ₽ на заказ` : lossSpec.mode === 'rate' ? `${pos(lossSpec.value)}% споров × ${pos(lossSpec.refundPct ?? 100)}% выплаты` : `${pos(lossSpec.value)}% цены`;
  return {
    price: P,
    lines: [
      { key: 'revenue', label: 'Цена лота', amount: P },
      { key: 'platform', label: `Комиссия FunPay ${pos(saleFee.pct)}%${feeModel === 'addon' ? ' (сверху)' : ''}${pos(saleFee.fixed) ? ` + ${pos(saleFee.fixed)} ₽` : ''}`, amount: -fee },
      { key: 'withdraw', label: `Вывод ${pos(m.withdrawPct)}%`, amount: -withdraw },
      { key: 'purchase', label: `Закупка${pos(m.fxSpreadPct) ? ` (+${pos(m.fxSpreadPct)}% курс)` : ''}`, amount: -purchase },
      { key: 'payment', label: `Комиссия при покупке ${pos(sourceFee.pct)}%${pos(sourceFee.fixed) ? ` + ${pos(sourceFee.fixed)} ₽` : ''}`, amount: -payment },
      { key: 'fulfillment', label: 'Исполнение (время и расходы)', amount: -fulfillment },
      { key: 'losses', label: `Споры и возвраты (${lossLabel})`, amount: -losses },
      { key: 'capital', label: `Заморозка денег ${pos(m.capitalRatePct)}% год. × ${days} дн.`, amount: -capital },
      { key: 'tax', label: `Налог ${pos(m.taxPct)}% (${m.taxBase === 'profit' ? 'с прибыли' : 'с выплаты'})`, amount: -tax },
    ],
    platformFee: fee,
    withdrawFee: withdraw,
    payout,
    purchase,
    payment,
    fulfillment,
    losses,
    capital,
    tax,
    invested,
    net,
    netPct: P > 0 ? (net / P) * 100 : 0,
    /** ROI = чистая прибыль / деньги, вложенные в единицу (закупка с курсом + комиссия покупки) */
    roiPct: invested > 0 ? (net / invested) * 100 : null,
  };
}

/**
 * Минимальная цена P (вверх до копейки), при которой net(P) ≥ target + pctOfPrice% × P.
 * net(P) монотонна по P, поэтому бинарный поиск точен. null — цель недостижима.
 */
export function solvePrice(args, target = 0, pctOfPrice = 0) {
  const k = share(pctOfPrice);
  const g = (P) => forecast({ ...args, sellPrice: P }).net - k * P - target;
  let lo = 0;
  let hi = Math.max(100, pos(args.buyRub) * 4 + pos(target) + 100);
  // потолок цены: дороже 100 млн ₽ за единицу — заведомо нереалистично, считаем цель недостижимой
  while (hi < MAX_PRICE && g(hi) < 0) hi = Math.min(MAX_PRICE, hi * 2);
  if (g(hi) < 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) >= 0) hi = mid;
    else lo = mid;
  }
  let p = Math.ceil(hi * 100 - 1e-7) / 100;
  for (let i = 0; i < 5 && g(p) < 0; i++) p = Math.round((p + 0.01) * 100) / 100;
  // на копейку ниже цель не выполняется — так гарантируется минимальность
  return p;
}

/** Предельная маржа в % от цены при P → ∞ (наклон net(P)) */
export function maxMarginPct(args) {
  const a = forecast({ ...args, sellPrice: 2e7 }).net;
  const b = forecast({ ...args, sellPrice: 1e7 }).net;
  return Math.max(0, ((a - b) / 1e7) * 100);
}

/**
 * Фактический результат продажи (суммы — за всю продажу).
 * refund — сколько вернули покупателю из полученной выплаты.
 */
export function saleResult({ qty = 1, unitPrice, saleFeePct, saleFeeFixed = 0, feeModel = 'deduct', withdrawPct = 0, cogs = 0, fulfillment = 0, refund = 0, taxPct = 0, taxBase = 'payout' }) {
  const revenue = pos(qty) * pos(unitPrice);
  const fee = platformFee(revenue, saleFeePct, feeModel) + pos(saleFeeFixed);
  const afterFee = Math.max(0, revenue - fee);
  const withdraw = afterFee * share(withdrawPct);
  const payout = afterFee - withdraw;
  const kept = Math.max(0, payout - pos(refund));
  const preTax = kept - pos(cogs) - pos(fulfillment);
  const tax = taxBase === 'profit' ? Math.max(0, preTax) * share(taxPct) : kept * share(taxPct);
  return { revenue, platformFee: fee, withdrawFee: withdraw, payout, kept, tax, net: preTax - tax };
}

/** Эффективная комиссия вывода с фиксированной платой: Y = 1 − (S(1 − p) − F) / S */
export function effectiveWithdrawPct(amount, pct, fixed) {
  const S = pos(amount);
  if (S <= 0) return null;
  const received = S * (1 - share(pct)) - pos(fixed);
  return Math.min(100, Math.max(0, (1 - received / S) * 100));
}
