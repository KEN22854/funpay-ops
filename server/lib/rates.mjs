// Курсы ЦБ РФ (зеркало cbr-xml-daily.ru) для перевода цен в рубли.
import { fetchCached } from './http.mjs';

const URL_CBR = 'https://www.cbr-xml-daily.ru/daily_json.js';

export async function getRates() {
  const d = await fetchCached(URL_CBR, { ttl: 6 * 3600_000 });
  const rates = { RUB: 1 };
  for (const [code, v] of Object.entries(d.Valute ?? {})) rates[code] = v.Value / v.Nominal;
  return { date: d.Date, rates };
}

/** перевод суммы в рубли; null — если валюта неизвестна */
export function toRub(amount, currency, rates) {
  const r = rates[currency?.toUpperCase?.()];
  return r ? amount * r : null;
}
