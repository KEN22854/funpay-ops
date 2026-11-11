// Настройки сервера с историей изменений (воспроизводимость расчётов).
import { createHash } from 'node:crypto';
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
  /** Capital & Risk: доли капитала, старение запасов, обучение потерь */
  risk: { maxItemSharePct: 30, maxSourceSharePct: 50, maxCategorySharePct: 70, staleStockDays: 30, lossPriorWeight: 10 },
  /** Profit Verification: сколько минут перепроверка считается действующей и допустимый рост цены */
  verification: { executableTtlMin: 15, priceTolerancePct: 2 },
  /** Строгость сопоставления: skinsStrict all — любой скин подтверждается вручную (float/паттерн/наклейки источник не передаёт) */
  matching: { skinsStrict: 'all' },
  /** Минимум данных для выводов о спросе */
  demand: { minSnapshots: 6, minObservationHours: 24, minOwnSales: 5 },
  /** Paper trading: «бумажные» позиции по рекомендациям, закрытие по рыночной переоценке */
  paper: { enabled: true, horizonDays: 7 },
  /**
   * Политики качества источников: решения по нижней/верхней границе 95% интервала Уилсона,
   * а не по точечной оценке — 3 удачные попытки из 3 не делают источник надёжным.
   */
  sourcePolicy: {
    enabled: true,
    /** меньше попыток закупки — испытательный срок */
    minAttempts: 5,
    /** надёжный: нижние границы точности цены и наличия не ниже */
    trustedLo: 0.85,
    /** надёжный: верхняя граница доли возвратов/споров не выше */
    trustedProblemHi: 0.15,
    /** блок: даже оптимистичная (верхняя) граница точности цены или наличия ниже */
    blockHi: 0.5,
    /** блок: даже пессимистичная (нижняя) граница доли проблемных продаж выше */
    blockProblemLo: 0.2,
    /** множитель лимитов доли капитала и суммы сделки */
    probationLimitFactor: 0.5,
    normalLimitFactor: 0.75,
    /** дополнительная требуемая маржа (чистыми от цены), п.п. */
    probationBufferPct: 5,
    normalBufferPct: 2,
  },
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
  'matching.skinsStrict': ['all', 'pattern'],
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

/**
 * Параметры, действовавшие в момент ts (по истории изменений): ключ берётся из последней записи
 * истории не позже ts, иначе — значение по умолчанию. Для бэктеста без заглядывания в будущее.
 * Возвращает функцию at(ts) — история читается один раз.
 * @param {string} [asOf] учитывать только изменения, сделанные не позже asOf
 */
export function settingsTimeline(asOf = nowIso()) {
  const rows = all('SELECT key, value, changed_at FROM settings_history WHERE changed_at <= ? ORDER BY changed_at, id', asOf);
  const byKey = new Map();
  for (const r of rows) {
    let v;
    try {
      v = JSON.parse(r.value);
    } catch {
      continue;
    }
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push({ ts: r.changed_at, v });
  }
  const cache = new Map();
  const at = (ts) => {
    const stored = {};
    let sig = '';
    for (const [k, list] of byKey) {
      let idx = -1;
      for (let i = 0; i < list.length && list[i].ts <= ts; i++) idx = i;
      if (idx >= 0) stored[k] = list[idx].v;
      sig += k + idx + ';';
    }
    if (!cache.has(sig)) cache.set(sig, validate(coerce(DEFAULT_SETTINGS, deepMerge(DEFAULT_SETTINGS, stored))));
    return cache.get(sig);
  };
  return { at, changes: rows.length };
}

export function settingsAt(ts, asOf) {
  return settingsTimeline(asOf).at(ts);
}

export function settingsHistory(limit = 200) {
  return all('SELECT key, value, changed_at FROM settings_history ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, value: JSON.parse(r.value) }));
}

/**
 * Отпечаток параметров, влияющих на решение (версионирование стратегии):
 * одинаковый хэш — рекомендации и бэктесты сравнимы между собой.
 */
export function settingsHash(s = getSettings()) {
  const relevant = { costModel: s.costModel, pricing: s.pricing, freshness: s.freshness, scoring: s.scoring, risk: s.risk, verification: s.verification, matching: s.matching, demand: s.demand };
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 12);
}
