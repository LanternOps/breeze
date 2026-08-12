# Workspace → ee/workspace Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the private `LanternOps/breeze-workspace` extension into the breeze monorepo at `ee/workspace/`, loaded as a statically-imported **built-in extension**, and delete the two-repo packaging seam.

**Architecture:** The workspace package becomes a pnpm workspace member (`@breeze/ext-workspace`) that `apps/api` imports directly. A new `builtinExtensions.ts` feeds its module + v1 manifest through the same staging pipeline signed bundles use (`defaultStageExtension` → tenancy tripwires → `registry.activate`), plus disk-based migrations and boot-time-hashed web assets. The signed-runtime-bundle platform is untouched.

**Tech Stack:** pnpm 10 workspaces, tsup (CJS bundle; `noExternal: [/^@breeze\//]` already bundles workspace packages into the API image), Hono, Drizzle, vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-workspace-ee-merge-design.md`

## Global Constraints

- **Sequencing:** breeze#3032 (tenant-scoped installs) merges FIRST. It touches extension registration/state; wherever this plan references `ExtensionStateStore` methods (`upsertObserved`, `setEnabled`, `isEnabled`, `recordActive`), re-read `apps/api/src/extensions/stateStore.ts` post-merge and use the merged signatures. Requirements stand regardless: workspace seeds enabled on first boot, later boots respect the persisted flag.
- **Branch base:** new branch off `origin/main` after #3032. Cherry-pick spec commit `05c8ffda6` if `ToddHebebrand/client-ext-seam-w4` is dropped. Do NOT touch the ~25 uncommitted `apps/docs` edits in Todd's tree.
- **The real typecheck gate** is `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json` (strict, `noUncheckedIndexedAccess`). The package's own `typecheck` passing is NOT sufficient once apps/api imports it.
- Source move is byte-identical where possible: no drive-by refactors of workspace services/routes/tests.
- All commands run from the breeze repo root unless stated. Source repo: `/Users/toddhebebrand/breeze-workspace` (pin `git rev-parse HEAD` there as `<WS_SHA>`).
- Package manager: `pnpm@10.33.4`. Never edit `pnpm-lock.yaml` by hand.

---

### Task 1: Import workspace source as `ee/workspace` pnpm member

**Files:**
- Modify: `pnpm-workspace.yaml` (add `ee/*`)
- Create: `ee/workspace/` — copied `src/`, `migrations/`, `manifest.json`, `tsconfig.json`, `tsup.server.config.ts`, `tsup.web.config.ts`, `vitest.config.ts`, `vitest.integration.config.ts` from the workspace repo
- Create: `ee/workspace/package.json` (rewritten — see below)

**Interfaces:**
- Produces: package `@breeze/ext-workspace` whose default export (from `src/index.ts`) is a `BreezeExtensionV1` (`register(registrar, context)`), plus `ee/workspace/manifest.json` (v1, `name: "workspace"`), `ee/workspace/migrations/*.sql`, and a `build:web` script emitting `ee/workspace/dist/web/index.js`.

- [ ] **Step 1: Add `ee/*` to the workspace globs**

In `pnpm-workspace.yaml` `packages:` add a third entry:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'ee/*'
```

- [ ] **Step 2: Copy the source at a pinned SHA**

```bash
cd /Users/toddhebebrand/breeze-workspace && git rev-parse HEAD   # record as <WS_SHA>
mkdir -p /Users/toddhebebrand/breeze/ee/workspace
cd /Users/toddhebebrand/breeze/ee/workspace
for p in src migrations manifest.json tsconfig.json tsup.server.config.ts tsup.web.config.ts vitest.config.ts vitest.integration.config.ts; do
  cp -R /Users/toddhebebrand/breeze-workspace/$p .
done
```

Do NOT copy: `vendor/`, `scripts/`, `dev/`, `test/`, `dist/`, `breeze-extension.json` (legacy manifest — the built-in path is v1-only), `vitest.conformance.config.ts`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `manifest.json`→keep (v1), `docs/` (stays in the archived repo). If `vitest.integration.config.ts` references a repo-root `.env.test`, repoint it at breeze's test-env convention (see what `apps/api`'s integration tests load) in Task 6.

- [ ] **Step 3: Write the new package.json**

Create `ee/workspace/package.json` (replaces the old one entirely — old name was `@lanternops/breeze-ext-workspace` with `file:vendor/*.tgz` deps):

```json
{
  "name": "@breeze/ext-workspace",
  "version": "0.2.0",
  "private": true,
  "license": "SEE LICENSE IN ../LICENSE",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build:web": "tsup --config tsup.web.config.ts",
    "test": "vitest run --config vitest.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.112.3",
    "@breeze/extension-sdk": "workspace:*",
    "@breeze/extension-web-sdk": "workspace:*",
    "drizzle-orm": "0.45.2",
    "hono": "4.12.31",
    "mailparser": "^3.9.14",
    "v9u-smb2": "^1.0.6",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@breeze/extension-testkit": "workspace:*",
    "@types/mailparser": "^3.4.6",
    "@types/node": "22.19.3",
    "dotenv": "16.6.1",
    "happy-dom": "^20.11.0",
    "postgres": "3.4.9",
    "tsup": "8.3.5",
    "tsx": "^4.23.1",
    "typescript": "5.7.2",
    "vitest": "4.1.9"
  }
}
```

Note `main: src/index.ts` — every `@breeze/*` package is source-only (apps/api's tsup bundles them via `noExternal`), so no server build script is needed; drop `tsup.server.config.ts` if nothing references it after this step. Pin exact versions to whatever breeze's lockfile already holds for shared deps (`drizzle-orm`, `hono`, `zod`, `vitest`) — check `pnpm why <dep>` and match to avoid duplicate majors.

- [ ] **Step 4: Install and typecheck the package standalone**

```bash
pnpm install
pnpm --filter @breeze/ext-workspace typecheck
pnpm --filter @breeze/ext-workspace build:web && ls ee/workspace/dist/web/index.js
```

Expected: install resolves `workspace:*` to `packages/extension-sdk` etc.; typecheck passes (hostTypes.ts already targets the real v1 SDK types, not the vendored tarball — same package, now by symlink); web build emits `dist/web/index.js`.

- [ ] **Step 5: Run the package's unit tests**

```bash
pnpm --filter @breeze/ext-workspace test
```

Expected: PASS (these are the same tests that passed in the standalone repo). Integration tests are deferred to Task 6 (need DB env wiring).

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml ee/workspace
git commit -m "feat(ee): import breeze-workspace as ee/workspace (@breeze/ext-workspace)

Source imported from LanternOps/breeze-workspace @ <WS_SHA>.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `ee/` commercial license

**Files:**
- Create: `ee/LICENSE`
- Modify: `README.md` (licensing section), `LICENSE` (no content change — add a pointer paragraph to README instead if LICENSE must stay pristine GNU text; the AGPL text itself must not be edited)

- [ ] **Step 1: Write `ee/LICENSE`**

Model on Cal.com's commercial license (`https://github.com/calcom/cal.com/blob/main/packages/features/ee/LICENSE`), adapted:

```
The Breeze Commercial License (the "Commercial License")
Copyright (c) 2026 LanternOps, Inc.

With regard to the Breeze Software:

This software and associated documentation files (the "Software") may only be
used in production, if you (and any entity that you represent) have agreed to,
and are in compliance with, a commercial agreement with LanternOps, Inc., or
other agreements governing the use of the Software, and otherwise have a valid
license for the correct number of users, devices, or endpoints.

Subject to the foregoing sentence, you are free to modify this Software and
publish patches to the Software. You agree that LanternOps, Inc. and/or its
licensors (as applicable) retain all right, title and interest in and to all
such modifications and/or patches, and all such modifications and/or patches
may only be used, copied, modified, displayed, distributed, or otherwise
exploited with a valid commercial license for the Software. You may not copy,
modify, create derivative works of, publicly display, publicly perform,
sublicense or distribute this Software except as expressly permitted above.

Any use of the Software outside of a valid commercial agreement is strictly
prohibited. For clarity, the Software outside of the "ee" directory is
licensed under AGPL-3.0 as described in the repository root LICENSE file.

This Commercial License applies only to the part of this Software that is in
the "ee" directory. The full text of this Commercial License shall be included
in all copies or substantial portions of the Software covered by it.
```

- [ ] **Step 2: Update the root README licensing section**

Find the existing license mention (`grep -n -i "license\|AGPL" README.md`) and replace/extend with:

```markdown
## License

Breeze is [AGPL-3.0](LICENSE) licensed, with one exception: everything under
the [`ee/`](ee/) directory is covered by the
[Breeze Commercial License](ee/LICENSE) (source-visible, requires a
commercial agreement for production use). This is the same open-core layout
used by projects like Cal.com.
```

- [ ] **Step 3: Verify + commit**

Run `pnpm lint` (README/markdown untouched by lint is fine — this confirms nothing broke). Commit:

```bash
git add ee/LICENSE README.md
git commit -m "docs(ee): commercial license for the ee/ directory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Built-in extension loader (`builtinExtensions.ts`)

The heart of the change. Mirrors the reconciler's phase order (migration → tenancy → stage → validate → activate) minus acquire/trust/verify/extract, for statically imported extensions.

**Files:**
- Create: `apps/api/src/extensions/builtinExtensions.ts`
- Create: `apps/api/src/extensions/builtinExtensions.test.ts`
- Modify: `apps/api/src/extensions/loader.ts` (export `declaredRuntimeExtensionNames`)
- Modify: `apps/api/src/extensions/reconciler.ts` (`defaultStageExtension` gains an options param for `helperRoutes`)
- Modify: `apps/api/package.json` (add `"@breeze/ext-workspace": "workspace:*"` to dependencies)

**Interfaces:**
- Consumes: `@breeze/ext-workspace` default export (`BreezeExtensionV1`), `ee/workspace/manifest.json`, `defaultStageExtension(module, manifest, registry, opts?)`, `reconcileExtensionMigrations(migratable, sql, stateStore, rollout?)` (`apps/api/src/extensions/migrator.ts:147` — verify the rollout param's post-#3032 type; pass `undefined`), `registerRuntimeExtensionTenancy`, `assertExtensionTenancyRls`, `registerExtensionWebAsset(name, {root, digest, files})`, `registerGlobalRateLimitSkipPrefix`, `ExtensionStateStore` (`upsertObserved`/`get`/`setEnabled`/`recordActive`/`isEnabled`).
- Produces: `export async function loadBuiltinExtensions(args: { registry: ExtensionContributionRegistry; stateStore: ExtensionStateStore }): Promise<void>` — the single entry Task 4 wires into boot. Also `export const BUILTIN_EXTENSION_NAMES: ReadonlySet<string>`.

- [ ] **Step 1: Export the runtime-name helper from loader.ts**

In `apps/api/src/extensions/loader.ts`, change `function declaredRuntimeExtensionNames(` to `export function declaredRuntimeExtensionNames(`. No behavior change.

- [ ] **Step 2: Extend `defaultStageExtension` for the helper-routes flag**

Workspace's `/helper/*` tree needs core helper auth. The gateway reads a legacy `helperRoutes` flag off the STAGED manifest (`apps/api/src/extensions/gateway.ts:36`), but the flag is not in the strict v1 wire schema — `loader.ts` stages an augmented manifest and strips before `parseExtensionManifestV1`. Give the reconciler's stage function the same ability:

```ts
export async function defaultStageExtension(
  module: BreezeExtensionV1,
  manifest: ExtensionManifestV1,
  registry: ExtensionContributionRegistry,
  opts?: { helperRoutes?: boolean },
): Promise<StagedExtensionContributions> {
  const stagedManifest = opts?.helperRoutes ? { ...manifest, helperRoutes: true } : manifest;
  const session = registry.begin(stagedManifest);
  // ... registrar + context construction unchanged ...
  await module.register(registrar, context);
  parseExtensionManifestV1(manifest);   // parse the CLEAN manifest, as before
  return session.finish();
}
```

Existing call sites (`buildDefaultPorts`'s `stageExtension`) pass no `opts` — unchanged behavior. Run `pnpm --filter @breeze/api exec vitest run src/extensions/reconciler.test.ts` to confirm no regression before proceeding.

- [ ] **Step 3: Write the failing tests**

`apps/api/src/extensions/builtinExtensions.test.ts`. Follow `reconciler.test.ts`'s conventions for building an `ExtensionContributionRegistry` and an in-memory state store (reuse its test backend helper; post-#3032, mirror whatever reconciler.test.ts then uses). Inject fakes through the args object — the loader accepts port overrides exactly like `reconcileExtensions` does, so tests never touch a real DB or the real workspace package:

```ts
import { describe, expect, it } from 'vitest';
import { loadBuiltinExtensions, BUILTIN_EXTENSION_NAMES } from './builtinExtensions';

// Minimal passing fixture: a manifest cloned from ee/workspace/manifest.json's
// shape but with empty tenancy tables, and a module whose register() mounts one
// route. Build both inline; do not import @breeze/ext-workspace in unit tests.

describe('loadBuiltinExtensions', () => {
  it('activates a built-in through the staged pipeline with enabled=true on first boot', async () => {
    // fresh registry + empty in-memory state store; ports: runMigrations,
    // publishTenancy, validateTenancy, registerWebAsset stubbed to record calls
    // → expect registry contains the extension, stateStore row exists with
    // enabled=true, activeVersion set, and phase order was
    // migration → tenancy → stage → validate → activate (assert via the
    // recording stubs' call sequence).
  });

  it('respects a persisted enabled=false on later boots', async () => {
    // seed the store with { name, enabled: false } → after load, the registry
    // snapshot for the extension has enabled=false (routes 404 via enabledGate)
    // and setEnabled was NOT called.
  });

  it('fails boot when extensions.yaml declares a built-in name', async () => {
    // ports.declaredRuntimeNames returns Set(['workspace']) → rejects with an
    // error naming both delivery paths.
  });

  it('fails boot when a legacy source dir shadows a built-in name', async () => {
    // ports.sourceCandidates returns ['workspace'] → rejects.
  });

  it('registers agent rate-limit skip prefixes when agentRoutes is true', async () => {
    // ports.registerRateLimitSkip recorder → expect /api/v1/ext/<name>/agent/
    // and /api/v1/<routeNamespace>/agent/.
  });

  it('production boot fails when the web dist is missing; dev warns and skips web asset', async () => {
    // ports.readWebDist throws ENOENT: with NODE_ENV=production → rejects;
    // otherwise → resolves, registerWebAsset not called, warning logged.
  });
});
```

Flesh each `it` into real assertions while writing Step 5's implementation — the six behaviors above are the required coverage, and each must assert on recorded calls, not just "no throw".

- [ ] **Step 4: Run tests to verify they fail**

```bash
pnpm --filter @breeze/api exec vitest run src/extensions/builtinExtensions.test.ts
```

Expected: FAIL — module `./builtinExtensions` not found.

- [ ] **Step 5: Implement `builtinExtensions.ts`**

Shape (real code; adjust identifiers to post-#3032 stateStore):

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { BreezeExtensionV1 } from '@breeze/extension-sdk';
import { parseExtensionManifestV1, type ExtensionManifestV1 } from '@breeze/extension-sdk';
import workspaceExtension from '@breeze/ext-workspace';
import type { ExtensionContributionRegistry } from './contributionRegistry';
import type { ExtensionStateStore } from './stateStore';
import { defaultStageExtension } from './reconciler';
import { reconcileExtensionMigrations, type MigratableExtension } from './migrator';
import { registerRuntimeExtensionTenancy } from './tenancyRegistry';
import { assertExtensionTenancyRls } from './tenancyTripwire';
import { registerExtensionWebAsset } from './webAssets';
import { declaredRuntimeExtensionNames } from './loader';
import { listSourceExtensionCandidates, resolveExtensionsRoot } from './discovery';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';

interface BuiltinExtension {
  module: BreezeExtensionV1;
  manifest: ExtensionManifestV1;
  /** package dir under the repo/image root, e.g. 'ee/workspace' */
  packageDir: string;
  helperRoutes: boolean;
}

