import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Отдельная временная база на каждый прогон: реальные данные в data/ не затрагиваются.
const DATA = process.env.FPO_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'fpo-e2e-'));
process.env.FPO_E2E_DATA = DATA;
const PORT = Number(process.env.FPO_E2E_PORT ?? 5191);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ru-RU',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium-headless-shell' } }],
  webServer: {
    // собранный интерфейс отдаёт сам сервер; сеть — фикстуры (e2e/fake-net.mjs)
    command: 'node --import ./e2e/fake-net.mjs server/index.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { FPO_DATA_DIR: DATA, FPO_PORT: String(PORT), FPO_HTTP_NO_GAP: '1', FPO_HTTP_RETRIES: '0', FPO_BACKUP_KEY: 'e2e-backup-key-0123456789' },
  },
});
