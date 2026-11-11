// Детерминированная «сеть» для E2E: подменяет fetch процесса сервера фикстурами.
// Подключается только флагом node --import ./e2e/fake-net.mjs — рабочий сервер его не загружает.
// Любой адрес, которого нет в фикстурах, падает как «нет сети»: тест никогда не ходит в интернет.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FUNPAY_LOTS = readFileSync(join(here, '..', 'server', 'tests', 'fixtures', 'funpay-lots.html'), 'utf8');

/** цена Steam в копейках; e2e может сменить её через переменную, чтобы проверить «цена выросла» */
const steamKop = () => Number(process.env.FPO_E2E_STEAM_KOP || 90000);

const ROUTES = [
  [/store\.steampowered\.com\/api\/storesearch/, () => ({ total: 1, items: [{ type: 'app', name: 'ELDEN RING', id: 1245620, price: { currency: 'RUB', initial: steamKop(), final: steamKop() } }] })],
  [/^https:\/\/funpay\.com\/(?:[a-z]{2}\/)?lots\/986\/?/, () => FUNPAY_LOTS],
  [/cbr-xml-daily\.ru/, () => ({ Date: new Date().toISOString(), Valute: { USD: { Nominal: 1, Value: 90 }, EUR: { Nominal: 1, Value: 98 }, KZT: { Nominal: 100, Value: 18 } } })],
];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) return realFetch(input, init);
  const r = ROUTES.find(([re]) => re.test(url));
  if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const body = r[1]();
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json' },
  });
};
console.log('[e2e] сеть подменена фикстурами');
