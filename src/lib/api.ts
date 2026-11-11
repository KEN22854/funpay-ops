// Клиент локального сервера (server/index.mjs). Vite проксирует /api → 127.0.0.1:5181.

export type Category = 'keys' | 'skins' | 'currency' | 'accounts' | 'subscriptions';
export type SkinGame = 'cs2' | 'dota2' | 'rust';
export type Mode = 'real' | 'sim';
export type MatchStatus = 'VERIFIED' | 'REVIEW_REQUIRED' | 'REJECTED';
export type OppStatus = 'RECOMMENDED' | 'CANDIDATE' | 'REVIEW' | 'BLOCKED';

export interface SourceInfo {
  id: string;
  name: string;
  url: string;
  categories: Category[];
  method: 'api' | 'feed' | 'html' | 'aggregator' | 'manual';
  note: string;
  auto: boolean;
  known: { platform?: string; region?: string; type?: string };
}

export interface Health {
  sourceId: string;
  calls: number;
  status: 'ok' | 'degraded' | 'failing' | 'circuit_open' | 'unknown';
  successRate?: number;
  errors?: Record<string, number>;
  latencyMedianMs?: number | null;
  lastSuccess?: string | null;
  freshnessMin?: number | null;
  lastError?: { ts: string; class: string; http: number | null; detail: string | null } | null;
  emptyStreak?: number;
  reliability?: number;
  circuitOpenUntil?: string | null;
}

export interface Match {
  status: MatchStatus;
  source: 'rules' | 'manual';
  reasons: { ok: boolean | null; text: string }[];
}

export interface Offer {
  sourceId: string;
  title: string;
  price: number;
  currency: string;
  priceRub: number;
  fxRate?: number;
  url: string;
  stock?: number | null;
  manual?: boolean;
  fetchedAt?: string;
  phase?: string | null;
  match: Match;
  /** проблемы качества данных котировки */
  dq?: string[];
}

export interface FunpayOffer {
  url: string;
  online: boolean;
  desc: string;
  server: string;
  side: string;
  seller: string;
  reviews: number;
  amount: number | null;
  price: number;
  filters: Record<string, string>;
  match?: Match;
}

export interface ManualPrice {
  sourceId: string;
  price: number;
  currency: string;
  url: string;
  note: string;
  stock: number | null;
  region: string;
  platform: string;
  type: string;
  updatedAt?: string;
}

export interface WatchAttrs {
  platform: string;
  regions: string[];
  type: string;
  edition: string;
  phase: string;
  requireFloat: boolean;
  floatMin: number | null;
  floatMax: number | null;
  server: string;
}

export interface Watch {
  id: string;
  createdAt: string;
  name: string;
  category: Category;
  game: SkinGame | null;
  query: string;
  include: string[];
  exclude: string[];
  sources: string[];
  ignore: string[];
  attrs: WatchAttrs;
  manual: ManualPrice[];
  funpay: { url: string; include: string[]; exclude: string[]; onlineOnly: boolean; minReviews: number; facets: Record<string, string[]> };
  enabled: boolean;
}

export interface ScanResult {
  watchId: string;
  startedAt: string;
  finishedAt: string;
  ratesDate: string;
  usdRub: number;
  sources: { sourceId: string; status: 'ok' | 'empty' | 'error' | 'rejected'; offers: Offer[]; rejected: number; error: string | null; errorClass: string | null }[];
  manual: Offer[];
  funpay:
    | {
        status: 'ok';
        title: string;
        url: string;
        pricePer: number;
        total: number;
        filtered: number;
        rejected: number;
        fetchedAt: string;
        count: number;
        online: number;
        min: number | null;
        median10: number | null;
        sellers: number;
        observedFee: { pct: number; source: string } | null;
        top: FunpayOffer[];
      }
    | { status: 'error'; error: string; url: string }
    | null;
}

export interface Line {
  key: string;
  label: string;
  amount: number;
}
export interface Forecast {
  price: number;
  lines: Line[];
  payout: number;
  invested: number;
  net: number;
  netPct: number;
  roiPct: number | null;
}

