# Breeze AI for Office — Plan 5: Excel Add-in

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the client-facing Excel add-in: a new `apps/office-addin/` task-pane app that signs users in via Office SSO (MSAL popup fallback), exchanges the Entra token for a Breeze client-AI session, streams chat over fetch-based SSE, executes the 9 workbook tools client-side via Office.js, gates every mutating tool behind a write-preview Apply/Reject card, and carries the context chip, template picker, and MSP-brandable footer from spec §11.

**Architecture:** A standalone Vite + React app in the pnpm workspace (`apps/*` glob — no workspace-file change). Office.js loads from the Microsoft CDN in `taskpane.html`; the React island renders after `Office.onReady`. Auth is a two-hop chain: `OfficeRuntime.auth.getAccessToken` (silent SSO) → `@azure/msal-browser` popup fallback → `POST /client-ai/auth/exchange` → in-memory + sessionStorage Breeze session token with single-flight re-exchange on 401. The chat loop is a framework-free `ChatController` (testable without React) that consumes the session SSE stream, auto-executes read tools through an Office.js executor registry, and parks mutating `tool_request`s in an approval queue that the `WritePreviewCard` resolves via `POST .../tool-results`. All Office.js access is funneled through `Excel.run`, which a hand-rolled mock replaces wholesale in vitest.

**Tech Stack:** Vite 8, React 19.2, TypeScript 5.7, Tailwind CSS 3.4, @azure/msal-browser 4, @types/office-js, office-addin-dev-certs (https dev server), Vitest 4 + jsdom

**Spec:** docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md
**Depends on:** Plans 1–4 (server); independently developable against mocks after Plan 2's API is stable
---

## Pinned server contracts (the ONLY API surface this plan touches)

Workers implement against these shapes verbatim — no other doc is needed. Sources: Plan 1 (`docs/superpowers/plans/ai-mcp/2026-06-12-ai-for-office-1-foundation.md`, Task 9 — implemented and authoritative) and the spec §5 protocol pins for the Plan-2 session loop (see Deviations D1 for the reconciliation rule).

### 1. Auth exchange — `POST /client-ai/auth/exchange` (Plan 1, authoritative)

Request: `{ "accessToken": "<Entra ID access token>" }` (no auth header — pre-auth route).

200 response (Plan 1 Task 9, `auth.ts` lines ~2330-2335 of that plan):

```json
{
  "accessToken": "<48-char Breeze session token>",
  "expiresInSeconds": 86400,
  "user": { "id": "<portal_users uuid>", "email": "user@contoso.com", "name": "Finance User" }
}
```

`user.name` may be `null`. **There is no `org` or `branding` field in Plan 1's response** — see Deviation D2; the client types them as optional so a later server addition is picked up with zero client changes.

Error responses — always `{ "error": "<code>" }`:

| Status | `error` code | Add-in behavior |
|---|---|---|
| 400 | (zod detail) | treat as `unknown` failure |
| 401 | `invalid_token` | retry sign-in from scratch |
| 404 | `tenant_not_provisioned` | "not provisioned by your IT provider" screen |
| 404 | `not_enabled` | same screen family (server lacks `CLIENT_AI_ENTRA_CLIENT_ID`) |
| 403 | `disabled` | "disabled for your organization" screen |
| 403 | `user_not_permitted` | "no access" screen |
| 403 | `account_inactive` | "account inactive" screen |
| 403 | `provisioning_failed` | generic failure, allow retry |
| 429 | `rate_limited` | toastable error, allow retry |
| 503 | `service_unavailable` | toastable error, allow retry |

### 2. Session loop (Plan 2 surface — prompt-pinned, see D1)

All requests carry `Authorization: Bearer <Breeze session token>`. On any 401 the client re-runs the exchange once (single-flight) and retries.

- `POST /client-ai/sessions` body `{}` → `200 { "sessionId": "<uuid>" }`
- `POST /client-ai/sessions/:id/messages` body:
  ```json
  {
    "content": "What does column B total to?",
    "workbookContext": {
      "kind": "selection",
      "address": "Sheet1!B2:F40",
      "sheetName": "Sheet1",
      "cells": [["Region", "Q1"], ["EMEA", 1200]]
    }
  }
  ```
  `workbookContext` optional; `kind` ∈ `selection | sheet | none`; `address`/`sheetName`/`cells` all optional (cells omitted when over the context cap). Returns 200 on accept; budget/rate rejections come back as 4xx `{ error }` (e.g. `budget_exceeded`, `rate_limited` — spec §4 pre-flight).
