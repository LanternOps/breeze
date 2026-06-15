# Office Add-in Runtime Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Office add-in JS bundle deployment-neutral by loading `apiBaseUrl` + `entraClientId` from a runtime `/config.json` instead of compile-time `import.meta.env.VITE_*`, so one prebuilt bundle works for hosted SaaS and every self-hoster without per-deployment rebuilds.

**Architecture:** `packages/office-addin-core/src/config.ts` currently exports two module-level constants (`API_BASE_URL`, `ENTRA_CLIENT_ID`) read from Vite env at build time — these get frozen into `dist/`. We replace them with a small runtime loader: `loadRuntimeConfig()` fetches `/config.json` (served from the add-in's own origin) at boot, and `getApiBaseUrl()` / `getEntraClientId()` getters return the loaded values. If `/config.json` is missing or malformed, it falls back to the existing `VITE_*` / `localhost` defaults, so local dev is unchanged. The four host apps await `loadRuntimeConfig()` before rendering. A committed `public/config.json` (localhost defaults) keeps dev working; a `generate-config.mjs` operator utility (symmetric with the existing `generate-manifest.mjs`) lets each deployment emit its own `config.json`. The manifest stays per-deployment (Office reads static XML — it cannot fetch runtime config), but that is the existing tiny template step, not a Vite build.

**Tech Stack:** TypeScript, Vite, Vitest + jsdom, React, pnpm workspaces. Node pinned to v22.20.0.

**Out of scope (separate follow-up plan):** the deployment mechanism that *serves* the bundle + `config.json` (Caddy `file_server` / `breeze-addins` image / CI build+publish, CORS + CSP). That work is gated on the unresolved decision: does the add-in talk to a single global API hostname or per-region (`eu.`/`us.`)? This plan only makes the bundle neutral so that follow-up has a clean artifact to ship.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/office-addin-core/src/config.ts` | Runtime config state + loader + getters | Rewrite |
| `packages/office-addin-core/src/config.test.ts` | Loader behavior (fetch ok / 404 / reject / malformed / trailing-slash / reset) | Create |
| `packages/office-addin-core/src/auth/entraToken.ts` | Use `getEntraClientId()` instead of `ENTRA_CLIENT_ID` | Modify |
| `packages/office-addin-core/src/auth/session.ts` | Use `getApiBaseUrl()` instead of `API_BASE_URL` | Modify |
| `packages/office-addin-core/src/api/client.ts` | Use `getApiBaseUrl()` instead of `API_BASE_URL` | Modify |
| `apps/{excel,word,powerpoint,outlook}-addin/src/main.tsx` | `await loadRuntimeConfig()` before render | Modify (×4) |
| `apps/{excel,word,powerpoint,outlook}-addin/public/config.json` | Committed localhost default so dev + bundle have a neutral config | Create (×4) |
| `apps/{excel,word,powerpoint,outlook}-addin/scripts/generate-config.mjs` | Operator utility: write `public/config.json` from env | Create (×4) |
| `apps/{excel,word,powerpoint,outlook}-addin/.env.example` | Document that prod values come from `config.json`, not the bundle | Modify (×4) |
| `apps/{excel,word,powerpoint,outlook}-addin/README.md` | Note the runtime-config model | Modify (×4) |

**Backward-compat note:** a repo-wide grep confirms `API_BASE_URL` / `ENTRA_CLIENT_ID` are imported ONLY by the three core files above (no app code, no tests). Replacing the constants with getters is safe. `index.ts` re-exports via `export * from './config'`, so the new getters export automatically — no `index.ts` edit needed.

**Node prefix for every command below:**
```bash
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
```

---

### Task 1: Runtime config loader (`config.ts`) — TDD

**Files:**
- Modify: `packages/office-addin-core/src/config.ts`
- Create: `packages/office-addin-core/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/office-addin-core/src/config.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetRuntimeConfigForTests,
  getApiBaseUrl,
  getEntraClientId,
  loadRuntimeConfig,
} from './config';

