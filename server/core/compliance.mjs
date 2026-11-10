// Compliance Engine: проверка товара и раздела по правилам FunPay (п. 2.1.x и 2.2.x).
// block — рекомендация запрещена; warn — требует ручной проверки правил раздела.
import { norm } from '../lib/match.mjs';

// Слово целиком: не внутри другого («чит» ≠ «читать», «крипт» ≠ «скрипт»)
const w = (s) => `(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}\\p{N}])`;
const R = (re) => new RegExp(re, 'iu');

/**
 * Текстовые признаки — эвристика. block ставится только для однозначных формулировок;
 * всё, что может встретиться в описании легального товара, — warn (требует проверки человеком).
 */
export const COMPLIANCE_RULES = [
  { clause: '2.2.1', level: 'block', re: R(w('брут\\p{L}*|brute|кардинг\\p{L}*|carding|stealer|стилер\\p{L}*|ворованн\\p{L}*|украденн\\p{L}*')), text: 'товары, полученные взломом/брутом/кардингом' },
  { clause: '2.2.1', level: 'warn', re: R(w('взлом\\p{L}*|hacked')), text: 'упоминание взлома — проверьте происхождение товара' },
  { clause: '2.2.2', level: 'block', re: R('обучени[ея].{0,20}(дюп|кардинг)|' + w('dupe method')), text: 'обучение незаконной деятельности' },
  { clause: '2.2.3', level: 'block', re: R(w('слив баз\\p{L}*|база клиентов|персональн\\p{L}* данн\\p{L}*|паспортн\\p{L}* данн\\p{L}*')), text: 'персональные данные третьих лиц' },
  { clause: '2.2.4', level: 'warn', re: R(w('кряк|crack|keygen|читы|чит|cheat|cheats|aimbot|вх|wallhack|пиратск\\p{L}*')), text: 'возможен нелицензионный софт / читы' },
  { clause: '2.2.6', level: 'warn', re: R(w('виртуальн\\p{L}* номер\\p{L}*|sim карт\\p{L}*|номер для смс|номер для регистрации')), text: 'возможна продажа телефонных номеров' },
  { clause: '2.2.8', level: 'warn', re: R(w('nsfw|onlyfans|порно|porn|интим\\p{L}*')), text: 'возможен 18+ контент' },
  { clause: '2.2.9', level: 'block', re: R(w('спам рассылк\\p{L}*|массов\\p{L}* рассылк\\p{L}*|spam bot|спам бот')), text: 'товары для спама и массовых рассылок' },
  { clause: '2.2.10', level: 'block', re: R(w('казино|casino|букмекер\\p{L}*|ставки на спорт|betting')), text: 'ставки и казино' },
  { clause: '2.2.11', level: 'block', re: R(w('накрутк\\p{L}*|накрутить|boost followers|подписчики на|лайки на|просмотры на')), text: 'способы доната и накрутки' },
  { clause: '2.2.12', level: 'warn', re: R(w('оффлайн|офлайн|offline|геймпасс|game pass|gamepass')), text: 'перепродажа офлайн-активаций и геймпассов (предупреждение, при повторе — блокировка)' },
  { clause: '2.2.13', level: 'warn', re: R(w('рандом|random key|случайн\\p{L}* ключ\\p{L}*|лотере\\p{L}*|lottery|mystery box')), text: 'лотереи, «рандом» (предупреждение, при повторе — блокировка)' },
  { clause: '2.2.14', level: 'warn', re: R(w('криптовалют\\p{L}*|crypto|usdt|btc|bitcoin|ethereum|эфириум')), text: 'криптовалюта (предупреждение, при повторе — блокировка)' },
  { clause: '2.1.1', level: 'block', re: R(w('оплата напрямую|вне funpay|в обход funpay|оплата на карту|пишите в тг для оплаты|discord для оплаты')), text: 'уход сделки за пределы FunPay' },
];

/** Разделы, где перепродажа покупного товара требует особой осторожности */
const SECTION_WARN = [
  { re: R('оффлайн актив'), clause: '2.2.12', text: 'раздел оффлайн-активаций: перепродажа офлайн-активаций ограничена' },
  { re: R('аккаунт'), clause: '2.2.7', text: 'раздел аккаунтов: аккаунты оптом (кроме зарегистрированных вами) запрещены' },
];

/**
 * @param {{ texts: string[], sectionTitle?: string, category?: string, buyType?: string }} p
 * @returns {{ level: 'ok'|'warn'|'block', hits: {clause:string, level:string, text:string, match:string}[] }}
 */
export function checkCompliance({ texts = [], sectionTitle = '', category, buyType }) {
  const hits = [];
  const n = norm(texts.map((t) => String(t ?? '')).join(' \n '));
  for (const r of COMPLIANCE_RULES) {
    const m = n.match(r.re);
    if (m) hits.push({ clause: r.clause, level: r.level, text: r.text, match: m[0].slice(0, 40) });
  }
  for (const s of SECTION_WARN) {
    if (s.re.test(sectionTitle)) hits.push({ clause: s.clause, level: 'warn', text: s.text, match: sectionTitle.slice(0, 60) });
  }
  if (category === 'accounts' && buyType === 'account') {
    hits.push({ clause: '2.2.7', level: 'warn', text: 'перепродажа чужих аккаунтов: проверьте правила раздела', match: '' });
  }
  const level = hits.some((h) => h.level === 'block') ? 'block' : hits.length ? 'warn' : 'ok';
  return { level, hits };
}
