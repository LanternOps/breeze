import { defineConfig } from 'tsup';

/**
 * Web bundle: one same-origin ESM graph rooted at dist/web/index.js, exactly
 * what manifest.json's `web.entry` names.
 *
 * The host loads the entry by URL (`loadEntry`) with no import map, so bare
 * specifiers cannot resolve in the browser — the web SDK and zod are bundled
 * IN (the plan's "externalize only if the host exposes the exact public
 * import map" condition does not hold). check-bundle enforces that no static
 * or dynamic bare import survives in the output.
 */
export default defineConfig({
  entry: { index: 'src/web/index.ts' },
  outDir: 'dist/web',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  minify: false,
  splitting: false,
  clean: true,
  noExternal: [/.*/],
});