- `GET /client-ai/sessions/:id/events` — SSE (`text/event-stream`). The add-in uses **fetch + ReadableStream parsing** so the `Authorization` header works (`EventSource` can't set headers); a `?token=` query-param fallback exists server-side but the header path is primary. Frames follow the technician-AI convention (`apps/api/src/routes/ai.ts:433`): `event: <type>` + `data: <JSON including "type">` — the client discriminates on the JSON `type` field and ignores unknown types. Event vocabulary (subset of `AiStreamEvent`, `packages/shared/src/types/ai.ts:104-119`, plus the client-execution event):

  | `type` | Payload fields | Meaning |
  |---|---|---|
  | `message_start` | `messageId` | assistant turn begins |
  | `content_delta` | `delta` | streaming text chunk |
  | `tool_request` | `toolUseId`, `toolName`, `input`, `mutating` | **execute in the add-in** (spec §5 protocol step 1) |
  | `tool_result` | `toolUseId`, `output`, `isError` | server echo after resolution (informational) |
  | `message_end` | `inputTokens`, `outputTokens` | assistant turn done |
  | `error` | `message` | loop error, user-readable |
  | `done` | — | session loop idle |

- `POST /client-ai/sessions/:id/tool-results` body `{ "toolUseId": "...", "status": "success" | "error" | "rejected", "output": <any JSON> }` → 200. Server timeouts (spec §5): 60s reads, 5min pending write approvals — a late result after timeout 4xxes; the client surfaces but does not retry.
- `GET /client-ai/templates` → `200 [{ "id", "name", "description", "category", "body" }]` (`description`/`category` nullable). The client also tolerates the repo's `{ data: [...] }` envelope convention.

### CORS prerequisite (deployment, not code)

The API's CORS allowlist is env-driven (`CORS_ALLOWED_ORIGINS`, `apps/api/src/index.ts:256-307`; `Authorization` is already in `allowHeaders`). The add-in origin must be added: `https://localhost:3000` for dev, the production add-in host for prod. This is a deploy-time `.env` change, not a code change in this plan — verified in the manual checklist (Task 11, item 0).

## Deviations & open questions (decided during planning)

1. **D1 — Plan 2 does not exist yet.** The task prompt said to mirror `2026-06-12-ai-for-office-2-session-loop.md`; that file is not in the repo at planning time. The event vocabulary above is therefore pinned **here**, derived from the existing `AiStreamEvent` union that the spec says Plan 2 reuses (`SessionEventBus` pattern, spec §4) plus the prompt-pinned `tool_request` shape. **Reconciliation rule:** when Plan 2 is written/implemented, its SSE events MUST either adopt this table or this plan's `apps/office-addin/src/api/types.ts` (a single file — the only place event names appear) must be updated before integration testing. Unknown event types are skipped by the client, so additive Plan-2 events are safe.
2. **D2 — No `branding`/`org` in the exchange response.** Plan 1's implemented response is `{ accessToken, expiresInSeconds, user }` only. The spec §11 footer needs `branding.displayName`/`logoUrl` from org policy. The client types `org?` and `branding?` as optional on `ExchangeResponse` and the footer falls back to "Governed by your IT provider" when absent. **Open question for Plan 2/4 owners:** add `branding` (and optionally `org`) to the exchange 200 body — it's a one-line join on `client_ai_org_policies.branding` the route already loads via `getOrgPolicy`. Zero add-in changes needed when it lands.
3. **D3 — No `@breeze/shared` dependency.** The `/client-ai` wire contracts are not in `packages/shared` today (Plan 1 defined its zod schemas API-locally in `apps/api/src/routes/clientAi/schemas.ts`). The add-in defines its wire types locally in `src/api/types.ts` rather than importing `@breeze/shared` — there is nothing relevant to import, and skipping the dependency keeps the add-in's Vite/tsconfig free of the alias plumbing `apps/web` needs. If a later plan centralizes the client-AI contracts in `packages/shared`, adopt them via the same tsconfig-`paths` + vitest-`alias` pattern `apps/web` uses (`apps/web/tsconfig.json:6`, `apps/web/vitest.config.ts:10-13`).
4. **D4 — SSO API choice.** v1 uses the classic Office SSO API (`OfficeRuntime.auth.getAccessToken`, wired to the manifest's `WebApplicationInfo`) with an MSAL **popup** fallback, exactly as spec §3 describes. Migrating the fallback to NAA (`createNestablePublicClientApplication`) is a drop-in swap inside `src/auth/entraToken.ts` later; it changes no other file.
5. **D5 — `insert_formula` applies the same formula text to every cell** of the target range (Office.js does not rewrite relative references on assignment). Single-cell targets behave exactly as expected; for per-row formulas the model should call `insert_formula` per cell or use `write_range`. The tool description Plan 2 registers server-side should say so.
6. **D6 — No component-test framework.** The prompt's required unit-test list (SSE parser, dispatcher routing, executors, auth ordering, diff builder) is all framework-free logic; `@testing-library/react` is intentionally not added. React components are verified by `tsc`, the production build, and the manual checklist (Playwright cannot drive Excel — spec §13).

## Verification notes for workers

- Node pin: prefix every pnpm/vitest/node command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- After creating `apps/office-addin/package.json`, run `pnpm install` from the repo root once — the `apps/*` workspace glob picks the new app up automatically; **no `pnpm-workspace.yaml` change**.
- All add-in tests are new files in a new app — no interaction with the known-flaky parallel API suite. `pnpm --filter @breeze/office-addin test -- --run` is the whole verification surface.
- If a pinned devDependency version doesn't resolve (the `office-addin-*` packages move majors), fall back to `pnpm --filter @breeze/office-addin add -D <pkg>@latest` — this plan only uses their stable surfaces (`getHttpsServerOptions`, `office-addin-manifest validate`, the `office-addin-dev-certs install` CLI).
- HTTPS dev certs: first `pnpm dev` run may prompt for the OS keychain (cert install). Run `pnpm --filter @breeze/office-addin run certs` once interactively if the non-interactive prompt fails.
- Never commit `manifest.xml` (generated), `.env`, or `public/assets/*.png` (generated) — the app `.gitignore` created in Task 1 covers them. The CLAUDE.md no-internal-infra rule applies: templates and `.env.example` carry placeholders only.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/office-addin/package.json` | Create | App manifest: scripts, deps (React 19.2, msal-browser 4, vite 8, vitest 4) |
| `apps/office-addin/tsconfig.json` | Create | Strict TS, `office-js` + `vite/client` + `vitest/globals` types |
| `apps/office-addin/vite.config.ts` | Create | React plugin, https via office-addin-dev-certs, port 3000, taskpane.html input |
| `apps/office-addin/vitest.config.ts` | Create | jsdom, globals, setup file |
| `apps/office-addin/tailwind.config.js` + `postcss.config.js` | Create | Tailwind 3 (same approach as apps/helper) |
| `apps/office-addin/taskpane.html` | Create | Task-pane entry; Office.js CDN script tag |
| `apps/office-addin/src/index.css` | Create | Tailwind directives |
| `apps/office-addin/src/main.tsx` | Create | `Office.onReady` → React root |
| `apps/office-addin/src/config.ts` | Create | `VITE_API_BASE_URL` / `VITE_CLIENT_AI_ENTRA_CLIENT_ID` env access |
| `apps/office-addin/scripts/make-icons.mjs` | Create | Generates placeholder ribbon icons (valid PNGs, no binary in git) |
| `apps/office-addin/scripts/generate-manifest.mjs` | Create | `manifest.template.xml` + env → `manifest.xml` |
| `apps/office-addin/manifest.template.xml` | Create | Task-pane manifest with SSO `WebApplicationInfo`, placeholder tokens |
| `apps/office-addin/.env.example` + `.gitignore` | Create | Generic placeholders; ignore generated artifacts |
| `apps/office-addin/src/lib/address.ts` (+ `.test.ts`) | Create | A1-notation parsing/printing shared by tools, preview, mock |
| `apps/office-addin/src/__tests__/setup.ts` | Create | Installs Excel/Office globals per test |
| `apps/office-addin/src/__tests__/officeMock.ts` (+ `officeMock.test.ts`) | Create | Full Office.js Excel mock (workbook/worksheet/range/sync batching) |
| `apps/office-addin/src/api/types.ts` | Create | Wire types incl. `ClientAiStreamEvent` (the D1 single-source file) |
| `apps/office-addin/src/api/sse.ts` (+ `.test.ts`) | Create | Fetch-SSE ReadableStream parser |
| `apps/office-addin/src/api/client.ts` (+ `.test.ts`) | Create | Typed bearer client, 401 single-flight re-auth, `streamEvents` |
| `apps/office-addin/src/auth/entraToken.ts` (+ `.test.ts`) | Create | Office SSO → MSAL popup fallback |
| `apps/office-addin/src/auth/session.ts` (+ `.test.ts`) | Create | Exchange call, error mapping, memory+sessionStorage store, refresh |
| `apps/office-addin/src/tools/helpers.ts` | Create | Input validation + sheet resolution + caps |
| `apps/office-addin/src/tools/getWorkbookOverview.ts` (+ `.test.ts`) | Create | Tool: `get_workbook_overview` |
| `apps/office-addin/src/tools/readSelection.ts` | Create | Tool: `read_selection` |
| `apps/office-addin/src/tools/readRange.ts` (+ `.test.ts`) | Create | Tool: `read_range` |
| `apps/office-addin/src/tools/searchWorkbook.ts` (+ `.test.ts`) | Create | Tool: `search_workbook` |
| `apps/office-addin/src/tools/writeRange.ts` (+ `.test.ts`) | Create | Tool: `write_range` |
| `apps/office-addin/src/tools/insertFormula.ts` | Create | Tool: `insert_formula` |
| `apps/office-addin/src/tools/createSheet.ts` | Create | Tool: `create_sheet` |
| `apps/office-addin/src/tools/formatRange.ts` | Create | Tool: `format_range` |
| `apps/office-addin/src/tools/createTable.ts` | Create | Tool: `create_table` |
| `apps/office-addin/src/tools/dispatcher.ts` (+ `.test.ts`) | Create | Executor registry, mutating set, `executeTool` |
| `apps/office-addin/src/approval/buildPreview.ts` (+ `.test.ts`) | Create | Before/after diff builder (≤200 cells) + summary fallback |
| `apps/office-addin/src/approval/approvalStore.ts` (+ `.test.ts`) | Create | Pending-approval queue; Apply executes + posts, Reject posts without executing |
| `apps/office-addin/src/chat/chatController.ts` (+ `.test.ts`) | Create | SSE consumption, tool routing, approval queue, tool-result posting |
| `apps/office-addin/src/chat/captureContext.ts` | Create | Selection/sheet context capture for outgoing messages |
| `apps/office-addin/src/hooks/useSelectionAddress.ts` | Create | Live selection address via `DocumentSelectionChanged` |
| `apps/office-addin/src/components/WritePreviewCard.tsx` | Create | Apply/Reject preview card |
| `apps/office-addin/src/components/ChatThread.tsx` | Create | Message list + streaming cursor + approval cards |
| `apps/office-addin/src/components/Composer.tsx` | Create | Input, send, context chip + per-message toggle |
| `apps/office-addin/src/components/TemplatePicker.tsx` | Create | Empty-state template picker |
| `apps/office-addin/src/components/BrandingFooter.tsx` | Create | MSP-brandable footer |
| `apps/office-addin/src/components/SignInScreen.tsx` + `BlockedScreen.tsx` | Create | Auth screens incl. "not provisioned" |
| `apps/office-addin/src/components/ChatPane.tsx` | Create | Wires controller + composer + templates |
| `apps/office-addin/src/App.tsx` | Create (Task 1 stub, Task 10 real) | Auth phase machine |
| `apps/office-addin/README.md` | Create | Dev setup: certs, scripts, env, sideload pointers |

---

### Task 1: Scaffold — workspace app, Vite, Tailwind, entry html (verification, no TDD)

**Files:**
- Create: apps/office-addin/package.json
- Create: apps/office-addin/tsconfig.json
- Create: apps/office-addin/vite.config.ts
- Create: apps/office-addin/vitest.config.ts
- Create: apps/office-addin/tailwind.config.js
- Create: apps/office-addin/postcss.config.js
- Create: apps/office-addin/taskpane.html
- Create: apps/office-addin/src/index.css
- Create: apps/office-addin/src/main.tsx
- Create: apps/office-addin/src/App.tsx (placeholder — replaced in Task 12)
- Create: apps/office-addin/src/config.ts
- Create: apps/office-addin/scripts/make-icons.mjs
- Create: apps/office-addin/.env.example
- Create: apps/office-addin/.gitignore

- [ ] **Step 1: Create `apps/office-addin/package.json`**

```json
{
  "name": "@breeze/office-addin",
  "type": "module",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "predev": "node scripts/make-icons.mjs && node scripts/generate-manifest.mjs",
    "dev": "vite",
    "prebuild": "node scripts/make-icons.mjs",
    "build": "tsc --noEmit && vite build && node scripts/generate-manifest.mjs",
    "test": "vitest",
    "certs": "office-addin-dev-certs install",
    "manifest": "node scripts/generate-manifest.mjs",
    "validate-manifest": "office-addin-manifest validate manifest.xml"
  },
  "dependencies": {
    "@azure/msal-browser": "^4.0.0",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@types/office-js": "^1.0.460",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "autoprefixer": "^10.5.0",
    "jsdom": "^29.1.1",
    "office-addin-dev-certs": "^2.0.0",
    "office-addin-manifest": "^2.0.0",
    "postcss": "^8.5.15",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.2",
    "vite": "^8.0.12",
    "vitest": "^4.1.8"
  }
}
```

(React/TS/Tailwind/vitest versions mirror `apps/web/package.json`; vite + plugin-react mirror `apps/helper/package.json`. `generate-manifest.mjs` arrives in Task 2 — `predev`/`build` will fail on it until then, which is fine; Step 8 verifies with `vite build` directly.)

- [ ] **Step 2: Create `apps/office-addin/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "useDefineForClassFields": true,
    "types": ["office-js", "vite/client", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `apps/office-addin/vite.config.ts`**

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Office hosts refuse to load task panes over plain http (except localhost in
// some hosts, but Excel on the web always requires https). office-addin-dev-certs
// installs a locally-trusted CA + localhost cert (~/.office-addin-dev-certs) and
// getHttpsServerOptions() returns { ca, key, cert } for Vite. Set
// ADDIN_NO_HTTPS=1 to opt out (plain-browser debugging only).
export default defineConfig(async () => {
  let https: { ca: Buffer; key: Buffer; cert: Buffer } | undefined;
  if (!process.env.ADDIN_NO_HTTPS) {
    const { getHttpsServerOptions } = await import('office-addin-dev-certs');
    https = await getHttpsServerOptions();
  }
  return {
    plugins: [react()],
    server: { port: 3000, strictPort: true, https },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { taskpane: fileURLToPath(new URL('./taskpane.html', import.meta.url)) },
      },
    },
  };
});
```

- [ ] **Step 4: Create `apps/office-addin/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
```

(`src/__tests__/setup.ts` is created in Task 4; until then `vitest` is not run.)

- [ ] **Step 5: Create Tailwind + PostCSS configs and the entry CSS**

`apps/office-addin/tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./taskpane.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

`apps/office-addin/postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

`apps/office-addin/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 6: Create `taskpane.html`, `src/main.tsx`, placeholder `src/App.tsx`, `src/config.ts`**

`apps/office-addin/taskpane.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Breeze AI</title>
    <!-- Office.js MUST load from the Microsoft CDN (host requirement) and must
         not be bundled. It loads before the module script so Office.onReady is
         defined when main.tsx runs. -->
    <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/office-addin/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('taskpane.html is missing #root');
const root = createRoot(rootEl);

function render(): void {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Inside Excel, wait for the host handshake; in a plain browser tab (dev
// convenience, ADDIN_NO_HTTPS debugging) Office is undefined — render anyway.
if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  void Office.onReady(() => render());
} else {
  render();
}
```

`apps/office-addin/src/App.tsx` (placeholder — Task 12 replaces it):

```tsx
export function App() {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-gray-500">
      Breeze AI — scaffold OK
    </div>
  );
}
```

`apps/office-addin/src/config.ts`:

```ts
/**
 * Build-time configuration. Values come from Vite env (apps/office-addin/.env,
 * gitignored — see .env.example). Defaults target local dev against the API
 * dev server (apps/api listens on 3001; apps/web/astro.config.mjs uses the
 * same default).
 */
export const API_BASE_URL: string =
  ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3001').replace(/\/$/, '');

/** Entra app registration client ID — must equal the API's CLIENT_AI_ENTRA_CLIENT_ID (Plan 1 Task 6). */
export const ENTRA_CLIENT_ID: string =
  (import.meta.env.VITE_CLIENT_AI_ENTRA_CLIENT_ID as string | undefined) ?? '';
```

- [ ] **Step 7: Create `scripts/make-icons.mjs`, `.env.example`, `.gitignore`**

`apps/office-addin/scripts/make-icons.mjs` (the manifest needs 16/32/64/80px icons; generating valid solid-color PNGs at build time keeps binaries out of git):

```js
#!/usr/bin/env node
// Generates placeholder ribbon icons into public/assets/ as valid PNGs
// (hand-built chunks: IHDR + zlib IDAT + IEND). Replace with real brand
// icons later by dropping files at the same paths.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'assets');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // bytes 10-12 (compression/filter/interlace) stay 0
  const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB pixels
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BREEZE_BLUE = [37, 99, 235];
for (const size of [16, 32, 64, 80]) {
  writeFileSync(path.join(outDir, `icon-${size}.png`), png(size, BREEZE_BLUE));
}
console.log(`[make-icons] wrote icon-16/32/64/80.png to ${outDir}`);
```

`apps/office-addin/.env.example` (generic placeholders only — CLAUDE.md no-internal-infra rule):

```bash
# Breeze API origin the add-in calls. Local dev default shown.
VITE_API_BASE_URL=http://localhost:3001
# Entra app registration (multi-tenant) client ID. MUST match the API's
# CLIENT_AI_ENTRA_CLIENT_ID (apps/api .env, Plan 1 Task 6).
VITE_CLIENT_AI_ENTRA_CLIENT_ID=
# Where the built add-in is hosted; used by generate-manifest. Dev default shown.
ADDIN_BASE_URL=https://localhost:3000
# Optional overrides for generate-manifest:
# ADDIN_MANIFEST_ID=          # GUID identifying the add-in to Office (stable per environment)
# ADDIN_SUPPORT_URL=https://your-domain.example.com/support
```

`apps/office-addin/.gitignore`:

```
node_modules
dist
manifest.xml
public/assets/
.env
```

- [ ] **Step 8: Verify — install, icons, type-check, build, dev server**

```bash
cd /Users/toddhebebrand/breeze
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
cd apps/office-addin
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH node scripts/make-icons.mjs
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vite build
ls dist/taskpane.html dist/assets public/assets/icon-32.png
```

Expected: install links `@breeze/office-addin` into the workspace; tsc clean; vite build emits `dist/taskpane.html`; icons exist. Then smoke the dev server (https cert install may prompt once):

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vite --port 3000 &
sleep 3 && curl -sk https://localhost:3000/taskpane.html | grep -c 'office.js'
kill %1
```

Expected: grep prints `1` (taskpane served with the CDN script tag). If cert installation needs interactivity, run `ADDIN_NO_HTTPS=1 npx vite --port 3000` and curl `http://localhost:3000/taskpane.html` instead, then fix certs via `pnpm run certs` before Task 13.

- [ ] **Step 9: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin pnpm-lock.yaml
git commit -m "feat(office-addin): scaffold Vite+React task-pane app in workspace" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Manifest template + env-driven generator (verification, no TDD)

The manifest is XML the M365 admin center / sideload consumes. It is environment-specific (dev localhost vs production host), so the repo tracks a **template** with `{{TOKEN}}` placeholders and a generator script; the generated `manifest.xml` is gitignored.

**Entra app registration prerequisites (one-time, outside this repo — record in the PR description):** the multi-tenant app `CLIENT_AI_ENTRA_CLIENT_ID` needs (a) an SPA redirect URI `https://localhost:3000/taskpane.html` (plus the production equivalent), (b) an Application ID URI of the form `api://<host>/<client-id>` matching each hosting origin (dev: `api://localhost:3000/<client-id>`), (c) an exposed delegated scope `access_as_user`, and (d) the Microsoft Office client application `ea5a67f6-b6f3-4338-b240-c655ddc3cc8e` pre-authorized for that scope (this single ID covers all Office application endpoints). Without (d), silent SSO always falls back to the MSAL popup.

**Files:**
- Create: apps/office-addin/manifest.template.xml
- Create: apps/office-addin/scripts/generate-manifest.mjs

- [ ] **Step 1: Create `apps/office-addin/manifest.template.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>{{ADDIN_ID}}</Id>
  <Version>0.1.0</Version>
  <ProviderName>Breeze</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Breeze AI"/>
  <Description DefaultValue="AI assistant for Excel, governed by your IT provider."/>
  <IconUrl DefaultValue="{{BASE_URL}}/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="{{BASE_URL}}/assets/icon-64.png"/>
  <SupportUrl DefaultValue="{{SUPPORT_URL}}"/>
  <AppDomains>
    <AppDomain>{{API_BASE_URL}}</AppDomain>
    <AppDomain>https://login.microsoftonline.com</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Workbook"/>
  </Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="{{BASE_URL}}/taskpane.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Workbook">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Breeze.Group">
                <Label resid="Breeze.GroupLabel"/>
                <Icon>
                  <bt:Image size="16" resid="Breeze.Icon16"/>
                  <bt:Image size="32" resid="Breeze.Icon32"/>
                  <bt:Image size="80" resid="Breeze.Icon80"/>
                </Icon>
                <Control xsi:type="Button" id="Breeze.TaskpaneButton">
                  <Label resid="Breeze.TaskpaneButton.Label"/>
                  <Supertip>
                    <Title resid="Breeze.TaskpaneButton.Label"/>
                    <Description resid="Breeze.TaskpaneButton.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Breeze.Icon16"/>
                    <bt:Image size="32" resid="Breeze.Icon32"/>
                    <bt:Image size="80" resid="Breeze.Icon80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>Breeze.Taskpane</TaskpaneId>
                    <SourceLocation resid="Breeze.Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Breeze.Icon16" DefaultValue="{{BASE_URL}}/assets/icon-16.png"/>
        <bt:Image id="Breeze.Icon32" DefaultValue="{{BASE_URL}}/assets/icon-32.png"/>
        <bt:Image id="Breeze.Icon80" DefaultValue="{{BASE_URL}}/assets/icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Breeze.Taskpane.Url" DefaultValue="{{BASE_URL}}/taskpane.html"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Breeze.GroupLabel" DefaultValue="Breeze AI"/>
        <bt:String id="Breeze.TaskpaneButton.Label" DefaultValue="Breeze AI"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Breeze.TaskpaneButton.Tooltip" DefaultValue="Open the Breeze AI assistant for this workbook."/>
      </bt:LongStrings>
    </Resources>
    <WebApplicationInfo>
      <Id>{{CLIENT_AI_ENTRA_CLIENT_ID}}</Id>
      <Resource>api://{{BASE_HOST}}/{{CLIENT_AI_ENTRA_CLIENT_ID}}</Resource>
      <Scopes>
        <Scope>openid</Scope>
        <Scope>profile</Scope>
        <Scope>access_as_user</Scope>
      </Scopes>
    </WebApplicationInfo>
  </VersionOverrides>
</OfficeApp>
```

- [ ] **Step 2: Create `apps/office-addin/scripts/generate-manifest.mjs`**

```js
#!/usr/bin/env node
// Renders manifest.template.xml -> manifest.xml from env / .env / CLI flags.
//   node scripts/generate-manifest.mjs [--base-url https://localhost:3000] [--out manifest.xml]
// Precedence: process.env > .env file > defaults. Fails loudly on unreplaced tokens.
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

const baseUrl = (argValue('--base-url') ?? env.ADDIN_BASE_URL ?? 'https://localhost:3000').replace(/\/$/, '');
const apiBaseUrl = (env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const clientId = env.VITE_CLIENT_AI_ENTRA_CLIENT_ID ?? env.CLIENT_AI_ENTRA_CLIENT_ID ?? '00000000-0000-0000-0000-000000000000';
// Stable add-in identity GUID. Override per environment (dev vs prod must differ
// or Office caches collide across hosts).
const addinId = env.ADDIN_MANIFEST_ID ?? 'b7f3a9d2-4c61-4e0a-9f4e-2d8a51c0a9b3';
const supportUrl = env.ADDIN_SUPPORT_URL ?? 'https://breezermm.com';
const baseHost = new URL(baseUrl).host;

if (clientId === '00000000-0000-0000-0000-000000000000') {
  console.warn('[generate-manifest] WARNING: VITE_CLIENT_AI_ENTRA_CLIENT_ID is not set — SSO will not work with the placeholder GUID.');
}

const template = readFileSync(path.join(root, 'manifest.template.xml'), 'utf8');
const output = template
  .replaceAll('{{ADDIN_ID}}', addinId)
  .replaceAll('{{BASE_URL}}', baseUrl)
  .replaceAll('{{BASE_HOST}}', baseHost)
  .replaceAll('{{API_BASE_URL}}', apiBaseUrl)
  .replaceAll('{{SUPPORT_URL}}', supportUrl)
  .replaceAll('{{CLIENT_AI_ENTRA_CLIENT_ID}}', clientId);

const leftover = output.match(/{{[A-Z_]+}}/g);
if (leftover) {
  console.error(`[generate-manifest] Unreplaced placeholders: ${[...new Set(leftover)].join(', ')}`);
  process.exit(1);
}

const outPath = path.join(root, argValue('--out') ?? 'manifest.xml');
writeFileSync(outPath, output);
console.log(`[generate-manifest] wrote ${outPath} (base: ${baseUrl}, clientId: ${clientId.slice(0, 8)}…)`);
```

- [ ] **Step 3: Verify — generate and validate**

```bash
cd /Users/toddhebebrand/breeze/apps/office-addin
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH node scripts/generate-manifest.mjs
grep -c '{{' manifest.xml || true            # expected: 0 (no output from grep -c means grep exited 1 → zero matches)
grep -c 'api://localhost:3000' manifest.xml  # expected: 1
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx office-addin-manifest validate manifest.xml
```

Expected: zero unreplaced tokens; the `WebApplicationInfo` resource targets the dev host; the validator passes (warnings about the placeholder client-id GUID are acceptable at this stage — it validates GUID shape, not existence).

- [ ] **Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/manifest.template.xml apps/office-addin/scripts/generate-manifest.mjs
git commit -m "feat(office-addin): manifest template + env-driven generator with SSO WebApplicationInfo" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: A1-notation address utilities (TDD)

Shared by the tool executors (search hit addresses), the preview diff builder (per-cell addresses), and the Office.js mock (range geometry). Pure functions — the easiest TDD on the critical path, done first.

**Files:**
- Create: apps/office-addin/src/lib/address.ts
- Test: apps/office-addin/src/lib/address.test.ts

- [ ] **Step 1: Write the failing test** — `apps/office-addin/src/lib/address.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { columnLetter, parseAddress, parseColumn, rangeAddress, stripSheet } from './address';

describe('columnLetter / parseColumn', () => {
  it('round-trips single and multi letter columns', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
    for (const i of [0, 25, 26, 51, 701, 702, 16383]) {
      expect(parseColumn(columnLetter(i))).toBe(i);
    }
  });
});

describe('parseAddress', () => {
  it('parses a bare cell', () => {
    expect(parseAddress('B2')).toEqual({ sheet: null, startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
  });

  it('parses a range with sheet prefix', () => {
    expect(parseAddress('Sheet1!B2:F40')).toEqual({ sheet: 'Sheet1', startRow: 1, startCol: 1, endRow: 39, endCol: 5 });
  });

  it('parses a quoted sheet name and absolute refs', () => {
    expect(parseAddress("'Q3 Budget'!$A$1:$C$3")).toEqual({ sheet: 'Q3 Budget', startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
  });

  it('throws on garbage', () => {
    expect(() => parseAddress('not-an-address')).toThrow(/Unsupported address/);
    expect(() => parseAddress('')).toThrow(/Unsupported address/);
  });
});

describe('rangeAddress / stripSheet', () => {
  it('prints single cells without a colon', () => {
    expect(rangeAddress(1, 1, 1, 1)).toBe('B2');
  });

  it('prints multi-cell ranges', () => {
    expect(rangeAddress(1, 1, 39, 5)).toBe('B2:F40');
  });

  it('stripSheet drops the sheet prefix only', () => {
    expect(stripSheet('Sheet1!B2:F40')).toBe('B2:F40');
    expect(stripSheet('B2:F40')).toBe('B2:F40');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/lib/address.test.ts`
Expected: FAIL — cannot resolve `./address`. (vitest setupFiles does not exist yet; if vitest complains about the missing setup file, create an empty `src/__tests__/setup.ts` now — Task 4 fills it in.)

- [ ] **Step 3: Write the implementation** — `apps/office-addin/src/lib/address.ts`:

```ts
/**
 * A1-notation helpers. Rows/columns are 0-based internally; printed addresses
 * are 1-based like Excel. Only rectangular A1 references are supported (no
 * R1C1, no whole-column "A:A" shorthand) — that is all the tool protocol uses.
 */

export type ParsedAddress = {
  sheet: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseColumn(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

export function parseAddress(address: string): ParsedAddress {
  let sheet: string | null = null;
  let ref = address;
  const bang = address.lastIndexOf('!');
  if (bang !== -1) {
    sheet = address.slice(0, bang).replace(/^'(.*)'$/, '$1');
    ref = address.slice(bang + 1);
  }
  const [first, second, extra] = ref.split(':');
  if (extra !== undefined) throw new Error(`Unsupported address: ${address}`);
  const m1 = first !== undefined ? CELL_RE.exec(first) : null;
  if (!m1) throw new Error(`Unsupported address: ${address}`);
  const startCol = parseColumn(m1[1]!);
  const startRow = parseInt(m1[2]!, 10) - 1;
  if (second === undefined) return { sheet, startRow, startCol, endRow: startRow, endCol: startCol };
  const m2 = CELL_RE.exec(second);
  if (!m2) throw new Error(`Unsupported address: ${address}`);
  const endCol = parseColumn(m2[1]!);
  const endRow = parseInt(m2[2]!, 10) - 1;
  return {
    sheet,
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}

/** 0-based start row/col + extent → "B2" or "B2:F40". */
export function rangeAddress(startRow: number, startCol: number, rows: number, cols: number): string {
  const start = `${columnLetter(startCol)}${startRow + 1}`;
  if (rows === 1 && cols === 1) return start;
  return `${start}:${columnLetter(startCol + cols - 1)}${startRow + rows}`;
}

export function stripSheet(address: string): string {
  const bang = address.lastIndexOf('!');
  return bang === -1 ? address : address.slice(bang + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/lib/address.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/lib
git commit -m "feat(office-addin): A1-notation address utilities" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Contract reconciliation — Plan 2 now exists (supersedes the §2 event table above)

> Written when Tasks 4+ were planned: `docs/superpowers/plans/ai-mcp/2026-06-12-ai-for-office-2-session-loop.md` now exists in the repo, which resolves Deviation D1 in Plan 2's favor. The "Session loop" table in *Pinned server contracts §2* above (message_start/content_delta/tool_result/message_end/error/done, "data JSON includes type") is **obsolete — do not implement it**. Tasks 4–11 below implement the contracts as Plan 2 actually pins them:

- **SSE event names** (`CLIENT_AI_SSE_EVENTS`, Plan 2 Task 9, `apps/api/src/routes/clientAi/sse.ts`). Frames are `event: <name>` + `data: <JSON>`; the data JSON does **not** repeat the type — the client discriminates on the SSE `event:` field and skips unknown names (additive server events stay safe):

  | `event:` | data payload |
  |---|---|
  | `message_delta` | `{ "text": string }` |
  | `tool_request` | `{ "toolUseId", "toolName", "input", "mutating" }` |
  | `tool_completed` | `{ "toolUseId", "toolName", "status": "success"\|"error"\|"rejected"\|"timeout", "redactions": [{rule,count,location}], "blockReason": string\|null }` |
  | `turn_complete` | `{ "usage": { "inputTokens", "outputTokens", "costCents" } \| null }` |
  | `session_error` | `{ "message": string }` |
  | `ping` | `{}` every 25s (server keepalive) |

- `POST /client-ai/sessions` body `{}` → **201** `{ "sessionId": "<uuid>" }` (not 200 — client accepts any 2xx).
- `POST /client-ai/sessions/:id/messages` body `{ content: string (1..20000), workbookContext?: { kind: 'selection'|'sheet'|'none', address?: ≤100 chars, sheetName?: ≤255 chars, cells?: CellValue[][] (≤5000 rows × ≤500 cols, strings ≤32767 chars) } }` → **202** `{ "accepted": true }`; the turn streams over the persistent `GET /events` channel. Budget/rate rejections are 4xx `{ error }` (`budget_exceeded`, `rate_limited`, …).
- `GET /client-ai/sessions/:id/events` — SSE; fetch + `Authorization` header primary, GET-only `?token=` exists server-side as the EventSource fallback (this client never uses it). **The events GET creates the active server session if absent**, so connecting right after create has no race.
- `POST /client-ai/sessions/:id/tool-results` body `{ toolUseId, status: 'success'|'error'|'rejected', output?: any }` → 200. Late results after server timeout (60s reads / 300s writes) 4xx; surface, don't retry.
- `GET /client-ai/sessions/:id` → `{ session: { id, status, title, model, turnCount, totalInputTokens, totalOutputTokens, totalCostCents, createdAt, lastActivityAt }, messages: [{ id, role, content, contentBlocks, toolName, toolInput, toolOutput, toolUseId, createdAt }] }` (history is stored already-redacted; render as-is).
- `POST /client-ai/sessions/:id/close` → `{ success: true }`.
- `GET /client-ai/templates` → **bare JSON array** `[{ id, name, description, category, body }]` (Plan 4 pins the bare array deliberately; the client still tolerates a `{ data: [...] }` envelope defensively).
- Exchange (Plan 1) is unchanged from §1 above: 200 `{ accessToken, expiresInSeconds, user: { id, email, name } }`, audience = bare `CLIENT_AI_ENTRA_CLIENT_ID` GUID, no `org`/`branding` yet (D2 stands — typed optional client-side).

---

### Task 4: Office.js test mock (TDD — the mock gets its own spec test)

The foundation for every tool/preview/context test: a hand-rolled fake of the Office.js proxy-object model. `Excel.run` executes the callback against a fake context whose ranges queue writes, record `load()` calls, and only expose property reads after `context.sync()` — the same lifecycle discipline the real API enforces, so tests catch missing `load`/`sync` bugs.

**Files:**
- Create: apps/office-addin/src/__tests__/officeMock.ts
- Create: apps/office-addin/src/__tests__/setup.ts
- Test: apps/office-addin/src/__tests__/officeMock.test.ts

- [ ] **Step 1: Write the failing test** — `apps/office-addin/src/__tests__/officeMock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOfficeMock } from './officeMock';

