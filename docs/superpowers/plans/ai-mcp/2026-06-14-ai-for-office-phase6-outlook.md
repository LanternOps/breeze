# AI for Office — Phase 6: Outlook Adapter (the mail-model outlier)

> Node prefix: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Commit per step; each ends green. API suite parallel-flaky — scope client-ai runs to named files.

**Goal:** Add Outlook — the **mail-model** host (no `Word.run`/`Excel.run`; you use `Office.context.mailbox.item` in read OR compose mode; surface = summarize/draft/extract, not document edits). Outlook is NOT a pure shell: it needs **real (minimal) core changes**. With Outlook supported, no real unsupported host remains, so the server negatives move to a **synthetic `keynote` host**.

## Execution: two parallel lanes (disjoint files)
- **Lane O-SERVER** (`apps/api`): Outlook registry + prompt + test flips (negatives → synthetic `keynote`) + seam proof. Branches off the merged Phase 5 (relay-baton).
- **Lane O-APP** (`packages/office-addin-core` REAL changes + new `apps/outlook-addin`): the core mail-fit changes, then the Outlook app.
(Disjoint: `apps/api` vs `core`+`apps/outlook-addin`.)

---

## O-SERVER

### S1 — Outlook registry + prompt, flip support; move negatives to synthetic host (TDD)
Files: `clientAiTools.ts`, `clientAiSessions.ts`, `clientAiTools.registry.test.ts`, `clientAiSessions.test.ts`.
1. Tests FIRST: in `registry.test.ts`, the "registries are empty" test now has nothing left (powerpoint already flipped in Phase 5) → **delete it**; add `describe('outlook')` pinning 4 tool names, 1 mutating (`draft_reply`), `clientMcpToolNamesForWriteMode('outlook','readonly')` length 3, all `mcp__outlook__`-prefixed, isolation. In `clientAiSessions.test.ts`, the fail-loud host (currently `'outlook'`) → cast a synthetic `buildClientSystemPrompt('keynote' as ClientHost, …)` (preserves the "no generic fallback ships" guarantee — `clientHostFromType('keynote')` → null); add positive `OUTLOOK_CLIENT_SYSTEM_PROMPT` pins.
2. `clientAiTools.ts`: add `OUTLOOK_CLIENT_TOOL_REGISTRY` (4 tools, `satisfies …`), flip `outlook: {}` → it. Wire keys:

| Tool | Mutating | inputSchema keys |
|---|---|---|
| `summarize_thread` | no | `{}` |
| `extract_action_items` | no | `{}` |
| `get_message_metadata` | no | `{}` |
| `draft_reply` | yes | `body` (str 1..100000), `replyAll?` (bool) |

3. `clientAiSessions.ts`: add+export `OUTLOOK_CLIENT_SYSTEM_PROMPT` (mail scope: "you help with the open email/thread"; advertises the 4 tools; the `draft_reply` preview/Apply + `[REDACTED:]` + no-RMM-claims lines), register `outlook:` in `CLIENT_SYSTEM_PROMPTS` (same commit).
Checkpoint: `pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts`.

### S2 — Seam proof (TDD)
Files: `sessions.create.test.ts`, new `sessions.outlook-roundtrip.test.ts`.
1. `sessions.create.test.ts`: flip the `outlook` 400-unsupported case → `201 / type:'outlook_client' / systemPrompt = OUTLOOK_CLIENT_SYSTEM_PROMPT`. Re-point the two use-path fail-loud guards (currently `outlook_client`) → synthetic `'keynote_client'` (`clientHostFromType` → null → still throws `ClientHostUnsupportedError`). Keep the `keynote` out-of-vocab/strict-schema cases.
2. New `sessions.outlook-roundtrip.test.ts` (clone the Word roundtrip): a `draft_reply` (mutating) round-trips with `mcp__outlook__` prefix + `mutating:true`.
Checkpoint: `pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/routes/clientAi src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts`.

---

## O-APP

