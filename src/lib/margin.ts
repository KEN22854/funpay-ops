import * as F from '../../shared/finance.mjs';
import type { ForecastArgs, LossSpec } from '../../shared/finance.mjs';
/**
 * Формула чистой маржи продавца FunPay:
 *   Маржа = P × (1 − X%) × (1 − Y%) − C − R − T
 *
 * X и Y ПЕРЕМНОЖАЮТСЯ: комиссия площадки берётся с суммы заказа,
 * комиссия вывода — с остатка после неё. Складывать проценты — ошибка.
 *
 * Все варианты R линейны по P, поэтому маржа всегда имеет вид
 *   net(P) = a × P − b
 * Это даёт точный обратный расчёт: минимальная цена, цена под целевую маржу.
 */

/**
 * rub     — R задан в ₽ на заказ (средняя потеря);
 * percent — R задан в % от P;
 * rate    — R = доля спорных заказов × доля возврата × выплата
 *           (при проигранном споре деньги возвращаются покупателю, а закупка C уже потрачена).
 */
export type DisputeMode = 'rub' | 'percent' | 'rate';

export interface MarginInput {
  /** P — цена лота, ₽ (что платит покупатель) */
  price: number;
  /** X — комиссия площадки, % */
  platformFeePct: number;
  /** Y — эффективная стоимость вывода, % */
  withdrawFeePct: number;
  /** C — закупочная цена, ₽ */
  cost: number;
  /** R: ₽ | % от P | доля спорных заказов, % — в зависимости от disputeMode */
  disputeValue: number;
  disputeMode: DisputeMode;
  /** для режима rate: какая часть выплаты теряется в споре, % (100 = полный возврат) */
  disputeRefundPct: number;
  /** T — минуты на обработку одного заказа */
  minutesPerOrder: number;
  /** T — ставка часа, ₽ */
  hourlyRate: number;
  /** Стартовые вложения для расчёта безубыточности, ₽ */
  investment: number;
  /** Цель для обратного расчёта: маржа в % от цены */
  targetMarginPct: number;
  /** Цель для обратного расчёта: маржа в ₽ на заказ */
  targetMarginRub: number;
  /** Цель по прибыли в месяц, ₽ */
  monthlyGoal: number;
}

export interface MarginResult {
  price: number;
  platformFee: number;
  afterPlatform: number;
  withdrawFee: number;
  payout: number;
  cost: number;
  disputeLoss: number;
  timeCost: number;
  net: number;
  /** чистая маржа в % от цены лота */
  netPct: number;
  /** доходность на закупку, % (null, если C = 0) */
  roiPct: number | null;
  /** заказов до окупаемости вложений (null — не окупится или вложений нет) */
  breakEvenOrders: number | null;
  /** заказов в месяц для цели по прибыли (null — цели нет или маржа ≤ 0) */
  ordersForMonthlyGoal: number | null;
  /** что получилось бы при ошибочном сложении X + Y */
  netIfAdded: number;
  /** на сколько ₽ ошибочное сложение искажает результат */
  additionError: number;
}

export type Verdict = 'good' | 'warn' | 'bad';

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pos = (v: unknown) => Math.max(0, num(v));
/** проценты комиссий ограничены [0; 100) — 100 % и выше делают продажу бессмысленной */
const share = (pct: unknown) => Math.min(pos(pct), 100) / 100;

/** Округление до копеек, без артефактов вида 0.1 + 0.2 */
export const kop = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Множитель «доля цены, которая доходит до продавца»: (1 − X)(1 − Y) — из единого движка */
export function payoutFactor(platformFeePct: number, withdrawFeePct: number): number {
  return F.payoutFactor(platformFeePct, withdrawFeePct);
}

export function timeCost(minutes: number, hourlyRate: number): number {
  return (pos(minutes) / 60) * pos(hourlyRate);
}

const lossSpec = (i: MarginInput): LossSpec =>
  i.disputeMode === 'rub'
    ? { mode: 'rub', value: i.disputeValue }
    : i.disputeMode === 'rate'
      ? { mode: 'rate', value: i.disputeValue, refundPct: i.disputeRefundPct ?? 100 }
      : { mode: 'pct', value: i.disputeValue };

