// Миграции схемы. Только добавлять новые версии в конец — уже применённые не менять.
export const MIGRATIONS = [
  {
    version: 1,
    name: 'core',
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE settings_history (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, changed_at TEXT NOT NULL);

CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, details TEXT);
CREATE INDEX audit_ts ON audit_log(ts);

CREATE TABLE idempotency (key TEXT PRIMARY KEY, route TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);

-- каталог товаров (карточки отслеживания): атрибуты — в data.attrs
CREATE TABLE watches (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE scan_results (watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE, data TEXT NOT NULL, finished_at TEXT NOT NULL);
CREATE TABLE discoveries (key TEXT PRIMARY KEY, data TEXT NOT NULL, scanned_at TEXT NOT NULL);

-- решения по сопоставлению: ручные VERIFIED / REJECTED перекрывают автоматические правила
CREATE TABLE match_decisions (
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  offer_url TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('source','funpay')),
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','REJECTED')),
  reason TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (watch_id, offer_url)
);

-- профили комиссий: только добавление; действующая = последняя с valid_from <= сейчас
CREATE TABLE fee_profiles (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('funpay_section','funpay_default','source')),
  scope_key TEXT NOT NULL DEFAULT '',
  pct REAL NOT NULL CHECK (pct >= 0 AND pct < 100),
  fixed_rub REAL NOT NULL DEFAULT 0 CHECK (fixed_rub >= 0),
  source TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX fee_scope ON fee_profiles(scope, scope_key, valid_from);

-- история цен: снимок на каждый скан по каждому источнику и по FunPay
CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY,
  watch_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source','funpay')),
  source_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  currency TEXT,
  fx_rate REAL,
  min_rub REAL,
  median_rub REAL,
  trimmed_rub REAL,
  count INTEGER,
  sellers INTEGER,
  online INTEGER,
  top_seller_share REAL,
  appeared INTEGER,
  disappeared INTEGER,
  stock INTEGER,
  best_url TEXT
);
CREATE INDEX snap_lookup ON price_snapshots(watch_id, kind, source_id, ts);

-- какие лоты FunPay видели и когда (исчезновение — сигнал, не факт продажи)
CREATE TABLE funpay_lots_seen (
  watch_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  seller TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_price REAL,
  PRIMARY KEY (watch_id, offer_id)
);

-- здоровье источников: одна строка на вызов адаптера
CREATE TABLE source_health (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_class TEXT,
  http_status INTEGER,
  latency_ms INTEGER,
  items INTEGER,
  detail TEXT
);
CREATE INDEX health_src ON source_health(source_id, ts);

-- журнал рекомендаций — основа для precision и backtesting
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  watch_id TEXT,
  item TEXT NOT NULL,
  source_id TEXT NOT NULL,
  offer_url TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  forecast_net REAL,
  forecast_price REAL,
  buy_cost REAL,
  data TEXT
);

-- закупочные партии
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  watch_id TEXT,
  recommendation_id TEXT,
  source_id TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL CHECK (fx_rate > 0),
  fx_spread_pct REAL NOT NULL DEFAULT 0,
  fees_rub REAL NOT NULL DEFAULT 0 CHECK (fees_rub >= 0),
  total_cost_rub REAL NOT NULL CHECK (total_cost_rub >= 0),
  unit_cost_rub REAL NOT NULL CHECK (unit_cost_rub >= 0),
  status TEXT NOT NULL CHECK (status IN ('in_transit','received','cancelled')),
  mode TEXT NOT NULL CHECK (mode IN ('real','sim')),
  purchased_at TEXT NOT NULL,
  received_at TEXT,
  note TEXT
);
CREATE INDEX purch_item ON purchases(item, mode, purchased_at);

-- продажи (заказы)
CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  watch_id TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  revenue_rub REAL NOT NULL,
  sale_fee_pct REAL NOT NULL,
  sale_fee_source TEXT,
  platform_fee_rub REAL NOT NULL,
  withdraw_pct REAL NOT NULL,
  withdraw_fee_rub REAL NOT NULL,
  payout_rub REAL NOT NULL,
  cogs_rub REAL NOT NULL,
  cost_method TEXT NOT NULL,
  fulfillment_rub REAL NOT NULL DEFAULT 0,
  tax_rub REAL NOT NULL DEFAULT 0,
  refund_rub REAL NOT NULL DEFAULT 0,
  net_rub REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','disputed_won','refunded','partial_refund','cancelled')),
  disputed INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL CHECK (mode IN ('real','sim')),
  imported INTEGER NOT NULL DEFAULT 0,
  recommendation_id TEXT,
  sold_at TEXT NOT NULL,
  closed_at TEXT,
  note TEXT
);
CREATE INDEX sales_item ON sales(item, sold_at);

