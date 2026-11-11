// Резервные копии базы и проверка восстановления.
import { createRequire } from 'node:module';
// через require: Vite/Vitest 2 не распознаёт встроенный модуль node:sqlite при импорте
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { all, closeDb, DATA_DIR, DB_FILE, getDb, nowIso, one, openDb, run } from '../db/db.mjs';
import { audit } from './audit.mjs';

export const BACKUP_DIR = process.env.FPO_BACKUP_DIR || join(DATA_DIR, 'backups');
/** внешнее хранилище зашифрованных копий: папка облачного диска, сетевой диск, флешка */
export const EXTERNAL_DIR = () => process.env.FPO_BACKUP_EXTERNAL_DIR || '';

/* ───────────── шифрование: AES-256-GCM, ключ из пароля через scrypt ───────────── */
// Формат файла: "FPOENC1\n" (8 байт) | соль 16 | IV 12 | тег 16 | шифртекст
const MAGIC = Buffer.from('FPOENC1\n');
export const backupKeySet = () => String(process.env.FPO_BACKUP_KEY ?? '').length >= 16;

function keyFrom(pass, salt) {
  return scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptBuffer(plain, pass) {
  if (String(pass ?? '').length < 16) throw Object.assign(new Error('ключ шифрования бэкапов короче 16 символов (FPO_BACKUP_KEY)'), { status: 400 });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decryptBuffer(enc, pass) {
  if (enc.length < 52 || !enc.subarray(0, 8).equals(MAGIC)) throw Object.assign(new Error('это не зашифрованная копия FunPay Ops'), { status: 400 });
  const salt = enc.subarray(8, 24);
  const iv = enc.subarray(24, 36);
  const tag = enc.subarray(36, 52);
  const d = createDecipheriv('aes-256-gcm', keyFrom(String(pass ?? ''), salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(enc.subarray(52)), d.final()]);
  } catch {
    throw Object.assign(new Error('не удалось расшифровать: неверный ключ или файл повреждён'), { status: 400 });
  }
}

/** зашифрованная копия бэкапа — во внешнюю папку (если задана) или рядом с бэкапами */
export function encryptBackup(name) {
  if (!backupKeySet()) throw Object.assign(new Error('не задан FPO_BACKUP_KEY (не короче 16 символов)'), { status: 400 });
  const src = join(BACKUP_DIR, basename(name));
  if (!existsSync(src)) throw Object.assign(new Error('копия не найдена'), { status: 404 });
  const dir = EXTERNAL_DIR() || BACKUP_DIR;
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${basename(name)}.enc`);
  writeFileSync(dest, encryptBuffer(readFileSync(src), process.env.FPO_BACKUP_KEY));
  run('UPDATE backups SET encrypted_file = ? WHERE file = ?', dest, basename(name));
  audit('backup.encrypt', 'backup', basename(name), { external: Boolean(EXTERNAL_DIR()), size: statSync(dest).size });
  return { file: dest, size: statSync(dest).size, external: Boolean(EXTERNAL_DIR()) };
}

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
  let encrypted = null;
  if (backupKeySet()) {
    try {
      encrypted = encryptBackup(basename(file));
    } catch (e) {
      encrypted = { error: e.message };
    }
  }
  return { file: basename(file), size, verify, encrypted };
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
    for (const dir of [BACKUP_DIR, EXTERNAL_DIR()].filter(Boolean)) rmSync(join(dir, `${f}.enc`), { force: true });
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

/**
 * Учения по восстановлению: последняя копия (зашифрованная, если есть ключ) расшифровывается во временный файл,
 * открывается отдельно от рабочей базы, проверяется целостность, версия схемы и строки по таблицам.
 * Рабочая база не трогается. Результат записывается к копии.
 */
export function restoreDrill() {
  const last = one('SELECT * FROM backups ORDER BY id DESC LIMIT 1');
  if (!last) throw Object.assign(new Error('копий ещё нет — сначала создайте бэкап'), { status: 409 });
  const t0 = Date.now();
  const tmp = join(BACKUP_DIR, `drill-${Date.now()}.db`);
  let detail;
  let ok = false;
  try {
    const useEnc = last.encrypted_file && existsSync(last.encrypted_file) && backupKeySet();
    if (useEnc) writeFileSync(tmp, decryptBuffer(readFileSync(last.encrypted_file), process.env.FPO_BACKUP_KEY));
    else copyFileSync(join(BACKUP_DIR, last.file), tmp);
    const b = new DatabaseSync(tmp, { readOnly: true });
    const integrity = Object.values(b.prepare('PRAGMA integrity_check').get())[0];
    const version = b.prepare('SELECT max(version) v FROM schema_migrations').get().v;
    const counts = {};
    for (const t of CHECK_TABLES) counts[t] = b.prepare(`SELECT count(*) n FROM ${t}`).get().n;
    b.close();
    const live = one('SELECT max(version) v FROM schema_migrations').v;
    const liveCounts = Object.fromEntries(CHECK_TABLES.map((t) => [t, one(`SELECT count(*) n FROM ${t}`).n]));
    // копия со старой схемой восстановима: при открытии миграции поднимут её до текущей; новее текущей — нет
    ok = integrity === 'ok' && version <= live;
    detail = { source: useEnc ? 'encrypted' : 'plain', integrity, version, liveVersion: live, needsMigration: version < live, counts, liveCounts, ms: Date.now() - t0 };
    if (version > live) detail.error = `копия со схемой v${version} новее приложения (v${live}) — обновите приложение`;
  } catch (e) {
    detail = { error: e.message, ms: Date.now() - t0 };
  } finally {
    rmSync(tmp, { force: true });
  }
  run('UPDATE backups SET drill_at = ?, drill_ok = ?, drill_detail = ? WHERE id = ?', nowIso(), ok ? 1 : 0, JSON.stringify(detail), last.id);
  audit('backup.drill', 'backup', last.file, { ok, ...detail, counts: undefined, liveCounts: undefined });
  return { ok, file: last.file, ...detail };
}

/** Восстановление из зашифрованного файла (например, с другого компьютера). */
export function restoreEncrypted(path, pass = process.env.FPO_BACKUP_KEY) {
  const enc = readFileSync(path);
  mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `funpay-ops-restored-${nowIso().replace(/[:.]/g, '-')}.db`;
  writeFileSync(join(BACKUP_DIR, name), decryptBuffer(enc, pass));
  run('INSERT INTO backups(file, created_at, size) VALUES (?, ?, ?)', name, nowIso(), statSync(join(BACKUP_DIR, name)).size);
  return restoreBackup(name);
}
