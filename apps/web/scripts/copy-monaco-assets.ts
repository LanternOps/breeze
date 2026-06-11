import { createRequire } from 'module';
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';

// Copy Monaco's AMD editor bundle (`monaco-editor/min/vs`) into the web app's
// `public/monaco/vs` so Astro serves it from `'self'`. This is what lets us
// drop `cdn.jsdelivr.net` (the @monaco-editor/loader default origin) from the
// CSP. Runs in the `predev`/`prebuild` lifecycle; the output is gitignored and
// regenerated from the pinned `monaco-editor` dependency on every build. See
// #1023 and src/lib/monacoLoader.ts.

const require = createRequire(import.meta.url);
const monacoPkg = require.resolve('monaco-editor/package.json');
const src = join(dirname(monacoPkg), 'min', 'vs');
const destRoot = join(import.meta.dirname, '..', 'public', 'monaco');
const dest = join(destRoot, 'vs');

if (!existsSync(src)) {
  throw new Error(
    `Monaco assets not found at ${src} — is the 'monaco-editor' dependency installed?`
  );
}

rmSync(destRoot, { recursive: true, force: true });
mkdirSync(destRoot, { recursive: true });
cpSync(src, dest, { recursive: true });

console.log(`Copied Monaco editor assets to ${dest}`);
