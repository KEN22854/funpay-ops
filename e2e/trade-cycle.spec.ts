// Полный торговый цикл через интерфейс и API на детерминированной «сети» (e2e/fake-net.mjs):
// товар → скан → Decision Center → перепроверка → закупка → частичная поставка → продажа с себестоимостью →
// частичный возврат → касса, прибыль, аналитика → экспорт/импорт → бэкап и восстановление.
import { expect, test, type APIRequestContext } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const H = { 'X-FPO-Client': '1', 'Content-Type': 'application/json' };
async function api<T = unknown>(rq: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers = method === 'GET' ? H : { ...H, 'Idempotency-Key': crypto.randomUUID() };
  const r = await rq.fetch(`/api${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  expect(r.status(), `${method} ${path}: ${text.slice(0, 300)}`).toBeLessThan(400);
  return (text ? JSON.parse(text) : {}) as T;
}

type Opp = { id: string; name: string; eval: { status: string; forecast: { net: number; price: number } | null } };
type Purchase = { id: string; item: string; qty: number; status: string; total_rub: number };
type Sale = { id: string; item: string; status: string; net_rub: number; cogs_rub: number; payout_rub: number };

let watchId = '';
let netBeforeRefund = 0;

test('0. стартовый экран — Decision Center', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/#\/decisions/);
  await expect(page.getByRole('heading', { name: 'Что делать' })).toBeVisible();
});

test('1. настройка: касса, комиссия раздела, товар в каталоге, скан', async ({ request }) => {
  await api(request, 'POST', '/cash', { type: 'deposit', amount: 10000, mode: 'real' });
  await api(request, 'POST', '/fees', { scope: 'funpay_section', scopeKey: 'https://funpay.com/lots/986/', pct: 5, source: 'e2e: форма лота' });
  const w = await api<{ id: string }>(request, 'POST', '/watches', {
    name: 'Elden Ring',
    category: 'keys',
    query: 'Elden Ring',
    sources: ['steam'],
    attrs: { platform: 'pc' },
    funpay: { url: 'https://funpay.com/lots/986/' },
  });
  watchId = w.id;
  await api(request, 'POST', `/scan/${watchId}`);
  const opps = (await api<{ items: Opp[] }>(request, 'GET', '/opportunities')).items;
  const o = opps.find((x) => x.name === 'Elden Ring');
  expect(o, 'связка Steam → FunPay найдена').toBeTruthy();
  expect(o!.eval.status).toBe('CANDIDATE'); // наличие у Steam неизвестно — до перепроверки не «исполнимо»
  expect(o!.eval.forecast!.net).toBeGreaterThan(0);
});

test('2. Decision Center советует перепроверить связку с эффектом в рублях', async ({ page }) => {
  await page.goto('/#/decisions');
  const item = page.locator('li', { hasText: 'Перепроверить «Elden Ring»' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('+');
  await item.getByRole('link', { name: 'Проверить' }).click();
  await expect(page).toHaveURL(/#\/scanner\?tab=opps/);
});

test('3. перепроверка: без отметки наличия — «неполная», с отметкой — «исполнимо», затем закупка 2 шт «в пути»', async ({ page }) => {
  await page.goto('/#/scanner?tab=opps');
  const row = page.locator('tr', { hasText: 'Elden Ring' }).first();
  await row.getByRole('button', { name: 'проверить сейчас' }).click();
  const dialog = page.getByRole('dialog', { name: 'Проверить сейчас: Elden Ring' });
  await dialog.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.getByText('Цена подтверждена, наличие — нет')).toBeVisible();
  await dialog.getByLabel('Товар в наличии — я проверил на сайте').check();
  await dialog.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.getByText('Цена и наличие подтверждены — можно покупать')).toBeVisible();
  await dialog.getByRole('button', { name: 'Купил — записать партию' }).click();

  const buy = page.getByRole('dialog', { name: 'Купил: Elden Ring' });
  await buy.getByLabel('Количество').fill('2');
  await buy.getByLabel('Статус').selectOption('in_transit');
  await buy.getByRole('button', { name: 'Записать партию' }).click();
  await expect(buy.getByRole('button', { name: 'Готово' })).toBeVisible();
});

test('4. частичная поставка: получено 1 из 2 — разница вернулась в кассу', async ({ request }) => {
  const purchases = await api<Purchase[]>(request, 'GET', '/purchases?mode=real');
  const p = purchases.find((x) => x.item === 'Elden Ring')!;
  expect(p.status).toBe('in_transit');
  expect(p.qty).toBe(2);
  await api(request, 'POST', `/purchases/${p.id}/receive`, { qty: 1 });
  const stock = (await api<{ items: { item: string; onHand: number }[] }>(request, 'GET', '/stock?mode=real')).items;
  expect(stock.find((s) => s.item === 'Elden Ring')?.onHand).toBe(1);
  const ledger = await api<{ type: string; amount_rub: number }[]>(request, 'GET', '/ledger?mode=real');
  const back = ledger.find((l) => l.type === 'purchase_partial_refund');
  expect(back?.amount_rub).toBeCloseTo(900, 2);
});

test('5. продажа: себестоимость списывается по партии (FIFO), прибыль считается', async ({ request }) => {
  const sale = await api<Sale>(request, 'POST', '/sales', { item: 'Elden Ring', qty: 1, unitPrice: 1499, mode: 'real', sectionUrl: 'https://funpay.com/lots/986/' });
  expect(sale.cogs_rub).toBeCloseTo(900, 2);
  expect(sale.payout_rub).toBeCloseTo(1499 * 0.95, 2);
  expect(sale.net_rub).toBeGreaterThan(0);
  netBeforeRefund = sale.net_rub;
  const stock = (await api<{ items: { item: string; onHand: number }[] }>(request, 'GET', '/stock?mode=real')).items;
  expect(stock.find((s) => s.item === 'Elden Ring')?.onHand ?? 0).toBe(0);
});

test('6. частичный возврат уменьшает прибыль на сумму возврата; аналитика это видит', async ({ request }) => {
  const sales = await api<Sale[]>(request, 'GET', '/sales?mode=real');
  const s = sales.find((x) => x.item === 'Elden Ring')!;
  const r = await api<Sale>(request, 'POST', `/sales/${s.id}/refund`, { amount: 300, note: 'e2e: частичный возврат' });
  expect(r.status).toBe('partial_refund');
  expect(r.net_rub).toBeCloseTo(netBeforeRefund - 300, 2);
  const from = new Date(Date.now() - 86400_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const m = await api<{ revenue: number; netProfit: number; orders: number }>(request, 'GET', `/analytics/metrics?from=${from}&to=${to}&mode=real`);
  expect(m.orders).toBe(1);
  expect(m.netProfit).toBeCloseTo(netBeforeRefund - 300, 2);
});

test('7. интерфейс склада и аналитики показывает сделку', async ({ page }) => {
  await page.goto('/#/inventory');
  await expect(page.getByRole('heading', { name: /Склад/ })).toBeVisible();
  await page.getByRole('button', { name: /Продажи/ }).click();
  await expect(page.getByText('Elden Ring').first()).toBeVisible();
  await page.goto('/#/quality?tab=sources');
  await expect(page.getByText('Политики качества')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'steam' }).first()).toBeVisible();
});

test('8. экспорт CSV и импорт сделок из журнала', async ({ request }) => {
  const csv = await (await request.get('/api/export/sales?mode=real')).text();
  expect(csv).toContain('Elden Ring');
  const r = await api<{ imported: number }>(request, 'POST', '/sales/import', { deals: [{ item: 'Old Game', qty: 1, unitPrice: 500, cogsRub: 300, saleFeePct: 5, mode: 'real', soldAt: new Date(Date.now() - 3600_000).toISOString() }] });
  expect(r.imported).toBe(1);
  const sales = await api<Sale[]>(request, 'GET', '/sales?mode=real');
  expect(sales.some((s) => s.item === 'Old Game')).toBe(true);
});

test('9. бэкап (с шифрованием), учения, изменение и восстановление', async ({ request }) => {
  const b = await api<{ file: string; verify: { ok: boolean }; encrypted: { file: string } | null }>(request, 'POST', '/backups');
  expect(b.verify.ok).toBe(true);
  expect(b.encrypted?.file).toMatch(/\.enc$/);
  const drill = await api<{ ok: boolean; source: string }>(request, 'POST', '/backups/drill');
  expect(drill).toMatchObject({ ok: true, source: 'encrypted' });
  // после бэкапа — лишняя продажа; восстановление должно её убрать
  await api(request, 'POST', '/sales/import', { deals: [{ item: 'After Backup', qty: 1, unitPrice: 100, cogsRub: 50, saleFeePct: 5, mode: 'real' }] });
  expect((await api<Sale[]>(request, 'GET', '/sales?mode=real')).some((s) => s.item === 'After Backup')).toBe(true);
  await api(request, 'POST', `/backups/${encodeURIComponent(b.file)}/restore`, { confirm: b.file });
  const after = await api<Sale[]>(request, 'GET', '/sales?mode=real');
  expect(after.some((s) => s.item === 'After Backup')).toBe(false);
  expect(after.some((s) => s.item === 'Elden Ring')).toBe(true);
});

test('10. Decision Center после цикла и метрики API без ошибок сервера', async ({ page, request }) => {
  await page.goto('/#/decisions');
  await expect(page.getByRole('heading', { name: 'Что делать' })).toBeVisible();
  const ops = await api<{ total: number; errors: number }>(request, 'GET', '/ops/metrics');
  expect(ops.total).toBeGreaterThan(10);
  expect(ops.errors).toBe(0);
});
