// Decision Center: что сделать прямо сейчас, чтобы заработать или не потерять.
// Каждое правило — конкретное действие с объяснением, оценкой эффекта в рублях и ссылкой туда, где его выполнить.
// Правила только советуют: закупка, продажа и цены остаются решением человека.
import { all, one } from './db/db.mjs';
import { STATUS } from './core/engine.mjs';
import { forecast } from './core/finance.mjs';
import { buildOpportunities } from './opportunities.mjs';
import { healthSummary } from './repo/health.mjs';
import { sourcePolicy } from './repo/quality.mjs';
import { aging, capitalSnapshot, listCashReservations } from './repo/risk.mjs';
import { paperStats } from './repo/paper.mjs';
import { saleFeeFor } from './repo/fees.mjs';
import { getSettings } from './repo/settings.mjs';
import { results, watches } from './repo/watches.mjs';

const DAY = 86400_000;
const ageDays = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / DAY : Infinity);
const rub = (x) => `${Math.round(x).toLocaleString('ru-RU')} ₽`;

/**
 * @typedef {{ id: string, priority: 1|2|3, kind: string, title: string, detail: string, impactRub: number|null, action: { label: string, to: string } }} Decision
 * priority: 1 — деньги сейчас (купить, спасти от убытка); 2 — разблокировать прибыль; 3 — гигиена данных
 */