export interface Opportunity {
  id: string;
  kind: 'watch' | 'discovery';
  watchId?: string;
  name: string;
  category: Category;
  game?: SkinGame;
  buy: Offer;
  market: { min: number | null; count: number; online: number; sellers: number; url: string; sectionUrl: string; pricePer: number; fetchedAt: string };
  saleFee: { pct: number; origin: string; source: string; assumed: boolean };
  compliance: { level: string; hits: { clause: string; level: string; text: string; match: string }[] };
  liquidity: Liquidity | null;
  sourceFee?: { pct: number; fixed: number; source: string; assumed: boolean };
  /** связка подтверждена собственной сделкой (куплено по ней и продано) */
  verifiedByTransaction?: boolean;
  eval: {
    status: OppStatus;
    /** theoretical — по котировкам; executable — перепроверено и наличие подтверждено */
    verification: 'theoretical' | 'executable';
    executionGaps: string[];
    netPerDay: number | null;
    sellProb7: { p: number; lo: number; hi: number } | null;
    liquidityBasis: string;
    /** модель затрат, по которой посчитан прогноз (с обученными потерями) */
    model?: ServerSettings['costModel'];
    score: number;
    components: Record<string, number>;
    blocks: string[];
    reviews: string[];
    warnings: string[];
    assumptions: string[];
    prices: {
      breakEven: number | null;
      scenarios: { key: string; label: string; price: number; why: string; forecast: Forecast | null }[];
      decision: string | null;
      optimal: { price: number; band: string; forecast: Forecast | null } | null;
      optimalNote: string;
    };
    forecast: Forecast | null;
    ages: { sourceMin: number; funpayMin: number; verificationMin: number };
    daysToSell: number;
  };
}

export interface Liquidity {
  observed: {
    activeLots: number;
    sellers: number;
    online: number;
    topSellerShare: number | null;
    disappearPerLotDay: number | null;
    disappearedTotal: number | null;
    priceVolatilityCv: number | null;
    observationDays: number;
    snapshots: number;
  } | null;
  fact: { count: number; medianDays: number | null };
  confidence: 'none' | 'low' | 'medium' | 'high';
  note: string;
}

export interface Snapshot {
  ts: string;
  min_rub: number | null;
  median_rub: number | null;
  trimmed_rub: number | null;
  count: number | null;
  sellers: number | null;
  online: number | null;
  disappeared: number | null;
  appeared: number | null;
  currency: string | null;
  fx_rate: number | null;
}

export interface MarketRow {
  watchId: string;
  name: string;
  category: Category;
  funpay: {
    min: number;
    median: number;
    trimmed: number;
    count: number;
    sellers: number;
    online: number;
    topSellerShare: number | null;
    changes: Record<string, number | null>;
    countChanges: Record<string, number | null>;
    anomalies: { ts: string; type: string; pct?: number; minutes?: number }[];
    points: number;
    ts: string;
  } | null;
  liquidity: Liquidity;
  sources: { sourceId: string; last: number | null; ts: string | null; changes: Record<string, number | null>; vs7dMedianPct: number | null; points: number }[];
}

export interface Discovery {
  game: SkinGame;
  funpay: { url: string; title: string; total: number; considered: number; matched: number };
  feedErrors: Record<string, string>;
  items: unknown[];
  scannedAt: string;
}

export interface CatalogGame {
  id: number;
  name: string;
  url: string;
  sections: { url: string; name: string }[];
}

export interface FunpayFacets {
  url: string;
  title: string;
  total: number;
  pricePer: number;
  facets: { key: string; label: string; options: { value: string; label: string; count: number }[] }[];
}

export interface FeeProfile {
  id: number;
  scope: 'funpay_section' | 'funpay_default' | 'source';
  scope_key: string;
  pct: number;
  fixed_rub: number;
  source: string;
  valid_from: string;
  created_at: string;
  note: string | null;
  active: boolean;
  future: boolean;
}

