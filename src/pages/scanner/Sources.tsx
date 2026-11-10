import { useMemo, useState } from 'react';
import { Badge, Card } from '../../components/ui';
import type { Category, SourceInfo } from '../../lib/api';
import { useStore } from '../../store/useStore';
import { CATEGORY_LABEL, type ScannerState } from './useScanner';

const METHOD: Record<SourceInfo['method'], { label: string; tone: 'good' | 'accent' | 'muted' }> = {
  api: { label: 'API', tone: 'good' },
  feed: { label: 'выгрузка', tone: 'good' },
  html: { label: 'страница', tone: 'good' },
  aggregator: { label: 'CheapShark', tone: 'accent' },
  manual: { label: 'вручную', tone: 'muted' },
};

export function Sources({ sc }: { sc: ScannerState }) {
  const fees = useStore((s) => s.arb.sourceFees);
  const setArb = useStore((s) => s.setArb);
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [mode, setMode] = useState<'all' | 'auto' | 'manual'>('all');
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return sc.sources.filter(
      (s) =>
        (cat === 'all' || s.categories.includes(cat)) &&
        (mode === 'all' || (mode === 'auto' ? s.auto : !s.auto)) &&
        (!qq || s.name.toLowerCase().includes(qq) || s.url.includes(qq)),
    );
  }, [sc.sources, cat, mode, q]);

  const autoCount = sc.sources.filter((s) => s.auto).length;

  return (
    <Card
      title={`Источники: ${sc.sources.length} (автоматически — ${autoCount}, вручную — ${sc.sources.length - autoCount})`}
      right={
        <div className="flex flex-wrap gap-2">
          <input className="input w-44 py-1" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-auto py-1" value={cat} onChange={(e) => setCat(e.target.value as Category | 'all')}>
            <option value="all">Все категории</option>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select className="input w-auto py-1" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="all">Любой способ</option>
            <option value="auto">Автоматически</option>
            <option value="manual">Вручную</option>
          </select>
        </div>
      }
    >
      <p className="mb-3 text-xs text-muted">
        «Комиссия при покупке» — сколько сверху берёт платёжка или сам сайт (добавляется к закупке при расчёте выгоды). Цены у сайтов с пометкой «вручную»
        вводятся в карточке товара во вкладке «Отслеживание».
      </p>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Сайт</th>
              <th>Категории</th>
              <th>Сбор</th>
              <th>Примечание</th>
              <th className="w-28 text-right">Комиссия при покупке, %</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap">
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {s.name} ↗
                  </a>
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {s.categories.map((c) => (
                      <Badge key={c} tone="muted">
                        {CATEGORY_LABEL[c]}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td>
                  <Badge tone={METHOD[s.method].tone}>{METHOD[s.method].label}</Badge>
                </td>
                <td className="text-xs text-muted">{s.note}</td>
                <td className="text-right">
                  <input
                    className="input num w-20 py-1 text-right"
                    inputMode="decimal"
                    value={fees[s.id] ?? ''}
                    placeholder="0"
                    onChange={(e) => {
                      const v = Math.min(100, Math.max(0, Number(e.target.value.replace(',', '.')) || 0));
                      setArb({ sourceFees: { [s.id]: v } });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