/** Resolve <repo or image root>/<packageDir>: dev walks up from this file
 *  (src/extensions → apps/api → apps → repo); the CJS Docker bundle falls back
 *  to cwd (/app), where the Dockerfile copies ee/workspace/{migrations,dist}.
 *  Same pattern as discovery.ts's resolveExtensionsRoot. */
function resolveBuiltinRoot(packageDir: string): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const fromSource = path.resolve(path.dirname(thisFile), '..', '..', '..', '..', packageDir);
    if (existsSync(fromSource)) return fromSource;
  } catch { /* CJS bundle: import.meta shim may not resolve a real path */ }
  return path.join(process.cwd(), packageDir);
}

function loadBuiltinManifest(root: string): ExtensionManifestV1 {
  return parseExtensionManifestV1(
    JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')),
  );
}

function readDiskMigrations(root: string, migrationsDir: string): MigratableExtension['migrations'] {
  const dir = path.join(root, migrationsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ filename, sql: readFileSync(path.join(dir, filename), 'utf8') }));
}

/** Hash dist/web at boot into the inventory shape registerExtensionWebAsset
 *  expects (members named `web/<relpath>`, root = <pkg>/dist), with a digest
 *  over the sorted inventory so the digest-addressed asset route stays
 *  cache-coherent across deploys. */
