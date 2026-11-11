import { useMemo, useState } from 'react';
import { Badge, Card, Empty, Warning } from '../../components/ui';
import type { Category, ManualPrice, Match, SkinGame, Watch, WatchAttrs } from '../../lib/api';
import { fmtDateTime, fmtRub } from '../../lib/format';
import { FunpayFacets } from './FunpayFacets';
import { FunpayPicker } from './FunpayPicker';
import { CATEGORY_LABEL, MATCH_LABEL, MATCH_TONE, type ScannerState } from './useScanner';

type Draft = Omit<Watch, 'id' | 'createdAt'> & { id?: string };

const EMPTY_ATTRS: WatchAttrs = { platform: '', regions: [], type: '', edition: '', phase: '', requireFloat: false, floatMin: null, floatMax: null, server: '', paintSeeds: [], stickers: [], durationDays: null };

/** что определяет «тот же товар» в категории (совпадает со схемами сервера) */
const SCHEMA_HINT: Partial<Record<Category, { required: (keyof WatchAttrs)[]; note: string }>> = {
  keys: { required: ['type', 'platform', 'regions'], note: 'тип (ключ/подарок), платформа и регион активации; издание — если цена зависит' },
  subscriptions: { required: ['durationDays', 'regions'], note: 'срок подписки и регион' },
  currency: { required: ['server'], note: 'сервер/регион игры' },
  accounts: { required: ['platform', 'regions'], note: 'платформа и регион аккаунта' },
};
const ATTR_LABEL: Partial<Record<keyof WatchAttrs, string>> = { type: 'тип', platform: 'платформа', regions: 'регион', durationDays: 'срок', server: 'сервер' };
const missingAttrs = (c: Category, a: WatchAttrs) =>
  (SCHEMA_HINT[c]?.required ?? []).filter((k) => {
    const v = a[k];
    return v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });

const blank = (): Draft => ({
  name: '',
  category: 'keys',
  game: null,
  query: '',
  include: [],
  exclude: [],
  sources: [],
  ignore: [],
  attrs: { ...EMPTY_ATTRS },
  manual: [],
  funpay: { url: '', include: [], exclude: [], onlineOnly: false, minReviews: 0, facets: {} },
  enabled: true,
});

const PLATFORMS = [
  ['', 'любая'],
  ['pc', 'PC'],
  ['ps', 'PlayStation'],
  ['xbox', 'Xbox'],
  ['switch', 'Switch'],
  ['mobile', 'Mobile'],
] as const;
const REGIONS = [
  ['ru', 'РФ'],
  ['cis', 'СНГ'],
  ['global', 'Global'],
  ['eu', 'Европа'],
  ['us', 'США'],
  ['tr', 'Турция'],
  ['kz', 'Казахстан'],
  ['ua', 'Украина'],
  ['by', 'Беларусь'],
  ['ar', 'Аргентина'],
] as const;
const TYPES = [
  ['', 'не проверять'],
  ['key', 'ключ'],
  ['gift', 'подарок'],
  ['account', 'аккаунт'],
  ['topup', 'пополнение'],
  ['currency', 'валюта'],
  ['item', 'предмет'],
  ['service', 'услуга'],
] as const;
const EDITIONS = ['', 'standard', 'deluxe', 'ultimate', 'gold', 'premium', 'complete', 'goty', 'collector', 'definitive', 'legendary'];

const QUERY_HINT: Record<Category, string> = {
  keys: 'Название игры, как в магазинах: «Elden Ring». Обязательно задайте атрибуты ниже — по одному названию товары не сопоставляются.',
  skins: 'Точное английское market_hash_name из Steam: «AK-47 | Redline (Field-Tested)».',
  currency: 'Например «WoW gold». Автоматически — только Plati; цены других площадок вводите вручную ЗА ТО ЖЕ количество, что в колонке цены FunPay.',
  accounts: 'Аккаунты уникальны — автоматически только Plati, остальное вручную.',
  subscriptions: 'Название подписки, срок и регион укажите в атрибутах/словах.',
};

