import { useMemo, useState } from 'react';
import { Badge, Card, CopyButton, NumberField, Page, Stat, Warning } from '../components/ui';
import { DELIVERY_CLAUSES, DELIVERY_LIMITS, DELIVERY_REFERENCE, KNOWLEDGE_BASE_URL, PUBLISH_CHECKLIST } from '../data/delivery';
import { analyzePool, poolRunway, renderTemplate, splitLong, TEMPLATE_KEYS, unknownPlaceholders, type TemplateVars } from '../lib/delivery';
import { fmtInt } from '../lib/format';
import { useStore } from '../store/useStore';

const fmtDays = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v);
const fmtDay = (d: Date) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

export default function AutoDelivery() {
  const delivery = useStore((s) => s.delivery);
  const setDelivery = useStore((s) => s.setDelivery);
  const toggleCheck = useStore((s) => s.toggleCheck);
  const resetChecklist = useStore((s) => s.resetChecklist);

  const pool = useMemo(() => analyzePool(delivery.pool), [delivery.pool]);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [vars, setVars] = useState<TemplateVars>({ buyer: '', order_id: '', item: '' });
  const [stockOverride, setStockOverride] = useState<number | null>(null);

  const stock = stockOverride ?? pool.total;
  const runway = poolRunway(stock, delivery.perDay, delivery.bufferDays);
  const rendered = renderTemplate(delivery.message, vars);
  const unknown = unknownPlaceholders(delivery.message);
  const doneCount = PUBLISH_CHECKLIST.filter((c) => delivery.checklist[c.id]).length;
  const allDone = doneCount === PUBLISH_CHECKLIST.length;
  const issues = pool.lines.filter((l) => l.tooLong || l.tooManyParagraphs || l.duplicateOf !== null);
  const shownLines = onlyIssues ? issues : pool.lines;

  const splitAllLong = () => {
    const out = pool.lines.flatMap((l) => (l.tooLong ? splitLong(l.text) : [l.text]));
    setDelivery({ pool: out.join('\n') });
  };
  const dedupe = () => {
    setDelivery({ pool: pool.lines.filter((l) => l.duplicateOf === null).map((l) => l.text).join('\n') });
  };
  const insertVar = (k: keyof TemplateVars) => setDelivery({ message: `${delivery.message}{${k}}` });

  return (
    <Page title="Автовыдача" subtitle="Подготовка пула товаров и сообщения покупателю, проверка лимитов и чеклист перед публикацией лота.">
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* 1. Пул */}
          <Card
            title="1. Пул товаров"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={pool.overLotLimit ? 'bad' : 'muted'}>
                  <span className="num">
                    {fmtInt(pool.total)} / {DELIVERY_LIMITS.maxItemsPerLot}
                  </span>
                </Badge>
              </div>
            }
          >
            <textarea
              className="input num min-h-[200px] resize-y text-xs leading-relaxed"
              placeholder="Одна строка = один товар (ключ, код, ссылка)"
              value={delivery.pool}
              onChange={(e) => setDelivery({ pool: e.target.value })}
              spellCheck={false}
            />
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Товаров" value={fmtInt(pool.total)} tone={pool.overLotLimit ? 'bad' : undefined} />
              <Stat label="> 140 символов" value={fmtInt(pool.tooLong)} tone={pool.tooLong ? 'bad' : 'good'} />
              <Stat label="> 6 абзацев" value={fmtInt(pool.tooManyParagraphs)} tone={pool.tooManyParagraphs ? 'bad' : 'good'} />
              <Stat label="Дубли" value={fmtInt(pool.duplicates)} tone={pool.duplicates ? 'warn' : 'good'} />
            </div>

            {pool.overLotLimit && (
              <div className="mt-3">
                <Warning tone="bad">
                  В пуле {fmtInt(pool.total)} строк — больше лимита {DELIVERY_LIMITS.maxItemsPerLot} на лот. Раздели пул на несколько лотов или загружай порциями.
                </Warning>
              </div>
            )}
            {pool.tooLong > 0 && (
              <div className="mt-3">
                <Warning tone="bad">
                  <p>
                    Строк длиннее {DELIVERY_LIMITS.maxCharsPerItem} символов: <span className="num">{pool.tooLong}</span>. Варианты: разбить товар на несколько лотов, сократить текст или вынести
                    содержимое в ссылку и выдавать ссылку.
                  </p>
                  <button className="btn-ghost mt-2 text-xs" onClick={splitAllLong}>
                    Разбить длинные строки по {DELIVERY_LIMITS.maxCharsPerItem} символов
                  </button>
                  <p className="text-xs text-muted">Разбиение превращает одну строку в несколько товаров — проверь, что каждая часть самостоятельна.</p>
                </Warning>
              </div>
            )}
            {pool.duplicates > 0 && (
              <div className="mt-3">
                <Warning>
                  <p>
                    Повторяющихся строк: <span className="num">{pool.duplicates}</span> — разные покупатели получат один и тот же товар.
                  </p>
                  <button className="btn-ghost mt-2 text-xs" onClick={dedupe}>
                    Удалить дубли
                  </button>
                </Warning>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <CopyButton text={pool.normalized} label="Скопировать нормализованный пул" className="btn-primary" disabled={!pool.total} />
              <button className="btn-ghost" disabled={!delivery.pool} onClick={() => setDelivery({ pool: pool.normalized })}>
                Нормализовать в поле
              </button>
              {pool.removedEmpty > 0 && <span className="text-xs text-muted">пустых строк будет удалено: {pool.removedEmpty}</span>}
            </div>

            {pool.total > 0 && (
              <div className="mt-4">
                <label className="mb-2 flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                  Только строки с проблемами ({issues.length})
                </label>
                <div className="max-h-80 overflow-auto rounded-lg border border-line">
                  <table className="table">
                    <thead className="sticky top-0 bg-surface">
                      <tr>
                        <th className="w-12 text-right">#</th>
                        <th>Товар</th>
                        <th className="w-20 text-right">Символов</th>
                        <th className="w-28">Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownLines.slice(0, 1000).map((l) => (
                        <tr key={l.index} className={l.tooLong || l.tooManyParagraphs ? 'bg-bad/10' : l.duplicateOf ? 'bg-warn/5' : ''}>
                          <td className="num text-right text-muted">{l.index}</td>
                          <td className="num max-w-0 truncate text-xs" title={l.text}>
                            {l.text}
                          </td>
                          <td className={`num text-right ${l.tooLong ? 'text-bad font-semibold' : 'text-muted'}`}>{l.length}</td>
                          <td className="space-x-1 whitespace-nowrap">
                            {l.tooLong && <Badge tone="bad">длинная</Badge>}
                            {l.tooManyParagraphs && <Badge tone="bad">{l.paragraphs} абз.</Badge>}
                            {l.duplicateOf !== null && <Badge tone="warn">дубль #{l.duplicateOf}</Badge>}
                            {!l.tooLong && !l.tooManyParagraphs && l.duplicateOf === null && <span className="text-xs text-good">ок</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>

          {/* 2. Сообщение */}
          <Card title="2. Сообщение покупателю после оплаты">
            <p className="mb-3 text-sm text-muted">
              Сюда — приветствие, инструкция по активации, просьба подтвердить заказ. <span className="text-fg">Не помещай это в поле товаров</span> — это нарушение
              п. 2.1.7.
            </p>
            <div className="mb-2 flex flex-wrap gap-2">
              {TEMPLATE_KEYS.map((k) => (
                <button key={k} className="btn-ghost num px-2 py-1 text-xs" onClick={() => insertVar(k)}>
                  + {`{${k}}`}
                </button>
              ))}
            </div>
            <textarea
              className="input min-h-[140px] resize-y"
              placeholder="Текст сообщения. Переменные: {buyer}, {order_id}, {item}"
              value={delivery.message}
              onChange={(e) => setDelivery({ message: e.target.value })}
            />
            {unknown.length > 0 && (
              <p className="mt-2 text-xs text-warn">
                Неизвестные переменные: <span className="num">{unknown.join(', ')}</span> — останутся как есть.
              </p>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['buyer', 'Имя покупателя'],
                  ['order_id', 'Номер заказа'],
                  ['item', 'Выданный товар'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="block">
                  <span className="label">
                    <span className="num normal-case">{`{${k}}`}</span> → {label}
                  </span>
                  <input className="input num" value={vars[k]} onChange={(e) => setVars((v) => ({ ...v, [k]: e.target.value }))} />
                </label>
              ))}
            </div>

            <div className="mt-4">
              <span className="label">Готовый текст</span>
              <pre className="min-h-[60px] whitespace-pre-wrap rounded-lg border border-line bg-raised/50 p-3 text-sm">{rendered || <span className="text-muted">—</span>}</pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <CopyButton text={rendered} label="Скопировать готовый текст" className="btn-primary" disabled={!rendered.trim()} />
                <CopyButton text={delivery.message} label="Скопировать шаблон с переменными" disabled={!delivery.message.trim()} />
              </div>
            </div>
          </Card>

          {/* 5. Сколько осталось */}
          <Card title="Сколько осталось">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <NumberField label="Строк в пуле" value={stock} onChange={(v) => setStockOverride(Math.floor(v))} />
                <span className="mt-1 block text-xs text-muted">
                  {stockOverride === null ? (
                    'взято из пула выше'
                  ) : (
                    <button className="text-accent hover:underline" onClick={() => setStockOverride(null)}>
                      взять из пула ({pool.total})
                    </button>
                  )}
                </span>
              </div>
              <NumberField label="Продаж в день (среднее)" value={delivery.perDay} onChange={(v) => setDelivery({ perDay: v })} />
              <NumberField label="Буфер на пополнение" suffix="дн." value={delivery.bufferDays} onChange={(v) => setDelivery({ bufferDays: v })} hint="Сколько дней нужно, чтобы докупить товар" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {runway.daysLeft === null ? (
                <div className="col-span-2 text-sm text-muted">Введи среднее число продаж в день.</div>
              ) : (
                <>
                  <Stat
                    label="Пул опустеет через"
                    value={`${fmtDays(runway.daysLeft)} дн.`}
                    sub={runway.emptyDate ? `≈ ${fmtDay(runway.emptyDate)}` : undefined}
                    tone={runway.daysLeft <= delivery.bufferDays ? 'bad' : undefined}
                  />
                  <Stat
                    label="Пополнить через"
                    value={runway.refillNow ? 'сейчас' : `${fmtDays(runway.refillInDays ?? 0)} дн.`}
                    sub={runway.refillNow ? 'остаток меньше буфера' : runway.refillDate ? `не позже ${fmtDay(runway.refillDate)}` : undefined}
                    tone={runway.refillNow ? 'bad' : 'good'}
                  />
                </>
              )}
            </div>
            {delivery.perDay > DELIVERY_LIMITS.maxItemsPerDay && (
              <p className="mt-3 text-xs text-bad">Больше лимита автовыдачи — {fmtInt(DELIVERY_LIMITS.maxItemsPerDay)} товаров в сутки.</p>
            )}
          </Card>
        </div>

        {/* Правая колонка */}
        <div className="space-y-6">
          <Card
            title="3. Чеклист перед публикацией"
            right={
              <span className={`num text-xs ${allDone ? 'text-good' : 'text-muted'}`}>
                {doneCount}/{PUBLISH_CHECKLIST.length}
              </span>
            }
          >
            <ul className="space-y-2">
              {PUBLISH_CHECKLIST.map((c) => {
                const on = !!delivery.checklist[c.id];
                return (
                  <li key={c.id}>
                    <label
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition ${on ? 'border-good/40 bg-good/5' : 'border-line hover:border-accent/50'}`}
                    >
                      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--good))]" checked={on} onChange={() => toggleCheck(c.id)} />
                      <span>
                        {c.text}
                        {c.clause && <span className="num ml-1 text-xs text-muted">(п. {c.clause})</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex items-center justify-between">
              <span className={`text-sm ${allDone ? 'text-good' : 'text-muted'}`}>{allDone ? 'Можно публиковать' : 'Отметь все пункты'}</span>
              <button className="text-xs text-muted hover:text-fg" onClick={resetChecklist}>
                Сбросить
              </button>
            </div>
          </Card>

          <Card title="4. Лимиты и правила">
            <table className="table">
              <tbody>
                {DELIVERY_REFERENCE.map((r) => (
                  <tr key={r.k}>
                    <td className="text-muted">{r.k}</td>
                    <td className="num text-right">{r.v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 space-y-3">
              {DELIVERY_CLAUSES.map((c) => (
                <div key={c.clause} className="text-sm">
                  <Badge tone="warn">п. {c.clause}</Badge>
                  <p className="mt-1 text-muted">{c.text}</p>
                </div>
              ))}
              <p className="text-xs text-muted">Санкции за нарушение п. 2.1.7 и 2.1.8 — по разделу 2.1 официальных правил; сверяй актуальную редакцию.</p>
            </div>
            <a className="mt-4 block text-sm text-accent hover:underline" href={KNOWLEDGE_BASE_URL} target="_blank" rel="noreferrer">
              База знаний FunPay ↗
            </a>
          </Card>
        </div>
      </div>
    </Page>
  );
}