function readWebDist(root: string): { root: string; digest: string; files: Map<string, { sha256: string; uncompressedSize: number }> } {
  const distRoot = path.join(root, 'dist');
  const webDir = path.join(distRoot, 'web');
  if (!existsSync(webDir)) throw Object.assign(new Error(`missing ${webDir}`), { code: 'ENOENT' });
  const files = new Map<string, { sha256: string; uncompressedSize: number }>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const bytes = readFileSync(full);
      files.set(path.relative(distRoot, full).split(path.sep).join('/'), {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uncompressedSize: bytes.length,
      });
    }
  };
  walk(webDir);
  const digest = createHash('sha256')
    .update([...files.keys()].sort().map((k) => `${k}:${files.get(k)!.sha256}`).join('\n'))
    .digest('hex');
  return { root: distRoot, digest, files };
}

const BUILTINS: BuiltinExtension[] = [
  {
    module: workspaceExtension,
    manifest: loadBuiltinManifest(resolveBuiltinRoot('ee/workspace')),
    packageDir: 'ee/workspace',
    helperRoutes: true,
  },
];

export const BUILTIN_EXTENSION_NAMES: ReadonlySet<string> = new Set(
  BUILTINS.map((b) => b.manifest.name),
);

export async function loadBuiltinExtensions(args: {
  registry: ExtensionContributionRegistry;
  stateStore: ExtensionStateStore;
  ports?: Partial<BuiltinPorts>;   // test seam, mirroring reconcileExtensions
}): Promise<void> { /* ... */ }
```

Body of `loadBuiltinExtensions`, per built-in, in this order (each phase overridable via `ports` exactly like `buildDefaultPorts`):

1. **Collision gates:** `declaredRuntimeExtensionNames(resolveExtensionsRoot())` and `listSourceExtensionCandidates()` must not contain the built-in's name — throw a boot-failing error naming both paths otherwise ("one delivery path per extension name", extending the tripwire in `loader.ts:235`).
2. **Migrations:** construct the `MigratableExtension` (`name`, `version`, `schemaCompatibilityFloor` from the manifest, `migrations` via `readDiskMigrations`), open `postgres(process.env.DATABASE_URL, { max: 2 })` (fail fast if unset, mirroring `buildDefaultPorts.createMigrationSql`), call `reconcileExtensionMigrations(migratable, sql, args.stateStore, undefined)`, `await sql.end()` in a finally.
3. **Tenancy publish:** `registerRuntimeExtensionTenancy(manifest.tenancy)`.
4. **Stage:** `await defaultStageExtension(module, manifest, args.registry, { helperRoutes })`.
5. **Validate:** `await assertExtensionTenancyRls(manifest.name, manifest.tenancy)`.
6. **State seed:** `await stateStore.upsertObserved({ name, configuredVersion: manifest.version, activeVersion: manifest.version, manifestApiVersion: manifest.apiVersion, serverSdkVersion: manifest.requires.serverSdk, webSdkVersion: manifest.requires.webSdk ?? null })`; if `await stateStore.get(name)` had been `null` BEFORE the upsert, `await stateStore.setEnabled(name, true)` (first boot defaults enabled; later boots never touch the flag); `await stateStore.recordActive(name, manifest.version)`.
7. **Activate:** `args.registry.activate({ ...staged, enabled: await stateStore.isEnabled(name) })`; if `staged.routeApp && manifest.agentRoutes === true`, register both rate-limit skip prefixes (`/api/v1/ext/<name>/agent/`, `/api/v1/<routeNamespace>/agent/`).
8. **Web asset:** `readWebDist(root)` → `registerExtensionWebAsset(name, asset)`. On ENOENT: `NODE_ENV === 'production'` → rethrow (boot fails — an image without the web bundle is misbuilt); otherwise log one structured warning (`builtin_web_dist_missing`, naming `pnpm --filter @breeze/ext-workspace build:web`) and skip — server routes still activate so API-only dev needs no web build.

Errors are NOT caught-and-continued: built-ins are first-party required code — any phase failure propagates and aborts boot (unlike optional runtime bundles). Do not call `registerExtensionRoot` (fault attribution keys on extracted-root stack paths; built-ins are bundled into the core image, so faults correctly attribute to core).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @breeze/api exec vitest run src/extensions/builtinExtensions.test.ts src/extensions/reconciler.test.ts src/extensions/loader.test.ts
```

