# AI for Office — Phase 3: Physical Package Split (Implementation Plan)

> **For agentic workers:** execute commit-by-commit. The tree MUST `tsc`-clean and test-green at every commit boundary. Node prefix for every JS command: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. This runs in the `feat/ai-for-office` line (worktree provided at execution time).

**Goal:** Extract the host-neutral add-in code into `packages/office-addin-core` (consumed as TS source, no build step — the `@breeze/shared` model) and rename `apps/office-addin` → `apps/excel-addin` (the host-bound Excel layer that imports the core). No behavior change; pure restructure. Unblocks Phase 4 (a Word app importing the same core).

**Architecture:** Core ships TypeScript source (`main`/`types`/`exports` → `./src/index.ts`, no `dist`), React as **peerDependencies** (one React instance), a single barrel export. Vite/`tsc` consume the core via the pnpm-workspace symlink + a tsconfig `paths` alias — exactly how `apps/web`/`apps/api` consume `@breeze/shared`.

---

## Type-ownership decision (resolves the circular `host/types.ts` ↔ excel dependency)

`host/types.ts` currently type-imports `WritePreview` (from `approval/buildPreview.ts`) and `ToolExecutor` (from `tools/dispatcher.ts`) — both host-bound files. That circular type edge blocks the split. **Fix: relocate both types into core's `api/types.ts`** (which already owns `CellValue`, `WritePreview`'s only dependency); the Excel modules then import them *back* from core. Arrow inverted.

---

## Final directory layout

```
packages/office-addin-core/
  package.json  tsconfig.json  vitest.config.ts
  src/
    index.ts                      # barrel (new)
    config.ts                     # pure Vite env — host-neutral
    api/        client(.test) sse(.test) types          # types.ts gains WritePreview + ToolExecutor
    auth/       entraToken(.test) session(.test)
    lib/        address(.test) markdown(.test)
    approval/   approvalStore(.test)                     # buildPreview.ts STAYS in excel
    chat/       chatController(.test) quickActions(.test)# captureContext.ts STAYS in excel
    hooks/      useSelectionAddress(.test)
    host/       types.ts                                 # interface only; NO excel.ts
    components/ QuickActions Composer ChatThread ChangesPanel MarkdownMessage
                WritePreviewCard ChatToolbar HistoryPanel TemplatePicker
                BlockedScreen BrandingFooter SignInScreen   (+ the 5 .test.tsx)
    index.css
    __tests__/  setup.ts                                 # core setup: sessionStorage.clear + jest-dom ONLY

apps/excel-addin/                 # git mv of apps/office-addin
  package.json tsconfig.json vite.config.ts vitest.config.ts
  manifest.template.xml taskpane.html postcss/tailwind configs .env.example .gitignore
  README.md FOLLOWUPS.md MANUAL_TESTS.md  scripts/*.mjs  public/assets/*
  src/
    App.tsx main.tsx                                     # main.tsx: Office.onReady
    components/ ChatPane.tsx                             # host-binding composition root (injects Excel defaults)
    host/       excel(.test) excelSelection(.test)       # types re-imported from core
    tools/      *.ts (all) + *.test.ts
    approval/   buildPreview(.test)                      # Excel.run — host-bound
    chat/       captureContext.ts  captureContext.test.ts(new)
    __tests__/  officeMock(.test)  setup.ts              # excel setup: core setup + installOfficeMock
```

---

## Commit 0 — decouple in place (NO package boundary yet; tree stays one package, fully green)

Apply ALL of these in `apps/office-addin` first, so the move in Commit 2 is a pure relocation:

1. **Relocate two types into `api/types.ts`:**
   - Cut `export type ToolExecutor = (input: Record<string, unknown>) => Promise<unknown>;` from `tools/dispatcher.ts` → add to `api/types.ts`; in `dispatcher.ts` `import { type ToolExecutor } from '../api/types'` and `export type { ToolExecutor }` (keep existing importers working).
   - Cut the `WritePreview` union from `approval/buildPreview.ts` → add to `api/types.ts` (references `CellValue`, already there); in `buildPreview.ts` `import type { WritePreview } from '../api/types'` and re-export.
   - Repoint `host/types.ts` to `import type { WritePreview, ToolExecutor } from '../api/types'`. → circular edge deleted.
