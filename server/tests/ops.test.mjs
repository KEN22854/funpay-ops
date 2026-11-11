// Зашифрованные бэкапы, учения по восстановлению, метрики и журнал ошибок API.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, run } from '../db/db.mjs';
import { apiMetrics, errorLog, recordRequest, routeKey, _resetOps } from '../lib/ops.mjs';

const dir = mkdtempSync(join(tmpdir(), 'fpo-ops-'));
process.env.FPO_BACKUP_DIR = join(dir, 'backups');
process.env.FPO_BACKUP_EXTERNAL_DIR = join(dir, 'cloud');
const B = await import('../repo/backup.mjs');

afterAll(() => {
  delete process.env.FPO_BACKUP_KEY;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* noop */
  }
});

beforeEach(() => {
  closeDb();
  openDb(join(dir, `t-${Math.random().toString(36).slice(2)}.db`));
  _resetOps();
});

describe('шифрование бэкапов (AES-256-GCM)', () => {
  const pass = 'correct horse battery staple';
  it('шифрование и расшифровка; неверный ключ и подмена байта — ошибка', () => {
    const plain = Buffer.from('SQLite format 3\u0000 тестовые данные'.repeat(100));
    const enc = B.encryptBuffer(plain, pass);
    expect(enc.subarray(0, 7).toString()).toBe('FPOENC1');
    expect(enc.includes(Buffer.from('тестовые'))).toBe(false);
    expect(B.decryptBuffer(enc, pass).equals(plain)).toBe(true);
    expect(() => B.decryptBuffer(enc, 'wrong password 123456')).toThrow(/неверный ключ/);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 1;
    expect(() => B.decryptBuffer(tampered, pass)).toThrow(/повреждён/);
    expect(() => B.encryptBuffer(plain, 'short')).toThrow(/16/);
  });

  it('бэкап с ключом создаёт зашифрованную копию во внешней папке; учения проходят по ней', () => {
    process.env.FPO_BACKUP_KEY = pass;
    run("INSERT INTO watches(id, data, created_at, updated_at) VALUES ('w1', '{}', 't', 't')");
    const b = B.createBackup('test');
    expect(b.verify.ok).toBe(true);
    expect(b.encrypted.external).toBe(true);
    expect(b.encrypted.file).toContain('cloud');
    const raw = readFileSync(b.encrypted.file);
    expect(raw.includes(Buffer.from('SQLite format 3'))).toBe(false);
    const d = B.restoreDrill();
    expect(d.ok).toBe(true);
    expect(d.source).toBe('encrypted');
    expect(d.counts.watches).toBe(1);
    expect(B.listBackups()[0].drill_ok).toBe(1);
  });

  it('копия со старой схемой проходит учения (миграции её поднимут); со схемой новее приложения — нет', () => {
    delete process.env.FPO_BACKUP_KEY;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const b = B.createBackup('test');
    const file = join(process.env.FPO_BACKUP_DIR, b.file);
    let db = new DatabaseSync(file);
    db.exec('DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)');
    db.close();
    const old = B.restoreDrill();
    expect(old.ok).toBe(true);
    expect(old.needsMigration).toBe(true);
    db = new DatabaseSync(file);
    db.exec("INSERT INTO schema_migrations(version, name, applied_at) VALUES (99, 'future', 't'), (98, 'f', 't')");
    db.close();
    const future = B.restoreDrill();
    expect(future.ok).toBe(false);
    expect(future.error).toMatch(/новее приложения/);
  });

  it('учения без ключа — по обычной копии; без копий — понятная ошибка', () => {
    delete process.env.FPO_BACKUP_KEY;
    expect(() => B.restoreDrill()).toThrow(/копий ещё нет/);
    B.createBackup('test');
    const d = B.restoreDrill();
    expect(d).toMatchObject({ ok: true, source: 'plain' });
  });
});

describe('метрики и журнал ошибок API', () => {
  it('маршрут нормализуется: идентификаторы не размножают метрики', () => {
    expect(routeKey('POST', '/api/verify/abc123def')).toBe('POST /api/verify/:id');
    expect(routeKey('GET', '/api/watches')).toBe('GET /api/watches');
  });

  it('перцентили, доля ошибок, 5xx — в журнал без секретов', () => {
    for (let i = 1; i <= 100; i++) recordRequest('GET', '/api/x', 200, i);
    recordRequest('GET', '/api/x', 502, 5, 'upstream token=abc123 failed bot123:XYZ');
    recordRequest('GET', '/api/x', 404, 1, 'нет');
    const m = apiMetrics();
    const r = m.routes.find((x) => x.route === 'GET /api/x');
    expect(r.count).toBe(102);
    expect(r.errors).toBe(1);
    expect(r.clientErrors).toBe(1);
    expect(r.p50).toBeGreaterThanOrEqual(45);
    expect(r.p95).toBeGreaterThanOrEqual(90);
    const log = errorLog();
    expect(log).toHaveLength(1);
    expect(log[0].message).not.toContain('abc123');
    expect(log[0].message).not.toContain('XYZ');
  });
});
