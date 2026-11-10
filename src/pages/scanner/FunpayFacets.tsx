import { useEffect, useState } from 'react';
import { api, type FunpayFacets as Facets } from '../../lib/api';

/** Фильтры раздела FunPay (платформа, издание, способ получения, регион) — как на самом сайте. */
export function FunpayFacets({ url, value, onChange }: { url: string; value: Record<string, string[]>; onChange: (v: Record<string, string[]>) => void }) {
  const [data, setData] = useState<Facets | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!/funpay\.com\/(lots|chips)\/\d+/.test(url)) {
      setData(null);
      return;
    }
    let alive = true;
    setError(null);
    api
      .facets(url)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [url]);

  if (error) return <p className="text-xs text-bad">Фильтры раздела не загрузились: {error}</p>;
  if (!data) return null;
  if (!data.facets.length) return <p className="text-xs text-muted">В разделе «{data.title}» нет фильтров — используй слова ниже.</p>;

  const toggle = (key: string, v: string) => {
    const cur = new Set(value[key] ?? []);
    if (cur.has(v)) cur.delete(v);
    else cur.add(v);
    const next = { ...value, [key]: [...cur] };
    if (!next[key].length) delete next[key];
    onChange(next);
  };

  return (
    <div className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
      <p className="text-xs text-muted">
        Фильтры раздела · лотов: <span className="num">{data.total}</span>
        {data.pricePer !== 1 && ` · цена указана за ${data.pricePer} ед.`}. Не выбрано — подходит любое значение.
      </p>
      {data.facets.map((f) => (
        <div key={f.key}>
          <span className="mb-1 block text-xs font-medium text-muted">{f.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {f.options.map((o) => {
              const on = value[f.key]?.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(f.key, o.value)}
                  className={`rounded-md border px-2 py-1 text-xs ${on ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted hover:text-fg'}`}
                >
                  {o.label} <span className="num opacity-60">{o.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
