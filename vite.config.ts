import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    host: '127.0.0.1',
    strictPort: true,
    // API сканера — локальный Node-сервер (server/index.mjs)
    proxy: { '/api': 'http://127.0.0.1:5181' },
  },
  test: {
    // тесты работают на базе в памяти и временной папке — реальные data/ не трогаются
    env: {
      FPO_DB: ':memory:',
      FPO_DATA_DIR: join(tmpdir(), 'funpay-ops-test'),
      FPO_BACKUP_DIR: join(tmpdir(), 'funpay-ops-test', 'backups'),
      FPO_HTTP_RETRIES: '0',
    },
  },
});
