// Тесты на реальных процессах: аварийное завершение, конкурентные запросы, защита API, серверный режим с входом.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fpo-proc-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  // Windows держит файлы базы, пока процесс сервера не завершился полностью
  await new Promise((r) => setTimeout(r, 500));
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* временная папка удалится системой */
    }
  }
});

/** запрос с произвольным заголовком Host (fetch его подменить не даёт) */
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const cleanEnv = (extra) => {
  const e = { ...process.env, ...extra };
  delete e.FPO_DB; // у тестового окружения база в памяти — процессам нужен файл
  return e;
};

describe('аварийное завершение', () => {
  it('процесс убит посреди записи: подтверждённые транзакции целы, база не повреждена', async () => {
    const dir = tmp();
    const script = `
      const { openDb, run, tx } = await import(${JSON.stringify('file:///' + join(ROOT, 'server/db/db.mjs').replace(/\\/g, '/'))});
      openDb(${JSON.stringify(join(dir, 'funpay-ops.db'))});
      for (let i = 0; ; i++) {
        tx(() => { run("INSERT INTO audit_log(ts, action, entity) VALUES ('t', 'tick', 'test')"); run("INSERT INTO audit_log(ts, action, entity) VALUES ('t', 'tock', 'test')"); });
        if (i % 50 === 0) process.stdout.write('.');
      }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: cleanEnv({ FPO_DATA_DIR: dir }) });
    await new Promise((r) => child.stdout.once('data', () => setTimeout(r, 300)));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const check = `
      const { openDb, one } = await import(${JSON.stringify('file:///' + join(ROOT, 'server/db/db.mjs').replace(/\\/g, '/'))});
      openDb(${JSON.stringify(join(dir, 'funpay-ops.db'))});
      const ic = Object.values(one('PRAGMA integrity_check'))[0];
      const t = one("SELECT count(*) n FROM audit_log WHERE action = 'tick'").n;
      const k = one("SELECT count(*) n FROM audit_log WHERE action = 'tock'").n;
      console.log(JSON.stringify({ ic, t, k }));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', check], { env: cleanEnv({ FPO_DATA_DIR: dir }), encoding: 'utf8' });
    const r = JSON.parse(out.stdout.trim().split('\n').pop());
    expect(r.ic).toBe('ok');
    expect(r.t).toBeGreaterThan(0);
    // транзакция атомарна: пары tick/tock не разорваны
    expect(r.t).toBe(r.k);
  }, 30_000);
});

describe('HTTP-сервер', () => {
  let server;
  let base;
  const PORT = 5300 + Math.floor(Math.random() * 500);
  beforeAll(async () => {
    const dir = tmp();
    server = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], { env: cleanEnv({ FPO_DATA_DIR: dir, FPO_PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
    base = `http://127.0.0.1:${PORT}`;
    await new Promise((r, j) => {
      const t = setTimeout(() => j(new Error('сервер не запустился')), 15_000);
      server.stdout.on('data', (d) => String(d).includes('FunPay Ops') && (clearTimeout(t), r()));
    });
  }, 20_000);
  afterAll(() => server?.kill());

  const H = { 'Content-Type': 'application/json', 'X-FPO-Client': '1' };

  it('10 параллельных одинаковых запросов с одним ключом → одна закупка', async () => {
    const body = JSON.stringify({ item: 'K', qty: 1, unitPrice: 100, currency: 'RUB' });
    const rs = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/api/purchases`, { method: 'POST', headers: { ...H, 'Idempotency-Key': 'same-key-123456' }, body }).then((r) => r.json())));
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    const list = await fetch(`${base}/api/purchases`).then((r) => r.json());
    expect(list).toHaveLength(1);
  });

  it('конкурентные продажи одного остатка: продано не больше, чем есть', async () => {
    await fetch(`${base}/api/purchases`, { method: 'POST', headers: { ...H, 'Idempotency-Key': 'buy-two-1234567' }, body: JSON.stringify({ item: 'Z', qty: 2, unitPrice: 10, currency: 'RUB' }) });
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => fetch(`${base}/api/sales`, { method: 'POST', headers: { ...H, 'Idempotency-Key': `sell-z-${i}-123456` }, body: JSON.stringify({ item: 'Z', qty: 1, unitPrice: 50, saleFeePct: 0 }) })),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('защита: чужой Host, чужой Origin, без заголовка клиента, без ключа идемпотентности', async () => {
    expect(await rawGet(PORT, '/api/health', { Host: 'evil.example' })).toBe(421);
    expect(await rawGet(PORT, '/api/health', { Host: `127.0.0.1:${PORT}` })).toBe(200);
    expect((await fetch(`${base}/api/watches`, { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/watches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/sales`, { method: 'POST', headers: H, body: '{}' })).status).toBe(400);
    expect((await fetch(`${base}/api/funpay/offers?url=${encodeURIComponent('http://169.254.169.254/')}`)).status).toBe(400);
  });

  it('слишком большой запрос отклоняется', async () => {
    const r = await fetch(`${base}/api/watches`, { method: 'POST', headers: H, body: JSON.stringify({ query: 'x'.repeat(1_100_000) }) });
    expect(r.status).toBe(413);
  });
});

