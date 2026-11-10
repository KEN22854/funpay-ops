import { useEffect, useState } from 'react';
import { Card, Stat, Warning } from '../../components/ui';
import type { SkinGame } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { FunpayPicker } from './FunpayPicker';
import type { ScannerState } from './useScanner';

const GAMES: { id: SkinGame; name: string; catalogName: string; defaultUrl?: string }[] = [
  { id: 'cs2', name: 'Counter-Strike 2', catalogName: 'Counter-Strike 2', defaultUrl: 'https://funpay.com/lots/1906/' },
  { id: 'dota2', name: 'Dota 2', catalogName: 'Dota 2' },
  { id: 'rust', name: 'Rust', catalogName: 'Rust' },
];

/** Ищет в каталоге FunPay подраздел «Скины»/«Предметы» нужной игры */
function guessSection(sc: ScannerState, catalogName: string): string | null {
  const g = sc.catalog?.find((x) => x.name === catalogName);
  const s = g?.sections.find((x) => /скин/i.test(x.name)) ?? g?.sections.find((x) => /предмет/i.test(x.name));
  return s?.url ?? null;
}

export function Discover({ sc }: { sc: ScannerState }) {
  const [game, setGame] = useState<SkinGame>('cs2');
  const [url, setUrl] = useState(GAMES[0].defaultUrl!);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sc.loadCatalog();
  }, [sc]);

  const pickGame = (g: SkinGame) => {
    setGame(g);
    const def = GAMES.find((x) => x.id === g)!;
    setUrl(guessSection(sc, def.catalogName) ?? def.defaultUrl ?? '');
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await sc.discover(game, url, onlineOnly);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const done = Object.values(sc.discoveries).sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));

  return (
    <div className="space-y-4">
      <Card title="Автопоиск скинов: весь раздел FunPay × площадки скинов">
        <p className="mb-4 text-sm text-muted">
          Берёт все лоты раздела FunPay (продажа, без аренды), находит в описании точное английское название предмета и сравнивает с ценами Skinport,
          Market.CSGO / Dota2.net / Rust.tm, LIS-SKINS и Waxpeer. Совпадают только лоты, где продавец указал имя как в Steam — русские названия не
          распознаются. Результат — во вкладке «Возможности».
        </p>
        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <label className="block">
            <span className="label">Игра</span>
            <select className="input" value={game} onChange={(e) => pickGame(e.target.value as SkinGame)}>
              {GAMES.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className="label">Раздел FunPay</span>
            <FunpayPicker sc={sc} value={url} onChange={setUrl} hintGame={GAMES.find((g) => g.id === game)!.catalogName} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} />
            Сравнивать только с продавцами онлайн
          </label>
          <button className="btn-primary" disabled={busy || !url} onClick={run}>
            {busy ? 'Сканирую (до минуты)…' : 'Запустить автопоиск'}
          </button>
        </div>
        {error && (
          <div className="mt-3">
            <Warning tone="bad">{error}</Warning>
          </div>
        )}
      </Card>

      {done.map((d) => (
        <Card key={d.game + d.funpay.url} title={`${GAMES.find((g) => g.id === d.game)?.name} — ${d.funpay.title}`} right={<span className="text-xs text-muted">{fmtDateTime(d.scannedAt)}</span>}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Лотов в разделе" value={d.funpay.total} />
            <Stat label="На продажу" value={d.funpay.considered} />
            <Stat label="Распознано" value={d.funpay.matched} sub={d.funpay.considered ? `${Math.round((d.funpay.matched / d.funpay.considered) * 100)} %` : undefined} />
            <Stat label="Предметов с ценой закупки" value={d.items.length} />
          </div>
          {Object.keys(d.feedErrors).length > 0 && (
            <p className="mt-3 text-xs text-warn">
              Не загрузились: {Object.entries(d.feedErrors).map(([k, v]) => `${k} — ${v}`).join('; ')}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
