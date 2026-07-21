# AI for Office — Phase 4: Baseline Word Adapter (Implementation Plan)

> **For agentic workers:** execute step-by-step; each step ends with a green checkpoint. Node prefix for every JS command: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. The API suite is parallel-flaky — scope client-ai runs to the named files.

**Goal:** Prove the multi-host seam with a real second host. Server-side: populate the Word tool registry + prompt so `host:'word'` is creatable (additive — host-keying already shipped in Phase 1). Add-in: a new `apps/word-addin` that is a *pure shell* importing the shared core, with a Word `HostAdapter` (5 baseline tools). Move `App`/`ChatPane` into the core (parameterized by `host`) so the pane shell is shared fix-once.

**Architecture:** Each per-host app collapses to `main.tsx` (`Office.onReady` → `<App host={adapter} clientHost="…"/>`) + the `HostAdapter` impl + host-specific tool/capture/preview files. All shell logic (auth phase machine, ChatPane, controller, components) lives in `@breeze/office-addin-core`.

## Locked decisions (from discovery synthesis)
1. **Shell → core, host-parameterized.** `ChatPane` has exactly one Excel import (`excelHostAdapter`); `App.tsx` has zero Excel coupling. Move both to core taking `host: HostAdapter` (+ `clientHost: ClientHost`) props.
2. **Two text paths, both minimal:** read-tool **output** returns user text under `cells: string[][]` (one paragraph/row) — REQUIRED for the per-cell DLP scan (`clientAiTools.ts` gate is `Array.isArray(output.cells)`); per-message **context chip** needs a new additive `WorkbookContext.text?` (Word context has no grid).
3. **Client `host` threading is mandatory** — without it the Word pane POSTs no host → server defaults `'excel'` → Excel prompt/registry the Word pane can't execute. Thread `clientHost` through `createSession`/`listSessions`.
4. **`buildPreview` for Word = `summary` variant** (already exists in `WritePreview`; no core change).
5. **`requireString`/`optionalString`/`ToolInputError` promoted to core** (host-neutral); Excel's `parseAddress`/`resolveSheet`/cell-cap stay Excel-only.

---

## Execution shape: two parallel lanes (disjoint files)
- **Lane A — SERVER** (`apps/api`): Steps 4 + 5. Self-contained (the seam proof mocks the SDK boundary; no add-in needed).
- **Lane B — CORE + WORD APP** (`packages/office-addin-core`, `apps/excel-addin`, `apps/word-addin`): Steps 1 → 2 → 3 → 6 → 7 (sequential).
- After both merge: Step 8 (CI) + final whole-repo verification.

---