describe('серверный режим (VPS)', () => {
  it('в сети без ключа доступа сервер отказывается запускаться', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'server/index.mjs')], { env: cleanEnv({ FPO_DATA_DIR: tmp(), FPO_HOST: '0.0.0.0', FPO_PORT: '5899', FPO_AUTH_TOKEN: '' }), encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FPO_AUTH_TOKEN/);
  });

  it('с ключом: без входа 401, вход выдаёт cookie, неверный ключ — 401', async () => {
    const PORT = 5900 + Math.floor(Math.random() * 90);
    const token = 'test-token-very-long-1234567890';
    const srv = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], { env: cleanEnv({ FPO_DATA_DIR: tmp(), FPO_PORT: String(PORT), FPO_AUTH_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('FunPay Ops') && r()));
      const b = `http://127.0.0.1:${PORT}`;
      expect((await fetch(`${b}/api/watches`)).status).toBe(401);
      expect((await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FPO-Client': '1' }, body: JSON.stringify({ token: 'wrong' }) })).status).toBe(401);
      const ok = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FPO-Client': '1' }, body: JSON.stringify({ token }) });
      expect(ok.status).toBe(200);
      const cookie = ok.headers.get('set-cookie');
      expect(cookie).toMatch(/HttpOnly/);
      expect((await fetch(`${b}/api/watches`, { headers: { Cookie: cookie.split(';')[0] } })).status).toBe(200);
      expect((await fetch(`${b}/api/watches`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally {
      srv.kill();
    }
  }, 20_000);

  it('сессия переживает перезапуск сервера; отзыв и выход закрывают её', async () => {
    const PORT = 5990 + Math.floor(Math.random() * 9);
    const token = 'test-token-very-long-1234567890';
    const dir = tmp();
    const start = async () => {
      const srv = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], { env: cleanEnv({ FPO_DATA_DIR: dir, FPO_PORT: String(PORT), FPO_AUTH_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('FunPay Ops') && r()));
      return srv;
    };
    const stop = (srv) => new Promise((r) => (srv.once('exit', r), srv.kill()));
    const b = `http://127.0.0.1:${PORT}`;
    const H = { 'Content-Type': 'application/json', 'X-FPO-Client': '1' };
    const loginCookie = async () => (await fetch(`${b}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ token }) })).headers.get('set-cookie').split(';')[0];
    let srv = await start();
    try {
      const c1 = await loginCookie();
      const c2 = await loginCookie();
      await stop(srv);
      srv = await start();
      // после перезапуска обе сессии действуют
      expect((await fetch(`${b}/api/watches`, { headers: { Cookie: c1 } })).status).toBe(200);
      const list = await (await fetch(`${b}/api/sessions`, { headers: { Cookie: c1 } })).json();
      expect(list.sessions).toHaveLength(2);
      expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(c1.split('=')[1]); // сам идентификатор наружу не отдаётся
      // «выйти на других устройствах» закрывает c2, c1 остаётся
      const r = await (await fetch(`${b}/api/sessions/others/revoke`, { method: 'POST', headers: { ...H, Cookie: c1 }, body: '{}' })).json();
      expect(r.revoked).toBe(1);
      expect((await fetch(`${b}/api/watches`, { headers: { Cookie: c2 } })).status).toBe(401);
      await fetch(`${b}/api/logout`, { method: 'POST', headers: { ...H, Cookie: c1 }, body: '{}' });
      expect((await fetch(`${b}/api/watches`, { headers: { Cookie: c1 } })).status).toBe(401);
    } finally {
      srv.kill();
    }
  }, 40_000);
});
