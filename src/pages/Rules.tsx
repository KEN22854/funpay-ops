import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Badge, Card, Empty, Page } from '../components/ui';
import { RULE_GROUPS, RULES_SOURCES, type Rule, type Severity } from '../data/rules';

const TONE: Record<Severity, 'bad' | 'warn' | 'muted'> = { block: 'bad', warn: 'warn', practice: 'muted' };

function matches(r: Rule, q: string) {
  if (!q) return true;
  const hay = `${r.clause ?? ''} ${r.title} ${r.sanction}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export default function Rules() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ 'block-60': true });
  const [onlyBlock, setOnlyBlock] = useState(false);

  const groups = useMemo(
    () =>
      RULE_GROUPS.map((g) => ({
        ...g,
        rules: g.rules.filter((r) => matches(r, q.trim()) && (!onlyBlock || r.severity === 'block')),
      })).filter((g) => g.rules.length > 0),
    [q, onlyBlock],
  );
  const searching = q.trim().length > 0 || onlyBlock;
  const total = groups.reduce((s, g) => s + g.rules.length, 0);

  return (
    <Page
      title="Правила FunPay"
      subtitle="Запрещённые товары и пункты о сделках с санкциями. Правила обновляются — перед публикацией лота сверься с первоисточником."
    >
      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-md" placeholder="Поиск: номер пункта, товар, санкция…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={onlyBlock} onChange={(e) => setOnlyBlock(e.target.checked)} />
          Только блокировки
        </label>
        <span className="num text-xs text-muted">найдено: {total}</span>
      </div>

      {groups.length === 0 && <Empty>Ничего не найдено.</Empty>}

      <div className="space-y-3">
        {groups.map((g) => {
          const isOpen = searching || !!open[g.id];
          return (
            <div key={g.id} className="card overflow-hidden">
              <button
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-raised/60"
                onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))}
                aria-expanded={isOpen}
              >
                <div className="flex items-center gap-3">
                  <Badge tone={TONE[g.severity]}>{g.severity === 'block' ? 'Блокировка' : g.severity === 'warn' ? 'Предупреждение' : 'Практика'}</Badge>
                  <span className="text-sm font-medium">{g.title}</span>
                </div>
                <span className="num text-xs text-muted">
                  {g.rules.length} {isOpen ? '▴' : '▾'}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
                    <p className="border-t border-line px-4 py-2 text-xs text-muted">{g.description}</p>
                    <div className="overflow-x-auto">
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="w-20">Пункт</th>
                            <th>Что запрещено</th>
                            <th>Санкция</th>
                            <th className="w-32 text-right">Выплата после идент.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.rules.map((r) => (
                            <tr key={r.id}>
                              <td className="num text-muted">{r.clause ?? '—'}</td>
                              <td>{r.title}</td>
                              <td>
                                <Badge tone={r.severity === 'block' ? 'bad' : 'warn'}>{r.sanction}</Badge>
                              </td>
                              <td className="num text-right">{r.payoutDays ? `${r.payoutDays} дн.` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <Card title="Первоисточники">
        <ul className="space-y-1 text-sm">
          {RULES_SOURCES.map((s) => (
            <li key={s.url}>
              <a className="text-accent hover:underline" href={s.url} target="_blank" rel="noreferrer">
                {s.label}
              </a>{' '}
              <span className="num text-xs text-muted">{s.url}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}