2. **`chatController.ts`: make `host` required, drop the Excel default.** Remove `import { excelHostAdapter } from '../host/excel'` and the `executeTool` import; change `this.host = deps.host ?? excelHostAdapter` → `this.host = deps.host` and make `host` a required ctor field. If `dispatchToolRequest`/`executeTool` are reached, route them via `deps.host`/injected executor (verify each use).
3. **`approvalStore.ts`: make `execute` + `buildPreview` required, drop Excel defaults.** Remove the `buildWritePreview`/`executeTool` imports; replace the `?? executeTool` / `?? buildWritePreview` fallbacks with the required injected deps.
4. **Inject the Excel defaults at the composition root (`ChatPane.tsx`).** Where `ApprovalStore`/`ChatController` are built, pass `host: excelHostAdapter`, `execute: (req) => executeTool(...)`, `buildPreview: buildWritePreview`; import `executeTool` from `../tools/dispatcher` and `buildWritePreview` from `../approval/buildPreview` here.
5. **Rewrite the two boundary tests to inject fakes (drops their `officeMock` dependency):** `approvalStore.test.ts` and the controller-logic half of `chatController.test.ts` pass fake `execute`/`buildPreview`/`host` instead of `getOfficeMock()`. Split the Excel-capture describe-blocks of `chatController.test.ts` (the `captureWorkbookContext`/`captureWorkbookName` cases) OUT into a new `chat/captureContext.test.ts` that keeps `officeMock`.

**Checkpoint C0:** `pnpm --filter @breeze/office-addin test` green + `pnpm --filter @breeze/office-addin exec tsc --noEmit` clean. Commit: `refactor(office-addin): decouple core modules from Excel defaults (DI at the composition root)`.

> After this commit, `grep -rn "Excel\.\|Office\.context\|getOfficeMock\|from '\.\./tools/\|from '\.\./host/excel\|buildWritePreview" apps/office-addin/src/{approval/approvalStore,chat/chatController}.* ` must be empty (those two modules are now host-clean).

---

## Commit 1 — rename app → `apps/excel-addin`

1. `git mv apps/office-addin apps/excel-addin` (carries vite/vitest/tsconfig, manifest, scripts, public, READMEs, etc.).
2. **Manually carry the gitignored `.env`** (`cp` if a local one exists) — `git mv` skips it; without it `predev`→`generate-manifest.mjs` emits a placeholder-GUID manifest and SSO silently fails. **#1 silent-break trap.**
3. Edit `apps/excel-addin/package.json`: `"name": "@breeze/office-addin"` → `"@breeze/excel-addin"`. **Do NOT touch** the third-party `office-addin-dev-certs` / `office-addin-manifest` deps/scripts or the `~/.office-addin-dev-certs` path.
4. `pnpm install` (regenerates `pnpm-lock.yaml` importer key + symlinks; never hand-edit the lock).

**Checkpoint:** `pnpm --filter @breeze/excel-addin test` green (app still self-contained, no core yet). Commit: `refactor(office-addin): rename apps/office-addin → apps/excel-addin`.

---

## Commit 2 — create core, move 45 files, rewrite imports, wire build config

1. **Scaffold `packages/office-addin-core`** — the four literal files below.
2. **`git mv` the core files** from `apps/excel-addin/src` → `packages/office-addin-core/src`: all `api/*`, `auth/*`, `lib/*`, `config.ts`, `host/types.ts`, `approval/approvalStore.ts(+test)`, `chat/chatController.ts(+test)`, `chat/quickActions.ts(+test)`, `hooks/useSelectionAddress.ts(+test)`, `index.css`, and the 12 neutral components (+ their 5 `.test.tsx`). **Keep in excel:** all `tools/*`, `host/excel*.ts(+test)`, `approval/buildPreview.ts(+test)`, `chat/captureContext.ts(+test)`, `components/ChatPane.tsx`, `App.tsx`, `main.tsx`, `__tests__/officeMock.ts(+test)`, excel `__tests__/setup.ts`.
3. **Split `setup.ts`:** core gets the mock-free version (below); excel's `__tests__/setup.ts` imports nothing from core and keeps `installOfficeMock()` + `sessionStorage.clear()`.
4. **Wire excel→core consumption:** add `"@breeze/office-addin-core": "workspace:*"` to `apps/excel-addin/package.json` deps; move `dompurify`/`marked` out of excel deps (transitive via core); add the core `paths` alias to `apps/excel-addin/tsconfig.json` (`"baseUrl": "."`, `"paths": { "@breeze/office-addin-core": ["../../packages/office-addin-core/src"] }`); add `resolve.alias` to `apps/excel-addin/vitest.config.ts`; add `server.fs.allow: ['../../packages/office-addin-core', '../..']` and `resolve.dedupe: ['react','react-dom']` to `apps/excel-addin/vite.config.ts`.
5. **Rewrite excel→core imports** (§ import-rewrite rule below).
6. `pnpm install`.

