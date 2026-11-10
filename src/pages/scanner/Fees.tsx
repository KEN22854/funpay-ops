import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, Empty, Warning } from '../../components/ui';
import { api, type FeeProfile } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { FunpayPicker } from './FunpayPicker';
import type { ScannerState } from './useScanner';

const SCOPE = { funpay_section: 'Раздел FunPay', funpay_default: 'FunPay по умолчанию', source: 'Покупка у источника' } as const;

/** Профили комиссий: ставка + источник + дата начала действия. Записи не изменяются — новая ставка добавляется новой строкой. */
export function Fees({ sc }: { sc: ScannerState }) {
  const [list, setList] = useState<FeeProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ scope: 'funpay_section' as FeeProfile['scope'], scopeKey: '', pct: '', fixedRub: '', source: '', validFrom: '', note: '' });
  const [showAll, setShowAll] = useState(false);

  const load = () => api.fees().then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);
  const sectionTitles = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of Object.values(sc.results)) if (r.funpay?.status === 'ok') m[r.funpay.url.match(/(lots|chips)\/\d+/)?.[0] ?? ''] = r.funpay.title;
    return m;
  }, [sc.results]);
  const usedSections = useMemo(() => [...new Set(sc.watches.map((w) => w.funpay.url.match(/(lots|chips)\/\d+/)?.[0]).filter(Boolean) as string[])], [sc.watches]);
  const activeSections = new Set(list.filter((x) => x.active && x.scope === 'funpay_section').map((x) => x.scope_key));
  const missing = usedSections.filter((s) => !activeSections.has(s));

  const submit = async () => {
    setError(null);
    try {
      await api.addFee({
        scope: f.scope,
        scopeKey: f.scopeKey,
        pct: Number(f.pct.replace(',', '.')),
        fixedRub: Number(f.fixedRub.replace(',', '.')) || 0,
        source: f.source,
        validFrom: f.validFrom || undefined,
        note: f.note || undefined,
      });
      setF({ ...f, pct: '', fixedRub: '', source: '', note: '', validFrom: '' });
      await load();
      await sc.loadOpps();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shown = showAll ? list : list.filter((x) => x.active || x.future);

  return (
    <div className="space-y-4">
      {missing.length > 0 && (
        <Warning>
          <p>
            Для разделов {missing.map((s) => sectionTitles[s] ?? s).join(', ')} нет подтверждённой комиссии — расчёт идёт по значению по умолчанию и помечается как допущение. Посмотрите ставку в форме создания лота и добавьте её
            ниже.
          </p>
        </Warning>
      )}
      <Card title="Добавить ставку">
        <div className="grid gap-3 lg:grid-cols-3">
          <label className="block">
            <span className="label">Что</span>
            <select className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as FeeProfile['scope'], scopeKey: '' })}>
              {Object.entries(SCOPE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div className="lg:col-span-2">
            {f.scope === 'funpay_section' && (
              <>
                <span className="label">Раздел</span>
                <FunpayPicker sc={sc} value={f.scopeKey} onChange={(scopeKey) => setF({ ...f, scopeKey })} />
              </>
            )}
            {f.scope === 'source' && (
              <label className="block">
                <span className="label">Источник</span>
                <select className="input" value={f.scopeKey} onChange={(e) => setF({ ...f, scopeKey: e.target.value })}>
                  <option value="">— выберите —</option>
                  {sc.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {f.scope === 'funpay_default' && <p className="mt-6 text-xs text-muted">Применяется к разделам без своей ставки. Всё равно помечается как допущение.</p>}
          </div>
          <label className="block">
            <span className="label">Ставка, %</span>
            <input className="input num" inputMode="decimal" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">Фикс. плата, ₽ (за операцию)</span>
            <input className="input num" inputMode="decimal" value={f.fixedRub} onChange={(e) => setF({ ...f, fixedRub: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">Действует с</span>
            <input type="datetime-local" className="input num" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} />
          </label>
          <label className="block lg:col-span-2">
            <span className="label">Источник ставки (обязательно)</span>
            <input className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="форма создания лота, 11.11.2026 / ответ поддержки / ссылка" />
          </label>
          <label className="block">
            <span className="label">Заметка</span>
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </label>
        </div>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        <div className="mt-3 flex justify-end">
          <button className="btn-primary" disabled={!f.pct || !f.source.trim() || (f.scope !== 'funpay_default' && !f.scopeKey)} onClick={submit}>
            Добавить ставку
          </button>
        </div>
      </Card>

      <Card
        title="Профили комиссий"
        right={
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> показать историю
          </label>
        }
      >
        {shown.length === 0 ? (
          <Empty>Ставок пока нет. Ставки из заголовков разделов FunPay (например «комиссия 2%») добавляются автоматически при скане.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Что</th>
                  <th className="text-right">Ставка</th>
                  <th>Действует с</th>
                  <th>Источник</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.id} className={x.active ? '' : 'opacity-60'}>
                    <td>
                      {SCOPE[x.scope]}
                      <div className="text-xs text-muted">{x.scope === 'source' ? (srcName[x.scope_key] ?? x.scope_key) : x.scope === 'funpay_section' ? (sectionTitles[x.scope_key] ?? x.scope_key) : ''}</div>
                    </td>
                    <td className="num text-right">
                      {x.pct}%{x.fixed_rub ? ` + ${x.fixed_rub} ₽` : ''}
                    </td>
                    <td className="num whitespace-nowrap text-xs">{fmtDateTime(x.valid_from)}</td>
                    <td className="max-w-sm text-xs text-muted">
                      {x.source}
                      {x.note && <div>{x.note}</div>}
                    </td>
                    <td>{x.active ? <Badge tone="good">действует</Badge> : x.future ? <Badge tone="accent">с даты</Badge> : <Badge tone="muted">заменена</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
