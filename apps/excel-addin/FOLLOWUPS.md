# Breeze AI for Office — Follow-ups / Backlog

Non-blocking enhancement ideas, mostly **parity with the Breeze Helper desktop app**.
None of these are required for the initial PR (#1314) — they're asides captured while
bringing Tier B up in Excel (2026-06-13).

## Parity-with-Helper features

- [ ] **Chat / conversation history** — a persistent history view in the task pane so
      users can revisit and resume prior threads (the Breeze Helper app has this).
      **Open design question: workbook-tied vs per-user?**
      - *Workbook-tied* — a conversation belongs to the file it started in; reopen that
        workbook → resume its thread. Fits the "assistant for *this* spreadsheet" model
        and keeps context local to the data.
      - *Per-user* — one history list that follows the signed-in user across workbooks.
        Fits cross-file continuity.
      - Likely answer: a per-user list, but **tag/associate each session with its
        workbook** (name/id) so it can be shown and filtered by file — best of both.
      - Server already persists sessions (`ai_sessions` / `client_ai_usage`); the admin
        Sessions tab reads them. This is mostly a pane UI + a "list my sessions" client
        endpoint, plus deciding the workbook association key.

- [ ] **Flag conversation** — let the end-user (and/or the MSP admin) flag a conversation
      for review, mirroring the AI-agent flagged-chat flow (`review-flagged-chats` skill).
      The admin **Sessions** tab already exists (session viewer) — add a flag action +
      a "flagged" filter there, and a flag affordance in the pane. Useful for quality/abuse
      review and for the governance story.

- [ ] **Logo / branding in the pane** — surface the org's branding logo to client
      end-users. The policy editor **already stores `branding.logo` (URL) + display name**
      (spec §11 white-label hook); the pane just needs to render it in the header/footer
      so end-users see their MSP's brand, not "Breeze". Low-effort, high white-label value.

## Pane UX

- [ ] **Render markdown in chat** — the assistant streams markdown (bold, lists, tables,
      code, headings), but the pane currently shows it as raw text. Render it (a small
      markdown renderer + sanitizer) so responses are readable — especially lists/tables,
      which are common for spreadsheet Q&A. Keep streaming-friendly (render incremental
      `message_delta` chunks without flicker) and sanitize to avoid HTML injection.

- [ ] **Apply-level selector (auto / ask)** — let writes run in an **Auto** mode
      (apply changes without the per-write preview card) or **Ask** mode (current
      approval-gated behavior), like the Breeze Helper tool-approval levels. UX: a small
      toggle in the pane.
      - **Governance caveat:** approval-gating is part of the product's safety story, so
        Auto should be **policy-gated** — the MSP decides per org whether end-users may
        enable Auto at all (new knob alongside `writeMode` readwrite/readonly, e.g.
        `writeApproval: ask | allow_auto`). Default stays Ask.
      - Possible middle ground: "auto-apply low-risk writes (single cell / within current
        selection), still ask for bulk/destructive writes."

## Capabilities / tools

- [ ] **`create_pivot_table` tool** — the current 9 tools have no PivotTable support, so the
      assistant can only fake pivots with formulas/Tables. Office.js *does* support native
      PivotTables programmatically: `worksheet.pivotTables.add(name, source, destination)`
      then add row/column/data hierarchies (ExcelApi **1.8**; supported on modern Excel
      Mac/Windows/web — feature-detect since the manifest declares no min requirement set).
      New **mutating** tool: server schema (source range, destination, rows/cols/values/agg)
      in `clientAiTools.ts`, client executor + approval preview (summary card: "PivotTable
      from A1:E50 → rows=Region, values=SUM(Revenue)"). Gracefully degrade to a formula
      summary when the API set is unavailable.

- [ ] **Don't undersell capabilities in the system prompt** — the model told the user it
      "can only work with cells," ignoring `create_table` / `insert_formula` / `format_range`
      / `create_sheet`. Tighten the `clientAiSessions.ts` system prompt so it accurately
      describes what it *can* do (and, once added, that it can build PivotTables).

## Office.js capability matrix (coverage vs gaps)

Current registry = **9 tools**. "Fully support Office.js" isn't a fixed target (hundreds of
API members; much of the long tail conflicts with the governed/approval model). Sized as
tool-sized capability gaps:

