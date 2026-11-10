import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DisputeOutcome, MarginInput, MarginResult } from '../lib/margin';
import { safeStorage, STORAGE_KEY, uid } from '../lib/storage';
import { DEFAULT_ARB, type ArbSettings } from '../lib/arbitrage';

export type Theme = 'dark' | 'light';

export interface SavedCalc {
  id: string;
  name: string;
  createdAt: string;
  input: MarginInput;
  net: number;
  netPct: number;
}

export interface Deal {
  id: string;
  date: string;
  item: string;
  /** штук в сделке; buy и sell — суммы за всю сделку */
  qty: number;
  buy: number;
  sell: number;
  feePct: number;
  withdrawPct: number;
  outcome: DisputeOutcome;
  /** для outcome = partial — потеря в ₽ */
  disputeLoss: number;
  note: string;
}

export interface DeliveryDraft {
  pool: string;
  message: string;
  checklist: Record<string, boolean>;
  perDay: number;
  bufferDays: number;
}

export interface Settings {
  theme: Theme;
  /** ниже этого % маржи вердикт жёлтый */
  warnThresholdPct: number;
  /** значения по умолчанию для новых расчётов и сделок */
  defaultFeePct: number;
  defaultWithdrawPct: number;
}

interface State {
  settings: Settings;
  calcDraft: MarginInput;
  calcs: SavedCalc[];
  deals: Deal[];
  delivery: DeliveryDraft;
  /** настройки расчёта выгоды в сканере */
  arb: ArbSettings;

  setArb: (p: Partial<ArbSettings>) => void;
  setSettings: (p: Partial<Settings>) => void;
  setCalcDraft: (p: Partial<MarginInput>) => void;
  /** заменить черновик целиком (из журнала / сохранённого расчёта) */
  replaceCalcDraft: (p: Partial<MarginInput>) => void;
  resetCalcDraft: () => void;
  saveCalc: (name: string, result: MarginResult) => void;
  removeCalc: (id: string) => void;
  loadCalc: (id: string) => void;

  addDeal: (d: Omit<Deal, 'id'>) => void;
  updateDeal: (id: string, d: Partial<Deal>) => void;
  removeDeal: (id: string) => void;
  importDeals: (d: Deal[]) => void;

  setDelivery: (p: Partial<DeliveryDraft>) => void;
  toggleCheck: (id: string) => void;
  resetChecklist: () => void;

  resetSection: (s: 'calcs' | 'deals' | 'delivery' | 'settings') => void;
  resetAll: () => void;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  warnThresholdPct: 10,
  defaultFeePct: 5,
  defaultWithdrawPct: 0,
};

export const emptyCalc = (s: Settings): MarginInput => ({
  price: 0,
  platformFeePct: s.defaultFeePct,
  withdrawFeePct: s.defaultWithdrawPct,
  cost: 0,
  disputeValue: 0,
  disputeMode: 'rub',
  disputeRefundPct: 100,
  minutesPerOrder: 0,
  hourlyRate: 0,
  investment: 0,
  targetMarginPct: s.warnThresholdPct,
  targetMarginRub: 0,
  monthlyGoal: 0,
});

const EMPTY_DELIVERY: DeliveryDraft = {
  pool: '',
  message: '',
  checklist: {},
  perDay: 0,
  bufferDays: 3,
};

const OUTCOMES: DisputeOutcome[] = ['none', 'won', 'refund', 'partial'];

/** Приводит сделку к корректному виду: числа ≥ 0, qty ≥ 1, потеря только у partial. */
export function normalizeDeal(d: Partial<Deal>): Deal {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
  const outcome: DisputeOutcome = d.outcome && OUTCOMES.includes(d.outcome) ? d.outcome : 'none';
  return {
    id: d.id || uid(),
    date: d.date || new Date().toISOString().slice(0, 10),
    item: (d.item ?? '').trim(),
    qty: Math.max(1, Math.floor(n(d.qty) || 1)),
    buy: n(d.buy),
    sell: n(d.sell),
    feePct: Math.min(100, n(d.feePct)),
    withdrawPct: Math.min(100, n(d.withdrawPct)),
    outcome,
    disputeLoss: outcome === 'partial' ? n(d.disputeLoss) : 0,
    note: d.note ?? '',
  };
}

