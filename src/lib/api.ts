// Клиент локального сервера сканера (server/index.mjs). Vite проксирует /api → 127.0.0.1:5181.

export type Category = 'keys' | 'skins' | 'currency' | 'accounts';
export type SkinGame = 'cs2' | 'dota2' | 'rust';

export interface SourceInfo {
  id: string;
  name: string;
  url: string;
  categories: Category[];
  method: 'api' | 'feed' | 'html' | 'aggregator' | 'manual';
  note: string;
  auto: boolean;
}

export interface Offer {
  sourceId: string;
  title: string;
  price: number;
  currency: string;
  priceRub: number;
  url: string;
  stock?: number | null;
  manual?: boolean;
  updatedAt?: string;
}

export interface FunpayOffer {
  url: string;
  online: boolean;
  desc: string;
  server: string;
  side: string;
  seller: string;
  reviews: number;
  amount: number | null;
  price: number;
  filters: Record<string, string>;
}

export interface FunpaySummary {
  count: number;
  online: number;
  min: number | null;
  median10: number | null;
  top: FunpayOffer[];
}

export interface ManualPrice {
  sourceId: string;
  price: number;
  currency: string;
  url: string;
  note: string;
  updatedAt?: string;
}

export interface Watch {
  id: string;
  createdAt: string;
  name: string;
  category: Category;
  game: SkinGame | null;
  query: string;
  include: string[];
  exclude: string[];
  sources: string[];
  ignore: string[];
  manual: ManualPrice[];
  funpay: {
    url: string;
    include: string[];
    exclude: string[];
    onlineOnly: boolean;
    minReviews: number;
    /** фильтры раздела FunPay: ключ → выбранные значения */
    facets: Record<string, string[]>;
  };
  enabled: boolean;
}

export interface ScanResult {
  watchId: string;
  startedAt: string;
  finishedAt: string;
  ratesDate: string;
  usdRub: number;
  eurRub: number;
  sources: { sourceId: string; status: 'ok' | 'empty' | 'error'; offers: Offer[]; error: string | null }[];
  manual: Offer[];
  funpay:
    | ({ status: 'ok'; title: string; url: string; pricePer: number; total: number } & FunpaySummary)
    | { status: 'error'; error: string; url: string }
    | null;
}

export interface Discovery {
  game: SkinGame;
  funpay: { url: string; title: string; total: number; considered: number; matched: number };
  feedErrors: Record<string, string>;
  usdRub: number;
  items: { name: string; funpay: FunpaySummary; buys: Offer[] }[];
  scannedAt: string;
}

export interface CatalogGame {
  id: number;
  name: string;
  url: string;
  sections: { url: string; name: string }[];
}

export interface FunpayFacets {
  url: string;
  title: string;
  total: number;
  pricePer: number;
  facets: { key: string; label: string; options: { value: string; label: string; count: number }[] }[];
}

export interface Health {
  ok: boolean;
  scanning: string[];
  allRunning: boolean;
  lastAutoScan: string | null;
  nextAutoScan: string | null;
  settings: { intervalMin: number };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Сервер сканера не отвечает. Запусти его: npm run server');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(res.status === 404 || res.status >= 500 ? 'Сервер сканера не запущен (npm run server)' : 'Неожиданный ответ сервера');
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  health: () => call<Health>('GET', '/health'),
  sources: () => call<{ categories: { id: Category; name: string }[]; sources: SourceInfo[] }>('GET', '/sources'),
  catalog: () => call<CatalogGame[]>('GET', '/funpay/catalog'),
  facets: (url: string) => call<FunpayFacets>('GET', `/funpay/facets?url=${encodeURIComponent(url)}`),
  watches: () => call<{ watches: Watch[]; results: Record<string, ScanResult> }>('GET', '/watches'),
  saveWatch: (w: Partial<Watch>) => call<Watch>('POST', '/watches', w),
  removeWatch: (id: string) => call<{ ok: true }>('DELETE', `/watches/${id}`),
  scan: (id: string) => call<ScanResult>('POST', `/scan/${id}`),
  scanAll: () => call<{ started: true }>('POST', '/scan-all'),
  discover: (game: SkinGame, funpayUrl: string, onlineOnly: boolean) => call<Discovery>('POST', '/discover', { game, funpayUrl, onlineOnly }),
  discoveries: () => call<Record<string, Discovery>>('GET', '/discover'),
  setInterval: (intervalMin: number) => call<{ intervalMin: number }>('PUT', '/settings', { intervalMin }),
};