describe('officeMock — Excel.run lifecycle', () => {
  it('queues writes until sync and reads values back after load+sync', async () => {
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getActiveWorksheet().getRange('B2:C3');
      range.values = [
        ['Region', 'Q1'],
        ['EMEA', 1200],
      ];
      range.load(['values', 'address']);
      await context.sync();
      expect(range.address).toBe('Sheet1!B2:C3');
      expect(range.values).toEqual([
        ['Region', 'Q1'],
        ['EMEA', 1200],
      ]);
    });
    expect(getOfficeMock().getValues('Sheet1', 'B2:C3')).toEqual([
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
  });

  it('throws when reading a property before context.sync()', async () => {
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getActiveWorksheet().getRange('A1');
      range.load('values');
      expect(() => range.values).toThrow(/PropertyNotLoaded/);
      await context.sync();
      expect(range.values).toEqual([['']]);
    });
  });

  it('computes the used range with sheet-qualified addresses', async () => {
    getOfficeMock().setValues('Sheet1', 'B2', [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    await Excel.run(async (context) => {
      const used = context.workbook.worksheets.getActiveWorksheet().getUsedRangeOrNullObject();
      used.load(['address', 'values']);
      await context.sync();
      expect(used.isNullObject).toBe(false);
      expect(used.address).toBe('Sheet1!B2:C3');
    });
  });

  it('returns a null object for the used range of an empty sheet', async () => {
    getOfficeMock().addSheet('Empty');
    await Excel.run(async (context) => {
      const used = context.workbook.worksheets.getItemOrNullObject('Empty').getUsedRangeOrNullObject();
      used.load('address');
      await context.sync();
      expect(used.isNullObject).toBe(true);
    });
  });

  it('getRow(0) of a used range exposes the header row', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [
      ['Name', 'Total'],
      ['x', 1],
    ]);
    await Excel.run(async (context) => {
      const used = context.workbook.worksheets.getActiveWorksheet().getUsedRangeOrNullObject();
      const header = used.getRow(0);
      header.load('values');
      await context.sync();
      expect(header.values).toEqual([['Name', 'Total']]);
    });
  });

  it('worksheet collection: items, add, getItemOrNullObject', async () => {
    getOfficeMock().addSheet('Data');
    await Excel.run(async (context) => {
      const worksheets = context.workbook.worksheets;
      worksheets.load('items/name');
      await context.sync();
      expect(worksheets.items.map((s) => s.name)).toEqual(['Sheet1', 'Data']);
      const missing = worksheets.getItemOrNullObject('Nope');
      await context.sync();
      expect(missing.isNullObject).toBe(true);
      const added = worksheets.add('Report');
      await context.sync();
      expect(added.name).toBe('Report');
      expect(getOfficeMock().hasSheet('Report')).toBe(true);
    });
  });

  it('selection: getSelectedRange reflects state and select() fires handlers', async () => {
    const mock = getOfficeMock();
    const seen: string[] = [];
    Office.context.document.addHandlerAsync(
      Office.EventType.DocumentSelectionChanged,
      () => seen.push('changed'),
      () => undefined,
    );
    mock.select('Sheet1!B2:F40');
    expect(seen).toEqual(['changed']);
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load(['address', 'rowCount', 'columnCount']);
      await context.sync();
      expect(range.address).toBe('Sheet1!B2:F40');
      expect(range.rowCount).toBe(39);
      expect(range.columnCount).toBe(5);
    });
  });

  it('records load and sync calls for assertions', async () => {
    const mock = getOfficeMock();
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getActiveWorksheet().getRange('A1:B2');
      range.load('values');
      await context.sync();
    });
    expect(mock.loadCalls.length).toBeGreaterThan(0);
    expect(mock.syncCount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/__tests__/officeMock.test.ts`
Expected: FAIL — `./officeMock` does not exist (and vitest may first complain the setup file `src/__tests__/setup.ts` is missing; create it in Step 3 along with the mock).

- [ ] **Step 3: Write the mock** — `apps/office-addin/src/__tests__/officeMock.ts`:

```ts
/**
 * Hand-rolled Office.js mock (jsdom). Installed fresh per test by
 * src/__tests__/setup.ts; tests seed and inspect workbook state via
 * getOfficeMock().
 *
 * Faithfulness contract (the parts of the real proxy-object model the tools
 * rely on, deliberately enforced so missing load()/sync() bugs fail tests):
 *  - property reads on a Range THROW until a context.sync() has hydrated them
 *  - property writes (range.values = ...) are queued and applied at sync()
 *  - *OrNullObject lookups expose isNullObject; null objects propagate
 *  - Excel.run() performs one trailing sync after the callback returns
 * Documented leniencies (do NOT rely on these in src/ production code):
 *  - Worksheet.name is always readable without load()
 *  - worksheets.getItem() throws immediately instead of at sync
 */
import { vi } from 'vitest';
import { parseAddress, rangeAddress, stripSheet } from '../lib/address';

export type CellValue = string | number | boolean | null;
type Rect = { startRow: number; startCol: number; rows: number; cols: number };

const key = (row: number, col: number): string => `${row},${col}`;

function rectOf(address: string): Rect {
  const p = parseAddress(stripSheet(address));
  return {
    startRow: p.startRow,
    startCol: p.startCol,
    rows: p.endRow - p.startRow + 1,
    cols: p.endCol - p.startCol + 1,
  };
}

export class MockSheetState {
  cells = new Map<string, CellValue>();
  formulas = new Map<string, string>();
  formats = new Map<string, Record<string, unknown>>();

  constructor(public name: string) {}

  setValues(anchor: string, values: CellValue[][]): void {
    const { startRow, startCol } = parseAddress(stripSheet(anchor));
    values.forEach((row, r) =>
      row.forEach((value, c) => this.cells.set(key(startRow + r, startCol + c), value)),
    );
  }

  getValues(rect: Rect): CellValue[][] {
    return Array.from({ length: rect.rows }, (_, r) =>
      Array.from(
        { length: rect.cols },
        (_, c) => this.cells.get(key(rect.startRow + r, rect.startCol + c)) ?? '',
      ),
    );
  }

  getFormulas(rect: Rect): string[][] {
    return Array.from({ length: rect.rows }, (_, r) =>
      Array.from({ length: rect.cols }, (_, c) => {
        const k = key(rect.startRow + r, rect.startCol + c);
        return this.formulas.get(k) ?? String(this.cells.get(k) ?? '');
      }),
    );
  }

  mergeFormat(rect: Rect, patch: Record<string, unknown>): void {
    for (let r = 0; r < rect.rows; r++) {
      for (let c = 0; c < rect.cols; c++) {
        const k = key(rect.startRow + r, rect.startCol + c);
        this.formats.set(k, { ...this.formats.get(k), ...patch });
      }
    }
  }

  /** Effective format of a single cell, e.g. formatAt('B2'). */
  formatAt(cellAddress: string): Record<string, unknown> | undefined {
    const p = parseAddress(stripSheet(cellAddress));
    return this.formats.get(key(p.startRow, p.startCol));
  }

  usedRect(): Rect | null {
    let minR = Infinity;
    let minC = Infinity;
    let maxR = -1;
    let maxC = -1;
    for (const k of [...this.cells.keys(), ...this.formulas.keys()]) {
      const [r, c] = k.split(',').map(Number) as [number, number];
      if (r < minR) minR = r;
      if (c < minC) minC = c;
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    if (maxR === -1) return null;
    return { startRow: minR, startCol: minC, rows: maxR - minR + 1, cols: maxC - minC + 1 };
  }
}

export class MockWorkbookState {
  sheets: MockSheetState[] = [new MockSheetState('Sheet1')];
  activeSheetName = 'Sheet1';
  /** Sheet-qualified selection, e.g. 'Sheet1!B2:F40'. */
  selectionAddress = 'Sheet1!A1';
  tables: Array<{ name: string; address: string; hasHeaders: boolean }> = [];
  loadCalls: Array<{ target: string; props: unknown }> = [];
  syncCount = 0;
  selectionHandlers: Array<() => void> = [];

  sheet(name: string): MockSheetState {
    const found = this.sheets.find((s) => s.name === name);
    if (!found) throw new Error(`ItemNotFound: ${name}`);
    return found;
  }

  hasSheet(name: string): boolean {
    return this.sheets.some((s) => s.name === name);
  }

  addSheet(name: string): MockSheetState {
    if (this.hasSheet(name)) throw new Error(`InvalidArgument: sheet "${name}" already exists`);
    const sheet = new MockSheetState(name);
    this.sheets.push(sheet);
    return sheet;
  }

  setValues(sheetName: string, anchor: string, values: CellValue[][]): void {
    this.sheet(sheetName).setValues(anchor, values);
  }

  getValues(sheetName: string, address: string): CellValue[][] {
    return this.sheet(sheetName).getValues(rectOf(address));
  }

  select(address: string): void {
    this.selectionAddress = address.includes('!')
      ? address
      : `${this.activeSheetName}!${address}`;
    this.fireSelectionChanged();
  }

  fireSelectionChanged(): void {
    for (const handler of [...this.selectionHandlers]) handler();
  }
}

type Syncable = { _sync(): void };

class MockContext {
  private tracked: Syncable[] = [];
  readonly workbook: MockWorkbook;

  constructor(readonly state: MockWorkbookState) {
    this.workbook = new MockWorkbook(this);
  }

  track<T extends Syncable>(obj: T): T {
    this.tracked.push(obj);
    return obj;
  }

  sync = async (): Promise<void> => {
    this.state.syncCount += 1;
    for (const obj of [...this.tracked]) obj._sync();
  };
}

class MockRange implements Syncable {
  isNullObject: boolean;
  readonly format: { fill: { color: string }; font: { bold: boolean; italic: boolean; color: string } };
  private hydrated = false;
  private pendingValues: CellValue[][] | null = null;
  private pendingFormulas: string[][] | null = null;
  private pendingNumberFormat: string[][] | null = null;
  private pendingFormat: Record<string, unknown> = {};
  private _values: CellValue[][] = [];
  private _formulas: string[][] = [];
  private _address = '';

  constructor(
    private ctx: MockContext,
    private sheetState: MockSheetState | null,
    private rect: Rect | null,
  ) {
    this.isNullObject = sheetState === null || rect === null;
    const setterObj = <T extends object>(map: Record<string, string>): T => {
      const obj = {} as T;
      for (const [prop, formatKey] of Object.entries(map)) {
        Object.defineProperty(obj, prop, {
          set: (v: unknown) => {
            this.pendingFormat[formatKey] = v;
          },
        });
      }
      return obj;
    };
    this.format = {
      fill: setterObj<{ color: string }>({ color: 'fillColor' }),
      font: setterObj<{ bold: boolean; italic: boolean; color: string }>({
        bold: 'bold',
        italic: 'italic',
        color: 'fontColor',
      }),
    };
    ctx.track(this);
  }

  load(props: unknown): this {
    const target = this.isNullObject
      ? 'range:null'
      : `range:${this.sheetState!.name}!${rangeAddress(this.rect!.startRow, this.rect!.startCol, this.rect!.rows, this.rect!.cols)}`;
    this.ctx.state.loadCalls.push({ target, props });
    return this;
  }

  getRow(index: number): MockRange {
    if (this.isNullObject) return new MockRange(this.ctx, null, null);
    const r = this.rect!;
    if (index < 0 || index >= r.rows) throw new Error('InvalidArgument: row index out of range');
    return new MockRange(this.ctx, this.sheetState, {
      startRow: r.startRow + index,
      startCol: r.startCol,
      rows: 1,
      cols: r.cols,
    });
  }

  private read<T>(prop: string, value: T): T {
    if (!this.hydrated)
      throw new Error(`PropertyNotLoaded: Range.${prop} read before context.sync()`);
    return value;
  }

  get values(): CellValue[][] {
    return this.read('values', this._values);
  }
  set values(v: CellValue[][]) {
    this.pendingValues = v;
  }

  get formulas(): string[][] {
    return this.read('formulas', this._formulas);
  }
  set formulas(v: string[][]) {
    this.pendingFormulas = v;
  }

  set numberFormat(v: string[][]) {
    this.pendingNumberFormat = v;
  }

  get address(): string {
    return this.read('address', this._address);
  }
  get rowCount(): number {
    return this.read('rowCount', this.rect?.rows ?? 0);
  }
  get columnCount(): number {
    return this.read('columnCount', this.rect?.cols ?? 0);
  }

  _sync(): void {
    if (this.isNullObject) {
      this.hydrated = true;
      return;
    }
    const sheet = this.sheetState!;
    const rect = this.rect!;
    if (this.pendingValues) {
      if (
        this.pendingValues.length !== rect.rows ||
        (this.pendingValues[0]?.length ?? 0) !== rect.cols
      ) {
        throw new Error(
          `InvalidArgument: values is ${this.pendingValues.length}x${this.pendingValues[0]?.length ?? 0} but the range is ${rect.rows}x${rect.cols}`,
        );
      }
      this.pendingValues.forEach((row, r) =>
        row.forEach((v, c) => {
          const k = key(rect.startRow + r, rect.startCol + c);
          sheet.cells.set(k, v);
          sheet.formulas.delete(k);
        }),
      );
      this.pendingValues = null;
    }
    if (this.pendingFormulas) {
      this.pendingFormulas.forEach((row, r) =>
        row.forEach((f, c) => {
          const k = key(rect.startRow + r, rect.startCol + c);
          sheet.formulas.set(k, f);
          sheet.cells.set(k, f); // mock: the "calculated value" mirrors the formula text
        }),
      );
      this.pendingFormulas = null;
    }
    if (this.pendingNumberFormat) {
      sheet.mergeFormat(rect, { numberFormat: this.pendingNumberFormat[0]?.[0] ?? '' });
      this.pendingNumberFormat = null;
    }
    if (Object.keys(this.pendingFormat).length > 0) {
      sheet.mergeFormat(rect, this.pendingFormat);
      this.pendingFormat = {};
    }
    this._values = sheet.getValues(rect);
    this._formulas = sheet.getFormulas(rect);
    this._address = `${sheet.name}!${rangeAddress(rect.startRow, rect.startCol, rect.rows, rect.cols)}`;
    this.hydrated = true;
  }
}

class MockWorksheet implements Syncable {
  isNullObject: boolean;

  constructor(
    private ctx: MockContext,
    private sheetState: MockSheetState | null,
  ) {
    this.isNullObject = sheetState === null;
    ctx.track(this);
  }

  /** Leniency: readable without load(). */
  get name(): string {
    return this.sheetState?.name ?? '';
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: `worksheet:${this.name || 'null'}`, props });
    return this;
  }

  getRange(address: string): MockRange {
    if (!this.sheetState) throw new Error('ItemNotFound: getRange on a null worksheet');
    return new MockRange(this.ctx, this.sheetState, rectOf(address));
  }

  getUsedRange(): MockRange {
    return this.getUsedRangeOrNullObject();
  }

  getUsedRangeOrNullObject(): MockRange {
    if (!this.sheetState) return new MockRange(this.ctx, null, null);
    const rect = this.sheetState.usedRect();
    return rect
      ? new MockRange(this.ctx, this.sheetState, rect)
      : new MockRange(this.ctx, null, null);
  }

  _sync(): void {
    /* name is always readable; nothing to hydrate */
  }
}

class MockWorksheetCollection implements Syncable {
  private _items: MockWorksheet[] | null = null;

  constructor(private ctx: MockContext) {
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'worksheets', props });
    return this;
  }

  get items(): MockWorksheet[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: WorksheetCollection.items read before context.sync()');
    return this._items;
  }

  getActiveWorksheet(): MockWorksheet {
    return new MockWorksheet(this.ctx, this.ctx.state.sheet(this.ctx.state.activeSheetName));
  }

  /** Leniency: throws immediately instead of at sync. */
  getItem(name: string): MockWorksheet {
    return new MockWorksheet(this.ctx, this.ctx.state.sheet(name));
  }

  getItemOrNullObject(name: string): MockWorksheet {
    const found = this.ctx.state.sheets.find((s) => s.name === name) ?? null;
    return new MockWorksheet(this.ctx, found);
  }

  add(name: string): MockWorksheet {
    return new MockWorksheet(this.ctx, this.ctx.state.addSheet(name));
  }

  _sync(): void {
    this._items = this.ctx.state.sheets.map((s) => new MockWorksheet(this.ctx, s));
  }
}

class MockTable {
  constructor(public name: string) {}
  load(_props: unknown): this {
    return this;
  }
  set style(_v: string) {
    /* accepted, not modelled */
  }
}

class MockTableCollection {
  constructor(private ctx: MockContext) {}

  add(address: string, hasHeaders: boolean): MockTable {
    const state = this.ctx.state;
    const sheetName = parseAddress(address).sheet ?? state.activeSheetName;
    state.sheet(sheetName); // validates the sheet exists
    const name = `Table${state.tables.length + 1}`;
    state.tables.push({ name, address, hasHeaders });
    return new MockTable(name);
  }
}

class MockWorkbook {
  readonly worksheets: MockWorksheetCollection;
  readonly tables: MockTableCollection;

  constructor(private ctx: MockContext) {
    this.worksheets = new MockWorksheetCollection(ctx);
    this.tables = new MockTableCollection(ctx);
  }

  getSelectedRange(): MockRange {
    const address = this.ctx.state.selectionAddress;
    const sheetName = parseAddress(address).sheet ?? this.ctx.state.activeSheetName;
    return new MockRange(this.ctx, this.ctx.state.sheet(sheetName), rectOf(address));
  }
}

let current: MockWorkbookState | null = null;

export function installOfficeMock(): MockWorkbookState {
  const state = new MockWorkbookState();
  current = state;
  const g = globalThis as Record<string, unknown>;
  g.Excel = {
    run: async <T>(callback: (context: unknown) => Promise<T>): Promise<T> => {
      const context = new MockContext(state);
      const result = await callback(context);
      await context.sync(); // Excel.run always performs a trailing sync
      return result;
    },
  };
  g.Office = {
    onReady: (cb?: (info: { host: string; platform: string }) => void) => {
      const info = { host: 'Excel', platform: 'Mock' };
      cb?.(info);
      return Promise.resolve(info);
    },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    context: {
      document: {
        addHandlerAsync: (
          _type: string,
          handler: () => void,
          done?: (result: { status: string }) => void,
        ) => {
          state.selectionHandlers.push(handler);
          done?.({ status: 'succeeded' });
        },
      },
    },
  };
  g.OfficeRuntime = { auth: { getAccessToken: vi.fn(async () => 'mock-entra-access-token') } };
  return state;
}

export function getOfficeMock(): MockWorkbookState {
  if (!current)
    throw new Error('installOfficeMock() has not run — is src/__tests__/setup.ts configured?');
  return current;
}
```

And `apps/office-addin/src/__tests__/setup.ts`:

```ts
import { beforeEach } from 'vitest';
import { installOfficeMock } from './officeMock';

beforeEach(() => {
  installOfficeMock();
  sessionStorage.clear();
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/__tests__/officeMock.test.ts`
Expected: 8 tests PASS. Also re-run the address suite to confirm the setup file didn't break it: `npx vitest run src/lib/address.test.ts` (8 PASS).

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/__tests__
git commit -m "test(office-addin): Office.js Excel mock with load/sync lifecycle enforcement" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Auth — Office SSO → MSAL fallback → Breeze exchange (TDD)

Two modules: `entraToken.ts` (silent `OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: false })` → `@azure/msal-browser` popup fallback) and `session.ts` (the `POST /client-ai/auth/exchange` call, error-code → block-kind mapping, memory + sessionStorage store, single-flight re-exchange for 401s). Plus the `BlockedScreen` component the error kinds map onto (presentational — verified by tsc per D6).

The MSAL scope is `api://<host>/<CLIENT_AI_ENTRA_CLIENT_ID>/access_as_user` — the same Application ID URI the manifest's `WebApplicationInfo` declares (Task 2). The Entra app registration must be configured for **v2.0 access tokens** (`requestedAccessTokenVersion: 2`) so the token's `aud` is the bare client-id GUID, which is exactly what Plan 1's `verifyEntraIdToken` pins (`audience: CLIENT_AI_ENTRA_CLIENT_ID`). Record this alongside the Task 2 registration prerequisites.

**Files:**
- Create: apps/office-addin/src/auth/entraToken.ts
- Create: apps/office-addin/src/auth/session.ts
- Create: apps/office-addin/src/components/BlockedScreen.tsx
- Test: apps/office-addin/src/auth/entraToken.test.ts
- Test: apps/office-addin/src/auth/session.test.ts

- [ ] **Step 1: Write the failing tests**

`apps/office-addin/src/auth/entraToken.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getEntraTokenInteractive, getEntraTokenSilent, type EntraTokenDeps } from './entraToken';

function deps(overrides: Partial<EntraTokenDeps> = {}): EntraTokenDeps {
  return {
    getSsoToken: vi.fn(async () => 'sso-token'),
    getMsalToken: vi.fn(async () => 'msal-token'),
    ...overrides,
  };
}

describe('getEntraTokenInteractive — fallback ordering', () => {
  it('returns the Office SSO token without touching MSAL when SSO succeeds', async () => {
    const d = deps();
    await expect(getEntraTokenInteractive(d)).resolves.toBe('sso-token');
    expect(d.getMsalToken).not.toHaveBeenCalled();
  });

  it('falls back to the MSAL popup when Office SSO fails', async () => {
    const d = deps({ getSsoToken: vi.fn(async () => Promise.reject(new Error('13001'))) });
    await expect(getEntraTokenInteractive(d)).resolves.toBe('msal-token');
    expect(d.getMsalToken).toHaveBeenCalledTimes(1);
  });
});

describe('getEntraTokenSilent', () => {
  it('never opens MSAL — rejects when SSO fails', async () => {
    const d = deps({ getSsoToken: vi.fn(async () => Promise.reject(new Error('13001'))) });
    await expect(getEntraTokenSilent(d)).rejects.toThrow('13001');
    expect(d.getMsalToken).not.toHaveBeenCalled();
  });
});
```

