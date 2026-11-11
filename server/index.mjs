// Локальный сервер FunPay Ops 2: API, планировщик сканов, уведомления, бэкапы, раздача фронтенда.
// Слушает только 127.0.0.1. Защита: проверка Host/Origin, обязательный заголовок клиента для изменений (CSRF),
// Idempotency-Key для финансовых операций, лимит размера запроса.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso, one, openDb, schemaVersion, all } from './db/db.mjs';
import { getCatalog, getOffers } from './lib/funpay.mjs';
import { getRates } from './lib/rates.mjs';
import { cacheStats, clearCache } from './lib/http.mjs';
import { discoverSkins, scanWatch } from './scanner.mjs';
import { buildOpportunities, historyFor, marketOverview } from './opportunities.mjs';
import { CATEGORIES, SOURCES } from './sources/registry.mjs';
import { decisions, discoveries, results, watches } from './repo/watches.mjs';
import { addFee, listFees } from './repo/fees.mjs';
import { DEFAULT_SETTINGS, getSettings, settingsHistory, updateSettings } from './repo/settings.mjs';
import { audit, auditLog, idempotent } from './repo/audit.mjs';
import { allHealth, downtimeMin, pruneHealth } from './repo/health.mjs';
import { prunesnapshots } from './repo/history.mjs';
import * as inv from './repo/inventory.mjs';
import { abcXyz, comparePeriods, exportCsv, metrics, recommendationQuality } from './repo/analytics.mjs';
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from './repo/backup.mjs';
import { botInfo, escape, notify, recentNotifications, send, setToken, startBot, telegramConfigured } from './notify/telegram.mjs';
import { STATUS } from './core/engine.mjs';
import { ENGINE_VERSION } from './core/finance.mjs';
import { verifyOpportunity } from './verify.mjs';
import { recordAttempt, sourceQuality } from './repo/quality.mjs';
import { aging, capitalSnapshot, cashFlowForecast, listCashReservations, releaseCash, reserveCash } from './repo/risk.mjs';
import { priceBands, sellProbability, weekdayProfile } from './repo/demand.mjs';
import { closeDuePaper, paperStats } from './repo/paper.mjs';
import { backtestRuns, runBacktest } from './repo/backtest.mjs';
import { productMetrics } from './repo/metrics.mjs';
import { authEnabled, checkAuth, login, logout, rateLimit } from './lib/auth.mjs';