/** Аргументы единого движка из полей калькулятора (без налога, курса и капитала — их калькулятор не задаёт) */
export function toForecastArgs(i: MarginInput): ForecastArgs {
  return {
    buyRub: pos(i.cost),
    saleFee: { pct: i.platformFeePct },
    sourceFee: { pct: 0 },
    m: {
      feeModel: 'deduct',
      withdrawPct: i.withdrawFeePct,
      minutesPerOrder: i.minutesPerOrder,
      hourlyRate: i.hourlyRate,
      losses: lossSpec(i),
    },
  };
}

export function disputeLossOf(i: MarginInput, price: number): number {
  const P = pos(price);
  return F.lossesOf(lossSpec(i), P, P * payoutFactor(i.platformFeePct, i.withdrawFeePct));
}

export function calcMargin(i: MarginInput): MarginResult {
  const P = pos(i.price);
  const f = F.forecast({ ...toForecastArgs(i), sellPrice: P });
  const X = share(i.platformFeePct);
  const Y = share(i.withdrawFeePct);
  // справочно: что получилось бы при ОШИБОЧНОМ сложении X + Y (единый движок такой ошибки не допускает)
  const wrongPayout = P * Math.max(0, 1 - X - Y);
  const wrongR = i.disputeMode === 'rate' ? wrongPayout * share(i.disputeValue) * share(i.disputeRefundPct ?? 100) : f.losses;
  const netIfAdded = wrongPayout - f.purchase - wrongR - f.fulfillment;
  const investment = pos(i.investment);
  const goal = pos(i.monthlyGoal);
  return {
    price: P,
    platformFee: f.platformFee,
    afterPlatform: P - f.platformFee,
    withdrawFee: f.withdrawFee,
    payout: f.payout,
    cost: f.purchase,
    disputeLoss: f.losses,
    timeCost: f.fulfillment,
    net: f.net,
    netPct: f.netPct,
    roiPct: f.roiPct,
    breakEvenOrders: investment > 0 && f.net > 0 ? Math.ceil(investment / f.net - 1e-9) : null,
    ordersForMonthlyGoal: goal > 0 && f.net > 0 ? Math.ceil(goal / f.net - 1e-9) : null,
    netIfAdded,
    additionError: f.net - netIfAdded,
  };
}

/**
 * Обратный расчёт. Возвращает цену P (с округлением ВВЕРХ до копейки,
 * чтобы цель гарантированно выполнялась) или null, если цель недостижима
 * при данных комиссиях и доле споров.
 */
export interface PriceTargets {
  /** минимальная цена, при которой маржа = 0 */
  breakEvenPrice: number | null;
  /** цена для маржи targetMarginRub ₽ на заказ */
  priceForRub: number | null;
  /** цена для маржи targetMarginPct % от цены */
  priceForPct: number | null;
  /** максимальная маржа в % от цены, достижимая при любой цене (предел при P → ∞) */
  maxPossiblePct: number;
}

export function priceTargets(i: MarginInput): PriceTargets {
  const args = toForecastArgs(i);
  const tRub = pos(i.targetMarginRub);
  const maxPossiblePct = F.maxMarginPct(args);
  return {
    breakEvenPrice: maxPossiblePct > 0 ? F.solvePrice(args, 0) : null,
    priceForRub: tRub > 0 && maxPossiblePct > 0 ? F.solvePrice(args, tRub) : null,
    priceForPct: i.targetMarginPct > 0 && maxPossiblePct > pos(i.targetMarginPct) ? F.solvePrice(args, 0, i.targetMarginPct) : null,
    maxPossiblePct,
  };
}

/** Вердикт: красный — маржа ≤ 0; жёлтый — ниже порога пользователя; зелёный — от порога и выше. */
export function verdictOf(netPct: number, net: number, warnThresholdPct: number): Verdict {
  if (net <= 0) return 'bad';
  if (netPct < warnThresholdPct) return 'warn';
  return 'good';
}

