// Каталог товаров (карточки отслеживания) с обязательными атрибутами + решения по сопоставлению.
import { randomUUID } from 'node:crypto';
import { all, nowIso, one, run, tx } from '../db/db.mjs';
import { audit } from './audit.mjs';
import { PLATFORMS, REGIONS, TYPES, EDITIONS } from '../core/attributes.mjs';

const CATS = ['keys', 'skins', 'currency', 'accounts', 'subscriptions'];
const CURRENCIES = ['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'TRY', 'CNY'];
const str = (v, max = 300) => String(v ?? '').slice(0, max).trim();
const list = (v, max = 30) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((x) => str(x, 100))
    .filter(Boolean)
    .slice(0, max);
const pick = (v, allowed) => (allowed.includes(v) ? v : '');
const pickList = (v, allowed) => list(v).filter((x) => allowed.includes(x));

/** Проверка и очистка входящей карточки товара */
export function sanitizeWatch(w, prev) {
  const category = CATS.includes(w.category) ? w.category : 'keys';
  const query = str(w.query, 200);
  if (!query) throw Object.assign(new Error('нужен поисковый запрос (для скинов — точное английское название из Steam)'), { status: 400 });
  const a = w.attrs ?? {};
  return {
    id: prev?.id ?? randomUUID(),
    createdAt: prev?.createdAt ?? nowIso(),
    name: str(w.name, 120) || query,
    category,
    game: category === 'skins' ? (['cs2', 'dota2', 'rust'].includes(w.game) ? w.game : 'cs2') : null,
    query,
    include: list(w.include),
    exclude: list(w.exclude),
    sources: list(w.sources, 80),
    ignore: list(w.ignore, 500).filter((u) => /^https?:\/\//.test(u)),
    /** обязательные характеристики: пусто — не проверяется */
    attrs: {
      platform: pick(a.platform, PLATFORMS),
      regions: pickList(a.regions, REGIONS),
      type: pick(a.type, TYPES),
      edition: pick(a.edition, EDITIONS),
      phase: str(a.phase, 40),
      requireFloat: Boolean(a.requireFloat),
      server: str(a.server, 80),
    },
    manual: (Array.isArray(w.manual) ? w.manual : []).slice(0, 60).map((m) => ({
      sourceId: str(m.sourceId, 60),
      price: Math.max(0, Number(m.price) || 0),
      currency: CURRENCIES.includes(m.currency) ? m.currency : 'RUB',
      url: /^https?:\/\//.test(m.url ?? '') ? str(m.url, 500) : '',
      note: str(m.note, 120),
      stock: m.stock === null || m.stock === undefined || m.stock === '' ? null : Math.max(0, Math.floor(Number(m.stock) || 0)),
      region: pick(m.region, REGIONS),
      platform: pick(m.platform, PLATFORMS),
      type: pick(m.type, TYPES),
      updatedAt: m.updatedAt ?? nowIso(),
    })),
    funpay: {
      url: str(w.funpay?.url, 300),
      include: list(w.funpay?.include),
      exclude: list(w.funpay?.exclude),
      onlineOnly: Boolean(w.funpay?.onlineOnly),
      minReviews: Math.max(0, Math.floor(Number(w.funpay?.minReviews) || 0)),
      facets: Object.fromEntries(
        Object.entries(w.funpay?.facets && typeof w.funpay.facets === 'object' ? w.funpay.facets : {})
          .slice(0, 20)
          .map(([k, v]) => [str(k, 40), (Array.isArray(v) ? v : []).map((x) => str(x, 100).toLowerCase()).filter(Boolean).slice(0, 50)])
          .filter(([k, v]) => /^[\w-]+$/.test(k) && v.length),
      ),
    },
    enabled: w.enabled !== false,
  };
}

const parse = (r) => (r ? JSON.parse(r.data) : null);

export const watches = {
  list: () => all('SELECT data FROM watches ORDER BY created_at DESC').map(parse),
  get: (id) => parse(one('SELECT data FROM watches WHERE id = ?', id)),
  upsert(input) {
    const prev = input.id ? watches.get(input.id) : null;
    const w = sanitizeWatch(input, prev);
    const now = nowIso();
    run(
      'INSERT INTO watches(id, data, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      w.id,
      JSON.stringify(w),
      w.createdAt,
      now,
    );
    audit(prev ? 'watch.update' : 'watch.create', 'watch', w.id, { name: w.name, attrs: w.attrs, funpay: w.funpay.url });
    return w;
  },
  remove(id) {
    tx(() => {
      run('DELETE FROM watches WHERE id = ?', id);
      run('DELETE FROM price_snapshots WHERE watch_id = ?', id);
      run('DELETE FROM funpay_lots_seen WHERE watch_id = ?', id);
    });
    audit('watch.delete', 'watch', id);
  },
};

export const results = {
  get: (id) => parse(one('SELECT data FROM scan_results WHERE watch_id = ?', id)),
  all: () => Object.fromEntries(all('SELECT watch_id, data FROM scan_results').map((r) => [r.watch_id, JSON.parse(r.data)])),
  set: (id, r) =>
    run(
      'INSERT INTO scan_results(watch_id, data, finished_at) VALUES (?, ?, ?) ON CONFLICT(watch_id) DO UPDATE SET data = excluded.data, finished_at = excluded.finished_at',
      id,
      JSON.stringify(r),
      r.finishedAt,
    ),
};

export const discoveries = {
  all: () => Object.fromEntries(all('SELECT key, data FROM discoveries').map((r) => [r.key, JSON.parse(r.data)])),
  set: (key, d) =>
    run('INSERT INTO discoveries(key, data, scanned_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, scanned_at = excluded.scanned_at', key, JSON.stringify(d), d.scannedAt),
};

export const decisions = {
  forWatch: (watchId) => Object.fromEntries(all('SELECT offer_url, status, reason, side, decided_at FROM match_decisions WHERE watch_id = ?', watchId).map((r) => [r.offer_url, r])),
  set(watchId, offerUrl, side, status, reason) {
    if (!['VERIFIED', 'REJECTED', 'CLEAR'].includes(status)) throw Object.assign(new Error('status: VERIFIED | REJECTED | CLEAR'), { status: 400 });
    if (!watches.get(watchId)) throw Object.assign(new Error('товар не найден'), { status: 404 });
    if (!/^https?:\/\//.test(offerUrl ?? '')) throw Object.assign(new Error('нужна ссылка предложения'), { status: 400 });
    if (status === 'CLEAR') run('DELETE FROM match_decisions WHERE watch_id = ? AND offer_url = ?', watchId, offerUrl);
    else
      run(
        'INSERT INTO match_decisions(watch_id, offer_url, side, status, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(watch_id, offer_url) DO UPDATE SET status = excluded.status, reason = excluded.reason, decided_at = excluded.decided_at',
        watchId,
        offerUrl,
        side === 'funpay' ? 'funpay' : 'source',
        status,
        str(reason, 300) || null,
        nowIso(),
      );
    audit('match.decision', 'watch', watchId, { offerUrl, side, status, reason });
    return { ok: true };
  },
};