`apps/office-addin/src/auth/session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthBlockedError,
  InvalidEntraTokenError,
  __resetSessionForTests,
  clearSession,
  getSessionToken,
  getStoredSession,
  reExchange,
  signIn,
} from './session';
import type { EntraTokenDeps } from './entraToken';

const OK_BODY = {
  accessToken: 'breeze-session-token-48ch',
  expiresInSeconds: 86400,
  user: { id: 'u-1', email: 'finance.user@contoso.com', name: 'Finance User' },
};

function entra(token = 'entra-token'): EntraTokenDeps {
  return { getSsoToken: vi.fn(async () => token), getMsalToken: vi.fn(async () => token) };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetSessionForTests();
});

describe('signIn', () => {
  it('exchanges the Entra token and stores the session in memory + sessionStorage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const session = await signIn({ interactive: false }, { entra: entra(), fetchImpl });
    expect(session.user.email).toBe('finance.user@contoso.com');
    expect(getSessionToken()).toBe('breeze-session-token-48ch');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/client-ai/auth/exchange');
    expect(JSON.parse(init.body as string)).toEqual({ accessToken: 'entra-token' });
    expect(sessionStorage.getItem('breeze-client-ai-session')).toContain('breeze-session-token-48ch');
  });

  it('maps exchange error codes to block kinds', async () => {
    const cases: Array<[number, string, string]> = [
      [404, 'tenant_not_provisioned', 'not_provisioned'],
      [404, 'not_enabled', 'not_provisioned'],
      [403, 'disabled', 'disabled'],
      [403, 'user_not_permitted', 'user_not_permitted'],
      [403, 'account_inactive', 'account_inactive'],
      [403, 'provisioning_failed', 'retryable'],
      [429, 'rate_limited', 'retryable'],
      [503, 'service_unavailable', 'retryable'],
    ];
    for (const [status, code, kind] of cases) {
      __resetSessionForTests();
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: code }));
      const err = await signIn({ interactive: false }, { entra: entra(), fetchImpl }).catch(
        (e: unknown) => e,
      );
      expect(err, code).toBeInstanceOf(AuthBlockedError);
      expect((err as AuthBlockedError).kind, code).toBe(kind);
      expect((err as AuthBlockedError).errorCode, code).toBe(code);
    }
  });

  it('on 401 invalid_token clears state and retries once with a fresh Entra token', async () => {
    const entraDeps = entra();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const session = await signIn({ interactive: false }, { entra: entraDeps, fetchImpl });
    expect(session.user.id).toBe('u-1');
    expect(entraDeps.getSsoToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates InvalidEntraTokenError when the retry also 401s', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'invalid_token' }));
    await expect(
      signIn({ interactive: false }, { entra: entra(), fetchImpl }),
    ).rejects.toBeInstanceOf(InvalidEntraTokenError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('reExchange', () => {
  it('is single-flight: concurrent callers share one exchange', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const p1 = reExchange({ entra: entra(), fetchImpl });
    const p2 = reExchange({ entra: entra(), fetchImpl });
    resolveFetch(jsonResponse(200, OK_BODY));
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1.sessionToken).toBe(s2.sessionToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('session store', () => {
  it('restores from sessionStorage and rejects expired entries', () => {
    sessionStorage.setItem(
      'breeze-client-ai-session',
      JSON.stringify({
        sessionToken: 'tok',
        expiresAt: Date.now() + 60_000,
        user: OK_BODY.user,
        org: null,
        branding: null,
      }),
    );
    expect(getStoredSession()?.sessionToken).toBe('tok');
    __resetSessionForTests();
    sessionStorage.setItem(
      'breeze-client-ai-session',
      JSON.stringify({
        sessionToken: 'tok',
        expiresAt: Date.now() - 1,
        user: OK_BODY.user,
        org: null,
        branding: null,
      }),
    );
    expect(getStoredSession()).toBeNull();
  });

  it('clearSession wipes memory and sessionStorage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    await signIn({ interactive: false }, { entra: entra(), fetchImpl });
    clearSession();
    expect(getSessionToken()).toBeNull();
    expect(sessionStorage.getItem('breeze-client-ai-session')).toBeNull();
  });
});
```