const PORT = Number(process.env.FPO_PORT || 5181);
// по умолчанию — только локально; сервер в сети (FPO_HOST) требует FPO_AUTH_TOKEN — см. docs/DEPLOY.md
const HOST = process.env.FPO_HOST || '127.0.0.1';
const PUBLIC_HOSTS = (process.env.FPO_PUBLIC_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const UI_PORTS = [PORT, 5180];

const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU'), ...a);
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

openDb();

/* ───────────── очередь сканов (Scheduler → Queue → Worker) ───────────── */

const queue = [];
const queued = new Set();
let working = null;
let lastCycle = null;
const scanState = new Map(); // watchId → { lastAt, stableRuns, lastMin }

function enqueue(watchId, priority = false) {
  if (queued.has(watchId) || working === watchId) return;
  queued.add(watchId);
  if (priority) queue.unshift(watchId);
  else queue.push(watchId);
  pump();
}

async function pump() {
  if (working !== null) return;
  const id = queue.shift();
  if (!id) return;
  queued.delete(id);
  working = id;
  try {
    const w = watches.get(id);
    if (w) {
      const r = await scanWatch(w);
      results.set(id, r);
      trackStability(id, r);
      await afterScan(w, r);
    }
  } catch (e) {
    log('ошибка скана', id, e.message);
  } finally {
    working = null;
    if (queue.length) setImmediate(pump);
    else lastCycle = nowIso();
  }
}

async function runScanNow(id) {
  const w = watches.get(id);
  if (!w) throw err('товар не найден', 404);
  const r = await scanWatch(w);
  results.set(id, r);
  trackStability(id, r);
  await afterScan(w, r);
  return r;
}

/** Адаптивный интервал: цена FunPay не меняется — сканируем реже (до 4× базового), изменилась — снова часто */
function trackStability(id, r) {
  const min = r.funpay?.status === 'ok' ? r.funpay.min : null;
  const st = scanState.get(id) ?? { stableRuns: 0, lastMin: null };
  st.stableRuns = min !== null && st.lastMin === min ? st.stableRuns + 1 : 0;
  st.lastMin = min;
  st.lastAt = Date.now();
  scanState.set(id, st);
}

function dueWatches() {
  const base = getSettings().intervalMin;
  if (!base) return [];
  const now = Date.now();
  return watches
    .list()
    .filter((w) => w.enabled)
    .filter((w) => {
      const st = scanState.get(w.id);
      const last = st?.lastAt ?? (results.get(w.id) ? new Date(results.get(w.id).finishedAt).getTime() : 0);
      const factor = Math.min(4, 1 + Math.floor((st?.stableRuns ?? 0) / 3));
      return now - last >= base * factor * 60_000;
    });
}

setInterval(() => {
  for (const w of dueWatches()) enqueue(w.id);
}, 60_000);

/* ───────────── уведомления ───────────── */

async function afterScan(w, r) {
  const S = getSettings();
  const N = S.notify;
  const opps = buildOpportunities({ log: true }).filter((o) => o.watchId === w.id);
  for (const o of opps) {
    const f = o.eval.forecast;
    if ([STATUS.RECOMMENDED, STATUS.CANDIDATE].includes(o.eval.status) && f && f.net >= N.minNet) {
      await notify(
        'opportunity',
        `rec:${o.id}`,
        `${o.eval.status === STATUS.RECOMMENDED ? '🟢 Исполнимо' : '🟡 Кандидат — перепроверьте перед покупкой'}\n<b>${escape(o.name)}</b>\nКупить: ${escape(o.buy.sourceId)} за ${o.buy.priceRub.toFixed(0)} ₽\nПродать: ${f.price} ₽ · чистыми ≈ ${f.net.toFixed(0)} ₽ (${f.netPct.toFixed(1)}%)\nБалл ${o.eval.score.toFixed(0)} · данные ${Math.round(o.eval.ages.sourceMin)} мин\n${escape(o.buy.url ?? '')}`,
      );
    }
    const wasRec = one("SELECT status FROM recommendations WHERE id = ? AND status IN ('RECOMMENDED', 'CANDIDATE')", o.id);
    if (wasRec && o.eval.status === STATUS.BLOCKED && o.eval.blocks.some((b) => b.startsWith('отрицательная'))) {
      await notify('negative', `neg:${o.id}:${nowIso().slice(0, 10)}`, `🔴 <b>${escape(o.name)}</b>: связка стала убыточной (${escape(o.eval.blocks[0])})`);
      require0(o.id);
    }
  }
  // резкое снижение цены конкурента
  if (r.funpay?.status === 'ok') {
    const snaps = all("SELECT min_rub, ts FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' ORDER BY ts DESC LIMIT 2", w.id);
    if (snaps.length === 2 && snaps[1].min_rub > 0 && snaps[0].min_rub !== null) {
      const drop = ((snaps[1].min_rub - snaps[0].min_rub) / snaps[1].min_rub) * 100;
      if (drop >= N.competitorDropPct) await notify('competitor', `drop:${w.id}:${snaps[0].ts}`, `📉 <b>${escape(w.name)}</b>: минимальная цена на FunPay упала на ${drop.toFixed(1)}% (${snaps[1].min_rub} → ${snaps[0].min_rub} ₽)`);
    }
  }
}

function require0(id) {
  // связка больше не рекомендуется — фиксируем в журнале рекомендаций
  getDb().prepare("UPDATE recommendations SET status = 'BLOCKED', last_seen = ? WHERE id = ?").run(nowIso(), id);
}

async function periodicChecks() {
  const S = getSettings();
  const hour = nowIso().slice(0, 13);
  for (const id of ['funpay', ...SOURCES.filter((s) => s.adapter).map((s) => s.id)]) {
    const down = downtimeMin(id);
    if (down >= S.notify.sourceDownMin) await notify('source', `down:${id}:${hour}`, `⚠️ Источник <b>${escape(id)}</b> не отвечает ${down} мин`);
  }
  const day = nowIso().slice(0, 10);
  for (const s of inv.stock('real')) {
    if (s.low && s.onHand >= 0 && one("SELECT 1 FROM sales WHERE item = ? AND mode = 'real' LIMIT 1", s.item)) {
      await notify('stock', `low:${s.item}:${day}`, `📦 Низкий остаток: <b>${escape(s.item)}</b> — доступно ${s.available}`);
    }
  }
  if (S.intervalMin) {
    for (const w of watches.list().filter((x) => x.enabled)) {
      const r = results.get(w.id);
      const age = r ? (Date.now() - new Date(r.finishedAt).getTime()) / 60000 : Infinity;
      if (age > Math.max(S.freshness.funpayTtlMin, S.intervalMin * 4) * 2) await notify('stale', `stale:${w.id}:${day}`, `⏱ Данные по <b>${escape(w.name)}</b> устарели (${Number.isFinite(age) ? Math.round(age) + ' мин' : 'не сканировался'})`);
    }
  }
}
setInterval(() => periodicChecks().catch((e) => log('проверки:', e.message)), 10 * 60_000);

/* ───────────── бэкапы и обслуживание ───────────── */

function maintenance() {
  const B = getSettings().backup;
  if (B.enabled) {
    const last = one('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1')?.created_at;
    if (!last || Date.now() - new Date(last).getTime() >= B.everyH * 3600_000) {
      try {
        const b = createBackup('auto');
        pruneBackups(B.keep);
        log(`бэкап ${b.file}: проверка ${b.verify.ok ? 'ok' : 'ОШИБКА'}`);
        if (!b.verify.ok) notify('backup', `backup:${b.file}`, `❗ Бэкап ${b.file} не прошёл проверку восстановления`);
      } catch (e) {
        log('бэкап не создан:', e.message);
        notify('backup', `backupfail:${nowIso().slice(0, 13)}`, `❗ Бэкап не создан: ${escape(e.message)}`);
      }
    }
  }
  try {
    const n = closeDuePaper();
    if (n) log(`paper trading: закрыто позиций ${n}`);
  } catch (e) {
    log('paper trading:', e.message);
  }
  pruneHealth(30);
  prunesnapshots(120);
}
setInterval(maintenance, 60 * 60_000);

/** Автодиагностика: целостность базы, источники, бэкапы, свежесть, секреты */
function diagnostics() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, status: ok === true ? 'ok' : ok === null ? 'warn' : 'fail', detail });
  const qc = one('PRAGMA quick_check');
  add('Целостность базы', Object.values(qc)[0] === 'ok', Object.values(qc)[0]);
  add('Версия схемы', true, `v${schemaVersion()}`);
  const health = allHealth(['funpay', ...SOURCES.filter((s) => s.adapter).map((s) => s.id)]);
  const failing = Object.values(health).filter((h) => ['failing', 'circuit_open'].includes(h.status));
  add('Источники', failing.length === 0 ? true : null, failing.length ? `не работают: ${failing.map((h) => h.sourceId).join(', ')}` : 'все проверенные отвечают');
  const empty = Object.values(health).filter((h) => h.emptyStreak >= 5);
  if (empty.length) add('Формат источников', null, `${empty.map((h) => h.sourceId).join(', ')}: 5+ ответов подряд без товаров — возможно, изменилась вёрстка`);
  const lastB = one('SELECT * FROM backups ORDER BY id DESC LIMIT 1');
  add('Резервная копия', lastB ? (lastB.verify_ok ? true : false) : null, lastB ? `${lastB.created_at}, проверка ${lastB.verify_ok ? 'пройдена' : 'не пройдена'}` : 'копий ещё нет');
  const S = getSettings();
  const stale = watches.list().filter((w) => {
    const r = results.get(w.id);
    return w.enabled && (!r || Date.now() - new Date(r.finishedAt).getTime() > S.freshness.funpayTtlMin * 60_000);
  });
  add('Свежесть данных', stale.length === 0 ? true : null, stale.length ? `устарели: ${stale.map((w) => w.name).join(', ')}` : 'все товары в пределах TTL');
  const unconfirmed = listFees().filter((f) => f.active && f.scope === 'funpay_section').length;
  add('Комиссии FunPay', unconfirmed > 0 ? true : null, unconfirmed ? `профилей разделов: ${unconfirmed}` : 'ни одной подтверждённой комиссии раздела — используется значение по умолчанию');
  add('Telegram', telegramConfigured() ? true : null, telegramConfigured() ? 'токен задан (хранится в data/secrets.json)' : 'не настроен');
  return { checkedAt: nowIso(), checks };
}