### Scaffold files (literal)

`packages/office-addin-core/package.json`:
```json
{
  "name": "@breeze/office-addin-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest", "typecheck": "tsc --noEmit" },
  "dependencies": { "dompurify": "^3.4.10", "marked": "^18.0.5" },
  "peerDependencies": { "react": "^19.2.7", "react-dom": "^19.2.7" },
  "devDependencies": {
    "@testing-library/react": "^16.3.2",
    "@types/office-js": "^1.0.460",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "jsdom": "^29.1.1",
    "typescript": "^5.7.2",
    "vitest": "^4.1.8"
  }
}
```
> `@types/office-js` in **devDeps** (not host types) because core's `auth/entraToken.ts` references the cross-host `OfficeRuntime.auth` global at compile time. Core never imports `Excel.*`.

`packages/office-addin-core/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "useDefineForClassFields": true,
    "types": ["office-js", "vitest/globals"]
  },
  "include": ["src"]
}
```
> If `tsc` complains about `import.meta.env` in `config.ts`, add `"vite/client"` to `types`.

`packages/office-addin-core/vitest.config.ts`:
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

`packages/office-addin-core/src/__tests__/setup.ts` (host-neutral — NO office mock):
```ts
import { beforeEach } from 'vitest';
import '@testing-library/jest-dom';

beforeEach(() => {
  sessionStorage.clear();
});
```

