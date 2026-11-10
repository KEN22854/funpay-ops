// Настройки сервера с историей изменений (воспроизводимость расчётов).
import { all, nowIso, one, run, tx } from '../db/db.mjs';
import { audit } from './audit.mjs';

export const DEFAULT_SETTINGS = {
  intervalMin: 30,
  /** модель затрат прогноза */
  costModel: {
    /** deduct: продавец получает P×(1−X); addon: FunPay добавляет X сверху, продавец получает P/(1+X) */
    feeModel: 'deduct',
    defaultSaleFeePct: 5,
    withdrawPct: 0,
    fxSpreadPct: 0,
    taxPct: 0,
    /** payout — налог с полученных денег (НПД); profit — с прибыли */
    taxBase: 'payout',
    disputePct: 0,
    minutesPerOrder: 0,
    hourlyRate: 0,
    extraFulfillmentRub: 0,
    /** стоимость замороженных денег, % годовых */
    capitalRatePct: 0,
    /** срок продажи по умолчанию, если своей истории нет */
    expectedDaysToSell: 3,
  },
  pricing: { undercutPct: 0, undercutRub: 1, minCompetitors: 3 },
  freshness: { funpayTtlMin: 60, sourceTtlMin: 120, manualTtlH: 24 },
  scoring: {
    weights: { match: 25, margin: 20, liquidity: 15, reliability: 10, competition: 10, freshness: 10, risk: 5, availability: 5 },
    minScore: 50,
    /** закупка дешевле этого % от цены FunPay — почти всегда не тот товар */
    suspiciousPct: 25,
    /** нужна ли проверка остатков у источника (неизвестный остаток — блок) */
    requireKnownStock: false,
  },
  inventory: { costMethod: 'fifo', allowNegative: false, startingCapital: 0, maxPurchaseRub: 0, lowStockQty: 1 },
  analytics: { abcA: 80, abcB: 95, xyzX: 0.1, xyzY: 0.25 },
  notify: { enabled: false, chatIds: [], minNet: 100, competitorDropPct: 10, sourceDownMin: 30 },
  backup: { enabled: true, everyH: 24, keep: 14 },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base && isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  return out;
}

/** приводит значение к типу и диапазону значения по умолчанию */
function coerce(def, v) {
  if (typeof def === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : def;
  }
  if (typeof def === 'boolean') return Boolean(v);
  if (typeof def === 'string') return typeof v === 'string' ? v.slice(0, 40) : def;
  if (Array.isArray(def)) return Array.isArray(v) ? v.map((x) => String(x).slice(0, 40)).slice(0, 20) : def;
  if (isObj(def)) {
    const out = {};
    for (const k of Object.keys(def)) out[k] = coerce(def[k], isObj(v) ? v[k] : undefined);
    return out;
  }
  return def;
}

const ENUMS = {
  'costModel.feeModel': ['deduct', 'addon'],
  'costModel.taxBase': ['payout', 'profit'],
  'inventory.costMethod': ['fifo', 'avg'],
};

function validate(s) {
  for (const [path, allowed] of Object.entries(ENUMS)) {
    const [a, b] = path.split('.');
    if (!allowed.includes(s[a][b])) s[a][b] = DEFAULT_SETTINGS[a][b];
  }
  for (const k of ['defaultSaleFeePct', 'withdrawPct', 'taxPct', 'disputePct', 'fxSpreadPct']) s.costModel[k] = Math.min(99, s.costModel[k]);
  s.intervalMin = Math.min(1440, Math.round(s.intervalMin));
  return s;
}

export function getSettings() {
  const stored = {};
  for (const r of all('SELECT key, value FROM settings')) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      /* битое значение — берём по умолчанию */
    }
  }
  return validate(coerce(DEFAULT_SETTINGS, deepMerge(DEFAULT_SETTINGS, stored)));
}

export function updateSettings(patch) {
  const next = validate(coerce(DEFAULT_SETTINGS, deepMerge(getSettings(), patch ?? {})));
  const now = nowIso();
  tx(() => {
    for (const [k, v] of Object.entries(next)) {
      const val = JSON.stringify(v);
      const prev = one('SELECT value FROM settings WHERE key = ?', k)?.value;
      if (prev === val) continue;
      run('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', k, val, now);
      run('INSERT INTO settings_history(key, value, changed_at) VALUES (?, ?, ?)', k, val, now);
      audit('settings.update', 'settings', k, v);
    }
  });
  return next;
}

export function settingsHistory(limit = 200) {
  return all('SELECT key, value, changed_at FROM settings_history ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, value: JSON.parse(r.value) }));
}