/** @returns {{ decisions: Decision[], summary: object }} */
export function decisions({ opportunities } = {}) {
  const S = getSettings();
  const opps = opportunities ?? buildOpportunities();
  const snap = capitalSnapshot('real');
  /** @type {Decision[]} */
  const out = [];
  const add = (d) => out.push(d);

  // ── 1. купить: исполнимые связки, лучшие по прибыли в день оборота
  const rec = opps.filter((o) => o.eval.status === STATUS.RECOMMENDED && o.eval.forecast).sort((a, b) => (b.eval.netPerDay ?? 0) - (a.eval.netPerDay ?? 0));
  let budget = snap.freeCash ?? Infinity;
  for (const o of rec.slice(0, 10)) {
    const f = o.eval.forecast;
    const fits = f.invested <= budget;
    if (fits && Number.isFinite(budget)) budget -= f.invested;
    add({
      id: `buy:${o.id}`,
      priority: fits ? 1 : 2,
      kind: 'buy',
      title: `Купить «${o.name}» у ${o.buy.sourceId} за ${rub(o.buy.priceRub)}`,
      detail: `Цена и наличие подтверждены. Ожидаемо +${rub(f.net)} чистыми (${f.netPct.toFixed(1)}%), ${o.eval.netPerDay !== null ? `${rub(o.eval.netPerDay)}/день оборота` : 'срок продажи неизвестен'}. Перепроверка действует ${S.verification.executableTtlMin} мин.${fits ? '' : ' Свободных денег не хватает с учётом более выгодных покупок выше.'}`,
      impactRub: f.net,
      action: { label: 'Открыть связку', to: '/scanner?tab=opps' },
    });
  }

  // ── 2. перепроверить: кандидаты, которым до покупки не хватает только перепроверки
  const cand = opps
    .filter((o) => o.eval.status === STATUS.CANDIDATE && o.eval.forecast && o.eval.forecast.net > 0)
    .sort((a, b) => (b.eval.netPerDay ?? b.eval.forecast.net) - (a.eval.netPerDay ?? a.eval.forecast.net));
  for (const o of cand.slice(0, 10)) {
    add({
      id: `verify:${o.id}`,
      priority: 1,
      kind: 'verify',
      title: `Перепроверить «${o.name}» у ${o.buy.sourceId}`,
      detail: `Потенциально +${rub(o.eval.forecast.net)}. До «Исполнимо» не хватает: ${o.eval.executionGaps.join('; ') || 'перепроверки'}. Нажмите «Проверить сейчас».`,
      impactRub: o.eval.forecast.net,
      action: { label: 'Проверить', to: '/scanner?tab=opps' },
    });
  }

  // ── 3. подтвердить совпадение: прибыль заблокирована только ручной проверкой товара
  const review = opps.filter((o) => o.eval.status === STATUS.REVIEW && o.eval.forecast && o.eval.forecast.net > 0 && o.eval.reviews.some((r) => r.startsWith('нужна проверка совпадения')));
  for (const o of review.sort((a, b) => b.eval.forecast.net - a.eval.forecast.net).slice(0, 5)) {
    add({
      id: `match:${o.id}`,
      priority: 2,
      kind: 'match',
      title: `Сверить товар «${o.name}» и предложение ${o.buy.sourceId}`,
      detail: `${o.eval.reviews.find((r) => r.startsWith('нужна проверка совпадения'))}. Если это тот же товар — подтвердите пару, и связка пойдёт дальше (+${rub(o.eval.forecast.net)}).`,
      impactRub: o.eval.forecast.net,
      action: { label: 'Сверить', to: '/scanner?tab=opps' },
    });
  }

  // ── 4. неподтверждённая комиссия раздела: прибыль может быть завышена
  const bySection = new Map();
  for (const o of opps) {
    if (!o.saleFee?.assumed || ![STATUS.RECOMMENDED, STATUS.CANDIDATE].includes(o.eval.status)) continue;
    const k = o.market?.sectionUrl ?? '';
    const g = bySection.get(k) ?? { n: 0, net: 0, name: o.name, pct: o.saleFee.pct };
    g.n++;
    g.net += o.eval.forecast?.net ?? 0;
    bySection.set(k, g);
  }
  for (const [url, g] of bySection) {
    add({
      id: `fee:${url}`,
      priority: 2,
      kind: 'fee',
      title: `Подтвердить комиссию раздела FunPay (${g.n} связок, напр. «${g.name}»)`,
      detail: `Сейчас принято ${g.pct}% — это допущение. Посмотрите ставку в форме создания лота и внесите её: иначе прибыль ${rub(g.net)} может оказаться меньше. Раздел: ${url || 'не указан'}.`,
      impactRub: null,
      action: { label: 'Комиссии', to: '/scanner?tab=fees' },
    });
  }

  // ── 5. склад: рынок ниже себестоимости и залежавшийся товар
  const ag = aging('real');
  const byItem = new Map();
  for (const it of ag.items) {
    const g = byItem.get(it.item) ?? { qty: 0, value: 0, maxAge: 0 };
    g.qty += it.qty;
    g.value += it.value;
    g.maxAge = Math.max(g.maxAge, it.ageDays);
    byItem.set(it.item, g);
  }
  const wByName = new Map(watches.list().map((w) => [w.name, w]));
  for (const [item, g] of byItem) {
    const w = wByName.get(item);
    const fpMin = w ? one("SELECT min_rub, ts FROM price_snapshots WHERE watch_id = ? AND kind = 'funpay' AND min_rub IS NOT NULL ORDER BY ts DESC LIMIT 1", w.id) : null;
    const unitCost = g.value / g.qty;
    if (fpMin && ageDays(fpMin.ts) < 2) {
      const price = Math.max(0, fpMin.min_rub * (1 - S.pricing.undercutPct / 100) - S.pricing.undercutRub);
      const f = forecast({ sellPrice: price, buyRub: unitCost, saleFee: saleFeeFor(w.funpay?.url, S.costModel.defaultSaleFeePct), sourceFee: { pct: 0, fixed: 0 }, m: S.costModel, daysToSell: S.costModel.expectedDaysToSell });
      if (f.net < 0) {
        add({
          id: `loss:${item}`,
          priority: 1,
          kind: 'loss',
          title: `«${item}»: рынок ниже себестоимости`,
          detail: `Себестоимость ${rub(unitCost)}, на FunPay сейчас от ${rub(fpMin.min_rub)} — продажа по рынку даст ${rub(f.net)} за штуку. Решите: держать (если ждёте роста) или продать, чтобы освободить ${rub(g.value)}. Новые закупки этого товара — только после восстановления цены.`,
          impactRub: f.net * g.qty,
          action: { label: 'Склад', to: '/inventory' },
        });
        continue;
      }
    }
    if (g.maxAge > ag.staleDays) {
      add({
        id: `stale:${item}`,
        priority: 2,
        kind: 'stale',
        title: `«${item}» лежит ${Math.round(g.maxAge)} дн. — заморожено ${rub(g.value)}`,
        detail: `Дольше порога ${ag.staleDays} дн. Снизьте цену лота до уровня самых дешёвых конкурентов или распродайте: деньги в обороте приносят больше, чем товар на полке.`,
        impactRub: null,
        action: { label: 'Склад', to: '/inventory' },
      });
    }
  }

  // ── 6. закупки в пути слишком долго
  for (const p of all("SELECT id, item, qty, purchased_at AS created_at, source_id FROM purchases WHERE mode = 'real' AND status = 'in_transit'")) {
    if (ageDays(p.created_at) < 2) continue;
    add({
      id: `transit:${p.id}`,
      priority: 2,
      kind: 'transit',
      title: `Закупка «${p.item}» в пути ${Math.floor(ageDays(p.created_at))} дн.`,
      detail: `Если товар получен — отметьте «получено» (можно частично). Если нет — свяжитесь с продавцом ${p.source_id ?? ''} или отмените закупку, чтобы вернуть деньги в кассу.`,
      impactRub: null,
      action: { label: 'Закупки', to: '/inventory' },
    });
  }

  // ── 7. резервы денег, которые никто не использовал
  for (const r of listCashReservations('real')) {
    if (ageDays(r.created_at) < 3) continue;
    add({
      id: `reserve:${r.id}`,
      priority: 3,
      kind: 'reserve',
      title: `Резерв ${rub(r.amount_rub)} висит ${Math.floor(ageDays(r.created_at))} дн.`,
      detail: `${r.item ? `Под «${r.item}». ` : ''}Если закупки не будет — освободите резерв, чтобы деньги участвовали в других сделках.`,
      impactRub: null,
      action: { label: 'Капитал и риск', to: '/quality?tab=risk' },
    });
  }

  // ── 8. источники: заблокированы политикой или отключены после ошибок
  const srcIds = new Set(opps.filter((o) => !o.buy.manual && o.buy.sourceId).map((o) => o.buy.sourceId));
  for (const id of srcIds) {
    const pol = sourcePolicy(id, {}, S);
    const h = healthSummary(id);
    if (pol.enabled && pol.tier === 'blocked') {
      add({
        id: `src-blocked:${id}`,
        priority: 2,
        kind: 'source',
        title: `Источник ${id} заблокирован политикой качества`,
        detail: `${pol.reasons.join('; ')}. Связки из него не рекомендуются. Если причина устранена — сделайте пробную закупку и отметьте результат.`,
        impactRub: null,
        action: { label: 'Источники', to: '/quality?tab=sources' },
      });
    } else if (h.status === 'circuit_open') {
      add({
        id: `src-down:${id}`,
        priority: 3,
        kind: 'source',
        title: `Источник ${id} временно отключён`,
        detail: `Серия ошибок подряд — пауза до ${h.circuitOpenUntil}. Причина — во вкладке «Источники» сканера.`,
        impactRub: null,
        action: { label: 'Источники', to: '/scanner?tab=sources' },
      });
    }
  }
  const probation = [...srcIds].filter((id) => sourcePolicy(id, {}, S).tier === 'probation');
  const probationWithProfit = probation.filter((id) => opps.some((o) => o.buy.sourceId === id && (o.eval.forecast?.net ?? 0) > 0 && o.eval.status !== STATUS.BLOCKED));
  if (S.sourcePolicy.enabled && probationWithProfit.length) {
    add({
      id: 'src-probation',
      priority: 3,
      kind: 'source',
      title: `${probationWithProfit.length} источник(ов) на испытательном сроке: ${probationWithProfit.slice(0, 5).join(', ')}`,
      detail: `Лимиты сделок урезаны и нужна маржа +${S.sourcePolicy.probationBufferPct} п.п. Пробные закупки небольшими суммами с отметкой «купил / не вышло» выведут их на обычные условия.`,
      impactRub: null,
      action: { label: 'Источники', to: '/quality?tab=sources' },
    });
  }

  // ── 9. данные: устаревшие сканы
  const ttl = S.freshness.funpayTtlMin / 60 / 24;
  const stale = watches.list().filter((w) => ageDays(results.get(w.id)?.finishedAt) > Math.max(ttl, 1 / 24));
  if (stale.length) {
    add({
      id: 'scan-stale',
      priority: 3,
      kind: 'data',
      title: `${stale.length} товар(ов) давно не сканировались`,
      detail: `Цены устарели — связки по ним не станут «Исполнимо». Запустите скан или включите автоскан (интервал ${S.intervalMin} мин).`,
      impactRub: null,
      action: { label: 'Каталог', to: '/scanner?tab=watch' },
    });
  }

  // ── 10. капитал не задан: лимиты долей не работают
  if (!snap.tracking) {
    add({
      id: 'capital',
      priority: 3,
      kind: 'capital',
      title: 'Задайте стартовый капитал',
      detail: 'Без кассы не проверяются доли капитала на товар, источник и категорию, не считается свободный остаток и прогноз денежного потока.',
      impactRub: null,
      action: { label: 'Касса', to: '/inventory' },
    });
  }

  // ── 11. стратегия цены: что показал paper trading
  const ps = paperStats().byStrategy;
  const ranked = Object.entries(ps)
    .filter(([, s]) => (s.closed ?? 0) >= 10)
    .sort((a, b) => (b[1].totalNet ?? 0) - (a[1].totalNet ?? 0));
  if (ranked.length >= 2 && (ranked[0][1].totalNet ?? 0) > 0) {
    const [best, s] = ranked[0];
    const label = { fast: 'быстрый оборот', balanced: 'сбалансированная', max: 'максимальная маржа' }[best] ?? best;
    add({
      id: 'strategy',
      priority: 3,
      kind: 'strategy',
      title: `Paper trading: лучше всего работает цена «${label}»`,
      detail: `${s.closed} закрытых позиций, ${rub(s.totalNet)} чистыми, win rate ${Math.round((s.winRate ?? 0) * 100)}%. Это переоценка по рынку, а не продажи — сверьте со своими сделками перед сменой цен.`,
      impactRub: null,
      action: { label: 'Paper trading', to: '/quality?tab=paper' },
    });
  }

  out.sort((a, b) => a.priority - b.priority || (b.impactRub ?? -Infinity) - (a.impactRub ?? -Infinity));
  const summary = {
    total: out.length,
    byPriority: { 1: out.filter((d) => d.priority === 1).length, 2: out.filter((d) => d.priority === 2).length, 3: out.filter((d) => d.priority === 3).length },
    buyNowRub: out.filter((d) => d.kind === 'buy' && d.priority === 1).reduce((a, d) => a + (d.impactRub ?? 0), 0),
    unlockRub: out.filter((d) => ['verify', 'match'].includes(d.kind)).reduce((a, d) => a + (d.impactRub ?? 0), 0),
    atRiskRub: -out.filter((d) => d.kind === 'loss').reduce((a, d) => a + (d.impactRub ?? 0), 0),
    freeCash: snap.freeCash,
  };
  return { decisions: out, summary };
}
