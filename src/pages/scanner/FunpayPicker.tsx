import { useEffect, useMemo, useState } from 'react';
import type { CatalogGame } from '../../lib/api';
import type { ScannerState } from './useScanner';

/** Выбор раздела FunPay из каталога (игра → подраздел) или вставка ссылки вручную. */
export function FunpayPicker({ sc, value, onChange, hintGame }: { sc: ScannerState; value: string; onChange: (url: string) => void; hintGame?: string }) {
  const [catalog, setCatalog] = useState<CatalogGame[] | null>(sc.catalog);
  const [gameId, setGameId] = useState<number | ''>('');
  const [filter, setFilter] = useState(hintGame ?? '');

  useEffect(() => {
    sc.loadCatalog().then((c) => c && setCatalog(c));
  }, [sc]);

  // если ссылка уже выбрана — найти её игру
  useEffect(() => {
    if (!catalog || !value || gameId) return;
    const g = catalog.find((x) => x.sections.some((s) => s.url === value) || x.url === value);
    if (g) setGameId(g.id);
  }, [catalog, value, gameId]);

  const games = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (catalog ?? []).filter((g) => !f || g.name.toLowerCase().includes(f)).slice(0, 200);
  }, [catalog, filter]);
  const game = catalog?.find((g) => g.id === gameId);

  return (
    <div className="space-y-2">
      {catalog ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="input" placeholder={`Поиск игры (${catalog.length})`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select className="input" value={gameId} onChange={(e) => setGameId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— игра —</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select className="input" value={game?.sections.some((s) => s.url === value) ? value : ''} onChange={(e) => onChange(e.target.value)} disabled={!game}>
            <option value="">— раздел —</option>
            {game?.sections.map((s) => (
              <option key={s.url} value={s.url}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-xs text-muted">{sc.catalogError ? `Каталог не загрузился: ${sc.catalogError}` : 'Загружаю каталог FunPay…'}</p>
      )}
      <input className="input num text-xs" placeholder="или ссылка: https://funpay.com/lots/1906/" value={value} onChange={(e) => onChange(e.target.value.trim())} />
    </div>
  );
}
