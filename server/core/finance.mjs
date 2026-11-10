// Финансовая модель: прогноз по одной единице и фактический результат продажи.
// Детерминированный код, без округлений внутри — округляет только интерфейс.

const pos = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const pct = (v) => Math.min(pos(v), 99.99) / 100;

/** Комиссия FunPay с цены лота по выбранной модели */
export function platformFee(price, feePct, feeModel = 'deduct') {
  const P = pos(price);
  const x = pct(feePct);
  return feeModel === 'addon' ? P - P / (1 + x) : P * x;
}

/**
 * Прогноз чистой прибыли на 1 шт.
 * @param {object} p
 * @param {number} p.sellPrice        цена лота на FunPay (что платит покупатель)
 * @param {number} p.buyRub           цена закупки у источника в ₽ по курсу ЦБ
 * @param {{pct:number, fixed:number}} p.saleFee     комиссия FunPay
 * @param {{pct:number, fixed:number}} p.sourceFee   комиссия при покупке
 * @param {object} p.m                settings.costModel
 * @param {number} p.daysToSell       ожидаемый срок продажи
 */
export function forecast({ sellPrice, buyRub, saleFee, sourceFee, m, daysToSell }) {
  const P = pos(sellPrice);
  const fee = platformFee(P, saleFee.pct, m.feeModel) + pos(saleFee.fixed);
  const afterFee = Math.max(0, P - fee);
  const withdraw = afterFee * pct(m.withdrawPct);
  const payout = afterFee - withdraw;
  const purchase = pos(buyRub) * (1 + pct(m.fxSpreadPct));
  const payment = purchase * pct(sourceFee.pct) + pos(sourceFee.fixed);
  const fulfillment = (pos(m.minutesPerOrder) / 60) * pos(m.hourlyRate) + pos(m.extraFulfillmentRub);
  const losses = P * pct(m.disputePct);
  const days = pos(daysToSell);
  const capital = (purchase + payment) * (pos(m.capitalRatePct) / 100) * (days / 365);
  const preTax = payout - purchase - payment - fulfillment - losses - capital;
  const tax = m.taxBase === 'profit' ? Math.max(0, preTax) * pct(m.taxPct) : payout * pct(m.taxPct);
  const net = preTax - tax;
  const invested = purchase + payment;
  return {
    price: P,
    lines: [
      { key: 'revenue', label: 'Цена лота', amount: P },
      { key: 'platform', label: `Комиссия FunPay ${saleFee.pct}%${m.feeModel === 'addon' ? ' (сверху)' : ''}`, amount: -fee },
      { key: 'withdraw', label: `Вывод ${m.withdrawPct}%`, amount: -withdraw },
      { key: 'purchase', label: `Закупка${m.fxSpreadPct ? ` (+${m.fxSpreadPct}% курс)` : ''}`, amount: -purchase },
      { key: 'payment', label: `Комиссия при покупке ${sourceFee.pct}%${sourceFee.fixed ? ` + ${sourceFee.fixed} ₽` : ''}`, amount: -payment },
      { key: 'fulfillment', label: 'Исполнение (время и расходы)', amount: -fulfillment },
      { key: 'losses', label: `Споры и возвраты ${m.disputePct}%`, amount: -losses },
      { key: 'capital', label: `Заморозка денег ${m.capitalRatePct}% год. × ${days} дн.`, amount: -capital },
      { key: 'tax', label: `Налог ${m.taxPct}% (${m.taxBase === 'profit' ? 'с прибыли' : 'с выплаты'})`, amount: -tax },
    ],
    payout,
    invested,
    net,
    netPct: P > 0 ? (net / P) * 100 : 0,
    /** ROI = чистая прибыль / деньги, вложенные в эту единицу (закупка + комиссия покупки) */
    roiPct: invested > 0 ? (net / invested) * 100 : null,
  };
}

/**
 * Минимальная цена, дающая net ≥ target. net(P) монотонно растёт (если комиссии < 100%),
 * поэтому бинарный поиск точен; цена округляется вверх до копейки.
 */
export function solvePrice(args, target = 0) {
  const f = (P) => forecast({ ...args, sellPrice: P }).net;
  let lo = 0;
  let hi = Math.max(100, pos(args.buyRub) * 4 + 100);
  for (let i = 0; i < 40 && f(hi) < target; i++) hi *= 2;
  if (f(hi) < target) return null; // недостижимо (например, суммарные % ≥ 100)
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= target) hi = mid;
    else lo = mid;
  }
  let p = Math.ceil(hi * 100) / 100;
  while (f(p) < target) p = Math.round((p + 0.01) * 100) / 100;
  return p;
}

/** Фактический результат продажи (все суммы — за всю продажу). */
export function saleResult({ qty, unitPrice, saleFeePct, saleFeeFixed = 0, feeModel = 'deduct', withdrawPct, cogs, fulfillment = 0, refund = 0, taxPct = 0, taxBase = 'payout' }) {
  const revenue = pos(qty) * pos(unitPrice);
  const fee = platformFee(revenue, saleFeePct, feeModel) + pos(saleFeeFixed);
  const afterFee = Math.max(0, revenue - fee);
  const withdraw = afterFee * pct(withdrawPct);
  const payout = afterFee - withdraw;
  const kept = Math.max(0, payout - pos(refund));
  const preTax = kept - pos(cogs) - pos(fulfillment);
  const tax = taxBase === 'profit' ? Math.max(0, preTax) * pct(taxPct) : kept * pct(taxPct);
  return { revenue, platformFee: fee, withdrawFee: withdraw, payout, tax, net: preTax - tax };
}