(`__resetSessionForTests` clears the in-memory cache WITHOUT touching sessionStorage — `clearSession` does both; the restore test needs them separate.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/auth`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`apps/office-addin/src/auth/entraToken.ts`:

```ts
/**
 * Entra ID access-token acquisition (spec §3):
 *   1. Office SSO — OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: false }).
 *      Works when the MSP centrally deployed the add-in and pre-authorized the
 *      Office client app (Task 2 prerequisite d). Silent, no UI ever.
 *   2. MSAL popup fallback — first-run consent / sideload / SSO error path.
 *      Popups must originate from a user gesture, so the silent boot path
 *      (App.tsx) uses getEntraTokenSilent and only the sign-in button uses
 *      getEntraTokenInteractive.
 * D4: swapping the fallback to NAA (createNestablePublicClientApplication)
 * later only touches this file.
 */
import { ENTRA_CLIENT_ID } from '../config';

export type EntraTokenDeps = {
  getSsoToken: () => Promise<string>;
  getMsalToken: () => Promise<string>;
};

/** Scope on the add-in's own app registration (matches the manifest's WebApplicationInfo Resource). */
export function msalScopes(): string[] {
  return [`api://${window.location.host}/${ENTRA_CLIENT_ID}/access_as_user`];
}

async function officeSsoToken(): Promise<string> {
  const officeRuntime = (
    globalThis as {
      OfficeRuntime?: { auth?: { getAccessToken?: (opts: object) => Promise<string> } };
    }
  ).OfficeRuntime;
  if (!officeRuntime?.auth?.getAccessToken) throw new Error('Office SSO unavailable');
  return officeRuntime.auth.getAccessToken({ allowSignInPrompt: false });
}

let msalInstancePromise: Promise<
  import('@azure/msal-browser').PublicClientApplication
> | null = null;

function getMsalInstance() {
  if (!msalInstancePromise) {
    msalInstancePromise = (async () => {
      const { PublicClientApplication } = await import('@azure/msal-browser');
      const pca = new PublicClientApplication({
        auth: {
          clientId: ENTRA_CLIENT_ID,
          authority: 'https://login.microsoftonline.com/organizations',
          redirectUri: `${window.location.origin}/taskpane.html`,
        },
        cache: { cacheLocation: 'sessionStorage' },
      });
      await pca.initialize();
      return pca;
    })();
  }
  return msalInstancePromise;
}

async function msalPopupToken(): Promise<string> {
  const pca = await getMsalInstance();
  const scopes = msalScopes();
  const account = pca.getAllAccounts()[0];
  if (account) {
    try {
      const silent = await pca.acquireTokenSilent({ scopes, account });
      return silent.accessToken;
    } catch {
      /* fall through to the popup */
    }
  }
  const popup = await pca.acquireTokenPopup({ scopes });
  return popup.accessToken;
}

export const defaultEntraTokenDeps: EntraTokenDeps = {
  getSsoToken: officeSsoToken,
  getMsalToken: msalPopupToken,
};

/** Silent only — never opens UI. Throws when Office SSO is unavailable or fails. */
export async function getEntraTokenSilent(
  deps: EntraTokenDeps = defaultEntraTokenDeps,
): Promise<string> {
  return deps.getSsoToken();
}

/** Full chain: silent Office SSO, then MSAL popup. Call from a user gesture. */
export async function getEntraTokenInteractive(
  deps: EntraTokenDeps = defaultEntraTokenDeps,
): Promise<string> {
  try {
    return await deps.getSsoToken();
  } catch {
    return deps.getMsalToken();
  }
}
```

`apps/office-addin/src/auth/session.ts`:

```ts
/**
 * Breeze client-AI session: POST /client-ai/auth/exchange (Plan 1, authoritative
 * — see Pinned server contracts §1). Stores { sessionToken, user, org?, branding? }
 * in memory + sessionStorage; reExchange() is the single-flight 401 recovery
 * path the API client (Task 6) calls.
 */
import { API_BASE_URL } from '../config';
import {
  defaultEntraTokenDeps,
  getEntraTokenInteractive,
  getEntraTokenSilent,
  type EntraTokenDeps,
} from './entraToken';

export type ExchangeUser = { id: string; email: string; name: string | null };
/** Not sent by Plan 1 yet (Deviation D2) — typed optional so a later server addition needs zero client changes. */
export type ExchangeOrg = { id: string; name?: string | null };
export type ExchangeBranding = { displayName?: string | null; logoUrl?: string | null };

export type ExchangeResponse = {
  accessToken: string;
  expiresInSeconds: number;
  user: ExchangeUser;
  org?: ExchangeOrg;
  branding?: ExchangeBranding;
};

export type AuthBlockKind =
  | 'not_provisioned'
  | 'disabled'
  | 'user_not_permitted'
  | 'account_inactive'
  | 'retryable';

export class AuthBlockedError extends Error {
  constructor(
    public kind: AuthBlockKind,
    public errorCode: string,
  ) {
    super(`client-ai auth blocked: ${errorCode}`);
    this.name = 'AuthBlockedError';
  }
}

/** The exchange 401'd (stale/garbled Entra token). signIn retries once; then this propagates. */
export class InvalidEntraTokenError extends Error {
  constructor() {
    super('Entra token rejected by the exchange');
    this.name = 'InvalidEntraTokenError';
  }
}

export type ClientSession = {
  sessionToken: string;
  expiresAt: number; // epoch ms
  user: ExchangeUser;
  org: ExchangeOrg | null;
  branding: ExchangeBranding | null;
};

const STORAGE_KEY = 'breeze-client-ai-session';
let current: ClientSession | null = null;

export function getStoredSession(): ClientSession | null {
  if (current && Date.now() < current.expiresAt) return current;
  current = null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientSession;
    if (typeof parsed.sessionToken !== 'string' || Date.now() >= parsed.expiresAt) return null;
    current = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function getSessionToken(): string | null {
  return getStoredSession()?.sessionToken ?? null;
}

export function clearSession(): void {
  current = null;
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Test-only: drops the in-memory cache WITHOUT touching sessionStorage. */
export function __resetSessionForTests(): void {
  current = null;
}

function storeSession(res: ExchangeResponse): ClientSession {
  const session: ClientSession = {
    sessionToken: res.accessToken,
    expiresAt: Date.now() + res.expiresInSeconds * 1000,
    user: res.user,
    org: res.org ?? null,
    branding: res.branding ?? null,
  };
  current = session;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage may be unavailable in some webviews — in-memory still works */
  }
  return session;
}

/** Plan 1 error-code table → screen family (Pinned server contracts §1). */
const BLOCK_KINDS: Record<string, AuthBlockKind> = {
  tenant_not_provisioned: 'not_provisioned',
  not_enabled: 'not_provisioned',
  disabled: 'disabled',
  user_not_permitted: 'user_not_permitted',
  account_inactive: 'account_inactive',
  provisioning_failed: 'retryable',
  rate_limited: 'retryable',
  service_unavailable: 'retryable',
};

async function exchangeOnce(entraToken: string, fetchImpl: typeof fetch): Promise<ClientSession> {
  const res = await fetchImpl(`${API_BASE_URL}/client-ai/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: entraToken }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (res.ok) return storeSession(body as ExchangeResponse);
  const code =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `http_${res.status}`;
  if (res.status === 401) throw new InvalidEntraTokenError();
  throw new AuthBlockedError(BLOCK_KINDS[code] ?? 'retryable', code);
}

export type SignInDeps = { entra?: EntraTokenDeps; fetchImpl?: typeof fetch };

export async function signIn(
  opts: { interactive: boolean },
  deps: SignInDeps = {},
): Promise<ClientSession> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const entraDeps = deps.entra ?? defaultEntraTokenDeps;
  const getToken = opts.interactive ? getEntraTokenInteractive : getEntraTokenSilent;
  const entraToken = await getToken(entraDeps);
  try {
    return await exchangeOnce(entraToken, fetchImpl);
  } catch (err) {
    if (err instanceof InvalidEntraTokenError) {
      // Stale cached Entra token: clear everything and retry once from scratch.
      clearSession();
      const freshToken = await getToken(entraDeps);
      return exchangeOnce(freshToken, fetchImpl);
    }
    throw err;
  }
}

let reExchangeInFlight: Promise<ClientSession> | null = null;

/** Single-flight silent re-auth for API-level 401s (Task 6 apiFetch). */
export function reExchange(deps: SignInDeps = {}): Promise<ClientSession> {
  if (!reExchangeInFlight) {
    clearSession();
    reExchangeInFlight = signIn({ interactive: false }, deps).finally(() => {
      reExchangeInFlight = null;
    });
  }
  return reExchangeInFlight;
}
```

`apps/office-addin/src/components/BlockedScreen.tsx`:

```tsx
import type { AuthBlockKind } from '../auth/session';

const COPY: Record<AuthBlockKind, { title: string; body: string }> = {
  not_provisioned: {
    title: 'Not set up yet',
    body: 'Breeze AI has not been provisioned for your organization. Contact your IT provider to enable it.',
  },
  disabled: {
    title: 'Disabled',
    body: 'Breeze AI is currently disabled for your organization. Contact your IT provider.',
  },
  user_not_permitted: {
    title: 'No access',
    body: 'Your account does not have access to Breeze AI. Contact your IT provider.',
  },
  account_inactive: {
    title: 'Account inactive',
    body: 'Your account is inactive. Contact your IT provider.',
  },
  retryable: {
    title: 'Temporarily unavailable',
    body: 'Something went wrong talking to Breeze. Try again in a moment.',
  },
};

export function BlockedScreen({ kind, onRetry }: { kind: AuthBlockKind; onRetry?: () => void }) {
  const copy = COPY[kind];
  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid={`blocked-${kind}`}
    >
      <div className="text-base font-semibold text-gray-800">{copy.title}</div>
      <p className="text-sm text-gray-500">{copy.body}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-700"
          data-testid="blocked-retry"
        >
          Try again
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/auth`
Expected: 10 tests PASS (3 entraToken + 7 session). Then `npx tsc --noEmit` — clean (BlockedScreen has no test; tsc is its gate, D6).

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/auth apps/office-addin/src/components/BlockedScreen.tsx
git commit -m "feat(office-addin): Office SSO -> MSAL fallback -> Breeze exchange with block-kind mapping" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: API client + fetch-SSE parser (TDD)

Three files: `types.ts` (the D1 single-source wire types, now mirroring Plan 2's `CLIENT_AI_SSE_EVENTS` exactly — see the Contract reconciliation section), `sse.ts` (a spec-correct SSE parser over `fetch` ReadableStream + TextDecoder, because `EventSource` cannot send the `Authorization` header), and `client.ts` (typed wrappers with bearer auth, single-flight 401 re-exchange, and `streamEvents` with reconnect-on-drop + history resync).

**Files:**
- Create: apps/office-addin/src/api/types.ts
- Create: apps/office-addin/src/api/sse.ts
- Create: apps/office-addin/src/api/client.ts
- Test: apps/office-addin/src/api/sse.test.ts
- Test: apps/office-addin/src/api/client.test.ts

- [ ] **Step 1: Create `apps/office-addin/src/api/types.ts`** (pure types — no test of its own; consumed everywhere):

```ts
/**
 * /client-ai wire types. THE single place event names/payloads appear (D1).
 * SSE names mirror Plan 2's CLIENT_AI_SSE_EVENTS (apps/api/src/routes/clientAi/sse.ts)
 * — the data JSON does NOT repeat the type; the client discriminates on the
 * SSE `event:` field (see Contract reconciliation).
 */

export type CellValue = string | number | boolean | null;

export type DlpRedaction = { rule: string; count: number; location: string };
export type TurnUsage = { inputTokens: number; outputTokens: number; costCents: number };

export type ToolResultStatus = 'success' | 'error' | 'rejected';
export type ToolCompletedStatus = ToolResultStatus | 'timeout';

export const CLIENT_AI_SSE_EVENTS = [
  'message_delta',
  'tool_request',
  'tool_completed',
  'turn_complete',
  'session_error',
  'ping',
] as const;

export type ClientAiStreamEvent =
  | { type: 'message_delta'; text: string }
  | {
      type: 'tool_request';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      mutating: boolean;
    }
  | {
      type: 'tool_completed';
      toolUseId: string;
      toolName: string;
      status: ToolCompletedStatus;
      redactions: DlpRedaction[];
      blockReason: string | null;
    }
  | { type: 'turn_complete'; usage: TurnUsage | null }
  | { type: 'session_error'; message: string }
  | { type: 'ping' };

export type WorkbookContextKind = 'selection' | 'sheet' | 'none';

/** Per-message context chip payload (Plan 2 workbookContextSchema). */
export type WorkbookContext = {
  kind: WorkbookContextKind;
  address?: string;
  sheetName?: string;
  cells?: CellValue[][];
};

export type SendMessageBody = { content: string; workbookContext?: WorkbookContext };

export type ToolResultBody = { toolUseId: string; status: ToolResultStatus; output?: unknown };

export type ClientAiTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  body: string;
};

export type SessionSummary = {
  id: string;
  status: string;
  title: string | null;
  model: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  createdAt: string;
  lastActivityAt: string | null;
};

export type SessionMessage = {
  id: string;
  role: string;
  content: string | null;
  contentBlocks: unknown;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  toolUseId: string | null;
  createdAt: string;
};

export type SessionHistory = { session: SessionSummary; messages: SessionMessage[] };
```

- [ ] **Step 2: Write the failing tests**

`apps/office-addin/src/api/sse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSseStream, type SseFrame } from './sse';

const encoder = new TextEncoder();

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(streamFrom(chunks))) frames.push(frame);
  return frames;
}

describe('parseSseStream', () => {
  it('parses a single event frame', async () => {
    const frames = await collect(['event: message_delta\ndata: {"text":"hi"}\n\n']);
    expect(frames).toEqual([{ event: 'message_delta', data: '{"text":"hi"}' }]);
  });

  it('handles events split across arbitrary chunk boundaries', async () => {
    const frames = await collect([
      'event: mess',
      'age_delta\nda',
      'ta: {"text":"x',
      'y"}\n',
      '\nevent: ping\ndata: {}\n\n',
    ]);
    expect(frames).toEqual([
      { event: 'message_delta', data: '{"text":"xy"}' },
      { event: 'ping', data: '{}' },
    ]);
  });

  it('joins multi-line data with newlines', async () => {
    const frames = await collect(['event: message_delta\ndata: line1\ndata: line2\n\n']);
    expect(frames).toEqual([{ event: 'message_delta', data: 'line1\nline2' }]);
  });

  it('accepts CRLF line endings', async () => {
    const frames = await collect(['event: ping\r\ndata: {}\r\n\r\n']);
    expect(frames).toEqual([{ event: 'ping', data: '{}' }]);
  });

  it('ignores comments and unknown fields', async () => {
    const frames = await collect([
      ': keepalive comment\nid: 42\nretry: 5000\nevent: ping\ndata: {}\n\n',
    ]);
    expect(frames).toEqual([{ event: 'ping', data: '{}' }]);
  });

  it("defaults the event name to 'message' when no event line is present", async () => {
    const frames = await collect(['data: {"a":1}\n\n']);
    expect(frames).toEqual([{ event: 'message', data: '{"a":1}' }]);
  });

  it('flushes a final frame when the stream ends without a trailing blank line', async () => {
    const frames = await collect(['event: session_error\ndata: {"message":"boom"}']);
    expect(frames).toEqual([{ event: 'session_error', data: '{"message":"boom"}' }]);
  });
});
```

`apps/office-addin/src/api/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createSession,
  decodeStreamFrame,
  getTemplates,
  sendMessage,
  streamEvents,
} from './client';
import { clearSession, getSessionToken, reExchange } from '../auth/session';
import type { ClientAiStreamEvent } from './types';

vi.mock('../auth/session', async () => {
  const actual = await vi.importActual<typeof import('../auth/session')>('../auth/session');
  return {
    ...actual,
    getSessionToken: vi.fn(() => 'breeze-token'),
    reExchange: vi.fn(async () => ({}) as never),
    clearSession: vi.fn(),
  };
});

const getSessionTokenMock = vi.mocked(getSessionToken);
const reExchangeMock = vi.mocked(reExchange);
const clearSessionMock = vi.mocked(clearSession);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const encoder = new TextEncoder();

function sseResponse(frames: string, opts: { keepOpen?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      if (!opts.keepOpen) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  getSessionTokenMock.mockReturnValue('breeze-token');
  reExchangeMock.mockClear();
  clearSessionMock.mockClear();
});

describe('apiFetch wrappers', () => {
  it('attaches the Authorization bearer header and returns the sessionId (201)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sessionId: 'sess-1' }));
    await expect(createSession(fetchImpl as unknown as typeof fetch)).resolves.toBe('sess-1');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/client-ai/sessions');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer breeze-token');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('on 401 runs the single-flight re-exchange and retries once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(jsonResponse(201, { sessionId: 'sess-2' }));
    await expect(createSession(fetchImpl as unknown as typeof fetch)).resolves.toBe('sess-2');
    expect(reExchangeMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates a 401 that survives the re-exchange and clears the session', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'invalid_token' }));
    const err = await createSession(fetchImpl as unknown as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(clearSessionMock).toHaveBeenCalled();
  });

  it('surfaces server rejection codes (budget_exceeded) as ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'budget_exceeded' }));
    const err = await sendMessage('sess-1', { content: 'hi' }, fetchImpl as unknown as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('budget_exceeded');
  });

  it('getTemplates accepts both the pinned bare array and a {data:[...]} envelope', async () => {
    const template = { id: 't1', name: 'T', description: null, category: null, body: 'B' };
    const bare = vi.fn(async () => jsonResponse(200, [template]));
    await expect(getTemplates(bare as unknown as typeof fetch)).resolves.toEqual([template]);
    const wrapped = vi.fn(async () => jsonResponse(200, { data: [template] }));
    await expect(getTemplates(wrapped as unknown as typeof fetch)).resolves.toEqual([template]);
  });
});

describe('decodeStreamFrame', () => {
  it('types known events, passes ping without payload, and skips unknown names', () => {
    expect(decodeStreamFrame({ event: 'message_delta', data: '{"text":"hi"}' })).toEqual({
      type: 'message_delta',
      text: 'hi',
    });
    expect(decodeStreamFrame({ event: 'ping', data: '{}' })).toEqual({ type: 'ping' });
    expect(decodeStreamFrame({ event: 'turn_complete', data: '{"usage":null}' })).toEqual({
      type: 'turn_complete',
      usage: null,
    });
    expect(decodeStreamFrame({ event: 'some_future_event', data: '{}' })).toBeNull();
  });
});

describe('streamEvents', () => {
  it('reconnects after a dropped stream with backoff and calls onReconnect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse('event: message_delta\ndata: {"text":"a"}\n\n'))
      .mockResolvedValueOnce(
        sseResponse('event: message_delta\ndata: {"text":"b"}\n\n', { keepOpen: true }),
      );
    const events: ClientAiStreamEvent[] = [];
    const onReconnect = vi.fn();
    const handle = streamEvents(
      'sess-1',
      { onEvent: (e) => events.push(e), onReconnect },
      fetchImpl as unknown as typeof fetch,
      [10], // test-only backoff schedule
    );
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((e) => (e.type === 'message_delta' ? e.text : ''))).toEqual(['a', 'b']);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/api`
Expected: FAIL — `./sse` / `./client` not found.

- [ ] **Step 4: Write the implementation**

`apps/office-addin/src/api/sse.ts`:

```ts
/**
 * SSE parser over a fetch ReadableStream. EventSource cannot set the
 * Authorization header, so the add-in consumes GET /events with fetch and
 * parses frames manually (the server's GET-only ?token= fallback exists for
 * EventSource clients; this client never uses it).
 *
 * Implements the SSE wire format subset the server emits: `event:` + one or
 * more `data:` lines per frame, blank-line dispatch, `:` comments and
 * `id:`/`retry:` fields ignored, CRLF tolerated, frames may be split across
 * arbitrary chunk boundaries.
 */

export type SseFrame = { event: string; data: string };

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0) {
      eventName = '';
      return null;
    }
    const frame = { event: eventName || 'message', data: dataLines.join('\n') };
    eventName = '';
    dataLines = [];
    return frame;
  };

  const handleLine = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return flush();
    if (line.startsWith(':')) return null; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // id: / retry: / anything else — ignored
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = handleLine(line);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const frame = handleLine(buffer);
      if (frame) yield frame;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
```

`apps/office-addin/src/api/client.ts`:

```ts
/**
 * Typed /client-ai API client. Every request carries the Breeze session token;
 * a 401 triggers ONE single-flight re-exchange (auth/session.ts) + retry.
 * Contracts: Contract reconciliation section of this plan (Plan 2 / Plan 4 pins).
 */
import { API_BASE_URL } from '../config';
import { AuthBlockedError, clearSession, getSessionToken, reExchange } from '../auth/session';
import { parseSseStream } from './sse';
import {
  CLIENT_AI_SSE_EVENTS,
  type ClientAiStreamEvent,
  type ClientAiTemplate,
  type SendMessageBody,
  type SessionHistory,
  type ToolResultBody,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`client-ai request failed: ${status} ${code}`);
    this.name = 'ApiError';
  }
}

type FetchLike = typeof fetch;

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const doFetch = async (): Promise<Response> => {
    const token = getSessionToken();
    if (!token) throw new ApiError(401, 'no_session');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    return fetchImpl(`${API_BASE_URL}${path}`, { ...init, headers });
  };
  let res = await doFetch();
  if (res.status === 401) {
    await reExchange(); // throws AuthBlockedError when access was revoked
    res = await doFetch();
    if (res.status === 401) {
      clearSession();
      throw new ApiError(401, 'unauthorized');
    }
  }
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function expectOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) {
    const code =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `http_${res.status}`;
    throw new ApiError(res.status, code);
  }
  return body;
}

/** POST /client-ai/sessions {} → 201 { sessionId } */
export async function createSession(fetchImpl?: FetchLike): Promise<string> {
  const body = (await expectOk(
    await apiFetch('/client-ai/sessions', { method: 'POST', body: '{}' }, fetchImpl),
  )) as { sessionId: string };
  return body.sessionId;
}

/** POST /client-ai/sessions/:id/messages → 202 { accepted: true }; the turn streams over GET /events. */
export async function sendMessage(
  sessionId: string,
  message: SendMessageBody,
  fetchImpl?: FetchLike,
): Promise<void> {
  await expectOk(
    await apiFetch(
      `/client-ai/sessions/${sessionId}/messages`,
      { method: 'POST', body: JSON.stringify(message) },
      fetchImpl,
    ),
  );
}

/** POST /client-ai/sessions/:id/tool-results — resolves a parked tool_request server-side. */
export async function postToolResult(
  sessionId: string,
  result: ToolResultBody,
  fetchImpl?: FetchLike,
): Promise<void> {
  await expectOk(
    await apiFetch(
      `/client-ai/sessions/${sessionId}/tool-results`,
      { method: 'POST', body: JSON.stringify(result) },
      fetchImpl,
    ),
  );
}

/** GET /client-ai/templates → bare array (Plan 4 pin); {data:[...]} tolerated defensively. */
export async function getTemplates(fetchImpl?: FetchLike): Promise<ClientAiTemplate[]> {
  const body = await expectOk(await apiFetch('/client-ai/templates', {}, fetchImpl));
  if (Array.isArray(body)) return body as ClientAiTemplate[];
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data))
    return (body as { data: ClientAiTemplate[] }).data;
  return [];
}

/** GET /client-ai/sessions/:id → { session, messages } (already-redacted history). */
export async function getSession(sessionId: string, fetchImpl?: FetchLike): Promise<SessionHistory> {
  return (await expectOk(await apiFetch(`/client-ai/sessions/${sessionId}`, {}, fetchImpl))) as SessionHistory;
}

/** POST /client-ai/sessions/:id/close — best-effort teardown. */
export async function closeSession(sessionId: string, fetchImpl?: FetchLike): Promise<void> {
  await expectOk(
    await apiFetch(`/client-ai/sessions/${sessionId}/close`, { method: 'POST', body: '{}' }, fetchImpl),
  );
}

const KNOWN_EVENTS = new Set<string>(CLIENT_AI_SSE_EVENTS);

/** SSE frame → typed event. Unknown event names → null (additive server events are safe). */
export function decodeStreamFrame(frame: { event: string; data: string }): ClientAiStreamEvent | null {
  if (!KNOWN_EVENTS.has(frame.event)) return null;
  if (frame.event === 'ping') return { type: 'ping' };
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  return { type: frame.event, ...(payload as object) } as ClientAiStreamEvent;
}

export type StreamHandle = { stop: () => void };

export type StreamCallbacks = {
  onEvent: (event: ClientAiStreamEvent) => void;
  /** Fires after a successful REconnect — re-GET history and reconcile (the gap may have streamed events). */
  onReconnect?: () => void | Promise<void>;
  /** Auth permanently lost (re-exchange failed / blocked) — stop and surface. */
  onPermanentError?: (err: unknown) => void;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * Persistent GET /events consumer. fetch + Authorization header (primary path;
 * the server's ?token= GET fallback is for EventSource clients only).
 * Reconnects forever with capped backoff until stop() — server pings (25s)
 * keep healthy connections alive, so a dropped read means real network loss.
 */
export function streamEvents(
  sessionId: string,
  callbacks: StreamCallbacks,
  fetchImpl: FetchLike = fetch,
  backoffMs: number[] = DEFAULT_BACKOFF_MS,
): StreamHandle {
  const controller = new AbortController();
  let attempt = 0;
  let connectedBefore = false;

  const loop = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) return;
      try {
        const res = await apiFetch(
          `/client-ai/sessions/${sessionId}/events`,
          { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
          fetchImpl,
        );
        if (!res.ok || !res.body) throw new ApiError(res.status, `http_${res.status}`);
        if (connectedBefore) await callbacks.onReconnect?.();
        connectedBefore = true;
        for await (const frame of parseSseStream(res.body)) {
          attempt = 0; // healthy traffic resets the backoff
          const event = decodeStreamFrame(frame);
          if (event) callbacks.onEvent(event);
        }
        // server closed the stream — fall through and reconnect
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof AuthBlockedError || (err instanceof ApiError && err.status === 401)) {
          callbacks.onPermanentError?.(err);
          return;
        }
        // transient (network drop, 5xx) — fall through to backoff
      }
      if (controller.signal.aborted) return;
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)]!;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  void loop();
  return { stop: () => controller.abort() };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/api`
Expected: 14 tests PASS (7 sse + 7 client).

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/api
git commit -m "feat(office-addin): typed client-ai API client + fetch-SSE parser with reconnect/backoff" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Tool executors — all 9 workbook tools + dispatcher (TDD)

The client-side halves of Plan 2's `CLIENT_TOOL_REGISTRY` (spec §5). Every executor funnels through `Excel.run`; inputs are validated before any Office.js call so bad model input fails fast with a model-readable message. The dispatcher routes `tool_request` events: non-mutating → execute + POST the result; mutating → park in the approval queue ONLY (Task 8 resolves them). `request.mutating` from the server is OR-ed with the local `MUTATING_TOOLS` set as defense-in-depth — a server bug can never auto-execute a write.

**Files:**
- Create: apps/office-addin/src/tools/helpers.ts
- Create: apps/office-addin/src/tools/getWorkbookOverview.ts
- Create: apps/office-addin/src/tools/readSelection.ts
- Create: apps/office-addin/src/tools/readRange.ts
- Create: apps/office-addin/src/tools/writeRange.ts
- Create: apps/office-addin/src/tools/insertFormula.ts
- Create: apps/office-addin/src/tools/createSheet.ts
- Create: apps/office-addin/src/tools/formatRange.ts
- Create: apps/office-addin/src/tools/createTable.ts
- Create: apps/office-addin/src/tools/searchWorkbook.ts
- Create: apps/office-addin/src/tools/dispatcher.ts
- Test: apps/office-addin/src/tools/getWorkbookOverview.test.ts
- Test: apps/office-addin/src/tools/readRange.test.ts
- Test: apps/office-addin/src/tools/writeRange.test.ts
- Test: apps/office-addin/src/tools/searchWorkbook.test.ts
- Test: apps/office-addin/src/tools/dispatcher.test.ts

- [ ] **Step 1: Write the failing tests**

`apps/office-addin/src/tools/getWorkbookOverview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { getWorkbookOverview } from './getWorkbookOverview';

describe('get_workbook_overview', () => {
  it('returns sheet names, used ranges, and first-row headers', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [
      ['Region', 'Q1', 'Q2'],
      ['EMEA', 1200, 1300],
    ]);
    mock.addSheet('Notes');
    const result = (await getWorkbookOverview({})) as {
      sheets: Array<{ name: string; usedRange: string | null; headers: unknown[] }>;
    };
    expect(result.sheets).toEqual([
      { name: 'Sheet1', usedRange: 'Sheet1!B2:D3', headers: ['Region', 'Q1', 'Q2'] },
      { name: 'Notes', usedRange: null, headers: [] },
    ]);
  });

  it('caps headers at 50 columns', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [Array.from({ length: 60 }, (_, i) => `h${i}`)]);
    const result = (await getWorkbookOverview({})) as {
      sheets: Array<{ headers: unknown[] }>;
    };
    expect(result.sheets[0]!.headers).toHaveLength(50);
  });
});
```

`apps/office-addin/src/tools/readRange.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { readRange } from './readRange';
import { ToolInputError } from './helpers';

describe('read_range', () => {
  it('reads values with the sheet-qualified address', async () => {
    getOfficeMock().setValues('Sheet1', 'B2', [
      ['a', 1],
      ['b', 2],
    ]);
    await expect(readRange({ address: 'B2:C3' })).resolves.toEqual({
      address: 'Sheet1!B2:C3',
      rowCount: 2,
      columnCount: 2,
      values: [
        ['a', 1],
        ['b', 2],
      ],
    });
  });

  it('rejects an unknown sheet with a model-readable error', async () => {
    await expect(readRange({ address: 'A1', sheetName: 'Nope' })).rejects.toThrow(
      /No worksheet named "Nope"/,
    );
  });

  it('rejects ranges over the 50k-cell cap before touching Office.js', async () => {
    await expect(readRange({ address: 'A1:ZZ10000' })).rejects.toBeInstanceOf(ToolInputError);
  });
});
```

`apps/office-addin/src/tools/writeRange.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { writeRange } from './writeRange';

describe('write_range', () => {
  it('writes a matrix anchored at a single cell and reports the written range', async () => {
    await expect(
      writeRange({
        address: 'B2',
        values: [
          ['Region', 'Q1'],
          ['EMEA', 1200],
        ],
      }),
    ).resolves.toEqual({ address: 'Sheet1!B2:C3', rowsWritten: 2, columnsWritten: 2 });
    expect(getOfficeMock().getValues('Sheet1', 'B2:C3')).toEqual([
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
  });

  it('writes into an exactly-matching multi-cell range', async () => {
    await expect(
      writeRange({ address: 'A1:B1', values: [['x', 'y']] }),
    ).resolves.toMatchObject({ address: 'Sheet1!A1:B1' });
    expect(getOfficeMock().getValues('Sheet1', 'A1:B1')).toEqual([['x', 'y']]);
  });

  it('rejects a dimension mismatch against a multi-cell target', async () => {
    await expect(writeRange({ address: 'A1:C1', values: [['only', 'two']] })).rejects.toThrow(
      /values is 1x2 but A1:C1 is 1x3/,
    );
  });
});
```

`apps/office-addin/src/tools/searchWorkbook.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { searchWorkbook } from './searchWorkbook';
import { SEARCH_RESULT_CAP } from './helpers';

type SearchResult = {
  query: string;
  results: Array<{ sheet: string; address: string; value: unknown }>;
  truncated: boolean;
};

describe('search_workbook', () => {
  it('finds case-insensitive substring matches across all sheets with cell addresses', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['Total Revenue', 'misc']]);
    mock.addSheet('Data');
    mock.setValues('Data', 'C5', [['quarterly TOTALS']]);
    const result = (await searchWorkbook({ query: 'total' })) as SearchResult;
    expect(result.results).toEqual([
      { sheet: 'Sheet1', address: 'A1', value: 'Total Revenue' },
      { sheet: 'Data', address: 'C5', value: 'quarterly TOTALS' },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('scopes the search to sheetName when provided', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['match here']]);
    mock.addSheet('Data');
    mock.setValues('Data', 'A1', [['match there']]);
    const result = (await searchWorkbook({ query: 'match', sheetName: 'Data' })) as SearchResult;
    expect(result.results).toEqual([{ sheet: 'Data', address: 'A1', value: 'match there' }]);
  });

  it('caps results at SEARCH_RESULT_CAP and sets truncated', async () => {
    const mock = getOfficeMock();
    mock.setValues(
      'Sheet1',
      'A1',
      Array.from({ length: SEARCH_RESULT_CAP + 5 }, () => ['needle']),
    );
    const result = (await searchWorkbook({ query: 'needle' })) as SearchResult;
    expect(result.results).toHaveLength(SEARCH_RESULT_CAP);
    expect(result.truncated).toBe(true);
  });
});
```

`apps/office-addin/src/tools/dispatcher.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { MUTATING_TOOLS, TOOL_EXECUTORS, dispatchToolRequest, executeTool } from './dispatcher';
import type { ToolRequest } from './dispatcher';

function deps() {
  return { postToolResult: vi.fn(async () => undefined), enqueueApproval: vi.fn() };
}

function request(overrides: Partial<ToolRequest>): ToolRequest {
  return {
    type: 'tool_request',
    toolUseId: 'tu-1',
    toolName: 'read_range',
    input: {},
    mutating: false,
    ...overrides,
  };
}

describe('registry shape', () => {
  it('registers exactly the 9 spec §5 tools; 5 are mutating', () => {
    expect(Object.keys(TOOL_EXECUTORS).sort()).toEqual([
      'create_sheet',
      'create_table',
      'format_range',
      'get_workbook_overview',
      'insert_formula',
      'read_range',
      'read_selection',
      'search_workbook',
      'write_range',
    ]);
    expect([...MUTATING_TOOLS].sort()).toEqual([
      'create_sheet',
      'create_table',
      'format_range',
      'insert_formula',
      'write_range',
    ]);
  });
});

describe('dispatchToolRequest', () => {
  it('auto-executes non-mutating tools and posts the success result', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['v']]);
    const d = deps();
    await dispatchToolRequest(request({ input: { address: 'A1' } }), d);
    expect(d.enqueueApproval).not.toHaveBeenCalled();
    expect(d.postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-1',
      status: 'success',
      output: { address: 'Sheet1!A1', rowCount: 1, columnCount: 1, values: [['v']] },
    });
  });

  it('parks mutating tools in the approval queue WITHOUT executing or posting', async () => {
    const d = deps();
    const req = request({ toolName: 'write_range', mutating: true, input: { address: 'A1', values: [['x']] } });
    await dispatchToolRequest(req, d);
    expect(d.enqueueApproval).toHaveBeenCalledWith(req);
    expect(d.postToolResult).not.toHaveBeenCalled();
    expect(getOfficeMock().getValues('Sheet1', 'A1')).toEqual([['']]); // nothing written
  });

  it('treats a locally-known mutating tool as mutating even if the server flag lies', async () => {
    const d = deps();
    await dispatchToolRequest(
      request({ toolName: 'write_range', mutating: false, input: { address: 'A1', values: [['x']] } }),
      d,
    );
    expect(d.enqueueApproval).toHaveBeenCalledTimes(1);
    expect(d.postToolResult).not.toHaveBeenCalled();
  });

  it('posts status:error when the executor throws', async () => {
    const d = deps();
    await dispatchToolRequest(request({ input: { address: 'A1', sheetName: 'Nope' } }), d);
    expect(d.postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-1',
      status: 'error',
      output: { error: expect.stringContaining('No worksheet named "Nope"') },
    });
  });

  it('posts status:error for an unknown tool', async () => {
    const d = deps();
    await dispatchToolRequest(request({ toolName: 'launch_missiles' }), d);
    expect(d.postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-1',
      status: 'error',
      output: { error: 'Unknown tool: launch_missiles' },
    });
  });
});

describe('executeTool', () => {
  it('never throws — failures come back as { status: "error" }', async () => {
    await expect(executeTool('read_range', {})).resolves.toMatchObject({ status: 'error' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/tools`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`apps/office-addin/src/tools/helpers.ts`:

```ts
/**
 * Shared tool plumbing: input validation (model input is untrusted), sheet
 * resolution, and payload caps. Caps mirror the server side: 50k cells is the
 * DLP engine's fail-closed limit (Plan 3) — anything bigger would be refused
 * there anyway, so fail fast here with a message the model can act on.
 */
import { parseAddress, stripSheet } from '../lib/address';
import type { CellValue } from '../api/types';

export const MAX_TOOL_CELLS = 50_000;
export const SEARCH_RESULT_CAP = 200;
export const OVERVIEW_HEADER_CAP = 50;

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new ToolInputError(`${key} must be a non-empty string`);
  return value;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
  return value;
}

export function requireCellMatrix(input: Record<string, unknown>, key: string): CellValue[][] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((row) => Array.isArray(row)))
    throw new ToolInputError(`${key} must be a non-empty 2D array`);
  const matrix = value as unknown[][];
  const width = matrix[0]!.length;
  if (width === 0 || !matrix.every((row) => row.length === width))
    throw new ToolInputError(`${key} must be rectangular (every row the same length)`);
  for (const row of matrix) {
    for (const cell of row) {
      if (
        cell !== null &&
        typeof cell !== 'string' &&
        typeof cell !== 'number' &&
        typeof cell !== 'boolean'
      )
        throw new ToolInputError(`${key} cells must be string | number | boolean | null`);
    }
  }
  return matrix as CellValue[][];
}

export function assertCellCap(rows: number, cols: number, what: string): void {
  if (rows * cols > MAX_TOOL_CELLS)
    throw new ToolInputError(
      `${what} covers ${rows * cols} cells — over the ${MAX_TOOL_CELLS}-cell limit. Use a narrower range.`,
    );
}

export function addressDims(address: string): { rows: number; cols: number } {
  const p = parseAddress(stripSheet(address));
  return { rows: p.endRow - p.startRow + 1, cols: p.endCol - p.startCol + 1 };
}

/** Explicit sheetName > sheet embedded in the address > active sheet. */
export async function resolveSheet(
  context: Excel.RequestContext,
  sheetName: string | undefined,
  address?: string,
): Promise<Excel.Worksheet> {
  const fromAddress = address?.includes('!') ? parseAddress(address).sheet : null;
  const name = sheetName ?? fromAddress ?? null;
  if (!name) return context.workbook.worksheets.getActiveWorksheet();
  const sheet = context.workbook.worksheets.getItemOrNullObject(name);
  await context.sync();
  if (sheet.isNullObject) throw new ToolInputError(`No worksheet named "${name}"`);
  return sheet;
}
```

`apps/office-addin/src/tools/getWorkbookOverview.ts`:

```ts
import { OVERVIEW_HEADER_CAP } from './helpers';
import type { CellValue } from '../api/types';

/** Sheet names + used ranges + first-row headers — the model's map of the workbook. */
export async function getWorkbookOverview(_input: Record<string, unknown>): Promise<unknown> {
  return Excel.run(async (context) => {
    const collection = context.workbook.worksheets;
    collection.load('items/name');
    await context.sync();
    const scans = collection.items.map((sheet) => {
      const used = sheet.getUsedRangeOrNullObject();
      used.load('address');
      const headerRow = used.getRow(0); // header row only — never hydrate the whole used range
      headerRow.load('values');
      return { sheet, used, headerRow };
    });
    await context.sync();
    const sheets = scans.map(({ sheet, used, headerRow }) => {
      if (used.isNullObject) return { name: sheet.name, usedRange: null, headers: [] as CellValue[] };
      const headers = ((headerRow.values[0] ?? []) as CellValue[]).slice(0, OVERVIEW_HEADER_CAP);
      return { name: sheet.name, usedRange: used.address, headers };
    });
    return { sheets };
  });
}
```

`apps/office-addin/src/tools/readSelection.ts`:

```ts
import { assertCellCap } from './helpers';

/** Reads the user's current selection. Two-phase: dims first, values only when under the cap. */
export async function readSelection(_input: Record<string, unknown>): Promise<unknown> {
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load(['address', 'rowCount', 'columnCount']);
    await context.sync();
    assertCellCap(range.rowCount, range.columnCount, `Selection ${range.address}`);
    range.load('values');
    await context.sync();
    return {
      address: range.address,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      values: range.values,
    };
  });
}
```

`apps/office-addin/src/tools/readRange.ts`:

```ts
import { stripSheet } from '../lib/address';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet } from './helpers';

export async function readRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Range ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.load(['address', 'values', 'rowCount', 'columnCount']);
    await context.sync();
    return {
      address: range.address,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      values: range.values,
    };
  });
}
```

`apps/office-addin/src/tools/writeRange.ts`:

```ts
import { parseAddress, rangeAddress, stripSheet } from '../lib/address';
import {
  addressDims,
  assertCellCap,
  optionalString,
  requireCellMatrix,
  requireString,
  resolveSheet,
  ToolInputError,
} from './helpers';

/**
 * MUTATING — only ever invoked through the approval store (Task 8).
 * A single-cell address acts as an anchor: the full matrix writes from there.
 * A multi-cell address must match the matrix dimensions exactly.
 */
export async function writeRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const values = requireCellMatrix(input, 'values');
  const { rows, cols } = addressDims(address);
  const isAnchor = rows === 1 && cols === 1;
  if (!isAnchor && (rows !== values.length || cols !== values[0]!.length))
    throw new ToolInputError(
      `values is ${values.length}x${values[0]!.length} but ${stripSheet(address)} is ${rows}x${cols}`,
    );
  assertCellCap(values.length, values[0]!.length, `Write to ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const parsed = parseAddress(stripSheet(address));
    const target = rangeAddress(parsed.startRow, parsed.startCol, values.length, values[0]!.length);
    const range = sheet.getRange(target);
    range.values = values;
    range.load('address');
    await context.sync();
    return { address: range.address, rowsWritten: values.length, columnsWritten: values[0]!.length };
  });
}
```

`apps/office-addin/src/tools/insertFormula.ts`:

```ts
import { stripSheet } from '../lib/address';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

/**
 * MUTATING. D5: Office.js assigns the SAME formula text to every cell of the
 * target range (no relative-reference rewriting on assignment) — single-cell
 * targets behave exactly as expected; per-row formulas need one call per cell.
 */
export async function insertFormula(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const formula = requireString(input, 'formula');
  const sheetName = optionalString(input, 'sheetName');
  if (!formula.startsWith('=')) throw new ToolInputError('formula must start with "="');
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Formula fill of ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.formulas = Array.from({ length: rows }, () => Array.from({ length: cols }, () => formula));
    range.load('address');
    await context.sync();
    return { address: range.address, formula, cellCount: rows * cols };
  });
}
```

`apps/office-addin/src/tools/createSheet.ts`:

```ts
import { requireString, ToolInputError } from './helpers';

