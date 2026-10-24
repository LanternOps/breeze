---
tracking_issue: LanternOps/breeze#9779
spec_issue: LanternOps/breeze#8883
refs: [LanternOps/breeze#8972, LanternOps/breeze#8973]
spec: docs/superpowers/specs/ticketing/2026-10-18-ticketing-merge-sla-calendars-routing-spec.md
base: origin/main @ 520d3dade2
status: approved (Gate B) — waves tracked on LanternOps/breeze#9779
---

# Ticketing: merge, business-hours SLA calendars, routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each wave is one PR off fresh `origin/main`; read the spec section named in each task before starting it.

**Goal:** Ship ticket merge (#8972), stored SLA deadlines computed on business-hours calendars (#8973) and create-time routing rules (#8883), exactly as the approved spec decides.

**Architecture:** Merge turns the source into a read-only tombstone (`tickets.merged_into_ticket_id`, one hop) and re-points its children inside one lock-ordered transaction. SLA deadlines become stored columns (`*_due_at`, `*_warn_at`) written at a fixed set of write points by one shared calculator, so the six readers stop re-deriving them. Calendars and routing rules are partner-wide-first config tables (`partner_id` XOR `org_id`) read by one resolver and one evaluator inside `createTicket`.

**Tech Stack:** Hono + Drizzle (queries only) + hand-written SQL migrations, PostgreSQL RLS, BullMQ, Vitest (unit / integration / RLS coverage), Astro + React islands (web, portal), `Intl` time-zone math (no tz library).

**Spec:** `docs/superpowers/specs/ticketing/2026-10-18-ticketing-merge-sla-calendars-routing-spec.md` (approved 2026-10-22; D1–D12 decided — do not re-open). Section numbers below (§3.3 etc.) are the spec's.

## Global Constraints

- Merge is same-org only and never changes a ticket's org (§2). No undo (D4). Survivor keeps its own SLA (D5).
- Refuse a merge when either ticket has any `ticket_approval_requests` row or a budget (`budget_minutes`/`budget_amount`) — `MERGE_APPROVAL_STATE` (D3).
- Source requester gets public read + public reply on the survivor through `portalTicketReadAccess`; `portalTicketOwnership` is never widened (D1).
- Notify-source-requester checkbox: opt-out, default on when the requesters differ (D6).
- Routing: org rules before partner-wide rules, first match wins, order `(position, id)` (D7). Default inbound assignee stays as the fallback; its editor moves to the Routing tab, storage `settings.ticketing.inbound.defaultAssigneeUserId` unchanged (D8).
- Business hours live under Settings → Ticketing → Priorities & SLAs; the Regional card is retired (D2). One calendar per org, no per-priority / per-category / per-site calendars (D9, D10).
- Portal shows SLA status only, never a due time (D11). Status values unchanged: `on_track`, `at_risk`, `breached`, `paused`, `met`, `not_configured`.
- Correcting a calendar for open tickets only for tickets with no pause history, behind a preview (D12).
- At-risk ratio is `0.8`, fractional: `warn = add(created_at, 0.8 * target + sla_paused_business_minutes)`; `due = add(created_at, target + sla_paused_business_minutes)` (§4.3). Null calendar = plain minute addition = today's rule.
- SLA targets up to `525600` minutes must be accepted; no horizon cap (§4.4).
- Holiday edits recompute only when `holiday_date > today` in the calendar's time zone; recompute chunk = `500`, `FOR UPDATE SKIP LOCKED` (§4.5).
- Routing keyword list ≤ `20` entries, each `2–100` chars, stored lower-cased; requester domains lower-cased, exact or `*.sub` (§5.1).
- Every new config table: `partner_id` XOR `org_id`, `<table>_one_owner_chk`, RLS enabled + forced, one `FOR ALL` dual-axis policy + a separate `FOR SELECT` partner-wide branch, all in the creating migration. No `org_id NOT NULL` table is added (§8.3).
- No jsonb anywhere new (export classification stays `included`).
- Migrations: hand-written, idempotent, no inner `BEGIN`/`COMMIT`, row writers elect `SELECT set_config('breeze.scope','system',true);` first, then `pnpm db:check-drift`.
- Web: every mutation through `runAction`; every control has a `data-testid`; every new string in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); transient UI state in `window.location.hash` via `useHashState`. Portal has no locale files — plain English.
- AI tool schemas never use `z.undefined()`; tool descriptions ≤ 300 chars naming every action (`aiTools.descriptionBudget.contract.test.ts`).
- Public repo: no customer names, hostnames, IPs in code, tests or PR text.

## Review Focus

Inputs the spec implies but no spec bullet tests; each has a pinned test in the owning task.

1. **Org erasure deletes a survivor before its tombstone.** `tickets_merged_into_org_fk` is `NO ACTION`; if `tenantCascade` (or any retention purge) deletes `tickets` in more than one statement or batch, a survivor can go before its tombstone → 23503 mid-erasure. Expect erasure to succeed. Test: T1.1 step 5.
2. **Merging a ticket whose survivor is itself later merged while a comment is in flight.** A→B, then B→C racing an `addTicketComment` on B. Expect the comment to land on C or be refused `TICKET_MERGED`, never on a tombstone. Test: T1.7 (`comment add vs merge` pair, survivor-side variant).
3. **DST night on a business calendar whose open interval spans the transition** (e.g. 00:00–06:00 in `America/New_York` on 2026-03-08 and 2026-11-01). Expect the interval to count its real elapsed minutes (300 / 420). Test: T3.1.
4. **A routing rule references a category or status that is later archived/deleted, or an assignee who leaves.** Expect: delete refused (`RESTRICT`) for category/status; deleted assignee → action becomes a no-op skip recorded on the ticket, never a broader rule. Test: T5.2.
5. **Portal requester of a tombstone whose survivor was then soft-deleted.** Expect the banner "merged into a deleted ticket", no link, no read of the survivor. Test: T1.12.

---

## Wave map

| Wave | PR content | Depends on | Migration slot | Blast radius |
|---|---|---|---|---|
| **W0** | Ticket-child writer lock-order invariant (spec §3.5 "first task"): writer registry + contract test, `addTicketComment` / `editTicketComment` / `deleteTicketComment` and every other violator re-ordered to ticket-row-first, concurrency tests. No schema. | — | none | high (locking on hot writers) |
| **W1** | Merge backend: tombstone columns, guards, eligibility, preview, execute, route, events, inbound email, movers carry tombstones, readers hide tombstones, Partner API, portal read predicate (API), AI actions. | W0 | `2027-01-02-200000-ticket-merge.sql` | high (data movement, billing rows) |
| **W2** | Merge UI: web dialog + header action + banners + "Show merged" filter; portal banner + list hiding. | W1 | none | medium |
| **W3** | Stored SLA deadlines, no calendar yet: shared calculator, columns + batched backfill, write points, six readers switched, §8.5 corrections, Partner API fields. | — (parallel with W0/W1) | `2027-01-02-190000-ticket-sla-deadlines.sql` (DDL) + `2027-01-02-190100-ticket-sla-deadlines-backfill.sql` + `2027-01-02-190200-ticket-sla-due-indexes.sql`, all `-- @no-transaction` | high (every ticket row, six readers) |
| **W4** | Business-hours calendars: four tables + RLS + registrations, service, resolver, calendar wired into W3 write points, holiday recompute job, D12 apply-revision, routes + AI read tool, Business-hours card, org picker, blob backfill, Regional card removal. | W3 | `2027-01-02-210000-business-calendars.sql` | high (new tenant tables) |
| **W5** | Routing rules: two tables + `tickets.routing_rule_id` + `ticket_statuses (id, partner_id)` key, evaluator in `createTicket`, explicit-choice provenance, routes, Routing tab + fallback editor move, AI tools, cross-context test. | W3 (both edit `createTicket`); W4 for the combined caller-context test | `2027-01-02-220000-ticket-routing-rules.sql` | high (every ticket create) |

Execution order: **W0 ∥ W3 → W1 → W2; W3 → W4 → W5.** W1 and W3 both touch `routes/tickets/tickets.ts` and `ticketSlaWorker.ts`; whichever lands second rebases and keeps the other's predicate (see "Cross-wave rebase rules").

**Migration slots** are reserved from the newest file on main at plan time (`2027-01-02-180000-elevation-device-unable.sql`). Each wave owns its `HH0000–HH5959` block, numbered in the expected landing order W3 (19) → W1 (20) → W4 (21) → W5 (22). A wave that lands out of that order (e.g. W4 before W1) is guaranteed to be overtaken and must take the next free slot at commit. If `origin/main` overtakes a slot before the wave commits, `scripts/check-migration-naming.sh` (pre-commit, pre-push `--against-ref origin/main`) rejects it: take the next free `HHMMSS` after the newest file and say so in the PR body. Never rename after the PR merges.

### Cross-wave rebase rules

- `merged_into_ticket_id IS NULL` (W1) must survive W3's rewrite of the sweep, queue, stats and report SQL. If W1 merged first, W3 keeps it in every rewritten predicate; if W3 merged first, W1 adds it to the stored-column predicates. W3 must **not** reference the column before W1's migration is on main (it would not exist at deploy).
- Hot-table DDL on `tickets` follows the `2026-12-20-200300-ticket-approval-hot-table-columns.sql` discipline: `-- @no-transaction`, `SET lock_timeout = '5s'`, catalog-only `ADD COLUMN`, constraints `NOT VALID` then `VALIDATE` as their own statements, indexes `CONCURRENTLY` after `RESET lock_timeout`, and a final `DO` block that raises on an `INVALID` index.
- W5 inserts routing between requester resolution and the SLA stamp in `createTicket`; W3 has already turned the SLA stamp into `computeSlaDeadlines`. W5 calls routing before it.

---

## Tenancy and registration ledger (all waves)

Grep, don't judge: each line is a mechanical registration the owning task must make. Contract suites marked **IT** only fail in the Integration Tests job.

| Object | Wave | Shape | RLS | Registrations |
|---|---|---|---|---|
| `tickets.merged_into_ticket_id`, `merged_at`, `merged_by_user_id` | W1 | columns on org-cascade table | existing | `CORE_TENANT_EXPORT_POLICY.tickets` `included` (`tenantExportPolicyRegistry.ts:974`); `tickets_merged_into_org_fk` composite `DEFERRABLE INITIALLY IMMEDIATE` added to `SET CONSTRAINTS … DEFERRED` in `ticketService.ts:3608` **and** `deviceOrgMove/moveDeviceOrgInTransaction.ts:207` |
| `ticket_comments.merged_from_ticket_id` | W1 | column; plain FK `ON DELETE SET NULL` | existing (parent policy) | confirm `ticket_comments` has no `org_id` export entry; if it does, classify `included` |
| `tickets.sla_paused_business_minutes`, `response_due_at`, `resolution_due_at`, `response_warn_at`, `resolution_warn_at` | W3 | columns | existing | export `included` |
| `business_calendars` | W4 | dual-axis XOR, `business_calendars_one_owner_chk`, partial unique `(partner_id) WHERE is_partner_default AND org_id IS NULL` | `business_calendars_isolation` FOR ALL + `business_calendars_partner_wide_select` FOR SELECT (template `2027-01-02-130000-flows.sql:91-109`) | `CORE_ORG_CASCADE_DELETE_ORDER`; `orgMergeRegistry` `repoint`; export all `included`; `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`rls-coverage.integration.test.ts:501`, `:912`); `businessCalendarsPartnerRls.integration.test.ts` |
| `business_calendar_revisions`, `business_calendar_intervals`, `business_calendar_holidays` | W4 | dual-axis, owner pair copied from parent, owner-guard constraint trigger (template `2026-10-16-193500-tool-sources.sql:143-177`) | same policy pair as parent | same four lists as parent; revisions UPDATE-immutable trigger, DELETE stays granted → **no** `AUDIT_ADMIN_REQUIRED_TABLES` entry |
| `tickets.sla_calendar_revision_id` | W4 | column, FK → revisions `ON DELETE SET NULL` | existing | export `included`; FK name in `CASCADE_ORDER_SET_NULL_EDGE_BREAKS` (`tenantCascade.ts:1432`) |
| `org_ticket_settings.business_calendar_id` | W4 | column, FK → calendars `ON DELETE SET NULL` + same-partner trigger | existing | export `included` (`tenantExportPolicyRegistry.ts:688`); FK in `CASCADE_ORDER_SET_NULL_EDGE_BREAKS`; org merge stays `keep-survivor` (`orgMergeRegistry.ts:536`) |
| `ticket_routing_rules` | W5 | dual-axis XOR, `ticket_routing_rules_one_owner_chk` | policy pair | cascade order; `orgMergeRegistry` `repoint`; export all `included` (typed arrays); `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; `ticketRoutingRulesPartnerRls.integration.test.ts` |
| `ticket_routing_rule_org_links` | W5 | FK child of the rule; `org_id` is the allowlisted target | parent-join policy (template `2026-07-11-ticket-form-org-links.sql`) | `PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage…:1059`) + `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`:137`) beside `ticket_form_org_links`; cascade order; `orgMergeRegistry` `{ kind: 'repoint-dedupe', key: ['rule_id'] }`; export entry |
| `tickets.routing_rule_id` | W5 | column, FK → rules `ON DELETE SET NULL` | existing | export `included`; FK in `CASCADE_ORDER_SET_NULL_EDGE_BREAKS` |
| `ticket_statuses_id_partner_id_key UNIQUE (id, partner_id)` | W5 | constraint only | — | none |

Not affected (checked): `CORE_DEVICE_CASCADE_DELETE_TABLES`, `TICKET_ORG_DENORMALIZED_TABLES`, `CUSTOM_ORG_REWRITE_TABLES` — no new table has `device_id`, and none has `ticket_id` + denormalized `org_id`.

Cascade order by name (`localeCompare`): `business_calendar_holidays` < `business_calendar_intervals` < `business_calendar_revisions` < `business_calendars`; `ticket_routing_rule_org_links` < `ticket_routing_rules`. The three back-edges from later-sorting tables (`tickets` → revisions, `tickets` → rules, `org_ticket_settings` → calendars) are `SET NULL` edge breaks.

## Rule 9 statements (paste into each wave's PR body)

| Concept | Wave | Home | Level | Resolver | Places configured before → after |
|---|---|---|---|---|---|
| "the hours the SLA clock counts" | W4 | Partner: Ticketing → Priorities & SLAs → Business hours card. Org: Org settings → Ticketing (`OrgTicketSettingsEditor.tsx`) calendar picker, blank = inherit, shows inherited calendar + source | partner default → org override → revision snapshot on ticket | `resolveBusinessCalendar` | 1 → 1 per level (before: Partner → Regional → Business hours, read by nothing; removed in the same PR) |
| "who and what a new ticket is routed to" | W5 | Ticketing → Routing (partner-wide and org rules on one page) | org rules, then partner-wide rules | `evaluateRoutingRules` | 0 → 1; the inbound default-assignee editor moves from `InboundEmailCard.tsx:305-313` into the same tab (storage unchanged), so that concept stays at 1 |
| Merge, W2 dialog | W2 | not a setting | — | — | 0 → 0 |

## CI traps (every wave)

- `pnpm test` skips RLS/integration/contract suites. Run the named **IT** suites on a per-worktree stack (`pnpm test-stack up` … `pnpm test-stack down`) with `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`; RLS coverage only via `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
- Never `pnpm --filter … test -- --run`; vitest path filters are substring matches — list sibling files explicitly and check the reported file count.
- `orgMerge.test.ts` reds only in the FULL API unit suite (missing merge policy). Run it explicitly after any cascade-list edit.
- A PR whose base is not `main` gets no CI: `gh workflow run CI --ref <branch>` and record the run id.
- Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` per touched package; read the exit code, never pipe to `tail`.
- New `apps/api/src/services/**` file → classify it in `parkedFanout.contract.test.ts`; new paths → per-area gating contract (Lint job).
- New route file → `services/mcpCoverage.ts` entry (`mcp-coverage.test.ts` rejects new gaps; `FROZEN_GAPS` only shrinks).
- New worker → `jobs/workerReadinessManifest.ts` entry (`workerReadinessCoverage.test.ts`).

---

## W0 — Ticket-child writer lock-order invariant

Spec §3.5. Invariant: **every writer of a ticket child row locks the ticket row first** (read unlocked → lock ticket → lock child → re-check). Draft send stays draft-before-ticket because `ticket_drafts` is a pre-ticket table in the #3778 order (`ticketService.ts:3615-3640`).

### Task 0.1: Writer registry and source-scan contract

**Files:**
- Create: `apps/api/src/services/ticketChildWriters.ts`
- Create: `apps/api/src/services/ticketChildWriters.contract.test.ts`
- Create: `apps/api/src/services/ticketRowLock.ts` (promote `lockTicketRow`, `timeEntryService.ts:549`)
- Modify: `apps/api/src/services/timeEntryService.ts` (import the promoted helper)

**Interfaces:**
- Produces: `type TicketChildWriterClass = 'ticket-first' | 'pre-ticket-child' | 'mover' | 'cascade' | 'maintenance'` (`maintenance` = retention/cleanup jobs, each with a reason string); the scan proves registration and call order only — lock ordering itself is proven by the T0.2/T0.3 concurrency tests; `export const TICKET_CHILD_WRITERS: Record<string /* file::function */, { tables: readonly string[]; lock: TicketChildWriterClass; tombstoneGuard: boolean }>` (W1 flips `tombstoneGuard`); `export async function lockTicketForWrite(tx: DbExecutor, ticketId: string): Promise<LockedTicketRow>` where `LockedTicketRow = { id; orgId; partnerId; status; deletedAt; workKind }` (W1 adds `mergedIntoTicketId`).

- [ ] **Step 1: Write the failing contract test.** `ticketChildWriters.contract.test.ts` scans **all** of `apps/api/src/**/*.ts` (non-test; includes direct route writers such as `routes/portal/tickets.ts:482` and `services/inboundEmail/emailComments.ts:33`) for `insert|update|delete(<childTable>)` and raw `INSERT INTO|UPDATE|DELETE FROM <childTable>` for the child tables `ticket_comments, ticket_attachments, time_entries, ticket_parts, ticket_checklist_items, ticket_alert_links, ticket_email_links, ticket_external_refs, ticket_links, ticket_drafts`, resolves the enclosing function (exported or not), and asserts:
  - `it('every ticket-child writer is registered')`: each found `file::function` is a key of `TICKET_CHILD_WRITERS`.
  - `it('no registered writer is stale')`: each key still exists in source.
  - `it('ticket-first writers call lockTicketForWrite before the child write')`: for `lock === 'ticket-first'`, the function body's first `lockTicketForWrite(` index < first child-write index.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/ticketChildWriters.contract.test.ts` — expect FAIL (`Cannot find module './ticketChildWriters'`).
- [ ] **Step 3: Implement** the registry by classifying every writer the scan finds (expect `addTicketComment`, `editTicketComment`, `deleteTicketComment`, `sendTicketDraft`, checklist, link, alert-link, email-link, external-ref, attachment, time-entry and part writers, `moveTicketOrg`, the device mover, `tenantCascade`, org-merge executors). Movers/cascades are `mover`/`cascade`; `sendTicketDraft` is `pre-ticket-child`. Promote `lockTicketRow` into `ticketRowLock.ts` as `lockTicketForWrite` (same SQL, `FOR UPDATE`, wider return row).
- [ ] **Step 4: Run the test** — expect the "ticket-first" assertion to FAIL for the current violators only (record the list in the PR body). The other two pass.
- [ ] **Step 5: Commit** `test(api): ticket-child writer registry + lock-order contract (#8972)`.

### Task 0.2: Comment writers lock the ticket first

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` — `addTicketComment` (`:2376`, read at `:2391` is outside the txn at `:2404`), `editTicketComment` (`:3284`), `deleteTicketComment` (`:3324`)
- Create: `apps/api/src/__tests__/integration/ticketCommentLockOrder.integration.test.ts`

**Interfaces:** Consumes `lockTicketForWrite` (T0.1).

- [ ] **Step 1: Write the failing concurrency test** `it('comment edit does not deadlock against a ticket-first writer')`: connection B opens a txn and `SELECT … FROM tickets WHERE id=$t FOR UPDATE`; then the test starts `editTicketComment(commentId, …)` (connection A) without awaiting; B then `UPDATE ticket_comments SET ticket_id = ticket_id WHERE id=$c` and commits. Assert neither side raises `40P01` and the edit resolves with the new content. Same shape for `deleteTicketComment` and for `addTicketComment` (B updates the ticket's `updated_at` instead).
- [ ] **Step 2: Run** on the test stack: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketCommentLockOrder.integration.test.ts` — expect FAIL with `deadlock detected` on the edit/delete cases (A holds the comment row, the feed trigger `breeze_ticket_comments_touch_parent_feed` then waits on the ticket).
- [ ] **Step 3: Implement**: each of the three opens its transaction first, calls `lockTicketForWrite(tx, ticketId)`, then locks/writes the comment, and re-checks the ticket state it previously read unlocked (deleted, org access).
- [ ] **Step 4: Run** the integration test and `npx vitest run src/services/ticketChildWriters.contract.test.ts src/services/ticketService.test.ts` — expect PASS for the three comment writers.
- [ ] **Step 5: Commit** `fix(api): comment writers lock the ticket row first (#8972)`.

### Task 0.3: Remaining violators

**Files:** each writer the T0.1 run listed; one integration test per writer appended to `ticketCommentLockOrder.integration.test.ts` (rename to `ticketChildLockOrder.integration.test.ts` in this task).

- [ ] **Step 1:** For each remaining violator, add a case of the T0.2 shape (B holds the ticket, then writes that writer's child row).
- [ ] **Step 2:** Run — expect FAIL (`40P01`) per case.
- [ ] **Step 3:** Apply the T0.2 pattern.
- [ ] **Step 4:** Run the integration file and the contract test — expect PASS, contract test fully green. Also run `npx vitest run src/services/ticketOrgMoveLockOrder.test.ts src/services/timeEntryWriters.contract.test.ts`.
- [ ] **Step 5: Commit** `fix(api): ticket-child writers lock ticket first (#8972)`.

**W0 gates:** API typecheck exit 0; `ticketChildWriters.contract.test.ts`, `ticketService.test.ts`, `ticketOrgMoveLockOrder.test.ts` green; IT `ticketChildLockOrder`, `ticket-move-org`, `ticketLinksOrgMove`, `ticketCommentsFeedRestamp` green.

---

## W1 — Merge backend (`2027-01-02-200000-ticket-merge.sql`)

### Task 1.1: Schema, FK, registrations

**Files:**
- Create: `apps/api/migrations/2027-01-02-200000-ticket-merge.sql`
- Modify: `apps/api/src/db/schema/portal.ts` (tickets `:174-265`, ticket_comments `:269`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:974`
- Modify: `apps/api/src/services/ticketService.ts:3608`, `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts:207`
- Test: `apps/api/src/__tests__/integration/ticketMergeSchema.integration.test.ts`

- [ ] **Step 1: Write the failing test** (IT) `ticketMergeSchema.integration.test.ts`:
  - `it('rejects self-merge')` → insert `merged_into_ticket_id = id` fails 23514.
  - `it('rejects merged_at without merged_into')` → 23514.
  - `it('rejects a cross-org survivor')` → 23503 on `tickets_merged_into_org_fk`.
  - `it('blocks hard delete of a survivor with tombstones')` → `DELETE` survivor alone fails 23503.
  - `it('FK is deferrable')` → `SELECT condeferrable FROM pg_constraint WHERE conname='tickets_merged_into_org_fk'` is true.
- [ ] **Step 2: Run** — FAIL (column does not exist).
- [ ] **Step 3: Implement the migration** as a `-- @no-transaction` hot-table file (Cross-wave rules: `lock_timeout`, FK and CHECKs `NOT VALID` then `VALIDATE`, index `CONCURRENTLY` + INVALID-index guard; no row writes, no scope election needed): `ADD COLUMN IF NOT EXISTS` × 3 on `tickets` (`merged_into_ticket_id uuid`, `merged_at timestamp`, `merged_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`); `DROP CONSTRAINT IF EXISTS` + add `tickets_merged_into_org_fk FOREIGN KEY (merged_into_ticket_id, org_id) REFERENCES tickets(id, org_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`, `tickets_merged_into_not_self_chk`, `tickets_merged_pair_chk CHECK ((merged_into_ticket_id IS NULL) = (merged_at IS NULL))`; `CREATE INDEX IF NOT EXISTS tickets_merged_into_idx ON tickets(merged_into_ticket_id) WHERE merged_into_ticket_id IS NOT NULL`; `ticket_comments.merged_from_ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL`. Drizzle columns + the composite FK declared in Drizzle. Export policy: three new `tickets` columns `included`. Add `tickets_merged_into_org_fk` to both `SET CONSTRAINTS … DEFERRED` lists.
- [ ] **Step 4: Run** the IT file, then `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`, `pnpm db:migrate && pnpm db:check-drift`, IT `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgLifecycleFoundations` — expect PASS.
- [ ] **Step 5: Review Focus #1 test** — append `it('org erasure deletes survivors and tombstones together')` to `tenantCascade.integration.test.ts` (or a new `ticketMergeErasure.integration.test.ts`): seed survivor + 2 tombstones, run the org cascade delete, assert success and zero rows. If it fails, make the `tickets` cascade step delete tombstones (`merged_into_ticket_id IS NOT NULL`) before survivors in the same step; also grep every hard-delete of `tickets` (`rg -n "delete\(tickets\)|DELETE FROM (public\.)?tickets" apps/api/src`) and apply the same order.
- [ ] **Step 6: Run** and **commit** `feat(api): ticket merge tombstone columns (#8972)`.

### Task 1.2: Tombstone guard on every writer

**Files:**
- Create: `apps/api/src/services/ticketMerge/errors.ts`
- Modify: `apps/api/src/services/ticketRowLock.ts` (return `mergedIntoTicketId`), `ticketChildWriters.ts` (`tombstoneGuard: true` for every `ticket-first` / `pre-ticket-child` writer), every registered writer, plus `changeTicketStatus` (`:1442`), `updateTicketFields` (`:1905`), `assignTicket` (`:2243`), `applyAiFieldUpdates` (`:2822`), `moveTicketOrg` (`:3537`), `restoreTicket` (`:3408`), approval request create, alert link
- Modify: `ticketChildWriters.contract.test.ts`

**Interfaces:**
- Produces: `class TicketMergedError extends Error { code = 'TICKET_MERGED'; status = 409; mergedIntoTicketId: string }`; `function assertTicketNotMerged(row: Pick<LockedTicketRow,'id'|'mergedIntoTicketId'>): void`.

- [ ] **Step 1: Failing tests.** Contract: `it('guarded writers call assertTicketNotMerged after lockTicketForWrite')`. Unit (`ticketService.test.ts`, mocked lock row with `mergedIntoTicketId` set): one `it('refuses <writer> on a tombstone with TICKET_MERGED')` per writer in the registry plus the ticket-row writers listed above.
- [ ] **Step 2: Run** `npx vitest run src/services/ticketChildWriters.contract.test.ts src/services/ticketService.test.ts` — FAIL.
- [ ] **Step 3: Implement** the guard call immediately after the lock in each writer. **Exception — security effects never throw on a tombstone:** caller-verification effects (`services/callerVerification/effects.ts:33`, `addCallerVerificationSystemComment` `ticketService.ts:444`) resolve a tombstone through `merged_into_ticket_id` under the lock and write to the survivor, so a merge can never roll back a verification rejection (unit test `it('verification decision on a merged ticket lands on the survivor')`). Route `handleServiceError` maps `TicketMergedError` to `409 { error, code: 'TICKET_MERGED', details: { mergedIntoTicketId } }`.
- [ ] **Step 4: Run** — PASS. **Commit** `feat(api): tombstones are read-only (#8972)`.

### Task 1.3: Eligibility

**Files:** Create `apps/api/src/services/ticketMerge/eligibility.ts` + `eligibility.test.ts`.

**Interfaces:**
- Produces: `type MergeRefusalCode = 'MERGE_SAME_TICKET' | 'MERGE_CROSS_ORG' | 'MERGE_SOURCE_INELIGIBLE' | 'MERGE_SURVIVOR_INELIGIBLE' | 'MERGE_DELIVERABLE_PINNED' | 'MERGE_IMPORT_WINDOW' | 'MERGE_APPROVAL_STATE' | 'MERGE_WORK_KIND_MISMATCH' | 'MERGE_PENDING_INTENTS' | 'ORG_MERGING' | 'MERGE_SCOPE_DENIED'`; `class MergeRefusedError extends Error { status = 409; code: MergeRefusalCode; side: 'source' | 'survivor' | 'both' }`; `async function checkMergeEligibility(db: DbExecutor, src: MergeTicketRow, dst: MergeTicketRow, actor: TicketActor): Promise<MergeRefusal[]>` (returns all refusals, for the preview); `async function assertMergeEligible(...same): Promise<void>` (throws the first).

- [ ] **Step 1: Failing tests**, one `it` per code with the spec's rule (§3.1): source may be resolved/closed but not deleted/merged; survivor not closed/deleted/merged; deliverable pin via `assertTicketNotPinnedToDeliverable` (`ticketService.ts:3491`) on both; `migration_window_id` open on either; any `ticket_approval_requests` row or non-null `budget_minutes`/`budget_amount` on **either** side; differing `work_kind`; pending `action_intents` with `scope_ticket_id = source`; org `status = 'merging'`; site/device restriction (`assertAssigneeEligible` semantics, `:532`) must pass for **both** tickets.
- [ ] **Step 2: Run** `npx vitest run src/services/ticketMerge/eligibility.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS. **Commit** `feat(api): merge eligibility (#8972)`.

### Task 1.4: Re-point engine and execute

**Files:**
- Create: `apps/api/src/services/ticketMerge/repoint.ts`, `execute.ts`, `index.ts`
- Modify: `apps/api/src/services/timeEntryWriters.contract.test.ts` (`TIME_ENTRY_WRITER_ALLOWLIST` entry `'services/ticketMerge/repoint.ts': 'same-org merge re-points ticket_id; billing fields unchanged (spec §3.3)'` — that scanner covers `time_entries` only; `ticket_parts` writes are covered by the T0.1 registry)
- Modify: `apps/api/src/services/parkedFanout.contract.test.ts` (classify new files)
- Test: `apps/api/src/__tests__/integration/ticketMerge.integration.test.ts`

**Interfaces:**
- Consumes: `lockOrgTicketLinks(tx, orgId, 'exclusive')` (`ticketLinkLock.ts:31`), `lockTicketForWrite`, `assertMergeEligible`, `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` (`ticketOrgMoveLockOrder.ts`).
- Produces: `type MergeCounts = Record<MergedTable, number>`; `type DroppedLink = { linkId; linkType; otherTicketId; reason: 'between_pair' | 'pair_unique' | 'self' | 'canonical_duplicate' | 'cycle' | 'limit' }`; `async function mergeTickets(input: { sourceTicketId: string; intoTicketId: string; notifyRequester: boolean }, actor: TicketActor): Promise<{ survivorId: string; counts: MergeCounts; droppedLinks: DroppedLink[]; retainedExternalRefIds: string[] }>`; `async function repointTicketChildren(tx, srcId, dstId, orgId): Promise<{ counts; droppedLinks; retainedExternalRefIds }>`.

- [ ] **Step 1: Failing IT tests**, one `it` per §3.3 row, each seeding source + survivor in one org and asserting post-merge state:
  - comments re-pointed, `merged_from_ticket_id = source` only where null (a twice-merged comment keeps the earliest origin);
  - internal system comment on the survivor containing source subject, description, intake answers and the dropped-link list, `is_public = false`;
  - attachments follow; time entries (billed, contract, block-drawn, running timer) re-pointed with `billing_status`, rate, amount unchanged; `invoice_lines.ticket_id` still = source and `ticket_label` unchanged;
  - parts (incl. billed); checklist `sort_order` offset past survivor max; alert links de-duplicated (survivor row wins);
  - email links re-pointed, source `email_message_id`/`email_thread_key` remain on tombstone;
  - external refs re-pointed except a same-principal collision, which stays;
  - links: between-pair deleted, `related` re-canonicalised (`source < target`), collisions dropped and listed, `duplicate_of` → survivor where allowed;
  - `device_vulnerabilities.ticket_id`, `organization_key_dates.reminder_ticket_id`, `service_deliverable_occurrences.ticket_id`, `ai_operator_task_targets.ticket_id` re-pointed;
  - device: survivor keeps its own or takes source's; tombstone `device_id` NULL; original in audit details;
  - tags union; source drafts deleted;
  - stays on tombstone: `ticket_outbox`, `ai_agent_runs`, `action_intents.scope_ticket_id`, `partner_api_idempotency_keys`, `ticket_email_inbound`, `invoice_lines`, `caller_verifications.ticket_ref` (Gate B6), SLA stamps;
  - tombstone: core `closed`, partner's system closed `status_id`, `closed_at`/`closed_by`/`resolved_at` set, `resolution_note = 'Merged into T-…'`, open pause folded into `sla_paused_minutes` (and, after W3, `sla_paused_business_minutes`) with `sla_paused_at` cleared; **no** "resolved" customer mail;
  - path compression: `it('A→B then B→C leaves A pointing at C')`;
  - `it('survivor feed xid bumped exactly once; moved comments do not fire the feed trigger')`.
- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement `mergeTickets`** in one request transaction with the §3.5 order: (1) `lockOrgTicketLinks(tx, orgId, 'exclusive')` holding no row lock; (2) `organizations` row `FOR SHARE`, refuse `merging`; (3) source's `action_intents` (refuse pending), `ticket_drafts`, `ai_agent_runs`, `ai_operator_task_targets`; (4) source, survivor and every ticket with `merged_into_ticket_id = source` `FOR UPDATE` in ascending id, then `assertMergeEligible` again; (5) `ticket_comments`, then `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER`. Then the tombstone transition (dedicated, not `changeTicketStatus`), path compression, outbox rows (T1.6) inside the txn. The device hand-over writes only `tickets.device_id`; merge takes **no** `devices` row lock after the link lock (the parked-device inversion, `ticketLinkLock.ts:21-30`). Wrap the whole call in one retry on `40P01`.
- [ ] **Step 4: Run** IT file + `npx vitest run src/services/timeEntryWriters.contract.test.ts src/services/ticketChildWriters.contract.test.ts src/services/parkedFanout.contract.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(api): merge re-point engine (#8972)`.

### Task 1.5: Preview and routes

**Files:**
- Create: `apps/api/src/services/ticketMerge/preview.ts`, `apps/api/src/routes/tickets/merge.ts`, `merge.test.ts`
- Modify: `apps/api/src/routes/tickets/index.ts` (mount before `ticketsApiRoutes`, beside `:26`), `apps/api/src/services/mcpCoverage.ts` (`'tickets/merge.ts': { tools: ['manage_tickets'] }`)
- Modify: `packages/shared/src/validators/tickets.ts` (`mergeTicketSchema`, `mergePreviewQuerySchema`)

**Interfaces:**
- Produces: `type MergePreview = { eligible: boolean; refusals: MergeRefusal[]; counts: MergeCounts; droppedLinks: DroppedLink[]; retainedExternalRefs: { id; principalName }[]; deviceDifference: { source: string | null; survivor: string | null; result: string | null }; requestersDiffer: boolean; sourceRequesterGainsAccess: boolean; suggestedSurvivorId: string }`; `GET /tickets/:id/merge-preview?into=<uuid>` → `MergePreview`; `POST /tickets/:id/merge` body `{ intoTicketId: uuid; notifyRequester?: boolean }` → `{ survivorId, counts, droppedLinks }`.

- [ ] **Step 1: Failing route tests** (`merge.test.ts`, Drizzle mocks per `breeze-testing`): 401/403 without `tickets:write`; org-scope token can merge inside its own org (route uses `requireScope('organization','partner','system')`, unlike move-org); 404 when either ticket is outside `auth`'s orgs; 409 with typed code per refusal; preview is read-only (no `insert`/`update` calls); `notifyRequester` defaults to `requestersDiffer` when omitted; `suggestedSurvivorId` = older `created_at`.
- [ ] **Step 2: Run** `npx vitest run src/routes/tickets/merge.test.ts` — FAIL.
- [ ] **Step 3: Implement** (preview computes counts with `SELECT count(*)` per table, no locks; POST calls `mergeTickets`; `requireMfa()` as move-org does).
- [ ] **Step 4: Run** + `npx vitest run src/__tests__/mcp-coverage.test.ts` — PASS. **Commit** `feat(api): merge preview + merge routes (#8972)`.

### Task 1.6: Events, notifications, audit

**Files:**
- Modify: `apps/api/src/db/schema/ticketOutbox.ts:38` (`'ticket.merged'`), `apps/api/src/jobs/ticketOutboxPublisher.ts:62` (bridge), `apps/api/src/services/eventBus.ts:11` + `EVENT_TYPES` (`:656-662`), `apps/api/src/services/ticketEvents.ts:35` (variant), `apps/api/src/jobs/ticketNotifyWorker.ts`, `services/ticketMerge/execute.ts`
- Modify: outbound email template registry (from `docs/superpowers/plans/ticketing/2026-09-16-outbound-email-templates.md`) — new built-in key `ticket_merged` (Gate B8)
- Modify: Partner API events docs page (`rg -l "ticket.status_changed" apps/docs`)
- Test: `ticketEventsContract.test.ts`, `ticketOutboxPublisher.test.ts`, `ticketNotifyWorker.test.ts`, IT `ticketMerge.integration.test.ts`

**Interfaces:** Produces outbox payload `{ sourceTicketId, targetTicketId, sourceInternalNumber, targetInternalNumber }` (ids/numbers only); `TicketEvent` variant `{ type: 'ticket.merged'; sourceTicketId; targetTicketId; notifyRequester: boolean; actor }`.

- [ ] **Step 1: Failing tests:** publisher maps `ticket.merged` → eventBus `ticket.merged`; merge writes `ticket.merged`, `ticket.updated` for the survivor with `changed: ['merge']`, `ticket.status_changed` for the source **only** when its status changed, and zero `ticket.commented`; notify worker sends an in-app notice to the survivor assignee unless they are the actor, and exactly one requester email when `notifyRequester` (threading headers of the survivor); audit rows `ticket.merge.source` / `ticket.merge.target` with counts, dropped links, original device, actor identity (`actorAuditIdentity`, `ticketService.ts:179`), `notifyRequester`.
- [ ] **Step 2: Run** the four files — FAIL.
- [ ] **Step 3: Implement.** Outbox rows inside the txn; events and audit after commit (#1105), as move-org does (`:3984-3985`).
- [ ] **Step 4: Run** — PASS. **Commit** `feat(api): ticket.merged events + notifications (#8972)`.

### Task 1.7: Concurrency pairs

**Files:** Create `apps/api/src/__tests__/integration/ticketMerge.concurrency.integration.test.ts` (shape: `ticketApprovalGate.concurrency.integration.test.ts`).

- [ ] **Step 1: Write** one `it` per pair, each starting both operations on separate connections with a barrier and asserting no `40P01` escapes (merge may retry once) and a consistent end state: merge vs `sendTicketDraft`, `editTicketComment`, `addTicketComment` (source side → comment lands on survivor or `TICKET_MERGED`; survivor-side chained A→B→C variant, Review Focus #2), timer stop, link add, `moveTicketOrg` (either order), device move, SLA sweep tick.
- [ ] **Step 2: Prove the pairs discriminate (mutation control).** Temporarily make `mergeTickets` lock children before tickets (swap steps 4 and 5) and disable the 40P01 retry; run — expect at least the comment-edit, draft-send and move-org pairs to FAIL with `40P01`. Record the red output in the PR body, then restore.
- [ ] **Step 3: Run** the restored code — PASS. Any red is a lock-order bug: fix in the writer (W0 pattern), never by widening the retry.
- [ ] **Step 4: Commit** `test(api): merge concurrency pairs (#8972)`.

### Task 1.8: Inbound email after a merge

**Files:** Modify `apps/api/src/services/inboundEmail/threadMatcher.ts` (`senderIsBoundToTicket :89`, `senderIsThreadParticipant :125`, `findTicketInPartner :173`, filters `:198`, `:226`, `findClosedTicketInPartner :254`); tests `threadMatcher.test.ts` + IT `inboundEmailMerge.integration.test.ts`.

- [ ] **Step 1: Failing tests:** a header reply to the source's `email_message_id`, a bracketed subject token for the source number, and a sender bound only to the source (incl. only via the tombstone's `ticket_email_inbound` history) each land on the survivor; `findClosedTicketInPartner` never returns a tombstone; subject-token binding strictness and current-org check unchanged.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement:** resolve the matched row through `merged_into_ticket_id` (one hop) **before** the `status != 'closed'` filter on both paths; extend both sender checks to tombstones whose `merged_into_ticket_id = matched.id`.
- [ ] **Step 4: Run** — PASS. **Commit** `feat(api): inbound mail follows merged tickets (#8972)`.

### Task 1.9: Movers carry tombstones

**Files:** Modify `ticketService.ts` `moveTicketOrg`, `deviceOrgMove/moveDeviceOrgInTransaction.ts`; tests IT `ticket-move-org.integration.test.ts`, `deviceMoveOrg*.integration.test.ts` (existing device-move IT file), `orgMergeRegistry.integration.test.ts`.

**Interfaces:** Extract `moveSingleTicketOrgInTx(tx, ticketId, targetOrgId, actor)` from `moveTicketOrg` (`:3537-3987`) so the mover can run it per tombstone.

- [ ] **Step 1: Failing tests:** moving a tombstone → 409 `TICKET_MERGED`; moving a survivor moves every tombstone with the full per-ticket routine (intents, drafts, outbox, idempotency, external refs, comments, links) and `tickets_merged_into_org_fk` holds after commit; device move of a survivor's device carries its tombstones; org merge keeps self-references inside the surviving org.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (tombstones locked with the survivor in ascending id). **Step 4: Run** — PASS, plus `npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/services/ticketOrgMoveLockOrder.test.ts src/services/orgMerge.test.ts`.
- [ ] **Step 5: Commit** `feat(api): movers carry merged tombstones (#8972)`.

### Task 1.10: Readers hide tombstones

**Files:** `routes/tickets/tickets.ts` (list/search/closed filter `:68`, `:348`; stats `:232-251`; queue `:355-373`), `jobs/ticketSlaWorker.ts:71-110`, `services/businessReports/ticketSlaReport.ts:98-134` + notes `:40`, `technicianTimeReport.ts`, `reportGenerationService.ts`, `services/orgAccountReadiness.ts:338`, `packages/shared/src/validators/tickets.ts` (list query `showMerged?: boolean`).

- [ ] **Step 1: Failing tests** per reader: a tombstone is absent by default and present with `showMerged=true` (list/search only); excluded from stats, at-risk/breached queue, sweep, SLA attainment and resolution-time analytics; report notes array gains the "merged tickets excluded" note.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `merged_into_ticket_id IS NULL` in each (list every reader touched in the PR body). **Step 4: Run** — PASS. **Commit** `feat(api): readers hide merged tombstones (#8972)`.

### Task 1.11: Partner API

**Files:** `routes/partnerApi/tickets.ts` (`toPartnerTicketRecord :212`, schema `schemas.ts:734-741`), `routes/partnerApi/ticketWrites.ts` (`findIdempotencyReplay :262`, `load`), tests beside each.

- [ ] **Step 1: Failing tests:** `GET` of a tombstone returns `mergedIntoTicketId` + `mergedAt` (additive, null on normal tickets); feed re-delivers both tickets after a merge; an idempotent create replay whose stored key names a tombstone returns the original response (not `gone`/404); a comment replay whose comment moved resolves by comment id.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Commit** `feat(api): partner API exposes merged tickets (#8972)`.

### Task 1.12: Portal read predicate (API)

**Files:** Create `apps/api/src/routes/portal/ticketReadAccess.ts` (beside `ticketOwnership.ts:31`); modify `routes/portal/tickets.ts` (list `:189`, detail `:349`, comment POST `:450-471`, attachment `:655`), `dashboard.ts:36`; tests `ticketReadAccess.test.ts`, `tickets.test.ts`, IT `portalTicketMerge.integration.test.ts`.

**Interfaces:** `function portalTicketReadAccess(user: PortalUser): SQL` = ownership OR `tickets.id IN (SELECT merged_into_ticket_id FROM tickets t2 WHERE <ownership on t2> AND t2.merged_into_ticket_id IS NOT NULL)`; detail payload for a tombstone `{ merged: true, mergedInto: { id, internalNumber } | null, mergedAt }`.

- [ ] **Step 1: Failing tests:** source requester reads the survivor's **public** thread and can post a public comment (D1(b)); cannot read internal comments (incl. the merge copy); approvals and comment PATCH/DELETE still require ownership/`portal_user_id`; list hides tombstones and shows the survivor; tombstone detail returns the merged payload with `mergedInto` null when the user may not read the survivor; Review Focus #5 — survivor soft-deleted → `mergedInto: null`, `survivorDeleted: true`, no survivor read; dashboard count excludes tombstones.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (comment POST switches to `portalTicketReadAccess` with a comment citing D1(b); every other write keeps `portalTicketOwnership`; attachment reads keep their public + non-deleted filters (`tickets.ts:683`) and comment PATCH/DELETE keep the author check (`:554`)). **Step 4: Run** — PASS. **Commit** `feat(api): portal read access follows merges (#8972)`.

### Task 1.13: AI tool actions

**Files:** `services/aiToolsTicketing.ts` (enum `:679-700`), `services/aiGuardrails.ts` (`TIER1_READ_ACTIONS :315` += `merge_preview`; tier-3 approval list += `merge`), tests `aiToolsTicketing.test.ts`, `aiToolsTicketing.schema.test.ts`, `aiTools.descriptionBudget.contract.test.ts`.

- [ ] **Step 1: Failing tests:** `merge_preview` is tier 1 and returns `MergePreview`; `merge` requires approval (tier 3), passes `notifyRequester`, maps `MergeRefusedError` to a tool error with the code; schema has no `z.undefined()`; description names both actions within budget.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Commit** `feat(api): AI merge actions (#8972)`.

**W1 gates:** API typecheck exit 0; full API unit suite (catches `orgMerge.test.ts`); IT: `ticketMerge*`, `ticketMergeSchema`, `ticketChildLockOrder`, `inboundEmailMerge`, `portalTicketMerge`, `ticket-move-org`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations`; `ticketOrgMoveLockOrder.test.ts`, `mcp-coverage.test.ts`, `migrationRlsScope.test.ts`; `pnpm db:check-drift`.

---

## W2 — Merge UI

### Task 2.1: Merge dialog and header action (web)

**Files:** Create `apps/web/src/components/tickets/MergeTicketDialog.tsx` + `.test.tsx`; modify `TicketWorkbench.tsx` (header actions beside move-org), `apps/web/src/locales/*/tickets.json` (8 locales).

**Interfaces:** Consumes `GET /tickets/:id/merge-preview`, `POST /tickets/:id/merge` (T1.5).

- [ ] **Step 1: Failing tests:** "Merge into…" opens the dialog (`data-testid="ticket-merge-open"`); picker (`ticket-merge-picker`) lists same-org tickets with the older one first; preview renders counts, dropped links, retained refs, device and requester differences, refusal codes as copy; notify checkbox (`ticket-merge-notify`) defaults to checked iff `requestersDiffer`; confirm (`ticket-merge-confirm`) shows the irreversible warning and calls `runAction`; on 409 no extra toast (ActionError already toasted); on success navigates to the survivor.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/tickets/MergeTicketDialog.test.tsx` — FAIL.
- [ ] **Step 3: Implement**; add keys to all 8 locales.
- [ ] **Step 4: Run** + `npx vitest run src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts` — PASS. **Commit** `feat(web): merge ticket dialog (#8972)`.

### Task 2.2: Tombstone and survivor views (web)

**Files:** `TicketWorkbench.tsx`, the comment timeline component, the ticket list filter bar, locales.

- [ ] **Step 1: Failing tests:** a tombstone renders a banner "Merged into T-…" with a link (`ticket-merged-banner`) and all write controls disabled; survivor-deleted tombstone shows "merged into a deleted ticket"; moved comments show "from T-…"; the list has a "Show merged" toggle (`ticket-list-show-merged`) that sends `showMerged=true`, with selection in hash state via `useHashState`.
- [ ] **Step 2–4:** Run → FAIL; implement; run → PASS (+ `localeParity`). **Commit** `feat(web): merged ticket banners + list filter (#8972)`.

### Task 2.3: Portal banner and list

**Files:** `apps/portal/src/components/portal/TicketDetails.tsx`, `TicketList.tsx`, tests beside each.

- [ ] **Step 1: Failing tests:** tombstone detail shows "This request was merged into T-…" with a link only when `mergedInto` is non-null; list never shows tombstones; plain English (no locale files).
- [ ] **Step 2–4:** `cd apps/portal && npx vitest run src/components/portal/TicketDetails.test.tsx src/components/portal/TicketList.test.tsx` FAIL → implement → PASS. **Commit** `feat(portal): merged-ticket banner (#8972)`.

### Task 2.4: E2E

**Files:** `e2e-tests/tests/ticket-merge.spec.ts`, page object in `e2e-tests/pages/`.

- [ ] **Step 1:** Spec: create two tickets in one org, comment on each, merge the newer into the older via the dialog, assert the survivor timeline has both comments and the tombstone URL shows the banner — `data-testid` selectors only.
- [ ] **Step 2:** Write the spec **before** T2.1's dialog is wired into `TicketWorkbench` and run it against a `worktree-stack` — expect FAIL (no `ticket-merge-open`); record the failing run.
- [ ] **Step 3:** After T2.1–T2.3, run — PASS. **Commit** `test(e2e): ticket merge (#8972)`.

**W2 gates:** web + portal typecheck exit 0; web/portal unit suites for touched files; `localeParity`, `no-silent-mutations`; e2e spec green locally (UI-test hold is Todd's call).

---

## W3 — Stored SLA deadlines (`2027-01-02-190000`, `2027-01-02-190100`, `2027-01-02-190200`)

### Task 3.1: Business-time calculator

**Files:** Create `packages/shared/src/utils/businessTime.ts` + `businessTime.test.ts`; export from `packages/shared/src/utils/index.ts` (if a barrel exists). Reuse `packages/shared/src/utils/timezone.ts` (`isValidIanaTimezone :22`, `normalizeTimezone :35`).

**Interfaces:**
- Produces: `type CalendarInterval = { weekday: 0|1|2|3|4|5|6; startMinute: number; endMinute: number }`; `type CalendarRevision = { timezone: string; intervals: readonly CalendarInterval[] }`; `type HolidaySet = readonly string[] /* 'YYYY-MM-DD', sorted, calendar-local */`; `function addBusinessMinutes(rev: CalendarRevision | null, holidays: HolidaySet, start: Date, minutes: number): Date` (fractional minutes, second precision); `function businessMinutesBetween(rev: CalendarRevision | null, holidays: HolidaySet, a: Date, b: Date): number`; `function weeklyOpenMinutes(rev: CalendarRevision): number`; `function validateRevision(rev: CalendarRevision): { ok: true } | { ok: false; code: 'NO_INTERVALS' | 'OVERLAP' | 'BAD_RANGE' | 'BAD_TIMEZONE' }`.

- [ ] **Step 1: Failing tests:**
  - `rev = null` → `addBusinessMinutes(null, [], t, n) = t + n min` exactly, incl. `n = 0.8 * 45` (36 min) and `0.8 * 7` (5.6 min = 336 s).
  - Property (seeded loop, 500 cases, 3 zones): `businessMinutesBetween(r, h, s, addBusinessMinutes(r, h, s, n)) === n`.
  - Mon–Fri 09:00–17:00 `Europe/London`: Fri 16:00 + 120 → Mon 10:00; start on a weekend → Mon 09:00 + n.
  - DST: `America/New_York` 2026-03-08 and 2026-11-01, `Europe/London` 2026-03-29 and 2026-10-25, `Australia/Sydney` 2026-04-05 and 2026-10-04; an interval 00:00–06:00 across the change counts real elapsed minutes (300 / 420) — Review Focus #3.
  - Split shift 08:00–12:00 + 13:00–17:00; holiday on Monday and on the Friday that closes a week jump.
  - `525600` minutes on a 40 h/week calendar terminates and round-trips (performance: < 50 ms).
  - `validateRevision`: overlap → `OVERLAP`; empty → `NO_INTERVALS`; `start >= end` → `BAD_RANGE`; `Mars/Phobos` → `BAD_TIMEZONE`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/utils/businessTime.test.ts` — FAIL.
- [ ] **Step 3: Implement**: walk the first partial week by interval, jump whole weeks in O(1) using `weeklyOpenMinutes` minus holiday minutes inside each jump (binary search the sorted holiday list), walk the last partial week. Local↔UTC conversion via `Intl.DateTimeFormat(..., { timeZone }).formatToParts` probing (pattern `patchSchedulerWorker.ts:122-131`); never construct local times by offset arithmetic across a transition.
- [ ] **Step 4: Run** — PASS; shared typecheck exit 0. **Commit** `feat(shared): business-time calculator (#8973)`.

### Task 3.2: Columns and backfill

**Files:**
- Create: `apps/api/migrations/2027-01-02-190000-ticket-sla-deadlines.sql` (DDL), `apps/api/migrations/2027-01-02-190100-ticket-sla-deadlines-backfill.sql` (backfill)
- Modify: `db/schema/portal.ts` (tickets), `tenantExportPolicyRegistry.ts:974`
- Test: IT `ticketSlaDeadlinesBackfill.integration.test.ts`

- [ ] **Step 1: Failing IT test** `it('backfill reproduces the pre-W3 breach and at-risk sets')`: seed a fixture set (null targets, paused, resumed with `sla_paused_minutes`, responded, resolved, reopened, fractional 0.8 targets), compute the pre-W3 sets with the **old** SQL predicates copied verbatim into the test (`tickets.ts:74-91`, `ticketSlaWorker.ts:92-93`), replay both migrations via `replayMigration`, compute the new sets from stored columns, assert equal. Second case `it('backfill is resumable')`: abort after one batch, re-run, assert the same end state.
- [ ] **Step 2: Run** — FAIL (columns missing).
- [ ] **Step 3: Implement the DDL file** (`-- @no-transaction`, hot-table discipline, no row writes): `ADD COLUMN IF NOT EXISTS sla_paused_business_minutes integer NOT NULL DEFAULT 0` (catalog-only), `response_due_at`, `resolution_due_at`, `response_warn_at`, `resolution_warn_at` (`timestamp` without tz, nullable). Drizzle + export `included`.
- [ ] **Step 4: Implement the backfill file** (`-- @no-transaction`, Gate B11): `CREATE OR REPLACE PROCEDURE public.breeze_backfill_ticket_sla_deadlines(batch int)` that loops `UPDATE tickets … WHERE ctid IN (SELECT ctid … WHERE <target non-null AND due column null> LIMIT batch)`, `PERFORM set_config('breeze.scope','system',true)` at the top of **every** iteration (a `COMMIT` resets the local setting), `COMMIT` after each batch, `RAISE NOTICE` running total; then `CALL public.breeze_backfill_ticket_sla_deadlines(5000);` and `DROP PROCEDURE`. Values: `response_due_at = created_at + (response_sla_minutes + sla_paused_minutes) * interval '1 minute'`, `response_warn_at = created_at + (0.8 * response_sla_minutes + sla_paused_minutes) * interval '1 minute'`, same for resolution, `sla_paused_business_minutes = sla_paused_minutes`. Header comment states: the `breeze_tickets_partner_feed_xid` BEFORE UPDATE trigger restamps every row, so Partner API feed consumers re-receive all tickets once (Gate B3). **Fallback:** if `autoMigrate`'s `@no-transaction` path or `migrationRlsScope.test.ts` cannot accept a transaction-controlling `CALL` (prove it on the test stack first), use a transactional `DO $$` ctid loop in this second file instead (precedent `2026-10-24-210000-time-entries-billable-minutes.sql`) — row locks only, the DDL is already committed — and say so in the PR body.
- [ ] **Step 5: Run** IT + `npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`, `pnpm db:migrate && pnpm db:check-drift`, IT `tenant-export-policy` — PASS. **Commit** `feat(api): stored SLA deadline columns + backfill (#8973)`.

### Task 3.3: Sweep indexes

**Files:** Create `apps/api/migrations/2027-01-02-190200-ticket-sla-due-indexes.sql` (first line `-- @no-transaction`; precedent `2026-12-13-120100-tickets-partner-feed-index.sql`, including its INVALID-index detection); Drizzle index declarations.

- [ ] **Step 1: Failing IT test** (in `ticketSlaDeadlinesBackfill.integration.test.ts`): `EXPLAIN` of the T3.5 sweep query uses `tickets_sla_response_due_idx` / `tickets_sla_resolution_due_idx`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_response_due_idx ON tickets (response_due_at) WHERE status IN ('new','open') AND work_kind = 'support' AND sla_paused_at IS NULL AND first_response_at IS NULL AND response_due_at IS NOT NULL` and the resolution twin (`resolved_at IS NULL`). Keep `tickets_sla_sweep_idx` (Gate B7). **Step 4: Run** — PASS, `pnpm db:check-drift`. **Commit** `feat(api): SLA due-at sweep indexes (#8973)`.

### Task 3.4: Write points

**Files:** Create `apps/api/src/services/ticketSlaDeadlines.ts` + `.test.ts`; modify `ticketService.ts` — `createTicket :1248`, `updateTicketFields` restamp `:2081-2111` and explicit override, `applyAiFieldUpdates :2912-2945`, `changeTicketStatus` pause fold `:1635-1648` and reopen `:1623-1628`, first-response writers `:2437`, `:2445`, `:3062`; movers (hook only, calendar null until W4).

**Interfaces:**
- Produces: `type SlaClockRow = { createdAt: Date; responseSlaMinutes: number | null; resolutionSlaMinutes: number | null; slaPausedAt: Date | null; slaPausedBusinessMinutes: number; firstResponseAt: Date | null; resolvedAt: Date | null; slaBreachReason: string | null }`; `type SlaDeadlinePatch = Partial<{ responseDueAt: Date | null; responseWarnAt: Date | null; resolutionDueAt: Date | null; resolutionWarnAt: Date | null }>`; `type TicketCalendar = { revision: CalendarRevision; holidays: HolidaySet } | null`; `function computeSlaDeadlines(row: SlaClockRow, cal: TicketCalendar): SlaDeadlinePatch` (skips frozen targets); `function accruePauseEnd(row: SlaClockRow, cal: TicketCalendar, now: Date): { slaPausedBusinessMinutes: number }`; `function freezeResponse(row: SlaClockRow, cal: TicketCalendar, now: Date): SlaDeadlinePatch` (transient accrual of an open pause, not persisted); `async function loadTicketCalendar(db, revisionId: string | null): Promise<TicketCalendar>` (returns null in W3; W4 implements).

- [ ] **Step 1: Failing unit tests** (`ticketSlaDeadlines.test.ts`): freeze rule (response frozen by `first_response_at` or `response` in breach reason; resolution by `resolved_at` or `resolution`); reopen unfreezes resolution with the same formula; first response while paused uses transient accrual and leaves `slaPausedBusinessMinutes` unchanged; pause end then resolve does not double count; null calendar → wall-clock. Service tests (`ticketService.test.ts`): each write point writes the expected patch inside the ticket lock — create, #6691 restamp, explicit override, pause end (to open, resolved, closed), first response from all three writers, resolve while paused, reopen.
- [ ] **Step 2: Run** `npx vitest run src/services/ticketSlaDeadlines.test.ts src/services/ticketService.test.ts` — FAIL.
- [ ] **Step 3: Implement**; also fold `sla_paused_business_minutes` in the existing pause fold (W1's tombstone transition calls `accruePauseEnd` too — add if W1 landed first).
- [ ] **Step 4: Run** — PASS; add `rg -n "firstResponseAt|first_response_at" apps/api/src --type ts -g '!*.test.ts'` output to the PR body showing every writer goes through `freezeResponse`. **Commit** `feat(api): SLA deadlines written at every write point (#8973)`.

### Task 3.5: Staff SQL readers (sites 1–3)

**Files:** `jobs/ticketSlaWorker.ts:71-110`, `routes/tickets/tickets.ts:74-91, 232-251, 355-373`, `services/businessReports/ticketSlaReport.ts:40-134`; tests beside each.

- [ ] **Step 1: Failing tests:** sweep predicate exactly as spec §4.3 table row 1 (incl. `merged_into_ticket_id IS NULL` per rebase rule), ordered by the due column; **rolling-deploy heal** (Gate B12) — each sweep tick first fills due/warn for up to 500 rows with a non-null target, null due column and `sla_calendar_revision_id IS NULL` using the wall-clock formula, so tickets created by a pre-W3 API instance during the deploy window still breach (`it('heals a ticket written without deadlines and then stamps its breach')`); `SLA_AT_RISK` = `now() >= *_warn_at` on unfrozen arms; `SLA_BREACHED` unchanged; report `met = completion <= *_due_at`, `missed = completion > due OR (unmet AND now() > due)`; the `:42` caveat note removed and replaced by the §8.5 correction note.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ IT `ticketSlaDeadlinesBackfill` golden still green, `businessReportsPartnerScope.integration.test.ts`). **Commit** `feat(api): staff SLA readers use stored deadlines (#8973)`.

### Task 3.6: Portal, web, Partner API readers (sites 4–6)

**Files:** `services/portal/ticketReadModel.ts:28-107`, `routes/portal/tickets.ts:56-63`; `routes/tickets/tickets.ts:392-397` + detail `:485`; `apps/web/src/components/tickets/ticketConfig.ts:115-147`, `SlaTimers.tsx:18-33`; `routes/partnerApi/tickets.ts:186-246`, `schemas.ts:734-741`; `packages/shared` ticket types.

**Interfaces:** list/detail payload adds `responseDueAt, resolutionDueAt, responseWarnAt, resolutionWarnAt: string | null` and `slaBusinessMinutesRemaining: { response: number | null; resolution: number | null } | null` (always `null` in W3; W4 fills when a calendar applies).

- [ ] **Step 1: Failing tests:** portal `ticketSla` for a null target returns `not_configured` (no `PRIORITY_SLA_DEFAULTS` fallback) and otherwise derives status from stored columns; web `slaState` and `timerState` read the payload fields only (no target arithmetic); `SlaTimers` shows "met" only when completion ≤ due, else "met late"/breached copy (new locale key ×8); Partner API record has the four fields.
- [ ] **Step 2–4:** FAIL → implement → PASS (`cd apps/web && npx vitest run src/components/tickets/ticketConfig.test.ts src/components/tickets/SlaTimers.test.tsx`; API files; `localeParity`). **Commit** `feat: SLA readers use stored deadlines (portal, web, partner API) (#8973)`.
- [ ] **Step 5:** PR body "Release notes" section lists the three §8.5 corrections and the one-time Partner API feed re-delivery.

**W3 gates:** shared, API, web, portal typecheck exit 0; touched unit suites; IT `ticketSlaDeadlinesBackfill`, `tenant-export-policy`, `businessReportsPartnerScope`; `migrationRlsScope`, `autoMigrate`; `pnpm db:check-drift`.

---

## W4 — Business-hours calendars (`2027-01-02-210000-business-calendars.sql`)

### Task 4.1: Tables, RLS, registrations, blob backfill

**Files:**
- Create: `apps/api/migrations/2027-01-02-210000-business-calendars.sql`, `apps/api/src/db/schema/businessCalendars.ts` (export from `schema/index.ts`)
- Modify: `db/schema/portal.ts` (`tickets.slaCalendarRevisionId`), `db/schema/ticketConfig.ts:38` (`orgTicketSettings.businessCalendarId`), `services/tenantCascade.ts` (order + `CASCADE_ORDER_SET_NULL_EDGE_BREAKS :1432`), `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/businessCalendarsPartnerRls.integration.test.ts` (template `flowsPartnerRls.integration.test.ts`)

- [ ] **Step 1: Failing IT tests** (`businessCalendarsPartnerRls`): cross-partner forge insert → 42501 on each of the four tables; XOR violation → 23514; org token sees its own org rows + its partner's partner-wide rows (read-only: UPDATE/DELETE of a partner-wide row from an org token affects 0 rows); org isolation between two orgs; child with owner pair ≠ parent → 23514 (`*_parent_owner_chk`); revision UPDATE → rejected except `created_by_user_id → NULL`; overlapping intervals inserted for one revision → rejected by constraint trigger; second `is_partner_default` for a partner → 23505; `org_ticket_settings.business_calendar_id` naming another partner's calendar, or another org's org-owned calendar, → rejected by trigger; **org merge of an org that owns a calendar succeeds** (revisions/intervals/holidays restamp `org_id`; the immutability trigger allows an `org_id`-only change, owner guards are `DEFERRABLE INITIALLY IMMEDIATE`) — add the case to `orgMergeRegistry.integration.test.ts`; blob backfill: partner with `settings.businessHours.preset = 'business'` gets one non-default calendar Mon–Fri 09:00–17:00 in the partner's time zone, `extended` gets Mon–Fri 07:00–19:00 + Sat 09:00–13:00, `24/7` gets none; `custom` maps its stored schedule; a malformed custom schedule (unknown day key, unparsable time, `start >= end`, missing schedule, or no open interval) creates **no** calendar and is counted in a `RAISE WARNING 'skipped % malformed business-hours blobs'` (`orgs.ts:700`, `:752` accept arbitrary strings today).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the migration (tables per spec §4.1 with the ledger shapes; per-axis partial unique indexes as in `flows`; owner-guard constraint triggers `DEFERRABLE INITIALLY IMMEDIATE`; revisions immutability trigger UPDATE-only, permitting only `created_by_user_id → NULL` and an `org_id`-only ownership restamp (org merge); overlap constraint trigger on intervals; `tickets.sla_calendar_revision_id` FK `SET NULL`; `org_ticket_settings.business_calendar_id` FK `SET NULL` + same-partner trigger; then `SELECT set_config('breeze.scope','system',true);` and the blob backfill as an idempotent `INSERT … WHERE NOT EXISTS` keyed on `(partner_id, name)` with name `'Business hours (imported)'`). Register every ledger row. RLS coverage lists.
- [ ] **Step 4: Run** IT `businessCalendarsPartnerRls`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations`; `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; `npx vitest run src/services/orgMerge.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts`; `pnpm db:check-drift` — PASS. **Commit** `feat(api): business calendar tables + RLS (#8973)`.

### Task 4.2: Calendar service and validators

**Files:** Create `apps/api/src/services/businessCalendars/service.ts` + `.test.ts`, `packages/shared/src/validators/businessCalendars.ts` + `.test.ts`.

**Interfaces:**
- Produces: `createCalendar(auth, { ownerScope: 'organization' | 'partner'; orgId?; name; timezone; intervals; holidays? })`, `updateCalendarHours(auth, calendarId, { timezone, intervals })` → creates revision `n+1`, `renameCalendar`, `setPartnerDefault(auth, calendarId)`, `archiveCalendar`, `deleteCalendar` (refuses `CALENDAR_IN_USE` 409 while any ticket references one of its revisions; refuses archiving/deleting the partner default), `addHoliday` / `removeHoliday` (return `{ recomputeQueued: boolean }`), `listCalendars(auth, { orgId? })` (with `inherited: boolean`).
- Validators: `createBusinessCalendarSchema`, `updateBusinessCalendarSchema = …partial().omit({ ownerScope: true })`, holiday schema (`YYYY-MM-DD`, name ≤ 100).

- [ ] **Step 1: Failing tests:** partner-wide writes refused without `canManagePartnerWidePolicies` **in the service** (`PartnerWideWriteDeniedError`); org-scope tokens write nothing (route scope `partner`,`system` per `routes/ticketConfig.ts:31`); hours edit creates a new revision and leaves the old one intact; `validateRevision` failures map to 400 codes; delete-in-use refused (§12 cascade note); holiday dated ≤ today returns `recomputeQueued: false`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Commit** `feat(api): business calendar service (#8973)`.

### Task 4.3: Resolver and caller contexts

**Files:** Create `apps/api/src/services/businessCalendars/resolve.ts` + `.test.ts`; implement `loadTicketCalendar` (T3.4); modify `routes/portal/tickets.ts` create route + `middleware/selfManagedDbContextRoutes.ts` (Gate B1); IT `businessCalendarCallerContexts.integration.test.ts`.

**Interfaces:** `async function resolveBusinessCalendar(db: DbExecutor, owner: { partnerId: string; orgId: string }): Promise<{ revisionId: string | null; calendarId: string | null; source: 'org' | 'partner' | 'none' }>` — org override → partner default → none; reads with explicit `partner_id`/`org_id` filters on the **caller's** connection (Gate B1).

- [ ] **Step 1: Failing tests:** resolution order; archived override falls through to the partner default; IT: a ticket created from portal, inbound email, Partner API, staff partner token and org-scope token, under a partner-default calendar, each snapshots the same `sla_calendar_revision_id`.
- [ ] **Step 2–4:** FAIL → implement (portal `POST /tickets` becomes self-managed and opens `portalOrgContext(orgId, auth.partnerId)`, precedent `routes/portal/network.ts:26-37,89`; the context must be in place **before** the ticketing-enabled middleware's org-scoped read (`portalTicketsEnabledMiddleware`, `routes/portal/tickets.ts:78-98`), which treats an invisible row as enabled — test `it('ticketing disabled still refuses a self-managed portal create')`) → PASS. **Commit** `feat(api): business calendar resolver (#8973)`.

### Task 4.4: Calendar-aware write points and payload

**Files:** `ticketService.ts` (create snapshot; pause accrual; movers re-resolve for the target org and recompute unfrozen targets), `services/ticketSlaDeadlines.ts`, `routes/tickets/tickets.ts` (`slaBusinessMinutesRemaining`), tests.

- [ ] **Step 1: Failing tests:** create snapshots the resolved revision and writes business-time due/warn; pause end accrues **business** minutes; move-org to an org with a different calendar re-resolves and recomputes unfrozen targets only; an org-owned calendar of the old org is never left referenced; payload `slaBusinessMinutesRemaining` is non-null only when a calendar applies.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ IT `ticket-move-org`). **Commit** `feat(api): SLA deadlines on business hours (#8973)`.

### Task 4.5: Holiday recompute job

**Files:** Create `apps/api/src/jobs/businessCalendarRecomputeWorker.ts` + `.test.ts`; modify `jobs/workerReadinessManifest.ts` (`consumers('businessCalendarRecomputeWorker')`), worker bootstrap, `parkedFanout.contract.test.ts`; IT `businessCalendarRecompute.integration.test.ts`.

**Interfaces:** queue `business-calendar-recompute`, one-shot job `{ calendarId: string; reason: 'holiday_added' | 'holiday_removed' }`, enqueued by T4.2 holiday writes only when `holiday_date > today` (calendar tz).

- [ ] **Step 1: Failing tests:** processes open tickets with an unfrozen target on any revision of that calendar in chunks of 500 under `withSystemDbAccessContext`, `FOR UPDATE SKIP LOCKED` per ticket, skipped rows retried next chunk; after a future holiday the affected `*_due_at` moves later by that day's open minutes; IT `it('recompute vs sweep never stamps an obsolete deadline')`; manifest coverage test green.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run src/jobs/workerReadinessCoverage.test.ts src/jobs/businessCalendarRecomputeWorker.test.ts`). **Commit** `feat(api): holiday recompute job (#8973)`.

### Task 4.6: D12 apply-revision

**Files:** `services/businessCalendars/applyRevision.ts` + `.test.ts`; routes in T4.7.

**Interfaces:** `previewApplyRevision(auth, calendarId)` → `{ eligibleCount; immediatelyBreachedCount; skippedPausedCount; revisionId }`; `applyRevision(auth, calendarId, { expectedRevisionId })` → `{ updated: number }` — only open tickets on an older revision of that calendar with `sla_paused_business_minutes = 0 AND sla_paused_at IS NULL`; same chunking as T4.5; refuses if `expectedRevisionId` is no longer current (409 `REVISION_CHANGED`).

- [ ] **Step 1: Failing tests:** counts match a fixture; paused/has-paused tickets keep their revision and are counted as skipped; frozen targets untouched; audit row `business_calendar.apply_revision`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Commit** `feat(api): apply calendar revision to unpaused open tickets (#8973)`.

### Task 4.7: Routes and AI read tool

**Files:** Create `apps/api/src/routes/businessCalendars.ts` + `.test.ts` (mount in `index.ts`); `services/mcpCoverage.ts` (`{ tools: ['list_business_calendars'], note: 'writes are human-only in v1 (spec §5.7)' }`); `services/aiToolsTicketing.ts` (or a new `aiToolsBusinessCalendars.ts` registered from the hub) tier 1 `list_business_calendars`.

- [ ] **Step 1: Failing tests:** CRUD + holidays + set-default + archive + `apply-revision/preview` + `apply-revision`; `requireScope('partner','system')`; partner-wide gate; `mcp-coverage.test.ts` passes with no new gap; tool tier 1, schema without `z.undefined()`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Commit** `feat(api): business calendar routes + AI read tool (#8973)`.

### Task 4.8: Settings UI

**Files:** Create `apps/web/src/components/settings/BusinessHoursCard.tsx` + `.test.tsx` (rendered inside `TicketPrioritiesTab.tsx`); modify `OrgTicketSettingsEditor.tsx` + test; locales `settings.json` ×8.

- [ ] **Step 1: Failing tests:** card lists calendars with "All orgs" badge for partner-wide rows; weekly grid editor with split shifts (`business-hours-interval-*`), tz select, holiday list with "dated today or earlier won't change open tickets" hint, set-default (`business-hours-set-default`), archive, "Apply to open tickets" opens the D12 preview with the three counts before confirming; every mutation via `runAction`; org picker blank = inherit and shows inherited calendar + source.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ `localeParity`, `no-silent-mutations`, `TicketingSettingsTabs.test.tsx`). **Commit** `feat(web): business hours settings (#8973)`.

### Task 4.9: Retire the Regional business-hours card

**Files:** `apps/web/src/components/settings/PartnerRegionalTab.tsx:31-157`, `PartnerSettingsPage.tsx:224,334`, `apps/api/src/routes/orgs.ts:752-755`, `packages/shared/src/types/index.ts:638,807`, `apps/web/src/locales/*/settings.json` (`partner.regional.businessHours`), docs `apps/docs/src/content/docs/reference/organizations-and-sites.mdx:90,638`, `partner-management.mdx:273`, `regional-settings.mdx:47`.

- [ ] **Step 1: Failing tests:** `PartnerRegionalTab` no longer renders business hours, and still renders its time-zone, date-format and language controls (`:59`) unchanged; `partnerSettingsSchema` parse of a stored blob that still contains `businessHours` succeeds and drops the key (Gate B5 — stored JSON is not rewritten); no `businessHours` key in any locale.
- [ ] **Step 2–4:** FAIL → implement (docs point to Ticketing → Priorities & SLAs) → PASS (+ `localeParity`, `settingsPageRegistry.test.ts`). **Commit** `refactor(settings): retire Regional business hours (#8973)`.

**W4 gates:** all typechecks exit 0; IT `businessCalendarsPartnerRls`, `businessCalendarCallerContexts`, `businessCalendarRecompute`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations`, `ticket-move-org`; `test:rls-coverage`; full API unit suite; `mcp-coverage`, `workerReadinessCoverage`, `localeParity`, `no-silent-mutations`, `migrationRlsScope`; `pnpm db:check-drift`. PR body carries the Rule 9 statement.

---

## W5 — Routing rules (`2027-01-02-220000-ticket-routing-rules.sql`)

### Task 5.1: Tables, RLS, registrations

**Files:** Create migration, `apps/api/src/db/schema/ticketRoutingRules.ts`; modify `tickets.routingRuleId`, registries, RLS coverage lists; create `ticketRoutingRulesPartnerRls.integration.test.ts`.

- [ ] **Step 1: Failing IT tests:** forge 42501, XOR 23514, org-token read-only partner-wide visibility, org isolation; org-links child visible only through its rule (parent-join); **deleting a user who is a rule's only action succeeds** and leaves a no-action rule (Gate B13: "at least one action" is a service validation at create/update, not a DB CHECK, because `ON DELETE SET NULL` would violate it); category/status/assignee references on an org-owned rule must belong to the org's partner (Gate B4 guard trigger → 23514), deleting a referenced category or status → 23503 (`RESTRICT`), deleting a referenced user nulls `set_assignee_user_id`; `ticket_statuses_id_partner_id_key` exists.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** columns per spec §5.1 (`match_sources ticket_source[]`, `match_priorities ticket_priority[]`, `match_category_id`, `match_subject_keywords text[]` with `CHECK (cardinality <= 20)`, `match_requester_domains text[]`, `set_assignee_user_id → users ON DELETE SET NULL`, `set_priority`, `set_category_id`, `set_status_id`, `add_tags text[]`, `enabled`, `position`, `name`); category/status FKs plain `RESTRICT` + `ticket_routing_rules_ref_partner_guard` constraint trigger resolving the rule's partner (`partner_id` or the org's partner) (Gate B4); policy pair; `ticket_routing_rule_org_links (rule_id → rules ON DELETE CASCADE, org_id → organizations, UNIQUE(rule_id, org_id))` with parent-join policy; `tickets.routing_rule_id` FK `SET NULL`; `ALTER TABLE ticket_statuses ADD CONSTRAINT ticket_statuses_id_partner_id_key UNIQUE (id, partner_id)` (idempotent `DO $$`). Register all ledger rows.
- [ ] **Step 4: Run** the W4 IT/registry set with the routing suite — PASS. **Commit** `feat(api): ticket routing rule tables + RLS (#8883)`.

### Task 5.2: Evaluator

**Files:** Create `apps/api/src/services/ticketRouting/match.ts` + `.test.ts` (pure), `evaluate.ts` + `.test.ts`.

**Interfaces:**
- Produces: `type RoutingFacts = { source: TicketSource; priority: TicketPriority | null; categoryId: string | null; subject: string; requesterEmail: string | null }`; `function matchRule(rule: RoutingRuleRow, facts: RoutingFacts): boolean`; `type RoutingOutcome = { ruleId: string | null; ruleName: string | null; applied: Partial<{ assigneeId: string; priority: TicketPriority; categoryId: string; statusId: string; tags: string[] }>; skipped: { action: string; reason: 'assignee_ineligible' | 'assignee_deleted' | 'category_foreign' | 'status_foreign' | 'status_core_not_allowed' }[] }`; `async function evaluateRoutingRules(db: DbExecutor, owner: { partnerId: string; orgId: string }, facts: RoutingFacts, explicit: ExplicitChoices): Promise<RoutingOutcome>` where `ExplicitChoices = { priority: boolean; categoryId: boolean; assigneeId: boolean; statusId: boolean }`.

- [ ] **Step 1: Failing tests:** AND across columns, OR within a list, empty = any; keywords case-insensitive substring; domain exact and `*.sub` suffix (`*.example.com` matches `a.example.com`, not `example.com.evil`); order `(position, id)`; org rules before partner-wide rules; partner-wide rule with org links applies only to listed orgs; disabled rules skipped; explicit choices never overwritten; ineligible assignee (`assertAssigneeEligible`) skipped with reason while other actions apply; Review Focus #4 (deleted assignee → no-op skip); status with core outside `new/open/pending/on_hold` skipped; partner-wide rows fetched by the ticket org's **partner**.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Commit** `feat(api): routing rule evaluator (#8883)`.

### Task 5.3: Wire into `createTicket`

**Files:** `ticketService.ts` (`createTicket :1067` — call after requester resolution `~:1191`, before priority `:1236`, initial status `:1237`, SLA `:1248`); `services/inboundEmail/inboundEmailService.ts:493-500` and `routes/officeAddin/tickets.ts:662` (continuation tickets pass `continuationOfTicketId`); tests.

**Interfaces:** `CreateTicketInput` gains `continuationOfTicketId?: string` (explicit provenance — never inferred from description or subject). Both continuation producers (`inboundEmailService.ts:493-500`/`:855`, `officeAddin/tickets.ts:662`/`:698`) pass it; `createTicket` skips routing when it is set and copies nothing from the predecessor — today's continuation path copies no priority/category/assignee, so the spec's "they copy their predecessor" is not current behaviour (Gate B14); consumes `evaluateRoutingRules`, `ExplicitChoices` derived from input presence (T5.4).

- [ ] **Step 1: Failing tests:** precedence per field (explicit > intake form > rule > category default/SLA chain); a rule category drives `resolveEffectiveSlaTargetsForTicket`; rule assignee → initial core `open`; rule `set_status_id` overrides; `pending`/`on_hold` status → `sla_paused_at = created_at`; `ticket.created` outbox carries the final `assigneeId`, no `ticket.assigned`; `tickets.routing_rule_id` set; internal system comment lists applied and skipped actions; `ticket.create` audit details gain `routingRuleId`, `routingActions`; skipped for `isImportWrite` and `continuationOfTicketId`; explicit ineligible assignee still errors; inbound default assignee (`applyDefaultInboundAssignee`, `defaultAssignee.ts:49`) applies only when no rule assigned.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ `inboundEmailService.test.ts`, `defaultAssignee.test.ts`). **Commit** `feat(api): route tickets at create (#8883)`.

### Task 5.4: Explicit-choice provenance

**Files:** `apps/web/src/components/tickets/CreateTicketPage.tsx:50,231` + test; `apps/portal/src/components/portal/NewTicketForm.tsx` + test; each `createTicket` caller.

Caller dispositions (verify each in the PR body):

| Caller | Today | After |
|---|---|---|
| `routes/tickets/tickets.ts:458`, `routes/partnerApi/ticketWrites.ts:304` | spread body; `priority` optional, no default (`packages/shared/src/validators/tickets.ts:71`) | unchanged — presence = explicit |
| `CreateTicketPage.tsx` | always sends `priority` (`'normal'` default state) | sends `priority`/`categoryId`/`assigneeId` only when the user touched them |
| `routes/portal/tickets.ts:271` + `apps/portal/src/components/portal/NewTicketForm.tsx:53,127` | portal form defaults state to `'normal'` and always sends it | portal form sends `priority` only when the customer touched it; route passes it through |
| `routes/vulnerabilities.ts:966`, `services/ticketService.ts:3225` (alerts), `routes/ai.ts:730`, `services/aiToolsTicketing.ts:945` | pass derived/chosen priority | explicit (configured choice) |
| `services/trustPage/access/requests.ts:252` | hardcoded `'normal'` | stop passing it (route-able) |
| `services/ticketImport/importWriter.ts:580` | always passes | skipped (`isImportWrite`) |
| inbound email `:856`, office add-in `:698`, `ticketConfigService.ts:870`, `plannedWorkTicket.ts:55`, `aiOperator/humanWorkService.ts:146` | omit | unchanged |

- [ ] **Step 1: Failing tests:** web form untouched → request body has no `priority`; touched → present; `createTicket` without priority and no matching rule stores `'normal'`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Commit** `feat: explicit-choice provenance on ticket create (#8883)`.

### Task 5.5: Routes

**Files:** Create `apps/api/src/routes/tickets/routingRules.ts` + `.test.ts` (mount), `services/ticketRouting/service.ts` + test, `packages/shared/src/validators/ticketRouting.ts` + test, `mcpCoverage.ts` entry.

**Interfaces:** `GET /ticket-routing-rules?orgId=`, `POST` (`ownerScope`), `PATCH /:id` (`.omit({ ownerScope: true })`), `DELETE /:id`, `POST /reorder` `{ ids: string[] }` (per owner), `POST /test` `{ orgId, source, subject, requesterEmail, categoryId?, priority? }` → `RoutingOutcome`.

- [ ] **Step 1: Failing tests:** create/update with no action set → 400 `ROUTING_RULE_NO_ACTION` (Gate B13); partner-wide writes gated in the service; app-layer dual-axis read conditions only when `auth.scope === 'partner'`; keyword/domain normalisation and limits; `/test` read-only, same evaluator; org-scope tokens read only.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ `mcp-coverage`). **Commit** `feat(api): routing rule routes (#8883)`.

### Task 5.6: Routing tab UI

**Files:** Create `apps/web/src/components/settings/TicketRoutingTab.tsx` + `.test.tsx`; modify `TicketingSettingsTabs.tsx` (add `routing` to `TICKETING_HUB_TABS :18` and the tab arrays), move the default-assignee editor out of `InboundEmailCard.tsx:305-313` into the tab footer ("If no rule assigns an email ticket"); locales ×8.

- [ ] **Step 1: Failing tests:** ordered list with drag reorder (`routing-rule-row-*`, `routing-rule-drag-*`), enable toggle autosaves with toast, create drawer with ownerScope (create only; pattern `software/PolicyForm.tsx:185-210`), "All orgs" badge, catch-all warning, selected rule in hash (`useHashState`), "Test a ticket" panel (`routing-test-*`) showing match + actions + skips, fallback editor saves the same setting key; `InboundEmailCard` no longer renders the editor.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ `TicketingSettingsTabs.test.tsx`, `InboundEmailCard.test.tsx`, `localeParity`, `no-silent-mutations`). **Commit** `feat(web): ticket routing tab (#8883)`.

### Task 5.7: AI tools

**Files:** `aiToolsTicketing.ts` (or `aiToolsTicketRouting.ts` registered from the hub), `aiGuardrails.ts`, tests.

- [ ] **Step 1: Failing tests:** `list_ticket_routing_rules`, `test_ticket_routing_rule` tier 1; `manage_ticket_routing_rules` (create/update/reorder/delete) tier 3 with the service-level partner-wide gate; description budget; no `z.undefined()`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Commit** `feat(api): routing rule AI tools (#8883)`.

### Task 5.8: Cross-context integration

**Files:** Create `apps/api/src/__tests__/integration/ticketCreateCallerContexts.integration.test.ts`.

- [ ] **Step 1:** For each of portal, inbound email, Partner API, staff partner token, org-scope token: create a ticket under a partner-default calendar and a partner-wide rule; assert the same `sla_calendar_revision_id` and `routing_rule_id` (spec §12 "Caller contexts").
- [ ] **Step 2: Mutation control.** Temporarily revert T4.3's portal self-managed context (portal create back on `currentPartnerId: null`); run — expect the portal case to FAIL (no revision, no rule). Record it, restore.
- [ ] **Step 3:** Run — PASS (red here means a context cannot see partner-wide config; fix the context, Gate B1). **Commit** `test(api): ticket create caller contexts (#8883)`.

**W5 gates:** as W4 plus `ticketRoutingRulesPartnerRls`, `ticketCreateCallerContexts`; PR body Rule 9 statement.

---

## Gate B — decisions for Todd

Plan default in brackets. Items 1–10 are plan-level choices the spec leaves open; items 11–16 depart from the spec's literal wording and amend it if approved. The spec's D1–D12 are not re-opened.

1. **How config is read from a portal-created ticket.** The spec says nested `runOutsideDbContext(withSystemDbAccessContext)`; `docs/agents/tenancy-rls.md` (Partner-Wide First, step 3) retired that for XOR config tables, and nested system reads inside an open transaction have stalled CI behind queued TRUNCATE (#9446). **[Read on the caller's connection with explicit owner filters; make portal `POST /tickets` a self-managed DB-context route carrying `currentPartnerId = auth.partnerId` (SELECT-only branch, precedent `routes/portal/network.ts`); prove with T5.8.]**
2. **Precursor wave W0** for the lock-order invariant, shipped before merge. **[Yes — independent PR, de-risks W1.]**
3. **W3 backfill re-delivers every ticket on the Partner API feed once** (BEFORE UPDATE feed trigger). **[Accept; the rows gain four new fields; release note. Do not disable the trigger.]**
4. **Same-partner enforcement for rule category/status references.** XOR org-owned rules have `partner_id NULL`, so the spec's composite `(category_id, partner_id)` FK cannot bind them. **[Plain FK `RESTRICT` + `ticket_routing_rules_ref_partner_guard` constraint trigger resolving the org's partner; service validation too.]**
5. **Stored `partners.settings.businessHours` after the Regional card is removed.** **[Leave stored JSON untouched (backfilled into a calendar); the schema stops reading/writing the key.]**
6. **`caller_verifications.ticket_ref`** (not in spec §3.3). **[Stays on the tombstone as history; verification *effects* that arrive after the merge redirect to the survivor under lock and never throw `TICKET_MERGED` (T1.2).]**
7. **`tickets_sla_sweep_idx`.** **[Keep through W3; drop in a follow-up once the due-at indexes are proven in prod.]**
8. **Source-requester merge email copy.** **[New built-in key `ticket_merged` in the existing outbound email template registry — editable where other ticket templates are; Rule 9 count unchanged.]**
9. **Wave order.** **[W0 ∥ W3 → W1 → W2; W3 → W4 → W5.]**
10. **Tombstone write enforcement.** **[App helper under the ticket lock + repository-wide source-scan registry; no DB trigger on `tickets`.]**
11. **W3 backfill transaction shape.** Spec §4.6 says "batched"; a ctid loop inside one migration transaction releases no locks. **[DDL in its own `@no-transaction` file; backfill as a procedure that `COMMIT`s per 5,000-row batch (resumable); fall back to a single transactional loop in its own file only if `autoMigrate` cannot run it.]**
12. **Rolling-deploy gap.** A pre-W3 API instance still serving during the deploy creates tickets with no stored deadlines, which the new sweep would never breach. **[Sweep heals up to 500 such rows per tick with the wall-clock formula before stamping.]**
13. **"At least one action" on a routing rule.** The spec's DB CHECK conflicts with `set_assignee_user_id ON DELETE SET NULL` (deleting a user whose rule only assigns would fail). **[Service validation at create/update only; a rule emptied by a user deletion becomes a visible no-action rule.]**
14. **Continuation tickets and routing.** Spec §5.2 says continuations skip routing "because they copy their predecessor", but today's continuation path copies no priority, category or assignee. **[Skip routing, copy nothing — today's behaviour unchanged; copying is a separate follow-up if wanted.]**
15. **Calendar revision immutability vs org merge.** Spec §4.1 allows only `created_by_user_id → NULL`; org merge must restamp `org_id` on an org-owned calendar's revisions. **[Trigger also allows an `org_id`-only ownership restamp; owner guards `DEFERRABLE INITIALLY IMMEDIATE` (T4.1).]**
16. **W5 depends on W3.** Spec §11 marks W5 independent. **[Land W5 after W3 (both edit `createTicket` and the SLA stamp) and after W4 (the combined caller-context test T5.8).]**

## Quorum outcome

Opus formed positions P1–P13 (Gate B 1–10 plus the slot and module choices) before the review. Codex `gpt-6-astra`, `model_reasoning_effort="xhigh"`, `-s read-only`, at `520d3dade`, **agreed on 11 of 13** and **disagreed on 2**. Both disagreements were resolved on the merits by adopting Codex's correction:

| Point | Codex objection | Resolution |
|---|---|---|
| P3 backfill packaging | ctid batches inside one transaction release no locks; ADD COLUMN + backfill holds ACCESS EXCLUSIVE throughout | DDL / backfill / index split into three `@no-transaction` files; resumable per-batch `COMMIT` (Gate B11, T3.2) |
| P9 guard scan scope | exported-service scanning misses direct route writers (`portal/tickets.ts:482`, `inboundEmail/emailComments.ts:33`); call presence cannot prove lock order | repository-wide scan of every enclosing function, `maintenance` class, lock order proven by concurrency tests (T0.1) |

Qualified agreements folded in: P1 context must precede the portal ticketing-enabled middleware (T4.3); P2 INVALID-index guard (T3.3, cross-wave rules); P6 time-entry scanner covers only `time_entries` (T1.4); P8 W3 must not reference `merged_into_ticket_id` before W1's migration ships (rebase rules); P10 portal `NewTicketForm` also always sends priority (T5.4); P11 keep attachment public/non-deleted filters and comment author checks (T1.12); P12 no `devices` row lock after the link lock (T1.4); P13 remove only the Business Hours card (T4.9).

Five additional risks Codex raised, all adopted: verification effects on a merged ticket (T1.2, Gate B6); explicit continuation provenance (T5.3); revision immutability vs org merge (T4.1); malformed legacy business-hours blobs (T4.1); sole-assignee rule vs `SET NULL` (T5.1, Gate B13). The hot-table DDL discipline (`2026-12-20-200300` precedent) was applied to W1 as well. No disagreement is left open; Gate B 11–16 are listed because they depart from the spec’s literal wording (14–16 came from the PR review).

## Deferred / follow-ups (not in any wave)

- Drop `tickets_sla_sweep_idx` (Gate B7).
- #6831 explicit outcome stamps (spec §7).
- After-hours approval detection reading `resolveBusinessCalendar` (approval spec D3(b)).
- `register_feature` for #8883 with W0–W5 sub-issues after Gate B approval.