| Domain | Covered now | Missing (≈ tools) |
|---|---|---|
| Read | overview, selection, range, search | — |
| Write values/formulas | `write_range`, `insert_formula` | clear/delete, insert/delete rows-cols, copy/move (~3) |
| Formatting | `format_range` (bold/italic, colors, num-fmt, size) | borders, alignment/wrap, col-width/row-height, **conditional formatting**, merge (~4–5) |
| Tables | `create_table` | sort/filter, add/remove rows, styles (~2) |
| PivotTables | ✗ | `create_pivot_table` (+configure) (~1–2) |
| Charts | ✗ | `create_chart` (+configure) (~1–2) |
| Worksheets | `create_sheet` | rename/delete/move/copy, freeze panes, protect, tab color (~3) |
| Workbook | ✗ | named ranges, AutoFilter, data validation, protect (~3–4) |
| Navigation | reads selection | **set** selection / activate (~1) |
| Comments / hyperlinks / images | ✗ | (~2–3) |
| Long tail | ✗ | events, custom XML, slicers, linked data types, page setup (rarely worth exposing) |

**Tally:** practical 90% coverage ≈ **10–15 new tools** (~20–24 total); broad coverage ≈ **20 new**
(~30 total); "everything" is not a real target. **High-value next batch:** `create_pivot_table`,
`create_chart`, sort/filter, `clear_range`, richer `format_range` (borders + alignment +
conditional formatting).

**Per-tool cost reminder:** each *mutating* tool = Office.js call **+ approval-preview card +
DLP path + tests**, not just an API wrapper (the governance tax). Mapping the API is
technically straightforward; the real budget is tool-count (prompt/model accuracy) and
product judgment about what a client end-user actually needs.

## Multi-host (Word / PowerPoint / Outlook) — shared-core architecture

Agreed plan (full detail in the `client-ai` skill). ~70% of the add-in + 100% of the
server control plane is already host-neutral; only `tools/*`, `buildPreview.ts`,
`captureContext.ts`, `useSelectionAddress.ts` (+ the server prompt/registry identifiers)
touch `Excel.*`.