### A1 — Core mail-fit changes (minimal; must not regress Excel/Word/PPT) (TDD)
Files: `packages/office-addin-core/src/host/types.ts`, `components/Composer.tsx`, `components/App.tsx` (+ tests).
1. **App item-changed rebinding (the one genuinely new core behavior).** Today App reads context once on mount. A *pinned* Outlook pane survives item switches (`mailbox.item` is replaced per selection); the core never re-reads, so the controller binds the stale item. Fix: have App re-read the context label when `host.subscribeSelectionChanged` fires (it already subscribes for the Excel selection chip — reuse it). **Widen the `host/types.ts` docblock** for `subscribeSelectionChanged` from "selection moves" to "the active context changes (selection / mailbox item)" — **no signature change**. Policy = re-read context (NOT start a fresh session).
2. **Composer vocabulary parameterization.** `Composer.tsx` hardcodes `CONTEXT_OPTIONS = [Selection, Whole sheet, No workbook data]`, "Sheet: …" chip, "Ask about this workbook…" placeholder — actively wrong for mail. Add **optional** `HostAdapter.contextOptions?: Array<{value: WorkbookContextKind; label: string}>` and `composerPlaceholder?: string`; Composer uses them when present, else today's Excel strings (Excel/Word/PPT untouched). 
3. Tests: a core Composer test asserting it renders a host's `contextOptions`/`composerPlaceholder` when provided and the Excel defaults otherwise; an App test asserting it re-reads context when the subscribed callback fires.
Checkpoint (regression gate): `pnpm --filter @breeze/office-addin-core test && pnpm --filter @breeze/office-addin-core run typecheck && pnpm --filter @breeze/excel-addin test && pnpm --filter @breeze/word-addin test && pnpm --filter @breeze/powerpoint-addin test`.

### A2 — Scaffold apps/outlook-addin (mail manifest)
- `package.json` `@breeze/outlook-addin`; copy Word configs; `vite.config.ts` **port 3004**; **distinct fresh ADDIN_MANIFEST_ID GUID**.
- `src/main.tsx`: render core `<App host={outlookHostAdapter} clientHost="outlook"/>`.
- **`manifest.template.xml` — net-new MailApp document (the big divergence; reuse `generate-manifest.mjs` token substitution unchanged):** root `xsi:type="MailApp"` + the mailapp namespace; `<Host Name="Mailbox"/>`; `<Permissions>ReadWriteItem</Permissions>`; legacy `<FormSettings>` + `<Rule xsi:type="RuleCollection" Mode="Or">` over `ItemIs ItemType="Message"` (read + edit); VersionOverrides V1_0→V1_1 nested; extension points `MessageReadCommandSurface` + `MessageComposeCommandSurface` on `TabDefault`; **`<SupportsPinning>true</SupportsPinning>`** on both (the manifest half of item-changed rebinding). `WebApplicationInfo`/Entra block byte-identical.
- `src/__tests__/officeMock.ts` (new — mailbox surface; Excel/Word mocks 0% reusable): `Office.context.mailbox.item` exposed as a **getter** (so `switchItem()` proves the adapter re-reads); `item.body.getAsync(coercionType, cb)` / `item.body.setAsync(data, opts, cb)`; `item.subject`, `item.from`, `item.to`, `item.cc`, `item.dateTimeCreated`; `item.displayReplyForm`/`displayReplyAllForm`; `mailbox.addHandlerAsync(Office.EventType.ItemChanged, cb)`; a `mode: 'read'|'compose'` switch; `Office.onReady → {host:'Outlook'}`; `OfficeRuntime.auth` verbatim. Seam helpers: `setItem({...})`, `switchItem(...)` (fires ItemChanged), `displayedReplies`/`composeSetBodies` inspectors.
Checkpoint: `pnpm install && pnpm --filter @breeze/outlook-addin test` (passWithNoTests). Commit the regenerated lockfile.

