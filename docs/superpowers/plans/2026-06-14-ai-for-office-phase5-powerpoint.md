# AI for Office — Phase 5: PowerPoint Adapter (Implementation Plan)

> Node prefix for every JS command: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Commit per step; each ends green. API suite is parallel-flaky — scope client-ai runs to named files.

**Goal:** Add PowerPoint as the 3rd populated host (document-model, mirrors Word). PowerPoint fits the shared core **unchanged** (no App/Composer edits — unlike Outlook). Also lands a shared server fix (the `wb.text` ingress gap) that benefits Word too.

**Decision:** sequence before Outlook (shared server test files use a relay-baton: the fail-loud/unsupported-host assertions point at a still-unsupported host; PPT-first keeps Outlook as that baton).

## Execution: two parallel lanes (disjoint files)
- **Lane P-SERVER** (`apps/api`): the shared `wb.text` fix + PowerPoint registry/prompt + test flips + seam proof.
- **Lane P-APP** (`apps/powerpoint-addin` + trivial core `main.tsx` wiring): the app shell + PowerPoint HostAdapter + 5 tools + officeMock.
Plus, after both merge: CI jobs.

---

## P-SERVER

### S1 — Shared `wb.text` ingress + DLP fix (benefits Word/PPT/Outlook) (TDD)
Files: `apps/api/src/routes/clientAi/schemas.ts`, `apps/api/src/routes/clientAi/sessions.ts`.
**Confirmed bug:** `workbookContextSchema` (schemas.ts:~135) has no `text` field and isn't `.strict()`, so the client's `WorkbookContext.text` (added Phase 4, api/types.ts) is silently dropped at `.parse()`; ingress (sessions.ts:~554) only interpolates `wb.cells`, emitting the literal `(no cell data provided)` otherwise — and `wb.text` is never DLP-scanned (governance gap for mail).
1. schemas.ts: add `text: z.string().max(<DLP char cap>).optional()` to `workbookContextSchema`.
2. sessions.ts ingress: when `wb.cells` is absent but `wb.text` present, interpolate `wb.text` (not the literal placeholder); AND route `wb.text` through `applyDlp({ text })` at the same chokepoint that scans `wb.cells` (sessions.ts:~539-552).
3. Tests: assert a context with only `text` reaches the model interpolation AND is DLP-redacted. Verify current Word behavior first (this is also a Word fix).
Checkpoint: `pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/routes/clientAi`.

### S2 — PowerPoint registry + prompt, flip support (TDD)
Files: `apps/api/src/services/clientAiTools.ts`, `clientAiSessions.ts`, `clientAiTools.registry.test.ts`, `clientAiSessions.test.ts`.
1. Tests FIRST: in `registry.test.ts` drop the two `powerpoint` lines from the empty-registries test; add `describe('powerpoint')` pinning 5 tool names, 3 mutating (`add_slide`,`insert_text_box`,`format_selection`), `clientMcpToolNamesForWriteMode('powerpoint','readonly')` length 2, all `mcp__powerpoint__`-prefixed, isolation from breeze tools. In `clientAiSessions.test.ts` move the fail-loud host `'powerpoint'` → `'outlook'`; add positive `POWERPOINT_CLIENT_SYSTEM_PROMPT` pins.
2. `clientAiTools.ts`: add `POWERPOINT_CLIENT_TOOL_REGISTRY` (5 tools, `satisfies Record<string, ClientWorkbookTool>`), flip `powerpoint: {}` → it. **`format_selection`'s `format` object is byte-identical to Word's `format_text`.** Tools + wire keys:

| Tool | Mutating | inputSchema keys |
|---|---|---|
| `get_presentation_overview` | no | `{}` |
| `read_selection` | no | `{}` |
| `add_slide` | yes | `layoutName?` (str), `title?` (str) |
| `insert_text_box` | yes | `text` (str), `slideIndex?` (int ≥0) |
| `format_selection` | yes | `format` {bold?,italic?,underline? bool, fontColor? str, fontSize? num} |

> **DROP `find_replace`** — PowerPoint JS has no presentation-wide search primitive.
3. `clientAiSessions.ts`: add+export `POWERPOINT_CLIENT_SYSTEM_PROMPT`, register `powerpoint:` in `CLIENT_SYSTEM_PROMPTS` (same commit as the registry flip — else `buildClientSystemPrompt` throws 500).
Checkpoint: `pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts`.

### S3 — Seam proof (TDD)
Files: `apps/api/src/routes/clientAi/sessions.create.test.ts`, new `sessions.powerpoint-roundtrip.test.ts`.
1. In `sessions.create.test.ts`: flip the `powerpoint` 400-unsupported case → positive `201 / type:'powerpoint_client' / systemPrompt = POWERPOINT_CLIENT_SYSTEM_PROMPT` (model on the Word 201 test). Re-point the two use-path guards (the hardcoded `powerpoint_client` /messages + /events 400) → `'outlook_client'` (still unsupported). Keep `outlook` 400 + `keynote` out-of-vocab cases unchanged.
2. New `sessions.powerpoint-roundtrip.test.ts` cloned from `sessions.word-roundtrip.test.ts`: a `format_selection` (mutating) tool round-trips with `mcp__powerpoint__` prefix + `mutating:true`, resolved by a posted tool-result.
Checkpoint: `pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/routes/clientAi src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts`.

---

## P-APP (apps/powerpoint-addin)

