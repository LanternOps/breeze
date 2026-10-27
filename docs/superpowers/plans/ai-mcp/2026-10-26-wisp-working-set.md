---
spec: docs/superpowers/specs/ai-mcp/2026-10-26-wisp-working-set.md
waves: W01 (working-set model), W02 (auto-link), W03 (record page context), W04 (surface)
tracking_issue: (set by register_feature)
---

# Wisp working set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wisp's thread links fill themselves from what Wisp actually works on, every record page tells the AI chat what it is looking at, and device/ticket/billing headers get a small "Talk to Wisp about this".

**Architecture:** `wisp_thread_links` gains a `source` (user pin, Wisp pin, auto) and recency; pins are sticky, auto links are LRU-capped. The pre-tool gate hands the tool handler an `onSuccess` closure that auto-links the call's subject objects (from a declarative manifest) under the call's own narrowed auth and ceiling. Concern subjects join the working set at read time. A new `record` page-context variant, read and authorized server-side, covers ticket, quote, invoice, contract, organization and site pages for both the plain chat and Wisp. The web turns the links panel into a pill strip and replaces "Link to Wisp" with "Talk to Wisp about this".

**Tech Stack:** Hono + Drizzle + hand-written SQL with forced RLS (API), Zod in `@breeze/shared`, Astro + React + Zustand (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-26-wisp-working-set.md`

## Execution split

| Wave | Owns | Depends on | Tasks |
|---|---|---|---|
| W01 working-set model | `apps/api/**`, `packages/shared/**` | — | 1–5 |
| W02 auto-link | `apps/api/**` | W01 merged | 6, 7, 9, then 8 (8 consumes 9) |
| W03 record page context | `packages/shared/**`, `apps/api/**`, `apps/web/**` | — (Task 14 after W01) | 10–14 |
| W04 surface | `apps/web/**`, one API route, `e2e-tests/**`, docs | W01 + W03 merged | 15–19 |

W01 and W03 run in parallel. Each wave is one PR targeting `main`; never stack. Opus for Tasks 1, 2, 7, 8, 11, 12, 15; Sonnet is fine for the rest.

## Global Constraints

- **Migration name** sorts after the newest committed migration. At plan time that is `2027-01-07-140000-flow-webhooks-tools-budgets.sql`; the slot is `2027-01-07-150000-wisp-thread-links-working-set.sql`. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` first and take the next slot if something newer landed. Idempotent, no inner `BEGIN;`/`COMMIT;`, and `SELECT set_config('breeze.scope', 'system', true);` first because it backfills rows. Never edit or rename a shipped migration.
- **Export policy:** every new `wisp_thread_links` column is classified in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:1125`): `source`, `last_touched_at`, `touch_count` go in `included`. The export-policy and cascade suites fail only under Integration Tests.
- **Constants** (`packages/shared/src/types/wisp.ts`): `WISP_THREAD_LINK_LIMIT = 50` (pins, unchanged), `WISP_THREAD_AUTO_LINK_LIMIT = 20`, `WISP_AUTO_LINKS_PER_TURN = 5`, `WISP_SEED_AUTO_LINK_MAX_LINES = 15`.
- **Authority:** every add, touch-by-focal-act and neighbour read goes through `resolveEntityRef` (or the new caller-only resolver in Task 11) with the call's auth. No path builds a link, a prompt line or a pill from a stored label or a client-supplied label.
- **Dark by default:** Wisp routes stay under the `wispRoutes` hub. The `record` page context is not flag-gated (plain chat uses it).
- **i18n:** every new `en` key is added to all eight locales (en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR); `localeParity` in `apps/web/src/lib/i18n` enforces it.
- **Web mutations** go through `runAction` with the CLAUDE.md caller catch pattern.
- Scoped tests: `cd apps/api && npx vitest run <path>` (or `apps/web`, `packages/shared`); never `pnpm --filter <pkg> test -- --run`. API typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --build tsconfig.tests.json; echo exit=$?` and read the exit code, never pipe to `tail`.

## Review Focus

1. **A fleet-wide tool call** (for example a query over 300 devices) must add zero auto links. Pinned in Task 6 (manifest contract: list/search/query/fleet tools are non-focal) and Task 8 (`does not link from a list action`).
2. **Pins at the cap plus a burst of auto links** must never evict a pin. Task 2 `auto eviction never removes a pin`.
3. **A record page in an org outside the Wisp ceiling** must render no record line in the prompt and no seed line. Task 12 `renders nothing for a refused record` and Task 14.
4. **A tool that succeeds but the auto-link resolve throws** must still return the tool result unchanged. Task 7 `onSuccess failure does not change the tool result`.
5. **Two concurrent focal acts in one turn** must not exceed `WISP_AUTO_LINKS_PER_TURN` or the auto cap. Task 8 `per-turn cap holds under concurrent calls` and Task 2 `concurrent auto adds respect the auto cap`.

---

## W01 — Working-set model

### Task 1: Migration, schema and registries

**Files:**
- Create: `apps/api/migrations/2027-01-07-150000-wisp-thread-links-working-set.sql`
- Modify: `apps/api/src/db/schema/wispThreadLinks.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts:1125`
- Test: `apps/api/src/__tests__/integration/wispThreadLinks.integration.test.ts` (extend)

**Interfaces:**
- Produces: columns `source text NOT NULL` with CHECK `source IN ('user_pin','wisp_pin','auto')`, `last_touched_at timestamptz NOT NULL DEFAULT now()`, `touch_count integer NOT NULL DEFAULT 1`; index `wisp_thread_links_thread_touched_idx (thread_id, last_touched_at DESC)`; Drizzle fields `source`, `lastTouchedAt`, `touchCount`; type `WispLinkSource = 'user_pin' | 'wisp_pin' | 'auto'` (Task 3 exports it from shared).

- [ ] **Step 1: Write the failing integration test** `migration backfills source and recency`: seed one row with `added_by_grant_id` NULL and one with it set, run the migration file, assert `source` is `user_pin` and `wisp_pin`, and `last_touched_at = created_at`.
- [ ] **Step 2: Run it** with `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispThreadLinks.integration.test.ts`. Expected: FAIL, column `source` does not exist.
- [ ] **Step 3: Write the migration.** Add the columns nullable, backfill (`source = CASE WHEN added_by_grant_id IS NULL THEN 'user_pin' ELSE 'wisp_pin' END`, `last_touched_at = created_at`), then set NOT NULL, add the CHECK and the index, all guarded (`ADD COLUMN IF NOT EXISTS`, `DO $$ … IF NOT EXISTS (pg_constraint …)`). Mirror it in the Drizzle schema. Add the three columns to the export policy `included` list.
- [ ] **Step 4: Run** the test plus `pnpm db:check-drift`. Expected: PASS, no drift.
- [ ] **Step 5: Commit** `feat(wisp): working-set columns on wisp_thread_links`.

### Task 2: `addLink` sources, promotion, touch and auto eviction

**Files:**
- Modify: `apps/api/src/services/wisp/threadLinks.ts`
- Test: `apps/api/src/services/wisp/threadLinks.test.ts` (create), `apps/api/src/__tests__/integration/wispThreadLinks.integration.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `addLink(ctx, threadId, ref, opts: { source: WispLinkSource; addedByGrantId?: string | null }): Promise<WispThreadLink>`. An `auto` add over an existing pin returns the touched pin; an `auto` add at the auto cap evicts and inserts; only a pin add at the pin cap throws `link_limit`.
  - `touchLinks(partnerId: string, threadId: string, refs: BreezeEntityRef[]): Promise<number>`: bumps `last_touched_at = now()` and `touch_count + 1` on rows that already exist; returns rows touched; inserts nothing; no resolve (it reveals nothing).

- [ ] **Step 1: Write failing tests** (integration, real Postgres):
  - `a pin add over an auto link promotes it to user_pin`
  - `an auto add over a pin keeps it a pin and touches it`
  - `auto eviction never removes a pin`: 50 pins + 20 autos, one more auto evicts the oldest auto, pin count stays 50.
  - `pin add at 50 pins still refuses with link_limit`
  - `concurrent auto adds respect the auto cap`: 25 parallel auto adds on an empty thread leave exactly 20 auto rows.
  - `touchLinks bumps recency and never inserts`
- [ ] **Step 2: Run** and expect FAIL (signature mismatch / no promotion).
- [ ] **Step 3: Implement.** Inside the existing thread `FOR UPDATE` transaction: on an existing row, set `source` to the stronger of old and new (`user_pin` > `wisp_pin` > `auto`), refresh label/org, bump recency. On insert, count by class: pins against `WISP_THREAD_LINK_LIMIT` (throw `link_limit`), autos against `WISP_THREAD_AUTO_LINK_LIMIT` (delete the auto row with the oldest `last_touched_at`, then insert).
- [ ] **Step 4: Run** and expect PASS. Update both callers: `routes/wispThreadLinks.ts:65` passes `source: 'user_pin'`; `services/wisp/linkTools.ts:122` passes `source: 'wisp_pin'`.
- [ ] **Step 5: Commit** `feat(wisp): link sources, promotion and auto eviction`.

### Task 3: Shared types

**Files:**
- Modify: `packages/shared/src/types/wisp.ts:37-56`, `packages/shared/src/index.ts` exports if needed
- Test: `packages/shared/src/types/wisp.test.ts` (create or extend)

**Interfaces:**
- Produces:
  - `export type WispLinkSource = 'user_pin' | 'wisp_pin' | 'auto';`
  - `WispThreadLink` changes: drop `addedBy`; add `source: WispLinkSource | 'concern'`, `lastTouchedAt: string`; `id: string | null` (null only when `source === 'concern'`).
  - `CONCERN_KIND_TO_ENTITY_KIND: Readonly<Partial<Record<ConcernSubjectKind, WispEntityKind>>>` (`org` → `organization`; ticket, device, alert, run, task, quote, invoice, contract, site map to themselves; `integration` and `incident` absent).
  - The four constants from Global Constraints.

- [ ] **Step 1: Failing test** `maps org concerns to organization and drops integration/incident`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/types/wisp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and fix every compile error from the `addedBy` removal (`threadLinks.ts toLink`, `linkTools.ts toolView`, `WispLinksPanel.tsx:92`, tests). Web keeps working: `addedBy === 'wisp'` becomes `source === 'wisp_pin'`.
- [ ] **Step 4: Run** the test and the API typecheck. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(shared): working-set link types`.

### Task 4: Working-set read with concern subjects

**Files:**
- Modify: `apps/api/src/services/wisp/threadLinks.ts` (`listLinks`), `apps/api/src/services/wisp/home.ts:105`, `apps/api/src/routes/wispThreadLinks.ts:52`
- Test: `apps/api/src/services/wisp/threadLinks.test.ts`, `apps/api/src/services/wisp/home.test.ts`

**Interfaces:**
- Produces: `listWorkingSet(ctx: EntityResolveContext, threadId: string, opts?: { concerns?: Concern[] }): Promise<WispThreadLink[]>`. Order: pins by `last_touched_at` desc, then concern subjects (deduplicated against stored links; a subject already stored keeps its stored row), then autos by `last_touched_at` desc. `listLinks` stays as the stored-rows-only read used by `list_links` and becomes ordered by `last_touched_at`.

- [ ] **Step 1: Failing tests:** `orders pins, then concern subjects, then autos`; `a concern subject that is also a stored link appears once as the stored link`; `a resolved concern's subject leaves the working set`; `an integration concern adds nothing`; `a concern subject outside the ceiling is omitted`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Concern subjects resolve through the same `createEntityResolver(ctx)`; they are never written. `home.ts` passes the concerns it already loaded (`listConcernsForCeiling`, line 102) to avoid a second read; the links route loads open/snoozed concerns for the grant.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(wisp): working set includes concern subjects`.

### Task 5: Seed ordering

**Files:**
- Modify: `apps/api/src/services/wisp/threads.ts:78-125`
- Test: `apps/api/src/services/wisp/threads.test.ts`

**Interfaces:**
- Consumes: `listWorkingSet` (Task 4).
- Produces: `renderLinkSection(items: WispThreadLink[], flags: string[], opts?: { viewing?: ResolvedEntity | null }): string`. `viewing` is filled by Task 14.

- [ ] **Step 1: Failing tests:** `seed lists pins before concern subjects before autos`; `seed caps auto lines at 15 while pins still show`; `concern lines say "(open concern)"`; existing 50 line / 4 KB and fencing tests stay green.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** `linkSeedSection` calls `listWorkingSet` with the grant's open concerns. Each line keeps today's shape; concern lines append ` (open concern)`; auto lines append ` (recent)`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(wisp): seed orders the working set`.

---

## W02 — Auto-link on focal acts

### Task 6: Subject manifest and its contract test

**Files:**
- Create: `apps/api/src/services/wisp/toolSubjects.ts`, `apps/api/src/services/wisp/toolSubjects.contract.test.ts`

**Interfaces:**
- Produces:
  - `type ToolSubject = { arg: string; kind: WispEntityKind; actions?: readonly string[] }`
  - `WISP_TOOL_SUBJECTS: Readonly<Record<string, readonly ToolSubject[]>>`
  - `WISP_NON_FOCAL_TOOLS: ReadonlySet<string>`
  - `subjectRefsOf(toolName: string, input: Record<string, unknown>): Array<{ kind: WispEntityKind; id: string }>`: only GUID-shaped string values; for a subject with `actions`, only when `input.action` is listed; deduplicated.
- Starting entries (from the 2026-10-26 tool map):

| Tool | arg → kind | actions |
|---|---|---|
| `get_device_details`, `get_device_context` | `deviceId` → device | — |
| `manage_tickets` | `ticketId` → ticket | get, comment, assign, update_status, update_fields, link_device, draft, log_time_entry |
| `get_quote` | `quoteId` → quote | — |
| `manage_quotes` | `quoteId` → quote | every action except create_draft and list |
| `get_invoice` | `invoiceId` → invoice | — |
| `manage_invoices` | `invoiceId` → invoice | every action that takes `invoiceId` except list |
| `get_contract` | `contractId` → contract | — |
| `manage_contracts` | `contractId` → contract | every action except create and list |
| `manage_organizations` | `orgId` → organization | update_org |
| `get_site` | `siteId` → site | — |
| `manage_alerts` | `alertId` → alert | get, acknowledge, resolve, suppress |
| `get_ai_agent_run` | `runId` → run | — |
| `get_operator_task` | `taskId` → task | — |

The implementer reads each tool's input schema and enumerates exact action names for the "every action except" rows.

- [ ] **Step 1: Write the contract tests:** `every tool in TOOL_TIERS is classified exactly once` (in the map xor the non-focal set); `no list_/search_/query_/find_/get_fleet tool is focal`; `every subject arg exists in the tool's input schema`; `every actions value exists in the tool's action enum`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/wisp/toolSubjects.contract.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** the map, the non-focal set (every other `TOOL_TIERS` entry, sorted) and `subjectRefsOf`, with unit cases `ignores manage_tickets list`, `reads quoteId on send`, `drops a non-GUID id`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(wisp): focal tool subject manifest`.

### Task 7: `onSuccess` seam in the tool handler

**Files:**
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:99-109` (`PreToolUseResult`), the `makeToolHandler` success path (~`:1150-1152`) and the same point in `makeSessionAwareHandler`
- Test: `apps/api/src/services/aiAgentSdkTools.onSuccess.test.ts` (create)

**Interfaces:**
- Produces: `PreToolUseResult` allowed branch gains `onSuccess?: (input: Record<string, unknown>) => Promise<void>`. The handler calls it after a non-error result (`!isToolError`, and the parsed JSON has no `refused` key), un-awaited from the caller's point of view: `void check.onSuccess?.(args).catch(logAndCapture)`.

- [ ] **Step 1: Failing tests:** `calls onSuccess once after a successful call`; `does not call onSuccess on an error result or a refused result`; `onSuccess failure does not change the tool result`; `a call with no onSuccess behaves as before`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement** in both handler factories. `logAndCapture` uses `captureException` with `{ op: 'wisp.auto_link', toolName }`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(ai): onSuccess hook on allowed tool calls`.

### Task 8: Auto-link service, wired from the Wisp gate

**Files:**
- Create: `apps/api/src/services/wisp/autoLink.ts`, `apps/api/src/services/wisp/autoLink.test.ts`
- Modify: `apps/api/src/services/aiAgentSdk.ts:1037-1050` (`createSessionPreToolUse`: when `wispCall.current` is set, return `onSuccess`), `apps/api/src/services/streamingSessionManager.ts` (per-turn counter field beside `pendingTurnToolExecutionCount`, `:542`)

**Interfaces:**
- Consumes: `subjectRefsOf` (Task 6), `addLink`/`touchLinks` (Task 2), `relatedRefs` (Task 9), `WispCallState` (`aiAgentSdk.ts:909`), `session.wispGrant.threadId`.
- Produces: `autoLinkFocalAct(args: { session: ActiveSession; toolName: string; input: Record<string, unknown>; auth: AuthContext; ceiling: GrantCeiling }): Promise<{ added: number; touched: number }>`; session field `pendingTurnAutoLinkCount: number`, reset where `pendingTurnToolExecutionCount` resets.

- [ ] **Step 1: Failing tests:** `links the ticket of manage_tickets get`; `does not link from a list action`; `does nothing outside a Wisp session`; `per-turn cap holds under concurrent calls` (8 parallel focal calls → 5 adds, the rest touch only); `a refused resolve adds nothing and throws nothing`; `writes wisp.thread.link_added with source auto`; `touches already-linked relations of the subject`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Reserve a per-turn slot synchronously (increment before the await) so concurrent calls cannot both pass. Add with `{ source: 'auto', addedByGrantId: ceiling.grantId }` and ctx `{ auth, ceiling }`. Audit with `writeAuditEvent(requestLikeFromSnapshot(session.auditSnapshot), …)` following `auditWispRefusal` (`aiAgentSdk.ts:919-937`), `initiatedBy: 'ai'`. Then `touchLinks` on `relatedRefs(subject)`.
- [ ] **Step 4: Run** and expect PASS, then the API typecheck.
- [ ] **Step 5: Commit** `feat(wisp): auto-link on focal acts`.

### Task 9: One-hop relations

**Files:**
- Create: `apps/api/src/services/wisp/entityRelations.ts`, `apps/api/src/services/wisp/entityRelations.test.ts`

**Interfaces:**
- Produces:
  - `relatedRefs(partnerId: string, ref: { kind: WispEntityKind; id: string }): Promise<Array<{ kind: WispEntityKind; id: string }>>`: upward pointers only, read in system context pinned to the partner, no labels. ticket → device (`tickets.device_id`), organization; device → site, organization; alert → device, organization; quote, invoice → organization, site; contract → organization; site → organization; others → none.
  - `neighbourRefs(partnerId, ref)`: `relatedRefs` plus, for device, up to 3 open tickets (`status` not resolved/closed, `deleted_at IS NULL`) and 3 active alerts. Used by Task 16 only.

- [ ] **Step 1: Failing tests** per kind: `ticket relates to its device and org`; `ticket without a device relates to its org only`; `device neighbours include at most 3 open tickets`; `another partner's ids return nothing`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement** with one query per kind.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(wisp): entity relations`.

---

## W03 — Record page context

### Task 10: Shared schema and type

**Files:**
- Modify: `packages/shared/src/types/ai.ts:125-136`, `packages/shared/src/validators/ai.ts:21-56`
- Test: `packages/shared/src/validators/ai_messages.test.ts`

**Interfaces:**
- Produces: `AiRecordPageContext = { type: 'record'; kind: AiRecordKind; id: string; orgId?: string; label?: string }`, `AiRecordKind = 'ticket' | 'quote' | 'invoice' | 'contract' | 'organization' | 'site'`, `AI_RECORD_KINDS`; schema member `.strict()`, `id`/`orgId` uuid, `label` max 200.

- [ ] **Step 1: Failing tests:** `accepts a ticket record`; `rejects an unknown record kind`; `rejects extra keys on a record`; `rejects a label over 200`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/ai_messages.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(shared): record page context`.

### Task 11: Caller-only record resolver

**Files:**
- Modify: `apps/api/src/services/wisp/entityRefs.ts`
- Test: `apps/api/src/services/wisp/entityRefs.test.ts`

**Interfaces:**
- Produces: `resolveEntityForCaller(auth: AuthContext, ref: { kind: WispEntityKind; id: string }): Promise<ResolvedEntity | ResolveFailure>`: steps 1, 2, 3 and 5 of `resolveEntityRef` (load in the caller's partner, org from the entity, read permission + org/site reach, token scope), no ceiling. `resolveEntityRef` reuses it and adds the ceiling step, so there is one implementation.

- [ ] **Step 1: Failing tests:** `resolves a ticket the caller can read`; `forbidden without tickets:read`; `outside_token_scope for another org on an org token`; `not_found for another partner's quote`; existing `resolveEntityRef` tests stay green.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement** by extracting the shared steps.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `refactor(wisp): caller-only entity resolver`.

### Task 12: Server handling — sanitizer, prompt, org anchor, tool domains

**Files:**
- Modify: `apps/api/src/services/aiInputSanitizer.ts:9-177` (import `AiPageContext` from shared, delete the local copy, exhaustive `never` default), `apps/api/src/services/aiAgent.ts:79-85` (`resolvePageContextOrgId`) and `:864-946` (prompt switch, exhaustive), `apps/api/src/services/aiSessionOrgAnchor.ts:41-51`, `apps/api/src/services/aiToolIndex.ts:51-57,158`
- Test: `apps/api/src/services/aiAgent.recordPageContext.test.ts` (create), `apps/api/src/services/aiToolIndex.test.ts:493-499`, `apps/api/src/services/aiSessionOrgAnchor.test.ts`

**Interfaces:**
- Consumes: `resolveEntityForCaller` (Task 11).
- Produces: prompt line `The user is viewing {kind} "{label}"{ (status S)} (ID: {id}). Prioritize information and actions related to it.`, label and status sanitized and fenced; `PAGE_CONTEXT_TOOL_DOMAINS.record` replaced by `pageContextToolDomains(ctx: AiPageContext): readonly AiToolDomain[]` (record by kind: ticket → tickets; quote, invoice, contract → billing; organization, site → accounts).

- [ ] **Step 1: Failing tests:** `renders the server label, not the client label`; `renders nothing for a refused record`; `anchors the session org to the ticket's org`; `write default org is the record's org`; `record domains follow the kind`; update the `toEqual` at `aiToolIndex.test.ts:493`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new and existing page-context suites (`aiAgent.pageContextOrg.test.ts`, `aiAgent.toolIndexPrompt.test.ts`, `aiSessionOrgAnchor.test.ts`, `lazyIndexCases.test.ts`) and the API typecheck. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(ai): record page context on the server`.

### Task 13: Web — store, badge and the six pages

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts:217-224` (`pageContextOrgMismatch` for any context with `orgId`), `apps/web/src/components/ai/AiContextBadge.tsx:15-32` (record case + exhaustive), `apps/web/src/stores/workspaceStore.ts:85-99`, `apps/web/src/lib/aiSessionOpen.ts:46-50` (parse with the shared schema), and the pages `TicketWorkbench.tsx`, `QuoteWorkspace.tsx`, `InvoiceWorkspace.tsx`, `ContractWorkspace.tsx`, the organization record page, `settings/SiteDetailPage.tsx`
- Create: `apps/web/src/hooks/useRecordPageContext.ts`
- Test: `apps/web/src/hooks/useRecordPageContext.test.ts`, `apps/web/src/stores/aiStore.pageContextOrg.test.ts`, `apps/web/src/components/ai/AiContextBadge.test.tsx`

**Interfaces:**
- Produces: `useRecordPageContext(ctx: { kind: AiRecordKind; id: string; orgId: string | null; label: string } | null): void`: sets on mount and change, clears on unmount, following `DeviceDetailPage.tsx:344-360`.

- [ ] **Step 1: Failing tests:** `sets and clears the record context`; `a ticket page in another org rebinds the session`; `badge shows the record label`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/hooks/useRecordPageContext.test.ts src/stores/aiStore.pageContextOrg.test.ts src/components/ai/AiContextBadge.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook and call it from each page once the record has loaded.
- [ ] **Step 4: Run** and expect PASS; run `cd apps/web && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(web): record pages set AI page context`.

### Task 14: Wisp seed "Viewing now" line (after W01 merges)

**Files:**
- Modify: `apps/api/src/services/wisp/chatCeiling.ts:236-252` (`wispSeedForSession` receives the turn's page context), `apps/api/src/services/aiAgentSdk.ts:626-635`, `apps/api/src/services/wisp/threads.ts` (`renderLinkSection` `viewing`)
- Test: `apps/api/src/services/wisp/threads.test.ts`, `apps/api/src/services/wisp/chatCeiling.test.ts`

- [ ] **Step 1: Failing tests:** `seed starts with the viewed record`; `a viewed record outside the ceiling adds no line`; `a device page context also fills viewing`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Resolve the page record (or device) with `resolveEntityRef({ auth, ceiling }, …)`; the line reads `Viewing now: {kind} "{label}" id={id} org={org}` inside the same fence.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(wisp): seed names the record being viewed`.

---

## W04 — Surface

### Task 15: Working-set routes for the strip

**Files:**
- Modify: `apps/api/src/routes/wispThreadLinks.ts`
- Test: `apps/api/src/routes/wispThreadLinks.test.ts`

**Interfaces:**
- Produces:
  - `GET /wisp/thread/:id/links` returns `listWorkingSet` (Task 4).
  - `POST /wisp/thread/:id/links/:linkId/pin` promotes an auto link to `user_pin`; 404 when absent.
  - `GET /wisp/thread/:id/links/neighbours?kind=&id=` returns up to 8 `WispThreadLink`-shaped items (`id: null`, `source: 'auto'`) from `neighbourRefs`, each through `resolveEntityRef` with the caller's auth; the subject itself must resolve first or 404.
  - Dismiss reuses `DELETE /wisp/thread/:id/links/:linkId`.
- [ ] **Step 1: Failing tests:** `pin promotes an auto link`; `neighbours omit an org the caller cannot read`; `neighbours 404 when the subject is refused`; `GET returns concern subjects`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement**, each mutation audited like `link_added`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(wisp): pin and neighbour routes`.

### Task 16: Pill strip

**Files:**
- Modify: `apps/web/src/components/wisp/WispLinksPanel.tsx` (becomes the strip; keep the file name and `data-testid="wisp-links-panel"`), `apps/web/src/lib/wispLinksApi.ts`
- Create: `apps/web/src/components/wisp/WispLinkPill.tsx`
- Test: `apps/web/src/components/wisp/WispLinksPanel.test.tsx`, `apps/web/src/components/wisp/WispLinkPill.test.tsx`

**Interfaces:**
- Produces: `WispLinkPill({ link, onPin?, onDismiss?, onRemove?, threadId })`; `pinWispLink(threadId, linkId)`, `listWispNeighbours(threadId, ref)` in `wispLinksApi.ts`.

- [ ] **Step 1: Failing tests:** `pins render with remove, autos with pin and dismiss, concerns with neither`; `shows 12 then More`; `auto pills older than 24 h render faded` (`data-age="old"`); `expand loads neighbours once`; `pin moves a pill into the pins group`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Groups in order pins, concerns, recent. The picker ("Add") stays. Faded = `opacity-60`, threshold 24 h from `lastTouchedAt`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(web): Wisp working-set pills`.

### Task 17: "Talk to Wisp about this"

**Files:**
- Create: `apps/web/src/components/wisp/WispTalkButton.tsx` (replaces `WispLinkButton.tsx`; keep its eligibility and `activeThreadFor` cache)
- Delete: `apps/web/src/components/wisp/WispLinkButton.tsx` and its test after moving the cases
- Modify: the six header mounts (`DeviceDetails.tsx`, `TicketWorkbench.tsx`, `QuoteWorkspace.tsx`, `InvoiceWorkspace.tsx`, `ContractWorkspace.tsx`, `OrgRecordHeader.tsx`), `apps/web/src/stores/aiStore.ts` (new action), `apps/web/src/lib/__tests__/runActionAllowlist.ts` if the allowlist names the old file
- Test: `apps/web/src/components/wisp/WispTalkButton.test.tsx`

**Interfaces:**
- Produces: store action `talkToWispAbout(target: { kind: WispEntityKind; id: string; orgId: string | null; label: string }): Promise<'opened' | 'declined_focus' | 'no_grant'>`; `WispTalkButton({ kind, id, orgId, label, size })`.

- [ ] **Step 1: Failing tests:** `with a grant, opens Wisp mode, pins and prefills "About {label}: "`; `keeps an existing draft`; `asks to switch focus when the record's org differs and stops on no`; `switches focus on yes, then pins`; `without a grant shows "Ask AI about this" and opens the plain chat`; `never sends a message`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** The focus question is an inline popover under the button (no browser dialog). The pin uses `addWispLink` (`source` is set server-side by the route).
- [ ] **Step 4: Run** and expect PASS, plus `no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit** `feat(web): Talk to Wisp about this`.

### Task 18: Copy and locales

**Files:**
- Modify: `apps/web/src/locales/*/ai.json` (all eight)

- [ ] **Step 1:** Add keys `wisp.talk.button` ("Talk to Wisp"), `wisp.talk.buttonPlain` ("Ask AI about this"), `wisp.talk.draft` ("About {{label}}: "), `wisp.talk.switchFocus` ("Wisp is focused on {{from}}. Switch to {{to}}?"), `wisp.links.groupPinned`, `wisp.links.groupConcerns`, `wisp.links.groupRecent`, `wisp.links.pin`, `wisp.links.dismiss`, `wisp.links.more`, `wisp.links.neighbours`; remove the `wisp.linkButton.*` keys and their `humanizedKeyBaseline.json` entries.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/i18n`. Expected: PASS.
- [ ] **Step 3: Commit** `i18n(web): working-set copy`.

### Task 19: End-to-end and docs

**Files:**
- Create: `e2e-tests/tests/wisp-working-set.spec.ts`
- Modify: the Wisp page in `apps/docs/` (working set, pills, "Talk to Wisp about this", record context)

- [ ] **Step 1:** Playwright (`data-testid` only): open a ticket, click Talk to Wisp, see the composer prefilled and a pinned pill on the home strip; ask Wisp to open a device and see a recent pill appear.
- [ ] **Step 2: Run** against a worktree stack (`worktree-stack` skill) with `BREEZE_WISP_ENABLED=true`. Expected: PASS.
- [ ] **Step 3:** Update the docs page; commit `docs(wisp): working set` and `test(e2e): wisp working set`.

---

## Follow-ups (file as issues when W02 lands)

- Inline per-message references in the transcript, from `subjectRefsOf`.
- Mobile `WispThreadScreen` pills.
