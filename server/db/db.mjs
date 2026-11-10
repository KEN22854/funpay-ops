// База данных FunPay Ops: встроенный SQLite из Node.js (node:sqlite), без внешних зависимостей.
// WAL-журнал, внешние ключи, миграции по версиям, транзакции.
import { createRequire } from 'node:module';
// через require: Vite/Vitest 2 не распознаёт встроенный модуль node:sqlite при импорте
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './migrations.mjs';

export const DATA_DIR = process.env.FPO_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const DB_FILE = process.env.FPO_DB || join(DATA_DIR, 'funpay-ops.db');

let db = null;

export function openDb(file = DB_FILE) {
  if (db) return db;
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  if (file !== ':memory:') importLegacyJson(db, join(dirname(file), 'state.json'));
  return db;
}

export function getDb() {
  return db ?? openDb();
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Транзакция: fn(db) выполняется целиком или не выполняется совсем. Поддерживает вложенность через SAVEPOINT. */
let depth = 0;
export function tx(fn) {
  const d = getDb();
  const sp = `sp${depth}`;
  d.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn(d);
    depth--;
    d.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    d.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export const all = (sql, ...p) => getDb().prepare(sql).all(...p);
export const one = (sql, ...p) => getDb().prepare(sql).get(...p);
export const run = (sql, ...p) => getDb().prepare(sql).run(...p);
export const nowIso = () => new Date().toISOString();

function migrate(d) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(d.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    d.exec('BEGIN');
    try {
      d.exec(m.sql);
      d.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`миграция ${m.version} (${m.name}) не применилась: ${e.message}`);
    }
  }
}

export function schemaVersion() {
  return one('SELECT max(version) v FROM schema_migrations')?.v ?? 0;
}

/** Однократный перенос данных из прежнего data/state.json (версия 1.x) */
function importLegacyJson(d, file) {
  if (!existsSync(file)) return;
  let s;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const now = nowIso();
  d.exec('BEGIN');
  try {
    for (const w of s.watches ?? []) {
      d.prepare('INSERT OR IGNORE INTO watches(id, data, created_at, updated_at) VALUES (?, ?, ?, ?)').run(w.id, JSON.stringify(w), w.createdAt ?? now, now);
    }
    for (const [k, r] of Object.entries(s.discoveries ?? {})) {
      d.prepare('INSERT OR IGNORE INTO discoveries(key, data, scanned_at) VALUES (?, ?, ?)').run(k, JSON.stringify(r), r.scannedAt ?? now);
    }
    if (s.settings?.intervalMin !== undefined) {
      d.prepare('INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run('intervalMin', JSON.stringify(s.settings.intervalMin), now);
    }
    d.prepare('INSERT INTO audit_log(ts, action, entity, details) VALUES (?, ?, ?, ?)').run(now, 'import', 'legacy-json', JSON.stringify({ watches: (s.watches ?? []).length }));
    d.exec('COMMIT');
    renameSync(file, file + '.imported');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}