/** MUTATING. */
export async function createSheet(input: Record<string, unknown>): Promise<unknown> {
  const name = requireString(input, 'name');
  if (name.length > 31 || /[\\/?*[\]:]/.test(name))
    throw new ToolInputError('Invalid sheet name (max 31 chars; no \\ / ? * [ ] :)');
  return Excel.run(async (context) => {
    const existing = context.workbook.worksheets.getItemOrNullObject(name);
    await context.sync();
    if (!existing.isNullObject) throw new ToolInputError(`A sheet named "${name}" already exists`);
    const sheet = context.workbook.worksheets.add(name);
    sheet.load('name');
    await context.sync();
    return { name: sheet.name, created: true };
  });
}
```

`apps/office-addin/src/tools/formatRange.ts`:

```ts
import { stripSheet } from '../lib/address';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

type FormatInput = {
  bold?: boolean;
  italic?: boolean;
  fontColor?: string;
  fillColor?: string;
  numberFormat?: string;
};

/** MUTATING. Applies a whitelisted subset of formatting to a range. */
export async function formatRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const raw = input.format;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolInputError('format must be an object');
  const format = raw as FormatInput;
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Format of ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    const applied: string[] = [];
    if (typeof format.bold === 'boolean') {
      range.format.font.bold = format.bold;
      applied.push('bold');
    }
    if (typeof format.italic === 'boolean') {
      range.format.font.italic = format.italic;
      applied.push('italic');
    }
    if (typeof format.fontColor === 'string') {
      range.format.font.color = format.fontColor;
      applied.push('fontColor');
    }
    if (typeof format.fillColor === 'string') {
      range.format.fill.color = format.fillColor;
      applied.push('fillColor');
    }
    if (typeof format.numberFormat === 'string') {
      range.numberFormat = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => format.numberFormat!),
      );
      applied.push('numberFormat');
    }
    if (applied.length === 0)
      throw new ToolInputError(
        'format contained no supported keys (bold, italic, fontColor, fillColor, numberFormat)',
      );
    range.load('address');
    await context.sync();
    return { address: range.address, applied };
  });
}
```

`apps/office-addin/src/tools/createTable.ts`:

```ts
import { stripSheet } from '../lib/address';
import { optionalString, requireString, resolveSheet } from './helpers';

/** MUTATING. */
export async function createTable(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const hasHeaders = input.hasHeaders === undefined ? true : input.hasHeaders === true;
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    sheet.load('name');
    await context.sync();
    const qualified = `${sheet.name}!${stripSheet(address)}`;
    const table = context.workbook.tables.add(qualified, hasHeaders);
    table.load('name');
    await context.sync();
    return { name: table.name, address: qualified, hasHeaders };
  });
}
```

`apps/office-addin/src/tools/searchWorkbook.ts`:

```ts
import { parseAddress, rangeAddress, stripSheet } from '../lib/address';
import { optionalString, requireString, resolveSheet, SEARCH_RESULT_CAP } from './helpers';
import type { CellValue } from '../api/types';

/** Case-insensitive substring scan over used ranges, capped at SEARCH_RESULT_CAP hits. */
export async function searchWorkbook(input: Record<string, unknown>): Promise<unknown> {
  const query = requireString(input, 'query');
  const sheetName = optionalString(input, 'sheetName');
  const needle = query.toLowerCase();
  return Excel.run(async (context) => {
    let sheets: Excel.Worksheet[];
    if (sheetName) {
      sheets = [await resolveSheet(context, sheetName)];
    } else {
      const collection = context.workbook.worksheets;
      collection.load('items/name');
      await context.sync();
      sheets = collection.items;
    }
    const scans = sheets.map((sheet) => {
      sheet.load('name');
      const used = sheet.getUsedRangeOrNullObject();
      used.load(['address', 'values']);
      return { sheet, used };
    });
    await context.sync();
    const results: Array<{ sheet: string; address: string; value: CellValue }> = [];
    let truncated = false;
    outer: for (const { sheet, used } of scans) {
      if (used.isNullObject) continue;
      const origin = parseAddress(stripSheet(used.address));
      const values = used.values as CellValue[][];
      for (let r = 0; r < values.length; r++) {
        const row = values[r]!;
        for (let c = 0; c < row.length; c++) {
          const value = row[c]!;
          if (value === null || value === '') continue;
          if (String(value).toLowerCase().includes(needle)) {
            if (results.length >= SEARCH_RESULT_CAP) {
              truncated = true;
              break outer;
            }
            results.push({
              sheet: sheet.name,
              address: rangeAddress(origin.startRow + r, origin.startCol + c, 1, 1),
              value,
            });
          }
        }
      }
    }
    return { query, results, truncated };
  });
}
```

`apps/office-addin/src/tools/dispatcher.ts`:

```ts
/**
 * tool_request router (spec §5 protocol step 2):
 *   non-mutating → execute via Office.js, POST the result immediately.
 *   mutating     → park in the approval queue ONLY (Task 8's ApprovalStore
 *                  executes on Apply / posts 'rejected' on Reject).
 * executeTool never throws — executor failures become { status: 'error' }
 * results so the model can react (the server's 60s read timeout is the
 * backstop, not the happy path).
 */
import type { ClientAiStreamEvent, ToolResultBody } from '../api/types';
import { getWorkbookOverview } from './getWorkbookOverview';
import { readSelection } from './readSelection';
import { readRange } from './readRange';
import { writeRange } from './writeRange';
import { insertFormula } from './insertFormula';
import { createSheet } from './createSheet';
import { formatRange } from './formatRange';
import { createTable } from './createTable';
import { searchWorkbook } from './searchWorkbook';

export type ToolExecutor = (input: Record<string, unknown>) => Promise<unknown>;

export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  get_workbook_overview: getWorkbookOverview,
  read_selection: readSelection,
  read_range: readRange,
  write_range: writeRange,
  insert_formula: insertFormula,
  create_sheet: createSheet,
  format_range: formatRange,
  create_table: createTable,
  search_workbook: searchWorkbook,
};

export const MUTATING_TOOLS = new Set([
  'write_range',
  'insert_formula',
  'create_sheet',
  'format_range',
  'create_table',
]);

export type ToolRequest = Extract<ClientAiStreamEvent, { type: 'tool_request' }>;

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ status: 'success' | 'error'; output: unknown }> {
  const executor = TOOL_EXECUTORS[toolName];
  if (!executor) return { status: 'error', output: { error: `Unknown tool: ${toolName}` } };
  try {
    return { status: 'success', output: await executor(input) };
  } catch (err) {
    return { status: 'error', output: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export type DispatcherDeps = {
  postToolResult: (result: ToolResultBody) => Promise<void>;
  enqueueApproval: (request: ToolRequest) => void | Promise<void>;
};

export async function dispatchToolRequest(request: ToolRequest, deps: DispatcherDeps): Promise<void> {
  // Defense-in-depth: the server flag is OR-ed with the local set so a server
  // bug can never auto-execute a write.
  const mutating = request.mutating || MUTATING_TOOLS.has(request.toolName);
  if (mutating) {
    await deps.enqueueApproval(request);
    return;
  }
  const { status, output } = await executeTool(request.toolName, request.input);
  await deps.postToolResult({ toolUseId: request.toolUseId, status, output });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/tools`
Expected: 16 tests PASS (2 overview + 3 readRange + 3 writeRange + 3 search + 5 dispatcher). Then `npx tsc --noEmit` — clean (covers the 4 executors without dedicated tests: readSelection, insertFormula, createSheet, formatRange, createTable are additionally exercised through Task 8's approval tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/tools
git commit -m "feat(office-addin): 9 Office.js workbook tool executors + mutating-aware dispatcher" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Approval store + write-preview card (TDD)

Spec §5 write approval: mutating tool requests park in a pending queue; a preview is built by reading the CURRENT target values for a before/after diff (≤200 cells renders a full grid; above that, a one-line summary). Apply → execute via Office.js then POST success/error; Reject → POST `status: 'rejected'` WITHOUT executing. The store is framework-free (immutable snapshots + subscribe, `useSyncExternalStore`-compatible); `WritePreviewCard` is the presentational card (tsc-gated per D6).

**Files:**
- Create: apps/office-addin/src/approval/buildPreview.ts
- Create: apps/office-addin/src/approval/approvalStore.ts
- Create: apps/office-addin/src/components/WritePreviewCard.tsx
- Test: apps/office-addin/src/approval/buildPreview.test.ts
- Test: apps/office-addin/src/approval/approvalStore.test.ts

- [ ] **Step 1: Write the failing tests**

`apps/office-addin/src/approval/buildPreview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { buildWritePreview, PREVIEW_GRID_CELL_CAP } from './buildPreview';

describe('buildWritePreview', () => {
  it('builds a before/after grid with changedCount for small write_range inputs', async () => {
    getOfficeMock().setValues('Sheet1', 'B2', [
      ['old', 'same'],
    ]);
    const preview = await buildWritePreview('write_range', {
      address: 'B2',
      values: [['new', 'same']],
    });
    expect(preview).toEqual({
      kind: 'grid',
      toolName: 'write_range',
      target: 'Sheet1!B2:C2',
      before: [['old', 'same']],
      after: [['new', 'same']],
      changedCount: 1,
    });
  });

  it('falls back to a summary line above the grid cap', async () => {
    const rows = 30;
    const cols = 10; // 300 cells > 200
    expect(rows * cols).toBeGreaterThan(PREVIEW_GRID_CELL_CAP);
    const preview = await buildWritePreview('write_range', {
      address: 'A1',
      values: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x')),
    });
    expect(preview.kind).toBe('summary');
    expect(preview.target).toBe('A1');
    expect((preview as { description: string }).description).toContain('300 cells');
  });

  it('previews insert_formula as a grid of the formula text', async () => {
    getOfficeMock().setValues('Sheet1', 'D1', [[5]]);
    const preview = await buildWritePreview('insert_formula', {
      address: 'D1',
      formula: '=SUM(A1:C1)',
    });
    expect(preview).toMatchObject({
      kind: 'grid',
      target: 'Sheet1!D1',
      before: [[5]],
      after: [['=SUM(A1:C1)']],
      changedCount: 1,
    });
  });

  it('summarizes create_sheet / format_range / create_table', async () => {
    const sheet = await buildWritePreview('create_sheet', { name: 'Report' });
    expect(sheet).toMatchObject({ kind: 'summary', target: 'Report' });
    const fmt = await buildWritePreview('format_range', {
      address: 'A1:B2',
      format: { bold: true },
    });
    expect(fmt).toMatchObject({ kind: 'summary', target: 'A1:B2' });
    expect((fmt as { description: string }).description).toContain('bold');
    const table = await buildWritePreview('create_table', { address: 'A1:C10' });
    expect(table).toMatchObject({ kind: 'summary', target: 'A1:C10' });
  });
});
```

`apps/office-addin/src/approval/approvalStore.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { ApprovalStore } from './approvalStore';
import type { ToolRequest } from '../tools/dispatcher';

function writeRequest(toolUseId = 'tu-w1'): ToolRequest {
  return {
    type: 'tool_request',
    toolUseId,
    toolName: 'write_range',
    input: { address: 'B2', values: [['hello']] },
    mutating: true,
  };
}

function makeStore() {
  const postToolResult = vi.fn(async () => undefined);
  const store = new ApprovalStore({ postToolResult });
  return { store, postToolResult };
}

describe('ApprovalStore', () => {
  it('enqueue builds a preview, exposes an immutable snapshot, and notifies subscribers', async () => {
    const { store } = makeStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getPending().length));
    const before = store.getPending();
    await store.enqueue(writeRequest());
    expect(store.getPending()).toHaveLength(1);
    expect(store.getPending()).not.toBe(before); // new snapshot reference
    expect(store.getPending()[0]).toMatchObject({
      toolUseId: 'tu-w1',
      toolName: 'write_range',
      preview: { kind: 'grid', target: 'Sheet1!B2' },
    });
    expect(seen).toEqual([1]);
  });

  it('apply executes the tool and posts the success result', async () => {
    const { store, postToolResult } = makeStore();
    await store.enqueue(writeRequest());
    await store.apply('tu-w1');
    expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['hello']]);
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w1',
      status: 'success',
      output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
    });
    expect(store.getPending()).toHaveLength(0);
  });

  it('apply posts status:error when execution fails', async () => {
    const { store, postToolResult } = makeStore();
    await store.enqueue({
      type: 'tool_request',
      toolUseId: 'tu-w2',
      toolName: 'create_sheet',
      input: { name: 'Sheet1' }, // already exists → executor error
      mutating: true,
    });
    await store.apply('tu-w2');
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w2',
      status: 'error',
      output: { error: expect.stringContaining('already exists') },
    });
  });

  it('reject posts status:rejected WITHOUT executing', async () => {
    const { store, postToolResult } = makeStore();
    await store.enqueue(writeRequest('tu-w3'));
    await store.reject('tu-w3');
    expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['']]); // untouched
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w3',
      status: 'rejected',
      output: { reason: 'User rejected the change' },
    });
    expect(store.getPending()).toHaveLength(0);
  });

  it('enqueue with unbuildable input posts an immediate error instead of a broken card', async () => {
    const { store, postToolResult } = makeStore();
    await store.enqueue({
      type: 'tool_request',
      toolUseId: 'tu-w4',
      toolName: 'write_range',
      input: { address: 'not-an-address', values: [['x']] },
      mutating: true,
    });
    expect(store.getPending()).toHaveLength(0);
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w4',
      status: 'error',
      output: { error: expect.stringContaining('Unsupported address') },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/approval`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`apps/office-addin/src/approval/buildPreview.ts`:

```ts
/**
 * Write-preview builder (spec §5): reads the CURRENT target values so the
 * Apply/Reject card can show a real before/after diff. ≤200 cells renders the
 * full grid; above that a summary line (reading thousands of cells to draw an
 * unreadable table helps nobody).
 */
import { parseAddress, rangeAddress, stripSheet } from '../lib/address';
import { addressDims, optionalString, requireCellMatrix, requireString, resolveSheet } from '../tools/helpers';
import type { CellValue } from '../api/types';

export const PREVIEW_GRID_CELL_CAP = 200;

export type WritePreview =
  | {
      kind: 'grid';
      toolName: string;
      target: string;
      before: CellValue[][];
      after: CellValue[][];
      changedCount: number;
    }
  | { kind: 'summary'; toolName: string; target: string; description: string };

async function readCurrent(
  sheetName: string | undefined,
  address: string,
  rows: number,
  cols: number,
): Promise<{ qualified: string; values: CellValue[][] }> {
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const parsed = parseAddress(stripSheet(address));
    const range = sheet.getRange(rangeAddress(parsed.startRow, parsed.startCol, rows, cols));
    range.load(['address', 'values']);
    await context.sync();
    return { qualified: range.address, values: range.values as CellValue[][] };
  });
}

function diffCount(before: CellValue[][], after: CellValue[][]): number {
  let changed = 0;
  for (let r = 0; r < after.length; r++) {
    for (let c = 0; c < after[r]!.length; c++) {
      if ((before[r]?.[c] ?? '') !== after[r]![c]) changed++;
    }
  }
  return changed;
}

export async function buildWritePreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<WritePreview> {
  switch (toolName) {
    case 'write_range': {
      const address = requireString(input, 'address');
      const sheetName = optionalString(input, 'sheetName');
      const after = requireCellMatrix(input, 'values');
      const rows = after.length;
      const cols = after[0]!.length;
      if (rows * cols > PREVIEW_GRID_CELL_CAP)
        return {
          kind: 'summary',
          toolName,
          target: address,
          description: `Write ${rows}×${cols} cells (${rows * cols} cells) starting at ${address}`,
        };
      const { qualified, values: before } = await readCurrent(sheetName, address, rows, cols);
      return { kind: 'grid', toolName, target: qualified, before, after, changedCount: diffCount(before, after) };
    }
    case 'insert_formula': {
      const address = requireString(input, 'address');
      const sheetName = optionalString(input, 'sheetName');
      const formula = requireString(input, 'formula');
      const { rows, cols } = addressDims(address);
      if (rows * cols > PREVIEW_GRID_CELL_CAP)
        return {
          kind: 'summary',
          toolName,
          target: address,
          description: `Fill ${address} (${rows * cols} cells) with the formula ${formula}`,
        };
      const after: CellValue[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => formula),
      );
      const { qualified, values: before } = await readCurrent(sheetName, address, rows, cols);
      return { kind: 'grid', toolName, target: qualified, before, after, changedCount: diffCount(before, after) };
    }
    case 'create_sheet': {
      const name = requireString(input, 'name');
      return { kind: 'summary', toolName, target: name, description: `Create a new sheet named "${name}"` };
    }
    case 'format_range': {
      const address = requireString(input, 'address');
      const format = input.format;
      const keys =
        format && typeof format === 'object' && !Array.isArray(format)
          ? Object.keys(format as object).join(', ')
          : '';
      return {
        kind: 'summary',
        toolName,
        target: address,
        description: `Apply formatting (${keys || 'none'}) to ${address}`,
      };
    }
    case 'create_table': {
      const address = requireString(input, 'address');
      return { kind: 'summary', toolName, target: address, description: `Create a table over ${address}` };
    }
    default:
      return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
  }
}
```

`apps/office-addin/src/approval/approvalStore.ts`:

```ts
/**
 * Pending mutating-tool queue. The dispatcher (Task 7) enqueues; the
 * WritePreviewCard resolves via apply()/reject(). Snapshots are immutable and
 * subscribe() fires on every change — useSyncExternalStore-compatible.
 */