const TYPICAL_EXCLUDE = ['аренда', 'аренду', 'rent', 'аккаунт', 'account', 'steam guard', 'offline', 'оффлайн', 'офлайн', 'общий', 'shared'];

const SKIN_GAMES: { id: SkinGame; name: string }[] = [
  { id: 'cs2', name: 'Counter-Strike 2' },
  { id: 'dota2', name: 'Dota 2' },
  { id: 'rust', name: 'Rust' },
];

const csv = (a: string[]) => a.join(', ');
const uncsv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function MatchBadge({ m }: { m?: Match }) {
  if (!m) return null;
  return (
    <span title={m.reasons.map((r) => `${r.ok === true ? '✓' : r.ok === false ? '✕' : '?'} ${r.text}`).join('\n')}>
      <Badge tone={MATCH_TONE[m.status]}>
        {MATCH_LABEL[m.status]}
        {m.source === 'manual' && ' ✎'}
      </Badge>
    </span>
  );
}

export function Watches({ sc }: { sc: ScannerState }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all');

  const srcName = useMemo(() => Object.fromEntries(sc.sources.map((s) => [s.id, s.name])), [sc.sources]);
  const visible = sc.watches.filter((w) => catFilter === 'all' || w.category === catFilter);
  const working = sc.health?.working;

  const guard = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = (andScan: boolean) =>
    guard('save', async () => {
      if (!draft) return;
      const w = await sc.saveWatch(draft);
      setDraft(null);
      if (andScan) {
        setOpen(w.id);
        setBusy(w.id);
        await sc.scan(w.id);
      }
    });

  const decide = (w: Watch, url: string, side: 'source' | 'funpay', status: 'VERIFIED' | 'REJECTED' | 'CLEAR') =>
    guard(w.id, () => sc.decide(w.id, url, side, status, status === 'VERIFIED' ? 'проверено вручную' : status === 'REJECTED' ? 'не тот товар' : undefined));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => setDraft(blank())}>
          + Товар
        </button>
        <button className="btn-ghost" disabled={!sc.watches.length || Boolean(working)} onClick={() => sc.scanAll()}>
          {working || sc.health?.queue.length ? `Сканирую… (в очереди ${(sc.health?.queue.length ?? 0) + (working ? 1 : 0)})` : 'Сканировать всё'}
        </button>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          Автоскан каждые
          <select className="input w-auto py-1" value={sc.settings?.intervalMin ?? 30} onChange={(e) => sc.saveSettings({ intervalMin: Number(e.target.value) })}>
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
      <p className="text-xs text-muted">
        Интервал адаптивный: если цена на FunPay не меняется, товар сканируется реже (до 4× интервала). Сервер должен быть запущен.
      </p>
      {error && <Warning tone="bad">{error}</Warning>}

      {draft && <WatchForm sc={sc} draft={draft} setDraft={setDraft} onSave={save} busy={busy === 'save'} />}

      {visible.length === 0 && !draft && <Empty>Каталог пуст. Добавьте товар: что искать у источников, обязательные характеристики и раздел FunPay для продажи.</Empty>}

      {visible.map((w) => {
        const r = sc.results[w.id];
        const fp = r?.funpay;
        const allOffers = r ? [...r.sources.flatMap((s) => s.offers), ...r.manual] : [];
        const verified = allOffers.filter((o) => o.match?.status === 'VERIFIED').length;
        const review = allOffers.filter((o) => o.match?.status === 'REVIEW_REQUIRED').length;
        const attrsSet = [w.attrs?.platform, w.attrs?.regions?.length, w.attrs?.type, w.attrs?.edition].filter(Boolean).length;
        return (
          <div key={w.id} className="card">
            <div className="flex flex-wrap items-center gap-3 p-4">
              <button className="flex-1 text-left" onClick={() => setOpen(open === w.id ? null : w.id)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{w.name}</span>
                  <Badge tone="muted">{CATEGORY_LABEL[w.category]}</Badge>
                  {!w.enabled && <Badge tone="warn">выкл.</Badge>}
                  {w.category !== 'skins' && !attrsSet && <Badge tone="warn">атрибуты не заданы</Badge>}
                </div>
                <div className="num mt-1 text-xs text-muted">
                  {r ? (
                    <>
                      {fmtDateTime(r.finishedAt)} · совпадает {verified}, проверить {review}
                      {fp?.status === 'ok' && ` · FunPay: ${fp.min === null ? 'нет подходящих' : `мин. ${fmtRub(fp.min)}`} (${fp.count} из ${fp.total}${fp.rejected ? `, отклонено ${fp.rejected}` : ''})`}
                      {fp?.status === 'error' && <span className="text-bad"> · FunPay: {fp.error}</span>}
                      {!fp && <span className="text-warn"> · не выбран раздел FunPay</span>}
                    </>
                  ) : (
                    'ещё не сканировался'
                  )}
                </div>
              </button>
              <div className="flex gap-2">
                <button className="btn-ghost text-xs" disabled={busy === w.id || working === w.id} onClick={() => guard(w.id, () => sc.scan(w.id).then(() => setOpen(w.id)))}>
                  {busy === w.id || working === w.id ? 'Сканирую…' : 'Сканировать'}
                </button>
                <button className="btn-ghost text-xs" onClick={() => setDraft({ ...w, attrs: { ...EMPTY_ATTRS, ...w.attrs } })}>
                  Изменить
                </button>
                <button className="btn-danger text-xs" onClick={() => confirm(`Удалить «${w.name}» из каталога вместе с историей цен?`) && sc.removeWatch(w.id)}>
                  ✕
                </button>
              </div>
            </div>

            {open === w.id && r && (
              <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Источники и совпадение</h3>
                  <div className="max-h-[28rem] overflow-auto">
                    <table className="table">
                      <tbody>
                        {r.sources
                          .filter((s) => s.status !== 'empty')
                          .map((s) => (
                            <tr key={s.sourceId}>
                              <td className="whitespace-nowrap align-top text-xs">{srcName[s.sourceId] ?? s.sourceId}</td>
                              <td>
                                {s.status === 'error' ? (
                                  <span className="text-xs text-bad">
                                    {s.error} <span className="text-muted">[{s.errorClass}]</span>
                                  </span>
                                ) : (
                                  <ul className="space-y-1.5">
                                    {s.offers.map((o) => (
                                      <OfferRow key={o.url} title={o.title} url={o.url} price={o.priceRub} match={o.match} extra={o.phase ? `фаза: ${o.phase}` : undefined} onDecide={(st) => decide(w, o.url, 'source', st)} />
                                    ))}
                                    {s.rejected > 0 && <li className="text-xs text-muted">отклонено правилами: {s.rejected}</li>}
                                  </ul>
                                )}
                              </td>
                            </tr>
                          ))}
                        {r.manual.map((m) => (
                          <tr key={'m' + m.sourceId + m.price}>
                            <td className="whitespace-nowrap align-top text-xs">
                              {srcName[m.sourceId] ?? m.sourceId} <span className="text-muted">(вручную)</span>
                            </td>
                            <td>
                              <OfferRow title={m.title} url={m.url} price={m.priceRub} match={m.match} extra={m.currency !== 'RUB' ? `${m.price} ${m.currency}` : undefined} onDecide={(st) => decide(w, m.url, 'source', st)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {r.sources.filter((s) => s.status === 'empty').length > 0 && (
                      <p className="mt-2 text-xs text-muted">Не найдено: {r.sources.filter((s) => s.status === 'empty').map((s) => srcName[s.sourceId] ?? s.sourceId).join(', ')}</p>
                    )}
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">FunPay — конкуренты</h3>
                  {fp?.status === 'ok' ? (
                    <>
                      <p className="mb-2 text-xs text-muted">
                        {fp.title} · фильтры пропустили {fp.filtered} из {fp.total}, по атрибутам отклонено {fp.rejected}
                        {fp.observedFee && ` · в заголовке раздела: комиссия ${fp.observedFee.pct}% (записана в профили)`}
                      </p>
                      <ul className="max-h-[26rem] space-y-1.5 overflow-auto">
                        {fp.top.map((o) => (
                          <OfferRow
                            key={o.url}
                            title={o.desc || [o.server, o.side].filter(Boolean).join(' · ') || o.seller}
                            url={o.url}
                            price={o.price}
                            match={o.match}
                            extra={`${o.online ? '● онлайн' : '○'} ${o.seller} · ${o.reviews} отз.`}
                            onDecide={(st) => decide(w, o.url, 'funpay', st)}
                          />
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-xs text-muted">{fp?.status === 'error' ? fp.error : 'Раздел FunPay не задан.'}</p>
                  )}
                  {w.ignore.length > 0 && (
                    <details className="mt-3 text-xs text-muted">
                      <summary className="cursor-pointer">Скрыто: {w.ignore.length}</summary>
                      <ul className="mt-1 space-y-1">
                        {w.ignore.map((u) => (
                          <li key={u} className="flex gap-2">
                            <span className="num truncate">{u}</span>
                            <button className="text-accent hover:underline" onClick={() => sc.saveWatch({ ...w, ignore: w.ignore.filter((x) => x !== u) })}>
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

function OfferRow({ title, url, price, match, extra, onDecide }: { title: string; url: string; price: number; match?: Match; extra?: string; onDecide: (s: 'VERIFIED' | 'REJECTED' | 'CLEAR') => void }) {
  return (
    <li className="text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline" title={title}>
          {title}
        </a>
        <span className="num shrink-0">{fmtRub(price)}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <MatchBadge m={match} />
        {match && match.status !== 'VERIFIED' && match.reasons.find((r) => r.ok !== true) && <span className="text-muted">{match.reasons.find((r) => r.ok !== true)!.text}</span>}
        {extra && <span className="text-muted">{extra}</span>}
        <span className="ml-auto flex gap-2">
          {match?.source === 'manual' ? (
            <button className="text-muted hover:text-fg" onClick={() => onDecide('CLEAR')}>
              сбросить решение
            </button>
          ) : (
            <>
              <button className="text-good hover:underline" onClick={() => onDecide('VERIFIED')} title="Я проверил: это тот же товар">
                ✓ тот
              </button>
              <button className="text-bad hover:underline" onClick={() => onDecide('REJECTED')} title="Не тот товар">
                ✕ не тот
              </button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

function WatchForm({ sc, draft, setDraft, onSave, busy }: { sc: ScannerState; draft: Draft; setDraft: (d: Draft | null) => void; onSave: (scan: boolean) => void; busy: boolean }) {
  const upd = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const updA = (p: Partial<WatchAttrs>) => setDraft({ ...draft, attrs: { ...draft.attrs, ...p } });
  const updFp = (p: Partial<Draft['funpay']>) => setDraft({ ...draft, funpay: { ...draft.funpay, ...p } });
  const autoSources = sc.sources.filter((s) => s.auto && s.categories.includes(draft.category));
  const manualSources = sc.sources.filter((s) => s.categories.includes(draft.category));
  const selected = new Set(draft.sources.length ? draft.sources : autoSources.map((s) => s.id));

  const toggleSource = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    upd({ sources: next.size === autoSources.length ? [] : [...next] });
  };
  const setManual = (i: number, p: Partial<ManualPrice>) => upd({ manual: draft.manual.map((m, j) => (j === i ? { ...m, ...p, updatedAt: new Date().toISOString() } : m)) });

  return (
    <Card title={draft.id ? 'Изменить товар' : 'Новый товар'} className="border-accent/50">
      <div className="grid gap-5 lg:grid-cols-2">
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
                <span className="label">Название в каталоге</span>
                <input className="input" value={draft.name} onChange={(e) => upd({ name: e.target.value })} placeholder="как будет в складе и продажах" />
              </label>
            )}
          </div>
          <label className="block">
            <span className="label">Что искать у источников</span>
            <input className="input" value={draft.query} onChange={(e) => upd({ query: e.target.value })} />
            <span className="mt-1 block text-xs text-muted">{QUERY_HINT[draft.category]}</span>
          </label>

          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <span className="label">Обязательные характеристики</span>
            <p className="mb-2 text-xs text-muted">Несовпадение → «не совпадает» (блок). Не указано у продавца → «проверить». Рекомендация — только при полном совпадении.</p>
            {SCHEMA_HINT[draft.category] && (
              <p className={`mb-2 text-xs ${missingAttrs(draft.category, draft.attrs).length ? 'text-warn' : 'text-good'}`}>
                Для категории важны: {SCHEMA_HINT[draft.category]!.note}.
                {missingAttrs(draft.category, draft.attrs).length > 0 && ` Не задано: ${missingAttrs(draft.category, draft.attrs).map((k) => ATTR_LABEL[k] ?? k).join(', ')} — пары будут сверяться только по названию.`}
              </p>
            )}
            {draft.category === 'skins' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="label">Фаза (Doppler и т.п.)</span>
                  <input className="input" value={draft.attrs.phase} onChange={(e) => updA({ phase: e.target.value })} placeholder="Phase 2, Ruby…" />
                </label>
                <label className="mt-6 flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={draft.attrs.requireFloat} onChange={(e) => updA({ requireFloat: e.target.checked })} />
                  Важен float / паттерн
                </label>
                <label className="block">
                  <span className="label">Float от</span>
                  <input className="input num" inputMode="decimal" placeholder="0.15" value={draft.attrs.floatMin ?? ''} onChange={(e) => updA({ floatMin: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')) })} />
                </label>
                <label className="block">
                  <span className="label">Float до</span>
                  <input className="input num" inputMode="decimal" placeholder="0.18" value={draft.attrs.floatMax ?? ''} onChange={(e) => updA({ floatMax: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')) })} />
                </label>
                <label className="block">
                  <span className="label">Paint seed (через запятую)</span>
                  <input
                    className="input num"
                    placeholder="661, 670"
                    key={`ps-${draft.id ?? 'new'}`}
                    defaultValue={draft.attrs.paintSeeds.join(', ')}
                    onBlur={(e) => updA({ paintSeeds: e.target.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 1000) })}
                  />
                </label>
                <label className="block">
                  <span className="label">Обязательные наклейки</span>
                  <input className="input" placeholder="Titan Katowice 2014" key={`st-${draft.id ?? 'new'}`} defaultValue={draft.attrs.stickers.join(', ')} onBlur={(e) => updA({ stickers: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                </label>
                <p className="text-xs text-muted sm:col-span-2">
                  Лоты FunPay с указанным float вне диапазона не учитываются в цене конкурентов. У площадок-источников float в выгрузках нет — такие пары подтверждаются вручную.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="label">Платформа</span>
                  <select className="input" value={draft.attrs.platform} onChange={(e) => updA({ platform: e.target.value })}>
                    {PLATFORMS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Тип товара</span>
                  <select className="input" value={draft.attrs.type} onChange={(e) => updA({ type: e.target.value })}>
                    {TYPES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Издание</span>
                  <select className="input" value={draft.attrs.edition} onChange={(e) => updA({ edition: e.target.value })}>
                    {EDITIONS.map((v) => (
                      <option key={v} value={v}>
                        {v || 'не проверять'}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sm:col-span-3">
                  <span className="label">Регионы, которые подходят</span>
                  <div className="flex flex-wrap gap-1.5">
                    {REGIONS.map(([v, l]) => {
                      const on = draft.attrs.regions.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          className={`rounded-md border px-2 py-1 text-xs ${on ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted'}`}
                          onClick={() => updA({ regions: on ? draft.attrs.regions.filter((x) => x !== v) : [...draft.attrs.regions, v] })}
                        >
                          {l}
                        </button>
                      );
                    })}
                  </div>
                  <span className="mt-1 block text-xs text-muted">Global подходит к любому выбранному региону.</span>
                </div>
                {draft.category === 'subscriptions' && (
                  <label className="block">
                    <span className="label">Срок подписки</span>
                    <select className="input" value={draft.attrs.durationDays ?? ''} onChange={(e) => updA({ durationDays: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">не проверять</option>
                      {[
                        [7, '7 дней'],
                        [30, '1 месяц'],
                        [90, '3 месяца'],
                        [180, '6 месяцев'],
                        [365, '12 месяцев'],
                      ].map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.category === 'currency' && (
                  <label className="block sm:col-span-3">
                    <span className="label">Сервер</span>
                    <input className="input" value={draft.attrs.server} onChange={(e) => updA({ server: e.target.value })} />
                  </label>
                )}
              </div>
            )}
          </div>

          {draft.category !== 'skins' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Обязательные слова</span>
                <input className="input" value={csv(draft.include)} onChange={(e) => upd({ include: uncsv(e.target.value) })} placeholder="по умолчанию — слова запроса" />
              </label>
              <label className="block">
                <span className="label">Исключить слова</span>
                <input className="input" value={csv(draft.exclude)} onChange={(e) => upd({ exclude: uncsv(e.target.value) })} placeholder="dlc, deluxe" />
                <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={() => upd({ exclude: [...new Set([...draft.exclude, ...TYPICAL_EXCLUDE])] })}>
                  + типовые исключения
                </button>
              </label>
            </div>
          )}

          <div>
            <span className="label">
              Автоматические источники ({selected.size}/{autoSources.length})
            </span>
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
              <p className="text-xs text-muted">Для этой категории автоматических источников нет — добавьте цены вручную.</p>
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
              <span className="label">Лоты FunPay: слова</span>
              <input className="input" value={csv(draft.funpay.include)} onChange={(e) => updFp({ include: uncsv(e.target.value) })} placeholder={draft.category === 'skins' ? 'по умолчанию — точное имя' : ''} />
            </label>
            <label className="block">
              <span className="label">Лоты FunPay: исключить</span>
              <input className="input" value={csv(draft.funpay.exclude)} onChange={(e) => updFp({ exclude: uncsv(e.target.value) })} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={draft.funpay.onlineOnly} onChange={(e) => updFp({ onlineOnly: e.target.checked })} />
              Только онлайн
            </label>
            <label className="flex items-center gap-2 text-muted">
              Отзывов от
              <input className="input num w-20 py-1" value={draft.funpay.minReviews || ''} onChange={(e) => updFp({ minReviews: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </label>
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={draft.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
              В автоскане
            </label>
          </div>

          <div>
            <span className="label">Цены вручную</span>
            <div className="space-y-3">
              {draft.manual.map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_90px_80px_auto] gap-2 rounded-lg border border-line p-2">
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
                  <select className="input py-1 text-xs" value={m.region} onChange={(e) => setManual(i, { region: e.target.value })}>
                    <option value="">регион ?</option>
                    {REGIONS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <select className="input py-1 text-xs" value={m.type} onChange={(e) => setManual(i, { type: e.target.value })}>
                    {TYPES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {v ? l : 'тип ?'}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input num py-1 text-xs"
                    placeholder="наличие"
                    value={m.stock ?? ''}
                    onChange={(e) => setManual(i, { stock: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                  />
                  <span />
                  <input className="input col-span-4 py-1 text-xs" placeholder="ссылка на товар" value={m.url} onChange={(e) => setManual(i, { url: e.target.value.trim() })} />
                </div>
              ))}
              <button
                className="btn-ghost text-xs"
                onClick={() =>
                  upd({
                    manual: [
                      ...draft.manual,
                      {
                        sourceId: manualSources.find((s) => !s.auto)?.id ?? manualSources[0]?.id ?? '',
                        price: 0,
                        currency: 'RUB',
                        url: '',
                        note: '',
                        stock: null,
                        region: '',
                        platform: draft.attrs.platform,
                        type: '',
                        updatedAt: new Date().toISOString(),
                      },
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
