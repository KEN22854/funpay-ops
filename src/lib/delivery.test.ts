import { describe, expect, it } from 'vitest';
import { analyzePool, poolRunway, renderTemplate, splitLong, unknownPlaceholders } from './delivery';

describe('analyzePool', () => {
  it('нормализует переносы, пробелы и пустые строки', () => {
    const a = analyzePool('  A  \r\nB\r\r\n\n  \nC\n');
    expect(a.normalized).toBe('A\nB\nC');
    expect(a.total).toBe(3);
  });

  it('ловит длинные строки, абзацы и дубли', () => {
    const long = 'x'.repeat(141);
    const a = analyzePool(['ok', long, 'x'.repeat(140), 'a\\nb\\nc\\nd\\ne\\nf\\ng', 'ok'].join('\n'));
    expect(a.tooLong).toBe(1);
    expect(a.lines[2].tooLong).toBe(false);
    expect(a.tooManyParagraphs).toBe(1);
    expect(a.duplicates).toBe(1);
    expect(a.lines[4].duplicateOf).toBe(1);
  });

  it('символы считаются по кодовым точкам, а не по UTF-16', () => {
    expect(analyzePool('🎮'.repeat(140)).tooLong).toBe(0);
  });

  it('лимит 500 на лот', () => {
    const a = analyzePool(Array.from({ length: 501 }, (_, i) => `K${i}`).join('\n'));
    expect(a.overLotLimit).toBe(true);
  });
});

describe('splitLong', () => {
  it('режет по словам, каждая часть ≤ 140', () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const parts = splitLong(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 140)).toBe(true);
    expect(parts.join(' ')).toBe(text);
  });
});

describe('шаблон сообщения', () => {
  it('подставляет переменные и сообщает о неизвестных', () => {
    const tpl = 'Привет, {buyer}! Заказ #{order_id}: {item}. {foo}';
    expect(renderTemplate(tpl, { buyer: 'Ivan', order_id: 'ABC', item: 'KEY-1' })).toBe('Привет, Ivan! Заказ #ABC: KEY-1. {foo}');
    expect(unknownPlaceholders(tpl)).toEqual(['{foo}']);
  });
});

describe('poolRunway', () => {
  it('дни до нуля и дата пополнения с буфером', () => {
    const r = poolRunway(100, 10, 3);
    expect(r.daysLeft).toBe(10);
    expect(r.refillInDays).toBe(7);
    expect(r.refillNow).toBe(false);
    expect(poolRunway(20, 10, 3).refillNow).toBe(true);
    expect(poolRunway(100, 0, 3).daysLeft).toBeNull();
  });
});
