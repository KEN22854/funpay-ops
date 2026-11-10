// Расчёт выгоды связки «купить в источнике → продать на FunPay».
// Используется та же формула, что и в калькуляторе: P × (1 − X) × (1 − Y) − C − R − T.
import type { Category, Discovery, FunpaySummary, Offer, ScanResult, Watch } from './api';
import { calcMargin, type MarginResult } from './margin';

export interface ArbSettings {
  /** подрезка цены относительно самого дешёвого конкурента на FunPay */
  undercutPct: number;
  undercutRub: number;
  /** X — комиссия FunPay в разделе продажи, % */
  sellFeePct: number;
  /** Y — эффективная комиссия вывода, % */
  withdrawPct: number;
  /** R — средняя потеря на спорах, % от цены продажи */
  disputePct: number;
  /** T */
  minutesPerOrder: number;
  hourlyRate: number;
  /** комиссия при покупке у источника (платёжка, конвертация), % — по id источника */
  sourceFees: Record<string, number>;
  /** ниже этого числа конкурентов — пометка «мало предложений» */
  minCompetitors: number;
  /** ручная цена старше N часов — пометка «устарела» */
  manualMaxAgeH: number;
  /** закупка дешевле этого % от цены FunPay — «подозрительно дёшево»: почти всегда не тот товар (аккаунт, аренда, набор) */
  suspiciousPct: number;
}

export const DEFAULT_ARB: ArbSettings = {
  undercutPct: 0,
  undercutRub: 1,
  sellFeePct: 5,
  withdrawPct: 0,
  disputePct: 0,
  minutesPerOrder: 0,
  hourlyRate: 0,
  sourceFees: {},
  minCompetitors: 3,
  manualMaxAgeH: 24,
  suspiciousPct: 25,
};

export interface Opportunity {
  key: string;
  kind: 'watch' | 'discovery';
  watchId?: string;
  name: string;
  category: Category;
  buy: Offer;
  /** закупка с комиссией источника */
  cost: number;
  sourceFeePct: number;
  fpMin: number;
  fpCount: number;
  fpOnline: number;
  fpUrl: string;
  /** цена, которую мы ставим на FunPay */
  sellPrice: number;
  pricePer: number;
  margin: MarginResult;
  /** закупка подозрительно дешевле цены FunPay */
  suspicious: boolean;
  warnings: string[];
  scannedAt: string;
}

/** Наша цена: ниже минимальной у конкурентов на подрезку, но не ниже нуля. */
export function sellPriceFor(fpMin: number, s: ArbSettings): number {
  const p = fpMin * (1 - Math.max(0, s.undercutPct) / 100) - Math.max(0, s.undercutRub);
  return Math.max(0, Math.round(p * 100) / 100);
}

export function evaluate(buy: Offer, fp: { min: number; count: number; online: number }, s: ArbSettings) {
  const sourceFeePct = Math.max(0, s.sourceFees[buy.sourceId] ?? 0);
  const cost = buy.priceRub * (1 + sourceFeePct / 100);
  const sellPrice = sellPriceFor(fp.min, s);
  const margin = calcMargin({
    price: sellPrice,
    platformFeePct: s.sellFeePct,
    withdrawFeePct: s.withdrawPct,
    cost,
    disputeValue: s.disputePct,
    disputeMode: 'percent',
    disputeRefundPct: 100,
    minutesPerOrder: s.minutesPerOrder,
    hourlyRate: s.hourlyRate,
    investment: 0,
    targetMarginPct: 0,
    targetMarginRub: 0,
    monthlyGoal: 0,
  });
  return { cost, sourceFeePct, sellPrice, margin };
}

export function isSuspicious(buyRub: number, fpMin: number, s: ArbSettings): boolean {
  return s.suspiciousPct > 0 && fpMin > 0 && buyRub < (fpMin * s.suspiciousPct) / 100;
}

