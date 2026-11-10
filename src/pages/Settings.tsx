import { Card, NumberField, Page } from '../components/ui';
import { ServerAdmin } from './settings/ServerAdmin';
import { downloadText, STORAGE_KEY } from '../lib/storage';
import { todayISO } from '../lib/format';
import { migrateState, normalizeDeal, useStore } from '../store/useStore';

export default function Settings() {
  const s = useStore((x) => x.settings);
  const setSettings = useStore((x) => x.setSettings);
  const resetSection = useStore((x) => x.resetSection);
  const resetAll = useStore((x) => x.resetAll);
  const counts = { calcs: useStore((x) => x.calcs.length), deals: useStore((x) => x.deals.length) };

  const ask = (msg: string, fn: () => void) => {
    if (confirm(`${msg}\nДействие необратимо.`)) fn();
  };

  const backup = () => {
    const st = useStore.getState();
    const data = { settings: st.settings, calcDraft: st.calcDraft, calcs: st.calcs, deals: st.deals, delivery: st.delivery };
    downloadText(`funpay-ops-backup-${todayISO()}.json`, JSON.stringify({ state: data, version: 2 }, null, 2), 'application/json');
  };

  const restore = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed?.state || typeof parsed.state !== 'object') throw new Error();
      const st = migrateState(parsed.state, Number(parsed.version) || 1) as Record<string, any>;
      useStore.setState({
        settings: { ...useStore.getState().settings, ...st.settings },
        calcDraft: { ...useStore.getState().calcDraft, ...st.calcDraft },
        calcs: Array.isArray(st.calcs) ? st.calcs : [],
        deals: Array.isArray(st.deals) ? st.deals.map(normalizeDeal) : [],
        delivery: { ...useStore.getState().delivery, ...st.delivery },
      });
      alert('Данные восстановлены.');
    } catch {
      alert('Файл не похож на резервную копию FunPay Ops.');
    }
  };

  return (
    <Page title="Настройки">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Тема">
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} className={s.theme === t ? 'btn-primary' : 'btn-ghost'} onClick={() => setSettings({ theme: t })}>
                {t === 'dark' ? 'Тёмная' : 'Светлая'}
              </button>
            ))}
          </div>
        </Card>

        <Card title="Значения по умолчанию">
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              label="Комиссия X"
              suffix="%"
              value={s.defaultFeePct}
              onChange={(v) => setSettings({ defaultFeePct: v })}
              hint="Проверь в своём разделе"
            />
            <NumberField label="Вывод Y" suffix="%" value={s.defaultWithdrawPct} onChange={(v) => setSettings({ defaultWithdrawPct: v })} />
            <NumberField
              label="Порог «жёлтого»"
              suffix="%"
              value={s.warnThresholdPct}
              onChange={(v) => setSettings({ warnThresholdPct: v })}
              hint="Маржа ниже — жёлтый вердикт"
            />
          </div>
          <p className="mt-3 text-xs text-muted">Подставляются в новые расчёты и сделки. Уже сохранённые записи не меняются.</p>
        </Card>

        <Card title="Резервная копия">
          <p className="mb-3 text-sm text-muted">
            Данные хранятся только в этом браузере (localStorage, ключ <span className="num">{STORAGE_KEY}</span>). Очистка данных сайта удалит их.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={backup}>
              Скачать JSON
            </button>
            <label className="btn-ghost cursor-pointer">
              Восстановить из JSON
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) restore(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </Card>

        <Card title="Сброс данных">
          <div className="flex flex-wrap gap-2">
            <button className="btn-danger" onClick={() => ask(`Удалить сохранённые расчёты (${counts.calcs})?`, () => resetSection('calcs'))}>
              Расчёты ({counts.calcs})
            </button>
            <button className="btn-danger" onClick={() => ask(`Удалить все сделки журнала (${counts.deals})?`, () => resetSection('deals'))}>
              Журнал ({counts.deals})
            </button>
            <button className="btn-danger" onClick={() => ask('Очистить пул, сообщение и чеклист автовыдачи?', () => resetSection('delivery'))}>
              Автовыдача
            </button>
            <button className="btn-danger" onClick={() => ask('Вернуть настройки по умолчанию?', () => resetSection('settings'))}>
              Настройки
            </button>
          </div>
          <button className="btn-danger mt-4 w-full" onClick={() => ask('Удалить ВСЕ данные приложения?', resetAll)}>
            Сбросить всё
          </button>
        </Card>
      </div>
      <h2 className="pt-4 text-lg font-semibold">Сервер: склад, бэкапы, уведомления</h2>
      <ServerAdmin />
    </Page>
  );
}
