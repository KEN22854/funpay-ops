// Песочница для просмотра интерфейса: отдельная база во временной папке, порт 5195, собранный интерфейс (npm run build).
// Запуск с поддельной сетью: node --import ./e2e/fake-net.mjs scripts/sandbox-server.mjs
// Реальные данные в data/ не затрагиваются.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FPO_DATA_DIR ??= join(tmpdir(), 'fpo-sandbox');
process.env.FPO_PORT ??= '5195';
process.env.FPO_HTTP_NO_GAP ??= '1';
mkdirSync(process.env.FPO_DATA_DIR, { recursive: true });
console.log(`Песочница: данные в ${process.env.FPO_DATA_DIR}, порт ${process.env.FPO_PORT}`);
await import('../server/index.mjs');
