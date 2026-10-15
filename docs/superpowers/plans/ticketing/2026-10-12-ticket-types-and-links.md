---
status: draft-awaiting-approval
issue: 7900
discussion: 7792
tracking_issue: LanternOps/breeze#8592
---

# Ticket Types + Ticket-to-Ticket Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every ticket a fixed ITIL-style type (`incident | service_request | problem | change`), let staff link tickets of the same org with typed links (`caused_by`, `resolves`, `related`, `duplicate_of`), and surface both in the list, a Related-tickets panel, per-type Service Desk nav entries, the portal (type only) and the AI tools.

**Architecture:** `tickets.ticket_type` is a new Postgres enum column (separate from `work_kind`). Links live in a new shape-1 table `ticket_links` (one row per link, inverse derived at read time) with composite `(ticket_id, org_id)` FKs to `tickets`, registered in every org-lifecycle registry. Four sequential waves, each a PR off `main`.

**Tech Stack:** Postgres (hand-written SQL migrations, RLS), Drizzle (queries only), Hono routes, Zod validators in `packages/shared`, Astro + React islands, Vitest.

**Spec:** none of its own. Design authority is issue #7900 and discussion #7792, with the existing ticketing docs: `docs/superpowers/specs/ticketing/2026-06-09-native-ticketing-design.md`, `2026-06-12-ticketing-configuration-design.md`, `2026-10-06-customer-work-approval-design.md`, `2026-10-10-service-catalog-design.md` (which says a *work type is not a ticket type* and lists #7900/#7901 as separate). Structural templates: `plans/ticketing/2026-10-06-customer-work-approval.md` and `2026-06-12-ticketing-configuration-backend.md`. This plan is the design doc; the Open Decisions at the end carry the recommendations.

## Global Constraints

- Migrations: hand-written SQL in `apps/api/migrations/`, never `drizzle-kit generate/push`. Names `2026-12-23-13NNNN-<slug>.sql`. Newest committed on `origin/main` when this plan was written: `2026-12-23-100000-tier1-sweep-indexes.sql`; open PRs hold `2026-12-23-110000`, `110100`, `120000`. **Before each wave, re-list `origin/main` migrations using the `node`/`localeCompare` one-liner from `apps/api/migrations/README.md` Rule 3 (shell `sort` is not authoritative, and `optional/`, `preflight/`, `README.md` pad the tail) and move up if anything newer landed.** Idempotent, no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration, `pnpm db:check-drift` after.
- Any migration that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);` (`migrationRlsScope.test.ts`). The planned migrations below write no rows; if a task adds a write, add the line.
- API connects as `breeze_app`; `ticket_links` gets RLS enabled + forced + policies **in the migration that creates it**. Request paths use `withDbAccessContext`; background code uses `withSystemDbAccessContext`.
- Every composite FK referencing an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`.
- Web mutation handlers wrap the call in `runAction` (`apps/web/src/lib/runAction.ts`); new `en` locale keys go into **all 7 non-en locales** in the same change (`apps/web/src/locales/<locale>/tickets.json`; parity enforced by `apps/web/src/lib/i18n/localeParity.test.ts`).
- Transient UI state lives in `window.location.hash`, not query params.
- Test commands never put `--` before flags: `cd apps/api && npx vitest run <file>`; `cd apps/web && npx vitest run <file>`. Vitest path filters are substring matches.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` (same for `apps/web`), and **check the exit code**; never pipe to `tail`.
- **CI shape:** `ci.yml` triggers only on PRs to `main`, so a PR stacked on a sibling wave runs no CI. Waves are therefore **sequential PRs off `main`**: open W(n+1) only after W(n) merged. If a stacked branch is unavoidable, run `gh workflow run CI --ref <branch>`.
- The org-cascade and export-policy suites (`tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `rls-coverage.integration.test.ts`) fail **only** under the *Integration Tests* CI job, never under *Test API*. Run them locally through `pnpm test-stack up` and tear down with `pnpm test-stack down`. See `docs/agents/testing.md`.
- No customer names, hostnames or IPs in code, commits or PR bodies. PR bodies say `Refs #7900` (never a closing keyword); the last wave's PR may say `Closes #<wave sub-issue>`.
- Commits carry the repo's standard co-author trailer for the authoring tool.

## Out of scope (and the seams left for it)

