import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
const compiler = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (compiler.error) throw compiler.error;
if (compiler.status !== 0) process.exit(compiler.status ?? 1);

await mkdir(new URL('public/', dist), { recursive: true });
await cp(new URL('../public/index.html', import.meta.url), new URL('public/index.html', dist));
const styles = spawnSync(
  process.execPath,
  [
    'node_modules/@tailwindcss/cli/dist/index.mjs',
    '-i',
    'public/app.css',
    '-o',
    'dist/public/app.css',
    '--minify',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (styles.error) throw styles.error;
if (styles.status !== 0) process.exit(styles.status ?? 1);

await build({
  absWorkingDir: root,
  entryPoints: { app: 'web/app.tsx', theme: 'web/theme-init.ts' },
  outdir: 'dist/public',
  entryNames: '[name]',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'eof',
});
await chmod(new URL('bin/pinotator.js', dist), 0o755);
console.log('Built TypeScript CLI/server/companion and TSX browser bundle in dist/.');