export interface ServerSettings {
  intervalMin: number;
  costModel: {
    feeModel: 'deduct' | 'addon';
    defaultSaleFeePct: number;
    withdrawPct: number;
    fxSpreadPct: number;
    taxPct: number;
    taxBase: 'payout' | 'profit';
    disputePct: number;
    minutesPerOrder: number;
    hourlyRate: number;
    extraFulfillmentRub: number;
    capitalRatePct: number;
    expectedDaysToSell: number;
  };
  pricing: { undercutPct: number; undercutRub: number; minCompetitors: number };
  freshness: { funpayTtlMin: number; sourceTtlMin: number; manualTtlH: number };
  scoring: { weights: Record<string, number>; minScore: number; suspiciousPct: number; requireKnownStock: boolean };
  risk: { maxItemSharePct: number; maxSourceSharePct: number; maxCategorySharePct: number; staleStockDays: number; lossPriorWeight: number };
  verification: { executableTtlMin: number; priceTolerancePct: number };
  matching: { skinsStrict: 'all' | 'pattern' };
  demand: { minSnapshots: number; minObservationHours: number; minOwnSales: number };
  paper: { enabled: boolean; horizonDays: number };
  inventory: { costMethod: 'fifo' | 'avg'; allowNegative: boolean; startingCapital: number; maxPurchaseRub: number; lowStockQty: number };
  analytics: { abcA: number; abcB: number; xyzX: number; xyzY: number };
  notify: { enabled: boolean; chatIds: string[]; minNet: number; competitorDropPct: number; sourceDownMin: number };
  backup: { enabled: boolean; everyH: number; keep: number };
}

export interface StockRow {
  item: string;
  onHand: number;
  reserved: number;
  available: number;
  inTransit: number;
  valueRub: number;
  avgCostRub: number | null;
  batches: number;
  low: boolean;
}

export interface Purchase {
  /** повтор запроса с тем же ключом — сервер вернул сохранённый ответ */
  replayed?: boolean;
  received_qty?: number | null;
  id: string;
  item: string;
  source_id: string | null;
  qty: number;
  unit_price: number;
  currency: string;
  fx_rate: number;
  fx_spread_pct: number;
  fees_rub: number;
  total_cost_rub: number;
  unit_cost_rub: number;
  status: 'in_transit' | 'received' | 'cancelled';
  mode: Mode;
  purchased_at: string;
  received_at: string | null;
  recommendation_id: string | null;
  note: string | null;
}

export interface Sale {
  id: string;
  item: string;
  qty: number;
  unit_price: number;
  revenue_rub: number;
  sale_fee_pct: number;
  sale_fee_source: string | null;
  platform_fee_rub: number;
  withdraw_fee_rub: number;
  payout_rub: number;
  cogs_rub: number;
  cost_method: string;
  fulfillment_rub: number;
  tax_rub: number;
  refund_rub: number;
  net_rub: number;
  status: 'completed' | 'disputed_won' | 'refunded' | 'partial_refund' | 'cancelled';
  disputed: number;
  imported: number;
  sold_at: string;
  note: string | null;
}

export interface Metrics {
  from: string;
  to: string;
  orders: number;
  units: number;
  revenue: number;
  cogs: number;
  fees: number;
  grossProfit: number;
  netProfit: number;
  netMarginPct: number | null;
  roiPct: number | null;
  aov: number | null;
  refundRatePct: number | null;
  disputeRatePct: number | null;
  inventoryStart: number;
  inventoryEnd: number;
  capitalTurnover: number | null;
  cashFlow: { in: number; out: number; net: number; byType: Record<string, number> };
}

export interface Backup {
  id: number;
  file: string;
  created_at: string;
  size: number;
  verified_at: string | null;
  verify_ok: number | null;
  verify_detail: { integrity?: string; counts?: Record<string, number>; error?: string } | null;
  exists: boolean;
}

export interface Diagnostics {
  checkedAt: string;
  checks: { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }[];
}

export interface SellProbability {
  events: number;
  censored: number;
  minEvents: number;
  enough: boolean;
  probs: Record<string, { p: number; lo: number; hi: number }> | null;
  medianDays: number | null;
  note: string | null;
}