/* ───────────── HTTP ───────────── */

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw err('слишком большой запрос', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw err('тело запроса — не JSON');
  }
}

const range = (url) => {
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')).toISOString() : new Date(Date.now() + 1000).toISOString();
  const days = Number(url.searchParams.get('days') || 30);
  const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')).toISOString() : new Date(new Date(to).getTime() - days * 86400_000).toISOString();
  return { from, to, mode: url.searchParams.get('mode') === 'sim' ? 'sim' : 'real' };
};
const modeQ = (url) => (url.searchParams.get('mode') === 'sim' ? 'sim' : 'real');
const idem = (req, route, fn) => idempotent(req.headers['idempotency-key'], route, fn);

async function withFx(b) {
  if (!b.currency || b.currency === 'RUB' || b.fxRate) return b;
  const { rates } = await getRates();
  const r = rates[String(b.currency).toUpperCase()];
  if (!r) throw err(`нет курса ЦБ для ${b.currency}`);
  return { ...b, fxRate: r };
}

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, version: 2, engine: ENGINE_VERSION, auth: authEnabled(), schema: schemaVersion(), working, queue: [...queue], lastCycle, settings: { intervalMin: getSettings().intervalMin }, cache: cacheStats(), telegram: telegramConfigured() })],
  ['GET', /^\/api\/diagnostics$/, () => diagnostics()],
  ['GET', /^\/api\/sources$/, () => ({ categories: CATEGORIES, sources: SOURCES.map(({ adapter, ...s }) => ({ ...s, auto: !!adapter })), health: allHealth(['funpay', ...SOURCES.map((s) => s.id)]) })],
  ['GET', /^\/api\/rates$/, () => getRates()],
  ['GET', /^\/api\/funpay\/catalog$/, () => getCatalog()],
  ['GET', /^\/api\/funpay\/offers$/, (_q, _m, url) => getOffers(url.searchParams.get('url'))],
  ['GET', /^\/api\/funpay\/facets$/, async (_q, _m, url) => {
    const p = await getOffers(url.searchParams.get('url'));
    return { url: p.url, title: p.title, total: p.offers.length, pricePer: p.pricePer, facets: p.facets };
  }],

  ['GET', /^\/api\/watches$/, () => ({ watches: watches.list(), results: results.all() })],
  ['POST', /^\/api\/watches$/, async (req) => watches.upsert(await readBody(req))],
  ['DELETE', /^\/api\/watches\/([\w-]+)$/, (_q, m) => (watches.remove(m[1]), { ok: true })],
  ['POST', /^\/api\/scan\/([\w-]+)$/, (_q, m) => runScanNow(m[1])],
  ['POST', /^\/api\/scan-all$/, () => {
    for (const w of watches.list().filter((x) => x.enabled)) enqueue(w.id);
    return { queued: queue.length + (working ? 1 : 0) };
  }],
  ['POST', /^\/api\/match$/, async (req) => {
    const b = await readBody(req);
    return decisions.set(b.watchId, b.offerUrl, b.side, b.status, b.reason);
  }],
  ['GET', /^\/api\/discover$/, () => discoveries.all()],
  ['POST', /^\/api\/discover$/, async (req) => {
    const b = await readBody(req);
    const r = await discoverSkins({ game: b.game, funpayUrl: b.funpayUrl, onlineOnly: !!b.onlineOnly });
    discoveries.set(`${b.game}|${b.funpayUrl}`, r);
    buildOpportunities({ log: true });
    return r;
  }],

  ['GET', /^\/api\/opportunities$/, () => ({ generatedAt: nowIso(), items: buildOpportunities() })],
  ['GET', /^\/api\/market$/, () => marketOverview()],
  ['GET', /^\/api\/history\/([\w-]+)$/, (_q, m, url) => historyFor(m[1], Number(url.searchParams.get('days') || 30))],

  ['GET', /^\/api\/fees$/, () => listFees()],
  ['POST', /^\/api\/fees$/, async (req) => addFee(await readBody(req))],

  ['GET', /^\/api\/settings$/, () => ({ settings: getSettings(), defaults: DEFAULT_SETTINGS })],
  ['PUT', /^\/api\/settings$/, async (req) => updateSettings(await readBody(req))],
  ['GET', /^\/api\/settings\/history$/, () => settingsHistory()],

  ['GET', /^\/api\/stock$/, (_q, _m, url) => ({ items: inv.stock(modeQ(url)), cash: { tracking: inv.cashTracking(modeQ(url)), balance: inv.cashBalance(modeQ(url)) }, reservations: inv.lists.reservations(modeQ(url)) })],
  ['GET', /^\/api\/purchases$/, (_q, _m, url) => inv.lists.purchases(modeQ(url))],
  ['POST', /^\/api\/purchases$/, async (req) => {
    const b = await withFx(await readBody(req));
    return idem(req, 'purchase', () => inv.createPurchase(b));
  }],
  ['POST', /^\/api\/purchases\/([\w-]+)\/receive$/, async (req, m) => {
    const b = await readBody(req);
    return idem(req, `receive:${m[1]}`, () => inv.receivePurchase(m[1], b));
  }],
  ['POST', /^\/api\/purchases\/([\w-]+)\/cancel$/, async (req, m) => {
    const b = await readBody(req);
    return idem(req, `cancel:${m[1]}`, () => inv.cancelPurchase(m[1], b.note));
  }],
  ['GET', /^\/api\/sales$/, (_q, _m, url) => inv.lists.sales(modeQ(url))],
  ['POST', /^\/api\/sales$/, async (req) => {
    const b = await readBody(req);
    return idem(req, 'sale', () => inv.createSale(b));
  }],
  ['POST', /^\/api\/sales\/import$/, async (req) => {
    const b = await readBody(req);
    if (!Array.isArray(b.deals)) throw err('deals: массив сделок журнала');
    return idem(req, 'sale-import', () => {
      let n = 0;
      for (const d of b.deals.slice(0, 5000)) {
        // исход спора из старого журнала: refund — полный возврат, partial — возврат суммы потери
        const s = inv.createSale({ ...d, imported: true, status: d.outcome === 'won' ? 'disputed_won' : 'completed' });
        if (d.outcome === 'refund') inv.refundSale(s.id, {});
        else if (d.outcome === 'partial' && Number(d.disputeLoss) > 0) inv.refundSale(s.id, { amount: Math.min(Number(d.disputeLoss), s.payout_rub) });
        n++;
      }
      audit('sale.import', 'sale', null, { count: n });
      return { imported: n };
    });
  }],
  ['POST', /^\/api\/sales\/([\w-]+)\/refund$/, async (req, m) => {
    const b = await readBody(req);
    return idem(req, `refund:${m[1]}`, () => inv.refundSale(m[1], b));
  }],
  ['POST', /^\/api\/sales\/([\w-]+)\/dispute$/, async (req, m) => {
    const b = await readBody(req);
    return idem(req, `dispute:${m[1]}`, () => inv.markDispute(m[1], b.won !== false));
  }],
  ['POST', /^\/api\/stock\/writeoff$/, async (req) => {
    const b = await readBody(req);
    return idem(req, 'writeoff', () => inv.writeOff(b));
  }],
  ['POST', /^\/api\/stock\/reserve$/, async (req) => {
    const b = await readBody(req);
    return idem(req, 'reserve', () => inv.reserve(b));
  }],
  ['POST', /^\/api\/reservations\/([\w-]+)\/release$/, (req, m) => idem(req, `release:${m[1]}`, () => inv.release(m[1]))],
  ['GET', /^\/api\/ledger$/, (_q, _m, url) => inv.lists.ledger(modeQ(url))],
  ['POST', /^\/api\/cash$/, async (req) => {
    const b = await readBody(req);
    return idem(req, 'cash', () => inv.cashMove(b));
  }],

  ['GET', /^\/api\/analytics\/metrics$/, (_q, _m, url) => metrics(range(url))],
  ['GET', /^\/api\/analytics\/compare$/, (_q, _m, url) => comparePeriods(range(url))],
  ['GET', /^\/api\/analytics\/abcxyz$/, (_q, _m, url) => abcXyz(range(url))],
  ['GET', /^\/api\/analytics\/recommendations$/, () => recommendationQuality()],

  ['POST', /^\/api\/verify\/([\w-]+)$/, async (req, m) => {
    const b = await readBody(req);
    return verifyOpportunity(m[1], b, (watchId) => runScanNow(watchId));
  }],
  ['POST', /^\/api\/attempts$/, async (req) => recordAttempt(await readBody(req))],
  ['GET', /^\/api\/quality\/sources$/, () => {
    // автоматические источники + ручные, по которым были попытки закупки
    const ids = new Set(['funpay', ...SOURCES.filter((s) => s.adapter).map((s) => s.id), ...all('SELECT DISTINCT source_id FROM execution_attempts').map((r) => r.source_id)]);
    return Object.fromEntries([...ids].map((id) => [id, sourceQuality(id)]));
  }],
  ['GET', /^\/api\/demand$/, (_q, _m, url) => {
    const item = url.searchParams.get('item') || undefined;
    const category = url.searchParams.get('category') || undefined;
    return { sell: sellProbability({ item, category }, { minEvents: getSettings().demand.minOwnSales }), bands: priceBands({ item }), weekdays: weekdayProfile(item) };
  }],
  ['GET', /^\/api\/risk$/, (_q, _m, url) => {
    const mode = modeQ(url);
    return { capital: capitalSnapshot(mode), aging: aging(mode), cashFlow: cashFlowForecast(mode), reservations: listCashReservations(mode), limits: getSettings().risk };
  }],
  ['POST', /^\/api\/cash\/reserve$/, async (req) => {
    const b = await readBody(req);
    return idem(req, 'cash-reserve', () => reserveCash(b));
  }],
  ['POST', /^\/api\/cash\/reserve\/([\w-]+)\/release$/, (req, m) => idem(req, `cash-release:${m[1]}`, () => releaseCash(m[1]))],
  ['GET', /^\/api\/paper$/, () => paperStats()],
  ['GET', /^\/api\/backtest$/, () => backtestRuns()],
  ['POST', /^\/api\/backtest$/, async (req) => runBacktest(await readBody(req))],
  ['GET', /^\/api\/metrics\/product$/, (_q, _m, url) => productMetrics(range(url))],
  ['GET', /^\/api\/audit$/, (_q, _m, url) => auditLog({ entity: url.searchParams.get('entity') || undefined })],
  ['GET', /^\/api\/backups$/, () => listBackups()],
  ['POST', /^\/api\/backups$/, () => createBackup('manual')],
  ['POST', /^\/api\/backups\/([\w.-]+)\/verify$/, (_q, m) => verifyBackup(m[1])],
  ['POST', /^\/api\/backups\/([\w.-]+)\/restore$/, async (req, m) => {
    const b = await readBody(req);
    if (b.confirm !== m[1]) throw err('для восстановления передайте confirm с именем файла копии');
    return restoreBackup(m[1]);
  }],
  ['GET', /^\/api\/telegram$/, async () => ({ ...(await botInfo()), chatIds: getSettings().notify.chatIds, enabled: getSettings().notify.enabled })],
  ['PUT', /^\/api\/telegram$/, async (req) => setToken((await readBody(req)).token)],
  ['POST', /^\/api\/telegram\/test$/, async () => {
    const ids = getSettings().notify.chatIds;
    if (!ids.length) throw err('добавьте chat id в настройках');
    for (const id of ids) await send(id, '✅ FunPay Ops: тестовое уведомление');
    return { sent: ids.length };
  }],
  ['GET', /^\/api\/notifications$/, () => recentNotifications()],
  ['POST', /^\/api\/cache\/clear$/, () => (clearCache(), { ok: true })],
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serveStatic(res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Фронтенд не собран: выполните npm run build или откройте dev-сервер Vite.');
  }
  let file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(file).pipe(res);
}