- [x] **HostAdapter seam (logical)** — `{ captureContext, captureName, toolExecutors, mutatingTools, buildPreview, captureSelectionAddress, subscribeSelectionChanged }` in `src/host/{types,excel}.ts`; the core consumes the adapter and never imports `Excel.*`. _(commit a63c9383 + Phase 2 below.)_
- [x] **Server host-keying (Phase 1)** — session is `host`-aware (`excel_client | word_client | powerpoint_client | outlook_client`); per-host tool registry (`CLIENT_TOOL_REGISTRIES`, Excel populated), MCP server name, and system prompt all keyed by host; `host` param on create-session with a fail-loud `isClientHostSupported` guard on both create and use paths; `ai_sessions` principal CHECK generalized to all client types (migration `2026-06-13-d-…`). Plan: `docs/superpowers/plans/ai-mcp/2026-06-13-ai-for-office-multihost.md`. _Word/PowerPoint/Outlook registries are intentionally empty until their tools land._
- [x] **Adapter-leak cleanup (Phase 2)** — the last two host-bound leaks (`hooks/useSelectionAddress.ts`, `components/QuickActions.tsx`) now route through the adapter; the live selection-refresh moved into `host/excelSelection.ts`. The core is `Excel.*`-clean (grep-gated).
- [x] **Physical package split (Phase 3)** — `packages/office-addin-core` (host-neutral TS-source workspace package, React peer dep) + `apps/excel-addin` (host-bound Excel layer importing the core). Cross-boundary leaks cut (DI at `ChatPane`; `WritePreview`/`ToolExecutor` types relocated to core `api/types`). New CI jobs `test-office-addin-core` + `test-excel-addin` gate the split (the suite never ran in CI before). Plan: `docs/superpowers/plans/ai-mcp/2026-06-13-ai-for-office-phase3-package-split.md`.
- [x] **Word add-in (Phase 4)** — `apps/word-addin` (pure shell importing the core) with a Word `HostAdapter` + 5 baseline tools (`get_document_overview`, `read_selection`, `insert_text`, `format_text`, `find_replace`); server `CLIENT_TOOL_REGISTRIES.word` + `WORD_CLIENT_SYSTEM_PROMPT` (so `host:'word'` is creatable); `App`/`ChatPane` shell moved into the core (host-parameterized — both apps share it); client threads `host` so the Word pane lists/creates Word sessions. CI `test-word-addin` gate. **This proves the seam end-to-end** (a `word_client` session creates + an `insert_text` mutating tool round-trips). Plan: `docs/superpowers/plans/ai-mcp/2026-06-14-ai-for-office-phase4-word-adapter.md`. _Remaining Word polish: comments / content-controls tools beyond the baseline 5._
- [x] **PowerPoint add-in (Phase 5)** — `apps/powerpoint-addin` (pure shell) with a PowerPoint `HostAdapter` + 5 baseline tools (`get_presentation_overview`, `read_selection`, `add_slide`, `insert_text_box`, `format_selection`); server `CLIENT_TOOL_REGISTRIES.powerpoint` + prompt. `insert_text_box`/`format_selection` gate `isSetSupported('PowerPointApi','1.4')`; `add_slide` tries native `slides.add` then falls back to `insertSlidesFromBase64`. Also landed a shared server fix — `wb.text` context is now interpolated AND DLP-scanned (was silently dropped for every grid-less host, incl. Word). CI `test-powerpoint-addin` + a distinct-port/GUID guard across all Office add-ins. Plan: `docs/superpowers/plans/ai-mcp/2026-06-14-ai-for-office-phase5-powerpoint.md`. _Fast-follows: title-aware `add_slide` (dropped to keep the wire contract honest — use `insert_text_box` for titles); `find_replace` has no PPT primitive._
- [x] **Outlook add-in (Phase 6)** — `apps/outlook-addin` with an Outlook `HostAdapter` over `mailbox.item` (read/compose) + 4 mail tools (`summarize_thread`, `extract_action_items`, `get_message_metadata`, mode-dependent `draft_reply`); server `CLIENT_TOOL_REGISTRIES.outlook` + prompt; **net-new MailApp manifest** (MessageRead+Compose surfaces, `SupportsPinning`). Minimal core mail-fit: optional `HostAdapter.contextOptions`/`composerPlaceholder` (Composer falls back to the Excel strings; Excel/Word/PPT unchanged). Item-changed rebinding is handled by the controller's fresh reads at send time + the Composer's selection subscription (no App-level effect needed). With Outlook supported, server negatives use a synthetic `keynote` host. CI `test-outlook-addin`. Plan: `docs/superpowers/plans/ai-mcp/2026-06-14-ai-for-office-phase6-outlook.md`. _Fast-follow: a `WritePreview` `{kind:'text'}` variant for the `draft_reply` approval card (a summary is weak for a multi-paragraph email)._

**All four Office hosts shipped: Excel · Word · PowerPoint · Outlook.** The shared `packages/office-addin-core` carries auth, chat, the App/ChatPane shell, DLP-aware UI, and the `HostAdapter` seam; each `apps/<host>-addin` is a thin shell + its host tool layer.

Effort ranking on top of the core (borne out): **Word ≈ PowerPoint < Outlook** (Outlook was the only host needing core changes).

## Notes
- These came out of the live Excel Tier-B session; see `docs/testing/FEATURE_TEST_LOG.md`
  for the verified state and the real bugs fixed during bring-up.
