import { useMemo, useState } from 'react';
import { Badge, Card, Empty, Warning } from '../../components/ui';
import type { Category, ManualPrice, SkinGame, Watch } from '../../lib/api';
import { fmtDateTime, fmtRub } from '../../lib/format';
import { FunpayFacets } from './FunpayFacets';
import { FunpayPicker } from './FunpayPicker';
import { CATEGORY_LABEL, type ScannerState } from './useScanner';

type Draft = Omit<Watch, 'id' | 'createdAt'> & { id?: string };

const blank = (): Draft => ({
  name: '',
  category: 'keys',
  game: null,
  query: '',
  include: [],
  exclude: [],
  sources: [],
  ignore: [],
  manual: [],
  funpay: { url: '', include: [], exclude: [], onlineOnly: false, minReviews: 0, facets: {} },
  enabled: true,
});

const QUERY_HINT: Record<Category, string> = {
  keys: 'Название игры, как в магазинах: «Elden Ring». Лишнее (DLC, аренда, другие платформы) отсекай словами-исключениями.',
  skins: 'Точное английское market_hash_name из Steam: «AK-47 | Redline (Field-Tested)».',
  currency: 'Например «WoW gold» — автоматически ищется только на Plati; цены остальных площадок вводи вручную ЗА ТО ЖЕ количество, что и в колонке цены FunPay.',
  accounts: 'Аккаунты уникальны — автоматически ищется только на Plati, остальное вручную.',
};

const SKIN_GAMES: { id: SkinGame; name: string }[] = [
  { id: 'cs2', name: 'Counter-Strike 2' },
  { id: 'dota2', name: 'Dota 2' },
  { id: 'rust', name: 'Rust' },
];

/** слова, которыми продавцы помечают НЕ ключи: общие аккаунты, аренду, оффлайн-активации */
const TYPICAL_EXCLUDE = ['аренда', 'аренду', 'rent', 'аккаунт', 'account', 'steam guard', 'offline', 'оффлайн', 'офлайн', 'общий', 'shared'];