export interface Capital {
  tracking: boolean;
  cash: number | null;
  reserved: number;
  freeCash: number | null;
  inventory: number;
  inTransit: number;
  total: number;
  utilization: number | null;
  byItem: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface StrategyStats {
  trades?: number;
  netProfit?: number;
  open?: number;
  closed?: number;
  noData?: number;
  totalNet?: number;
  roiPct: number | null;
  winRate: number | null;
  falsePositiveRate: number | null;
  maxDrawdown?: number;
  turnover?: number | null;
  capitalUtilization?: number | null;
  forecastMae: number | null;
}

export interface VerifyResult {
  ok: boolean;
  quoted: number;
  fresh: number | null;
  stock: number | null;
  userConfirmedStock: boolean;
  notes: string[];
  opportunity: Opportunity | null;
}

export interface ServerHealth {
  ok: boolean;
  version: number;
  engine: string;
  auth: boolean;
  schema: number;
  working: string | null;
  queue: string[];
  lastCycle: string | null;
  settings: { intervalMin: number };
  telegram: boolean;
}

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

async function call<T>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        'X-FPO-Client': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Сервер не отвечает. Запустите его: npm run dev');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(res.status === 404 || res.status >= 500 ? 'Сервер не запущен (npm run dev)' : 'Неожиданный ответ сервера');
  }
  if (!res.ok) {
    const e = Object.assign(new Error((data as { error?: string }).error || `HTTP ${res.status}`), { status: res.status, code: (data as { code?: string }).code });
    if (res.status === 401 && e.code === 'auth') window.dispatchEvent(new CustomEvent('fpo:auth-required'));
    throw e;
  }
  return data as T;
}

/** финансовая операция: ключ идемпотентности передаёт вызывающий (один на попытку пользователя) */
const fin = <T,>(path: string, body: unknown, key = newKey()) => call<T>('POST', path, body, { idempotencyKey: key });