Expected: all PASS.

- [ ] **Step 7: Add the dependency + run the real typecheck gate**

Add to `apps/api/package.json` dependencies: `"@breeze/ext-workspace": "workspace:*"`, then:

```bash
pnpm install
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: clean. This is where `noUncheckedIndexedAccess` errors inside workspace code would first surface — fix them in `ee/workspace` (narrowing only, no logic changes) if any appear. Check `apps/api/tsconfig.json`'s `include`/`references` — if workspace src is not pulled in via the import graph automatically, tsc will say so with unresolved-module errors; add a path mapping only if needed (the pnpm symlink normally suffices).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/extensions/builtinExtensions.ts apps/api/src/extensions/builtinExtensions.test.ts \
  apps/api/src/extensions/loader.ts apps/api/src/extensions/reconciler.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(extensions): built-in extension loading path; workspace is the first built-in

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Boot wiring

**Files:**
- Modify: `apps/api/src/index.ts` (around line 1618 — after `loadSourceExtensions`, before `reconcileExtensions`)

**Interfaces:**
- Consumes: `loadBuiltinExtensions({ registry, stateStore })` from Task 3; the existing `extensionContributionRegistry` and `extensionStateStore` singletons already in scope at that call site.

- [ ] **Step 1: Wire the call**

```ts
await loadSourceExtensions(extensionContributionRegistry);

