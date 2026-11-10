import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CatalogGame, type Category, type Discovery, type Health, type ScanResult, type SourceInfo, type Watch } from '../../lib/api';

/** Состояние сканера с сервера: здоровье, источники, список отслеживания, результаты, автопоиск. */
export function useScanner() {
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [categories, setCategories] = useState<{ id: Category; name: string }[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [results, setResults] = useState<Record<string, ScanResult>>({});
  const [discoveries, setDiscoveries] = useState<Record<string, Discovery>>({});
  const [catalog, setCatalog] = useState<CatalogGame[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const reload = useCallback(async () => {
    const [w, d] = await Promise.all([api.watches(), api.discoveries()]);
    setWatches(w.watches);
    setResults(w.results);
    setDiscoveries(d);
  }, []);

  const ping = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setOffline(null);
      // фоновый «скан всего» закончился — подтягиваем свежие результаты
      if (wasRunning.current && !h.allRunning) await reload();
      wasRunning.current = h.allRunning;
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
      const s = await api.sources();
      if (!alive) return;
      setSources(s.sources);
      setCategories(s.categories);
      await reload();
    })().catch((e) => setOffline((e as Error).message));
    const t = setInterval(ping, 10_000);
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

  const removeWatch = useCallback(async (id: string) => {
    await api.removeWatch(id);
    setWatches((l) => l.filter((w) => w.id !== id));
    setResults((r) => {
      const n = { ...r };
      delete n[id];
      return n;
    });
  }, []);

  const scan = useCallback(async (id: string) => {
    const r = await api.scan(id);
    setResults((x) => ({ ...x, [id]: r }));
    return r;
  }, []);

  const scanAll = useCallback(async () => {
    await api.scanAll();
    wasRunning.current = true;
    await ping();
  }, [ping]);

  const discover = useCallback(async (game: Parameters<typeof api.discover>[0], url: string, onlineOnly: boolean) => {
    const d = await api.discover(game, url, onlineOnly);
    setDiscoveries((x) => ({ ...x, [`${game}|${url}`]: d }));
    return d;
  }, []);

  const setIntervalMin = useCallback(
    async (m: number) => {
      await api.setInterval(m);
      await ping();
    },
    [ping],
  );

  return {
    health,
    offline,
    sources,
    categories,
    watches,
    results,
    discoveries,
    catalog,
    catalogError,
    loadCatalog,
    saveWatch,
    removeWatch,
    scan,
    scanAll,
    discover,
    setIntervalMin,
    reload,
  };
}

export type ScannerState = ReturnType<typeof useScanner>;

export const CATEGORY_LABEL: Record<Category, string> = {
  keys: 'Ключи и игры',
  skins: 'Скины',
  currency: 'Валюта',
  accounts: 'Аккаунты/услуги',
};
