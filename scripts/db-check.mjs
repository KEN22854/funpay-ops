// Проверка миграций и восстановления на КОПИИ базы (рабочая база не меняется).
//   node scripts/db-check.mjs           — копия data/funpay-ops.db
//   node scripts/db-check.mjs --fresh   — пустая база (CI)
//   node scripts/db-check.mjs <файл.db> — конкретный файл
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const work = mkdtempSync(join(tmpdir(), 'fpo-dbcheck-'));
const target = join(work, 'funpay-ops.db');
process.env.FPO_DATA_DIR = work;
process.env.FPO_DB = target;
process.env.FPO_BACKUP_DIR = join(work, 'backups');

const source = arg === '--fresh' ? null : arg || join(root, 'data', 'funpay-ops.db');
if (source) {
  if (!existsSync(source)) {
    console.error(`Нет файла базы: ${source}`);
    process.exit(2);
  }
  copyFileSync(source, target);
  console.log(`Копия: ${source} → ${target}`);
} else console.log('Пустая база');

const { openDb, one, schemaVersion, closeDb } = await import('../server/db/db.mjs');
const { MIGRATIONS } = await import('../server/db/migrations.mjs');
const { createBackup, verifyBackup } = await import('../server/repo/backup.mjs');

let ok = true;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) ok = false;
};

try {
  const before = source ? (() => {
    // версия схемы до миграции (без открытия через приложение)
    return null;
  })() : null;
  void before;
  openDb(target);
  check('миграции применены', schemaVersion() === MIGRATIONS.at(-1).version, `v${schemaVersion()} из v${MIGRATIONS.at(-1).version}`);
  const ic = Object.values(one('PRAGMA integrity_check'))[0];
  check('integrity_check', ic === 'ok', ic);
  const fk = one('PRAGMA foreign_key_check');
  check('внешние ключи', !fk, fk ? JSON.stringify(fk) : 'нарушений нет');
  for (const t of ['watches', 'purchases', 'sales', 'stock_movements', 'cash_ledger', 'price_snapshots', 'recommendations']) {
    console.log(`  ${t}: ${one(`SELECT count(*) n FROM ${t}`).n}`);
  }
  // повторное открытие не должно ничего менять
  closeDb();
  openDb(target);
  check('повторное открытие идемпотентно', schemaVersion() === MIGRATIONS.at(-1).version);
  const b = createBackup('db-check');
  check('бэкап создан и проверен', b.verify.ok, b.file);
  check('повторная проверка бэкапа', verifyBackup(b.file).ok);
  closeDb();
} catch (e) {
  check('без исключений', false, e.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? 'Итог: OK' : 'Итог: ЕСТЬ ОШИБКИ');
process.exit(ok ? 0 : 1);