- **Change-record fields (#7901)** (risk, impact, schedule window, rollback plan) and **change approvals** (separate issue; the existing customer-work-approval feature is a *different* mechanism: it holds billable work). This plan adds only the `change` *value* of the type. **Seam:** #7901 should add a 1:1 side table `ticket_change_details (ticket_id, org_id, …)` with its own composite FK, created lazily when `ticket_type = 'change'`, not columns on `tickets`. Nothing in W1–W4 blocks that. A later approval gate can key off `ticket_type = 'change'` in `ticketService`'s status-transition path; this plan adds no transition rules to leave that door open.
- **Cross-org links** (MSP-wide problems spanning customers): the issue says one org only. See Open Decision 6.
- **Problem rollups** (aggregate incident counts/SLA/status onto a problem): Open Decision 4, deferred.
- Bulk type change, type-aware SLA policies, type-specific forms/workflows.

## Why `ticket_type` is a new column, not `work_kind`

`tickets.work_kind` (`ticket_work_kind`: `support | deliverable | project_task`, `apps/api/src/db/schema/portal.ts`, spec #5573 §4.8) says *how the work is delivered and billed* (planned service-deliverable occurrences and project tasks vs. reactive support). ITIL type says *what the ticket is about* (an outage vs. a request vs. the underlying cause vs. a planned change). They are orthogonal: a `deliverable` ticket is typically a `service_request`; a `support` ticket is any of the four. Overloading `work_kind` would break its consumers (planned-work generation, billing), force a four-way split of `support`, and make the issue's "core set fixed so reporting can rely on it" impossible to state independently of delivery mode. The service-catalog spec already draws the same line for *work types*.

## Verified starting state (origin/main at plan time)

| Fact | Where |
|---|---|
| `tickets` has no type/parent/link/merge column; closest is `work_kind` | `apps/api/src/db/schema/portal.ts` (table ~l.145; enums l.8–12) |
| `tickets_id_org_uq` unique index on `(id, org_id)` **exists** (composite-FK target) | `apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql:34` |
| Precedent: a ticket child with composite FK + both movers + merge + cascade + export | `ticket_external_refs` (`2026-12-04-101300-ticket-external-refs.sql`, `ticketExternalRefsOrgMove.integration.test.ts`) |
| Org-move shared lock order `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` / `TICKET_ORG_DENORMALIZED_TABLES`, last entry `ticket_approval_requests` | `apps/api/src/services/ticketOrgMoveLockOrder.ts` |
| `moveTicketOrg` names child FKs in `SET CONSTRAINTS … DEFERRED` | `apps/api/src/services/ticketService.ts` ~l.3164–3230 |
| Device-axis mover rewrites the same ticket children via the tickets join | `apps/api/src/routes/devices/core.ts` (`CUSTOM_ORG_REWRITE_TABLES`, ~l.470–491) and `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts` (~l.172–181, 1063–1114) |
| Cascade list, ticket tables alphabetical; `ticket_forms` < `ticket_links` < `ticket_mailbox_connections` (verified with `localeCompare`: -1, -1) | `apps/api/src/services/tenantCascade.ts` ~l.890–985 |
| Merge registry: ticket children are plain `repoint` entries | `apps/api/src/services/orgMergeRegistry.ts` ~l.1132–1154 |
| Export policy per table, e.g. `ticket_alert_links` | `apps/api/src/services/tenantExportPolicyRegistry.ts` l.843; `tickets` l.906 |
| Enum parity test pattern | `apps/api/src/db/schema/ticketEnums.test.ts` (Zod in `packages/shared/src/validators/tickets.ts`) |
| Ticket creation funnels: `createTicket` (l.948), `createTicketFromAlert` (l.2843) in `services/ticketService.ts`; `createPlannedWorkTicket` in `services/plannedWorkTicket.ts` | |
| Service Desk nav holds only Tickets + Timesheets; active state is `item.href === activeHref` with `activeHref` derived from **pathname only** | `apps/web/src/components/layout/Sidebar.tsx` ~l.342–348, 104, 767, 872 |
| Tickets page hash is `#<selection>&sort=<sort>` via `parseHash`/`hashFor`; the category filter is React state only | `apps/web/src/components/tickets/TicketsPage.tsx` l.122–146, 175, 247 |
| AI: `manage_tickets` in `services/aiToolsTicketing.ts` (l.556); portal ticket routes `routes/portal/tickets.ts` + `services/portal/ticketReadModel.ts`; portal flags test `__tests__/integration/portalVisibilityRls.integration.test.ts` | |

Drift check at the start of every wave: re-run the greps in each wave's "Pre-flight" step; adjust line numbers, not intent.

## Wave map

| Wave | Delivers | Migration | If the next wave never ships |
|---|---|---|---|
| **W1** | `tickets.ticket_type` enum column, validators, create/PATCH/list/export/partner-API/office-add-in plumbing, per-source defaults, `ticket.updated` event | `2026-12-23-130000-ticket-type.sql` (column) + `2026-12-23-130010-ticket-type-index.sql` (`@no-transaction`, concurrent index) | Tickets are typed and filterable through the API and `?ticketType=` only. No UI. Fully usable by integrations and by W3 later. Nothing to unwind. |
| **W2** | `ticket_links` table + service + routes + all registrations + both movers + merge/cascade/export | `2026-12-23-130100-ticket-links.sql` | Links are creatable via API only, no UI. All lifecycle registries are complete, so no tenancy debt. |
| **W3** | Web: type chip + selector, list filter (in hash), Service Desk nav entries per type, Related-tickets panel | none | The feature is usable end to end by staff. Portal and AI do not know about type (they simply ignore it). |
| **W4** | Portal type badge (read-only, links deliberately hidden), AI tools (`manage_tickets` type filter + link/unlink), MCP coverage | none | Staff-only feature; customers/AI see nothing new. |

Optional **W5** (not part of the minimum): partner-configurable type labels, see Open Decision 2.

Each wave: branch from fresh `origin/main` as `feature/<parent#>-ticket-types-links/wave-<subissue#>` (the orchestrator registers the feature and creates sub-issues after approval; this plan does not).

---

# Wave 1: `ticket_type` column + API

**Mergeable alone:** additive column with a constant default (metadata-only on PG ≥ 11, no table rewrite, so no batched backfill is needed even above 1M rows and **no row writes occur in the migration**; existing rows read as `incident` immediately). The index is built concurrently in its own non-transactional migration so the column migration holds its lock only briefly. All existing API clients that do not send the field behave exactly as before.

**Files (whole wave)**
- Create: `apps/api/migrations/2026-12-23-130000-ticket-type.sql`, `apps/api/migrations/2026-12-23-130010-ticket-type-index.sql`
- Modify: `apps/api/src/db/schema/portal.ts` (enum + column), `packages/shared/src/validators/tickets.ts` (+ export from the package index), `apps/api/src/db/schema/ticketEnums.test.ts`
- Modify: `apps/api/src/services/ticketService.ts` (`createTicket`, `createTicketFromAlert`, update path, list filter), `apps/api/src/services/plannedWorkTicket.ts`, `apps/api/src/services/ticketEvents.ts` (+ `ticketEventsContract.test.ts`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (line ~906, `tickets` entry)
- Modify routes: `apps/api/src/routes/tickets/tickets.ts`, `export.ts`, `bulk.ts` (read-only awareness, see Task 1.5), `apps/api/src/routes/partnerApi/{tickets,ticketWrites}.ts`, `apps/api/src/routes/officeAddin/tickets.ts`, `apps/api/src/routes/portal/tickets.ts` (**no** type on portal in W1; assert it is not returned)
- Sweep (read, then touch only where needed): `services/businessReports/ticketSlaReport.ts`, `services/aiAgents/ticketContext.ts`, `services/psa/ticketScope.ts`, `routes/alerts/alertTickets.test.ts`

### Task 1.1: Migration + Drizzle column + enum parity (red first)

**Files:**
- Create: `apps/api/migrations/2026-12-23-130000-ticket-type.sql`
- Modify: `apps/api/src/db/schema/portal.ts`, `packages/shared/src/validators/tickets.ts`
- Test: `apps/api/src/db/schema/ticketEnums.test.ts`

**Interfaces:**
- Produces: `ticketTypeEnum` (Drizzle pgEnum `ticket_type`), `tickets.ticketType`, Zod `ticketTypeSchema` and `TicketType` from `@breeze/shared`, const `TICKET_TYPES = ['incident','service_request','problem','change'] as const`.

- [ ] **Step 1: Pre-flight**

```bash
git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -5   # then confirm with README Rule 3
grep -rn "ticket_type\b" apps/api/migrations | head   # expect none (the word 'ticket_type' must be unused)
```
Move the migration prefix above the newest committed name if needed.

- [ ] **Step 2: Write the failing parity test** (append to `ticketEnums.test.ts`)

```ts
import { ticketTypeSchema } from '@breeze/shared';
import { ticketTypeEnum } from './portal';

it('ticketType: Zod options match Drizzle enumValues', () => {
  expect([...ticketTypeSchema.options].sort()).toEqual([...ticketTypeEnum.enumValues].sort());
});
it('ticketType core set is exactly the four ITIL types', () => {
  expect([...ticketTypeEnum.enumValues].sort()).toEqual(['change', 'incident', 'problem', 'service_request']);
});
```

- [ ] **Step 3: Run, expect FAIL** (`ticketTypeSchema` / `ticketTypeEnum` undefined)

Run: `cd apps/api && npx vitest run src/db/schema/ticketEnums.test.ts`

- [ ] **Step 4: Implement.** Schema: `export const ticketTypeEnum = pgEnum('ticket_type', ['incident','service_request','problem','change']);` and in `tickets`: `ticketType: ticketTypeEnum('ticket_type').notNull().default('incident'),`. Validator: `export const ticketTypeSchema = z.enum([...]); export type TicketType = z.infer<typeof ticketTypeSchema>;` next to `ticketStatusSchema`. Migration:

```sql
-- ticket_type: fixed ITIL core set on tickets (#7900). Separate axis from
-- work_kind (delivery mode). Constant DEFAULT => metadata-only ADD COLUMN
-- (PG >= 11): no rewrite, no row writes, existing tickets read as 'incident'.
-- Idempotent. No row writes, so no breeze.scope election.
DO $$ BEGIN
  CREATE TYPE ticket_type AS ENUM ('incident', 'service_request', 'problem', 'change');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type ticket_type NOT NULL DEFAULT 'incident';

```
The index goes in a **separate** migration `2026-12-23-130010-ticket-type-index.sql`. The runner wraps a migration in one transaction (`apps/api/src/db/autoMigrate.ts` ~l.832), so an index build in the same file would hold the `ALTER TABLE` exclusive lock for the whole scan of `tickets`. Mirror `2026-12-23-100000-tier1-sweep-indexes.sql` exactly: first line `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_org_type_status_idx ON tickets (org_id, ticket_type, status) WHERE deleted_at IS NULL;`, plus whatever invalid-index detection/rebuild guard that file uses (read it end to end and copy the pattern; a failed concurrent build leaves an INVALID index that `IF NOT EXISTS` would silently keep). Org queues filtered by type are the hot path behind the Service Desk nav entries. `check-migration-naming` must pass.

- [ ] **Step 5: Run parity test, expect PASS; add the `@no-transaction` index migration described above; `pnpm db:check-drift`; typecheck (api, shared).**

- [ ] **Step 6: Commit** `feat(tickets): ticket_type enum column (#7900)`.

### Task 1.2: Export-policy classification of the new column (red first)

**Files:** Modify `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `tickets` entry, `included` array); Test: `tenant-export-policy.integration.test.ts`.

- [ ] **Step 1:** With the migration applied but the registry untouched, run the export-policy suite and watch it fail on the unclassified `ticket_type` column.
```bash
pnpm test-stack up
cd apps/api && npx vitest run src/__tests__/integration/tenant-export-policy.integration.test.ts
```
- [ ] **Step 2:** Add `"ticket_type"` to the `tickets` policy's `included` list (enum scalar, not sensitive, not json/jsonb/bytea so not `excludedOpen`).
- [ ] **Step 3:** Re-run the same suite and `tenantExportErasureRoundtrip.integration.test.ts`: PASS. Commit.
- [ ] **Mechanical grep (do not judge):** `grep -rn "ticket_type" apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts`. The column needs an export entry only; cascade and merge are table-level and unchanged for an added column. Enforced by **Integration Tests**, not Test API.

### Task 1.3: Create-path defaults (red first)

**Files:** Modify `ticketService.ts` (`createTicket` input gains `ticketType?: TicketType`; defaulting helper), `createTicketFromAlert`, `plannedWorkTicket.ts`; Test: `ticketService.test.ts`, `alertTickets.test.ts`, `plannedWorkTicket` test.

**Interfaces:**
- Produces: `defaultTicketTypeForSource(source: TicketSource, opts?: { plannedWork?: boolean }): TicketType` exported from `ticketService.ts` (or a tiny `ticketType.ts` beside it).
- Rule (Open Decision 3): `alert` → `incident`; planned work (`createPlannedWorkTicket`) → `service_request`; everything else (`portal`, `email`, `manual`, `api`, `ai`) → `incident` unless the caller passes an explicit `ticketType`. Intake forms / service catalog carry no type in W1 (seam: a later `default_ticket_type` on forms; see Open Decision 3).

- [ ] **Step 1: Failing tests**

```ts
it('defaults alert-created tickets to incident', async () => {
  const t = await createTicketFromAlert(/* existing fixture */);
  expect(t.ticketType).toBe('incident');
});
it('planned-work tickets default to service_request', async () => { /* createPlannedWorkTicket fixture */ expect(t.ticketType).toBe('service_request'); });
it('honours an explicit ticketType on createTicket', async () => {
  const t = await createTicket({ ...base, ticketType: 'problem' }, actor);
  expect(t.ticketType).toBe('problem');
});
it('rejects an unknown type', () => { expect(ticketTypeSchema.safeParse('outage').success).toBe(false); });
```
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/ticketService.test.ts src/routes/alerts/alertTickets.test.ts` → FAIL (property undefined).
- [ ] **Step 3:** Implement: add `ticketType: input.ticketType ?? defaultTicketTypeForSource(input.source)` to the insert in `createTicket`; pass `'incident'` explicitly in `createTicketFromAlert`; route `createPlannedWorkTicket` through `defaultTicketTypeForSource(source, { plannedWork: true })` rather than passing `'service_request'` explicitly (it calls `createTicket`, `plannedWorkTicket.ts` ~l.55, and an explicit value would be stamped as caller-supplied provenance). Set `fieldProvenance.ticket_type` only when the caller (user / ai_agent / service principal) supplied it explicitly, per `ticketProvenance.ts`.
- [ ] **Step 4:** Tests PASS. Commit.

### Task 1.4: Update path + event (red first)

**Files:** `ticketService.ts` (update function behind `PATCH /tickets/:id`), `ticketEvents.ts`, `ticketEventsContract.test.ts`, `routes/tickets/tickets.ts`, `routes/partnerApi/ticketWrites.ts`.

Behaviour (Open Decision 5, recommended): type is **editable by staff with `tickets` write**, never by portal users; changing it does **not** recompute SLA or re-run category rules (SLA keys off priority/category; the type is a classification). It records `ticket.updated` with `changed: ['ticketType']`, an internal system comment (`commentType: 'system'`, `isPublic: false`, `oldValue`/`newValue`), and field provenance.

- [ ] **Step 1: Failing tests:** PATCH `{ ticketType: 'problem' }` returns 200 and the new type; writes one internal system comment with old/new; does not change `responseSlaMinutes`/`resolutionSlaMinutes`/`dueDate`; emits `ticket.updated` with `changed` containing `ticketType`; portal user PATCH is impossible (no portal PATCH route exists; the portal create/update Zod schemas are plain `z.object`, not strict, so assert a `ticketType` key sent by a portal user is stripped and never persisted, not that it 400s; do not add `.strict()`, which would break clients sending extra keys); invalid value → 400.
- [ ] **Step 2:** run `npx vitest run src/services/ticketService.test.ts src/services/ticketEventsContract.test.ts src/routes/tickets` → FAIL.
- [ ] **Step 3:** Implement. Add `ticketType: ticketTypeSchema.optional()` to the staff create/update zod bodies in `packages/shared/src/validators/tickets.ts` (the create and update schemas are at ~l.20 and ~l.84 of that file; l.130/157/203 are the status-change, bulk and list-query schemas, which must NOT get the field except the list query's filter). Update path pushes `'ticketType'` into the `changed` array; no new event type needed (`ticket.updated`).
- [ ] **Step 4:** PASS. Commit.

### Task 1.5: List filter, export, stats-free (red first)

**Files:** `ticketService.ts` list function, `routes/tickets/tickets.ts` (query schema), `routes/tickets/export.ts`, `routes/partnerApi/tickets.ts`, `routes/officeAddin/tickets.ts`.

- [ ] **Step 1: Failing tests:** `GET /tickets?ticketType=problem` returns only problems; `?ticketType=incident,change` accepts a comma list (there is no existing multi-value convention: `listTicketsQuerySchema` in `packages/shared/src/validators/tickets.ts` ~l.200-217 has single-value fields only; add `z.preprocess` splitting on commas into `z.array(ticketTypeSchema).min(1).max(4)`); invalid value → 400; the filter composes with `status`, `categoryId`, `assignee`, soft-delete, and site scope (`siteScope.ts`): a site-scoped user never sees out-of-scope tickets under any type filter; export honours the same filter; every list/detail response includes `ticketType`.
- [ ] **Step 2:** run, FAIL. **Step 3:** implement (a single `inArray(tickets.ticketType, types)` condition added where `categoryId` is added). Partner API: add `ticketType` to the response model and to create/update; additive field only (Partner API compatibility rule: fields are only ever added, never removed or renamed). The `partner_feed_xid` trigger already re-stamps on write; a column add with default fires no trigger, so the feed is unaffected until an actual change.
- [ ] **Step 4:** PASS. Commit.
- [ ] **Bulk:** no bulk type-set in this feature. The bulk route stays unchanged; add one assertion that bulk update strips a `ticketType` key (`bulkTicketActionSchema` is not strict) and never persists it (so nothing silently half-works).

### Task 1.6: Repo-wide `tickets` call-site sweep

- [ ] **Step 1:** `grep -rn "from(tickets)\|insert(tickets)\|update(tickets)" apps/api/src --include=*.ts | grep -v test` and for each hit classify: *must carry type* (create paths, partner API, add-in, export), *may filter by type* (reports), *unaffected*. Record the table in the PR body (no security reasoning here, just a routing table).
- [ ] **Step 2:** `ticketSlaReport.ts`: add an optional `ticketType` filter only if the report already takes category filters; otherwise leave and note as follow-up (reporting by type is the *reason* the core set is fixed, but report UI is out of scope).
- [ ] **Step 3:** `services/aiAgents/ticketContext.ts`: include `ticketType` in the assembled ticket context (read-only; triage agents benefit). Check `ticketContext` tests for shape pinning and update them.

### Task 1.7: Wave gate

- [ ] Run: `cd apps/api && npx vitest run src/services/ticketService.test.ts src/services/ticketEventsContract.test.ts src/db/schema/ticketEnums.test.ts src/routes/tickets src/routes/partnerApi src/routes/officeAddin src/routes/alerts`; full `pnpm test` for api + shared; typecheck api + shared; integration suites through test-stack (`tenant-export-policy`, `tenantExportErasureRoundtrip`, `rls-coverage`); `pnpm test-stack down`.
- [ ] PR title `feat(tickets): ticket_type column + API (#7900 W1)`, body `Refs #7900` + sub-issue closing line.

---

# Wave 2: `ticket_links`

**Mergeable alone:** a new table plus routes; nothing references it from existing flows except the org-move/merge/cascade/export registries it must join. If W3 never ships, links are an API-only feature and every lifecycle path is already correct.

**High blast radius** (tenancy/RLS, org move, cascade, merge, concurrency): full rigor, one independent review round, a `codex exec` quorum on the migration and the lock-order change before the PR.

## Design decisions baked into W2 (see Open Decisions 1, 9)

- **One row per link; the inverse is derived at read time.** A row `(source, target, link_type)` reads "source `<link_type>` target". Derived inverse labels: `caused_by`↔`causes`, `resolves`↔`resolved_by`, `duplicate_of`↔`duplicates`, `related`↔`related`. Two-row storage doubles writes, needs a pair-consistency invariant and a delete-both transaction, and makes the org-move/merge story twice as large for no query benefit at this scale (two indexed lookups).
- `related` is symmetric: canonicalize so `source_ticket_id < target_ticket_id` (CHECK), so `(A,B,related)` and `(B,A,related)` cannot coexist.
- **Same org only**, enforced by the schema: both legs are composite `(ticket_id, org_id)` FKs to `tickets(id, org_id)` sharing one `org_id` column.
- CHECK no self-link; unique `(source_ticket_id, target_ticket_id, link_type)`; partial unique `(source_ticket_id) WHERE link_type = 'duplicate_of'` (a ticket duplicates at most one canonical ticket).
- App-layer guards (service, inside one transaction, both ticket rows locked `FOR UPDATE` in ascending id order): both tickets exist, not soft-deleted, same org, caller can see both under site scope; **cycle guard** for `caused_by`/`resolves` via a depth-capped recursive CTE (cap 25; reject with 409 `LINK_CYCLE`), run while holding a per-org `pg_advisory_xact_lock(hashtextextended('ticket_links:' || org_id, 0))` for those two link types (locking only the two endpoint rows does not stop two concurrent adds, e.g. A->B and C->D with existing B->C and D->A, from jointly closing a cycle under READ COMMITTED); add a concurrent-insert test; `duplicate_of` chains are kept depth 1: reject if the target is itself a `duplicate_of` source (409 `DUPLICATE_TARGET_IS_DUPLICATE`, naming the canonical ticket) or if the source is already a `duplicate_of` target. Max 50 links per ticket (409 `LINK_LIMIT`), a cheap abuse guard.
- **No status propagation in the MVP.** Linking never changes either ticket's status, SLA or assignee. `duplicate_of` is link-only (Open Decision 9).
- **Org move deletes, not re-stamps.** A link has two tickets; moving one ticket to another org would leave a link whose legs disagree on org, which the composite FKs forbid, and neither mover can move both. So both movers **delete every `ticket_links` row touching the moved ticket(s)**, as the **last** step of the shared child order (after `ticket_approval_requests`), and the two FKs are **deferred by name** like every other composite child FK.
  - *Why deferral is mandatory (Codex review, verified):* on the device axis the `devices` UPDATE fires `breeze_cascade_device_org_id()`, which re-stamps `tickets.org_id` *inside that statement* (`moveDeviceOrgInTransaction.ts` ~l.450 and the comment at ~l.859-865), long before the child tail runs. An immediate `ticket_links` FK would 23503 at that point, before any delete could execute. So add `ticket_links_source_org_fk, ticket_links_target_org_fk` to the `SET CONSTRAINTS ... DEFERRED` statements in `moveTicketOrg` (`ticketService.ts` ~l.3230) and in `moveDeviceOrgInTransaction.ts` (~l.172-181). With deferral the delete simply follows the single canonical order (last), which removes a "delete before UPDATE tickets" ordering conflict an earlier draft had; at COMMIT no violating row remains because the rows are gone.
  - *No counterpart writes inside the move transaction.* Writing a system comment on the surviving counterpart inside the move touches that ticket's row (the comment trigger re-stamps `partner_feed_xid` on the parent, `2026-12-13-120000-tickets-partner-feed-xid.sql`), and two concurrent moves of linked tickets A and B could then wait on each other's parent row lock. Instead the delete uses `RETURNING` to collect `(counterpartTicketId, linkType, movedTicketNumber)`, and the notes are written **after the move transaction commits**, best-effort, each in its own short transaction (a failure is logged and never fails the move). Inside the move the only extra lock is the link row itself; two concurrent deletes of the same shared row serialize on that row while holding no lock on the other ticket's parent row.
  - Precedent: the `ticket_external_refs` cross-partner delete in `moveDeviceOrgInTransaction.ts` (~l.1063-1083).
- **Org merge:** `repoint`. Both legs live in the loser org; both tickets move to the survivor; unique keys cannot collide (ticket ids are globally unique). Under merge's single transaction + `SET CONSTRAINTS ALL DEFERRED`, a repoint is safe.

**Files (whole wave)**
- Create: `apps/api/migrations/2026-12-23-130100-ticket-links.sql`, `apps/api/src/db/schema/ticketLinks.ts` (+ export from `db/schema/index.ts`), `apps/api/src/services/ticketLinkService.ts` (+ test), `apps/api/src/routes/tickets/links.ts` (+ test), `apps/api/src/__tests__/integration/ticketLinksRls.integration.test.ts`, `apps/api/src/__tests__/integration/ticketLinksOrgMove.integration.test.ts` (model: `ticketExternalRefsOrgMove.integration.test.ts`)
- Modify: `routes/tickets/index.ts` (mount), `packages/shared/src/validators/tickets.ts` (`ticketLinkTypeSchema`, request schemas), `ticketOrgMoveLockOrder.ts`, `ticketService.ts` (`moveTicketOrg`), `routes/devices/core.ts` + `services/deviceOrgMove/moveDeviceOrgInTransaction.ts`, `tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `ticketEvents.ts`, `rls-coverage.integration.test.ts` (only if it needs an explicit table list entry)

### Task 2.1: Schema, RLS, cross-tenant forge test (red first)

- [ ] **Step 1: Pre-flight:** `git ls-tree` re-check of migration names; `grep -n "tickets_id_org_uq" apps/api/migrations/*.sql` (must exist).
- [ ] **Step 2: Failing integration test** `ticketLinksRls.integration.test.ts` (under `pnpm test-stack up`): as `breeze_app` in org A's context, inserting a link whose `org_id` is B's → SQLSTATE `42501`; inserting a link between a ticket in A and a ticket in B with `org_id = A` → `23503` (composite FK); self-link → `23514`; duplicate `(source,target,type)` → `23505`; `related` with `source > target` → `23514`; second `duplicate_of` for one source → `23505`; org A context selects zero rows of org B; deleting a ticket cascades its links. Run: `cd apps/api && npx vitest run src/__tests__/integration/ticketLinksRls.integration.test.ts` → FAIL (relation missing).
- [ ] **Step 3: Migration**

```sql
-- ticket_links (#7900): typed links between two tickets of ONE org.
-- Tenancy shape 1 (direct org_id). One row per link; the inverse is derived.
-- Row reads: source <link_type> target.
DO $$ BEGIN
  CREATE TYPE ticket_link_type AS ENUM ('caused_by', 'resolves', 'related', 'duplicate_of');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ticket_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_ticket_id uuid NOT NULL,
  target_ticket_id uuid NOT NULL,
  link_type ticket_link_type NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_links_no_self_chk CHECK (source_ticket_id <> target_ticket_id),
  CONSTRAINT ticket_links_related_canonical_chk
    CHECK (link_type <> 'related' OR source_ticket_id < target_ticket_id)
);

DO $$ BEGIN
  ALTER TABLE ticket_links ADD CONSTRAINT ticket_links_source_org_fk
    FOREIGN KEY (source_ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE ticket_links ADD CONSTRAINT ticket_links_target_org_fk
    FOREIGN KEY (target_ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_pair_type_uq
  ON ticket_links (source_ticket_id, target_ticket_id, link_type);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_one_canonical_uq
  ON ticket_links (source_ticket_id) WHERE link_type = 'duplicate_of';
CREATE INDEX IF NOT EXISTS ticket_links_target_idx ON ticket_links (target_ticket_id);
CREATE INDEX IF NOT EXISTS ticket_links_org_idx ON ticket_links (org_id);

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_links FORCE ROW LEVEL SECURITY;
-- Policies: copy the four policies (select/insert/update/delete) of
-- ticket_external_refs from 2026-12-04-101300-ticket-external-refs.sql,
-- each with breeze_has_org_access(org_id) in USING / WITH CHECK, replacing
-- the table name. (Full text goes in the migration; do not paraphrase.)
```
Rows are never written, so no `breeze.scope` line. Confirm the exact policy text and grants (`GRANT … TO breeze_app` if the precedent has them) by reading the precedent file end to end.
- [ ] **Step 4:** Drizzle `ticketLinks` table + `ticketLinkTypeEnum`; Zod `ticketLinkTypeSchema`; extend `ticketEnums.test.ts` with a parity test for `ticket_link_type` (same pattern as Task 1.1).
- [ ] **Step 5:** test PASS; `pnpm db:check-drift`; commit `feat(tickets): ticket_links table with org-scoped RLS (#7900)`.

### Task 2.2: Registrations (cascade, merge, export, lock order). Contract tests first

These five registrations are the "not done until registered" list. Grep, don't judge.

- [ ] **Step 1: Failing contract run** (table exists, registries untouched):
```bash
pnpm test-stack up
cd apps/api && npx vitest run src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected FAIL: `ticket_links` missing from the cascade order and the export policy (and merge registry test, wherever it lives: `grep -rln orgMergeRegistry apps/api/src --include=*.test.ts`).
- [ ] **Step 2: Cascade:** in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) insert `'ticket_links'` between `'ticket_forms'` and `'ticket_mailbox_connections'`, with a comment in the file's style (shape 1; composite FKs to tickets; children-before-parent satisfied because `'ticket_links' < 'tickets'` under `localeCompare`: verified `-1`). Re-verify: `node --eval "console.log('ticket_forms'.localeCompare('ticket_links'),'ticket_links'.localeCompare('ticket_mailbox_connections'),'ticket_links'.localeCompare('tickets'))"` must print `-1 -1 -1`.
- [ ] **Step 3: Export:** `CORE_TENANT_EXPORT_POLICY`: `"ticket_links": tablePolicy("org_id", {"included":["id","org_id","source_ticket_id","target_ticket_id","link_type","created_by","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]})` placed alphabetically (after `ticket_forms…`).
- [ ] **Step 4: Merge:** `orgMergeRegistry.ts`: add `"ticket_links"` to the plain-repoint list next to `"ticket_external_refs"` (~l.1154) with a comment (both legs repoint with their tickets; ticket ids are globally unique so no dedupe), and, if the file also keeps a per-table kind map for this table class, add the entry there. Add `'ticket_links'` to `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` (see Task 2.3) because the merge walker reorders by it.
- [ ] **Step 5:** Re-run the four suites: PASS. Commit.
- **No `device_id` column on `ticket_links`, so `CORE_DEVICE_*` cascade lists in `routes/devices/core.ts` are untouched.** (The *device org-move* list in the same file is a different list and is touched in Task 2.3.)
- **Enforcement map:** cascade order + both export-policy suites + roundtrip + merge registry: *Integration Tests* only. Lock-order/coverage unit tests (`moveOrg.coverage.test.ts`, `ticketOrgMoveLockOrder` tests): *Test API*.

### Task 2.3: Both org movers + lock order (red first, high risk)

Read `ticketOrgMoveLockOrder.ts` header fully (the #4657 AB-BA history, #4748 merge tie-break) before editing.

- [ ] **Step 1: Failing tests:** (a) `ticketOrgMoveLockOrder` / `moveOrg.coverage.test.ts` fail until `ticket_links` is in the right place; (b) new `ticketLinksOrgMove.integration.test.ts`: link A→B in org X; `moveTicketOrg(A, orgY)` succeeds, the link is gone, B survives in X, B gains an internal system comment naming the removed link (written after commit), A's other children are re-stamped as before; same for `POST /devices/:id/move-org` where A is the device's ticket; links between two tickets *both* on the moved device are deleted too; a concurrent `moveTicketOrg(A)` and `moveTicketOrg(B)` pair completes without 40P01 (the model integration test shows how to drive the concurrency).
- [ ] **Step 2: Lock order and coverage test.** Append `'ticket_links'` **last** in `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` (after `ticket_approval_requests`), with a comment stating it is delete-not-rewrite and why its FKs are deferred. For `TICKET_ORG_DENORMALIZED_TABLES`, read the loop in `moveTicketOrg`: it is an `UPDATE ... SET org_id WHERE ticket_id = $1`, and `ticket_links` has no `ticket_id` column, so it cannot live in that list; add a separate exported `TICKET_ORG_MOVE_DELETE_TABLES = ['ticket_links'] as const` consumed by a delete step placed after the loop. **`moveOrg.coverage.test.ts` will not discover this table on its own** (its discovery requires a literal `ticket_id` plus `org_id` column, ~l.565; `ticket_links` has `source_ticket_id`/`target_ticket_id`): extend the test with an explicit assertion that `ticket_links` is in `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` and the delete list and that both movers delete on both legs. Write that assertion first and watch it fail.
  Existing contract tests that this design changes (review finding, verified): `ticketOrgMoveLockOrder.test.ts` (~l.80-98) requires the projections of `TICKET_ORG_DENORMALIZED_TABLES` and `CUSTOM_ORG_REWRITE_TABLES` onto the canonical order to each equal the full canonical order, so the new `TICKET_ORG_MOVE_DELETE_TABLES` and a device-axis equivalent must be included in both projections (update the test to project `[...rewrite, ...delete]`); the same file hardcodes `fixed.slice(3, 13)` for ten ticket child tables (~l.173), which must grow by one; and `moveOrg.test.ts` checks the device mover's hand-written statements against `CUSTOM_ORG_REWRITE_TABLES` in order, so teach it that a `DELETE FROM ticket_links` statement satisfies the delete-list entry. Update these tests red-first in the same task.
- [ ] **Step 3: `moveTicketOrg`:** add the two FK names to the `SET CONSTRAINTS ... DEFERRED` statement; after the rewrite loop run `DELETE FROM ticket_links WHERE source_ticket_id = $1 OR target_ticket_id = $1 RETURNING source_ticket_id, target_ticket_id, link_type`; after the transaction commits, write the internal notes on the surviving counterparts (outside the transaction, best-effort).
- [ ] **Step 4: Device mover:** mirror in `moveDeviceOrgInTransaction.ts`: defer the same two FKs in its `SET CONSTRAINTS` statement; delete `WHERE source_ticket_id IN (SELECT id FROM tickets WHERE device_id = $d) OR target_ticket_id IN (SELECT id FROM tickets WHERE device_id = $d)` at the tail position; notes after commit. Update `CUSTOM_ORG_REWRITE_TABLES` / its declaration in `routes/devices/core.ts` as the coverage test requires.
- [ ] **Step 5:** run `npx vitest run src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/ticketService.test.ts` plus the new integration test (including a concurrent `moveTicketOrg(A)` / `moveTicketOrg(B)` on linked tickets completing without 40P01, and a device move whose ticket is linked to a ticket on another device): PASS. Commit.

### Task 2.4: Link service (red first)

**Files:** `ticketLinkService.ts` (+ `.test.ts`), `ticketEvents.ts`.

**Interfaces:**
- Produces:
```ts
export type TicketLinkView = { id: string; direction: 'outgoing' | 'incoming'; linkType: TicketLinkType; label: DerivedLinkLabel; other: { id: string; ticketNumber: string; subject: string; status: TicketStatus; ticketType: TicketType }; createdAt: string };
export async function listTicketLinks(ticketId: string, actor: TicketActor): Promise<TicketLinkView[]>;
export async function addTicketLink(input: { sourceTicketId: string; targetTicketId: string; linkType: TicketLinkType }, actor: TicketActor): Promise<TicketLinkView>;
export async function removeTicketLink(ticketId: string, linkId: string, actor: TicketActor): Promise<void>;
export class TicketLinkError extends Error { code: 'LINK_CYCLE'|'LINK_LIMIT'|'CROSS_ORG'|'NOT_FOUND'|'DUPLICATE_TARGET_IS_DUPLICATE'|'ALREADY_LINKED'; status: 404|409|422 }
```
- Events (`ticketEvents.ts`): `{ type: 'ticket.link_added'; payload: { linkType: TicketLinkType; otherTicketId: string } }` and `ticket.link_removed`, emitted for *both* tickets; update `ticketEventsContract.test.ts` and every consumer that exhaustively switches on event type (`grep -rn "ticket\.sla_breached" apps/api/src`).

- [ ] **Step 1: Failing unit tests** for: normalization of `related` (callers may pass either order; stored canonical); duplicate add → `ALREADY_LINKED` (idempotent 200 is the alternative; choose 409 to match `EXTERNAL_ID_CONFLICT` style); cross-org target → `CROSS_ORG` (422, and the response must not reveal that the other ticket exists: answer `NOT_FOUND` when the caller cannot see it under site scope or org access); self-link rejected; cycle `A caused_by B`, `B caused_by C`, then `C caused_by A` → `LINK_CYCLE`; `duplicate_of` depth rule; 51st link → `LINK_LIMIT`; soft-deleted target → `NOT_FOUND`; remove by wrong ticket id → `NOT_FOUND`; add/remove each emit one event per ticket and one internal system comment per ticket; `listTicketLinks` returns derived inverse labels and **omits** counterpart tickets the caller cannot see under site scope; a counterpart that was soft-deleted after linking is omitted from lists.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/ticketLinkService.test.ts` → FAIL. **Step 3:** implement with the lock/cycle algorithm above in a single `db.transaction`. **Step 4:** PASS. **Step 5:** commit.

### Task 2.5: Routes (red first)

**Files:** `routes/tickets/links.ts`, `routes/tickets/index.ts`, test `routes/tickets/links.test.ts`.

- `GET /tickets/:id/links` (permission: tickets read) → `TicketLinkView[]`
- `POST /tickets/:id/links` body `{ targetTicketId?: uuid, targetTicketNumber?: string, linkType }` (exactly one target key; number resolves within the caller's org scope) (tickets write)
- `DELETE /tickets/:id/links/:linkId` (tickets write)
- All three go through `getScopedTicketOr404`-style scoping and `siteScope.ts` exactly like `checklist.ts`/`parts.ts`; mutation responses follow the `{ success: true, … }` convention `runAction` expects.

- [ ] **Step 1: Failing route tests:** 401/403 without permission; 404 for a ticket in another org (never 403, to avoid existence leak); site-scoped user denied linking to a ticket outside scope; 422 body validation (both or neither target key); success shapes; `linkType: 'blocks'` → 400.
- [ ] **Step 2:** FAIL. **Step 3:** implement; mount in `routes/tickets/index.ts`. **Step 4:** PASS; add the wave-gate commands: all W2 unit tests, the four integration suites via test-stack, `ticketLinksRls`, `ticketLinksOrgMove`, typecheck api + shared, `pnpm test-stack down`.
- [ ] **Step 5:** PR `feat(tickets): ticket links backend (#7900 W2)`. Since W2 touches tenancy/cascade, run the full contract suites (not only the targeted ones) before opening, and one independent review round. Quorum: `codex exec` read-only on the migration + Task 2.3 diff (see "Quorum" below).

---

# Wave 3: Web (list filter, nav, Related-tickets panel)

**Mergeable alone:** UI over already-merged APIs. Nav entries are additive. If W4 never ships, staff have the full feature.

**Files**
- Modify: `apps/web/src/components/tickets/TicketsPage.tsx` (type filter, hash), `TicketQueueList.tsx` (type chip), `TicketWorkbench.tsx` (type selector + panel mount), `CreateTicketPage.tsx` (type select), `apps/web/src/components/layout/Sidebar.tsx` (nav + hash-aware active state)
- Create: `apps/web/src/components/tickets/TicketLinksCard.tsx` (+ test), `apps/web/src/components/tickets/ticketType.ts` (labels/icons/order; unit test)
- Modify locale files: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json` and the `nav` namespace file that holds `nav.tickets` (find with `grep -rn '"sectionServiceDesk"' apps/web/src/locales/en`)

### Task 3.1: Type filter with hash state (red first)

Hash layout today: `#<selection>&sort=<sort>`. New: `#<selection>&sort=<sort>&type=<type>` (`type` omitted when empty), parsed by `parseHash`, emitted by `hashFor`, consumed through `useHashState` like `sort`. Today `parseHash` treats **any** segment that is not `sort=` as the *selection* (`TicketsPage.tsx` ~l.130), so an unknown `type=incident` segment would currently be read as a ticket key. The new `type=` branch must be added **before** the selection fallback, exactly as `sort=` is, and a test pins that `#type=incident` yields `selection: null`. Old bookmarks without `type=` are unaffected.

- [ ] **Step 1: Failing tests** (`TicketsPage.test.tsx`; and a pure `parseHash`/`hashFor` test: export them for testing or test through the component): `#type=problem` preselects the filter and the list request carries `ticketType=problem`; changing the select rewrites the hash (`replaceUrl`) and keeps selection and sort; `#T-2026-0001&type=change` keeps both; an invalid `type=` value is ignored; clearing filters removes `type=`; the "filters active" indicator counts the type filter; `hashchange` (nav click while on the page) updates the filter without remount; changing the filter from the select notifies the sidebar (`breeze:urlchange`).
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/tickets/TicketsPage.test.tsx` → FAIL. **Step 3:** implement. **Step 4:** PASS. Commit.
- Scope note: the category filter is *not* moved into the hash here (the discussion comment observed this; it is a separate paper cut). Only the new type filter uses the hash; moving category is a one-line follow-up using the same helpers, listed in the PR but not done, to keep this wave reviewable.

### Task 3.2: Service Desk nav entries per type (red first)

- [ ] **Step 1: Failing test** (there are ~15 `Sidebar.*.test.tsx` files; extend `Sidebar.nav.test.tsx` or the closest existing nav test, `ls apps/web/src/components/layout/Sidebar.*.test.tsx`): Service Desk section lists Tickets, Incidents, Service Requests, Problems, Changes, Timesheets in that order, each typed entry with `href` `/tickets#type=<type>`; exactly one entry is active at a time (a typed hash activates its entry, no hash or another hash activates plain Tickets); the `requiredPermission` and `requiresModule: 'service_management'` gates apply to all; collapsed/narrow rendering still shows icons with tooltips.
- [ ] **Step 2: Implement.** `activeHref` is derived from `window.location.pathname` only (`useCurrentPath`, l.101/767) and active state is `item.href === activeHref`, so five entries sharing `/tickets` would either all be active or none. Three requirements (Codex review, verified against `replaceUrl.ts` and `Sidebar.tsx`):
  1. **Match on the parsed type, not the href string.** The page hash can be `#T-2026-0001&sort=updated&type=change`; a string match on `/tickets#type=change` would miss it. Export a small pure helper (e.g. `ticketTypeFromHash(hash): TicketType | null` in `ticketType.ts`, reused by `TicketsPage.parseHash`); the sidebar marks the typed entry active when `pathname === '/tickets'` and the parsed type equals the entry's type, and plain Tickets active when no type is parsed.
  2. **`replaceUrl` emits no event** (`history.replaceState` fires neither `hashchange` nor `popstate`), and the filter select rewrites the hash through it. Add an explicit notification: have `replaceUrl` dispatch a `breeze:urlchange` `CustomEvent` on `window`, and have the sidebar tracker listen for it in addition to `hashchange`, `popstate` and `astro:after-swap`. `no-wipe-history-state.test.ts` must stay green.
  3. **Mount-time read.** `useCurrentPath` seeds from a server-provided `initialPath` and only registers listeners; on a deep link `/tickets#type=problem` the hash is not in it. Read `window.location.hash` in an effect on mount.
  Keep `sectionForHref` pathname-only. The sidebar is shared by every page, so cover the helper and all three behaviours with tests.
- [ ] **Step 3:** locale keys `nav.ticketsIncidents`, `nav.ticketsServiceRequests`, `nav.ticketsProblems`, `nav.ticketsChanges` in all 8 locale dirs (en + 7). Run `npx vitest run src/lib/i18n/localeParity.test.ts` and `src/locales` key tests. Commit.
- Whether nav entries ship in W3 or separately: Open Decision 8 (recommended: with W3, behind no flag).

### Task 3.3: Type chip, selector, create form

- [ ] Failing tests: queue rows show a type chip; the workbench shows a type select for users with tickets write, changing it calls `PATCH /tickets/:id` through `runAction` and toasts via `ActionError` handling as in CLAUDE.md (`if (err instanceof ActionError && err.status === 401) return;` …); create form defaults to Incident and sends `ticketType`; read-only users see a chip, not a select. `no-silent-mutations.test.ts` must stay green (no allowlist additions).
- [ ] Implement; locale keys for the four type labels (`ticketType.incident` …) in 8 locales; PASS; commit.

### Task 3.4: Related-tickets panel

**Files:** `TicketLinksCard.tsx`, mounted in `TicketWorkbench.tsx` beside `TicketChecklistCard` (mirror its data-loading and confirm patterns).

- [ ] Failing tests: lists links grouped by derived label (Caused by / Causes / Resolves / Resolved by / Duplicate of / Duplicates / Related) with number, subject, status and type chip; each links to `/tickets#<number>`; add dialog: type select + ticket search by number/subject (reuse the list search endpoint scoped to the same org, excluding the current ticket); remove button with confirm; add/remove via `runAction`; 409 error codes map to specific toast messages (`LINK_CYCLE`, `ALREADY_LINKED`, `LINK_LIMIT`, `DUPLICATE_TARGET_IS_DUPLICATE`); empty state; read-only users see no add/remove; a problem ticket shows a count "N linked incidents" computed client-side from the links (no server rollup; Open Decision 4).
- [ ] Implement, locale keys in 8 locales, PASS. Wave gate: `cd apps/web && npx vitest run src/components/tickets src/components/layout src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts`; web typecheck (exit code); lint. PR `feat(web): ticket types, nav and related tickets (#7900 W3)`. Browser verification through `worktree-stack`/Playwright is the orchestrator's pre-release sweep; list the checks in the PR body (nav highlights, hash bookmark round-trip, link add/remove).

---

# Wave 4: Portal display + AI tools

**Mergeable alone:** portal read model gains one field; AI tools gain a filter and two write actions. If it never ships, W1–W3 are intact.

## Portal exposure (Open Decision 7; recommendation implemented here)

- **Type: visible, read-only.** `ticketType` is added to the portal ticket list/detail read model (`services/portal/ticketReadModel.ts`, `routes/portal/tickets.ts`, `ticketOwnership.ts` unchanged) and rendered as a small badge in `apps/portal/src/components/portal/{TicketList,TicketDetails}.tsx`. Portal create (`NewTicketForm.tsx`) does **not** let the customer choose a type (they would mislabel; staff classify). Portal-created tickets use the `portal` source default.
- **Links: not exposed to the portal in this feature.** A link names another ticket's number and subject. That ticket may be internal (a problem or change the customer should not see) or belong to a requester the viewer does not own. The only safe exposure is a link whose counterpart passes the *same* portal visibility predicate as the viewer's own list (same org, not deleted, visible under #7730's flags and the ownership rule), which needs its own design and RLS test. Until then the portal read model selects no link data at all. This is a deliberate omission, not a gap: a regression test asserts the response of every portal ticket route contains no `links`/`ticket_links`-derived key, so a later "helpful" join cannot start leaking silently.
- Reconcile with #7730: read `portalVisibilityRls.integration.test.ts` and `services/portal/*ReadModel.ts` first; if #7730's flags already gate ticket fields, hang `ticketType` off the same flag rather than adding a new one.

**Files**
- Modify: `services/portal/ticketReadModel.ts` (+ `ticketReadModel.test.ts`), `routes/portal/tickets.ts`, `apps/portal/src/components/portal/{TicketList,TicketDetails}.tsx`, `apps/portal/src/lib/ticketsPage.ts` (type in the list type, no filter UI), portal locale files (find: `ls apps/portal/src`)
- Modify AI: `services/aiToolsTicketing.ts` (and its `aiToolsTicketing.*.test.ts` family), `services/mcpCoverage.ts` + `aiAgentSdkTools.mcpCoverage.test.ts`, registries `aiToolSchemas*`, `aiGuardrails`, `aiToolRateLimits`, `aiAgentSdkTools`, `agentToolCatalog`

### Task 4.1: Portal read model (red first)

- [ ] Failing tests: portal list/detail include `ticketType`; response never includes link data; a portal user cannot set the type (a sent `ticketType` key is stripped and never persisted); no new column is read for non-owner rows.
- [ ] Implement; portal component tests for the badge; PASS; commit.

### Task 4.2: AI read surface first (separate commit)

- [ ] Failing tests (`aiToolsTicketing.outputShape.test.ts`, `siteScope`, `deviceScope`): `manage_tickets` list/get accept `ticketType` (single or array) and return it; output shape stays within the declared contract; site/device scope tests still pass with the filter; a `list_ticket_links` read (either a `manage_tickets` action `list_links` or a sibling read tool; prefer an action to avoid a new tool registry entry; decide when reading the existing action list at `aiToolsTicketing.ts:556+`) returns the same derived view as the service and respects site scope.
- [ ] Implement via `ticketLinkService.listTicketLinks` (no query duplication). Read-only commit mergeable by itself. Update `mcpCoverage` if the action list is mirrored there; run `npx vitest run src/services/aiAgentSdkTools.mcpCoverage.test.ts`.

### Task 4.3: AI write surface (high care)

- Registry specifics (verified): the read action `list_links` must be added to the read-only allowlist at `aiGuardrails.ts` (~l.297, `manage_tickets: ['list','get','list_work_types']`); there is no separate shadow-run deny set: `ticketShadowGuardrail.contract.test.ts` (~l.45) derives it from `TIER2_ACTIONS.manage_tickets`, so putting `link_ticket`/`unlink_ticket` in `TIER2_ACTIONS` is the shadow change; `agentToolCatalog` is `services/aiAgents/agentToolCatalog.ts`.
- [ ] Add actions `link_ticket` and `unlink_ticket` (and `ticketType` on create/update) to `manage_tickets`. Each write action needs: a guardrail tier in `aiGuardrails` (recommended: same tier as other `manage_tickets` writes such as comment/assign; links are reversible, internal, and org-bounded, so no higher), a rate-limit entry in `aiToolRateLimits`, schema entries in `aiToolSchemas*`, SDK registration in `aiAgentSdkTools`, catalog entry in `agentToolCatalog`, and `mcpCoverage`.
- [ ] **Traps:** the AI-tool contract tests key `SAFE_WRITE_SITES` by **line number**: adding lines above an existing site shifts keys; update the keyed list in the same commit and re-run those tests. Never use `z.undefined()` in a tool schema (it empties the model's tool list); use `.optional()`.
- [ ] Ticket-shadow runs: helpdesk-agent runs deny `manage_tickets` mutations (see the comment on `ticketComments.originPrincipalKind` in `portal.ts` and the shadow gating from wave 6 of the AI-agents feature). Add the two new actions to that deny set and test it: a ticket-run principal calling `link_ticket` is refused.
- [ ] Failing tests first for: link/unlink through the tool honour the service guards (cycle, cross-org, limit), site scope, and write-gap tests in `aiToolsTicketing.writeGaps.test.ts`; provenance records `ai_agent` as the actor on the system comments/events. Then implement.
- [ ] Wave gate: `cd apps/api && npx vitest run src/services/aiToolsTicketing src/services/aiAgentSdkTools src/services/portal src/routes/portal`; portal tests `cd apps/portal && npx vitest run`; typecheck api/web/portal; full api + shared tests. PR `feat(tickets): portal type badge + AI ticket type/link tools (#7900 W4)`.

---

## Behaviour summary (reference for implementers)

| Path | Default type | Notes |
|---|---|---|
| Manual (staff UI) | `incident` | UI create form lets staff choose |
| Email intake | `incident` | staff reclassify; no NLP in scope |
| Alert bridge (`createTicketFromAlert`) | `incident` | explicit |
| AI (`manage_tickets` create) | `incident` unless given | provenance `ai_agent` when AI supplies it |
| Portal | `incident` | customers cannot choose |
| Partner API / Office add-in | `incident` unless given | additive field |
| Planned work (`createPlannedWorkTicket`) | `service_request` | |
| Intake forms / service catalog | `incident` in this feature | follow-up: `default_ticket_type` on forms/catalog items (Open Decision 3) |

Events: type change is `ticket.updated` (`changed: ['ticketType']`); links add `ticket.link_added` / `ticket.link_removed` on both tickets. Audit: every type change and link change writes an internal `system` ticket comment (who/what/old/new) and follows the existing audit-log pattern used by `addTicketComment` (read it and mirror; do not invent a new one).

## Quorum (design-consequential: new table + tenancy)

A read-only Codex pass (effort medium) was run on this plan; its seven findings were each checked against the cited files and folded in (FK deferral with tail-position delete, counterpart notes after commit, the coverage-test discovery gap, the separate concurrent index migration, the hash-parser and sidebar-notification corrections). Before opening the W2 PR, repeat a read-only Codex pass at `xhigh` on the migration and the Task 2.3 diff (tenancy shape is hard to reverse). Verify every claim by re-reading the cited file before acting; record unresolved disagreements under Open Decisions in the PR.

## Self-review notes

- Spec coverage: type enum + filters (W1), typed links with org scoping, composite DEFERRABLE FKs, move/cascade/merge/export registration (W2), list filter, per-type nav with hash filter, Related-tickets panel (W3), portal display + AI tools (W4). Change-record fields and approvals are explicitly out, with a seam.
- Placeholders: the RLS policy text and index-creation style are deliberately "copy from named precedent file", because the exact text must come from the shipped file, not from this plan's paraphrase; each is marked at its step.
- Consistency: names used across waves: `ticketTypeEnum`, `ticketTypeSchema`, `TicketType`, `ticket_type`; `ticketLinks`, `ticketLinkTypeSchema`, `ticket_links`, `listTicketLinks`/`addTicketLink`/`removeTicketLink`, `TicketLinkError`.

## Review Focus

1. A ticket moved to another org (staff move or device move, including the device trigger that re-stamps `tickets.org_id` mid-statement) while linked: links are deleted with the FKs deferred, the counterpart note is written after commit, no 23503, no 40P01 under concurrent moves of both ends (Task 2.3 tests).
2. A site-scoped or limited user adding/listing links: never learns an out-of-scope ticket exists (404, omitted from lists) (Tasks 2.4/2.5).
3. Cycles and duplicate chains: `caused_by` cycle, `duplicate_of` of a duplicate, 50-link cap (Task 2.4).
4. Portal responses never carry link-derived data or internal ticket numbers/subjects (Task 4.1).
5. Hash handling on the tickets page: old `#<selection>&sort=…` bookmarks, hostile/unknown `type=` values, nav click while already on `/tickets` (Tasks 3.1/3.2).
6. AI link tools under ticket-shadow runs and guardrails (Task 4.3).

---

## Open Decisions

1. **Link vocabulary and storage.** Options: (a) fixed four (`caused_by`, `resolves`, `related`, `duplicate_of`), one row per link with derived inverse; (b) add `blocks/blocked_by`, `parent/child`, `merged_into`; (c) two rows per link. **Recommend (a):** it is the issue's scope, parent/child and blocking imply workflow semantics (status gating, rollups) that need their own design, and the enum can be extended later with `ALTER TYPE … ADD VALUE`; one row halves lifecycle work and avoids a pair-consistency invariant.
2. **`ticket_type` storage and labels.** Options: (a) Postgres enum column, labels from i18n only; (b) lookup table with fixed core keys plus partner-editable labels; (c) enum column now, partner label overrides as an optional W5. **Recommend (c):** the fixed enum is what reporting needs; labels are cosmetic. If W5 ships, labels are partner-level config with no org override, so a partner-axis table (`partner_id NOT NULL`, like `ticket_categories`/`ticket_statuses`) is justified instead of the org-XOR-partner dual shape, and it still needs the partner cascade and export registrations plus `canManagePartnerWidePolicies`-style write gating. If the product wants org-level label overrides, flip to the dual-ownership playbook in `docs/agents/tenancy-rls.md` (dual-axis RLS, `DUAL_AXIS_TENANT_TABLES`, `<table>PartnerRls.integration.test.ts`, ownerScope selector).
3. **Default type for existing and new tickets.** Options: (a) existing → `incident`; new defaults per source (alert → incident, planned work → service_request, rest → incident); (b) existing → `service_request`; (c) infer from source/category at backfill. **Recommend (a):** the constant default keeps the migration metadata-only and honest (no heuristic guesses written into history); reclassification is a one-click edit. Follow-up: `default_ticket_type` on intake forms and service-catalog items so portal requests via those become `service_request` automatically.
4. **ITIL problem rollups.** Options: (a) none now (panel shows a client-side count); (b) server rollup of linked-incident counts/SLA/status on the problem; (c) auto-resolve linked incidents when the problem resolves. **Recommend (a):** rollups and status propagation are policy-laden; ship the data model first and learn what MSPs actually want.
5. **Is type editable after creation; does it retrigger SLA/category rules?** Options: (a) editable by staff, no SLA/category recompute; (b) editable and recompute; (c) immutable. **Recommend (a):** misclassification at intake is the norm (email), SLA is keyed to priority/category, and recomputing on a classification edit would surprise.
6. **Cross-org links (partner-scope problems).** Options: (a) out of scope, record as follow-up; (b) design now with partner-axis links. **Recommend (a):** one-org scoping is the issue's explicit boundary and keeps shape 1; a partner-scope problem is a different tenancy shape (parent record owned by the partner, children in orgs) that deserves its own spec after usage data.
7. **Portal visibility under #7730.** Options: (a) type visible read-only, links hidden; (b) both hidden; (c) both visible with a visibility predicate. **Recommend (a):** the type is harmless and useful; links name other tickets and need a counterpart-visibility predicate plus tests, so (c) is a separate follow-up.
8. **Wave cut and nav timing.** Options: (a) W1 API, W2 links, W3 web + nav, W4 portal + AI; (b) nav entries as their own wave; (c) merge W1+W2. **Recommend (a):** each wave has one risk class (additive column; tenancy; UI; cross-surface) and is mergeable alone; nav belongs with the filter it targets, and splitting it would ship dead links or a filter without entry points.
9. **`duplicate_of` semantics.** Options: (a) link-only; (b) link + auto-close the duplicate; (c) real merge (comments, time, attachments move to the canonical ticket). **Recommend (a):** merging moves money-bearing child rows (time entries, parts) and customer conversations, which is a feature of its own with a billing blast radius; staff can close the duplicate with the existing status flow.
10. **Org move: delete vs refuse.** Options: (a) delete links touching the moved ticket and note it on the surviving ticket; (b) refuse the move with 409 until links are removed; (c) allow cross-org links. **Recommend (a):** consistent with the `ticket_external_refs` precedent and never blocks an admin action; (b) is stricter but makes bulk device moves brittle.
11. **Who may create links.** Options: (a) tickets write permission plus site scope on both tickets; (b) a dedicated `ticket_links` permission. **Recommend (a):** a link is part of editing a ticket; a new permission is nav/role-matrix churn without a distinct risk.
12. **Index build.** Options: (a) in the column migration; (b) separate `@no-transaction` migration with `CREATE INDEX CONCURRENTLY`. **Recommend (b):** the runner wraps a migration in one transaction, so (a) would hold the `ALTER TABLE` lock across a scan of `tickets`; the tier-1 index migration is the precedent.