-- движения склада: только добавление, остаток = сумма qty
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  item TEXT NOT NULL,
  mode TEXT NOT NULL,
  purchase_id TEXT REFERENCES purchases(id),
  sale_id TEXT REFERENCES sales(id),
  type TEXT NOT NULL CHECK (type IN ('receive','sale','writeoff','return','adjust')),
  qty INTEGER NOT NULL,
  unit_cost_rub REAL NOT NULL,
  ts TEXT NOT NULL,
  note TEXT
);
CREATE INDEX mov_item ON stock_movements(item, mode);
CREATE INDEX mov_purchase ON stock_movements(purchase_id);

CREATE TABLE reservations (id TEXT PRIMARY KEY, item TEXT NOT NULL, mode TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), created_at TEXT NOT NULL, released_at TEXT, note TEXT);

-- касса: только добавление
CREATE TABLE cash_ledger (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, mode TEXT NOT NULL, type TEXT NOT NULL, amount_rub REAL NOT NULL, ref_id TEXT, note TEXT);
CREATE INDEX cash_ts ON cash_ledger(mode, ts);

-- уведомления: dedupe_key не даёт слать одно и то же повторно
CREATE TABLE notifications (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, dedupe_key TEXT UNIQUE, text TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, error TEXT);

CREATE TABLE backups (id INTEGER PRIMARY KEY, file TEXT NOT NULL, created_at TEXT NOT NULL, size INTEGER, verified_at TEXT, verify_ok INTEGER, verify_detail TEXT);
`,
  },
  {
    version: 2,
    name: 'verification-quality-backtest',
    sql: `
-- версия движка и настроек у рекомендации: воспроизводимость и сравнение версий
ALTER TABLE recommendations ADD COLUMN engine_version TEXT;
ALTER TABLE recommendations ADD COLUMN settings_hash TEXT;
ALTER TABLE recommendations ADD COLUMN category TEXT;
ALTER TABLE recommendations ADD COLUMN forecast_days REAL;

-- качество данных при каждом вызове адаптера (отдельно от транспортного здоровья)
ALTER TABLE source_health ADD COLUMN dq_checked INTEGER;
ALTER TABLE source_health ADD COLUMN dq_issues INTEGER;
ALTER TABLE source_health ADD COLUMN dq_detail TEXT;

-- перепроверка связки перед закупкой (Profit Verification: theoretical → executable)
CREATE TABLE verifications (
  id INTEGER PRIMARY KEY,
  opp_id TEXT NOT NULL,
  watch_id TEXT,
  source_id TEXT NOT NULL,
  offer_url TEXT NOT NULL,
  ts TEXT NOT NULL,
  quoted_rub REAL,
  fresh_rub REAL,
  stock INTEGER,
  user_confirmed_stock INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX verif_opp ON verifications(opp_id, ts);

-- попытки закупки: точность котировки и остатка источника (source price/stock accuracy)
CREATE TABLE execution_attempts (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  opp_id TEXT,
  watch_id TEXT,
  source_id TEXT NOT NULL,
  offer_url TEXT,
  quoted_rub REAL,
  actual_rub REAL,
  quoted_stock INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','price_changed','out_of_stock','not_found','failed')),
  purchase_id TEXT,
  note TEXT
);
CREATE INDEX exec_src ON execution_attempts(source_id, ts);

-- частичное исполнение закупки
ALTER TABLE purchases ADD COLUMN received_qty INTEGER;
ALTER TABLE purchases ADD COLUMN category TEXT;

-- резерв денег под плановые закупки (reserved cash)
CREATE TABLE cash_reservations (id TEXT PRIMARY KEY, mode TEXT NOT NULL, amount_rub REAL NOT NULL CHECK (amount_rub > 0), item TEXT, source_id TEXT, opp_id TEXT, note TEXT, created_at TEXT NOT NULL, released_at TEXT);

-- paper trading: позиции «как если бы купили» по рекомендациям, закрываются по рыночной переоценке
CREATE TABLE paper_positions (
  id TEXT PRIMARY KEY,
  opp_id TEXT NOT NULL,
  watch_id TEXT,
  item TEXT NOT NULL,
  category TEXT,
  source_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  horizon_days REAL NOT NULL,
  entry_cost REAL NOT NULL,
  planned_price REAL NOT NULL,
  forecast_net REAL NOT NULL,
  engine_version TEXT,
  settings_hash TEXT,
  closed_at TEXT,
  exit_price REAL,
  exit_net REAL,
  status TEXT NOT NULL CHECK (status IN ('open','closed','expired_no_data'))
);
CREATE UNIQUE INDEX paper_open ON paper_positions(opp_id, strategy) WHERE status = 'open';

CREATE TABLE backtest_runs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, engine_version TEXT, settings_hash TEXT, params TEXT NOT NULL, result TEXT NOT NULL);
`,
  },
  {
    version: 3,
    name: 'paper-params',
    sql: `
-- параметры расчёта на момент открытия бумажной позиции (выход считается по тем же условиям)
ALTER TABLE paper_positions ADD COLUMN params TEXT;
`,
  },
];
