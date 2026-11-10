import { DELIVERY_LIMITS } from '../data/delivery';

export interface PoolLine {
  index: number;
  text: string;
  length: number;
  /** абзацев в строке (литерал \n внутри строки — перенос в FunPay) */
  paragraphs: number;
  tooLong: boolean;
  tooManyParagraphs: boolean;
  duplicateOf: number | null;
}

export interface PoolAnalysis {
  lines: PoolLine[];
  normalized: string;
  total: number;
  tooLong: number;
  tooManyParagraphs: number;
  duplicates: number;
  overLotLimit: boolean;
  removedEmpty: number;
}

/** Унификация переносов, trim каждой строки, удаление пустых. */
export function analyzePool(raw: string): PoolAnalysis {
  const unified = raw.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n');
  const rawLines = unified.split('\n');
  const trimmed = rawLines.map((l) => l.replace(/\s+$/u, '').replace(/^\s+/u, ''));
  const kept = trimmed.filter((l) => l.length > 0);

  const firstSeen = new Map<string, number>();
  const lines: PoolLine[] = kept.map((text, i) => {
    const index = i + 1;
    const length = [...text].length;
    const paragraphs = text.split('\\n').length;
    const prev = firstSeen.get(text);
    if (prev === undefined) firstSeen.set(text, index);
    return {
      index,
      text,
      length,
      paragraphs,
      tooLong: length > DELIVERY_LIMITS.maxCharsPerItem,
      tooManyParagraphs: paragraphs > DELIVERY_LIMITS.maxParagraphs,
      duplicateOf: prev ?? null,
    };
  });

  return {
    lines,
    normalized: kept.join('\n'),
    total: lines.length,
    tooLong: lines.filter((l) => l.tooLong).length,
    tooManyParagraphs: lines.filter((l) => l.tooManyParagraphs).length,
    duplicates: lines.filter((l) => l.duplicateOf !== null).length,
    overLotLimit: lines.length > DELIVERY_LIMITS.maxItemsPerLot,
    removedEmpty: raw.trim() === '' ? 0 : rawLines.length - kept.length,
  };
}

/** Разбивает длинную строку на куски ≤ limit символов по границам слов. */
export function splitLong(text: string, limit = DELIVERY_LIMITS.maxCharsPerItem): string[] {
  const chars = [...text];
  if (chars.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while ([...rest].length > limit) {
    const head = [...rest].slice(0, limit).join('');
    const cut = head.lastIndexOf(' ');
    const piece = cut > limit * 0.5 ? head.slice(0, cut) : head;
    out.push(piece.trim());
    rest = rest.slice(piece.length).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface TemplateVars {
  buyer: string;
  order_id: string;
  item: string;
}

export const TEMPLATE_KEYS: (keyof TemplateVars)[] = ['buyer', 'order_id', 'item'];

export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(/\{(buyer|order_id|item)\}/g, (_, k: keyof TemplateVars) => vars[k] || `{${k}}`);
}

export function unknownPlaceholders(tpl: string): string[] {
  const found = tpl.match(/\{[^{}\s]+\}/g) ?? [];
  const allowed = new Set(TEMPLATE_KEYS.map((k) => `{${k}}`));
  return [...new Set(found.filter((f) => !allowed.has(f)))];
}

export interface Runway {
  daysLeft: number | null;
  refillInDays: number | null;
  emptyDate: Date | null;
  refillDate: Date | null;
  refillNow: boolean;
}

export function poolRunway(stock: number, perDay: number, bufferDays: number): Runway {
  if (!(perDay > 0) || stock < 0) {
    return { daysLeft: null, refillInDays: null, emptyDate: null, refillDate: null, refillNow: false };
  }
  const daysLeft = stock / perDay;
  const refillInDays = daysLeft - Math.max(0, bufferDays);
  const now = Date.now();
  const day = 86_400_000;
  return {
    daysLeft,
    refillInDays: Math.max(0, refillInDays),
    emptyDate: new Date(now + daysLeft * day),
    refillDate: new Date(now + Math.max(0, refillInDays) * day),
    refillNow: refillInDays <= 0,
  };
}