/** v1: dispute: boolean + disputeLoss ₽ → v2: outcome + qty. */
export function migrateState(persisted: unknown, version: number): unknown {
  const st = { ...((persisted ?? {}) as Record<string, unknown>) };
  if (version < 2 && Array.isArray(st.deals)) {
    st.deals = (st.deals as Record<string, unknown>[]).map((d) => {
      const dispute = Boolean(d.dispute);
      const loss = typeof d.disputeLoss === 'number' ? d.disputeLoss : 0;
      return normalizeDeal({
        ...(d as Partial<Deal>),
        qty: 1,
        outcome: !dispute ? 'none' : loss > 0 ? 'partial' : 'won',
        disputeLoss: loss,
      });
    });
  }
  return st;
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      calcDraft: emptyCalc(DEFAULT_SETTINGS),
      calcs: [],
      deals: [],
      delivery: EMPTY_DELIVERY,
      arb: DEFAULT_ARB,

      setArb: (p) => set((s) => ({ arb: { ...s.arb, ...p, sourceFees: { ...s.arb.sourceFees, ...p.sourceFees } } })),
      setSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
      setCalcDraft: (p) => set((s) => ({ calcDraft: { ...s.calcDraft, ...p } })),
      replaceCalcDraft: (p) => set((s) => ({ calcDraft: { ...emptyCalc(s.settings), ...p } })),
      resetCalcDraft: () => set((s) => ({ calcDraft: emptyCalc(s.settings) })),
      saveCalc: (name, r) =>
        set((s) => ({
          calcs: [
            { id: uid(), name: name.trim(), createdAt: new Date().toISOString(), input: { ...s.calcDraft }, net: r.net, netPct: r.netPct },
            ...s.calcs,
          ],
        })),
      removeCalc: (id) => set((s) => ({ calcs: s.calcs.filter((c) => c.id !== id) })),
      loadCalc: (id) => {
        const c = get().calcs.find((x) => x.id === id);
        if (c) set((s) => ({ calcDraft: { ...emptyCalc(s.settings), ...c.input } }));
      },

      addDeal: (d) => set((s) => ({ deals: [normalizeDeal({ ...d, id: uid() }), ...s.deals] })),
      updateDeal: (id, d) => set((s) => ({ deals: s.deals.map((x) => (x.id === id ? normalizeDeal({ ...x, ...d, id }) : x)) })),
      removeDeal: (id) => set((s) => ({ deals: s.deals.filter((x) => x.id !== id) })),
      importDeals: (d) => set((s) => ({ deals: [...d.map(normalizeDeal), ...s.deals] })),

      setDelivery: (p) => set((s) => ({ delivery: { ...s.delivery, ...p } })),
      toggleCheck: (id) =>
        set((s) => ({ delivery: { ...s.delivery, checklist: { ...s.delivery.checklist, [id]: !s.delivery.checklist[id] } } })),
      resetChecklist: () => set((s) => ({ delivery: { ...s.delivery, checklist: {} } })),

      resetSection: (sec) =>
        set((s) => {
          switch (sec) {
            case 'calcs':
              return { calcs: [], calcDraft: emptyCalc(s.settings) };
            case 'deals':
              return { deals: [] };
            case 'delivery':
              return { delivery: EMPTY_DELIVERY };
            case 'settings':
              return { settings: DEFAULT_SETTINGS };
          }
        }),
      resetAll: () =>
        set({
          settings: DEFAULT_SETTINGS,
          calcDraft: emptyCalc(DEFAULT_SETTINGS),
          calcs: [],
          deals: [],
          delivery: EMPTY_DELIVERY,
          arb: DEFAULT_ARB,
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => safeStorage),
      migrate: (persisted, version) => migrateState(persisted, version) as State,
      partialize: (s) => ({
        settings: s.settings,
        calcDraft: s.calcDraft,
        calcs: s.calcs,
        deals: s.deals,
        delivery: s.delivery,
        arb: s.arb,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          ...p,
          settings: { ...current.settings, ...p.settings },
          calcDraft: { ...current.calcDraft, ...p.calcDraft },
          deals: Array.isArray(p.deals) ? p.deals.map(normalizeDeal) : current.deals,
          calcs: Array.isArray(p.calcs) ? p.calcs : current.calcs,
          delivery: { ...current.delivery, ...p.delivery },
          arb: { ...current.arb, ...p.arb, sourceFees: { ...current.arb.sourceFees, ...p.arb?.sourceFees } },
        };
      },
    },
  ),
);