const LOCAL_HOST = new RegExp(`^(127\\.0\\.0\\.1|localhost)(:(${UI_PORTS.join('|')}))?$`);
const LOCAL_ORIGIN = new RegExp(`^http://(127\\.0\\.0\\.1|localhost)(:(${UI_PORTS.join('|')}))?$`);
const hostOk = (h) => LOCAL_HOST.test(h) || PUBLIC_HOSTS.includes(String(h).toLowerCase().replace(/:443$/, ''));
const originOk = (o) => LOCAL_ORIGIN.test(o) || PUBLIC_HOSTS.some((h) => o === `https://${h}` || o === `http://${h}`);

/** дорогие операции: не больше N за минуту, чтобы случайные повторы не нагружали источники и FunPay */
const RATE = [
  [/^\/api\/scan(-all)?(\/|$)/, 20],
  [/^\/api\/discover$/, 3],
  [/^\/api\/verify\//, 20],
  [/^\/api\/backtest$/, 5],
  [/^\/api\/backups/, 10],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  // DNS rebinding: чужое имя хоста, указывающее на сервер, не пройдёт
  if (!hostOk(req.headers.host ?? '')) return json(res, 421, { error: 'недопустимый Host' });
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  const origin = req.headers.origin;
  if (origin && !originOk(origin)) return json(res, 403, { error: 'чужой origin' });
  // CSRF: изменяющие запросы обязаны нести заголовок клиента — браузер не пошлёт его с чужого сайта без preflight
  if (req.method !== 'GET' && req.headers['x-fpo-client'] !== '1') return json(res, 403, { error: 'нет заголовка X-FPO-Client' });
  // вход (только в серверном режиме с FPO_AUTH_TOKEN)
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const r = login(req, (await readBody(req).catch(() => ({}))).token);
    return r.ok ? json(res, 200, { ok: true }, { 'Set-Cookie': r.cookie }) : json(res, r.status, { error: r.error });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': logout(req) });
  if (!checkAuth(req)) return json(res, 401, { error: 'нужен вход', code: 'auth' });
  if (req.method !== 'GET') {
    const rule = RATE.find(([re]) => re.test(url.pathname));
    const wait = rule && rateLimit(rule[0].source, rule[1], 60_000);
    if (wait) return json(res, 429, { error: `слишком часто — повторите через ${wait} с` }, { 'Retry-After': String(wait) });
  }
  const exp = req.method === 'GET' && url.pathname.match(/^\/api\/export\/(sales|purchases|ledger)$/);
  if (exp) {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="funpay-ops-${exp[1]}-${nowIso().slice(0, 10)}.csv"` });
    return res.end(exportCsv(exp[1], modeQ(url)));
  }
  const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) return json(res, 404, { error: 'нет такого метода API' });
  try {
    const body = await route[2](req, url.pathname.match(route[1]), url);
    json(res, 200, body);
  } catch (e) {
    const status = e.status || (e.code === 'input' ? 400 : 502);
    if (status >= 500) log('ошибка API', req.method, url.pathname, e.message);
    json(res, status, { error: e.message, code: e.code });
  }
});

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !authEnabled()) {
  console.error('Отказ запуска: сервер открыт в сеть (FPO_HOST), но не задан FPO_AUTH_TOKEN. См. docs/DEPLOY.md');
  process.exit(1);
}
if (authEnabled() && String(process.env.FPO_AUTH_TOKEN).length < 24) {
  console.error('Отказ запуска: FPO_AUTH_TOKEN короче 24 символов.');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  log(`FunPay Ops 2: http://${HOST}:${PORT} (схема v${schemaVersion()})`);
  maintenance();
  startBot(botCommands());
});

/* ───────────── команды Telegram ───────────── */

function botCommands() {
  const rub = (v) => `${Math.round(v ?? 0).toLocaleString('ru-RU')} ₽`;
  const period = (days) => ({ from: new Date(Date.now() - days * 86400_000).toISOString(), to: new Date(Date.now() + 1000).toISOString(), mode: 'real' });
  return {
    '/start': () =>
      'FunPay Ops — команды:\n/status — система и источники\n/opportunities — проверенные возможности\n/profit [дней] — прибыль\n/report — отчёт за неделю\n/market — рынок\n/orders — последние продажи\n/inventory — остатки\n/alerts — уведомления\n/sources — здоровье источников',
    '/status': () => {
      const d = diagnostics();
      return `<b>Состояние</b>\n${d.checks.map((c) => `${c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'} ${escape(c.name)}: ${escape(c.detail)}`).join('\n')}`;
    },
    '/opportunities': () => {
      const items = buildOpportunities()
        .filter((o) => [STATUS.RECOMMENDED, STATUS.CANDIDATE].includes(o.eval.status))
        .sort((a, b) => (b.eval.netPerDay ?? 0) - (a.eval.netPerDay ?? 0))
        .slice(0, 5);
      if (!items.length) return 'Проверенных возможностей сейчас нет.';
      return items
        .map((o) => `${o.eval.status === STATUS.RECOMMENDED ? '🟢' : '🟡'} <b>${escape(o.name)}</b>: ${escape(o.buy.sourceId)} ${rub(o.buy.priceRub)} → ${rub(o.eval.forecast.price)}, чистыми ${rub(o.eval.forecast.net)} (≈${rub(o.eval.netPerDay)}/день, балл ${o.eval.score.toFixed(0)})`)
        .join('\n') + '\n🟡 — кандидат: перепроверьте цену и наличие перед покупкой';
    },
    '/profit': (text) => {
      const days = Math.min(365, Math.max(1, Number(text.split(/\s+/)[1]) || 7));
      const m = metrics(period(days));
      return `<b>Прибыль за ${days} дн.</b>\nВыручка ${rub(m.revenue)}\nЧистая прибыль ${rub(m.netProfit)}${m.netMarginPct !== null ? ` (${m.netMarginPct.toFixed(1)}%)` : ''}\nЗаказов ${m.orders}`;
    },
    '/report': () => {
      const c = comparePeriods(period(7));
      const d = (k) => (c.deltaPct[k] === null ? '' : ` (${c.deltaPct[k] > 0 ? '+' : ''}${c.deltaPct[k].toFixed(0)}%)`);
      return `<b>Отчёт: 7 дней к предыдущим 7</b>\nВыручка ${rub(c.current.revenue)}${d('revenue')}\nЧистая прибыль ${rub(c.current.netProfit)}${d('netProfit')}\nЗаказов ${c.current.orders}${d('orders')}\nСредний чек ${rub(c.current.aov)}\nВозвраты ${c.current.refundRatePct?.toFixed(1) ?? '—'}% · споры ${c.current.disputeRatePct?.toFixed(1) ?? '—'}%\nЗапасы ${rub(c.current.inventoryEnd)}`;
    },
    '/market': () => {
      const m = marketOverview().filter((x) => x.funpay);
      if (!m.length) return 'Нет истории рынка — добавьте товары и дождитесь сканов.';
      return m
        .slice(0, 10)
        .map((x) => `• ${escape(x.name)}: мин. ${rub(x.funpay.min)}, лотов ${x.funpay.count}, 24ч ${x.funpay.changes['24h'] === null ? '—' : x.funpay.changes['24h'].toFixed(1) + '%'}`)
        .join('\n');
    },
    '/orders': () => {
      const s = inv.lists.sales('real', 10);
      return s.length ? s.map((x) => `• ${x.sold_at.slice(0, 10)} ${escape(x.item)} ×${x.qty}: ${rub(x.net_rub)} [${x.status}]`).join('\n') : 'Продаж пока нет.';
    },
    '/inventory': () => {
      const st = inv.stock('real').filter((x) => x.onHand || x.inTransit);
      return st.length ? st.map((x) => `• ${escape(x.item)}: ${x.available} дост. (${x.onHand} на складе, ${x.inTransit} в пути) — ${rub(x.valueRub)}`).join('\n') : 'Склад пуст.';
    },
    '/alerts': () => {
      const n = recentNotifications(10);
      return n.length ? n.map((x) => `• ${x.ts.slice(5, 16).replace('T', ' ')} ${x.text.split('\n')[0]}`).join('\n') : 'Уведомлений не было.';
    },
    '/sources': () => {
      const h = Object.values(allHealth(['funpay', ...SOURCES.filter((s) => s.adapter).map((s) => s.id)])).filter((x) => x.calls);
      return h.length ? h.map((x) => `${x.status === 'ok' ? '✅' : x.status === 'degraded' ? '⚠️' : '❌'} ${escape(x.sourceId)}: ${Math.round(x.successRate * 100)}%${x.lastError ? `, последняя ошибка: ${escape(x.lastError.class)}` : ''}`).join('\n') : 'Источники ещё не опрашивались.';
    },
  };
}
