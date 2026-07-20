import { defineConfig } from 'tsup';

export default defineConfig({
  // src/index.ts is the API server. scripts/* are operational one-shots that
  // must be available inside the production image (the runtime container
  // doesn't carry source or tsx). Use named entries so index.cjs stays at
  // dist/index.cjs (preserving the existing Dockerfile CMD path) and scripts
  // land at dist/scripts/<name>.cjs.
  entry: {
    index: 'src/index.ts',
    'scripts/recover-stuck-agents': 'scripts/recover-stuck-agents.ts',
    'scripts/breezectl': 'scripts/breezectl.ts',
  },
  format: ['cjs'],
  // @breeze/api is a deployed application, not a consumed library: package.json
  // declares no `main`/`types`/`exports` and nothing imports `@breeze/api`, so
  // the emitted declarations have no consumers. Generating them ran the whole
  // src tree through declaration emit in tsup's lower-heap worker thread, which
  // OOMed (ERR_WORKER_OUT_OF_MEMORY) on heavy inferred types — e.g. the incident
  // feed's UNION ALL query builder — failing the build for ~150 bytes of unused
  // .d.cts. Disable it; the Dockerfile and runbook only ever run dist/*.cjs.
  dts: false,
  // All @breeze/* workspace packages are source-only (main → src/index.ts), so bundle them; exclude future prebuilt packages here.
  noExternal: [/^@breeze\//, 'dotenv'],
});