function warningsFor(buy: Offer, fp: FunpaySummary, category: Category, s: ArbSettings, pricePer: number): string[] {
  const w: string[] = [];
  if (fp.min !== null && isSuspicious(buy.priceRub, fp.min, s))
    w.push(`закупка дешевле ${s.suspiciousPct}% от цены FunPay — скорее всего не тот товар (аккаунт, аренда, набор, другой регион)`);
  if (fp.count < s.minCompetitors) w.push(`на FunPay всего ${fp.count} предл. — цена конкурента не гарантирует продажу`);
  if (fp.online === 0) w.push('ни одного продавца онлайн — спрос не подтверждён');
  if (buy.sourceId.startsWith('cs-')) w.push('цена региона США — ключ может не активироваться в РФ/СНГ');
  if (category === 'skins') w.push('Steam может удерживать предмет до 7 дней после покупки (трейд-холд)');
  if (category === 'currency' && pricePer !== 1) w.push(`цена FunPay — за ${pricePer} ед.; ручная цена источника должна быть за столько же`);
  if (buy.manual) {
    const age = buy.updatedAt ? (Date.now() - new Date(buy.updatedAt).getTime()) / 3600_000 : Infinity;
    if (age > s.manualMaxAgeH) w.push('ручная цена устарела — проверь на сайте');
  }
  if (buy.stock === 0) w.push('у источника нет в наличии');
  return w;
}

/** Все варианты закупки товара из результата скана */
export function offersOf(r: ScanResult): Offer[] {
  return [...r.sources.flatMap((s) => (s.status === 'ok' ? s.offers : [])), ...r.manual];
}

/** Лучшая связка по каждому товару списка отслеживания (максимальная маржа) */
export function fromWatches(watches: Watch[], results: Record<string, ScanResult>, s: ArbSettings): Opportunity[] {
  const out: Opportunity[] = [];
  for (const w of watches) {
    const r = results[w.id];
    if (!r || !r.funpay || r.funpay.status !== 'ok' || r.funpay.min === null) continue;
    const fp = r.funpay;
    for (const buy of offersOf(r)) {
      const e = evaluate(buy, { min: fp.min!, count: fp.count, online: fp.online }, s);
      out.push({
        key: `${w.id}|${buy.sourceId}|${buy.url}`,
        kind: 'watch',
        watchId: w.id,
        name: w.name,
        category: w.category,
        buy,
        ...e,
        fpMin: fp.min!,
        fpCount: fp.count,
        fpOnline: fp.online,
        fpUrl: fp.top[0]?.url ?? fp.url,
        pricePer: fp.pricePer,
        suspicious: isSuspicious(buy.priceRub, fp.min!, s),
        warnings: warningsFor(buy, fp, w.category, s, fp.pricePer),
        scannedAt: r.finishedAt,
      });
    }
  }
  return out;
}

export function fromDiscovery(d: Discovery, s: ArbSettings): Opportunity[] {
  const out: Opportunity[] = [];
  for (const it of d.items) {
    if (it.funpay.min === null) continue;
    for (const buy of it.buys) {
      const e = evaluate(buy, { min: it.funpay.min, count: it.funpay.count, online: it.funpay.online }, s);
      out.push({
        key: `d|${d.game}|${it.name}|${buy.sourceId}`,
        kind: 'discovery',
        name: it.name,
        category: 'skins',
        buy,
        ...e,
        fpMin: it.funpay.min,
        fpCount: it.funpay.count,
        fpOnline: it.funpay.online,
        fpUrl: it.funpay.top[0]?.url ?? d.funpay.url,
        pricePer: 1,
        suspicious: isSuspicious(buy.priceRub, it.funpay.min, s),
        warnings: warningsFor(buy, it.funpay, 'skins', s, 1),
        scannedAt: d.scannedAt,
      });
    }
  }
  return out;
}

/** Оставляет по каждому товару только лучшую закупку (или все, если bestOnly = false) */
export function bestPerItem(list: Opportunity[]): Opportunity[] {
  const m = new Map<string, Opportunity>();
  for (const o of list) {
    const k = o.kind === 'watch' ? `w|${o.watchId}` : `d|${o.name}`;
    const prev = m.get(k);
    if (!prev || o.margin.net > prev.margin.net) m.set(k, o);
  }
  return [...m.values()];
}