### A1 — Scaffold (mirror apps/word-addin)
- `package.json` name `@breeze/powerpoint-addin`; copy Word's configs; `vite.config.ts` **port 3003** (Excel 3000/API 3001/Word 3002); `manifest.template.xml` = Word's with `<Host Name="Presentation"/>` + `<Host xsi:type="Presentation">` + **a distinct fresh ADDIN_MANIFEST_ID GUID** (Word's default `cf1e2379-…` must NOT be reused); `Permissions` stays `ReadWriteDocument`; WebApplicationInfo/Entra identical.
- `src/main.tsx`: `import { App } from '@breeze/office-addin-core'; import { powerpointHostAdapter } from './host/powerpoint'; root.render(<React.StrictMode><App host={powerpointHostAdapter} clientHost="powerpoint"/></React.StrictMode>)`.
- `src/__tests__/officeMock.ts` (new — PowerPoint surface): `PowerPoint.run(cb)`; `presentation.slides` (load count + each slide's shapes/title), `getSelectedSlides()`/`getSelectedShapes()`, `shape.textFrame.hasText`/`textRange.text`/`textRange.font`, `slides.add()`, `Presentation.insertSlidesFromBase64`, `shapes.addTextBox`. Same faithfulness discipline as the Word mock (read-throws-before-sync, writes-at-sync, one trailing sync). **Critical addition over Word: a per-test-togglable `Office.context.requirements.isSetSupported('PowerPointApi', v)`** so the 1.4 capability gates + the native→OOXML `add_slide` fallback are both unit-tested.
Checkpoint: `pnpm install && pnpm --filter @breeze/powerpoint-addin test` (passWithNoTests until A2).

### A2 — Tools + HostAdapter (TDD)
- `tools/getPresentationOverview.ts` (read): slide count + per-slide title; guard `textFrame.hasText`; return `{ slideCount, selectedSlideIndex, truncated, cells: string[][] }`.
- `tools/readSelection.ts` (read): selected shapes' text (shape-scoped, not text-range); return `{ shapeCount, isEmpty, cells }`.
- `tools/addSlide.ts` (mutating): try native `presentation.slides.add({layoutId,slideMasterId})` resolved from `slideMasters[0].layouts` (by `layoutName` or first); on unsupported/throw, fall back to `Presentation.insertSlidesFromBase64(<one-slide pptx>)`; return `{ added:true, via:'native'|'ooxml' }`.
- `tools/insertTextBox.ts` (mutating): gate `isSetSupported('PowerPointApi','1.4')` → `{error}` if absent; `slide.shapes.addTextBox(text, …)`; return `{ inserted:true, slideIndex }`.
- `tools/formatSelection.ts` (mutating): gate 1.4; for each selected shape with `textFrame.hasText`, map `bold/italic`→font, `underline`→font.underline (PowerPoint underline type), `fontColor`→font.color, `fontSize`→font.size; throw `ToolInputError` if no keys; return `{ applied:[...] }`.
- `tools/dispatcher.ts`: `POWERPOINT_TOOL_EXECUTORS` (5), `POWERPOINT_MUTATING_TOOLS = new Set(['add_slide','insert_text_box','format_selection'])`.
- `host/powerpointSelection.ts`: `capturePptSelectionLabel()` (selected slide/shape locator or undefined), `subscribePptSelectionChanged(cb)` (Office.context document `DocumentSelectionChanged`, no-op unsubscribe).
- `chat/captureContext.ts`: `capturePptContext(kind)` (none/selection→selected shapes text/sheet→whole-deck text, under `.text`), `capturePptName()` (presentation name).
- `approval/buildPreview.ts`: `buildPptPreview` → `{kind:'summary',…}` for the 3 mutating tools.
- `host/powerpoint.ts`: assemble `powerpointHostAdapter: HostAdapter` (all 7 members).
- Tests against the officeMock (incl. the 1.4-gate `{error}` path and the `add_slide` native-then-OOXML fallback via the togglable `isSetSupported`) + adapter test (7 members; summary previews).
Checkpoint: `pnpm --filter @breeze/powerpoint-addin test && pnpm --filter @breeze/powerpoint-addin exec tsc --noEmit`.

---

## CI (after both lanes merge)
- Clone `test-word-addin` → `test-powerpoint-addin` (`pnpm test --filter=@breeze/powerpoint-addin` + tsc). Wire into `ci-success` (needs + env `TEST_POWERPOINT_ADDIN_RESULT` + the fail check).
- **Add a 4-GUID-uniqueness assert** (no guard today; Word's `.env.example` even defaults to the Excel port 3000 — a copy-paste foot-gun): a small test or CI step asserting the four apps' default `ADDIN_MANIFEST_ID` GUIDs and dev ports are distinct.

## FINAL CHECKPOINTS
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/office-addin-core test
pnpm --filter @breeze/excel-addin test && pnpm --filter @breeze/word-addin test
pnpm --filter @breeze/powerpoint-addin test && pnpm --filter @breeze/powerpoint-addin exec tsc --noEmit
pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/routes/clientAi src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts
pnpm exec tsc --noEmit   # root (expect only the 1 pre-existing shared error)
```
**Seam proof:** `powerpoint_client` session creates + a `format_selection` tool round-trips (`mcp__powerpoint__`, `mutating:true`).

## RISKS → mitigations
1. `wb.text` ingress bug (also DLP gap) → S1 fixes it for all hosts; verify Word first. **Highest server priority.**
2. Registry-without-prompt 500 → both in the same commit (S2); S3 asserts clean 201.
3. PPT API maturity → drop `find_replace`; gate `insert_text_box`/`format_selection` behind 1.4 `{error}`; `add_slide` native-then-OOXML fallback. PPT officeMock `isSetSupported` per-test togglable so all branches are proven.
4. Shape-scoped selection + absent `textFrame` → read tools guard `textFrame.hasText`, never throw.
5. Port/GUID collision → port 3003, distinct GUID; the 4-GUID CI assert.
6. Relay-baton → fail-loud/unsupported negatives re-point to `outlook` (still unsupported after Phase 5).