export const api = {
  newKey,
  health: () => call<ServerHealth>('GET', '/health'),
  diagnostics: () => call<Diagnostics>('GET', '/diagnostics'),
  sources: () => call<{ categories: { id: Category; name: string }[]; sources: SourceInfo[]; health: Record<string, Health> }>('GET', '/sources'),
  catalog: () => call<CatalogGame[]>('GET', '/funpay/catalog'),
  facets: (url: string) => call<FunpayFacets>('GET', `/funpay/facets?url=${encodeURIComponent(url)}`),
  watches: () => call<{ watches: Watch[]; results: Record<string, ScanResult> }>('GET', '/watches'),
  saveWatch: (w: Partial<Watch>) => call<Watch>('POST', '/watches', w),
  removeWatch: (id: string) => call<{ ok: true }>('DELETE', `/watches/${id}`),
  scan: (id: string) => call<ScanResult>('POST', `/scan/${id}`),
  scanAll: () => call<{ queued: number }>('POST', '/scan-all'),
  match: (watchId: string, offerUrl: string, side: 'source' | 'funpay', status: 'VERIFIED' | 'REJECTED' | 'CLEAR', reason?: string) =>
    call<{ ok: true }>('POST', '/match', { watchId, offerUrl, side, status, reason }),
  discover: (game: SkinGame, funpayUrl: string, onlineOnly: boolean) => call<Discovery>('POST', '/discover', { game, funpayUrl, onlineOnly }),
  discoveries: () => call<Record<string, Discovery>>('GET', '/discover'),
  opportunities: () => call<{ generatedAt: string; items: Opportunity[] }>('GET', '/opportunities'),
  market: () => call<MarketRow[]>('GET', '/market'),
  history: (watchId: string, days = 30) => call<{ funpay: Snapshot[]; sources: Record<string, Snapshot[]>; anomalies: unknown[] }>('GET', `/history/${watchId}?days=${days}`),
  fees: () => call<FeeProfile[]>('GET', '/fees'),
  addFee: (f: { scope: string; scopeKey?: string; pct: number; fixedRub?: number; source: string; validFrom?: string; note?: string }) => call<FeeProfile>('POST', '/fees', f),
  settings: () => call<{ settings: ServerSettings; defaults: ServerSettings }>('GET', '/settings'),
  saveSettings: (p: Partial<ServerSettings> | Record<string, unknown>) => call<ServerSettings>('PUT', '/settings', p),
  settingsHistory: () => call<{ key: string; value: unknown; changed_at: string }[]>('GET', '/settings/history'),

  stock: (mode: Mode) => call<{ items: StockRow[]; cash: { tracking: boolean; balance: number }; reservations: { id: string; item: string; qty: number; created_at: string; note: string | null }[] }>('GET', `/stock?mode=${mode}`),
  purchases: (mode: Mode) => call<Purchase[]>('GET', `/purchases?mode=${mode}`),
  sales: (mode: Mode) => call<Sale[]>('GET', `/sales?mode=${mode}`),
  ledger: (mode: Mode) => call<{ id: number; ts: string; type: string; amount_rub: number; ref_id: string | null; note: string | null }[]>('GET', `/ledger?mode=${mode}`),
  createPurchase: (b: Record<string, unknown>, key?: string) => fin<Purchase>('/purchases', b, key),
  receive: (id: string, qty?: number) => fin<Purchase>(`/purchases/${id}/receive`, qty ? { qty } : {}),
  cancelPurchase: (id: string, note?: string) => fin<Purchase>(`/purchases/${id}/cancel`, { note }),
  createSale: (b: Record<string, unknown>, key?: string) => fin<Sale>('/sales', b, key),
  importSales: (deals: Record<string, unknown>[], key?: string) => fin<{ imported: number; replayed?: boolean }>('/sales/import', { deals }, key),
  refund: (id: string, b: { amount?: number; restock?: boolean; note?: string }) => fin<Sale>(`/sales/${id}/refund`, b),
  dispute: (id: string) => fin<Sale>(`/sales/${id}/dispute`, { won: true }),
  writeOff: (b: { item: string; qty: number; note?: string; mode: Mode }) => fin<{ lossRub: number }>('/stock/writeoff', b),
  reserve: (b: { item: string; qty: number; note?: string; mode: Mode }) => fin<{ id: string }>('/stock/reserve', b),
  release: (id: string) => fin<{ ok: true }>(`/reservations/${id}/release`, {}),
  cash: (b: { type: 'deposit' | 'withdraw'; amount: number; note?: string; mode: Mode }) => fin<{ balance: number }>('/cash', b),

  metrics: (q: string) => call<Metrics>('GET', `/analytics/metrics?${q}`),
  compare: (q: string) => call<{ current: Metrics; previous: Metrics; deltaPct: Record<string, number | null> }>('GET', `/analytics/compare?${q}`),
  abcxyz: (q: string) => call<{ item: string; net: number; revenue: number; qty: number; sharePct: number; abc: string; cv: number | null; xyz: string | null }[]>('GET', `/analytics/abcxyz?${q}`),
  recQuality: () =>
    call<{ total: number; purchased: number; known: number; profitable: number; precision: number | null; maePerUnit: number | null; items: { id: string; item: string; sourceId: string; forecastNet: number; qty: number; soldQty: number; actualNet: number; known: boolean }[] }>(
      'GET',
      '/analytics/recommendations',
    ),

  audit: () => call<{ id: number; ts: string; action: string; entity: string; entity_id: string | null; details: unknown }[]>('GET', '/audit'),
  backups: () => call<Backup[]>('GET', '/backups'),
  createBackup: () => call<{ file: string; verify: { ok: boolean } }>('POST', '/backups'),
  verifyBackup: (file: string) => call<{ ok: boolean }>('POST', `/backups/${encodeURIComponent(file)}/verify`),
  restoreBackup: (file: string) => call<{ restored: string; safetyCopy: string }>('POST', `/backups/${encodeURIComponent(file)}/restore`, { confirm: file }),
  telegram: () => call<{ configured: boolean; username?: string; error?: string; chatIds: string[]; enabled: boolean }>('GET', '/telegram'),
  setTelegramToken: (token: string) => call<{ configured: boolean }>('PUT', '/telegram', { token }),
  telegramTest: () => call<{ sent: number }>('POST', '/telegram/test'),
  verify: (id: string, b: { userConfirmedStock?: boolean; actualPriceRub?: number }) => call<VerifyResult>('POST', `/verify/${id}`, b),
  attempt: (b: { oppId?: string; watchId?: string; sourceId: string; offerUrl?: string; quotedRub?: number; actualRub?: number; quotedStock?: number | null; outcome: string; purchaseId?: string; note?: string }) =>
    call<{ id: number }>('POST', '/attempts', b),
  qualitySources: () =>
    call<
      Record<
        string,
        {
          sourceId: string;
          data: { checked: number; withIssues: number; okShare: number | null };
          price: { attempts: number; medianDeviationPct: number | null; accuracy: number | null };
          stock: { attempts: number; accuracy: number | null };
          fulfillment: { sales: number; problemRate: number | null };
        }
      >
    >('GET', '/quality/sources'),
  demand: (q: string) =>
    call<{
      sell: SellProbability;
      bands: { observations: number; bands: { key: string; label: string; n: number; medianDays: number | null; avgNetPerUnit: number | null; netPerDay: number | null }[]; best: { label: string } | null; note: string | null };
      weekdays: number[];
    }>('GET', `/demand?${q}`),
  risk: (mode: Mode) =>
    call<{
      capital: Capital;
      aging: { buckets: { key: string; qty: number; value: number }[]; items: { item: string; ageDays: number; qty: number; value: number; stale: boolean }[]; frozen: number; staleDays: number };
      cashFlow: { days: number; inflow: number; outflow: number; net: number }[];
      reservations: { id: string; amount_rub: number; item: string | null; note: string | null; created_at: string }[];
      limits: ServerSettings['risk'];
    }>('GET', `/risk?mode=${mode}`),
  reserveCash: (b: { amount: number; item?: string; note?: string; mode: Mode }) => fin<{ id: string }>('/cash/reserve', b),
  releaseCash: (id: string) => fin<{ ok: true }>(`/cash/reserve/${id}/release`, {}),
  paper: () => call<{ byStrategy: Record<string, StrategyStats>; recent: { id: string; item: string; strategy: string; opened_at: string; status: string; planned_price: number; forecast_net: number; exit_price: number | null; exit_net: number | null }[] }>('GET', '/paper'),
  backtest: (b: { horizonDays: number; minNet: number; minRoiPct: number; sinceDays: number }) =>
    call<{ params: Record<string, number>; engineVersion: string; settingsHash: string; strategies: Record<string, StrategyStats>; trades: { watch: string; source: string; strategy: string; entry: string; exit: string; plannedPrice: number; exitPrice: number; forecastNet: number; net: number }[]; skippedNoExit: number; note: string }>(
      'POST',
      '/backtest',
      b,
    ),
  backtestRuns: () => call<{ id: number; ts: string; engine_version: string; settings_hash: string; params: Record<string, number>; result: { strategies: Record<string, StrategyStats> } }[]>('GET', '/backtest'),
  productMetrics: (q: string) =>
    call<{
      precision: { value: number | null; known: number; profitable: number; purchased: number };
      falsePositiveRate: number | null;
      netPnL: number;
      forecastError: { profitMaePerUnit: number | null; daysMae: number | null; samples: number };
      sellThrough: number | null;
      timeToSale: { medianDays: number | null; enough: boolean; events: number; censored: number };
      capitalUtilization: number | null;
      refundRatePct: number | null;
      disputeRatePct: number | null;
      sources: { sourceId: string; priceAccuracy: number | null; priceAttempts: number; stockAccuracy: number | null; stockAttempts: number; problemRate: number | null }[];
      paper: Record<string, StrategyStats>;
      backtest: { ts: string; params: Record<string, number>; strategies: Record<string, StrategyStats> } | null;
    }>('GET', `/metrics/product?${q}`),
  login: (token: string) => call<{ ok: true }>('POST', '/login', { token }),
  logout: () => call<{ ok: true }>('POST', '/logout', {}),
  notifications: () => call<{ id: number; ts: string; type: string; text: string; sent: number; error: string | null }[]>('GET', '/notifications'),
};
