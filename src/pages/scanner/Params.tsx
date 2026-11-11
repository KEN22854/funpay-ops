import { useEffect, useState } from 'react';
import { Card, NumberField, Warning } from '../../components/ui';
import { api, type ServerSettings } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import type { ScannerState } from './useScanner';

const W_LABEL: Record<string, string> = {
  match: 'Совпадение товара',
  margin: 'Чистая маржа',
  liquidity: 'Ликвидность',
  reliability: 'Надёжность источника',
  competition: 'Конкуренция',
  freshness: 'Свежесть данных',
  risk: 'Риск',
  availability: 'Наличие',
};

/** Настройки модели хранятся на сервере, каждое изменение пишется в историю (воспроизводимость расчётов). */
export function Params({ sc }: { sc: ScannerState }) {
  const [s, setS] = useState<ServerSettings | null>(sc.settings);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ key: string; changed_at: string }[]>([]);

  useEffect(() => setS(sc.settings), [sc.settings]);
  useEffect(() => {
    api.settingsHistory().then(setHistory).catch(() => {});
  }, [saved]);

  if (!s) return null;
  const set = <K extends keyof ServerSettings>(k: K, p: Partial<ServerSettings[K]>) => setS({ ...s, [k]: { ...(s[k] as object), ...p } } as ServerSettings);
  const save = async () => {
    setError(null);
    try {
      await sc.saveSettings(s);
      setSaved(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const c = s.costModel;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Модель затрат (прогноз)">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="label">Как FunPay берёт комиссию</span>
              <select className="input" value={c.feeModel} onChange={(e) => set('costModel', { feeModel: e.target.value as 'deduct' | 'addon' })}>
                <option value="deduct">из цены лота: я получаю P × (1 − X)</option>
                <option value="addon">сверху: покупатель платит больше, я получаю P / (1 + X)</option>
              </select>
              <span className="mt-1 block text-xs text-muted">Сверьте в форме лота: сколько показывается вам и сколько покупателю.</span>
            </label>
            <NumberField label="Комиссия FunPay по умолчанию" suffix="%" value={c.defaultSaleFeePct} onChange={(v) => set('costModel', { defaultSaleFeePct: v })} hint="Только если у раздела нет профиля" />
            <NumberField label="Вывод (эффективный)" suffix="%" value={c.withdrawPct} onChange={(v) => set('costModel', { withdrawPct: v })} />
            <NumberField label="Спред курса валют" suffix="%" value={c.fxSpreadPct} onChange={(v) => set('costModel', { fxSpreadPct: v })} hint="Сколько карта/банк берёт сверх курса ЦБ" />
            <NumberField label="Споры и возвраты" suffix="% от цены" value={c.disputePct} onChange={(v) => set('costModel', { disputePct: v })} />
            <NumberField label="Налог" suffix="%" value={c.taxPct} onChange={(v) => set('costModel', { taxPct: v })} hint="НПД 4–6% или ваш режим" />
            <label className="block">
              <span className="label">База налога</span>
              <select className="input" value={c.taxBase} onChange={(e) => set('costModel', { taxBase: e.target.value as 'payout' | 'profit' })}>
                <option value="payout">с полученных денег</option>
                <option value="profit">с прибыли</option>
              </select>
            </label>
            <NumberField label="Минут на заказ" value={c.minutesPerOrder} onChange={(v) => set('costModel', { minutesPerOrder: v })} />
            <NumberField label="Ставка часа" suffix="₽/ч" value={c.hourlyRate} onChange={(v) => set('costModel', { hourlyRate: v })} />
            <NumberField label="Прочие расходы на заказ" suffix="₽" value={c.extraFulfillmentRub} onChange={(v) => set('costModel', { extraFulfillmentRub: v })} hint="Внутриигровые комиссии и т.п." />
            <NumberField label="Стоимость денег" suffix="% годовых" value={c.capitalRatePct} onChange={(v) => set('costModel', { capitalRatePct: v })} hint="Цена заморозки капитала" />
            <NumberField label="Срок продажи по умолчанию" suffix="дн." value={c.expectedDaysToSell} onChange={(v) => set('costModel', { expectedDaysToSell: v })} hint="Если своих продаж товара ещё нет" />
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Цена продажи и свежесть">
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField label="Подрезка" suffix="%" value={s.pricing.undercutPct} onChange={(v) => set('pricing', { undercutPct: v })} />
              <NumberField label="Подрезка" suffix="₽" value={s.pricing.undercutRub} onChange={(v) => set('pricing', { undercutRub: v })} />
              <NumberField label="Мин. конкурентов" value={s.pricing.minCompetitors} onChange={(v) => set('pricing', { minCompetitors: Math.floor(v) })} />
              <NumberField label="Цены FunPay годны" suffix="мин" value={s.freshness.funpayTtlMin} onChange={(v) => set('freshness', { funpayTtlMin: v })} />
              <NumberField label="Цены источников годны" suffix="мин" value={s.freshness.sourceTtlMin} onChange={(v) => set('freshness', { sourceTtlMin: v })} />
              <NumberField label="Ручные цены годны" suffix="ч" value={s.freshness.manualTtlH} onChange={(v) => set('freshness', { manualTtlH: v })} />
            </div>
            <p className="mt-2 text-xs text-muted">Старше этих сроков — жёсткий блок рекомендации.</p>
          </Card>
          <Card title="Оценка привлекательности">
            <p className="mb-3 text-xs text-muted">Стартовые веса из аудита — не статистически доказанные. Калибруйте по своим сделкам (вкладка «Склад и финансы» → качество рекомендаций). Жёсткие блоки действуют независимо от балла.</p>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(s.scoring.weights).map(([k, v]) => (
                <NumberField key={k} label={W_LABEL[k] ?? k} suffix="%" value={v} onChange={(n) => set('scoring', { weights: { ...s.scoring.weights, [k]: n } })} />
              ))}
              <NumberField label="Порог рекомендации" suffix="баллов" value={s.scoring.minScore} onChange={(v) => set('scoring', { minScore: v })} />
              <NumberField label="«Подозрительно дёшево» <" suffix="% FunPay" value={s.scoring.suspiciousPct} onChange={(v) => set('scoring', { suspiciousPct: v })} />
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={s.scoring.requireKnownStock} onChange={(e) => set('scoring', { requireKnownStock: e.target.checked })} />
              Блокировать, если наличие у источника неизвестно
            </label>
          </Card>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Исполнимость и строгость (Profit Verification)">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Перепроверка действует" suffix="мин" value={s.verification.executableTtlMin} onChange={(v) => set('verification', { executableTtlMin: v })} hint="После — снова «кандидат»" />
            <NumberField label="Допустимый рост цены" suffix="%" value={s.verification.priceTolerancePct} onChange={(v) => set('verification', { priceTolerancePct: v })} hint="При перепроверке" />
            <label className="block sm:col-span-2">
              <span className="label">Скины</span>
              <select className="input" value={s.matching.skinsStrict} onChange={(e) => set('matching', { skinsStrict: e.target.value as 'all' | 'pattern' })}>
                <option value="all">строго: каждый скин подтверждается вручную (float, паттерн и наклейки источник не передаёт)</option>
                <option value="pattern">только скины, где цена зависит от фазы/паттерна (Doppler, Case Hardened, Fade…)</option>
              </select>
            </label>
          </div>
        </Card>
        <Card title="Спрос и paper trading">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Минимум снимков рынка" value={s.demand.minSnapshots} onChange={(v) => set('demand', { minSnapshots: Math.floor(v) })} hint="Меньше — ликвидность не оценивается" />
            <NumberField label="Минимум наблюдения" suffix="ч" value={s.demand.minObservationHours} onChange={(v) => set('demand', { minObservationHours: v })} />
            <NumberField label="Своих продаж для статистики" value={s.demand.minOwnSales} onChange={(v) => set('demand', { minOwnSales: Math.floor(v) })} hint="Для вероятности продажи" />
            <NumberField label="Горизонт paper trading" suffix="дн." value={s.paper.horizonDays} onChange={(v) => set('paper', { horizonDays: Math.max(1, v) })} />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={s.paper.enabled} onChange={(e) => set('paper', { enabled: e.target.checked })} />
            Открывать бумажные позиции по кандидатам
          </label>
        </Card>
      </div>
      {error && <Warning tone="bad">{error}</Warning>}
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-xs text-good">Сохранено {fmtDateTime(saved)}</span>}
        <button className="btn-primary" onClick={save}>
          Сохранить параметры
        </button>
      </div>
      {history.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">История изменений настроек ({history.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {history.slice(0, 50).map((h, i) => (
              <li key={i}>
                {fmtDateTime(h.changed_at)} — {h.key}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