import { buildWritePreview, type WritePreview } from './buildPreview';
import { executeTool, type ToolRequest } from '../tools/dispatcher';
import type { ToolResultBody } from '../api/types';

export type PendingApproval = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  preview: WritePreview;
  requestedAt: number;
};

export type ApprovalDeps = {
  postToolResult: (result: ToolResultBody) => Promise<void>;
  /** Injectable for tests; defaults to the real Office.js executor. */
  execute?: typeof executeTool;
};

export class ApprovalStore {
  private queue: readonly PendingApproval[] = [];
  private listeners = new Set<() => void>();

  constructor(private deps: ApprovalDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  getPending(): readonly PendingApproval[] {
    return this.queue;
  }

  async enqueue(request: ToolRequest): Promise<void> {
    let preview: WritePreview;
    try {
      preview = await buildWritePreview(request.toolName, request.input);
    } catch (err) {
      // Malformed input (bad address etc.): tell the model now instead of
      // rendering a broken card the user can't reason about.
      await this.deps.postToolResult({
        toolUseId: request.toolUseId,
        status: 'error',
        output: { error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    this.queue = [
      ...this.queue,
      {
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        preview,
        requestedAt: Date.now(),
      },
    ];
    this.notify();
  }

  private take(toolUseId: string): PendingApproval | null {
    const found = this.queue.find((p) => p.toolUseId === toolUseId) ?? null;
    if (found) {
      this.queue = this.queue.filter((p) => p.toolUseId !== toolUseId);
      this.notify();
    }
    return found;
  }

  /** Apply → execute via Office.js, then report success/error to the server. */
  async apply(toolUseId: string): Promise<void> {
    const pending = this.take(toolUseId);
    if (!pending) return;
    const run = this.deps.execute ?? executeTool;
    const { status, output } = await run(pending.toolName, pending.input);
    await this.deps.postToolResult({ toolUseId, status, output });
  }

  /** Reject → report 'rejected' WITHOUT executing anything. */
  async reject(toolUseId: string, reason = 'User rejected the change'): Promise<void> {
    const pending = this.take(toolUseId);
    if (!pending) return;
    await this.deps.postToolResult({ toolUseId, status: 'rejected', output: { reason } });
  }
}
```

`apps/office-addin/src/components/WritePreviewCard.tsx`:

```tsx
import type { PendingApproval } from '../approval/approvalStore';
import type { CellValue } from '../api/types';

function cellText(value: CellValue | undefined): string {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

export function WritePreviewCard({
  approval,
  onApply,
  onReject,
  busy,
}: {
  approval: PendingApproval;
  onApply: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const { preview } = approval;
  return (
    <div
      className="my-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
      data-testid="write-preview-card"
    >
      <div className="mb-1 font-semibold text-amber-900">
        {approval.toolName} → {preview.target}
      </div>
      {preview.kind === 'summary' ? (
        <p className="mb-2 text-amber-900">{preview.description}</p>
      ) : (
        <div className="mb-2">
          <div className="max-h-48 overflow-auto">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {preview.after.map((row, r) => (
                  <tr key={r}>
                    {row.map((after, c) => {
                      const before = preview.before[r]?.[c];
                      const changed = (before ?? '') !== after;
                      return (
                        <td
                          key={c}
                          className={`border border-amber-200 px-1 py-0.5 ${changed ? 'bg-amber-100' : ''}`}
                        >
                          {changed && cellText(before) !== '' ? (
                            <>
                              <span className="text-gray-400 line-through">{cellText(before)}</span>{' '}
                            </>
                          ) : null}
                          <span className={changed ? 'font-medium text-amber-900' : 'text-gray-600'}>
                            {cellText(after)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1 text-xs text-amber-700">{preview.changedCount} cell(s) will change</div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onApply}
          className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50"
          data-testid="approval-apply"
        >
          Apply
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="rounded border border-gray-300 px-3 py-1 text-gray-700 disabled:opacity-50"
          data-testid="approval-reject"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/approval`
Expected: 9 tests PASS (4 buildPreview + 5 approvalStore). Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/approval apps/office-addin/src/components/WritePreviewCard.tsx
git commit -m "feat(office-addin): approval queue + before/after write-preview with Apply/Reject" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Chat UI — controller, context chip, thread, templates, branding (TDD on the controller)

Spec §11. Per D6, ALL behavior lives in the framework-free `ChatController` (thread state, delta accumulation, banners, draft/template insertion, tool routing into the dispatcher/approval store, history resync) and `captureContext.ts` — both fully unit-tested in jsdom. The React components are thin renderers over controller snapshots (`useSyncExternalStore`) and are gated by tsc + the production build + the Task 11 manual checklist.

Lifecycle: the session is created **lazily on the first send** (`ensureSession`), which also opens the persistent SSE stream — Plan 2's events-GET creates the server-side session, so there is no race.

**Files:**
- Create: apps/office-addin/src/chat/chatController.ts
- Create: apps/office-addin/src/chat/captureContext.ts
- Create: apps/office-addin/src/hooks/useSelectionAddress.ts
- Create: apps/office-addin/src/components/ChatThread.tsx
- Create: apps/office-addin/src/components/Composer.tsx
- Create: apps/office-addin/src/components/TemplatePicker.tsx
- Create: apps/office-addin/src/components/BrandingFooter.tsx
- Create: apps/office-addin/src/components/ChatPane.tsx
- Test: apps/office-addin/src/chat/chatController.test.ts

- [ ] **Step 1: Write the failing test** — `apps/office-addin/src/chat/chatController.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatApi } from './chatController';
import { captureWorkbookContext } from './captureContext';
import { getOfficeMock } from '../__tests__/officeMock';
import { ApiError } from '../api/client';
import type { WorkbookContext } from '../api/types';

function stubApi(overrides: Partial<ChatApi> = {}): ChatApi {
  return {
    createSession: vi.fn(async () => 'sess-1'),
    sendMessage: vi.fn(async () => undefined),
    postToolResult: vi.fn(async () => undefined),
    streamEvents: vi.fn(() => ({ stop: vi.fn() })),
    getSession: vi.fn(async () => ({
      session: {
        id: 'sess-1',
        status: 'active',
        title: null,
        model: 'm',
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostCents: 0,
        createdAt: '',
        lastActivityAt: null,
      },
      messages: [],
    })),
    ...overrides,
  };
}

const SELECTION_CONTEXT: WorkbookContext = {
  kind: 'selection',
  address: 'Sheet1!B2:C3',
  sheetName: 'Sheet1',
  cells: [
    ['Region', 'Q1'],
    ['EMEA', 1200],
  ],
};

describe('ChatController — streaming', () => {
  it('accumulates message_delta text and finalizes one assistant message on turn_complete', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.handleEvent({ type: 'message_delta', text: 'Hello ' });
    controller.handleEvent({ type: 'message_delta', text: 'world' });
    expect(controller.getState().streamingText).toBe('Hello world');
    controller.handleEvent({
      type: 'turn_complete',
      usage: { inputTokens: 10, outputTokens: 5, costCents: 1 },
    });
    const state = controller.getState();
    expect(state.streamingText).toBe('');
    expect(state.busy).toBe(false);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, costCents: 1 });
    expect(state.thread.filter((m) => m.kind === 'assistant')).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Hello world' }),
    ]);
  });

  it('session_error raises the error banner and clears busy', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.handleEvent({ type: 'session_error', message: 'loop exploded' });
    expect(controller.getState().banner).toEqual({ kind: 'error', text: 'loop exploded' });
    expect(controller.getState().busy).toBe(false);
  });

  it('tool_completed appends an activity row with the redaction count and raises a block banner', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.handleEvent({
      type: 'tool_completed',
      toolUseId: 'tu-1',
      toolName: 'read_range',
      status: 'success',
      redactions: [
        { rule: 'creditCard', count: 2, location: 'cell[0][0]' },
        { rule: 'ssn', count: 1, location: 'cell[1][1]' },
      ],
      blockReason: null,
    });
    expect(controller.getState().thread.at(-1)).toMatchObject({
      kind: 'tool',
      toolName: 'read_range',
      status: 'success',
      redactions: 3,
    });
    controller.handleEvent({
      type: 'tool_completed',
      toolUseId: 'tu-2',
      toolName: 'read_range',
      status: 'error',
      redactions: [],
      blockReason: 'dlp_blocked:creditCard',
    });
    expect(controller.getState().banner?.kind).toBe('blocked');
    expect(controller.getState().banner?.text).toContain('dlp_blocked:creditCard');
  });
});

describe('ChatController — send', () => {
  it('lazily creates the session, opens the stream once, and posts the pinned message body', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, captureContext: async () => SELECTION_CONTEXT });
    await controller.send('What does column B total to?');
    await controller.send('And C?');
    expect(api.createSession).toHaveBeenCalledTimes(1); // the busy guard makes the 2nd send a no-op
    expect(api.streamEvents).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith('sess-1', {
      content: 'What does column B total to?',
      workbookContext: SELECTION_CONTEXT,
    });
    expect(controller.getState().thread[0]).toMatchObject({
      kind: 'user',
      text: 'What does column B total to?',
    });
    expect(controller.getState().busy).toBe(true);
  });

  it('surfaces budget rejections as a banner and clears busy', async () => {
    const api = stubApi({
      sendMessage: vi.fn(async () => {
        throw new ApiError(403, 'budget_exceeded');
      }),
    });
    const controller = new ChatController({ api, captureContext: async () => undefined });
    await controller.send('hi');
    expect(controller.getState().busy).toBe(false);
    expect(controller.getState().banner?.text).toContain('budget');
  });

  it('routes mutating tool_requests into the approval queue without posting', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, captureContext: async () => undefined });
    await controller.send('write something'); // establishes sessionId
    controller.handleEvent({
      type: 'tool_request',
      toolUseId: 'tu-w1',
      toolName: 'write_range',
      input: { address: 'B2', values: [['x']] },
      mutating: true,
    });
    await vi.waitFor(() => expect(controller.approvals.getPending()).toHaveLength(1));
    expect(api.postToolResult).not.toHaveBeenCalled();
  });
});

describe('ChatController — draft & templates', () => {
  it('insertTemplate fills an empty draft and appends to a non-empty one', () => {
    const controller = new ChatController({ api: stubApi() });
    controller.insertTemplate('Summarize this sheet.');
    expect(controller.getState().draft).toBe('Summarize this sheet.');
    controller.insertTemplate('Then list outliers.');
    expect(controller.getState().draft).toBe('Summarize this sheet.\n\nThen list outliers.');
  });
});

describe('captureWorkbookContext', () => {
  it("'selection' captures the pinned payload shape from the live selection", async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
    mock.select('Sheet1!B2:C3');
    await expect(captureWorkbookContext('selection')).resolves.toEqual(SELECTION_CONTEXT);
  });

  it("'sheet' captures the used range of the active sheet; 'none' sends kind only", async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['x', 'y']]);
    await expect(captureWorkbookContext('sheet')).resolves.toEqual({
      kind: 'sheet',
      sheetName: 'Sheet1',
      address: 'Sheet1!A1:B1',
      cells: [['x', 'y']],
    });
    await expect(captureWorkbookContext('none')).resolves.toEqual({ kind: 'none' });
  });
});
```

**Note on the double-send assertion:** the second `controller.send('And C?')` is a no-op because `busy` is still true from the first turn — that is the intended guard (one in-flight turn per pane). The assertions verify the session/stream were only set up once for the successful send.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/chat`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the framework-free modules**

`apps/office-addin/src/chat/captureContext.ts`:

```ts
/**
 * Context chip payload (spec §11): the user controls data egress per message.
 *   selection → address + values of the current selection
 *   sheet     → used range of the active sheet
 *   none      → { kind: 'none' } (explicit choice, recorded server-side)
 * Over CONTEXT_CELL_CAP cells, `cells` is omitted (address/sheetName only) —
 * the model can still pull narrower data through read tools.
 */
import { parseAddress } from '../lib/address';
import type { CellValue, WorkbookContext, WorkbookContextKind } from '../api/types';

export const CONTEXT_CELL_CAP = 10_000;

export async function captureWorkbookContext(
  kind: WorkbookContextKind,
): Promise<WorkbookContext | undefined> {
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'selection') {
    return Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load(['address', 'values', 'rowCount', 'columnCount']);
      await context.sync();
      const sheetName = parseAddress(range.address).sheet ?? undefined;
      const payload: WorkbookContext = {
        kind: 'selection',
        address: range.address,
        ...(sheetName ? { sheetName } : {}),
      };
      if (range.rowCount * range.columnCount <= CONTEXT_CELL_CAP)
        payload.cells = range.values as CellValue[][];
      return payload;
    });
  }
  return Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    sheet.load('name');
    const used = sheet.getUsedRangeOrNullObject();
    used.load(['address', 'values', 'rowCount', 'columnCount']);
    await context.sync();
    if (used.isNullObject) return { kind: 'sheet', sheetName: sheet.name };
    const payload: WorkbookContext = { kind: 'sheet', sheetName: sheet.name, address: used.address };
    if (used.rowCount * used.columnCount <= CONTEXT_CELL_CAP)
      payload.cells = used.values as CellValue[][];
    return payload;
  });
}
```

`apps/office-addin/src/chat/chatController.ts`:

```ts
/**
 * Framework-free chat state machine (D6): owns the thread, streaming buffer,
 * banners, composer draft, and tool routing. React renders snapshots via
 * subscribe()/getState() (useSyncExternalStore). The session is created
 * lazily on the first send; the SSE stream opens in the same step.
 */
import {
  ApiError,
  createSession,
  getSession,
  postToolResult,
  sendMessage,
  streamEvents,
  type StreamCallbacks,
  type StreamHandle,
} from '../api/client';
import { dispatchToolRequest, type ToolRequest } from '../tools/dispatcher';
import { ApprovalStore } from '../approval/approvalStore';
import { captureWorkbookContext } from './captureContext';
import type {
  ClientAiStreamEvent,
  SendMessageBody,
  SessionHistory,
  ToolCompletedStatus,
  ToolResultBody,
  TurnUsage,
  WorkbookContext,
  WorkbookContextKind,
} from '../api/types';

export type ChatApi = {
  createSession: () => Promise<string>;
  sendMessage: (sessionId: string, body: SendMessageBody) => Promise<void>;
  postToolResult: (sessionId: string, result: ToolResultBody) => Promise<void>;
  streamEvents: (sessionId: string, callbacks: StreamCallbacks) => StreamHandle;
  getSession: (sessionId: string) => Promise<SessionHistory>;
};

const realApi: ChatApi = { createSession, sendMessage, postToolResult, streamEvents, getSession };

export type ThreadMessage =
  | { kind: 'user'; id: number; text: string; context?: WorkbookContext }
  | { kind: 'assistant'; id: number; text: string }
  | {
      kind: 'tool';
      id: number;
      toolName: string;
      status: ToolCompletedStatus;
      redactions: number;
      blockReason: string | null;
    };

export type ChatState = {
  thread: ThreadMessage[];
  streamingText: string;
  busy: boolean;
  banner: { kind: 'error' | 'blocked'; text: string } | null;
  draft: string;
  contextKind: WorkbookContextKind;
  usage: TurnUsage | null;
};

const ERROR_BANNERS: Record<string, string> = {
  budget_exceeded:
    "Your organization's AI budget for this period has been reached. Contact your IT provider.",
  rate_limited: 'You are sending messages too quickly. Wait a moment and try again.',
  no_session: 'Not signed in. Reload the task pane.',
};

function bannerText(err: unknown): string {
  if (err instanceof ApiError) return ERROR_BANNERS[err.code] ?? `Request failed (${err.code}).`;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export type ChatControllerDeps = {
  api?: ChatApi;
  captureContext?: (kind: WorkbookContextKind) => Promise<WorkbookContext | undefined>;
};

export class ChatController {
  readonly approvals: ApprovalStore;
  private state: ChatState = {
    thread: [],
    streamingText: '',
    busy: false,
    banner: null,
    draft: '',
    contextKind: 'selection',
    usage: null,
  };
  private listeners = new Set<() => void>();
  private sessionId: string | null = null;
  private stream: StreamHandle | null = null;
  private nextId = 1;
  private api: ChatApi;
  private capture: (kind: WorkbookContextKind) => Promise<WorkbookContext | undefined>;

  constructor(deps: ChatControllerDeps = {}) {
    this.api = deps.api ?? realApi;
    this.capture = deps.captureContext ?? captureWorkbookContext;
    this.approvals = new ApprovalStore({
      postToolResult: async (result) => {
        if (!this.sessionId) throw new Error('No active session for tool result');
        await this.api.postToolResult(this.sessionId, result);
      },
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): ChatState {
    return this.state;
  }

  private update(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  setDraft(text: string): void {
    this.update({ draft: text });
  }

  /** Template picker → composer (spec §10: templates land in the input, not auto-sent). */
  insertTemplate(body: string): void {
    this.update({ draft: this.state.draft ? `${this.state.draft}\n\n${body}` : body });
  }

  setContextKind(kind: WorkbookContextKind): void {
    this.update({ contextKind: kind });
  }

  dismissBanner(): void {
    this.update({ banner: null });
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    this.sessionId = await this.api.createSession();
    this.stream = this.api.streamEvents(this.sessionId, {
      onEvent: (event) => this.handleEvent(event),
      onReconnect: () => this.resync(),
      onPermanentError: () =>
        this.update({
          busy: false,
          banner: { kind: 'error', text: 'Connection to Breeze lost. Reload the task pane.' },
        }),
    });
    return this.sessionId;
  }

  async send(content?: string): Promise<void> {
    const text = (content ?? this.state.draft).trim();
    if (!text || this.state.busy) return;
    let workbookContext: WorkbookContext | undefined;
    try {
      workbookContext = await this.capture(this.state.contextKind);
    } catch {
      workbookContext = undefined; // context capture must never block sending
    }
    this.update({
      thread: [
        ...this.state.thread,
        { kind: 'user', id: this.nextId++, text, ...(workbookContext ? { context: workbookContext } : {}) },
      ],
      draft: '',
      busy: true,
      banner: null,
    });
    try {
      const sessionId = await this.ensureSession();
      await this.api.sendMessage(sessionId, {
        content: text,
        ...(workbookContext ? { workbookContext } : {}),
      });
    } catch (err) {
      this.update({ busy: false, banner: { kind: 'error', text: bannerText(err) } });
    }
  }

  /** Moves any streamed text into the thread, optionally appending one more item. */
  private flushStreaming(extra?: ThreadMessage): void {
    const thread = [...this.state.thread];
    if (this.state.streamingText)
      thread.push({ kind: 'assistant', id: this.nextId++, text: this.state.streamingText });
    if (extra) thread.push(extra);
    this.update({ thread, streamingText: '' });
  }

  handleEvent(event: ClientAiStreamEvent): void {
    switch (event.type) {
      case 'message_delta':
        this.update({ streamingText: this.state.streamingText + event.text });
        break;
      case 'turn_complete':
        this.flushStreaming();
        this.update({ busy: false, usage: event.usage });
        break;
      case 'tool_request':
        void this.handleToolRequest(event);
        break;
      case 'tool_completed': {
        this.flushStreaming({
          kind: 'tool',
          id: this.nextId++,
          toolName: event.toolName,
          status: event.status,
          redactions: event.redactions.reduce((n, r) => n + r.count, 0),
          blockReason: event.blockReason,
        });
        if (event.blockReason)
          this.update({
            banner: {
              kind: 'blocked',
              text: `Blocked by your IT provider's data policy (${event.blockReason}).`,
            },
          });
        break;
      }
      case 'session_error':
        this.update({ busy: false, banner: { kind: 'error', text: event.message } });
        break;
      case 'ping':
        break; // server keepalive — nothing to do
    }
  }

  private async handleToolRequest(request: ToolRequest): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return; // events only flow on an open stream, which implies a session
    await dispatchToolRequest(request, {
      postToolResult: (result) => this.api.postToolResult(sessionId, result),
      enqueueApproval: (req) => this.approvals.enqueue(req),
    });
  }

  /** After an SSE reconnect: replace the local thread with server history (already redacted). */
  private async resync(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const history = await this.api.getSession(this.sessionId);
      const thread: ThreadMessage[] = [];
      for (const m of history.messages) {
        if (m.toolName) {
          thread.push({
            kind: 'tool',
            id: this.nextId++,
            toolName: m.toolName,
            status: 'success',
            redactions: 0,
            blockReason: null,
          });
        } else if (m.role === 'user') {
          thread.push({ kind: 'user', id: this.nextId++, text: m.content ?? '' });
        } else if (m.content) {
          thread.push({ kind: 'assistant', id: this.nextId++, text: m.content });
        }
      }
      this.update({ thread, streamingText: '' });
    } catch {
      // keep the local thread when the history fetch fails — better stale than empty
    }
  }

  dispose(): void {
    this.stream?.stop();
    this.stream = null;
  }
}
```

`apps/office-addin/src/hooks/useSelectionAddress.ts`:

```ts
/**
 * Live sheet-qualified selection address via DocumentSelectionChanged.
 * No removeHandlerAsync on unmount: the hook lives in the always-mounted
 * Composer; the `disposed` flag guards late setState.
 */
