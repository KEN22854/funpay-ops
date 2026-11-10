import { useMemo, useState } from 'react';
import { Badge, Card } from '../../components/ui';
import type { Category, Health, SourceInfo } from '../../lib/api';
import { CATEGORY_LABEL, ageText, type ScannerState } from './useScanner';

const METHOD: Record<SourceInfo['method'], { label: string; tone: 'good' | 'accent' | 'muted' }> = {
  api: { label: 'API', tone: 'good' },
  feed: { label: 'выгрузка', tone: 'good' },
  html: { label: 'HTML-парсер', tone: 'good' },
  aggregator: { label: 'CheapShark', tone: 'accent' },
  manual: { label: 'вручную', tone: 'muted' },
};

const HEALTH: Record<Health['status'], { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  ok: { label: 'работает', tone: 'good' },
  degraded: { label: 'с ошибками', tone: 'warn' },
  failing: { label: 'не отвечает', tone: 'bad' },
  circuit_open: { label: 'отключён', tone: 'bad' },
  unknown: { label: 'не опрашивался', tone: 'muted' },
};

const ERR: Record<string, string> = { blocked: '403/Cloudflare', ratelimit: '429', server: '5xx', http: '4xx', network: 'сеть', timeout: 'таймаут', format: 'формат', circuit_open: 'отключён', unknown: 'прочее' };

export function Sources({ sc }: { sc: ScannerState }) {
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [mode, setMode] = useState<'all' | 'auto' | 'manual' | 'problem'>('all');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const fp: SourceInfo = { id: 'funpay', name: 'FunPay (цены продажи)', url: 'https://funpay.com', categories: ['keys', 'skins', 'currency', 'accounts'], method: 'html', note: 'публичные страницы разделов; цены в ₽ через cookie cy=rub', auto: true, known: {} };
    return [fp, ...sc.sources].filter((s) => {
      const h = sc.sourceHealth[s.id];
      return (
        (cat === 'all' || s.categories.includes(cat)) &&
        (mode === 'all' || (mode === 'auto' ? s.auto : mode === 'manual' ? !s.auto : h && ['failing', 'circuit_open', 'degraded'].includes(h.status))) &&
        (!qq || s.name.toLowerCase().includes(qq) || s.url.includes(qq))
      );
    });
  }, [sc.sources, sc.sourceHealth, cat, mode, q]);

  const autoCount = sc.sources.filter((s) => s.auto).length;
  const working = Object.values(sc.sourceHealth).filter((h) => h.status === 'ok').length;

  return (
    <Card
      title={`Источники: ${sc.sources.length} в реестре · автоматически ${autoCount} · работают сейчас ${working}`}
      right={
        <div className="flex flex-wrap gap-2">
          <input className="input w-40 py-1" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-auto py-1" value={cat} onChange={(e) => setCat(e.target.value as Category | 'all')}>
            <option value="all">Все категории</option>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select className="input w-auto py-1" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="all">Все</option>
            <option value="auto">Автоматические</option>
            <option value="manual">Ручные</option>
            <option value="problem">С проблемами</option>
          </select>
        </div>
      }
    >
      <p className="mb-3 text-xs text-muted">
        Число источников в реестре ≠ число работающих интеграций. Статистика — за 7 дней по каждому вызову адаптера. После 3 ошибок подряд источник отключается на 15 минут, чтобы не мешать остальным. Пустые ответы подряд — признак
        изменившейся вёрстки. Комиссии при покупке задаются во вкладке «Комиссии».
      </p>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Сайт</th>
              <th>Сбор</th>
              <th>Состояние</th>
              <th className="text-right">Успешно</th>
              <th className="text-right">Задержка</th>
              <th>Последний успех</th>
              <th>Ошибки</th>
              <th>Примечание</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const h = sc.sourceHealth[s.id];
              const st = s.auto ? HEALTH[h?.status ?? 'unknown'] : { label: 'ручной ввод', tone: 'muted' as const };
              return (
                <tr key={s.id}>
                  <td className="whitespace-nowrap">
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      {s.name} ↗
                    </a>
                    <div className="text-xs text-muted">{s.categories.map((c) => CATEGORY_LABEL[c]).join(', ')}</div>
                  </td>
                  <td>
                    <Badge tone={METHOD[s.method].tone}>{METHOD[s.method].label}</Badge>
                  </td>
                  <td>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {h?.circuitOpenUntil && <div className="text-xs text-bad">до {new Date(h.circuitOpenUntil).toLocaleTimeString('ru-RU')}</div>}
                    {(h?.emptyStreak ?? 0) >= 5 && <div className="text-xs text-warn">{h!.emptyStreak} пустых ответов подряд</div>}
                  </td>
                  <td className="num text-right">{h?.calls ? `${Math.round((h.successRate ?? 0) * 100)}% из ${h.calls}` : '—'}</td>
                  <td className="num text-right">{h?.latencyMedianMs ? `${(h.latencyMedianMs / 1000).toFixed(1)} с` : '—'}</td>
                  <td className="text-xs text-muted">{h?.lastSuccess ? ageText(h.freshnessMin ?? Infinity) : '—'}</td>
                  <td className="text-xs">
                    {h?.errors && Object.keys(h.errors).length ? (
                      <span title={h.lastError?.detail ?? ''}>
                        {Object.entries(h.errors)
                          .map(([k, v]) => `${ERR[k] ?? k}: ${v}`)
                          .join(', ')}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="max-w-xs text-xs text-muted">
                    {s.note}
                    {s.known?.region && ` · регион цены: ${s.known.region}`}
                    {s.known?.type && ` · тип: ${s.known.type}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
