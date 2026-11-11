import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type CatalogGame,
  type Category,
  type Discovery,
  type Health,
  type Opportunity,
  type ScanResult,
  type ServerHealth,
  type ServerSettings,
  type SourceInfo,
  type Watch,
} from '../../lib/api';

/** Состояние сканера с сервера. Возможности считает сервер (core/engine.mjs) — здесь только отображение. */
export function useScanner() {
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceHealth, setSourceHealth] = useState<Record<string, Health>>({});
  const [watches, setWatches] = useState<Watch[]>([]);
  const [results, setResults] = useState<Record<string, ScanResult>>({});
  const [discoveries, setDiscoveries] = useState<Record<string, Discovery>>({});
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [oppsAt, setOppsAt] = useState<string | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [catalog, setCatalog] = useState<CatalogGame[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const wasBusy = useRef(false);

  const loadOpps = useCallback(async () => {
    const o = await api.opportunities();
    setOpps(o.items);
    setOppsAt(o.generatedAt);
  }, []);

  const reload = useCallback(async () => {
    const [w, d, s, st] = await Promise.all([api.watches(), api.discoveries(), api.sources(), api.settings()]);
    setWatches(w.watches);
    setResults(w.results);
    setDiscoveries(d);
    setSources(s.sources);
    setSourceHealth(s.health);
    setSettings(st.settings);
    await loadOpps();
  }, [loadOpps]);

  const ping = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setOffline(null);
      const busy = Boolean(h.working) || h.queue.length > 0;
      if (wasBusy.current && !busy) await reload();
      wasBusy.current = busy;
      return true;
    } catch (e) {
      setOffline((e as Error).message);
      return false;
    }
  }, [reload]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!(await ping()) || !alive) return;
      await reload();
    })().catch((e) => setOffline((e as Error).message));
    const t = setInterval(ping, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ping, reload]);

  const loadCatalog = useCallback(async () => {
    if (catalog) return catalog;
    try {
      const c = await api.catalog();
      setCatalog(c);
      setCatalogError(null);
      return c;
    } catch (e) {
      setCatalogError((e as Error).message);
      return null;
    }
  }, [catalog]);

  const saveWatch = useCallback(async (w: Partial<Watch>) => {
    const saved = await api.saveWatch(w);
    setWatches((list) => {
      const i = list.findIndex((x) => x.id === saved.id);
      return i >= 0 ? list.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...list];
    });
    return saved;
  }, []);

  const removeWatch = useCallback(
    async (id: string) => {
      await api.removeWatch(id);
      setWatches((l) => l.filter((w) => w.id !== id));
      await loadOpps();
    },
    [loadOpps],
  );

  const scan = useCallback(
    async (id: string) => {
      const r = await api.scan(id);
      setResults((x) => ({ ...x, [id]: r }));
      const s = await api.sources();
      setSourceHealth(s.health);
      await loadOpps();
      return r;
    },
    [loadOpps],
  );

  const scanAll = useCallback(async () => {
    await api.scanAll();
    wasBusy.current = true;
    await ping();
  }, [ping]);

  const decide = useCallback(
    async (watchId: string, offerUrl: string, side: 'source' | 'funpay', status: 'VERIFIED' | 'REJECTED' | 'CLEAR', reason?: string) => {
      await api.match(watchId, offerUrl, side, status, reason);
      await scan(watchId);
    },
    [scan],
  );

  const discover = useCallback(
    async (game: Parameters<typeof api.discover>[0], url: string, onlineOnly: boolean) => {
      const d = await api.discover(game, url, onlineOnly);
      setDiscoveries((x) => ({ ...x, [`${game}|${url}`]: d }));
      await loadOpps();
      return d;
    },
    [loadOpps],
  );

  const saveSettings = useCallback(
    async (p: Partial<ServerSettings> | Record<string, unknown>) => {
      const s = await api.saveSettings(p);
      setSettings(s);
      await loadOpps();
      return s;
    },
    [loadOpps],
  );

  return {
    health,
    offline,
    sources,
    sourceHealth,
    watches,
    results,
    discoveries,
    opps,
    oppsAt,
    settings,
    catalog,
    catalogError,
    loadCatalog,
    saveWatch,
    removeWatch,
    scan,
    scanAll,
    decide,
    discover,
    saveSettings,
    reload,
    loadOpps,
  };
}

export type ScannerState = ReturnType<typeof useScanner>;

export const CATEGORY_LABEL: Record<Category, string> = {
  keys: 'Ключи и игры',
  skins: 'Скины',
  currency: 'Валюта',
  accounts: 'Аккаунты/услуги',
  subscriptions: 'Подписки',
};

export const MATCH_LABEL = { VERIFIED: 'совпадает', REVIEW_REQUIRED: 'проверить', REJECTED: 'не совпадает' } as const;
export const MATCH_TONE = { VERIFIED: 'good', REVIEW_REQUIRED: 'warn', REJECTED: 'bad' } as const;
export const STATUS_LABEL = { RECOMMENDED: 'Исполнимо', CANDIDATE: 'Кандидат', REVIEW: 'Проверить', BLOCKED: 'Заблокировано' } as const;
export const STATUS_TONE = { RECOMMENDED: 'good', CANDIDATE: 'accent', REVIEW: 'warn', BLOCKED: 'bad' } as const;
export const STATUS_HINT = {
  RECOMMENDED: 'все проверки пройдены, цена перепроверена и наличие подтверждено — можно покупать',
  CANDIDATE: 'все проверки пройдены по котировкам; перед покупкой нажмите «Проверить сейчас»',
  REVIEW: 'нужно ваше решение: совпадение товара, правила площадки или качество данных',
  BLOCKED: 'жёсткий блок: несовпадение, устаревшие данные, убыток, лимиты капитала',
} as const;

export const ageText = (min: number) =>
  !Number.isFinite(min) ? 'нет данных' : min < 1 ? 'только что' : min < 60 ? `${Math.round(min)} мин назад` : min < 1440 ? `${(min / 60).toFixed(1)} ч назад` : `${(min / 1440).toFixed(1)} дн назад`;