`packages/office-addin-core/src/index.ts` (barrel — verify exact symbol names against each module's exports during the move):
```ts
export type { HostAdapter } from './host/types';
export type { WorkbookContext, WorkbookContextKind, CellValue, WritePreview, ToolExecutor } from './api/types';
export * from './config';
export * from './api/client';
export * from './api/sse';
export * from './auth/entraToken';
export * from './auth/session';
export * from './approval/approvalStore';
export * from './chat/chatController';
export * from './chat/quickActions';
export { useSelectionAddress } from './hooks/useSelectionAddress';
export { QuickActions } from './components/QuickActions';
export { Composer } from './components/Composer';
export { ChatThread } from './components/ChatThread';
export { ChangesPanel } from './components/ChangesPanel';
export { MarkdownMessage } from './components/MarkdownMessage';
export { WritePreviewCard } from './components/WritePreviewCard';
export { ChatToolbar } from './components/ChatToolbar';
export { HistoryPanel } from './components/HistoryPanel';
export { TemplatePicker } from './components/TemplatePicker';
export { BlockedScreen } from './components/BlockedScreen';
export { BrandingFooter } from './components/BrandingFooter';
export { SignInScreen } from './components/SignInScreen';
export * from './lib/address';
export * from './lib/markdown';
```

### Import-rewrite rule
- **Intra-core** (both ends moved together): relative imports unchanged.
- **Excel→core** (a file staying in `apps/excel-addin/src` that imports a moved module — `../api/*`, `../auth/*`, `../lib/*`, `../config`, `../approval/approvalStore`, `../chat/chatController`, `../chat/quickActions`, `../hooks/*`, `../host/types`, or a moved `../components/*`): rewrite the specifier to `'@breeze/office-addin-core'` (named import from the barrel). Specifically: `host/excel.ts` → `import type { HostAdapter, WritePreview, ToolExecutor } from '@breeze/office-addin-core'`; `approval/buildPreview.ts` → `import type { WritePreview, CellValue } from '@breeze/office-addin-core'`; `tools/dispatcher.ts` → `import type { ToolExecutor } from '@breeze/office-addin-core'`.
- **Apply grep-driven, per-hit (NOT a blind `sed`)** — `App.tsx`/`ChatPane.tsx` import a MIX of moved and kept modules; a global replace would corrupt kept-module imports. Drive off the grep `file:line` list; `tsc` catches any miss (hard error).
  ```bash
  grep -rnE "from '\.\.?/(api|auth|lib|hooks|config)" apps/excel-addin/src
  grep -rnE "from '\.\.?/(approval/approvalStore|chat/chatController|chat/quickActions|host/types)'" apps/excel-addin/src
  grep -rnE "from '\.\.?/components/(QuickActions|Composer|ChatThread|ChangesPanel|MarkdownMessage|WritePreviewCard|ChatToolbar|HistoryPanel|TemplatePicker|BlockedScreen|BrandingFooter|SignInScreen)'" apps/excel-addin/src
  # rewrite each hit → '@breeze/office-addin-core'; re-run until zero hits.
  ```

**Checkpoints (all must pass):**
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm install
pnpm --filter @breeze/office-addin-core test            # A
pnpm --filter @breeze/excel-addin test                  # B
pnpm --filter @breeze/excel-addin build                 # C (tsc --noEmit && vite build && manifest)
pnpm --filter @breeze/office-addin-core typecheck       # D
npx tsc --noEmit                                        # E (root; add core to root tsconfig paths if it complains)
grep -rn officeMock packages/office-addin-core           # MUST be empty
```
Commit: `refactor(office-addin): extract packages/office-addin-core; excel-addin imports the core`.

---

## Commit 3 — docs + CI

1. Doc path updates: `FOLLOWUPS.md` Phase-3 → `[x]` + paths → `apps/excel-addin`; `docs/superpowers/plans/ai-mcp/2026-06-13-ai-for-office-multihost.md` (mark Phase 3 done); `docs/.../2026-06-12-ai-for-office-1-foundation.md`, `docs/.../specs/2026-06-12-breeze-ai-for-office-design.md`, `docs/testing/FEATURE_TEST_LOG.md` path refs. Do NOT mass-rewrite the historical `2026-06-12-ai-for-office-5-excel-addin.md`.
2. **CI (R7 — the largest latent risk):** the office-addin suite NEVER ran in CI. Add `test-office-addin-core` + `test-excel-addin` jobs to `.github/workflows/ci.yml` running `pnpm --filter <pkg> test` (mirror an existing `test-web`-style job). The core backs every future host — leaving it ungated is the biggest risk.
3. **Leave untouched** (not packages/paths): `apps/web/.../OrgsTab.tsx` product prose "Office add-in"; `apps/api/.../clientAiTools.handler.test.ts` user-agent fixture `'office-addin'`.

Commit: `chore(office-addin): docs + CI for the excel-addin / office-addin-core split`.

---

## Top risks + mitigations

- **R1 Duplicate React (Invalid hook call).** Core hooks crash with two React copies. → React as core **peerDependencies** (never deps); `resolve.dedupe: ['react','react-dom']` in excel vite config. First React-lib-consumed-by-an-app in this repo (no precedent).
- **R2 Vite dev 403 on core source** (outside the app root). → `server.fs.allow: ['../../packages/office-addin-core','../..']`. Do NOT add core to `optimizeDeps` (breaks HMR).
- **R3 officeMock leaking into core.** → Commit 0 rewrites the two boundary tests to inject fakes; `officeMock` stays in excel; core ships a mock-free `setup.ts`. Guard: `grep -rn officeMock packages/office-addin-core` empty.
- **R4 Circular type dep.** → relocate `WritePreview`+`ToolExecutor` to core `api/types.ts` (Commit 0).
- **R5 Blind import-rewrite corrupts kept imports.** → grep-driven per-hit edits; `tsc` catches misses.
- **R6 Lost `.env` / placeholder manifest.** → manual `.env` carry in Commit 1; verify generated `manifest.xml` has the real GUID.
- **R7 Core ships untested in CI.** → add CI jobs (Commit 3).
- **R8 `pnpm-lock.yaml` drift.** → regenerate via `pnpm install`; never hand-edit.
- **R9 Core typecheck fails on `OfficeRuntime` (entraToken.ts).** → keep `@types/office-js` in core devDeps + `"office-js"` in core tsconfig `types`. Core is "Office-platform-neutral", not "any-host-neutral" — intended.
