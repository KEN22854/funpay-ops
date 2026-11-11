import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Empty, NumberField, Warning } from '../../components/ui';
import { api, type Backup, type Diagnostics, type ServerSettings } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';

/** Серверная часть настроек: склад, аналитика, бэкапы, Telegram, диагностика, аудит. */
export function ServerAdmin() {
  const [s, setS] = useState<ServerSettings | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [tg, setTg] = useState<Awaited<ReturnType<typeof api.telegram>> | null>(null);
  const [token, setToken] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>>>([]);
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof api.notifications>>>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    try {
      const [st, d, b, t, a, n] = await Promise.all([api.settings(), api.diagnostics(), api.backups(), api.telegram(), api.audit(), api.notifications()]);
      setS(st.settings);
      setDiag(d);
      setBackups(b);
      setTg(t);
      setChatInput(t.chatIds.join(', '));
      setAudit(a);
      setNotes(n);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  if (offline) return <Warning>Серверные настройки недоступны: сервер не запущен (npm run dev).</Warning>;
  if (!s) return null;
  const setPart = <K extends keyof ServerSettings>(k: K, p: Partial<ServerSettings[K]>) => setS({ ...s, [k]: { ...(s[k] as object), ...p } } as ServerSettings);

  return (
    <div className="space-y-6">
      {msg && <Warning tone={msg.ok ? 'warn' : 'bad'}>{msg.text}</Warning>}

      <Card title="Автодиагностика" right={<button className="btn-ghost text-xs" onClick={load}>Проверить снова</button>}>
        {diag && (
          <ul className="space-y-1.5 text-sm">
            {diag.checks.map((c) => (
              <li key={c.name} className="flex gap-3">
                <Badge tone={c.status === 'ok' ? 'good' : c.status === 'warn' ? 'warn' : 'bad'}>{c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'внимание' : 'ошибка'}</Badge>
                <span className="font-medium">{c.name}</span>
                <span className="text-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Склад и капитал">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Себестоимость</span>
              <select className="input" value={s.inventory.costMethod} onChange={(e) => setPart('inventory', { costMethod: e.target.value as 'fifo' | 'avg' })}>
                <option value="fifo">FIFO (по партиям)</option>
                <option value="avg">средневзвешенная</option>
              </select>
            </label>
            <NumberField label="Стартовый капитал" suffix="₽" value={s.inventory.startingCapital} onChange={(v) => setPart('inventory', { startingCapital: v })} hint="> 0 включает кассу и контроль разрывов" />
            <NumberField label="Лимит одной закупки" suffix="₽" value={s.inventory.maxPurchaseRub} onChange={(v) => setPart('inventory', { maxPurchaseRub: v })} hint="0 — без лимита" />
            <NumberField label="«Мало» при остатке ≤" suffix="шт" value={s.inventory.lowStockQty} onChange={(v) => setPart('inventory', { lowStockQty: Math.floor(v) })} />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={s.inventory.allowNegative} onChange={(e) => setPart('inventory', { allowNegative: e.target.checked })} />
            Разрешить продажу без остатка (минус на складе)
          </label>
          <h4 className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted">Лимиты риска (доля капитала)</h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <NumberField label="На один товар" suffix="%" value={s.risk.maxItemSharePct} onChange={(v) => setPart('risk', { maxItemSharePct: v })} />
            <NumberField label="На один источник" suffix="%" value={s.risk.maxSourceSharePct} onChange={(v) => setPart('risk', { maxSourceSharePct: v })} />
            <NumberField label="На категорию" suffix="%" value={s.risk.maxCategorySharePct} onChange={(v) => setPart('risk', { maxCategorySharePct: v })} />
            <NumberField label="Залежалый товар через" suffix="дн." value={s.risk.staleStockDays} onChange={(v) => setPart('risk', { staleStockDays: v })} />
            <NumberField label="Вес априорных потерь" value={s.risk.lossPriorWeight} onChange={(v) => setPart('risk', { lossPriorWeight: v })} hint="Сколько «своих сделок» весит параметр споров" />
          </div>
          <h4 className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted">Границы ABC / XYZ</h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumberField label="A до" suffix="%" value={s.analytics.abcA} onChange={(v) => setPart('analytics', { abcA: v })} />
            <NumberField label="B до" suffix="%" value={s.analytics.abcB} onChange={(v) => setPart('analytics', { abcB: v })} />
            <NumberField label="X: CV ≤" value={s.analytics.xyzX} onChange={(v) => setPart('analytics', { xyzX: v })} />
            <NumberField label="Y: CV ≤" value={s.analytics.xyzY} onChange={(v) => setPart('analytics', { xyzY: v })} />
          </div>
          <div className="mt-4 flex justify-end">
            <button className="btn-primary" onClick={() => act(() => api.saveSettings({ inventory: s.inventory, analytics: s.analytics, risk: s.risk }), 'Сохранено')}>
              Сохранить
            </button>
          </div>
        </Card>

        <Card title="Telegram">
          <p className="mb-3 text-xs text-muted">
            1) Создайте бота у @BotFather и вставьте токен. 2) Напишите боту /start — он ответит вашим chat id. 3) Добавьте chat id ниже. Токен хранится только в data/secrets.json (не в базе, не в бэкапах и не в git). Бот отвечает
            только чатам из списка.
          </p>
          <div className="flex gap-2">
            <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tg?.configured ? `задан${tg.username ? ` (@${tg.username})` : ''} — введите новый, чтобы заменить` : 'токен бота'} />
            <button className="btn-ghost" disabled={!token} onClick={() => act(() => api.setTelegramToken(token).then(() => setToken('')), 'Токен сохранён')}>
              Сохранить
            </button>
          </div>
          {tg?.error && <p className="mt-1 text-xs text-bad">{tg.error}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="label">Chat id (через запятую)</span>
              <input className="input num" value={chatInput} onChange={(e) => setChatInput(e.target.value)} />
            </label>
            <NumberField label="Уведомлять от (чистыми)" suffix="₽" value={s.notify.minNet} onChange={(v) => setPart('notify', { minNet: v })} />
            <NumberField label="Падение цены конкурента ≥" suffix="%" value={s.notify.competitorDropPct} onChange={(v) => setPart('notify', { competitorDropPct: v })} />
            <NumberField label="Источник не отвечает ≥" suffix="мин" value={s.notify.sourceDownMin} onChange={(v) => setPart('notify', { sourceDownMin: v })} />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={s.notify.enabled} onChange={(e) => setPart('notify', { enabled: e.target.checked })} /> Отправлять уведомления
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-ghost" disabled={!tg?.configured} onClick={() => act(() => api.telegramTest(), 'Тестовое сообщение отправлено')}>
              Тест
            </button>
            <button
              className="btn-primary"
              onClick={() =>
                act(
                  () =>
                    api.saveSettings({
                      notify: {
                        ...s.notify,
                        chatIds: chatInput
                          .split(',')
                          .map((x) => x.trim())
                          .filter((x) => /^-?\d+$/.test(x)),
                      },
                    }),
                  'Сохранено',
                )
              }
            >
              Сохранить
            </button>
          </div>
        </Card>
      </div>

      <Card
        title="Резервные копии базы"
        right={
          <button className="btn-primary" onClick={() => act(() => api.createBackup(), 'Копия создана и проверена')}>
            Создать сейчас
          </button>
        }
      >
        <div className="mb-3 grid gap-3 sm:grid-cols-4">
          <label className="mt-6 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={s.backup.enabled} onChange={(e) => setPart('backup', { enabled: e.target.checked })} /> Автоматически
          </label>
          <NumberField label="Каждые" suffix="ч" value={s.backup.everyH} onChange={(v) => setPart('backup', { everyH: v })} />
          <NumberField label="Хранить" suffix="копий" value={s.backup.keep} onChange={(v) => setPart('backup', { keep: Math.floor(v) })} />
          <button className="btn-ghost mt-5" onClick={() => act(() => api.saveSettings({ backup: s.backup }), 'Сохранено')}>
            Сохранить
          </button>
        </div>
        <p className="mb-2 text-xs text-muted">Каждая копия проверяется сразу: открывается отдельно, проходит integrity_check и сверку количества строк. Перед восстановлением текущая база сама сохраняется в копию.</p>
        {backups.length === 0 ? (
          <Empty>Копий нет.</Empty>
        ) : (
          <div className="overflow-x-auto">
          <table className="table">
            <tbody>
              {backups.slice(0, 20).map((b) => (
                <tr key={b.id}>
                  <td className="num text-xs">{b.file}</td>
                  <td className="text-xs text-muted">{fmtDateTime(b.created_at)}</td>
                  <td className="num text-right text-xs">{(b.size / 1024).toFixed(0)} КБ</td>
                  <td>{!b.exists ? <Badge tone="muted">удалена</Badge> : b.verify_ok ? <Badge tone="good">проверена</Badge> : <Badge tone="bad">не прошла проверку</Badge>}</td>
                  <td className="whitespace-nowrap text-right text-xs">
                    {b.exists && (
                      <>
                        <button className="text-accent hover:underline" onClick={() => act(() => api.verifyBackup(b.file), 'Проверка пройдена')}>
                          проверить
                        </button>
                        <button
                          className="ml-3 text-bad hover:underline"
                          onClick={() => confirm(`Восстановить базу из ${b.file}? Текущее состояние сначала сохранится в отдельную копию.`) && act(() => api.restoreBackup(b.file), 'База восстановлена — обновите страницу')}
                        >
                          восстановить
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Журнал действий">
          {audit.length === 0 ? (
            <Empty>Пусто.</Empty>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto text-xs">
              {audit.map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="num shrink-0 text-muted">{fmtDateTime(a.ts)}</span>
                  <span className="font-medium">{a.action}</span>
                  <span className="truncate text-muted" title={JSON.stringify(a.details)}>
                    {a.details ? JSON.stringify(a.details) : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Уведомления">
          {notes.length === 0 ? (
            <Empty>Уведомлений не было.</Empty>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-auto text-xs">
              {notes.map((n) => (
                <li key={n.id}>
                  <span className="num text-muted">{fmtDateTime(n.ts)}</span> {n.sent ? '✓' : n.error ? '✕' : '·'}
                  {n.text.replace(/<[^>]+>/g, '').split('\n')[0]}
                  {n.error && <span className="text-bad"> — {n.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
