import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outdir = path.join(root, 'dist', 'client');

await mkdir(outdir, { recursive: true });

await build({
  entryNames: 'app',
  entryPoints: [path.join(root, 'client', 'main.tsx')],
  bundle: true,
  outdir,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  loader: {
    '.svg': 'dataurl',
  },
  splitting: false,
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