/** Эффективная комиссия вывода: Y_eff = 1 − (S × (1 − p) − F) / S — из единого движка */
export function effectiveWithdrawPct(amount: number, pct: number, fixed: number): number | null {
  return F.effectiveWithdrawPct(amount, pct, fixed);
}

/* ───────────────────────── Журнал ───────────────────────── */

/**
 * none    — спора не было;
 * won     — спор решён в пользу продавца (деньги получены);
 * refund  — полный возврат покупателю: выплаты нет, закупка потрачена;
 * partial — частичный возврат: продавец указывает сумму потери в ₽.
 */
export type DisputeOutcome = 'none' | 'won' | 'refund' | 'partial';

export interface DealLike {
  sell: number;
  buy: number;
  feePct: number;
  withdrawPct: number;
  outcome: DisputeOutcome;
  /** для partial — потеря в ₽ */
  disputeLoss: number;
  /** штук в сделке (по умолчанию 1): sell и buy — за всю сделку */
  qty?: number;
}

/** Выплата, если бы сделка прошла без спора */
export function dealPayout(d: DealLike): number {
  return pos(d.sell) * payoutFactor(d.feePct, d.withdrawPct);
}

/** Итог сделки — тем же движком, что продажи на складе (без T: время в журнал не вносится). */
export function dealResult(d: DealLike): number {
  const payout = dealPayout(d);
  const refund = d.outcome === 'refund' ? payout : d.outcome === 'partial' ? pos(d.disputeLoss) : 0;
  return F.saleResult({ unitPrice: pos(d.sell), saleFeePct: d.feePct, withdrawPct: d.withdrawPct, cogs: pos(d.buy), refund }).net;
}

/** Потеря из-за спора относительно сделки без спора, ₽ (≥ 0) */
export function dealDisputeLoss(d: DealLike): number {
  return Math.max(0, dealPayout(d) - pos(d.buy) - dealResult(d));
}

export const isDisputed = (o: DisputeOutcome) => o !== 'none';
export const isLost = (o: DisputeOutcome) => o === 'refund' || o === 'partial';

export interface ItemStats {
  item: string;
  count: number;
  qty: number;
  revenue: number;
  cost: number;
  net: number;
  disputes: number;
  lost: number;
  disputeLossTotal: number;
  avgSell: number;
  avgBuy: number;
  avgFeePct: number;
  avgWithdrawPct: number;
  /** реальная средняя потеря на спорах на одну сделку — это и есть R */
  avgDisputeLoss: number;
  avgNet: number;
  netPct: number;
}

export function itemStats<T extends DealLike & { item: string }>(deals: T[]): ItemStats[] {
  const m = new Map<string, T[]>();
  for (const d of deals) {
    const key = d.item.trim() || '(без названия)';
    const arr = m.get(key);
    if (arr) arr.push(d);
    else m.set(key, [d]);
  }
  return [...m.entries()]
    .map(([item, list]) => {
      const count = list.length;
      const sum = (f: (d: T) => number) => list.reduce((s, d) => s + f(d), 0);
      const revenue = sum((d) => pos(d.sell));
      const net = sum(dealResult);
      const disputeLossTotal = sum(dealDisputeLoss);
      return {
        item,
        count,
        qty: sum((d) => Math.max(1, Math.floor(num(d.qty) || 1))),
        revenue,
        cost: sum((d) => pos(d.buy)),
        net,
        disputes: list.filter((d) => isDisputed(d.outcome)).length,
        lost: list.filter((d) => isLost(d.outcome)).length,
        disputeLossTotal,
        avgSell: revenue / count,
        avgBuy: sum((d) => pos(d.buy)) / count,
        avgFeePct: sum((d) => num(d.feePct)) / count,
        avgWithdrawPct: sum((d) => num(d.withdrawPct)) / count,
        avgDisputeLoss: disputeLossTotal / count,
        avgNet: net / count,
        netPct: revenue > 0 ? (net / revenue) * 100 : 0,
      };
    })
    .sort((a, b) => a.net - b.net);
}
