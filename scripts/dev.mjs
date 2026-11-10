// npm run dev — поднимает сервер и Vite одной командой.
// npm run dev -- --data <папка> — отдельная база (песочница: тестировать, не трогая основные данные).
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--data');
const env = { ...process.env };
if (i > 0 && process.argv[i + 1]) {
  env.FPO_DATA_DIR = resolve(process.argv[i + 1]);
  console.log(`Песочница: данные в ${env.FPO_DATA_DIR}`);
}
const opts = { stdio: 'inherit', cwd: root, env };

const procs = [
  spawn(process.execPath, ['--watch-path=server', 'server/index.mjs'], opts),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], opts),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
