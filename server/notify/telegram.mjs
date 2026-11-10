// Telegram: уведомления (с защитой от повторов) и команды бота.
// Токен хранится в data/secrets.json — вне базы, бэкапов, репозитория и логов.
// Бот отвечает только chat id из белого списка в настройках.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, all, nowIso, run } from '../db/db.mjs';
import { audit } from '../repo/audit.mjs';
import { getSettings } from '../repo/settings.mjs';

const SECRETS = join(DATA_DIR, 'secrets.json');
const API = 'https://api.telegram.org';

function readSecrets() {
  try {
    return existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function setToken(token) {
  const t = String(token ?? '').trim();
  if (t && !/^\d{5,}:[\w-]{30,}$/.test(t)) throw Object.assign(new Error('это не похоже на токен бота от @BotFather'), { status: 400 });
  const s = readSecrets();
  if (t) s.telegramToken = t;
  else delete s.telegramToken;
  writeFileSync(SECRETS, JSON.stringify(s, null, 1), { mode: 0o600 });
  audit('telegram.token', 'telegram', null, { set: Boolean(t) });
  return { configured: Boolean(t) };
}

const token = () => readSecrets().telegramToken ?? process.env.FPO_TELEGRAM_TOKEN ?? null;
export const telegramConfigured = () => Boolean(token());

async function tg(method, body) {
  const t = token();
  if (!t) throw new Error('токен Telegram не задан');
  const res = await fetch(`${API}/bot${t}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
  const j = await res.json().catch(() => ({}));
  // в ошибку не попадает URL с токеном
  if (!j.ok) throw new Error(`Telegram: ${j.description ?? res.status}`);
  return j.result;
}

export async function botInfo() {
  if (!telegramConfigured()) return { configured: false };
  try {
    const me = await tg('getMe', {});
    return { configured: true, username: me.username };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

const escape = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

export async function send(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
}

/**
 * Поставить уведомление. dedupeKey не даёт отправить одно и то же повторно.
 * Отправка — всем chat id из настроек, если уведомления включены.
 */
export async function notify(type, dedupeKey, text) {
  const { notify: N } = getSettings();
  try {
    run('INSERT INTO notifications(ts, type, dedupe_key, text) VALUES (?, ?, ?, ?)', nowIso(), type, dedupeKey, text);
  } catch {
    return { skipped: 'duplicate' };
  }
  if (!N.enabled || !N.chatIds.length || !telegramConfigured()) return { queued: true, sent: false };
  const errors = [];
  for (const id of N.chatIds) {
    try {
      await send(id, text);
    } catch (e) {
      errors.push(e.message);
    }
  }
  run('UPDATE notifications SET sent = ?, error = ? WHERE dedupe_key = ?', errors.length ? 0 : 1, errors.join('; ') || null, dedupeKey);
  return { sent: !errors.length, errors };
}

export const recentNotifications = (limit = 100) => all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', limit);

/* ───────────── команды бота ───────────── */

let polling = false;
let offset = 0;

/**
 * @param {Record<string, () => Promise<string>|string>} commands  /status → текст ответа
 */
export function startBot(commands) {
  if (polling) return;
  polling = true;
  (async function loop() {
    while (polling) {
      if (!telegramConfigured()) {
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      try {
        const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          const chatId = String(msg.chat.id);
          const allowed = getSettings().notify.chatIds.map(String);
          const cmd = msg.text.trim().split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();
          if (!allowed.includes(chatId)) {
            // неизвестному чату — только его id, чтобы владелец мог добавить его в настройки; данные не раскрываются
            if (cmd === '/start') await send(chatId, `FunPay Ops: этот чат не подключён.\nВаш chat id: <code>${escape(chatId)}</code>\nДобавьте его в «Настройки → Telegram».`).catch(() => {});
            continue;
          }
          const handler = commands[cmd] ?? commands['/start'];
          let reply;
          try {
            reply = await handler(msg.text);
          } catch (e) {
            reply = `Ошибка: ${escape(e.message)}`;
          }
          await send(chatId, reply).catch(() => {});
        }
      } catch {
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  })();
}

export function stopBot() {
  polling = false;
}

export { escape };
