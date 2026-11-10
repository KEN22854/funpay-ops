// Резервные копии базы и проверка восстановления.
import { createRequire } from 'node:module';
// через require: Vite/Vitest 2 не распознаёт встроенный модуль node:sqlite при импорте
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { all, closeDb, DATA_DIR, DB_FILE, getDb, nowIso, one, openDb, run } from '../db/db.mjs';
import { audit } from './audit.mjs';

export const BACKUP_DIR = process.env.FPO_BACKUP_DIR || join(DATA_DIR, 'backups');

const CHECK_TABLES = ['watches', 'fee_profiles', 'purchases', 'sales', 'stock_movements', 'cash_ledger', 'price_snapshots'];

export function createBackup(reason = 'manual') {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const file = join(BACKUP_DIR, `funpay-ops-${stamp}.db`);
  // VACUUM INTO — согласованная копия даже при работающей базе
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const size = statSync(file).size;
  run('INSERT INTO backups(file, created_at, size) VALUES (?, ?, ?)', basename(file), nowIso(), size);
  audit('backup.create', 'backup', basename(file), { reason, size });
  const verify = verifyBackup(basename(file));
  return { file: basename(file), size, verify };
}

/** Тест восстановления: открыть копию отдельно, проверить целостность и сверить количество строк. */
export function verifyBackup(name) {
  const file = join(BACKUP_DIR, basename(name));
  if (!existsSync(file)) throw Object.assign(new Error('копия не найдена'), { status: 404 });
  let ok = false;
  let detail = {};
  try {
    const b = new DatabaseSync(file, { readOnly: true });
    const integrity = b.prepare('PRAGMA integrity_check').get();
    const counts = {};
    for (const t of CHECK_TABLES) counts[t] = b.prepare(`SELECT count(*) n FROM ${t}`).get().n;
    const version = b.prepare('SELECT max(version) v FROM schema_migrations').get().v;
    b.close();
    ok = Object.values(integrity)[0] === 'ok';
    detail = { integrity: Object.values(integrity)[0], version, counts };
  } catch (e) {
    detail = { error: e.message };
  }
  run('UPDATE backups SET verified_at = ?, verify_ok = ?, verify_detail = ? WHERE file = ?', nowIso(), ok ? 1 : 0, JSON.stringify(detail), basename(name));
  return { ok, ...detail };
}

export function listBackups() {
  return all('SELECT * FROM backups ORDER BY id DESC').map((r) => ({ ...r, verify_detail: r.verify_detail ? JSON.parse(r.verify_detail) : null, exists: existsSync(join(BACKUP_DIR, r.file)) }));
}

export function pruneBackups(keep) {
  if (!existsSync(BACKUP_DIR)) return 0;
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => /^funpay-ops-.*\.db$/.test(f))
    .sort()
    .reverse();
  let n = 0;
  for (const f of files.slice(Math.max(1, keep))) {
    rmSync(join(BACKUP_DIR, f), { force: true });
    n++;
  }
  return n;
}

/**
 * Восстановление из копии. Текущая база сначала сама сохраняется в копию «pre-restore»,
 * копия проходит проверку, и только потом заменяет рабочую базу.
 */
export function restoreBackup(name) {
  const v = verifyBackup(name);
  if (!v.ok) throw Object.assign(new Error('копия не прошла проверку целостности — восстановление отменено'), { status: 409 });
  const safety = createBackup('pre-restore');
  closeDb();
  for (const ext of ['-wal', '-shm']) rmSync(DB_FILE + ext, { force: true });
  copyFileSync(join(BACKUP_DIR, basename(name)), DB_FILE);
  openDb();
  audit('backup.restore', 'backup', basename(name), { safety: safety.file });
  return { restored: basename(name), safetyCopy: safety.file, version: one('SELECT max(version) v FROM schema_migrations').v };
}
