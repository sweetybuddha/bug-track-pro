import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const analyzer = spawn(python, [path.join(root, 'backend', 'app.py')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.ANALYZER_PORT || '5000' },
});

const shutdown = (signal) => {
  analyzer.kill(signal);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
analyzer.on('error', (error) => {
  console.error(`Could not start the analyzer with ${python}: ${error.message}`);
  process.exit(1);
});
analyzer.on('exit', (code) => {
  if (code && code !== 0) process.exit(code);
});

await import('./server.js');
