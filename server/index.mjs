// Локальный сервер FunPay Ops: API сканера + раздача собранного фронтенда (dist/).
// Слушает только 127.0.0.1 — наружу не открыт.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './lib/store.mjs';
import { getCatalog, getOffers } from './lib/funpay.mjs';
import { getRates } from './lib/rates.mjs';
import { cacheStats, clearCache } from './lib/http.mjs';
import { discoverSkins, scanWatch } from './scanner.mjs';
import { CATEGORIES, SOURCES } from './sources/registry.mjs';

const PORT = Number(process.env.FPO_PORT || 5181);
const HOST = '127.0.0.1';
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU'), ...a);

/* ───────────── планировщик ───────────── */

const scanning = new Set();
let lastAutoScan = null;
let nextAutoScan = null;

async function runScan(watch) {
  if (scanning.has(watch.id)) return db.get().results[watch.id];
  scanning.add(watch.id);
  try {
    const r = await scanWatch(watch);
    db.setResult(watch.id, r);
    return r;
  } finally {
    scanning.delete(watch.id);
  }
}

let allRunning = null;
function scanAll() {
  if (allRunning) return allRunning;
  allRunning = (async () => {
    const list = db.watches().filter((w) => w.enabled);
    log(`скан: ${list.length} товаров`);
    for (const w of list) {
      try {
        await runScan(w);
      } catch (e) {
        log('ошибка скана', w.name, e.message);
      }
    }
    lastAutoScan = new Date().toISOString();
  })().finally(() => (allRunning = null));
  return allRunning;
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  const min = db.settings().intervalMin;
  if (!min) {
    nextAutoScan = null;
    return;
  }
  nextAutoScan = new Date(Date.now() + min * 60_000).toISOString();
  timer = setTimeout(async () => {
    await scanAll();
    schedule();
  }, min * 60_000);
}

/* ───────────── HTTP ───────────── */

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('слишком большой запрос'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('тело запроса — не JSON'), { status: 400 });
  }
}

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, scanning: [...scanning], allRunning: !!allRunning, lastAutoScan, nextAutoScan, cache: cacheStats(), settings: db.settings() })],
  ['GET', /^\/api\/sources$/, () => ({ categories: CATEGORIES, sources: SOURCES.map(({ adapter, ...s }) => ({ ...s, auto: !!adapter })) })],
  ['GET', /^\/api\/rates$/, () => getRates()],
  ['GET', /^\/api\/funpay\/catalog$/, () => getCatalog()],
  ['GET', /^\/api\/funpay\/offers$/, (_req, _m, url) => getOffers(url.searchParams.get('url'))],
  [
    'GET',
    /^\/api\/funpay\/facets$/,
    async (_req, _m, url) => {
      const p = await getOffers(url.searchParams.get('url'));
      return { url: p.url, title: p.title, total: p.offers.length, pricePer: p.pricePer, facets: p.facets };
    },
  ],
  ['GET', /^\/api\/watches$/, () => ({ watches: db.watches(), results: db.get().results })],
  ['POST', /^\/api\/watches$/, async (req) => db.upsertWatch(await readBody(req))],
  ['DELETE', /^\/api\/watches\/([\w-]+)$/, (_req, m) => (db.removeWatch(m[1]), { ok: true })],
  [
    'POST',
    /^\/api\/scan\/([\w-]+)$/,
    async (_req, m) => {
      const w = db.watches().find((x) => x.id === m[1]);
      if (!w) throw Object.assign(new Error('товар не найден'), { status: 404 });
      return runScan(w);
    },
  ],
  ['POST', /^\/api\/scan-all$/, () => (scanAll(), { started: true })],
  [
    'POST',
    /^\/api\/discover$/,
    async (req) => {
      const b = await readBody(req);
      const r = await discoverSkins({ game: b.game, funpayUrl: b.funpayUrl, onlineOnly: !!b.onlineOnly });
      db.setDiscovery(`${b.game}|${b.funpayUrl}`, r);
      return r;
    },
  ],
  ['GET', /^\/api\/discover$/, () => db.get().discoveries],
  ['GET', /^\/api\/settings$/, () => db.settings()],
  [
    'PUT',
    /^\/api\/settings$/,
    async (req) => {
      const s = db.setSettings(await readBody(req));
      schedule();
      return s;
    },
  ],
  ['POST', /^\/api\/cache\/clear$/, () => (clearCache(), { ok: true })],
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serveStatic(res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Фронтенд не собран: выполни npm run build или открой dev-сервер Vite.');
  }
  let file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  // защита от запросов со сторонних сайтов в браузере (DNS rebinding / CSRF)
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, { error: 'чужой origin' });
  const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) return json(res, 404, { error: 'нет такого метода API' });
  try {
    const body = await route[2](req, url.pathname.match(route[1]), url);
    json(res, 200, body);
  } catch (e) {
    json(res, e.status || (e.code === 'input' ? 400 : 502), { error: e.message, code: e.code });
  }
});

server.listen(PORT, HOST, () => {
  log(`FunPay Ops scanner: http://${HOST}:${PORT}`);
  schedule();
});