import { useEffect, useState } from 'react';

export function useSelectionAddress(): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void Excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.load('address');
        await context.sync();
        if (!disposed) setAddress(range.address);
      }).catch(() => undefined);
    };
    refresh();
    const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
    officeGlobal?.context?.document?.addHandlerAsync(
      officeGlobal.EventType.DocumentSelectionChanged,
      refresh,
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, []);
  return address;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/office-addin && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/chat`
Expected: 9 tests PASS.

- [ ] **Step 5: Write the React components** (tsc-gated, D6)

`apps/office-addin/src/components/ChatThread.tsx`:

```tsx
import type { ChatState, ThreadMessage } from '../chat/chatController';
import type { PendingApproval } from '../approval/approvalStore';
import { WritePreviewCard } from './WritePreviewCard';

const TOOL_STATUS_LABEL: Record<string, string> = {
  success: 'ran',
  error: 'failed',
  rejected: 'rejected',
  timeout: 'timed out',
};

function ToolRow({ item }: { item: Extract<ThreadMessage, { kind: 'tool' }> }) {
  return (
    <div className="my-1 flex items-center gap-2 text-xs text-gray-500" data-testid="tool-activity">
      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono">{item.toolName}</span>
      <span>{TOOL_STATUS_LABEL[item.status] ?? item.status}</span>
      {item.redactions > 0 && (
        <span
          className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-700"
          data-testid="redaction-badge"
        >
          {item.redactions} redacted
        </span>
      )}
    </div>
  );
}

export function ChatThread({
  state,
  approvals,
  onApply,
  onReject,
  onDismissBanner,
}: {
  state: ChatState;
  approvals: readonly PendingApproval[];
  onApply: (toolUseId: string) => void;
  onReject: (toolUseId: string) => void;
  onDismissBanner: () => void;
}) {
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {state.thread.map((item) =>
        item.kind === 'user' ? (
          <div key={item.id} className="ml-6 whitespace-pre-wrap rounded-lg bg-blue-600 p-2 text-sm text-white">
            {item.text}
          </div>
        ) : item.kind === 'assistant' ? (
          <div key={item.id} className="mr-6 whitespace-pre-wrap rounded-lg bg-gray-100 p-2 text-sm text-gray-900">
            {item.text}
          </div>
        ) : (
          <ToolRow key={item.id} item={item} />
        ),
      )}
      {state.streamingText && (
        <div
          className="mr-6 whitespace-pre-wrap rounded-lg bg-gray-100 p-2 text-sm text-gray-900"
          data-testid="streaming-message"
        >
          {state.streamingText}
          <span className="animate-pulse">▍</span>
        </div>
      )}
      {approvals.map((approval) => (
        <WritePreviewCard
          key={approval.toolUseId}
          approval={approval}
          onApply={() => onApply(approval.toolUseId)}
          onReject={() => onReject(approval.toolUseId)}
        />
      ))}
      {state.banner && (
        <div
          className={`flex items-start justify-between gap-2 rounded-md border p-2 text-xs ${
            state.banner.kind === 'blocked'
              ? 'border-purple-300 bg-purple-50 text-purple-800'
              : 'border-red-300 bg-red-50 text-red-700'
          }`}
          data-testid="chat-banner"
        >
          <span>{state.banner.text}</span>
          <button type="button" onClick={onDismissBanner} className="font-semibold" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
```

`apps/office-addin/src/components/Composer.tsx`:

```tsx
import { useSelectionAddress } from '../hooks/useSelectionAddress';
import { parseAddress, stripSheet } from '../lib/address';
import type { WorkbookContextKind } from '../api/types';

const CONTEXT_OPTIONS: Array<{ value: WorkbookContextKind; label: string }> = [
  { value: 'selection', label: 'Selection' },
  { value: 'sheet', label: 'Whole sheet' },
  { value: 'none', label: 'No workbook data' },
];

export function Composer({
  draft,
  busy,
  contextKind,
  onDraftChange,
  onContextKindChange,
  onSend,
}: {
  draft: string;
  busy: boolean;
  contextKind: WorkbookContextKind;
  onDraftChange: (text: string) => void;
  onContextKindChange: (kind: WorkbookContextKind) => void;
  onSend: () => void;
}) {
  const selection = useSelectionAddress();
  const sheetName = selection ? parseAddress(selection).sheet : null;
  const chip =
    contextKind === 'none'
      ? 'No workbook data'
      : contextKind === 'sheet'
        ? sheetName
          ? `Sheet: ${sheetName}`
          : 'Whole sheet'
        : selection
          ? `Selection ${stripSheet(selection)}`
          : 'Selection';
  return (
    <div className="border-t border-gray-200 p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700" data-testid="context-chip">
          {chip}
        </span>
        <select
          className="ml-auto rounded border border-gray-200 text-xs"
          value={contextKind}
          onChange={(e) => onContextKindChange(e.target.value as WorkbookContextKind)}
          data-testid="context-select"
        >
          {CONTEXT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder="Ask about this workbook…"
          className="flex-1 resize-none rounded border border-gray-300 p-2 text-sm"
          data-testid="composer-input"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="self-end rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
          data-testid="composer-send"
        >
          Send
        </button>
      </form>
    </div>
  );
}
```

`apps/office-addin/src/components/TemplatePicker.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getTemplates } from '../api/client';
import type { ClientAiTemplate } from '../api/types';

/** Empty-state template picker (spec §10): click inserts the body into the composer. */
export function TemplatePicker({ onPick }: { onPick: (body: string) => void }) {
  const [templates, setTemplates] = useState<ClientAiTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false;
    getTemplates()
      .then((items) => {
        if (!disposed) {
          setTemplates(items);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) setLoaded(true); // templates are sugar — never block chat on them
      });
    return () => {
      disposed = true;
    };
  }, []);
  if (!loaded || templates.length === 0) return null;
  return (
    <div className="p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Templates from your IT provider
      </div>
      <div className="space-y-1">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onPick(template.body)}
            className="block w-full rounded-md border border-gray-200 p-2 text-left text-sm hover:border-blue-400"
            data-testid={`template-${template.id}`}
          >
            <div className="font-medium text-gray-800">{template.name}</div>
            {template.description && <div className="text-xs text-gray-500">{template.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}
```

`apps/office-addin/src/components/BrandingFooter.tsx`:

```tsx
import type { ExchangeBranding } from '../auth/session';

/** spec §11 white-label hook. branding is absent until the server adds it (D2) — graceful fallback. */
export function BrandingFooter({ branding }: { branding: ExchangeBranding | null }) {
  const name = branding?.displayName?.trim() || 'your IT provider';
  return (
    <div
      className="flex items-center justify-center gap-1.5 border-t border-gray-100 py-1.5 text-[11px] text-gray-400"
      data-testid="branding-footer"
    >
      {branding?.logoUrl ? (
        <img src={branding.logoUrl} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" />
      ) : null}
      <span>Powered by {name}</span>
    </div>
  );
}
```

`apps/office-addin/src/components/ChatPane.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ChatController } from '../chat/chatController';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { TemplatePicker } from './TemplatePicker';
import { BrandingFooter } from './BrandingFooter';
import type { ClientSession } from '../auth/session';

export function ChatPane({ session }: { session: ClientSession }) {
  const controller = useMemo(() => new ChatController(), []);
  useEffect(() => () => controller.dispose(), [controller]);

  const state = useSyncExternalStore(
    useCallback((cb: () => void) => controller.subscribe(cb), [controller]),
    () => controller.getState(),
  );
  const approvals = useSyncExternalStore(
    useCallback((cb: () => void) => controller.approvals.subscribe(cb), [controller]),
    () => controller.approvals.getPending(),
  );

  const empty = state.thread.length === 0 && !state.streamingText;

  return (
    <div className="flex h-screen flex-col">
      {empty && <TemplatePicker onPick={(body) => controller.insertTemplate(body)} />}
      <ChatThread
        state={state}
        approvals={approvals}
        onApply={(id) => void controller.approvals.apply(id)}
        onReject={(id) => void controller.approvals.reject(id)}
        onDismissBanner={() => controller.dismissBanner()}
      />
      <Composer
        draft={state.draft}
        busy={state.busy}
        contextKind={state.contextKind}
        onDraftChange={(text) => controller.setDraft(text)}
        onContextKindChange={(kind) => controller.setContextKind(kind)}
        onSend={() => void controller.send()}
      />
      <BrandingFooter branding={session.branding} />
    </div>
  );
}
```

- [ ] **Step 6: Verify the whole app still type-checks and the suite is green**

```bash
cd /Users/toddhebebrand/breeze/apps/office-addin
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run
```

Expected: tsc clean; full suite green (address 8, officeMock 8, auth 10, api 14, tools 16, approval 9, chat 9 ≈ 74 tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/chat apps/office-addin/src/hooks apps/office-addin/src/components
git commit -m "feat(office-addin): chat controller + streamed thread, context chip, templates, branding footer" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: App shell — auth state machine, sign-in/blocked screens, README (verification, no TDD)

Replaces the Task 1 placeholder `App.tsx` with the real phase machine: `loading` → silent SSO attempt → (`signin` screen with MSAL-popup button | `blocked` screens | `ready` → ChatPane). The silent boot path NEVER opens a popup (browsers block popups outside user gestures); the popup only fires from the sign-in button. The session itself is created lazily on the first message (Task 9), so a signed-in pane that never chats costs nothing server-side.

**Files:**
- Modify: apps/office-addin/src/App.tsx (replace the Task 1 placeholder)
- Create: apps/office-addin/src/components/SignInScreen.tsx
- Create: apps/office-addin/README.md

- [ ] **Step 1: Create `apps/office-addin/src/components/SignInScreen.tsx`**

```tsx
export function SignInScreen({ failed, onSignIn }: { failed: boolean; onSignIn: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-base font-semibold text-gray-800">Breeze AI</div>
      <p className="text-sm text-gray-500">
        Sign in with your work account to use the AI assistant for this workbook.
      </p>
      {failed && (
        <p className="text-xs text-red-600" data-testid="signin-error">
          Sign-in didn&apos;t complete. Try again.
        </p>
      )}
      <button
        type="button"
        onClick={onSignIn}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white"
        data-testid="signin-button"
      >
        Sign in with Microsoft
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Replace `apps/office-addin/src/App.tsx`** (Task 1 placeholder) with:

```tsx
/**
 * Auth phase machine (spec §3 + §11):
 *   loading → silent Office SSO → ready
 *                              ↘ blocked (not_provisioned / disabled / no-access / inactive / retryable)
 *                              ↘ signin (silent failed; button triggers SSO→MSAL-popup chain)
 * A stored unexpired session short-circuits straight to ready.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AuthBlockedError,
  getStoredSession,
  signIn,
  type AuthBlockKind,
  type ClientSession,
} from './auth/session';
import { BlockedScreen } from './components/BlockedScreen';
import { SignInScreen } from './components/SignInScreen';
import { ChatPane } from './components/ChatPane';

type Phase =
  | { name: 'loading' }
  | { name: 'signin'; failed: boolean }
  | { name: 'blocked'; kind: AuthBlockKind }
  | { name: 'ready'; session: ClientSession };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    const restored = getStoredSession();
    if (restored) {
      setPhase({ name: 'ready', session: restored });
      return;
    }
    let cancelled = false;
    // Silent path only — popups are blocked outside user gestures.
    signIn({ interactive: false })
      .then((session) => {
        if (!cancelled) setPhase({ name: 'ready', session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AuthBlockedError) setPhase({ name: 'blocked', kind: err.kind });
        else setPhase({ name: 'signin', failed: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const interactiveSignIn = useCallback(() => {
    setPhase({ name: 'loading' });
    signIn({ interactive: true })
      .then((session) => setPhase({ name: 'ready', session }))
      .catch((err: unknown) => {
        if (err instanceof AuthBlockedError) setPhase({ name: 'blocked', kind: err.kind });
        else setPhase({ name: 'signin', failed: true });
      });
  }, []);

  switch (phase.name) {
    case 'loading':
      return (
        <div className="flex h-screen items-center justify-center text-sm text-gray-400">
          Connecting to Breeze…
        </div>
      );
    case 'signin':
      return <SignInScreen failed={phase.failed} onSignIn={interactiveSignIn} />;
    case 'blocked':
      return (
        <BlockedScreen
          kind={phase.kind}
          onRetry={phase.kind === 'retryable' ? interactiveSignIn : undefined}
        />
      );
    case 'ready':
      return <ChatPane session={phase.session} />;
  }
}
```

- [ ] **Step 3: Create `apps/office-addin/README.md`**

````markdown
# Breeze AI for Office — Excel add-in

Task-pane add-in delivering the governed Breeze AI assistant to MSP client
end-users inside Excel. Spec: `docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md`.

## Prerequisites

- Node 22 (`nvm use 22.20.0`) and `pnpm install` from the repo root.
- HTTPS dev certs (Office hosts require https):

  ```bash
  pnpm run certs   # office-addin-dev-certs install — one-time, may prompt for the OS keychain
  ```

- `.env` (copy `.env.example`): `VITE_API_BASE_URL`, `VITE_CLIENT_AI_ENTRA_CLIENT_ID`
  (must equal the API's `CLIENT_AI_ENTRA_CLIENT_ID`), `ADDIN_BASE_URL`.
- The API's `CORS_ALLOWED_ORIGINS` must include this app's origin
  (`https://localhost:3000` for dev).

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Generates icons + `manifest.xml`, serves the pane at `https://localhost:3000` |
| `pnpm build` | Type-check + production build into `dist/` + manifest |
| `pnpm test` | Vitest (jsdom + the Office.js mock in `src/__tests__/officeMock.ts`) |
| `pnpm manifest` | Re-render `manifest.xml` from `manifest.template.xml` + env |
| `pnpm validate-manifest` | `office-addin-manifest validate manifest.xml` |

## Sideloading the generated `manifest.xml`

- **Excel on the web:** Insert ▸ Add-ins ▸ More Add-ins ▸ MY ADD-INS ▸ Upload My Add-in.
- **Excel desktop (macOS):** copy `manifest.xml` to
  `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/` and restart Excel
  (the add-in appears under Insert ▸ My Add-ins ▸ Developer Add-ins).
- **Excel desktop (Windows):** add a shared-folder catalog pointing at the
  directory containing `manifest.xml` (File ▸ Options ▸ Trust Center ▸ Trusted
  Add-in Catalogs), then Insert ▸ My Add-ins ▸ SHARED FOLDER.
- Production distribution is M365 **centralized deployment** by the MSP (spec §2).

## Entra app registration

Silent SSO needs the registration described in the plan (Task 2 prerequisites):
SPA redirect URI `<origin>/taskpane.html`, Application ID URI
`api://<host>/<client-id>`, delegated scope `access_as_user`, the Office client
app `ea5a67f6-b6f3-4338-b240-c655ddc3cc8e` pre-authorized, and **v2.0 access
tokens** (`requestedAccessTokenVersion: 2`). Without pre-authorization, the
add-in falls back to the MSAL popup — functional, just not silent.
````

- [ ] **Step 4: Verify — type-check, full suite, production build**

```bash
cd /Users/toddhebebrand/breeze/apps/office-addin
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH node scripts/make-icons.mjs
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vite build
ls dist/taskpane.html
```

Expected: tsc clean, suite green (~74 tests), build emits `dist/taskpane.html`. Smoke the dev server once more as in Task 1 Step 8 if anything around the entry changed.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/office-addin/src/App.tsx apps/office-addin/src/components/SignInScreen.tsx apps/office-addin/README.md
git commit -m "feat(office-addin): auth phase machine, sign-in/blocked screens, README" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Manual test checklist (no code)

Playwright cannot drive Excel (spec §13) — the in-host behavior is verified by hand against a Plan 1–4 capable API. Work through the numbered list in order on BOTH hosts where marked; record results in the PR description. Prep: a dev Entra tenant mapped via `client_ai_tenant_mappings`, a second unmapped tenant, an org policy you can toggle (`enabled`, `writeMode`, a DLP block rule), and at least one prompt template row.

- [ ] **0. CORS prerequisite** — add the add-in origin (`https://localhost:3000`) to the API's `CORS_ALLOWED_ORIGINS` and restart it. Sanity: a browser-tab fetch from the pane origin to `GET <api>/health` succeeds.
- [ ] **1. Sideload — Excel desktop** — `pnpm dev`, sideload `manifest.xml` (README instructions). Ribbon shows the Breeze AI button; the pane opens and renders past "Connecting to Breeze…".
- [ ] **2. Sideload — Excel on the web** — upload the same manifest. Pane loads over https with no mixed-content/CORS console errors.
- [ ] **3. Silent SSO** — in a tenant with admin consent + the Office client app pre-authorized: open the pane → lands directly in chat with **no** sign-in UI. Verify a `client_ai.auth.exchange` success audit row.
- [ ] **4. MSAL popup fallback** — in a consented tenant WITHOUT Office-client pre-authorization (or a fresh sideload where `getAccessToken` 13012s): pane shows the sign-in screen; the button opens the MSAL popup; completing it lands in chat.
- [ ] **5. Unprovisioned tenant** — sign in from the unmapped tenant: "Not set up yet" screen (`tenant_not_provisioned`), no chat UI.
- [ ] **6. Disabled org** — set the org policy `enabled=false`: pane shows the "Disabled" screen on next sign-in/exchange.
- [ ] **7. Read Q&A on selection** — select a numeric range, context chip shows `Selection <range>`, ask "what do these total to?" → tool activity rows appear for read tools, the streamed answer references the selected data.
- [ ] **8. Sheet-context toggle** — switch the context select to "Whole sheet": chip shows `Sheet: <name>`; send a message and verify (server logs / session viewer) the message carried `workbookContext.kind='sheet'` with used-range cells.
- [ ] **9. Write apply** — ask for a small edit ("put 'Reviewed' in D1"): write-preview card shows the before/after diff; Apply → the cell changes in the grid, the model receives the success result and confirms.
- [ ] **10. Write reject** — repeat with Reject: the workbook is untouched, the model acknowledges the rejection (`status:'rejected'` tool result), no retry loop.
- [ ] **11. Readonly org** — set `writeMode='readonly'`: ask for a write → NO `tool_request` for mutating tools ever arrives (Plan 2 removes write tools from the toolset); the model answers in text only; no approval card renders.
- [ ] **12. Template insert** — with an empty thread, the template picker lists the seeded template; clicking inserts its body into the composer (not auto-sent).
- [ ] **13. DLP block banner** — add a `block`-action DLP rule (e.g. credit cards), put a matching value in a cell, ask the model to read it: `tool_completed` arrives with `blockReason`, the purple "Blocked by your IT provider's data policy" banner renders, and the redaction badge appears on redact-action rules.
- [ ] **14. 401 mid-session re-exchange** — delete the Breeze session token key from Redis while the pane is open, then send a message: the single-flight re-exchange runs silently (one new exchange audit row) and the message succeeds with no visible interruption.
- [ ] **15. Network-loss reconnect** — kill the API (or drop the network) mid-turn, restore within ~30s: the stream reconnects with backoff, history resyncs via `GET /sessions/:id` (no duplicated/garbled thread), and chat continues.
- [ ] **16. Idle ping keepalive** — leave the pane idle 3+ minutes: `ping` frames keep the SSE connection alive (network tab), no error banner, and the next message streams without reconnecting.

---

## Execution order & parallelism notes

Tasks 4 → 7 → 8 → 9 are a strict chain (mock → tools → approvals → controller). Task 5 (auth) and Task 6 (API client) only depend on Tasks 1–3 and can run in parallel with Task 4/7 — except `client.ts` imports `auth/session.ts`, so Task 5 lands before Task 6. Task 10 needs everything; Task 11 needs Plans 1–4 deployed somewhere reachable.
