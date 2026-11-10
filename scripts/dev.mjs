// npm run dev — поднимает сервер сканера и Vite одной командой.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const opts = { stdio: 'inherit', cwd: root };

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