// Built-in (first-party, statically imported) extensions: same staged v1
// pipeline as signed bundles, no artifact verification. Any failure aborts
// boot — built-ins are required code, not optional deployments.
await loadBuiltinExtensions({
  registry: extensionContributionRegistry,
  stateStore: extensionStateStore,
});

await reconcileExtensions({ /* unchanged */ });
```

Import `loadBuiltinExtensions` alongside the existing `loadSourceExtensions` import (`apps/api/src/index.ts:287`).

- [ ] **Step 2: Boot it against the dev stack**

```bash
pnpm --filter @breeze/ext-workspace build:web
pnpm --filter @breeze/api dev   # or the compose dev flow Todd uses; watch boot logs
```

Expected boot log lines: workspace migrations reconcile (idempotent — the dev DB already has the tables from the seam era; the migrator's ledger handles re-runs), `activated "workspace" at /api/v1/ext/workspace`, no tenancy tripwire errors. Then smoke:

```bash
curl -s localhost:3001/api/v1/ext/workspace/health   # expect 401/403 (auth-gated), NOT 404
```

A 404 means the enabled gate is off — check the `installed_extensions` row for `workspace` (`enabled` must be true; Task 3 Step 5.6 seeds it).

- [ ] **Step 3: Run the API extension suite + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/extensions/
git add apps/api/src/index.ts
git commit -m "feat(api): load built-in extensions at boot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Docker image

**Files:**
- Modify: `docker/Dockerfile.api` (deps COPY list, builder build steps, runner COPY list, stock-image comment)
- Check-only: `docker/Dockerfile.api.dev` (bind-mount dev flow — usually needs nothing; verify `ee/` is inside the mounted tree)

- [ ] **Step 1: deps stage — add the package manifests**

After the existing `COPY packages/extension-sdk/package.json ./packages/extension-sdk/` line add:

```dockerfile
COPY packages/extension-web-sdk/package.json ./packages/extension-web-sdk/
COPY packages/extension-testkit/package.json ./packages/extension-testkit/
COPY ee/workspace/package.json ./ee/workspace/
```

(extension-web-sdk/testkit only if `pnpm install --frozen-lockfile` in the image fails without them — `workspace:*` deps of ee/workspace must be present. Test by building.)

- [ ] **Step 2: builder stage — build the web bundle**

After `RUN pnpm --filter @breeze/api build` add:

```dockerfile
RUN pnpm --filter @breeze/ext-workspace build:web
```

(The server code needs no separate build — tsup bundles it into `dist/index.cjs` via the static import.)

- [ ] **Step 3: runner stage — copy migrations + web dist**

After the `COPY ... /app/apps/api/migrations ./migrations` line add:

```dockerfile
# Built-in extensions: migrations + prebuilt web assets, resolved at runtime
# relative to cwd (/app) by builtinExtensions.ts.
COPY --from=builder --chown=hono:nodejs /app/ee/workspace/migrations ./ee/workspace/migrations
COPY --from=builder --chown=hono:nodejs /app/ee/workspace/manifest.json ./ee/workspace/manifest.json
COPY --from=builder --chown=hono:nodejs /app/ee/workspace/dist ./ee/workspace/dist
```

Also update the stock-image comment above the `mkdir -p /app/extensions` line: the image now contains AGPL core + built-in `ee/` code; third-party extensions still arrive only as signed runtime bundles.

- [ ] **Step 4: Build and boot the image**

```bash
docker build -f docker/Dockerfile.api -t breeze-api:ee-merge .
docker run --rm breeze-api:ee-merge node -e "require('node:fs').accessSync('/app/ee/workspace/dist/web/index.js'); require('node:fs').accessSync('/app/ee/workspace/manifest.json'); console.log('ok')"
```

Expected: build succeeds; `ok`. If a full boot against a throwaway DB is cheap in this environment (compose ci profile), do it and verify the `activated "workspace"` log line from a production-mode bundle.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile.api
git commit -m "build(docker): bake built-in ee/workspace migrations + web assets into the API image

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CI + integration tests

**Files:**
- Modify: `.github/workflows/ci.yml` (Test API job — add workspace steps next to the extension-sdk steps at lines ~135-144)
- Modify: `ee/workspace/vitest.integration.config.ts` (env loading repointed at breeze conventions)
- Check: `eslint` root config covers `ee/` (run `pnpm lint`; if `ee/` is ignored/unmatched, add it to the lint globs)

- [ ] **Step 1: Repoint the integration config's env**

Read how the old config loaded `.env.test` (repo-root of the OLD repo) and how breeze's `apps/api` integration tests get DB env in CI (`grep -n "env.test\|DATABASE_URL" .github/workflows/ci.yml apps/api/vitest*.config.ts`). Make `ee/workspace/vitest.integration.config.ts` load the same source breeze uses. The integration suite's self-provisioned throwaway-DB pattern (`breeze_test_<suffix>`, created + `autoMigrate()`d in beforeAll, FORCE-dropped in afterAll) is kept as-is — never point it at the shared `breeze_test`.

- [ ] **Step 2: Add CI steps**

In the Test API job, after the extension-sdk test/typecheck steps:

```yaml
      - name: Test workspace (ee)
        run: pnpm --filter @breeze/ext-workspace test

      - name: Type-check workspace (ee)
        run: pnpm --filter @breeze/ext-workspace typecheck

      - name: Integration-test workspace (ee)
        run: pnpm --filter @breeze/ext-workspace test:integration
