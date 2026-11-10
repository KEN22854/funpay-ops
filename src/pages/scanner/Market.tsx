import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, Empty } from '../../components/ui';
import { api, type MarketRow, type Snapshot } from '../../lib/api';
import { fmtPct, fmtRub } from '../../lib/format';
import { CATEGORY_LABEL, type ScannerState } from './useScanner';

type ModeId = 'trend' | 'stock' | 'competitor' | 'demand' | 'undervalued' | 'anomaly';
const MODES: { id: ModeId; label: string; hint: string }[] = [
  { id: 'trend', label: 'Тренды', hint: 'изменение минимальной цены FunPay за 24 ч / 7 дн' },
  { id: 'stock', label: 'Предложение', hint: 'как меняется число лотов: падение — возможный дефицит' },
  { id: 'competitor', label: 'Конкуренты', hint: 'число продавцов и доля крупнейшего' },
  { id: 'demand', label: 'Спрос (сигнал)', hint: 'исчезновение лотов — наблюдаемый сигнал, не продажи' },
  { id: 'undervalued', label: 'Недооценённые', hint: 'цена источника ниже своей медианы за 7 дней' },
  { id: 'anomaly', label: 'Аномалии', hint: 'скачки цены > 30% и пропуски наблюдений' },
];

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? '' : v > 0 ? 'text-good' : v < 0 ? 'text-bad' : '');

export function Market({ sc }: { sc: ScannerState }) {
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [mode, setMode] = useState<ModeId>('trend');
  const [sel, setSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);

  useEffect(() => {
    api
      .market()
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, [sc.results]);

  const sorted = useMemo(() => {
    const r = rows.filter((x) => x.funpay);
    const key: Record<ModeId, (x: MarketRow) => number> = {
      trend: (x) => Math.abs(x.funpay!.changes['24h'] ?? x.funpay!.changes['7d'] ?? 0),
      stock: (x) => -(x.funpay!.countChanges['24h'] ?? 0),
      competitor: (x) => x.funpay!.topSellerShare ?? 0,
      demand: (x) => x.liquidity.observed?.disappearPerLotDay ?? -1,
      undervalued: (x) => -Math.min(0, ...x.sources.map((s) => s.vs7dMedianPct ?? 0)),
      anomaly: (x) => x.funpay!.anomalies.length,
    };
    return r.sort((a, b) => key[mode](b) - key[mode](a));
  }, [rows, mode]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {MODES.map((m) => (
          <button key={m.id} className={`rounded-md px-3 py-1.5 ${mode === m.id ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`} onClick={() => setMode(m.id)} title={m.hint}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{MODES.find((m) => m.id === mode)!.hint}. История копится с каждым сканом: чем дольше наблюдение, тем надёжнее сигналы.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {sorted.length === 0 ? (
        <Empty>История рынка пуста — просканируйте товары из каталога несколько раз.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="text-right">Мин. FunPay</th>
                <th className="text-right">1 ч</th>
                <th className="text-right">24 ч</th>
                <th className="text-right">7 дн</th>
                <th className="text-right">Лотов (24 ч)</th>
                <th className="text-right">Продавцов</th>
                <th className="text-right">Исчезает/сут</th>
                <th>Источники vs 7 дн</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((x) => {
                const f = x.funpay!;
                return (
                  <tr key={x.watchId} className={sel === x.watchId ? 'bg-accent/10' : ''}>
                    <td>
                      <button className="font-medium hover:underline" onClick={() => setSel(sel === x.watchId ? null : x.watchId)}>
                        {x.name}
                      </button>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone="muted">{CATEGORY_LABEL[x.category]}</Badge>
                        {f.anomalies.length > 0 && <Badge tone="warn">аномалий: {f.anomalies.length}</Badge>}
                        <Badge tone="muted">{f.points} снимк.</Badge>
                      </div>
                    </td>
                    <td className="num text-right">{fmtRub(f.min)}</td>
                    <td className={`num text-right ${tone(f.changes['1h'])}`}>{pct(f.changes['1h'])}</td>
                    <td className={`num text-right ${tone(f.changes['24h'])}`}>{pct(f.changes['24h'])}</td>
                    <td className={`num text-right ${tone(f.changes['7d'])}`}>{pct(f.changes['7d'])}</td>
                    <td className="num text-right">
                      {f.count} <span className={tone(f.countChanges['24h'])}>{pct(f.countChanges['24h'])}</span>
                    </td>
                    <td className="num text-right">
                      {f.sellers}
                      {f.topSellerShare !== null && <div className="text-xs text-muted">топ: {fmtPct(f.topSellerShare * 100)}</div>}
                    </td>
                    <td className="num text-right">{x.liquidity.observed?.disappearPerLotDay === null || !x.liquidity.observed ? '—' : x.liquidity.observed.disappearPerLotDay.toFixed(2)}</td>
                    <td className="text-xs">
                      {x.sources.slice(0, 4).map((s) => (
                        <div key={s.sourceId}>
                          {srcName[s.sourceId] ?? s.sourceId}: {s.last === null ? '—' : fmtRub(s.last)} <span className={tone(s.vs7dMedianPct === null ? null : -s.vs7dMedianPct)}>{pct(s.vs7dMedianPct)}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sel && <HistoryChart watchId={sel} srcName={srcName} />}
    </div>
  );
}

function HistoryChart({ watchId, srcName }: { watchId: string; srcName: Record<string, string> }) {
  const [days, setDays] = useState(7);
  const [h, setH] = useState<{ funpay: Snapshot[]; sources: Record<string, Snapshot[]> } | null>(null);
  useEffect(() => {
    api.history(watchId, days).then(setH);
  }, [watchId, days]);
  const data = useMemo(() => {
    if (!h) return [];
    const pts = new Map<string, Record<string, number | string>>();
    const put = (ts: string, k: string, v: number | null) => {
      if (v === null) return;
      const t = ts.slice(0, 16);
      pts.set(t, { ...(pts.get(t) ?? { t }), [k]: v });
    };
    for (const s of h.funpay) {
      put(s.ts, 'FunPay мин.', s.min_rub);
      put(s.ts, 'FunPay усеч. медиана', s.trimmed_rub);
    }
    for (const [id, rows] of Object.entries(h.sources)) for (const s of rows) put(s.ts, srcName[id] ?? id, s.min_rub);
    return [...pts.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  }, [h, srcName]);
  const keys = data.length ? [...new Set(data.flatMap((d) => Object.keys(d).filter((k) => k !== 't')))] : [];
  const colors = ['rgb(var(--accent))', 'rgb(var(--muted))', 'rgb(var(--good))', 'rgb(var(--warn))', 'rgb(var(--bad))', '#38bdf8', '#a78bfa', '#f472b6'];
  return (
    <Card
      title="История цен"
      right={
        <select className="input w-auto py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30].map((d) => (
            <option key={d} value={d}>
              {d} дн
            </option>
          ))}
        </select>
      }
    >
      {data.length < 2 ? (
        <Empty>Для графика нужно хотя бы два скана.</Empty>
      ) : (
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ left: 8, right: 16 }}>
              <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" />
              <XAxis dataKey="t" tick={{ fill: 'rgb(var(--muted))', fontSize: 10 }} tickFormatter={(t: string) => t.slice(5).replace('T', ' ')} />
              <YAxis tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} width={64} />
              <Tooltip contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))', borderRadius: 8 }} formatter={(v: number) => fmtRub(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {keys.map((k, i) => (
                <Line key={k} dataKey={k} stroke={colors[i % colors.length]} dot={false} strokeWidth={k.startsWith('FunPay') ? 2 : 1.5} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