const csv = (a: string[]) => a.join(', ');
const uncsv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function Watches({ sc }: { sc: ScannerState }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all');

  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);
  const visible = sc.watches.filter((w) => catFilter === 'all' || w.category === catFilter);

  const save = async (andScan: boolean) => {
    if (!draft) return;
    setError(null);
    setBusy('save');
    try {
      const w = await sc.saveWatch(draft);
      setDraft(null);
      if (andScan) {
        setBusy(w.id);
        setOpen(w.id);
        await sc.scan(w.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runScan = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await sc.scan(id);
      setOpen(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const unignore = async (w: Watch, url: string) => {
    await sc.saveWatch({ ...w, ignore: w.ignore.filter((u) => u !== url) });
  };
  const ignore = async (w: Watch, url: string) => {
    setBusy(w.id);
    try {
      await sc.saveWatch({ ...w, ignore: [...w.ignore, url] });
      await sc.scan(w.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => setDraft(blank())}>
          + Товар
        </button>
        <button className="btn-ghost" disabled={!sc.watches.length || sc.health?.allRunning} onClick={() => sc.scanAll()}>
          {sc.health?.allRunning ? 'Сканирую всё…' : 'Сканировать всё'}
        </button>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          Автоскан каждые
          <select className="input w-auto py-1" value={sc.health?.settings.intervalMin ?? 30} onChange={(e) => sc.setIntervalMin(Number(e.target.value))}>
            {[0, 10, 15, 30, 60, 120, 360].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'выкл.' : `${m} мин`}
              </option>
            ))}
          </select>
        </label>
        <select className="input w-auto py-1" value={catFilter} onChange={(e) => setCatFilter(e.target.value as Category | 'all')}>
          <option value="all">Все категории</option>
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </div>
      {sc.health?.nextAutoScan && <p className="text-xs text-muted">Следующий автоскан: {fmtDateTime(sc.health.nextAutoScan)}. Сервер должен быть запущен.</p>}
      {error && <Warning tone="bad">{error}</Warning>}

      {draft && <WatchForm sc={sc} draft={draft} setDraft={setDraft} onSave={save} busy={busy === 'save'} />}

      {visible.length === 0 && !draft && <Empty>Список пуст. Добавь товар: что искать у источников и в каком разделе FunPay продавать.</Empty>}

      {visible.map((w) => {
        const r = sc.results[w.id];
        const ok = r?.sources.filter((s) => s.status === 'ok').length ?? 0;
        const err = r?.sources.filter((s) => s.status === 'error') ?? [];
        const best = r ? [...r.sources.flatMap((s) => s.offers), ...r.manual].sort((a, b) => a.priceRub - b.priceRub)[0] : undefined;
        const fp = r?.funpay;
        return (
          <div key={w.id} className="card">
            <div className="flex flex-wrap items-center gap-3 p-4">
              <button className="flex-1 text-left" onClick={() => setOpen(open === w.id ? null : w.id)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{w.name}</span>
                  <Badge tone="muted">{CATEGORY_LABEL[w.category]}</Badge>
                  {!w.enabled && <Badge tone="warn">выкл.</Badge>}
                </div>
                <div className="num mt-1 text-xs text-muted">
                  {r ? (
                    <>
                      {fmtDateTime(r.finishedAt)} · источников с ценой: {ok}
                      {err.length > 0 && <span className="text-warn"> · ошибок: {err.length}</span>}
                      {best && ` · дешевле всего: ${fmtRub(best.priceRub)} (${srcName[best.sourceId] ?? best.sourceId})`}
                      {fp?.status === 'ok' && ` · FunPay мин.: ${fp.min === null ? 'нет предложений' : fmtRub(fp.min)} (${fp.count})`}
                      {fp?.status === 'error' && <span className="text-bad"> · FunPay: {fp.error}</span>}
                      {!fp && <span className="text-warn"> · не выбран раздел FunPay</span>}
                    </>
                  ) : (
                    'ещё не сканировался'
                  )}
                </div>
              </button>
              <div className="flex gap-2">
                <button className="btn-ghost text-xs" disabled={busy === w.id} onClick={() => runScan(w.id)}>
                  {busy === w.id || sc.health?.scanning.includes(w.id) ? 'Сканирую…' : 'Сканировать'}
                </button>
                <button className="btn-ghost text-xs" onClick={() => setDraft({ ...w })}>
                  Изменить
                </button>
                <button
                  className="btn-danger text-xs"
                  onClick={() => {
                    if (confirm(`Удалить «${w.name}» из отслеживания?`)) sc.removeWatch(w.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {open === w.id && r && (
              <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Источники</h3>
                  <div className="max-h-96 overflow-auto">
                    <table className="table">
                      <tbody>
                        {[...r.sources]
                          .sort((a, b) => (a.offers[0]?.priceRub ?? Infinity) - (b.offers[0]?.priceRub ?? Infinity))
                          .map((s) => (
                            <tr key={s.sourceId}>
                              <td className="whitespace-nowrap">{srcName[s.sourceId] ?? s.sourceId}</td>
                              <td>
                                {s.status === 'error' ? (
                                  <span className="text-xs text-bad">{s.error}</span>
                                ) : s.status === 'empty' ? (
                                  <span className="text-xs text-muted">не найдено</span>
                                ) : (
                                  <ul className="space-y-1">
                                    {s.offers.slice(0, 3).map((o) => (
                                      <li key={o.url} className="flex items-baseline justify-between gap-2 text-xs">
                                        <a href={o.url} target="_blank" rel="noreferrer" className="truncate hover:underline" title={o.title}>
                                          {o.title}
                                        </a>
                                        <span className="num shrink-0">{fmtRub(o.priceRub)}</span>
                                        <button className="shrink-0 text-muted hover:text-bad" title="Не тот товар" onClick={() => ignore(w, o.url)}>
                                          ✕
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                            </tr>
                          ))}
                        {r.manual.map((m) => (
                          <tr key={'m' + m.sourceId + m.price}>
                            <td className="whitespace-nowrap">
                              {srcName[m.sourceId] ?? m.sourceId} <span className="text-xs text-muted">(вручную)</span>
                            </td>
                            <td className="num text-right text-xs">
                              {fmtRub(m.priceRub)} {m.currency !== 'RUB' && `(${m.price} ${m.currency})`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                    FunPay {fp?.status === 'ok' && `· ${fp.count} из ${fp.total} предложений раздела подходят`}
                  </h3>
                  {fp?.status === 'ok' ? (
                    fp.top.length ? (
                      <ul className="space-y-1 text-xs">
                        {fp.top.map((o) => (
                          <li key={o.url} className="flex items-baseline justify-between gap-2">
                            <span className={o.online ? 'text-good' : 'text-muted'}>●</span>
                            <a href={o.url} target="_blank" rel="noreferrer" className="flex-1 truncate hover:underline" title={o.desc}>
                              {o.desc || [o.server, o.side].filter(Boolean).join(' · ') || o.seller}
                            </a>
                            <span className="shrink-0 text-muted">{o.seller}</span>
                            <span className="num shrink-0">{fmtRub(o.price)}</span>
                            <button className="shrink-0 text-muted hover:text-bad" title="Не тот товар" onClick={() => ignore(w, o.url)}>
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">Под фильтр не попало ни одного предложения. Ослабь слова фильтра FunPay.</p>
                    )
                  ) : (
                    <p className="text-xs text-muted">{fp?.status === 'error' ? fp.error : 'Раздел FunPay не задан.'}</p>
                  )}
                  {w.ignore.length > 0 && (
                    <details className="mt-3 text-xs text-muted">
                      <summary className="cursor-pointer">Скрыто как «не тот товар»: {w.ignore.length}</summary>
                      <ul className="mt-1 space-y-1">
                        {w.ignore.map((u) => (
                          <li key={u} className="flex gap-2">
                            <span className="num truncate">{u}</span>
                            <button className="text-accent hover:underline" onClick={() => unignore(w, u)}>
                              вернуть
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WatchForm({
  sc,
  draft,
  setDraft,
  onSave,
  busy,
}: {
  sc: ScannerState;
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  onSave: (scan: boolean) => void;
  busy: boolean;
}) {
  const upd = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const updFp = (p: Partial<Draft['funpay']>) => setDraft({ ...draft, funpay: { ...draft.funpay, ...p } });
  const autoSources = sc.sources.filter((s) => s.auto && s.categories.includes(draft.category));
  const manualSources = sc.sources.filter((s) => s.categories.includes(draft.category));
  const selected = new Set(draft.sources.length ? draft.sources : autoSources.map((s) => s.id));

  const toggleSource = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // все выбраны = пустой список (значит «все», в том числе будущие)
    upd({ sources: next.size === autoSources.length ? [] : [...next] });
  };

  const setManual = (i: number, p: Partial<ManualPrice>) =>
    upd({ manual: draft.manual.map((m, j) => (j === i ? { ...m, ...p, updatedAt: new Date().toISOString() } : m)) });

  return (
    <Card title={draft.id ? 'Изменить товар' : 'Новый товар'} className="border-accent/50">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Категория</span>
              <select className="input" value={draft.category} onChange={(e) => upd({ category: e.target.value as Category, sources: [], game: e.target.value === 'skins' ? 'cs2' : null })}>
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            {draft.category === 'skins' ? (
              <label className="block">
                <span className="label">Игра</span>
                <select className="input" value={draft.game ?? 'cs2'} onChange={(e) => upd({ game: e.target.value as SkinGame })}>
                  {SKIN_GAMES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="block">
                <span className="label">Название у себя</span>
                <input className="input" value={draft.name} onChange={(e) => upd({ name: e.target.value })} placeholder="необязательно" />
              </label>
            )}
          </div>
          <label className="block">
            <span className="label">Что искать у источников</span>
            <input className="input" value={draft.query} onChange={(e) => upd({ query: e.target.value })} />
            <span className="mt-1 block text-xs text-muted">{QUERY_HINT[draft.category]}</span>
          </label>
          {draft.category !== 'skins' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Обязательные слова</span>
                <input className="input" value={csv(draft.include)} onChange={(e) => upd({ include: uncsv(e.target.value) })} placeholder="по умолчанию — слова запроса" />
              </label>
              <label className="block">
                <span className="label">Исключить слова</span>
                <input className="input" value={csv(draft.exclude)} onChange={(e) => upd({ exclude: uncsv(e.target.value) })} placeholder="аренда, dlc, ps4, deluxe" />
                <button
                  type="button"
                  className="mt-1 text-xs text-accent hover:underline"
                  onClick={() => upd({ exclude: [...new Set([...draft.exclude, ...TYPICAL_EXCLUDE])] })}
                >
                  + типовые исключения (аккаунты, аренда, оффлайн)
                </button>
              </label>
            </div>
          )}

          <div>
            <span className="label">Автоматические источники ({selected.size}/{autoSources.length})</span>
            {autoSources.length ? (
              <div className="flex flex-wrap gap-1.5">
                {autoSources.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSource(s.id)}
                    className={`rounded-md border px-2 py-1 text-xs ${selected.has(s.id) ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted'}`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">Для этой категории автоматических источников нет — добавь цены вручную ниже.</p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <span className="label">Где продавать — раздел FunPay</span>
            <FunpayPicker sc={sc} value={draft.funpay.url} onChange={(url) => updFp({ url, facets: url === draft.funpay.url ? draft.funpay.facets : {} })} />
          </div>
          <FunpayFacets url={draft.funpay.url} value={draft.funpay.facets ?? {}} onChange={(facets) => updFp({ facets })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Фильтр лотов FunPay: слова</span>
              <input
                className="input"
                value={csv(draft.funpay.include)}
                onChange={(e) => updFp({ include: uncsv(e.target.value) })}
                placeholder={draft.category === 'skins' ? 'по умолчанию — точное имя скина' : 'elden ring, ключ'}
              />
            </label>
            <label className="block">
              <span className="label">Фильтр лотов FunPay: исключить</span>
              <input className="input" value={csv(draft.funpay.exclude)} onChange={(e) => updFp({ exclude: uncsv(e.target.value) })} placeholder="аренда, аккаунт" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={draft.funpay.onlineOnly} onChange={(e) => updFp({ onlineOnly: e.target.checked })} />
              Только продавцы онлайн
            </label>
            <label className="flex items-center gap-2 text-muted">
              Отзывов от
              <input
                className="input num w-20 py-1"
                value={draft.funpay.minReviews || ''}
                onChange={(e) => updFp({ minReviews: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              />
            </label>
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={draft.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
              В автоскане
            </label>
          </div>

          <div>
            <span className="label">Цены вручную (сайты без автосбора)</span>
            <div className="space-y-2">
              {draft.manual.map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_90px_80px_auto] gap-2">
                  <select className="input py-1 text-xs" value={m.sourceId} onChange={(e) => setManual(i, { sourceId: e.target.value })}>
                    {manualSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.auto ? '' : ' (вручную)'}
                      </option>
                    ))}
                  </select>
                  <input className="input num py-1 text-xs" placeholder="цена" value={m.price || ''} onChange={(e) => setManual(i, { price: Number(e.target.value.replace(',', '.')) || 0 })} />
                  <select className="input py-1 text-xs" value={m.currency} onChange={(e) => setManual(i, { currency: e.target.value })}>
                    {['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'TRY', 'CNY'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => upd({ manual: draft.manual.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                  <input
                    className="input col-span-4 py-1 text-xs"
                    placeholder="ссылка на товар (необязательно)"
                    value={m.url}
                    onChange={(e) => setManual(i, { url: e.target.value.trim() })}
                  />
                </div>
              ))}
              <button
                className="btn-ghost text-xs"
                onClick={() =>
                  upd({
                    manual: [
                      ...draft.manual,
                      { sourceId: manualSources.find((s) => !s.auto)?.id ?? manualSources[0]?.id ?? '', price: 0, currency: 'RUB', url: '', note: '', updatedAt: new Date().toISOString() },
                    ],
                  })
                }
              >
                + Ручная цена
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => setDraft(null)}>
          Отмена
        </button>
        <button className="btn-ghost" disabled={busy || !draft.query.trim()} onClick={() => onSave(false)}>
          Сохранить
        </button>
        <button className="btn-primary" disabled={busy || !draft.query.trim()} onClick={() => onSave(true)}>
          {busy ? 'Сохраняю…' : 'Сохранить и сканировать'}
        </button>
      </div>
    </Card>
  );
}