```

Place the integration step wherever the job has a Postgres service available — if the Test API job lacks one, put it in the job that runs `apps/api` integration tests instead (find it: `grep -n "postgres" .github/workflows/ci.yml`). The apps/api typecheck step at ci.yml:108 already covers workspace code via the static import — no new step needed for the strict gate.

- [ ] **Step 3: Run everything locally as CI would**

```bash
pnpm lint
pnpm --filter @breeze/ext-workspace test
pnpm --filter @breeze/ext-workspace test:integration
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml ee/workspace/vitest.integration.config.ts
git commit -m "ci: run ee/workspace tests in breeze CI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Seam demolition + docs

**Files:**
- Delete: `extensions/workspace` (the symlink in the breeze repo)
- Modify: `docs/extensions/build-time-transition.md` (document the built-in path as a distinct first-party mode)
- Modify: `extensions/README.md` (delivery-path list)
- Check: root `package.json` — Todd's machine-local UNSTAGED `pnpm.overrides` edit for vendored SDKs, and the untracked compose-override `./package.json:/app/package.json` mount. These are not in git; leave a checklist item for Todd rather than editing his tree: **"Todd: discard the local root-package.json overrides edit + delete the compose override mount — both are dead now."**

- [ ] **Step 1: Remove the symlink**