### A3 — Outlook HostAdapter + 4 tools (TDD)
- `tools/summarizeThread.ts` (read): `item.body.getAsync(Text)`; return `{ subject, from, cells: string[][] }` (paragraphs of the body, one/row — DLP).
- `tools/extractActionItems.ts` (read): same body read; return `{ subject, cells }`.
- `tools/getMessageMetadata.ts` (read): return `{ subject, from, to, cc, date }` AND pack into `cells` for pass-1 DLP parity.
- `tools/draftReply.ts` (mutating, **mode-dependent**): compose mode → `item.body.setAsync(body)`; read mode → `item.displayReplyForm/displayReplyAllForm({htmlBody: body})`. Self-guard: if neither path is available, return a clear `{error}` (mutatingTools is a static Set, can't be mode-conditional). `replyAll` selects all-vs-single.
- `tools/dispatcher.ts`: `OUTLOOK_TOOL_EXECUTORS` (4), `OUTLOOK_MUTATING_TOOLS = new Set(['draft_reply'])`.
- `host/outlookSelection.ts`: `captureOutlookSelectionLabel()` (the message subject or undefined — Outlook has no cell selection), `subscribeOutlookItemChanged(cb)` → `mailbox.addHandlerAsync(Office.EventType.ItemChanged, cb)` (NOT DocumentSelectionChanged), no-op unsubscribe.
- `chat/captureContext.ts`: `captureOutlookContext(kind)` — `none`→`{kind:'none'}`; `selection`→`{kind:'selection', text: <subject + body>}` (reuse `'selection'` = "this message"; uses `WorkbookContext.text`); `captureOutlookSubject()` for the history tag.
- `approval/buildPreview.ts`: `buildOutlookPreview('draft_reply', input)` → `{kind:'summary', …}` (the draft body — note `summary` is a weak card for a multi-paragraph email; a `{kind:'text'}` variant is a fast-follow).
- `host/outlook.ts`: assemble `outlookHostAdapter: HostAdapter` (all 7 members) + the new `contextOptions: [{value:'selection',label:'This email'},{value:'none',label:'No email data'}]` + `composerPlaceholder: 'Ask about this email…'`.
- Tests against the mailbox officeMock: each tool (cells shape on reads; `draft_reply` down BOTH read→`displayedReplies` and compose→`composeSetBodies` branches); the item-changed re-read (`switchItem()` → adapter reads the new item); the adapter (7 members + contextOptions/placeholder; summary previews).
Checkpoint: `pnpm --filter @breeze/outlook-addin test && pnpm --filter @breeze/outlook-addin exec tsc --noEmit`.

---

## CI (after both lanes merge)
Clone `test-word-addin` → `test-outlook-addin` (`pnpm test --filter=@breeze/outlook-addin` + tsc). Wire into `ci-success` (needs + env `TEST_OUTLOOK_ADDIN_RESULT` + the fail check). Port 3004 / distinct GUID are covered by the existing distinct-port/GUID guard step (it globs `apps/*-addin`).

## FINAL CHECKPOINTS
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/office-addin-core test && pnpm --filter @breeze/office-addin-core run typecheck
pnpm --filter @breeze/excel-addin test && pnpm --filter @breeze/word-addin test && pnpm --filter @breeze/powerpoint-addin test
pnpm --filter @breeze/outlook-addin test && pnpm --filter @breeze/outlook-addin exec tsc --noEmit
pnpm --filter @breeze/api exec vitest run --no-file-parallelism src/routes/clientAi src/services/clientAiTools.registry.test.ts src/services/clientAiSessions.test.ts
pnpm exec tsc --noEmit   # root (expect only the 1 pre-existing shared error)
```
**Seam proof:** `outlook_client` session creates + a `draft_reply` round-trips (`mcp__outlook__`, `mutating:true`).

## TOP RISKS → mitigations
1. **Shared-shell fit — NOT a pure shell.** Mail needs the App item-changed re-read + Composer vocabulary. → A1 lands them in core (optional/defaulted so Excel/Word/PPT are untouched); regression gate every checkpoint.
2. **Outlook manifest is net-new MailApp** (wrong root/namespace/extension-points → Office ignores it; missing `SupportsPinning` makes item-changed moot). → write per the A2 spec; reuse `generate-manifest.mjs` tokens; validate with the Office manifest validator.
3. **`draft_reply` is mode-dependent** (read vs compose). → executor self-guards both paths + returns `{error}` if neither; tested down both branches.
4. **Read-tool text under wrong key → DLP no-op.** → all reads return `cells: string[][]`; tests assert. (The Phase-5 `wb.text` ingress+DLP fix already covers the context-chip path.)
5. **Registry-without-prompt 500.** → registry + prompt same commit (S1); S2 asserts clean 201.
6. **Relay-baton: no real unsupported host left.** → negatives use synthetic `keynote`/`keynote_client` (S1/S2).
7. **`WritePreview summary` weak for `draft_reply`** (highest-stakes action — sending an email). → acceptable for baseline; a `{kind:'text', before?, after}` preview variant is a noted fast-follow.
8. **Port/GUID collision.** → port 3004, distinct GUID; the existing distinct-port/GUID CI guard catches regressions.
