import { defineConfig } from 'tsup';

export default defineConfig({
  // src/index.ts is the API server. scripts/* are operational one-shots that
  // must be available inside the production image (the runtime container
  // doesn't carry source or tsx). Use named entries so index.cjs stays at
  // dist/index.cjs (preserving the existing Dockerfile CMD path) and scripts
  // land at dist/scripts/<name>.cjs.
  entry: {
    index: 'src/index.ts',
    // BREEZE_ROLE=worker entrypoint (wave 3.5d-b, #4086) — same named-entry
    // pattern as scripts/recover-stuck-agents below, so worker.cjs lands at
    // dist/worker.cjs (the compose `worker` service's `command`).
    worker: 'src/worker.ts',
    'scripts/recover-stuck-agents': 'scripts/recover-stuck-agents.ts',
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
  // All @breeze/* workspace packages are source-only (main → src/index.ts), so bundle
  // them; exclude future prebuilt packages here.
  //
  // 'mailparser' and 'v9u-smb2' are third-party runtime dependencies of the built-in
  // ee/workspace extension (bundled above via @breeze/ext-workspace) that are NOT among
  // apps/api's own `dependencies`. Both production Dockerfiles deploy only apps/api's own
  // dependency closure into the runner image's node_modules (docker/Dockerfile.api's
  // `pnpm deploy --prod`; apps/api/Dockerfile's direct node_modules copy) -- neither
  // provisions ee/workspace's node_modules at runtime. Left off this list, tsup would
  // still attempt to bundle them by default (they're absent from apps/api's own
  // package.json, so tsup's "external = apps/api's declared deps" heuristic wouldn't
  // externalize them either) -- but that's an ACCIDENT of apps/api not happening to
  // depend on them itself, not a decision, and it would silently break (dangling
  // `require()` in dist/index.cjs, "Cannot find module" at boot) if apps/api ever gained
  // its own same-named dependency for an unrelated reason. Listing them here makes the
  // inlining a deliberate, explicit contract instead. Both are pure JS with no native
  // bindings (verified: no `gypfile`, no `.node` binaries in their dependency trees) --
  // safe to bundle. See apps/api/src/config/extensionBundledDependencies.test.ts for the
  // guard that keeps this list in sync with ee/workspace/package.json.
  //
  // Anything ee/workspace depends on that IS also one of apps/api's own dependencies
  // (today: @anthropic-ai/sdk, drizzle-orm, hono, zod) is deliberately left OFF this
  // list: it stays external and resolves from apps/api's own deployed node_modules,
  // which pnpm already dedupes at install time -- smaller bundle, one copy on disk.
  noExternal: [/^@breeze\//, 'dotenv', 'mailparser', 'v9u-smb2'],
});
