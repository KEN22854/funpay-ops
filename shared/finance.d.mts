// Типы для shared/finance.mjs (единый финансовый движок)

export const ENGINE_VERSION: string;

export type FeeModel = 'deduct' | 'addon';
export type LossSpec = { mode: 'pct' | 'rub' | 'rate'; value: number; refundPct?: number };

export interface CostModel {
  feeModel?: FeeModel;
  withdrawPct?: number;
  fxSpreadPct?: number;
  taxPct?: number;
  taxBase?: 'payout' | 'profit';
  minutesPerOrder?: number;
  hourlyRate?: number;
  extraFulfillmentRub?: number;
  capitalRatePct?: number;
  disputePct?: number;
  losses?: LossSpec;
}

export interface Fee {
  pct: number;
  fixed?: number;
}

export interface ForecastArgs {
  sellPrice?: number;
  buyRub: number;
  saleFee?: Fee;
  sourceFee?: Fee;
  m?: CostModel;
  daysToSell?: number;
}

export interface ForecastLine {
  key: string;
  label: string;
  amount: number;
}

export interface Forecast {
  price: number;
  lines: ForecastLine[];
  platformFee: number;
  withdrawFee: number;
  payout: number;
  purchase: number;
  payment: number;
  fulfillment: number;
  losses: number;
  capital: number;
  tax: number;
  invested: number;
  net: number;
  netPct: number;
  roiPct: number | null;
}

export function platformFee(price: number, feePct: number, feeModel?: FeeModel): number;
export function payoutFactor(feePct: number, withdrawPct: number, feeModel?: FeeModel): number;
export function lossesOf(losses: LossSpec | undefined, price: number, payout: number): number;
export function forecast(args: ForecastArgs & { sellPrice: number }): Forecast;
export function solvePrice(args: ForecastArgs, target?: number, pctOfPrice?: number): number | null;
export function maxMarginPct(args: ForecastArgs): number;
export function saleResult(args: {
  qty?: number;
  unitPrice: number;
  saleFeePct: number;
  saleFeeFixed?: number;
  feeModel?: FeeModel;
  withdrawPct?: number;
  cogs?: number;
  fulfillment?: number;
  refund?: number;
  taxPct?: number;
  taxBase?: 'payout' | 'profit';
}): { revenue: number; platformFee: number; withdrawFee: number; payout: number; kept: number; tax: number; net: number };
export function effectiveWithdrawPct(amount: number, pct: number, fixed: number): number | null;
