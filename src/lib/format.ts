const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** |v| < полкопейки → 0, чтобы не показывать «−0,00 ₽» */
const clean = (v: number, eps: number) => (Number.isFinite(v) && Math.abs(v) >= eps ? v : 0);
export const fmtRub = (v: number) => `${rub.format(clean(v, 0.005))} ₽`;
export const fmtPct = (v: number) => `${pct.format(clean(v, 0.05))} %`;
export const fmtInt = (v: number) => int.format(Number.isFinite(v) ? v : 0);

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU');
};

export const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const todayISO = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

/** Парсит ввод вида "1 234,5" → 1234.5 */
export const parseNum = (s: string): number => {
  const v = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};