## STEP 1 — CORE: generalize `WorkbookContext`, add `ClientHost`, promote helpers
Files: `packages/office-addin-core/src/api/types.ts`, new `packages/office-addin-core/src/tools/helpers.ts`, `index.ts`, `apps/excel-addin/src/tools/helpers.ts`.
1. `api/types.ts`: add `text?: string` to `WorkbookContext` (additive; Excel never sets it). Add `export const CLIENT_HOSTS = ['excel','word','powerpoint','outlook'] as const; export type ClientHost = (typeof CLIENT_HOSTS)[number];` and `export type CreateSessionBody = { workbookName?: string; host?: ClientHost };`.
2. `tools/helpers.ts` (new): move `requireString`, `optionalString`, `ToolInputError` verbatim from `apps/excel-addin/src/tools/helpers.ts` (leave Excel's `parseAddress`/`resolveSheet`/cell-cap there).
3. `index.ts`: export `CLIENT_HOSTS`, `ClientHost`, `CreateSessionBody`, and `export * from './tools/helpers'`.
4. `apps/excel-addin/src/tools/helpers.ts`: re-export the three from `@breeze/office-addin-core` so Excel tool files need no edits.

Checkpoint: `pnpm --filter @breeze/office-addin-core run typecheck && pnpm --filter @breeze/office-addin-core test && pnpm --filter @breeze/excel-addin test`.

## STEP 2 — CORE: thread `host` through client + controller (TDD)
Files: `packages/office-addin-core/src/api/client.ts`, `chat/chatController.ts`, `chat/chatController.test.ts`.
1. `client.ts`: `createSession` already serializes `body` (now optionally carrying `host`); add `host?: ClientHost` to `listSessions(host?, fetchImpl?)` → `?host=<host>` query.
2. `chatController.ts`: add `clientHost: ClientHost` to `ChatControllerDeps` (distinct name from the `host: HostAdapter` dep — avoid collision), default `'excel'`. Thread it: `ensureSession()` → `createSession({ host: this.clientHost, ...(workbookName?{workbookName}:{}) })`; `listSessions()` → `listSessions(this.clientHost)`. Update the `ChatApi` type's `listSessions` signature.
3. Test: `new ChatController({ host: fakeAdapter, clientHost: 'word', api: stubApi() })`; assert `createSession` called with `{host:'word'}` and `listSessions` with `'word'`. (Reuse the existing `stubApi`/fake-host pattern.)

Checkpoint: core test + typecheck + excel test.

## STEP 3 — CORE: move App + ChatPane into core, host-parameterized (TDD)
Files: new `packages/office-addin-core/src/components/{App,ChatPane}.tsx` (+ tests), `index.ts`; delete `apps/excel-addin/src/App.tsx` + `apps/excel-addin/src/components/ChatPane.tsx`; update `apps/excel-addin/src/main.tsx`.
1. `ChatPane.tsx` → core. Signature `{ session: ClientSession; host: HostAdapter; clientHost: ClientHost }`. Delete the `excelHostAdapter` import; replace the 4 use sites with `host.*` / `clientHost`: `new ChatController({ host, clientHost })`, `capture={host.captureContext.bind(null,'selection')}`, `captureSelectionAddress={host.captureSelectionAddress}`, `subscribeSelectionChanged={host.subscribeSelectionChanged}`. Switch barrel imports to **relative** core paths; import `HostAdapter` from `../host/types`.
2. `App.tsx` → core. Signature `{ host: HostAdapter; clientHost: ClientHost }`. Phase machine verbatim; `import { ChatPane } from './ChatPane'`; render `<ChatPane session={phase.session} host={host} clientHost={clientHost} />`. Auth imports → relative core paths.
3. `index.ts`: `export { App } from './components/App'; export { ChatPane } from './components/ChatPane';`.
4. Core tests (new) injecting a fake `HostAdapter` + stub `ChatApi`: App renders sign-in when no stored session; ChatPane mounts a controller and the selection chip calls `host.captureSelectionAddress`.
5. Thin Excel app: delete its `App.tsx`/`ChatPane.tsx`; `main.tsx` → `import { App } from '@breeze/office-addin-core'; import { excelHostAdapter } from './host/excel'; root.render(<React.StrictMode><App host={excelHostAdapter} clientHost="excel"/></React.StrictMode>)` (keep the `Office.onReady`/fallback wrapper).

Checkpoint: core test + typecheck + excel test (regression gate).

## STEP 4 — SERVER: Word registry + system prompt, flip host support (TDD)
Files: `apps/api/src/services/clientAiTools.ts`, `clientAiSessions.ts`, `clientAiTools.registry.test.ts`, `clientAiSessions.test.ts`.
1. Tests FIRST: in `registry.test.ts` split the empty-registries test so `powerpoint`/`outlook` stay length 0 / unsupported, and add a `describe('word')` pinning 5 tool names, 3 mutating (`insert_text`,`format_text`,`find_replace`), `clientMcpToolNamesForWriteMode('word','readonly')` length 2, all `mcp__word__`-prefixed; leave all excel pins untouched. In `clientAiSessions.test.ts` change the fail-loud host from `'word'` to `'powerpoint'`; add positive Word prompt pins + `buildClientSystemPrompt('word',…)`.
2. `clientAiTools.ts`: add `WORD_CLIENT_TOOL_REGISTRY` (5 tools, `satisfies Record<string, ClientWorkbookTool>`); flip `word: {}` → `word: WORD_CLIENT_TOOL_REGISTRY`. `isClientHostSupported('word')` auto-flips.
3. `clientAiSessions.ts`: add+export `WORD_CLIENT_SYSTEM_PROMPT`; register `word:` in `CLIENT_SYSTEM_PROMPTS`.

**Wire-contract key table (server `inputSchema` key ≡ client executor read key — byte-identical):**

| Tool | Mutating | Server `inputSchema` keys |
|---|---|---|
| `get_document_overview` | no | `{}` |
| `read_selection` | no | `{}` |
| `insert_text` | yes | `text` (str), `location` (enum `Replace`/`Start`/`End`/`Before`/`After`) |
| `format_text` | yes | `format` (object: `bold?`/`italic?`/`underline?` bool, `fontColor?` str, `fontSize?` num) |
| `find_replace` | yes | `query` (str), `replace` (str), `matchCase?` bool, `matchWholeWord?` bool |

> Both registry flip AND prompt registration are required in the SAME commit — `createSession` checks `isClientHostSupported` (registry only) then calls `buildClientSystemPrompt` which **throws 500 without a prompt**.

Checkpoint: `pnpm --filter @breeze/api test -- src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts`.

## STEP 5 — SERVER: end-to-end seam proof (TDD)
File: `apps/api/src/routes/clientAi/sessions.test.ts` (extend).
1. POST `/client-ai/sessions` `{host:'word'}` → 201, stored type `word_client`, prompt = `WORD_CLIENT_SYSTEM_PROMPT`. POST `{host:'powerpoint'}` → 400 `unsupported_host`.
2. Mutating Word tool round-trip: drive a `tool_request` for `insert_text` through the session loop; assert `mutating:true`, MCP name `mcp__word__insert_text`, and a posted `tool-result` resolves the parked request (reuse the Excel `write_range` round-trip harness).

Checkpoint: `pnpm --filter @breeze/api test -- src/routes/clientAi/sessions.test.ts src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts`.

## STEP 6 — WORD-ADDIN: scaffold the app shell
New `apps/word-addin/`. After creating, `pnpm install` and commit the regenerated `pnpm-lock.yaml` (CI uses `--frozen-lockfile`).
- `package.json`: copy Excel's verbatim except `"name": "@breeze/word-addin"`.
- Copy verbatim from `apps/excel-addin`: `postcss.config.js`, `tailwind.config.js`, `tsconfig.json`, `vitest.config.ts`, `taskpane.html`, `src/index.css`, `src/__tests__/setup.ts`, `scripts/*.mjs`, `.gitignore`, `.env.example`.
- `vite.config.ts`: copy Excel's, change `server.port` → `3002` (keep strictPort/https/dedupe/`server.fs.allow`/the `/api/v1`→`:3001` proxy).
- `manifest.template.xml`: copy Excel's with: `<Host Name="Document"/>`, VersionOverrides `<Host xsi:type="Document">`, Description/Tooltip Excel→Word, **a distinct `ADDIN_MANIFEST_ID` GUID** (reusing Excel's makes Office cache them as one add-in). `WebApplicationInfo`/Entra byte-identical; `Permissions` `ReadWriteDocument`.
- `src/main.tsx`: `import { App } from '@breeze/office-addin-core'; import { wordHostAdapter } from './host/word'; root.render(<React.StrictMode><App host={wordHostAdapter} clientHost="word"/></React.StrictMode>)`.
- `src/__tests__/officeMock.ts` (new — Excel's grid mock is 0% reusable). Minimal linear-text Word surface with the SAME faithfulness discipline (reads throw before `context.sync()`; writes apply at sync; `Word.run` does one trailing sync; same `installOfficeMock()`/`getOfficeMock()` exports so the copied `setup.ts` works):
  - `Word.run(cb)`; `MockWordContext` with `.document` + `.sync()` (increments `syncCount`).
  - `document.getSelection()→MockRange`; `document.body→MockBody`; `MockRange`/`MockBody`: `.text` (load-gated), `.font` (settable bold/italic/underline/color/size → recorded), `.insertText(text,location)`, `.search(q,opts)→collection` (load-gated `.items`), `.paragraphs` (load items/text), `.load(props)`.
  - `Word.InsertLocation` (`replace/start/end/before/after`), `Word.SearchOptions`/`Word.UnderlineType` shapes.
  - Reuse Excel's `Office` block: `Office.onReady → {host:'Word'}`, `EventType.DocumentSelectionChanged`, `addHandlerAsync`/`removeHandlerAsync`, `isSetSupported('WordApi',…)→true`, `OfficeRuntime.auth` verbatim.
  - Seam helpers: `setBody(text)`, `select(start,end)` (fires selection handlers), `selectedText()`, inspect `formats`/`syncCount`.

Checkpoint: `pnpm install && pnpm --filter @breeze/word-addin test` (passWithNoTests until Step 7).

## STEP 7 — WORD-ADDIN: tools + HostAdapter (TDD)
New files under `apps/word-addin/src/`. Tests first against the Word officeMock.
- `tools/getDocumentOverview.ts` (read): `body.load('text')` + `paragraphs.load('items/text')`; return `{ paragraphCount, wordCount, truncated, cells }`, `cells = paras.slice(0,CAP).map(t=>[t])`.
- `tools/readSelection.ts` (read): `getSelection()` text+paragraphs; return `{ paragraphCount, isEmpty, cells }` (selection text under `cells`, one paragraph/row). **Text under any other key downgrades DLP.**
- `tools/insertText.ts` (mutating): `requireString(input,'text')`, `requireString(input,'location')` validated against the 5 enum values; `sel.insertText(text, location.toLowerCase() as Word.InsertLocation)`; return `{ inserted, location, charactersInserted }`.
- `tools/formatText.ts` (mutating): validate `input.format` is an object; map `bold/italic`→`font.bold/italic`, `underline`→`font.underline = bool ? 'Single' : 'None'` (UnderlineType, NOT bool), `fontColor`→`font.color`, `fontSize`→`font.size`; throw `ToolInputError` if no supported keys; return `{ applied:[...] }`.
- `tools/findReplace.ts` (mutating): `requireString(input,'query')`, `input.replace` (default `''`), `input.matchCase===true`, `input.matchWholeWord===true`; `body.search(query,{matchCase,matchWholeWord})`, load items, `match.insertText(replace,'replace')`; return `{ query, replaced }`.
- `tools/dispatcher.ts`: `WORD_TOOL_EXECUTORS` (5), `WORD_MUTATING_TOOLS = new Set(['insert_text','format_text','find_replace'])`.
- `host/wordSelection.ts`: `captureWordSelectionLabel()` (one-shot `Word.run` selection text snippet or `undefined`; never throws), `subscribeWordSelectionChanged(cb)` (Office.context document `DocumentSelectionChanged`, no-op unsubscribe).
- `chat/captureContext.ts`: `captureWordContext(kind)` — `none`→`{kind:'none'}`, `selection`→`{kind:'selection', text:<sel>}`, `sheet`→`{kind:'sheet', text:<body>}` (reuse `'sheet'` as "whole document", comment it); `captureWordDocumentName()` (try/catch → name or undefined).
- `approval/buildPreview.ts`: `buildWordPreview(toolName,input)` → `{kind:'summary', toolName, target, description}` for all 3 mutating tools.
- `host/word.ts`: assemble `wordHostAdapter: HostAdapter` from the above (all 7 members).
- Tests: per-tool against the mock (cells shape; insert mutates after sync; bad location rejected; format records font patches; find_replace replaces all; overview counts) + an adapter test (all 7 members; `buildWordPreview` summary for each mutating tool) + `officeMock.test.ts` (faithfulness contract).

Checkpoint: `pnpm --filter @breeze/word-addin test && pnpm --filter @breeze/word-addin exec tsc --noEmit`.

## STEP 8 — CI: `test-word-addin` job (after both lanes merge)
File: `.github/workflows/ci.yml`. Clone `test-excel-addin` as `test-word-addin` (`run: pnpm test --filter=@breeze/word-addin` + a `tsc --noEmit` step). Add to `ci-success` `needs`, the summary env (`TEST_WORD_ADDIN_RESULT`), and the pass/fail assertion.

---

## FINAL GREEN CHECKPOINTS
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/office-addin-core test && pnpm --filter @breeze/office-addin-core run typecheck
pnpm --filter @breeze/excel-addin test
pnpm --filter @breeze/word-addin test && pnpm --filter @breeze/word-addin exec tsc --noEmit
pnpm --filter @breeze/api test -- src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts src/routes/clientAi/sessions.test.ts
pnpm exec tsc --noEmit   # root (expect only the 1 pre-existing shared ticketConfig error)
```
**Seam proof:** a `word_client` session creates via `POST {host:'word'}` AND `insert_text` round-trips with `mcp__word__` prefix + `mutating:true`, asserted in `sessions.test.ts`.

## TOP RISKS → mitigations
1. **Client never sends `host`** → Word pane served Excel. → Step 2 threads `clientHost`; tests assert it. **Highest-impact fix.**
2. **`isClientHostSupported` checks registry only, not prompt** → 500 on create if registry flipped without prompt. → Step 4 registers both in the same commit; Step 5 asserts 201 vs 400.
3. **Read-tool text under wrong key downgrades DLP** (`cells` gate). → read tools return `cells: string[][]`; tests assert shape.
4. **Wire-key drift** (the `cells`-vs-`values` no-op bug). → Step 4 key table + Step 5 round-trip test exercises real keys.
5. **Moving App/ChatPane regresses Excel** (StrictMode, relative imports, selection chip). → Step 3 keeps phase machine verbatim + core tests + Excel suite as regression gate; revertible per-commit.
6. **`--frozen-lockfile` CI failure** for the new package. → Step 6 commits the regenerated lockfile.
7. **Duplicate add-in GUID** (Word reusing Excel's) → Office caches as one. → distinct GUID in Step 6.
8. **Word officeMock infidelity** masking missing-`load()`/`sync()`. → mock enforces read-throws-before-sync; `officeMock.test.ts` pins it.
9. **`Word.UnderlineType` vs boolean** → naive `font.underline = true` is wrong. → executor maps bool→`'Single'`/`'None'`; test asserts.

Non-risks (verified): `WritePreview.summary` exists (no preview core change); baseline Word APIs are WordApi 1.1 (no `isSetSupported` gate); `word_client` + the host CHECK constraint already shipped (migration `2026-06-13-d`); `@types/office-js` carries `Word.*` (no new dep).