```bash
git rm --cached extensions/workspace 2>/dev/null || true   # only if it was ever tracked
rm extensions/workspace
```

(It points at `~/orca/workspaces/breeze-workspace/demo-preparation-bcre`; nothing in-repo may reference it — verify with `grep -rn "extensions/workspace" --include="*.ts" --include="*.yml" --include="*.yaml" apps packages docker .github | grep -v node_modules`. Any hit is a dev-flow reference to update to `ee/workspace`.)

- [ ] **Step 2: Docs**

In `docs/extensions/build-time-transition.md`, add a short section after the intro:

```markdown
## Built-in (first-party) extensions

Since 2026-08, first-party extensions under `ee/` (currently `ee/workspace`)
are compiled into the API image and registered at boot through the same
staged v1 pipeline as signed bundles (`builtinExtensions.ts`) — no signing,
no artifact verification, no source-directory scan. This path is reserved
for code that lives in this repository. Third-party delivery remains signed
runtime bundles; the deprecated source-directory path and its removal gate
below are unaffected. The stock image therefore contains AGPL core plus
built-in `ee/` code — "extension-free" in the removal-gate sense refers to
*externally delivered* extension code only.
```

Update `extensions/README.md`'s description of the directory to note first-party extensions live in `ee/`, not here. Run the doc-verify workflow's local equivalent if one exists (`ls scripts | grep -i doc`).