/** Build a minimal fetch stub returning the given /config.json response. */
function fetchReturning(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const fetchRejecting: typeof fetch = (async () => {
  throw new Error('network down');
}) as unknown as typeof fetch;

afterEach(() => {
  __resetRuntimeConfigForTests();
});

describe('runtime config', () => {
  it('defaults to localhost before any load', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('loads apiBaseUrl + entraClientId from /config.json', async () => {
    await loadRuntimeConfig(
      fetchReturning({ apiBaseUrl: 'https://us.2breeze.app', entraClientId: 'abc-123' }),
    );
    expect(getApiBaseUrl()).toBe('https://us.2breeze.app');
    expect(getEntraClientId()).toBe('abc-123');
  });

  it('strips a trailing slash from apiBaseUrl', async () => {
    await loadRuntimeConfig(fetchReturning({ apiBaseUrl: 'https://eu.2breeze.app/', entraClientId: 'x' }));
    expect(getApiBaseUrl()).toBe('https://eu.2breeze.app');
  });

  it('falls back to defaults on a non-ok response (404)', async () => {
    await loadRuntimeConfig(fetchReturning({}, false));
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('falls back to defaults when fetch rejects', async () => {
    await loadRuntimeConfig(fetchRejecting);
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
  });

  it('falls back per-field when config.json is missing/garbled fields', async () => {
    await loadRuntimeConfig(fetchReturning({ apiBaseUrl: 42, entraClientId: null }));
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @breeze/office-addin-core exec vitest run src/config.test.ts
```
Expected: FAIL — `loadRuntimeConfig` / `getApiBaseUrl` / `getEntraClientId` / `__resetRuntimeConfigForTests` are not exported (only `API_BASE_URL` / `ENTRA_CLIENT_ID` exist today).

- [ ] **Step 3: Rewrite `config.ts` with the runtime loader**

Replace the entire contents of `packages/office-addin-core/src/config.ts` with:

```ts
/**
 * Runtime configuration. The bundle is deployment-neutral: it fetches
 * `/config.json` (served from the add-in's own origin) at boot via
 * loadRuntimeConfig(), so one prebuilt bundle works for every deployment
 * (hosted SaaS and self-hosters) with no per-deployment rebuild.
 *
 * If /config.json is absent or malformed, we fall back to the build-time
 * VITE_* env (apps/<host>-addin/.env, gitignored — see .env.example) and then
 * to localhost defaults, so local dev needs no config file.
 *
 * NOTE: the manifest is NOT runtime-configurable — Office reads static XML and
 * cannot fetch this file. Each deployment still generates its own manifest
 * (scripts/generate-manifest.mjs). config.json covers only the JS bundle.
 */
export type RuntimeConfig = {
  /** Origin of the Breeze API, no trailing slash, e.g. https://us.2breeze.app */
  apiBaseUrl: string;
  /** Entra app-registration client ID; must equal the API's CLIENT_AI_ENTRA_CLIENT_ID. */
  entraClientId: string;
};

const FALLBACK: RuntimeConfig = {
  apiBaseUrl: ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3001').replace(
    /\/$/,
    '',
  ),
  entraClientId: (import.meta.env.VITE_CLIENT_AI_ENTRA_CLIENT_ID as string | undefined) ?? '',
};

let runtime: RuntimeConfig = { ...FALLBACK };

/** API origin (no trailing slash). Valid before load (returns the fallback). */
export function getApiBaseUrl(): string {
  return runtime.apiBaseUrl;
}

/** Entra client ID. Valid before load (returns the fallback). */
export function getEntraClientId(): string {
  return runtime.entraClientId;
}

/**
 * Fetch /config.json once at boot and populate the runtime config. Always
 * resolves — on any failure it keeps the fallback. Safe to call more than once
 * (the last successful load wins). cache:'no-store' so a deploy that swaps
 * config.json is picked up without an Office webview cache hit.
 */
export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const res = await fetchImpl('/config.json', { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as Partial<RuntimeConfig>;
      runtime = {
        apiBaseUrl: (typeof body.apiBaseUrl === 'string' && body.apiBaseUrl
          ? body.apiBaseUrl
          : FALLBACK.apiBaseUrl
        ).replace(/\/$/, ''),
        entraClientId:
          typeof body.entraClientId === 'string' ? body.entraClientId : FALLBACK.entraClientId,
      };
    }
  } catch {
    /* keep the fallback — dev / no config.json served */
  }
  return runtime;
}

/** Test-only: reset to the build-time fallback. */
export function __resetRuntimeConfigForTests(): void {
  runtime = { ...FALLBACK };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @breeze/office-addin-core exec vitest run src/config.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/office-addin-core/src/config.ts packages/office-addin-core/src/config.test.ts
git commit -m "feat(office-addin): runtime config loader (config.json) replacing build-time VITE env"
```

---

### Task 2: Point the three consumers at the getters

**Files:**
- Modify: `packages/office-addin-core/src/auth/entraToken.ts:13,22,45`
- Modify: `packages/office-addin-core/src/auth/session.ts:7,123`
- Modify: `packages/office-addin-core/src/api/client.ts:6,46`

All three already read the values *inside functions* (never at module top level), so swapping a constant for a getter call is mechanical.

- [ ] **Step 1: Update `entraToken.ts`**

Change the import (line 13):
```ts
import { getEntraClientId } from '../config';
```
Change `msalScopes()` (line 22):
```ts
  return [`api://${window.location.host}/${getEntraClientId()}/access_as_user`];
```
Change the MSAL instance config (line 45):
```ts
          clientId: getEntraClientId(),
```

- [ ] **Step 2: Update `session.ts`**

Change the import (line 7):
```ts
import { getApiBaseUrl } from '../config';
```
Change `exchangeOnce` (line 123):
```ts
  const res = await fetchImpl(`${getApiBaseUrl()}/client-ai/auth/exchange`, {
```

- [ ] **Step 3: Update `api/client.ts`**

Change the import (line 6):
```ts
import { getApiBaseUrl } from '../config';
```
Change `doFetch` (line 46):
```ts
    return fetchImpl(`${getApiBaseUrl()}${path}`, { ...init, headers });
```

- [ ] **Step 4: Run the core package test suite + typecheck**

```bash
pnpm --filter @breeze/office-addin-core exec vitest run
pnpm --filter @breeze/office-addin-core exec tsc --noEmit
```
Expected: all tests PASS, no type errors. (Existing auth/client tests inject `fetchImpl` and assert URLs against `http://localhost:3001`, which `getApiBaseUrl()` still returns by default — they pass unchanged.)

- [ ] **Step 5: Commit**

```bash
git add packages/office-addin-core/src/auth/entraToken.ts packages/office-addin-core/src/auth/session.ts packages/office-addin-core/src/api/client.ts
git commit -m "refactor(office-addin): read API/Entra config via runtime getters"
```

---

### Task 3: Load config before render in all four host apps

**Files:**
- Modify: `apps/excel-addin/src/main.tsx`
- Modify: `apps/word-addin/src/main.tsx`
- Modify: `apps/powerpoint-addin/src/main.tsx`
- Modify: `apps/outlook-addin/src/main.tsx`

`App` triggers a silent `signIn` in its mount effect, so config must be loaded before render. Each `main.tsx` is identical except the host adapter import and the `<App>` props.

- [ ] **Step 1: Update `apps/excel-addin/src/main.tsx`**

Replace its contents with:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App, loadRuntimeConfig } from '@breeze/office-addin-core';
import { excelHostAdapter } from './host/excel';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('taskpane.html is missing #root');
const root = createRoot(rootEl);

function render(): void {
  root.render(
    <React.StrictMode>
      <App host={excelHostAdapter} clientHost="excel" />
    </React.StrictMode>,
  );
}

// Load runtime config (/config.json) BEFORE first render — App's mount effect
// kicks off a silent sign-in that needs the API origin + Entra client ID.
async function boot(): Promise<void> {
  await loadRuntimeConfig();
  render();
}

// Inside Excel, wait for the host handshake; in a plain browser tab (dev
// convenience, ADDIN_NO_HTTPS debugging) Office is undefined — boot anyway.
if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  void Office.onReady(() => void boot());
} else {
  void boot();
}
```

- [ ] **Step 2: Apply the same change to the other three apps**

For each of `apps/word-addin/src/main.tsx`, `apps/powerpoint-addin/src/main.tsx`, `apps/outlook-addin/src/main.tsx`: make the identical edit — add `loadRuntimeConfig` to the `@breeze/office-addin-core` import, wrap the existing render trigger in an `async boot()` that `await loadRuntimeConfig()` first, and call `boot()` from both the `Office.onReady` and the `else` branch. Keep each file's existing host adapter import and `<App host=... clientHost=...>` props exactly as they are (word/powerpoint/outlook respectively).

- [ ] **Step 3: Typecheck each app**

```bash
for a in excel word powerpoint outlook; do
  pnpm --filter @breeze/$a-addin exec tsc --noEmit || echo "FAILED: $a";
done
```
Expected: no type errors for any app.

- [ ] **Step 4: Commit**

```bash
git add apps/*-addin/src/main.tsx
git commit -m "feat(office-addin): await runtime config before render in all four hosts"
```

---

### Task 4: Default `config.json` + `generate-config.mjs` per app

**Files (×4 apps):**
- Create: `apps/<host>-addin/public/config.json`
- Create: `apps/<host>-addin/scripts/generate-config.mjs`

The committed `public/config.json` (localhost defaults) makes dev work with no extra step and keeps the shipped bundle neutral (identical for everyone, leaks nothing). `generate-config.mjs` is the operator/deploy-time utility — NOT wired into the standard build, so a clean CI build always ships the neutral localhost default.

- [ ] **Step 1: Create the default `public/config.json` for each app**

Write this identical file to each of `apps/excel-addin/public/config.json`, `apps/word-addin/public/config.json`, `apps/powerpoint-addin/public/config.json`, `apps/outlook-addin/public/config.json`:

```json
{
  "apiBaseUrl": "http://localhost:3001",
  "entraClientId": ""
}
```

- [ ] **Step 2: Create `generate-config.mjs` for each app**

Write this identical file to each of `apps/<host>-addin/scripts/generate-config.mjs`:

```js
#!/usr/bin/env node
// Writes public/config.json (served at /config.json) from env / .env / CLI flags.
//   node scripts/generate-config.mjs [--api-base-url https://us.2breeze.app] [--client-id <guid>] [--out public/config.json]
// Precedence: CLI flag > process.env > .env file > localhost default.
// This is a DEPLOY-TIME utility. The committed public/config.json holds localhost
// defaults so the shipped bundle stays deployment-neutral; each deployment runs
// this (or serves its own config.json) with its real API origin + Entra client ID.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadDotEnv(path.join(root, '.env')), ...process.env };
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const apiBaseUrl = (
  argValue('--api-base-url') ??
  env.VITE_API_BASE_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const clientId =
  argValue('--client-id') ??
  env.VITE_CLIENT_AI_ENTRA_CLIENT_ID ??
  env.CLIENT_AI_ENTRA_CLIENT_ID ??
  '';

if (!clientId) {
  console.warn('[generate-config] WARNING: entraClientId is empty — SSO will not work until set.');
}

const outPath = path.join(root, argValue('--out') ?? 'public/config.json');
writeFileSync(outPath, `${JSON.stringify({ apiBaseUrl, entraClientId: clientId }, null, 2)}\n`);
console.log(`[generate-config] wrote ${outPath} (api: ${apiBaseUrl}, clientId: ${clientId.slice(0, 8) || '∅'}…)`);
```

- [ ] **Step 3: Verify the generator runs and round-trips**

```bash
cd apps/excel-addin
node scripts/generate-config.mjs --api-base-url https://us.2breeze.app --client-id 11111111-2222-3333-4444-555555555555 --out /tmp/config.test.json
cat /tmp/config.test.json
cd ../..
```
Expected: `/tmp/config.test.json` contains `"apiBaseUrl": "https://us.2breeze.app"` and the client ID. (Then discard the temp file — do not commit it.)

- [ ] **Step 4: Run each app's build to confirm `config.json` lands in `dist/`**

```bash
pnpm --filter @breeze/excel-addin build
test -f apps/excel-addin/dist/config.json && echo "config.json shipped in dist" || echo "MISSING"
```
Expected: `config.json shipped in dist` (Vite copies `public/` to `dist/`). The dist `config.json` holds the committed localhost default — correct for a neutral bundle.

- [ ] **Step 5: Commit**

```bash
git add apps/*-addin/public/config.json apps/*-addin/scripts/generate-config.mjs
git commit -m "feat(office-addin): default config.json + generate-config deploy utility"
```

---

### Task 5: Document the runtime-config model

**Files (×4 apps):**
- Modify: `apps/<host>-addin/.env.example`
- Modify: `apps/<host>-addin/README.md`

- [ ] **Step 1: Update each `.env.example`**

In each `apps/<host>-addin/.env.example`, add a comment block above the `VITE_*` lines clarifying they are now dev fallbacks only:

```bash
# Runtime config: in production these values are served at /config.json (see
# scripts/generate-config.mjs), NOT baked into the bundle. The VITE_* vars below
# are dev fallbacks used only when /config.json is absent (e.g. `pnpm dev`).
```

- [ ] **Step 2: Update each `README.md`**

In each `apps/<host>-addin/README.md`, add a short "Runtime config" section:

```markdown
## Runtime config

The JS bundle is deployment-neutral. At boot it fetches `/config.json`
(`{ "apiBaseUrl": "...", "entraClientId": "..." }`) from its own origin. For
local dev the committed `public/config.json` (localhost defaults) is served by
Vite; the `VITE_*` env vars are only a fallback when `/config.json` is absent.

To produce a deployment's config:

    node scripts/generate-config.mjs --api-base-url https://us.2breeze.app --client-id <entra-client-id>

The manifest is still per-deployment (Office reads static XML and cannot fetch
runtime config) — keep generating it with `scripts/generate-manifest.mjs`.
```

- [ ] **Step 3: Commit**

```bash
git add apps/*-addin/.env.example apps/*-addin/README.md
git commit -m "docs(office-addin): document runtime config.json model"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the core + all four app test suites**

```bash
pnpm --filter @breeze/office-addin-core exec vitest run
for a in excel word powerpoint outlook; do
  pnpm --filter @breeze/$a-addin exec vitest run || echo "FAILED: $a";
done
```
Expected: all green. (CI guards distinct ports/GUIDs across apps — unchanged by this work.)

- [ ] **Step 2: Confirm no stale references to the old constants remain**

```bash
grep -rn "\bAPI_BASE_URL\b\|\bENTRA_CLIENT_ID\b" packages/office-addin-core/src apps/*-addin/src | grep -v node_modules
```
Expected: NO matches (all replaced by `getApiBaseUrl()` / `getEntraClientId()`). `VITE_API_BASE_URL` / `VITE_CLIENT_AI_ENTRA_CLIENT_ID` still appearing in `config.ts`, `generate-*.mjs`, and `.env.example` is expected and correct.

- [ ] **Step 3: Sanity-check the dev fallback path**

```bash
pnpm --filter @breeze/excel-addin dev &
sleep 6
curl -ksf https://localhost:3000/config.json && echo "served"
kill %1
```
Expected: `config.json` served with the localhost default (`https` dev cert; `-k` accepts the self-signed cert). This is the file the loader fetches in-host.

---

## Self-Review

**Spec coverage:** The goal (deployment-neutral bundle via runtime config) is fully covered — loader (Task 1), consumers (Task 2), boot (Task 3), default + generator (Task 4), docs (Task 5), verification (Task 6). The manifest-stays-per-deployment caveat is documented (Task 1 `config.ts` header + Task 5 README). The deploy/serving mechanism is explicitly deferred and gated on the hostname decision.

**Placeholder scan:** No TBD/TODO. Every code step shows full code; every command shows expected output.

**Type consistency:** `RuntimeConfig`, `getApiBaseUrl()`, `getEntraClientId()`, `loadRuntimeConfig(fetchImpl?)`, `__resetRuntimeConfigForTests()` are defined in Task 1 and used consistently in Tasks 2, 3, and the Task 1 test. Consumer call sites match the getter names exactly.
