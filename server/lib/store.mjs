// Хранилище сервера: список отслеживания, результаты сканов, настройки. Обычный JSON-файл.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// data/ в корне проекта, НЕ внутри server/: иначе `node --watch-path=server` перезапускал бы сервер на каждое сохранение
const FILE = process.env.FPO_DATA || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'state.json');

const DEFAULT = { watches: [], results: {}, discoveries: {}, settings: { intervalMin: 30 } };

let state = load();

function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'));
    return { ...DEFAULT, ...s, settings: { ...DEFAULT.settings, ...s.settings } };
  } catch {
    return structuredClone(DEFAULT);
  }
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, FILE); // атомарно: файл не побьётся при падении посреди записи
}

const CATS = ['keys', 'skins', 'currency', 'accounts'];
const str = (v, max = 300) => String(v ?? '').slice(0, max).trim();
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => str(x, 100)).filter(Boolean).slice(0, 30);

/** Проверка и очистка входящего товара */
export function sanitizeWatch(w, prev) {
  const category = CATS.includes(w.category) ? w.category : 'keys';
  const query = str(w.query, 200);
  if (!query) throw new Error('нужен поисковый запрос (для скинов — точное английское название из Steam)');
  return {
    id: prev?.id ?? randomUUID(),
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    name: str(w.name, 120) || query,
    category,
    game: category === 'skins' ? (['cs2', 'dota2', 'rust'].includes(w.game) ? w.game : 'cs2') : null,
    query,
    include: list(w.include),
    exclude: list(w.exclude),
    sources: list(w.sources),
    /** ссылки предложений, которые пользователь скрыл как «не тот товар» */
    ignore: (Array.isArray(w.ignore) ? w.ignore : []).map((u) => str(u, 500)).filter((u) => /^https?:\/\//.test(u)).slice(0, 500),
    manual: (Array.isArray(w.manual) ? w.manual : []).slice(0, 60).map((m) => ({
      sourceId: str(m.sourceId, 60),
      price: Math.max(0, Number(m.price) || 0),
      currency: ['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'TRY', 'CNY'].includes(m.currency) ? m.currency : 'RUB',
      url: /^https?:\/\//.test(m.url ?? '') ? str(m.url, 500) : '',
      note: str(m.note, 120),
      updatedAt: m.updatedAt ?? new Date().toISOString(),
    })),
    funpay: {
      url: str(w.funpay?.url, 300),
      include: list(w.funpay?.include),
      exclude: list(w.funpay?.exclude),
      onlineOnly: Boolean(w.funpay?.onlineOnly),
      minReviews: Math.max(0, Math.floor(Number(w.funpay?.minReviews) || 0)),
      /** фильтры раздела FunPay: ключ → допустимые значения (в нижнем регистре, как в data-f-*) */
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

export const db = {
  get: () => state,
  watches: () => state.watches,
  upsertWatch(input) {
    const i = state.watches.findIndex((w) => w.id === input.id);
    const w = sanitizeWatch(input, i >= 0 ? state.watches[i] : null);
    if (i >= 0) state.watches[i] = w;
    else state.watches.unshift(w);
    save();
    return w;
  },
  removeWatch(id) {
    state.watches = state.watches.filter((w) => w.id !== id);
    delete state.results[id];
    save();
  },
  setResult(id, r) {
    state.results[id] = r;
    save();
  },
  setDiscovery(key, r) {
    state.discoveries[key] = r;
    save();
  },
  settings: () => state.settings,
  setSettings(p) {
    const n = Number(p.intervalMin);
    state.settings.intervalMin = Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.round(n))) : state.settings.intervalMin;
    save();
    return state.settings;
  },
};