- [ ] **Step 3: Full suite + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/extensions/ && pnpm lint
git add -A extensions docs/extensions
git commit -m "chore(extensions): retire the workspace symlink dev flow; document the built-in path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(ee): merge Workspace into the monorepo as a built-in extension" --body "..."
```

PR body: link the spec, summarize the built-in path, list the deletion inventory, and include the two Todd checklist items (local overrides edit; compose override mount). End with the standard generation footer.

---

### Task 8: Archive the private repo (after the PR merges)

Manual/gh steps — no code. **Do not run until the breeze PR is merged and a dev boot has been verified by Todd.**

- [ ] **Step 1: Migrate open items** — `gh issue list -R LanternOps/breeze-workspace --state open` and `gh pr list -R LanternOps/breeze-workspace --state open`; re-file still-relevant items as breeze issues (label `ee/workspace`), close the rest with a pointer to the merge PR.
- [ ] **Step 2: Final README** — commit a README banner to breeze-workspace main: "Merged into LanternOps/breeze at `ee/workspace` as of <merge-SHA> (imported at <WS_SHA>). This repo is archived; history lives here."
- [ ] **Step 3: Archive** — `gh repo archive LanternOps/breeze-workspace --yes`.
- [ ] **Step 4: Local cleanup checklist for Todd** — the `~/orca/workspaces/breeze-workspace/*` worktrees and `~/breeze-workspace` clone are now historical; the `client-ext-seam-w4` branch's two commits (clientSurfaces/clientPanels legacy-path carry, web-module CORS allowlist) get triaged: keep what serves the third-party platform, drop what existed only for the seam.
