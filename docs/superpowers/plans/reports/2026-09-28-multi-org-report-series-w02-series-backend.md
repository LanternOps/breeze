---
tracking_issue: LanternOps/breeze#7438
spec: docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md
index: docs/superpowers/plans/reports/2026-09-28-multi-org-report-series-INDEX.md
wave: W02 — Series backend (one PR)
blast_radius: high (two new tenant tables + RLS, constraint triggers, reports columns, org merge executor, cascade/export registration, schedule worker, child-writer refusals)
written_against: main 92764125ed + spec commit e9ac8b6e22 (branch reports-org-assignment)
---

# Multi-org Report Series W02: Series Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read [`2026-09-28-multi-org-report-series-INDEX.md`](2026-09-28-multi-org-report-series-INDEX.md) (same directory) and the spec first.** The INDEX holds the global constraints and the fixed cross-wave names; this plan uses them verbatim.

**Goal:** Ship the API-complete backend for "one report per organization": the partner-axis `report_series` parent, the org-axis `report_series_org_targets`, ordinary org-owned child `reports` rows materialized by a reconciler (transactionally on every series write + a repair sweep on the 5-minute `check-schedules` tick), a worker gate, owner authority, rule-based recipients with per-org add/remove overrides, the `/reports/series` routes, and `series_managed` refusals on every other child writer.

**Architecture:** A series never executes. It owns a definition; `services/reportSeries/reconcile.ts` makes exactly one active org-owned `reports` child per eligible targeted org (partial unique index backstop), archiving — never deleting — children that fall out of the target set. Children run through the existing schedule worker unchanged, behind one extra gate (`seriesChildGate`) that re-checks enabled/targeted/owner/revision before generating. Each child's execution scope is captured from the series owner for that child's own org (`resolveLiveReportAuthority`), so the existing live re-authorization path keeps working and a child can never run under system or substitute authority. Partner-owned `reports` rows keep meaning "combined aggregate" and are never touched (CHECK + no `partner_id` predicate anywhere).

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, BullMQ, Vitest (unit, RLS-coverage, integration against real Postgres as `breeze_app`), the tenancy contract in `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md` — §2 (D1–D6), §3.1–§3.6, §4 W02 row, §5 W02 tests.

**Depends on:** W01 merged (`report_runs.delivery_status` / `recipient_count`, `ReportDeliveryStatus` in `apps/api/src/services/reportDelivery.ts`, the worker's delivery-status write, `orgName` on both lists). Rebase on `origin/main` before Task 1. W03 consumes everything this wave produces.

---

## Contract concerns (read before executing; each is a deliberate decision, raise it in the PR)

1. **`ExecutionScopeColumns` does not exist.** The INDEX names it in `captureChildExecutionScope`'s return type. The real type is `PersistedSiteScopeColumns` (`services/siteScope.ts:101`). Task 4 exports `type ExecutionScopeColumns = PersistedSiteScopeColumns` from `authority.ts` so the INDEX name compiles.
2. **Org merge does NOT re-home the losing child's runs (spec §3.2 says it does).** `service_deliverable_evidence` carries `sd_evidence_report_run_fk (report_run_id, report_id) → report_runs(id, report_id) ON DELETE CASCADE` (`migrations/2026-10-15-170000-service-deliverables.sql:170-173`) — NOT deferrable and with no `ON UPDATE` action. `UPDATE report_runs SET report_id = <survivor child>` on any evidence-linked run therefore aborts the whole merge with 23503, and `SET CONSTRAINTS ALL DEFERRED` cannot help. Series children are ordinary org reports, so their runs can be evidence. Task 12 instead **archives the loser's colliding active child in place** (it leaves the partial unique index and repoints into the survivor org with its runs, evidence and history untouched), and unions its recipient overrides onto the survivor's child with removes winning. "Survivor keeps its row", "runs are never deleted", "removes win", "no 23505/23503" all still hold. **Follow-up to file:** the existing narrative / portal / fleet-design passes (`rehomeReportChildrenThenDelete`) have the same latent 23503 on an evidence-linked run (portal self-service definitions include the managed-evidence definitions).
3. **Managed-evidence types are refused as series types, literally per spec** (`threat_detection_review`, `endpoint_management_review`, `vulnerability_management`, `identity_access_review` — `execution: 'managed_evidence'` in the registry). These types also have ordinary user-authored definitions, so the rule may be broader than intended. Kept (loosening later is a one-line change; tightening after children exist is not).
4. **Error codes beyond the INDEX list** (all thrown as `ReportSeriesError` and mapped by `seriesErrorResponse`; W03 must handle them): `series_write_denied` (403, caller is not a partner-scope `org_access='all'` user), `series_target_org_inaccessible` (400), `report_not_series_child` (409, detach on a non-child or an archived child), `recipient_mode_requires_series` (400, a `remove` override on an ordinary report). The delivery gate answers `recipients_need_export_and_mfa` (403) on series routes; `core.ts` keeps its existing sentence-shaped body unchanged.
4a. **`callerMaySetEmailRecipients` takes the permission set as a second argument.** The INDEX writes `callerMaySetEmailRecipients(auth)`, but the resolved permission set is not on `AuthContext` — `requirePermission` stores it as `c.get('permissions')` (`middleware/auth.ts:1002`), which is exactly what today's `recipientExportGateFails(config, permissions, auth)` reads. Task 8 exports `callerMaySetEmailRecipients(auth: Pick<AuthContext, 'token'>, permissions: UserPermissions | undefined): boolean`.
4b. **"Adds a delivery" is decided in the store, against the locked current row** (server-derived, never from the body): the route passes `mayAddDelivery = callerMaySetEmailRecipients(auth, permissions)` and the store throws 403 only when the write actually widens delivery (create with a CC or an active rule; PATCH adding a CC address, turning `primaryContact` on, or adding a role; a targets change that newly targets an org while a rule or CC is active). Detach and transfer-owner never widen delivery and are not gated.
4c. **Response shapes (adopted from the coordinator's W03 contract):** `GET /reports/series` → `{ data: SeriesDetail[] }`; `GET /:id`, `POST /`, `PATCH /:id`, `PUT /:id/targets` → a bare `SeriesDetail` (`{ series, targets, orgs }`). Additions this plan makes, stated explicitly: `POST /:id/transfer-owner` also answers a bare `SeriesDetail`; `DELETE /:id` answers `{ success: true, archivedChildren: number }`; the reconcile counts go to the audit log, not the response. Recipient override `POST /reports/:id/recipients` takes `{ contactId, mode? }` and `GET /reports/:id/recipients` rows carry `mode`.
5. **`POST /reports/series/recipients/preview` accepts an optional `internalCc`** in addition to the INDEX body `{ targetMode, orgIds, recipientRule }`, so the preview's "no recipients at all" count matches what the saved series would do.
6. **W01 seam in the worker.** Task 9 swaps W01's `resolveScheduledReportRecipientSets(...)` call in the delivery tail (and the final-attempt notice) for `resolveRunRecipientSets(...)`, which returns W01's `ScheduledRecipientSets` shape. Written against W01's PLAN (its Tasks 2–3), not merged code; if W01 merged different names, keep the behaviour (series child: customer = rule ∪ adds − removes, cc = internal CC, `recipient_count = customer.length`). `resolveSeriesChildRecipients` also returns `dropped` (additive to the INDEX signature) so W01's 'partial' rule sees series drops.
7. **Detach does more than "clear `series_id`".** It also (a) un-targets the org (an exclusion row in `all` mode / deletes the inclusion row in `selected` mode) — otherwise the next reconcile mints a second child for the same org; and (b) materializes the org's current rule matches as `add` override rows and drops `remove` rows — otherwise the detached report silently stops mailing the rule-matched customers, and a leftover `remove` row would be read as a recipient by the ordinary resolver. No series revision bump (spec: "bumps nothing on the series").
8. **Children of a disabled series are excluded from `findDueReports`** (spec §3.3 names only archived rows). Without it every occurrence of a disabled series would enqueue a job whose only effect is a recorded skip row per org.
9. **`report_series.schedule` excludes `one_time`** (CHECK + zod) — a one-time series never runs.
10. **`owner_user_id` / `created_by` are nullable `ON DELETE SET NULL`.** `users` is in the org cascade set, so a `NO ACTION` edge fails `orgCascadeFkOnDelete.integration.test.ts`. A NULL owner blocks every child (never a system fallback, spec §3.4).
11. **Extra database guards beyond spec §3.2** (all `DEFERRABLE INITIALLY IMMEDIATE`): `organizations_partner_report_series_guard` (an org cannot change partner while a series of the old partner targets it or owns its child — precedent `organizations_partner_config_policy_guard`), `report_series_partner_immutable`, and a `BEFORE DELETE` trigger on `report_series` that archives every child. The last is load-bearing: a partner request context cannot see (RLS) children in out-of-service orgs, so an app-only archive would leave them as active standalone reports after `series_id` goes NULL.
12. **The spec CHECK is widened** to `series_id IS NULL OR (org_id IS NOT NULL AND portal_self_service = false AND source_ai_agent_schedule_id IS NULL)` so a child can never also be the portal's definition or a narrative definition.
13. **Blocked children are not polled by the repair sweep.** The sweep reconciles only series with structural drift (a targeted org without an active child, a stale revision, an active child of an untargeted org). A child blocked for lack of owner authority is re-captured on the next series write, `transfer-owner`, or worker gate — never by a background authority poll every 5 minutes.

## Decisions made in this plan (no quorum needed; noted for review)

- **`mode='remove'` exists only on series children.** `POST /reports/:id/recipients` refuses `mode:'remove'` on an ordinary report (400). `resolveScheduledReportRecipients` additionally filters `mode = 'add'` (every existing row is `add`, so it is byte-for-byte today's result; the filter is a belt for any `remove` row that outlives its series).
- **A new child is immediately due for the latest occurrence**, exactly like a newly created standalone report (`isDue(null, …) === true` in `packages/shared/src/utils/reportSchedule.ts:126`). Creating a monthly series on the 28th mails that month's report to every targeted org at the next tick. Same behaviour as creating the reports one by one today.
- **Series reads are gated like writes** (partner scope + `canManagePartnerWidePolicies`). A 'selected' partner user still sees the children of their own orgs in `GET /reports` (with `seriesId`/`seriesName`), just not the series itself.
- **`services/reportSeries/store.ts`** (not in the INDEX file list) holds the series CRUD so the route file stays thin and every mutation is integration-tested against real Postgres. It adds functions; it changes no INDEX signature.
- **MCP coverage:** `routes/reports/series.ts` is registered as `{ tools: ['generate_report'] }` (the tool lists and runs series children; "tools indicate an existing surface, not parity" — `services/mcpCoverage.ts:3`). A series management tool is a follow-up, not a frozen gap (new gaps fail `mcp-coverage.test.ts`).

---

## Global Constraints

- **Every spec decision stands** (§2 D1–D6). D6: `report_series` is partner-only, `partner_id NOT NULL`, shape 3, in `PARTNER_TENANT_TABLES` and no other allowlist. The PR states the Partner-Wide-First exception.
- **Partner-owned `reports` rows (`org_id NULL`) are untouched.** No series code path builds a `reports.partner_id` predicate (the `partnerOwnedVisibility.scan.test.ts` `PARTNER_ID_PREDICATE_SITES` list does not grow). `reports_series_child_shape_chk` makes a partner-owned child unconstructible.
- **Series types:** refuse `PARTNER_ONLY_DELIVERY_REPORT_TYPES` (business), system-authored (`ai_org_narrative`, `ai_fleet_design`), managed-evidence and any `msp_staff`/org-unsupported type → 400 `series_type_unsupported`. A config naming sites, devices or groups → 400 `series_config_org_specific`.
- **Write gate for every series mutation:** `reports:write` AND `auth.scope === 'partner'` AND `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts:25`). `partner_id` always comes from the token.
- **Children:** org-owned; at most one active child per `(org_id, series_id)`; only recipient add/remove and Detach mutate a child outside the reconciler; every other writer answers 409 `series_managed`. **The reconciler is the only writer of a child's shared fields** (name, type, format, schedule, config, `series_revision`, execution scope).
- **Revision sentinel (INDEX):** `report_series.revision` starts at 1; `reports.series_revision = 0` means "created/adopted, never reconciled" (W04 adopts at 0). The CHECK allows `>= 0`; `reconcileSeries`, `seriesChildGate` and the sweep's drift query all treat any `series_revision <> report_series.revision` (0 included) as stale.
- **Errors:** every service in `services/reportSeries/` throws `ReportSeriesError(code, status, body?)` (`services/reportSeries/errors.ts`, INDEX signature); routes map it through the one function `seriesErrorResponse(c, err)` (`routes/reports/seriesErrors.ts`).
- **Recipient delivery gate (INDEX):** `RECIPIENTS_NEED_EXPORT_AND_MFA` and the export+MFA check move from `core.ts` to `routes/reports/recipientGate.ts` (`callerMaySetEmailRecipients`), byte-for-byte behaviour in `core.ts`. It applies to every series write that ADDS a delivery and to a `mode:'add'` override on a series child — server-derived, never read from the body (Contract concern 4b).
- **`recipient_count` (INDEX ruling):** a series child counts the customer set only (rule ∪ adds − removes), `internal_cc` excluded; a non-series report keeps W01's count (contacts ∪ `config.emailRecipients`).
- **Archive, never delete** on exclusion, org ineligibility and series delete. Eligible orgs: `status IN ('active','trial') AND deleted_at IS NULL` (`SERIES_ELIGIBLE_ORG_STATUSES`, pinned equal to `isUsableOrgStatus`).
- **Never run a child with substitute or system authority.** No owner / ineligible owner / no reach into the org ⇒ `blocked_no_authority` (all-NULL execution scope on the row; the worker's `completeExecutableScope` never polls it).
- **Existing behaviour is byte-for-byte unchanged for non-series rows.** Every new predicate is either scoped to `series_id IS NOT NULL` or is true for every existing row (`archived_at IS NULL`, `mode = 'add'`).
- **Migration names:** `apps/api/migrations/2026-11-09-110000-report-series.sql` and `apps/api/migrations/2026-11-09-110100-reports-series-children.sql`. Before committing run `ls apps/api/migrations | sort | tail -1`; both names must sort after it and after W01's `2026-11-09-100000-…`. If main moved past, bump BOTH (keep the `-110000`/`-110100` pair). Never touch the closed `2026-08-06` block. Idempotent (`IF NOT EXISTS` / `DO $$` / `CREATE OR REPLACE` / `DROP … IF EXISTS` then create). No `BEGIN`/`COMMIT`. **No rows written** — the trigger bodies are routine definitions, which `migrationRlsScope.test.ts` blanks; never add to its baseline.
- **Composite / org-referencing constraint triggers are `DEFERRABLE INITIALLY IMMEDIATE`** (org merge runs `SET CONSTRAINTS ALL DEFERRED`, `services/orgMerge.ts:1068`). Trigger bodies that read across tenants elevate `breeze.scope` and restore it (precedent `migrations/2026-07-27-a-feature-policy-reference-ownership.sql:367-374`).
- **Tests.** API unit: `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Real-DB suites need `pnpm test-stack up` from the worktree root (and `pnpm test-stack down` when done). Integration: `pnpm --filter=@breeze/api test:integration <path>` (script `vitest run --config vitest.integration.config.ts`, `apps/api/package.json:40`). RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
- **Mechanical contracts this wave trips** (all in **Test API** unless noted): `partnerOwnedVisibility.scan.test.ts` (every new `reports`/`reportRuns` query site needs an allowlist entry with an exact pinned count), `partner-wide-write-coverage.test.ts` (every file mutating `reports`/`report_series` mentions `canManagePartnerWidePolicies` or is allowlisted), `mcp-coverage.test.ts` (new route file), `siteScope.projections.test.ts` (any literal naming `executionScopeCapturedAt:` must also name `executionScopePrincipalKind:`), `reportScheduleWorker.contract.test.ts` (keep `(WORKER_EXCLUDED_REPORT_TYPES as readonly string[]).includes(report.type)` and `notInArray(reports.type, [...WORKER_EXCLUDED_REPORT_TYPES])` textually intact), `orgMerge.test.ts` (full unit run only). Integration-only: `rls-coverage`, `tenantCascade.integration`, `orgMergeRegistry.integration`, `orgCascadeFkOnDelete.integration`, `tenant-export-policy.integration`, `tenantExportErasureRoundtrip.integration`, `orgLifecycleFoundations.integration` (merge contract).
- **Commit after every task.** Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push until Task 13.

---

## Review Focus

The five inputs the spec implies but its test list does not exercise, most likely first. Each is pinned by a named test in the owning task.

1. **Detach in `all` mode followed by the next sweep.** A person expects the detached report to be the org's only copy; without un-targeting, the reconciler mints a fresh child and the customer gets the report twice. → Task 7 store integration case `detach bookkeeping un-targets the org so the next sweep does not mint a second child` + Task 10 route case `clears series_id + series_revision, hands off to finishDetach, and audits`.
2. **Detach when the child relied on the recipient rule / carried `remove` overrides.** A person expects the same customers to keep receiving it; without materialization the standalone report mails nobody (rule is gone) or mails the contacts the MSP explicitly removed. → Task 5 integration case `turns current rule matches into add rows, keeps explicit adds, and drops remove rows` + Task 9 case `resolveScheduledReportRecipients reads only mode = 'add' rows`.
3. **Series deleted while one of its orgs is suspended.** RLS hides that org from the partner request, so an app-only archive misses its child; after `series_id` goes NULL the child would be an active standalone report that restarts when the org is reactivated. → Task 1 `deleting a series archives children the caller cannot see`.
4. **Owner demoted from `org_access='all'` to `'selected'` that still covers the org.** The per-org live check (`resolveLiveReportAuthority`) still passes, so without the gate's partner-level owner check the child keeps running on a principal that may no longer own partner-wide state. → Task 4 `refuses when the live partner authority says partner_access_not_all` + Task 6 gate case `owner demoted to 'selected' still covering the org → blocked_no_authority`.
5. **One series throws during the repair sweep.** A person expects every other series (and every ordinary scheduled report on that tick) to still be processed. → Task 6 unit case `isolates a failing series: the rest still reconcile and the sweep resolves` + Task 9 case `still scans due reports when the sweep rejects`.

---

## File map

| File | Change | Task |
|---|---|---|
| `apps/api/migrations/2026-11-09-110000-report-series.sql` | create — `report_series`, `report_series_org_targets`, RLS, target same-partner + partner-immutable triggers | 1 |
| `apps/api/migrations/2026-11-09-110100-reports-series-children.sql` | create — `reports.series_id/series_revision/archived_at`, CHECKs, partial unique, child same-partner trigger, org partner-move guard, archive-on-delete trigger, `report_schedule_recipients.mode` | 1 |
| `apps/api/src/db/schema/reports.ts` | `reportSeries`, `reportSeriesOrgTargets`, three `reports` columns + indexes, `reportScheduleRecipients.mode` | 1 |
| `apps/api/src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts` | create | 1 |
| `apps/api/src/services/tenantCascade.ts` | `report_series_org_targets` in `CORE_ORG_CASCADE_DELETE_ORDER` | 2 |
| `apps/api/src/services/orgMergeRegistry.ts` | `report_series_org_targets` repoint-dedupe; `reports` note | 2 |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | new columns on `reports`, `report_schedule_recipients`; new `report_series_org_targets` | 2 |
| `apps/api/src/services/tenantExportPolicyReportSeries.test.ts` | create | 2 |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `report_series` in `PARTNER_TENANT_TABLES` | 2 |
| `apps/api/src/services/reportSeries/errors.ts` (+ `.test.ts`) | create — `ReportSeriesError` (INDEX) | 3 |
| `apps/api/src/services/reportSeries/types.ts` (+ `.test.ts`) | create | 3 |
| `apps/api/src/services/reportSeries/validation.ts` (+ `.test.ts`) | create | 3 |
| `apps/api/src/services/reportConfigSchemas.ts` | export `selectsSomething` | 3 |
| `apps/api/src/services/reportSeries/authority.ts` (+ `.test.ts`) | create | 4 |
| `apps/api/src/services/reportSeries/targets.ts` (+ `.test.ts`) | create | 5 |
| `apps/api/src/services/reportSeries/recipients.ts` (+ `.test.ts`) | create | 5 |
| `apps/api/src/__tests__/integration/reportSeriesRecipients.integration.test.ts` | create — targets eligibility, rule/override resolution, detach materialization | 5 |
| `apps/api/src/services/reportSeries/reconcile.ts` (+ `.test.ts`) | create | 6 |
| `apps/api/src/__tests__/integration/reportSeriesReconcile.integration.test.ts` | create | 6 |
| `apps/api/src/services/reportSeries/store.ts` (+ `.test.ts`) | create | 7 |
| `apps/api/src/__tests__/integration/reportSeriesStore.integration.test.ts` | create | 7 |
| `apps/api/src/routes/reports/recipientGate.ts` (+ `.test.ts`) | create — extracted `RECIPIENTS_NEED_EXPORT_AND_MFA` + `callerMaySetEmailRecipients` (INDEX) | 8 |
| `apps/api/src/routes/reports/seriesErrors.ts` | create — `seriesErrorResponse(c, err)` (INDEX) | 8 |
| `apps/api/src/routes/reports/seriesSchemas.ts` | create | 8 |
| `apps/api/src/routes/reports/series.ts` (+ `series.test.ts`) | create | 8 |
| `apps/api/src/routes/reports/index.ts` | mount `/series` first | 8 |
| `apps/api/src/services/mcpCoverage.ts` | `reports/series.ts` entry | 8 |
| `apps/api/src/jobs/reportScheduleWorker.ts` | `findDueReports`, gate, `resolveRunRecipientSets`, sweep, `mode='add'` filter | 9 |
| `apps/api/src/jobs/reportScheduleWorker.series.test.ts` | create | 9 |
| `apps/api/src/jobs/reportScheduleWorker.due.test.ts`, `reportScheduleWorker.test.ts` | new cases / mock additions | 9 |
| `apps/api/src/routes/reports/helpers.ts` | projection gains `seriesId`, `archivedAt` | 10 |
| `apps/api/src/routes/reports/core.ts` | PUT/reauthorize/DELETE refusal, `POST /:id/detach`, list filters + `seriesName`, templates archived filter, `'series'` in the `/:id` guard list | 10, 11 |
| `apps/api/src/routes/reports/recipients.ts` (+ `recipients.test.ts`) | `mode`, convert refusal | 10 |
| `apps/api/src/routes/reports/schemas.ts` | `listReportsSchema.series/includeArchived`, `addReportRecipientSchema.mode` | 10, 11 |
| `apps/api/src/routes/reports/runs.ts` | `GET /runs` + `seriesId`, `seriesName` | 11 |
| `apps/api/src/services/aiToolsFleet.ts` (+ `aiToolsFleet.reportAudience.test.ts`) | update/delete refuse series children | 10 |
| `apps/api/src/routes/reports/core.partnerOwned.test.ts` | series-child + list cases (existing harness) | 10, 11 |
| `apps/api/src/services/orgMergeCustomExecutors.ts` | series pass in `mergeReports` | 12 |
| `apps/api/src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts` | create | 12 |
| `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` | allowlist entries | 6, 7, 9, 12 |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | `services/reportSeries/reconcile.ts` entry | 6 |

**Call-site decision table — every writer of `reports` at HEAD** (`grep -rnE "\.(update\|insert\|delete)\(\s*reports\s*\)\|UPDATE reports\|INSERT INTO reports\|DELETE FROM reports" apps/api/src`):

| Site | What it writes | Decision |
|---|---|---|
| `routes/reports/core.ts:624,706` POST `/` | new row | unaffected (never sets `series_id`) |
| `routes/reports/core.ts:813` PUT `/:id` | shared fields | **409 `series_managed`** (Task 10) |
| `routes/reports/core.ts:912` POST `/:id/reauthorize` | execution scope | **409 `series_managed`** — the child's scope belongs to the series owner (Task 10) |
| `routes/reports/core.ts:995` DELETE `/:id` | delete | **409 `series_managed`** (exclude or detach instead) (Task 10) |
| `routes/reports/recipients.ts:291` `/recipients/convert` | `config.emailRecipients` = the series internal CC | **409 `series_managed`** on a child (Task 10) |
| `routes/reports/runs.ts:229` POST `/:id/generate` | `last_generated_at` | allowed ("Run now (this org)") |
| `jobs/reportScheduleWorker.ts:325,765` | `last_generated_at` | allowed (scheduling bookkeeping) |
| `services/aiToolsFleet.ts:3072` generate | `last_generated_at` | allowed |
| `services/aiToolsFleet.ts:3210` create | new row | unaffected |
| `services/aiToolsFleet.ts:3240` update, `:3263` delete | shared fields / delete | **refuse `series_managed`** + `series_id IS NULL` in the WHERE (Task 10) |
| `services/portal/reportsSelfService.ts:188,645` | portal definitions | unaffected (`reports_series_child_shape_chk` forbids `portal_self_service` on a child) |
| `services/managedEvidenceDefinitions.ts:88` | managed evidence definition | unaffected (portal_self_service = true, never a child) |
| `services/aiAgents/narrativeReport.ts:254,361`, `fleetDesignReport.ts:185,279` | system-authored definitions | unaffected (types refused as series types; CHECK forbids narrative children) |
| `services/orgMergeCustomExecutors.ts:1439` + `buildRepoint('reports')` | merge | series pass added (Task 12) |
| `services/tenantCascade.ts` org erasure | delete | unaffected (children are org rows; `report_series` goes with the partner sweep) |
| W04 `services/reportSeries/combine.ts` | adoption | future — writes through the reconciler's shared-field helper |

---
### Task 1: Migrations, Drizzle schema, and the tenancy proof suite

**Files:**
- Create: `apps/api/migrations/2026-11-09-110000-report-series.sql`
- Create: `apps/api/migrations/2026-11-09-110100-reports-series-children.sql`
- Modify: `apps/api/src/db/schema/reports.ts` (new tables above `reports`; three `reports` columns + two indexes; `reportScheduleRecipients.mode`)
- Test: `apps/api/src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts` (create); existing `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`

**Interfaces:**
- Produces (DB): tables `report_series`, `report_series_org_targets`; columns `reports.series_id`, `reports.series_revision`, `reports.archived_at`, `report_schedule_recipients.mode`; constraints `report_series_target_mode_chk`, `report_series_schedule_recurring_chk`, `reports_series_child_shape_chk`, `reports_series_revision_present_chk`, `report_schedule_recipients_mode_chk`; unique `report_series_org_targets_series_org_uniq`, partial unique `reports_series_active_child_uniq`; constraint triggers `report_series_org_targets_same_partner`, `reports_series_child_same_partner`, `report_series_partner_immutable`, `organizations_partner_report_series_guard`; trigger `report_series_archive_children_before_delete`.
- Produces (Drizzle, `db/schema/reports.ts`, re-exported by `db/schema/index.ts:27`): `reportSeries`, `reportSeriesOrgTargets`, `reports.seriesId|seriesRevision|archivedAt`, `reportScheduleRecipients.mode` (`'add' | 'remove'`).

- [ ] **Step 1: Write the failing tenancy suite**

Create `apps/api/src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts`. It runs through the real postgres.js driver as the forced-RLS `breeze_app` role (precedent: `reportsPartnerRls.integration.test.ts`, `workTypesPartnerRls.integration.test.ts`). The shared setup truncates tenant tables with CASCADE before every test.

```ts
/**
 * Multi-org report series W02 — tenancy proof (spec §5 W02).
 *
 * Migrations under test: 2026-11-09-110000-report-series.sql and
 * 2026-11-09-110100-reports-series-children.sql.
 *
 * report_series is partner-axis (shape 3): breeze_has_partner_access only, so
 * an ORG token of the same partner reads nothing. report_series_org_targets is
 * shape 1 (breeze_has_org_access). The same-partner constraint triggers are
 * the only thing standing between a target/child row and another partner's
 * series — FK checks bypass RLS — so each is forged here, and each is proven
 * DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL DEFERRED).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { createOrganization, createPartner } from './db-utils';

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

/** An org token DOES carry its partner in currentPartnerId — that is the trap. */
function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId,
    userId: null,
  };
}

function system<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn);
}

async function rows<T>(ctx: DbAccessContext | null, query: SQL): Promise<T[]> {
  const run = () => db.execute(query) as unknown as Promise<T[]>;
  return ctx ? withDbAccessContext(ctx, run) : system(run);
}

/** SQLSTATE of a driver error, whether or not Drizzle wrapped it. */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}
function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  return e?.cause?.constraint_name ?? e?.constraint_name;
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to fail');
}

async function seedTenancy() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  return {
    partnerA: partnerA.id,
    partnerB: partnerB.id,
    orgA1: orgA1.id,
    orgA2: orgA2.id,
    orgB1: orgB1.id,
  };
}

async function insertSeries(partnerId: string, ctx: DbAccessContext | null = null): Promise<string> {
  const id = randomUUID();
  await rows(ctx, sql`
    INSERT INTO report_series (id, partner_id, name, type, schedule)
    VALUES (${id}, ${partnerId}, 'Monthly summary', 'executive_summary', 'monthly')
  `);
  return id;
}

async function insertChild(orgId: string, seriesId: string | null, archived = false): Promise<string> {
  const id = randomUUID();
  await rows(null, sql`
    INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision, archived_at)
    VALUES (${id}, ${orgId}, 'Monthly summary', 'executive_summary', 'monthly',
            ${seriesId}, ${seriesId ? 1 : null}, ${archived ? sql`now()` : null})
  `);
  return id;
}

describe('report_series (shape 3, partner axis)', () => {
  it('ENABLE and FORCE row level security are on for both new tables', async () => {
    const flags = await rows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(null, sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('report_series', 'report_series_org_targets') ORDER BY relname
    `);
    expect(flags).toEqual([
      { relname: 'report_series', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'report_series_org_targets', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('a partner context inserts and reads its own series', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA, partnerContext(t.partnerA, [t.orgA1, t.orgA2]));
    const read = await rows<{ id: string }>(partnerContext(t.partnerA, []), sql`SELECT id FROM report_series WHERE id = ${id}`);
    expect(read).toEqual([{ id }]);
  });

  it('FORGE: partner B cannot insert a series attributed to partner A (42501)', async () => {
    const t = await seedTenancy();
    const err = await failure(insertSeries(t.partnerA, partnerContext(t.partnerB, [t.orgB1])));
    expect(sqlState(err)).toBe('42501');
  });

  it('FORGE: partner B reads zero rows of partner A (with a system control)', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA);
    expect(await rows(null, sql`SELECT id FROM report_series WHERE id = ${id}`)).toHaveLength(1);
    expect(await rows(partnerContext(t.partnerB, [t.orgB1]), sql`SELECT id FROM report_series WHERE id = ${id}`)).toHaveLength(0);
  });

  it('FORGE: an ORG token of the same partner cannot read report_series', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA);
    expect(await rows(partnerContext(t.partnerA, []), sql`SELECT id FROM report_series WHERE id = ${id}`)).toHaveLength(1);
    expect(await rows(orgContext(t.orgA1, t.partnerA), sql`SELECT id FROM report_series WHERE partner_id = ${t.partnerA}`)).toHaveLength(0);
  });

  it('partner_id is immutable (report_series_partner_immutable)', async () => {
    const t = await seedTenancy();
    const id = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`UPDATE report_series SET partner_id = ${t.partnerB} WHERE id = ${id}`));
    expect(sqlState(err)).toBe('23514');
    expect(constraintOf(err)).toBe('report_series_partner_immutable');
  });

  it('refuses a one_time schedule and an unknown target mode', async () => {
    const t = await seedTenancy();
    const oneTime = await failure(rows(null, sql`
      INSERT INTO report_series (partner_id, name, type, schedule)
      VALUES (${t.partnerA}, 'x', 'executive_summary', 'one_time')`));
    expect(constraintOf(oneTime)).toBe('report_series_schedule_recurring_chk');
    const mode = await failure(rows(null, sql`
      INSERT INTO report_series (partner_id, name, type, schedule, target_mode)
      VALUES (${t.partnerA}, 'x', 'executive_summary', 'monthly', 'some')`));
    expect(constraintOf(mode)).toBe('report_series_target_mode_chk');
  });
});

describe('report_series_org_targets (shape 1) and the same-partner trigger', () => {
  it('FORGE: partner B cannot insert a target row for partner A\'s org (42501)', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(partnerContext(t.partnerB, [t.orgB1]), sql`
      INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgA1})`));
    expect(sqlState(err)).toBe('42501');
  });

  it('FORGE: a target naming another partner\'s org is rejected by the trigger (23514), even in system context', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`
      INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgB1})`));
    expect(sqlState(err)).toBe('23514');
    expect(constraintOf(err)).toBe('report_series_org_targets_same_partner');
  });

  it('the trigger is deferrable: a cross-partner target fails at COMMIT, not at the INSERT, under SET CONSTRAINTS ALL DEFERRED', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    let insertReturned = false;
    const err = await failure(system(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgB1})`);
      insertReturned = true;
    }));
    expect(insertReturned).toBe(true);
    expect(sqlState(err)).toBe('23514');
  });

  it('every new constraint trigger is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const triggers = await rows<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(null, sql`
      SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
       WHERE tgname IN ('report_series_org_targets_same_partner', 'reports_series_child_same_partner',
                        'report_series_partner_immutable', 'organizations_partner_report_series_guard')
       ORDER BY tgname`);
    expect(triggers).toEqual([
      { tgname: 'organizations_partner_report_series_guard', tgdeferrable: true, tginitdeferred: false },
      { tgname: 'report_series_org_targets_same_partner', tgdeferrable: true, tginitdeferred: false },
      { tgname: 'report_series_partner_immutable', tgdeferrable: true, tginitdeferred: false },
      { tgname: 'reports_series_child_same_partner', tgdeferrable: true, tginitdeferred: false },
    ]);
  });

  it('an org cannot move to another partner while a series of its old partner targets it', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await rows(null, sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgA1})`);
    const err = await failure(rows(null, sql`UPDATE organizations SET partner_id = ${t.partnerB} WHERE id = ${t.orgA1}`));
    expect(constraintOf(err)).toBe('organizations_partner_report_series_guard');
  });
});

describe('reports series columns', () => {
  it('FORGE: a child whose org belongs to another partner is rejected (reports_series_child_same_partner)', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(insertChild(t.orgB1, series));
    expect(sqlState(err)).toBe('23514');
    expect(constraintOf(err)).toBe('reports_series_child_same_partner');
  });

  it('a partner-owned (org_id NULL) row can never carry series_id', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`
      INSERT INTO reports (partner_id, org_id, name, type, schedule, series_id, series_revision)
      VALUES (${t.partnerA}, NULL, 'Aggregate', 'ar_aging', 'monthly', ${series}, 1)`));
    expect(constraintOf(err)).toBe('reports_series_child_shape_chk');
  });

  it('a series child can never be the portal self-service definition', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const err = await failure(rows(null, sql`
      INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision, portal_self_service)
      VALUES (${t.orgA1}, 'x', 'executive_summary', 'monthly', ${series}, 1, true)`));
    expect(constraintOf(err)).toBe('reports_series_child_shape_chk');
  });

  it('one ACTIVE child per (org, series); archived siblings are allowed', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await insertChild(t.orgA1, series, true);
    await insertChild(t.orgA1, series);
    const err = await failure(insertChild(t.orgA1, series));
    expect(sqlState(err)).toBe('23505');
    expect(constraintOf(err)).toBe('reports_series_active_child_uniq');
  });

  it('series_revision 0 (never-reconciled sentinel) is allowed; NULL on a child and negatives are not', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await rows(null, sql`
      INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision)
      VALUES (${t.orgA1}, 'x', 'executive_summary', 'monthly', ${series}, 0)`);
    const missing = await failure(rows(null, sql`
      INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision)
      VALUES (${t.orgA2}, 'x', 'executive_summary', 'monthly', ${series}, NULL)`));
    expect(constraintOf(missing)).toBe('reports_series_revision_present_chk');
  });

  it('report_schedule_recipients.mode defaults to add and refuses anything but add/remove', async () => {
    const cols = await rows<{ column_default: string; is_nullable: string }>(null, sql`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'report_schedule_recipients' AND column_name = 'mode'`);
    expect(cols).toEqual([{ column_default: "'add'::text", is_nullable: 'NO' }]);
    const check = await rows<{ def: string }>(null, sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'report_schedule_recipients_mode_chk'`);
    expect(check[0]?.def).toMatch(/'add'.*'remove'/);
  });

  it('an ORG token reads its own child and that child\'s runs, but not the series', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const child = await insertChild(t.orgA1, series);
    const runId = randomUUID();
    await rows(null, sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${child}, 'completed')`);
    const org = orgContext(t.orgA1, t.partnerA);
    expect(await rows(org, sql`SELECT id FROM reports WHERE id = ${child}`)).toEqual([{ id: child }]);
    expect(await rows(org, sql`SELECT id FROM report_runs WHERE id = ${runId}`)).toEqual([{ id: runId }]);
    expect(await rows(org, sql`SELECT id FROM report_series WHERE id = ${series}`)).toHaveLength(0);
  });

  // Review Focus 3.
  it('deleting a series archives children the caller cannot see (out-of-service org) and SET NULLs series_id', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    const visible = await insertChild(t.orgA1, series);
    const hidden = await insertChild(t.orgA2, series);
    const runId = randomUUID();
    await rows(null, sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${hidden}, 'completed')`);
    await rows(null, sql`UPDATE organizations SET status = 'suspended' WHERE id = ${t.orgA2}`);

    // The partner request context only sees active/trial orgs (orgA2 is absent).
    const ctx = partnerContext(t.partnerA, [t.orgA1]);
    expect(await rows(ctx, sql`SELECT id FROM reports WHERE id = ${hidden}`)).toHaveLength(0);
    await rows(ctx, sql`DELETE FROM report_series WHERE id = ${series}`);

    const after = await rows<{ id: string; series_id: string | null; archived: boolean }>(null, sql`
      SELECT id, series_id, archived_at IS NOT NULL AS archived FROM reports
       WHERE id IN (${visible}, ${hidden}) ORDER BY id`);
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.series_id).toBeNull();
      expect(row.archived).toBe(true);
    }
    expect(await rows(null, sql`SELECT id FROM report_runs WHERE id = ${runId}`)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test-stack up` (worktree root), then `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts`
Expected: FAIL — every case errors with `relation "report_series" does not exist` (42P01) or `column "series_id" of relation "reports" does not exist`.

- [ ] **Step 3: Write the table migration**

Create `apps/api/migrations/2026-11-09-110000-report-series.sql`:

```sql
-- Multi-org report series W02
-- (docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md §3.2).
--
-- report_series: ONE partner-owned definition that fans out into one ordinary
-- org-owned `reports` child per targeted organization (spec D1). It never
-- executes; services/reportSeries/reconcile.ts materializes the children.
--
-- TENANCY: shape 3 (partner axis), partner_id NOT NULL. This is the spec D6
-- exception to Partner-Wide-First: single-org definitions already live in
-- `reports`, and a one-org series is "Chosen orgs: [X]". Policy copied from
-- 2026-10-21-100000-work-types.sql (system OR breeze_has_partner_access). Its
-- only allowlist is PARTNER_TENANT_TABLES. No org_id, so no org cascade, merge
-- or export entry; partner erasure discovers it from its partner_id column
-- (tenantCascade.ts cascadeDeletePartner information_schema sweep).
--
-- report_series_org_targets: shape 1 (direct org_id), auto-discovered by the
-- RLS coverage contract. In target_mode 'all' a row is an EXCLUSION; in
-- 'selected' it is an INCLUSION. Registered in CORE_ORG_CASCADE_DELETE_ORDER,
-- orgMergeRegistry (repoint-dedupe on series_id) and CORE_TENANT_EXPORT_POLICY
-- in the same PR.
--
-- users FKs are ON DELETE SET NULL: `users` is in the org cascade set, so a NO
-- ACTION edge from here fails orgCascadeFkOnDelete.integration.test.ts. A NULL
-- owner blocks every child (spec §3.4) — never a system fallback.
--
-- The trigger functions elevate breeze.scope for their own cross-tenant reads
-- and restore the caller's scope before returning (precedent:
-- 2026-07-27-a-feature-policy-reference-ownership.sql). They are DEFERRABLE
-- INITIALLY IMMEDIATE because org merge runs SET CONSTRAINTS ALL DEFERRED.
--
-- DDL only: no rows are written at migration time, so no scope election is
-- needed (migrationRlsScope.test.ts blanks routine bodies). Idempotent; no
-- inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS report_series (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name           varchar(255) NOT NULL,
  type           report_type NOT NULL,
  format         report_format NOT NULL DEFAULT 'pdf',
  schedule       report_schedule NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_mode    text NOT NULL DEFAULT 'all',
  recipient_rule jsonb NOT NULL DEFAULT '{"primaryContact": true, "roles": []}'::jsonb,
  internal_cc    text[] NOT NULL DEFAULT '{}'::text[],
  revision       integer NOT NULL DEFAULT 1,
  enabled        boolean NOT NULL DEFAULT true,
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_target_mode_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_target_mode_chk
      CHECK (target_mode IN ('all', 'selected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_schedule_recurring_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_schedule_recurring_chk
      CHECK (schedule <> 'one_time');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_revision_positive_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_revision_positive_chk
      CHECK (revision >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_name_not_blank_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_name_not_blank_chk
      CHECK (btrim(name) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_internal_cc_max_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_internal_cc_max_chk
      CHECK (cardinality(internal_cc) <= 50);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS report_series_partner_idx ON report_series (partner_id);
CREATE INDEX IF NOT EXISTS report_series_owner_user_idx ON report_series (owner_user_id);

ALTER TABLE report_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_series FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'report_series'
       AND policyname = 'report_series_partner_access'
  ) THEN
    CREATE POLICY report_series_partner_access ON report_series
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep deletes as
-- breeze_app under a system context.
GRANT SELECT, INSERT, UPDATE, DELETE ON report_series TO breeze_app;

CREATE TABLE IF NOT EXISTS report_series_org_targets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id  uuid NOT NULL REFERENCES report_series(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_series_org_targets_series_org_uniq
  ON report_series_org_targets (series_id, org_id);
CREATE INDEX IF NOT EXISTS report_series_org_targets_org_idx
  ON report_series_org_targets (org_id);

ALTER TABLE report_series_org_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_series_org_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON report_series_org_targets;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON report_series_org_targets;
DROP POLICY IF EXISTS breeze_org_isolation_update ON report_series_org_targets;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON report_series_org_targets;
CREATE POLICY breeze_org_isolation_select ON report_series_org_targets
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON report_series_org_targets
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON report_series_org_targets
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON report_series_org_targets
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON report_series_org_targets TO breeze_app;

-- Same-partner guard for targets. FK checks bypass RLS, so "the target org
-- belongs to the series' partner" must be structural (spec §3.2).
CREATE OR REPLACE FUNCTION public.breeze_report_series_target_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _ok boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT EXISTS (
    SELECT 1
      FROM public.report_series s
      JOIN public.organizations o ON o.partner_id = s.partner_id
     WHERE s.id = NEW.series_id AND o.id = NEW.org_id
  ) INTO _ok;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _ok IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'report_series_org_targets_same_partner',
      MESSAGE = 'report series target organization must belong to the series partner';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_target_partner_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_org_targets_same_partner ON public.report_series_org_targets;
CREATE CONSTRAINT TRIGGER report_series_org_targets_same_partner
  AFTER INSERT OR UPDATE OF series_id, org_id ON public.report_series_org_targets
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_target_partner_guard();

-- partner_id never changes: every child and target was validated against it.
CREATE OR REPLACE FUNCTION public.breeze_report_series_partner_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'report_series_partner_immutable',
      MESSAGE = 'report series partner_id is immutable';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_partner_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_partner_immutable ON public.report_series;
CREATE CONSTRAINT TRIGGER report_series_partner_immutable
  AFTER UPDATE OF partner_id ON public.report_series
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_partner_immutable();
```

- [ ] **Step 4: Write the children migration**

Create `apps/api/migrations/2026-11-09-110100-reports-series-children.sql`:

```sql
-- Multi-org report series W02: series children on `reports`, recipient
-- override mode, and the guards that keep a child on its series' partner
-- (spec §3.2). Depends on 2026-11-09-110000-report-series.sql.
--
-- reports.series_id / series_revision / archived_at: only ever set on
-- ORG-owned rows (reports_series_child_shape_chk also forbids a child from
-- being the portal self-service definition or a narrative definition). The
-- partial unique index is the "one active child per (org, series)" backstop
-- behind the reconciler's per-series FOR UPDATE lock.
--
-- report_schedule_recipients.mode: 'add' (every existing row, so today's
-- delivery is unchanged) or 'remove' (a per-org exclusion of a rule match on
-- a series child). The unique key stays (report_id, contact_id).
--
-- DDL only (ADD COLUMN ... DEFAULT is a catalog-only default); no rows are
-- written at migration time. Idempotent; no inner BEGIN/COMMIT.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS series_id uuid;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS series_revision integer;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reports_series_id_report_series_id_fk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_series_id_report_series_id_fk
      FOREIGN KEY (series_id) REFERENCES report_series(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_series_child_shape_chk') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_series_child_shape_chk CHECK (
      series_id IS NULL
      OR (org_id IS NOT NULL AND portal_self_service = false AND source_ai_agent_schedule_id IS NULL)
    );
  END IF;
  -- series_revision 0 is the INDEX sentinel "created/adopted, never
  -- reconciled" (report_series.revision starts at 1, so 0 is always stale).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_series_revision_present_chk') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_series_revision_present_chk
      CHECK (series_id IS NULL OR (series_revision IS NOT NULL AND series_revision >= 0));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS reports_series_active_child_uniq
  ON reports (org_id, series_id)
  WHERE series_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_series_id_idx
  ON reports (series_id)
  WHERE series_id IS NOT NULL;

ALTER TABLE report_schedule_recipients ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'add';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_schedule_recipients_mode_chk') THEN
    ALTER TABLE report_schedule_recipients ADD CONSTRAINT report_schedule_recipients_mode_chk
      CHECK (mode IN ('add', 'remove'));
  END IF;
END $$;

-- A child's org must belong to the series' partner (spec §3.2). Deferrable:
-- org merge repoints reports.org_id under SET CONSTRAINTS ALL DEFERRED; both
-- orgs share a partner (orgMerge.ts refuses otherwise), so the check passes at
-- COMMIT.
CREATE OR REPLACE FUNCTION public.breeze_report_series_child_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _ok boolean;
BEGIN
  IF NEW.series_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT EXISTS (
    SELECT 1
      FROM public.report_series s
      JOIN public.organizations o ON o.partner_id = s.partner_id
     WHERE s.id = NEW.series_id AND o.id = NEW.org_id
  ) INTO _ok;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _ok IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'reports_series_child_same_partner',
      MESSAGE = 'a series child must belong to an organization of the series partner';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_child_partner_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS reports_series_child_same_partner ON public.reports;
CREATE CONSTRAINT TRIGGER reports_series_child_same_partner
  AFTER INSERT OR UPDATE OF series_id, org_id ON public.reports
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_child_partner_guard();

-- An org changing partner would strand its targets / children under the old
-- partner's series. No code path does this today; the guard keeps the
-- invariant from depending on that (precedent:
-- organizations_partner_config_policy_guard, 2026-10-12-100000).
CREATE OR REPLACE FUNCTION public.breeze_report_series_org_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _bad boolean;
BEGIN
  IF NEW.partner_id IS NOT DISTINCT FROM OLD.partner_id THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT EXISTS (
           SELECT 1 FROM public.report_series_org_targets t
             JOIN public.report_series s ON s.id = t.series_id
            WHERE t.org_id = NEW.id AND s.partner_id IS DISTINCT FROM NEW.partner_id)
      OR EXISTS (
           SELECT 1 FROM public.reports r
             JOIN public.report_series s ON s.id = r.series_id
            WHERE r.org_id = NEW.id AND s.partner_id IS DISTINCT FROM NEW.partner_id)
    INTO _bad;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _bad THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'organizations_partner_report_series_guard',
      MESSAGE = 'organization partner change would orphan multi-org report targets or children';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_org_partner_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS organizations_partner_report_series_guard ON public.organizations;
CREATE CONSTRAINT TRIGGER organizations_partner_report_series_guard
  AFTER UPDATE OF partner_id ON public.organizations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_org_partner_guard();

-- Deleting a series archives EVERY child before series_id goes NULL (spec
-- §3.6 DELETE). The request path archives the children it can see, but RLS
-- hides children in out-of-service orgs from a partner request; without this
-- they would become active standalone reports that restart the day the org is
-- reactivated. Elevated for exactly this one UPDATE, then restored.
CREATE OR REPLACE FUNCTION public.breeze_report_series_archive_children()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE public.reports
     SET archived_at = now(), updated_at = now()
   WHERE series_id = OLD.id AND archived_at IS NULL;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_archive_children() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_archive_children_before_delete ON public.report_series;
CREATE TRIGGER report_series_archive_children_before_delete
  BEFORE DELETE ON public.report_series
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_archive_children();
```

- [ ] **Step 5: Add the Drizzle schema**

In `apps/api/src/db/schema/reports.ts`, insert directly after `reportRunStatusEnum` (before `export const reports`):

```ts
/**
 * Multi-org report series W02 (spec 2026-09-28 §3.2). ONE partner-owned
 * definition that fans out into one ordinary org-owned `reports` child per
 * targeted organization. Partner-axis (shape 3, partner_id NOT NULL — the D6
 * Partner-Wide-First exception). It never executes: the reconciler
 * (services/reportSeries/reconcile.ts) materializes the children. CHECKs and
 * the constraint triggers live in SQL only
 * (migrations/2026-11-09-110000-report-series.sql).
 */
export const reportSeries = pgTable('report_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: reportTypeEnum('type').notNull(),
  format: reportFormatEnum('format').notNull().default('pdf'),
  schedule: reportScheduleEnum('schedule').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  targetMode: text('target_mode').$type<'all' | 'selected'>().notNull().default('all'),
  recipientRule: jsonb('recipient_rule')
    .$type<{ primaryContact: boolean; roles: string[] }>()
    .notNull()
    .default({ primaryContact: true, roles: [] }),
  internalCc: text('internal_cc').array().notNull().default(sql`'{}'::text[]`),
  revision: integer('revision').notNull().default(1),
  enabled: boolean('enabled').notNull().default(true),
  // ON DELETE SET NULL (users is in the org cascade set). NULL = every child
  // blocked_no_authority; never a system fallback.
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  partnerIdx: index('report_series_partner_idx').on(table.partnerId),
  ownerIdx: index('report_series_owner_user_idx').on(table.ownerUserId),
}));

/**
 * Multi-org report series W02. Shape 1 (direct org_id). In target_mode 'all'
 * a row is an EXCLUSION; in 'selected' an INCLUSION. Same-partner is enforced
 * by the report_series_org_targets_same_partner constraint trigger.
 */
export const reportSeriesOrgTargets = pgTable('report_series_org_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  seriesId: uuid('series_id').notNull().references(() => reportSeries.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  seriesOrgUniq: uniqueIndex('report_series_org_targets_series_org_uniq').on(table.seriesId, table.orgId),
  orgIdx: index('report_series_org_targets_org_idx').on(table.orgId),
}));
```

In the `reports` column block, after `portalSelfService`:

```ts
  // Multi-org report series W02: set only on ORG-owned children
  // (reports_series_child_shape_chk). ON DELETE SET NULL — a deleted series
  // leaves its children archived (the BEFORE DELETE trigger archives them).
  seriesId: uuid('series_id').references(() => reportSeries.id, { onDelete: 'set null' }),
  // 0 = created/adopted, never reconciled (INDEX revision sentinel);
  // report_series.revision starts at 1, so 0 is always stale.
  seriesRevision: integer('series_revision'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
```

In the `reports` table callback, after `aiFleetDesignOrgUniq`:

```ts
  // Multi-org report series W02: one ACTIVE child per (org, series).
  seriesActiveChildUniq: uniqueIndex('reports_series_active_child_uniq')
    .on(table.orgId, table.seriesId)
    .where(sql`${table.seriesId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
  seriesIdx: index('reports_series_id_idx')
    .on(table.seriesId)
    .where(sql`${table.seriesId} IS NOT NULL`),
```

In `reportScheduleRecipients`, after `contactId`:

```ts
    // Multi-org report series W02: 'remove' exists only on series children
    // (the route refuses it elsewhere); every legacy row is 'add'.
    mode: text('mode').$type<'add' | 'remove'>().notNull().default('add'),
```

- [ ] **Step 6: Run the suite and the migration guards**

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts`
Expected: PASS (18 tests).

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS (no baseline change).

Run: `bash scripts/check-migration-naming.sh` (worktree root)
Expected: exit 0.

Run: `cd apps/api && DATABASE_URL=$(grep '^DATABASE_URL=' ../../.env.test | cut -d= -f2-) pnpm db:check-drift`
Expected: `OK` — ledger row count equals the migration file count.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (if the heap overflows, `NODE_OPTIONS=--max-old-space-size=8192`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-11-09-110000-report-series.sql \
        apps/api/migrations/2026-11-09-110100-reports-series-children.sql \
        apps/api/src/db/schema/reports.ts \
        apps/api/src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts
git commit -m "feat(reports): report_series + targets tables, series columns on reports, same-partner guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tenancy registration (cascade, merge registry, export policy, RLS coverage)

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, around line 720)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (SPECIAL map near `ticket_form_org_links`, ~line 498; `reports` note, line 625)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`report_schedule_recipients` line 597, `reports` line 604, new `report_series_org_targets` entry)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`, line 211)
- Create: `apps/api/src/services/tenantExportPolicyReportSeries.test.ts`
- Test (append): `apps/api/src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 tables/columns.
- Produces: registry entries only.

**FK direction check (children before parents):** `report_series_org_targets` references `organizations` (NO ACTION — `organizations` is last in the list, so correct) and `report_series` (not in the org cascade set). Nothing in the cascade set references `report_series_org_targets`. Alphabetical by `localeCompare`: `report_schedule_recipients` < `report_series_org_targets` < `reports` (`c` < `e`; `_` sorts before `s`).

**Partner erasure:** `report_series` has a `partner_id` column, so `cascadeDeletePartner`'s `information_schema` sweep (`tenantCascade.ts` ~line 2080) discovers and deletes it after every child org is erased; its `BEFORE DELETE` trigger and `reports.series_id ON DELETE SET NULL` make the order irrelevant. No static registration exists or is needed (same as `work_types`).

- [ ] **Step 1: Write the failing export-policy unit test**

Create `apps/api/src/services/tenantExportPolicyReportSeries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';
import { reports, reportScheduleRecipients, reportSeriesOrgTargets } from '../db/schema/reports';

/**
 * CLAUDE.md: the export-policy row fires on a NEW COLUMN of an
 * already-registered org-cascade table, not only on a new table. Multi-org
 * report series W02 adds three columns to `reports`, one to
 * `report_schedule_recipients`, and the new org-cascade table
 * `report_series_org_targets`. None is json/jsonb/bytea and none matches
 * SUSPICIOUS_NAME_PARTS, so all go to `included`.
 */
describe('multi-org report series export policy', () => {
  it.each([
    ['reports', reports],
    ['report_schedule_recipients', reportScheduleRecipients],
    ['report_series_org_targets', reportSeriesOrgTargets],
  ] as const)('classifies every Drizzle column of %s', (name, table) => {
    const policy = CORE_TENANT_EXPORT_POLICY[name];
    expect(policy, `${name} has no export policy`).toBeDefined();
    for (const column of Object.values(getTableColumns(table)).map((c) => c.name)) {
      expect(Object.keys(policy!.columns), `unclassified ${name}.${column}`).toContain(column);
    }
  });

  it('exports the new columns as ordinary tenant data', () => {
    const expectIncluded = (table: string, columns: string[]) => {
      for (const column of columns) {
        expect(CORE_TENANT_EXPORT_POLICY[table]!.columns[column]?.decision, `${table}.${column}`).toBe('include');
      }
    };
    expectIncluded('reports', ['series_id', 'series_revision', 'archived_at']);
    expectIncluded('report_schedule_recipients', ['mode']);
    expectIncluded('report_series_org_targets', ['id', 'series_id', 'org_id', 'created_at']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/tenantExportPolicyReportSeries.test.ts`
Expected: FAIL — `report_series_org_targets has no export policy` and `unclassified reports.series_id`.

- [ ] **Step 3: Append the failing partner-erasure case**

Append to `reportSeriesPartnerRls.integration.test.ts` (add `import { cascadeDeletePartner } from '../../services/tenantCascade';` at the top):

```ts
describe('erasure', () => {
  it('cascadeDeletePartner erases a partner holding a series, a target and a child', async () => {
    const t = await seedTenancy();
    const series = await insertSeries(t.partnerA);
    await rows(null, sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series}, ${t.orgA1})`);
    const child = await insertChild(t.orgA2, series);

    await expect(cascadeDeletePartner(t.partnerA, randomUUID())).resolves.toBeDefined();

    expect(await rows(null, sql`SELECT id FROM report_series WHERE id = ${series}`)).toHaveLength(0);
    expect(await rows(null, sql`SELECT id FROM report_series_org_targets WHERE series_id = ${series}`)).toHaveLength(0);
    expect(await rows(null, sql`SELECT id FROM reports WHERE id = ${child}`)).toHaveLength(0);
  });
});
```

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts -t erasure`
Expected: FAIL — `DELETE from "organizations" failed ... violates foreign key constraint "report_series_org_targets_org_id_fkey"` (the org cascade never deletes the target rows).

- [ ] **Step 4: Register in the org cascade list**

In `apps/api/src/services/tenantCascade.ts`, between `'report_schedule_recipients',` and `'reports',`:

```ts
  // Multi-org report series W02: shape-1 target rows. FK to organizations is
  // NO ACTION (organizations is last); its series_id parent (report_series) is
  // partner-axis and outside this set. report_series itself goes with the
  // partner sweep (partner_id column).
  'report_series_org_targets',
```

- [ ] **Step 5: Run the unit merge walk to see the next red**

Run: `cd apps/api && npx vitest run src/services/orgMerge.test.ts`
Expected: FAIL — `no merge policy registered for 'report_series_org_targets'`. (CLAUDE.md: this suite may only red in the FULL unit run; if this targeted run passes, confirm the red with `cd apps/api && npx vitest run src/services/orgMerge` before continuing.)

- [ ] **Step 6: Register the merge policy**

In `apps/api/src/services/orgMergeRegistry.ts`, directly after the `ticket_form_org_links` repoint-dedupe entry:

```ts
  // Multi-org report series W02 (spec §3.2): verified
  // report_series_org_targets_series_org_uniq (series_id, org_id). On a
  // collision the survivor's row is kept and the loser's dropped — either way
  // the survivor ends up WITH a row, so an exclusion (target_mode 'all') wins,
  // as the spec requires; in 'selected' mode the inclusion wins symmetrically.
  report_series_org_targets: { kind: 'repoint-dedupe', key: ['series_id'] },
```

Replace the `reports:` note string (line 625) with:

```ts
  reports: { kind: 'custom', note: "dedupe narrative-schedule definitions by source_ai_agent_schedule_id, portal-self-service definitions by type, and ai_fleet_design definitions by type (Fleet Designer W01, #5651); in all three passes re-home report_runs.report_id, dedupe report_schedule_recipients by (report_id, contact_id), and re-home remaining recipients before deleting duplicate definitions. Multi-org report series children (W02) colliding on reports_series_active_child_uniq (org_id, series_id) are ARCHIVED in place, never deleted and never re-homed: their runs may be deliverable evidence, and sd_evidence_report_run_fk (report_run_id, report_id) is non-deferrable with no ON UPDATE action, so moving a run would abort the merge with 23503; their recipient overrides are unioned onto the survivor's child with removes winning. NEVER delete report runs or recipient rows except recipient-key collisions; partner-owned definitions (org_id NULL, #3198) are never touched by an org merge — every pass keys on org_id = loser" },
```

- [ ] **Step 7: Register the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`:

Replace the `"report_schedule_recipients"` line with:

```ts
  "report_schedule_recipients": tablePolicy("org_id", {"included":["id","report_id","org_id","contact_id","mode","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  // Multi-org report series W02: shape-1 target rows (exclusion in 'all' mode,
  // inclusion in 'selected'). Plain identifiers; nothing open or secret.
  "report_series_org_targets": tablePolicy("org_id", {"included":["id","series_id","org_id","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

In the `"reports"` line, add `"series_id","series_revision","archived_at"` to `included` directly after `"portal_self_service"`:

```ts
  "reports": tablePolicy("org_id", {"included":["id","org_id","partner_id","name","type","schedule","format","last_generated_at","execution_scope_version","execution_scope_kind","execution_scope_site_ids","execution_scope_user_id","execution_scope_fingerprint","execution_scope_captured_at","execution_scope_principal_kind","source_ai_agent_schedule_id","portal_self_service","series_id","series_revision","archived_at","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["config"]}),
```

(Keep the file's existing key order — `report_series_org_targets` sorts between `report_schedule_recipients` and `reports`.)

- [ ] **Step 8: Register report_series in the RLS coverage allowlist**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, in `PARTNER_TENANT_TABLES` directly after `['work_types', 'partner_id'],`:

```ts
  // report_series (multi-org report series W02): partner-owned parent of
  // org-owned `reports` children. Shape 3, flat
  // breeze_has_partner_access(partner_id), partner_id NOT NULL — the spec D6
  // exception to Partner-Wide-First, so deliberately NOT in
  // DUAL_AXIS_TENANT_TABLES. No org_id, so no org cascade/export/merge entry;
  // report_series_org_targets (shape 1) is auto-discovered. Functional forge
  // proof: reportSeriesPartnerRls.integration.test.ts.
  ['report_series', 'partner_id'],
```

- [ ] **Step 9: Run everything this task touches**

Run: `cd apps/api && npx vitest run src/services/tenantExportPolicyReportSeries.test.ts src/services/orgMerge.test.ts src/services/orgMergeRegistry.extensions.test.ts`
Expected: PASS.

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
Expected: PASS (all six files).

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: PASS — `report_series` asserted via `PARTNER_TENANT_TABLES`; `report_series_org_targets` auto-discovered with `breeze_has_org_access(org_id)` on all four commands. (If it prints "No test files found" you pointed the wrong config at it — see CLAUDE.md.)

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/services/tenantExportPolicyReportSeries.test.ts \
        apps/api/src/__tests__/integration/rls-coverage.integration.test.ts \
        apps/api/src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts
git commit -m "feat(reports): register report series tables in cascade, merge, export and RLS contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: `errors.ts`, `types.ts`, `validation.ts`

**Files:**
- Create: `apps/api/src/services/reportSeries/errors.ts`, `errors.test.ts`
- Create: `apps/api/src/services/reportSeries/types.ts`, `types.test.ts`
- Create: `apps/api/src/services/reportSeries/validation.ts`, `validation.test.ts`
- Modify: `apps/api/src/services/reportConfigSchemas.ts:164` (`function selectsSomething` → `export function selectsSomething`, no body change)

**Interfaces:**
- Consumes: `reportSeries` (Task 1); `REPORT_GENERATORS`, `ReportTypeDef` (`services/reportRegistry.ts`); `BUSINESS_REPORT_TYPES` (`@breeze/shared`); `ReportDeliveryStatus` (W01, `services/reportDelivery.ts`).
- Produces:
  - `class ReportSeriesError extends Error { code: string; status: 400|403|404|409; body?: Record<string, unknown> }`, `seriesNotFound(): ReportSeriesError`, `isReportSeriesError(err, code?): err is ReportSeriesError`.
  - `ReportSeriesRow`, `SeriesTx`, `SeriesTargetMode`, `SeriesRecipientRule`, `SeriesOrgState`, `SeriesOrgStatus`, `ReconcileResult`, `SeriesGateDecision`, `SeriesDetail`, `SeriesRecipientPreview`, `ReportDeliveryStatus` (re-export), `SERIES_ELIGIBLE_ORG_STATUSES`, `SERIES_MANAGED_ERROR`, `seriesManagedRefusal(seriesId)`, `parseSeriesRecipientRule(value)`, `recipientRuleIsActive(rule)`, `emptyReconcileResult()`.
  - `assertSeriesTypeSupported(type: string): void` (throws `ReportSeriesError('series_type_unsupported', 400, { type, reason })`), `assertSeriesConfigOrgAgnostic(config: unknown): void` (throws `ReportSeriesError('series_config_org_specific', 400, { key })`).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/reportSeries/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isReportSeriesError, ReportSeriesError, seriesNotFound } from './errors';

describe('ReportSeriesError', () => {
  it('carries code, status and an optional body', () => {
    const err = new ReportSeriesError('series_owner_ineligible', 400, { reason: 'user_inactive' });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('series_owner_ineligible');
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ reason: 'user_inactive' });
  });

  it('seriesNotFound is the 404 series_not_found error', () => {
    const err = seriesNotFound();
    expect([err.code, err.status]).toEqual(['series_not_found', 404]);
  });

  it('isReportSeriesError narrows by class and optionally by code', () => {
    const err = new ReportSeriesError('series_managed', 409);
    expect(isReportSeriesError(err)).toBe(true);
    expect(isReportSeriesError(err, 'series_managed')).toBe(true);
    expect(isReportSeriesError(err, 'series_not_found')).toBe(false);
    expect(isReportSeriesError(new Error('series_managed'))).toBe(false);
  });
});
```

`apps/api/src/services/reportSeries/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { orgStatusEnum } from '../../db/schema';
import { isUsableOrgStatus } from '../tenantStatus';
import {
  parseSeriesRecipientRule,
  recipientRuleIsActive,
  SERIES_ELIGIBLE_ORG_STATUSES,
  seriesManagedRefusal,
} from './types';

describe('series eligibility', () => {
  it('SERIES_ELIGIBLE_ORG_STATUSES is exactly the statuses isUsableOrgStatus admits', () => {
    const usable = orgStatusEnum.enumValues.filter((status) => isUsableOrgStatus(status));
    expect([...SERIES_ELIGIBLE_ORG_STATUSES].sort()).toEqual([...usable].sort());
  });
});

describe('parseSeriesRecipientRule', () => {
  it('reads a stored rule', () => {
    expect(parseSeriesRecipientRule({ primaryContact: false, roles: ['billing', 'owner'] }))
      .toEqual({ primaryContact: false, roles: ['billing', 'owner'] });
  });
  it('fails closed to "nobody" on a malformed value (never the primary-contact default)', () => {
    for (const bad of [null, 'x', 42, [], { primaryContact: 'yes', roles: 'billing' }]) {
      expect(parseSeriesRecipientRule(bad)).toEqual({ primaryContact: false, roles: [] });
    }
  });
  it('drops non-string and blank roles and dedupes', () => {
    expect(parseSeriesRecipientRule({ primaryContact: true, roles: ['a', 3, ' ', 'a'] }))
      .toEqual({ primaryContact: true, roles: ['a'] });
  });
});

describe('recipientRuleIsActive', () => {
  it('is true for the primary-contact rule or any role', () => {
    expect(recipientRuleIsActive({ primaryContact: true, roles: [] })).toBe(true);
    expect(recipientRuleIsActive({ primaryContact: false, roles: ['billing'] })).toBe(true);
    expect(recipientRuleIsActive({ primaryContact: false, roles: [] })).toBe(false);
  });
});

describe('seriesManagedRefusal', () => {
  it('names the series and the two allowed ways out', () => {
    const body = seriesManagedRefusal('44444444-4444-4444-8444-444444444444');
    expect(body.error).toBe('series_managed');
    expect(body.seriesId).toBe('44444444-4444-4444-8444-444444444444');
    expect(body.message).toMatch(/multi-org report/i);
    expect(body.message).toMatch(/detach/i);
  });
});
```

`apps/api/src/services/reportSeries/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REPORT_TYPES } from '@breeze/shared';
import { INTERNAL_REPORT_TYPES, PARTNER_ONLY_DELIVERY_REPORT_TYPES } from '../../routes/reports/schemas';
import { ReportSeriesError } from './errors';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from './validation';

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ReportSeriesError ? err.code : `unexpected:${String(err)}`;
  }
}

describe('assertSeriesTypeSupported', () => {
  it('admits exactly the org-executable, user-authored, non-business types', () => {
    const supported = REPORT_TYPES.filter((type) => codeOf(() => assertSeriesTypeSupported(type)) === null);
    expect([...supported].sort()).toEqual([
      'alert_summary',
      'compliance',
      'device_inventory',
      'executive_summary',
      'hardware_lifecycle',
      'performance',
      'security_compliance_posture',
      'software_inventory',
    ]);
  });

  it('refuses every system-authored type the routes treat as internal', () => {
    for (const type of INTERNAL_REPORT_TYPES) {
      expect(codeOf(() => assertSeriesTypeSupported(type))).toBe('series_type_unsupported');
    }
  });

  it('refuses every business (partner-only delivery) type', () => {
    for (const type of PARTNER_ONLY_DELIVERY_REPORT_TYPES) {
      expect(codeOf(() => assertSeriesTypeSupported(type))).toBe('series_type_unsupported');
    }
  });

  it('refuses managed-evidence types and unknown strings', () => {
    for (const type of ['threat_detection_review', 'endpoint_management_review', 'vulnerability_management', 'identity_access_review', 'nope']) {
      expect(codeOf(() => assertSeriesTypeSupported(type))).toBe('series_type_unsupported');
    }
  });
});

describe('assertSeriesConfigOrgAgnostic', () => {
  it.each([
    [{ filters: { siteIds: ['11111111-1111-4111-8111-111111111111'] } }, 'filters.siteIds'],
    [{ filters: { deviceIds: ['11111111-1111-4111-8111-111111111111'] } }, 'filters.deviceIds'],
    [{ filters: { groupIds: ['g'] } }, 'filters.groupIds'],
    [{ sites: ['11111111-1111-4111-8111-111111111111'] }, 'sites'],
    [{ siteIds: ['s'] }, 'siteIds'],
    [{ deviceIds: ['d'] }, 'deviceIds'],
    [{ deviceGroupIds: ['g'] }, 'deviceGroupIds'],
    [{ orgId: '11111111-1111-4111-8111-111111111111' }, 'orgId'],
    [{ orgIds: ['o'] }, 'orgIds'],
  ])('refuses %j naming %s', (config, key) => {
    try {
      assertSeriesConfigOrgAgnostic(config);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ReportSeriesError);
      expect((err as ReportSeriesError).code).toBe('series_config_org_specific');
      expect((err as ReportSeriesError).status).toBe(400);
      expect((err as ReportSeriesError).body).toEqual({ key });
    }
  });

  it.each([
    [undefined],
    [{}],
    [{ filters: {} }],
    [{ filters: { siteIds: [] } }],
    [{ sites: [] }],
    [{ filters: { osTypes: ['windows'], severity: ['critical'] }, dateRange: { preset: 'last_30_days' }, columns: ['hostname'] }],
  ])('admits an org-agnostic config %j', (config) => {
    expect(() => assertSeriesConfigOrgAgnostic(config)).not.toThrow();
  });

  it('refuses a non-object config', () => {
    expect(codeOf(() => assertSeriesConfigOrgAgnostic(['x']))).toBe('series_config_org_specific');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reportSeries/errors.test.ts src/services/reportSeries/types.test.ts src/services/reportSeries/validation.test.ts`
Expected: FAIL — `Failed to resolve import "./errors"` / `"./types"` / `"./validation"`.

- [ ] **Step 3: Implement `errors.ts`**

```ts
/**
 * Multi-org report series (spec 2026-09-28). The one error type every
 * services/reportSeries module throws (INDEX contract). Routes map it through
 * `seriesErrorResponse` (routes/reports/seriesErrors.ts) into
 * `{ error: code, ...body }` with `status`. W04 may subclass it.
 */
export class ReportSeriesError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly body?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'ReportSeriesError';
  }
}

export function seriesNotFound(): ReportSeriesError {
  return new ReportSeriesError('series_not_found', 404);
}

export function isReportSeriesError(err: unknown, code?: string): err is ReportSeriesError {
  return err instanceof ReportSeriesError && (code === undefined || err.code === code);
}
```

- [ ] **Step 4: Implement `types.ts`**

```ts
/**
 * Multi-org report series — shared types (INDEX "Types"). The web mirrors the
 * exported interfaces in apps/web/src/components/reports/series/types.ts (W03).
 */
import type { db } from '../../db';
import type { reportSeries } from '../../db/schema';
import type { ReportDeliveryStatus } from '../reportDelivery';

export type { ReportDeliveryStatus };

export type ReportSeriesRow = typeof reportSeries.$inferSelect;

/** `db` itself or a transaction handle — every series service accepts either. */
export type SeriesTx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export type SeriesTargetMode = 'all' | 'selected';

export interface SeriesRecipientRule {
  primaryContact: boolean;
  roles: string[];
}

export type SeriesOrgState =
  | 'active'
  | 'excluded'
  | 'ineligible'
  | 'blocked_no_authority'
  | 'blocked_no_recipients';

export interface SeriesOrgStatus {
  orgId: string;
  orgName: string;
  state: SeriesOrgState;
  childReportId: string | null;
  lastRun: {
    status: string;
    deliveryStatus: ReportDeliveryStatus | null;
    recipientCount: number | null;
    completedAt: string | null;
  } | null;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  archived: number;
  unarchived: number;
  /** orgIds whose child could not capture the owner's authority. */
  blocked: string[];
}

export type SeriesGateDecision =
  | 'run'
  | 'skip_disabled'
  | 'skip_untargeted'
  | 'skip_archived'
  | 'blocked_no_authority';

/**
 * The series response shape W03 consumes: `GET /reports/series` answers
 * `{ data: SeriesDetail[] }`; `GET /:id`, `POST /`, `PATCH /:id`,
 * `PUT /:id/targets` and `POST /:id/transfer-owner` answer a bare SeriesDetail.
 */
export interface SeriesDetail {
  series: ReportSeriesRow;
  targets: string[];
  orgs: SeriesOrgStatus[];
}

/** `GET /reports/series/:id/recipients/preview` and the unsaved POST twin. */
export interface SeriesRecipientPreview {
  totalCustomerRecipients: number;
  orgCount: number;
  orgsWithoutCustomerRecipient: Array<{ orgId: string; orgName: string }>;
}

/**
 * Orgs a series may target (spec §3.3). Pinned equal to
 * `isUsableOrgStatus` (services/tenantStatus.ts) by types.test.ts — a status
 * admitted there but not here (or vice versa) would make the worker gate and
 * the report authority resolvers disagree about the same org.
 */
export const SERIES_ELIGIBLE_ORG_STATUSES = ['active', 'trial'] as const;

export const SERIES_MANAGED_ERROR = 'series_managed' as const;

/** The 409 body every child writer answers (spec §3.3 "Child writers"). */
export function seriesManagedRefusal(seriesId: string) {
  return {
    error: SERIES_MANAGED_ERROR,
    seriesId,
    message:
      'This report is managed by a multi-org report. Edit the multi-org report, or detach this organization to edit it on its own.',
  } as const;
}

/**
 * Reads a stored `recipient_rule`. A malformed value fails closed to "nobody"
 * (not to the primary-contact default): a corrupt rule must never widen who
 * receives a customer's report.
 */
export function parseSeriesRecipientRule(value: unknown): SeriesRecipientRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { primaryContact: false, roles: [] };
  }
  const record = value as Record<string, unknown>;
  const roles = Array.isArray(record.roles)
    ? [...new Set(record.roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0))]
    : [];
  return { primaryContact: record.primaryContact === true, roles };
}

export function recipientRuleIsActive(rule: SeriesRecipientRule): boolean {
  return rule.primaryContact || rule.roles.length > 0;
}

export function emptyReconcileResult(): ReconcileResult {
  return { created: 0, updated: 0, archived: 0, unarchived: 0, blocked: [] };
}
```

Note: the malformed-value case `{ primaryContact: 'yes', roles: 'billing' }` yields `{ primaryContact: false, roles: [] }` — matching the test.

- [ ] **Step 5: Implement `validation.ts` (and export `selectsSomething`)**

In `apps/api/src/services/reportConfigSchemas.ts:164` change `function selectsSomething(` to `export function selectsSomething(` (body unchanged).

Create `apps/api/src/services/reportSeries/validation.ts`:

```ts
/**
 * Multi-org report series — definition rules (spec §3.2 "Series
 * restrictions"). Pure; throws ReportSeriesError with the INDEX codes.
 */
import { BUSINESS_REPORT_TYPES } from '@breeze/shared';
import { selectsSomething } from '../reportConfigSchemas';
import { REPORT_GENERATORS, type ReportTypeDef } from '../reportRegistry';
import { ReportSeriesError } from './errors';

/**
 * Mirrors routes/reports/schemas.ts INTERNAL_REPORT_TYPES (the service layer
 * must not import the route layer); validation.test.ts pins that every
 * internal type is refused here.
 */
const SYSTEM_AUTHORED_REPORT_TYPES: ReadonlySet<string> = new Set(['ai_org_narrative', 'ai_fleet_design']);
const BUSINESS_TYPES: ReadonlySet<string> = new Set(BUSINESS_REPORT_TYPES);

function unsupported(type: string, reason: string): ReportSeriesError {
  return new ReportSeriesError('series_type_unsupported', 400, { type, reason });
}

/**
 * A series type must run for ONE organization under a human principal:
 *  - business types are partner aggregates by nature (PARTNER_ONLY_DELIVERY /
 *    audience msp_staff) — the "combined" report is a partner-owned row;
 *  - narrative / fleet design are system-authored;
 *  - managed-evidence types (registry `execution: 'managed_evidence'`) are
 *    refused per spec §3.2, even though they also have user-authored
 *    definitions (plan Contract concern 3).
 */
export function assertSeriesTypeSupported(type: string): void {
  const def = (REPORT_GENERATORS as Readonly<Record<string, ReportTypeDef | undefined>>)[type];
  if (!def) throw unsupported(type, 'unknown_type');
  if (SYSTEM_AUTHORED_REPORT_TYPES.has(type)) throw unsupported(type, 'system_authored');
  if (BUSINESS_TYPES.has(type) || def.audience === 'msp_staff') throw unsupported(type, 'partner_aggregate');
  if (def.execution !== 'user') throw unsupported(type, 'managed_evidence');
  if (!def.supportedScopes.includes('organization')) throw unsupported(type, 'not_org_executable');
}

/** Top-level config keys that select org-specific objects. */
const ORG_SPECIFIC_KEYS = ['sites', 'siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds', 'orgId', 'orgIds'] as const;
/** `config.filters` keys that name org-specific objects (builder filters). */
const ORG_SPECIFIC_FILTER_KEYS = ['siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds'] as const;

function orgSpecific(key: string): ReportSeriesError {
  return new ReportSeriesError('series_config_org_specific', 400, { key });
}

/**
 * A series config is copied verbatim onto every child, so it must not name a
 * site, device, group or org of any one tenant. "Names" means "selects
 * something" (reportConfigSchemas.selectsSomething): `sites: []` and
 * `filters: {}` are the org-wide default, not a selection.
 */
export function assertSeriesConfigOrgAgnostic(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config !== 'object' || Array.isArray(config)) throw orgSpecific('config');
  const record = config as Record<string, unknown>;
  for (const key of ORG_SPECIFIC_KEYS) {
    if (selectsSomething(record[key])) throw orgSpecific(key);
  }
  const filters = record.filters;
  if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
    for (const key of ORG_SPECIFIC_FILTER_KEYS) {
      if (selectsSomething((filters as Record<string, unknown>)[key])) throw orgSpecific(`filters.${key}`);
    }
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && npx vitest run src/services/reportSeries/errors.test.ts src/services/reportSeries/types.test.ts src/services/reportSeries/validation.test.ts src/services/reportConfigSchemas.test.ts src/routes/reports/schemas.config.test.ts`
Expected: PASS. (`reportConfigSchemas.test.ts` may not exist; drop it from the command if vitest reports "No test files found" for that path — the other files must still run.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/reportSeries/errors.ts apps/api/src/services/reportSeries/errors.test.ts \
        apps/api/src/services/reportSeries/types.ts apps/api/src/services/reportSeries/types.test.ts \
        apps/api/src/services/reportSeries/validation.ts apps/api/src/services/reportSeries/validation.test.ts \
        apps/api/src/services/reportConfigSchemas.ts
git commit -m "feat(reports): report series error, types and definition validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `authority.ts` — owner eligibility and per-child scope capture

**Files:**
- Create: `apps/api/src/services/reportSeries/authority.ts`
- Test: `apps/api/src/services/reportSeries/authority.test.ts`

**Interfaces:**
- Consumes: `resolveLivePartnerReportAuthority(userId, partnerId, action)` (`siteScope.ts:1496` — active user, own partner, `partner_users.org_access = 'all'`, role grants the action, partner operational), `resolveLiveReportAuthority(userId, orgId, action)` (`siteScope.ts:1451` — the same per-org resolver the schedule worker re-checks, `reportScheduleWorker.ts` `processRunScheduledReport`), `persistedSiteScopeValues(authority)` (`siteScope.ts:676` — the encoder report create uses, `core.ts` POST `/`), `ReportSeriesError`.
- Produces:
  - `type ExecutionScopeColumns = PersistedSiteScopeColumns`
  - `assertSeriesOwnerEligible(userId: string, partnerId: string, tx: SeriesTx): Promise<void>` — throws `ReportSeriesError('series_owner_ineligible', 400, { reason })`.
  - `isSeriesOwnerEligible(userId: string, partnerId: string, tx: SeriesTx): Promise<boolean>`
  - `captureChildExecutionScope(ownerUserId: string, orgId: string, tx: SeriesTx): Promise<ExecutionScopeColumns | 'no_authority'>`

Why `'export'`: the worker re-authorizes every scheduled run on `'export'` (a scheduled report mails rendered rows off-platform). Capturing on `'export'` means a child that could never deliver is `blocked_no_authority` up front instead of failing every occurrence.

Both resolvers read on their own system connection (`runOutsideDbContext(withSystemDbAccessContext(...))`) by design (siteScope.ts), exactly as PUT `/reports/:id` already does inside its transaction (`loadLockedDefinition`); the `tx` argument is used only for the owner's partner lookup.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  partner: vi.fn(),
  org: vi.fn(),
}));

vi.mock('../siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../siteScope')>();
  return {
    ...actual,
    resolveLivePartnerReportAuthority: live.partner,
    resolveLiveReportAuthority: live.org,
  };
});

import { siteScopeFingerprint } from '../siteScope';
import { ReportSeriesError } from './errors';
import {
  assertSeriesOwnerEligible,
  captureChildExecutionScope,
  isSeriesOwnerEligible,
} from './authority';
import type { SeriesTx } from './types';

const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_AT = new Date('2026-09-28T12:00:00.000Z');

function txReturningUser(user: { partnerId: string | null } | null): SeriesTx {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(user ? [user] : []);
  return { select: () => chain } as unknown as SeriesTx;
}

function okOrg(kind: 'unrestricted' | 'restricted') {
  const scope = kind === 'unrestricted'
    ? { version: 1 as const, kind, orgId: ORG_ID }
    : { version: 1 as const, kind, orgId: ORG_ID, siteIds: ['44444444-4444-4444-8444-444444444444'] };
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: OWNER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ReportSeriesError);
    expect((err as ReportSeriesError).code).toBe('series_owner_ineligible');
    expect((err as ReportSeriesError).status).toBe(400);
    return (err as ReportSeriesError).body?.reason;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  live.partner.mockResolvedValue({ ok: true, authority: {} });
});

describe('assertSeriesOwnerEligible', () => {
  it('accepts an active full-partner admin of the series partner, checked on export', async () => {
    await expect(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID }))).resolves.toBeUndefined();
    expect(live.partner).toHaveBeenCalledWith(OWNER_ID, PARTNER_ID, 'export');
  });

  it('refuses a user of another partner before any live lookup (no platform-admin escape)', async () => {
    expect(await reasonOf(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: OTHER_PARTNER_ID })))).toBe('owner_not_partner_user');
    expect(await reasonOf(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser(null)))).toBe('owner_not_partner_user');
    expect(live.partner).not.toHaveBeenCalled();
  });

  // Review Focus 4: a 'selected' owner is ineligible even if the selection covers every org.
  it.each(['partner_access_not_all', 'user_inactive', 'permission_removed', 'membership_removed', 'tenant_inactive'])(
    'refuses when the live partner authority says %s',
    async (reason) => {
      live.partner.mockResolvedValue({ ok: false, reason });
      expect(await reasonOf(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID })))).toBe(reason);
    },
  );

  it('isSeriesOwnerEligible maps the refusal to false and rethrows anything else', async () => {
    live.partner.mockResolvedValue({ ok: false, reason: 'partner_access_not_all' });
    await expect(isSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID }))).resolves.toBe(false);
    live.partner.mockRejectedValue(new Error('db down'));
    await expect(isSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID }))).rejects.toThrow('db down');
  });
});

describe('captureChildExecutionScope', () => {
  const tx = txReturningUser({ partnerId: PARTNER_ID });

  it('captures the owner\'s unrestricted scope for THIS org, fingerprint included', async () => {
    live.org.mockResolvedValue(okOrg('unrestricted'));
    const columns = await captureChildExecutionScope(OWNER_ID, ORG_ID, tx);
    expect(live.org).toHaveBeenCalledWith(OWNER_ID, ORG_ID, 'export');
    expect(columns).toEqual({
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: OWNER_ID,
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
      executionScopeCapturedAt: CAPTURED_AT,
      executionScopePrincipalKind: 'user',
    });
  });

  it('a site-restricted owner in that org has no series authority there', async () => {
    live.org.mockResolvedValue(okOrg('restricted'));
    await expect(captureChildExecutionScope(OWNER_ID, ORG_ID, tx)).resolves.toBe('no_authority');
  });

  it('a denied live authority is no_authority, never a fallback', async () => {
    live.org.mockResolvedValue({ ok: false, reason: 'organization_inaccessible' });
    await expect(captureChildExecutionScope(OWNER_ID, ORG_ID, tx)).resolves.toBe('no_authority');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/reportSeries/authority.test.ts`
Expected: FAIL — `Failed to resolve import "./authority"`.

- [ ] **Step 3: Implement**

```ts
/**
 * Multi-org report series — authority (spec §3.4).
 *
 * A child runs as the series OWNER, captured per child for THAT child's org
 * (the fingerprint binds the org id). The owner must be a user of the series'
 * partner with live partner-wide report authority (org_access = 'all', role
 * grants reports:export, user and partner active) — checked at series write,
 * at every reconcile and at every worker gate. A child whose owner cannot
 * reach its org is blocked; it is never run with substitute or system
 * authority.
 */
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema';
import {
  persistedSiteScopeValues,
  resolveLivePartnerReportAuthority,
  resolveLiveReportAuthority,
  type PersistedSiteScopeColumns,
} from '../siteScope';
import { isReportSeriesError, ReportSeriesError } from './errors';
import type { SeriesTx } from './types';

/** INDEX name for the execution-scope columns a child row stores. */
export type ExecutionScopeColumns = PersistedSiteScopeColumns;

function ineligible(reason: string): ReportSeriesError {
  return new ReportSeriesError('series_owner_ineligible', 400, { reason });
}

export async function assertSeriesOwnerEligible(
  userId: string,
  partnerId: string,
  tx: SeriesTx,
): Promise<void> {
  // The partner check comes first and from the users row: the live resolver
  // admits a PLATFORM ADMIN of any partner (allowPlatformAuthority), and a
  // series owner must belong to the series' own partner.
  const [user] = await tx
    .select({ partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.partnerId !== partnerId) throw ineligible('owner_not_partner_user');

  const live = await resolveLivePartnerReportAuthority(userId, partnerId, 'export');
  if (!live.ok) throw ineligible(live.reason);
}

export async function isSeriesOwnerEligible(
  userId: string,
  partnerId: string,
  tx: SeriesTx,
): Promise<boolean> {
  try {
    await assertSeriesOwnerEligible(userId, partnerId, tx);
    return true;
  } catch (err) {
    if (isReportSeriesError(err, 'series_owner_ineligible')) return false;
    throw err;
  }
}

export async function captureChildExecutionScope(
  ownerUserId: string,
  orgId: string,
  // Reserved (INDEX signature): the live resolver reads on its own system
  // connection by design, as every report-authority check does.
  _tx: SeriesTx,
): Promise<ExecutionScopeColumns | 'no_authority'> {
  const live = await resolveLiveReportAuthority(ownerUserId, orgId, 'export');
  if (!live.ok || live.authority.scope.kind !== 'unrestricted') return 'no_authority';
  return persistedSiteScopeValues(live.authority);
}
```

- [ ] **Step 4: Run it**

Run: `cd apps/api && npx vitest run src/services/reportSeries/authority.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reportSeries/authority.ts apps/api/src/services/reportSeries/authority.test.ts
git commit -m "feat(reports): report series owner eligibility and per-child scope capture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `targets.ts` and `recipients.ts`

**Files:**
- Create: `apps/api/src/services/reportSeries/targets.ts`, `targets.test.ts`
- Create: `apps/api/src/services/reportSeries/recipients.ts`, `recipients.test.ts`
- Create: `apps/api/src/__tests__/integration/reportSeriesRecipients.integration.test.ts`

**Interfaces:**
- Consumes: `reportSeriesOrgTargets`, `organizations`, `contacts`, `reportScheduleRecipients` (schema); `SERIES_ELIGIBLE_ORG_STATUSES`, `ReportSeriesRow`, `SeriesTx`, `SeriesRecipientRule`.
- Produces (`targets.ts`):
  - `eligiblePartnerOrgs(partnerId: string, tx: SeriesTx): Promise<Array<{ id: string; name: string }>>`
  - `applyTargetMode(eligibleOrgIds: readonly string[], targetMode: SeriesTargetMode, listedOrgIds: ReadonlySet<string>): string[]`
  - `listSeriesTargetRows(seriesId: string, tx: SeriesTx): Promise<string[]>`
  - `resolveSeriesTargetOrgIds(series: ReportSeriesRow, tx: SeriesTx): Promise<string[]>` (INDEX; eligible orgs only, sorted)
- Produces (`recipients.ts`):
  - `isValidRecipientEmail(value: unknown): value is string`
  - `mergeSeriesRecipients(input: { ruleMatches: RecipientContact[]; overrides: RecipientOverride[]; internalCc: readonly string[] }): { customer: string[]; cc: string[]; dropped: number }`
  - `resolveSeriesRecipientsForOrgs(args: { orgIds: readonly string[]; rule: SeriesRecipientRule; internalCc: readonly string[]; childReportIdByOrg: ReadonlyMap<string, string>; tx?: SeriesTx }): Promise<Map<string, { customer: string[]; cc: string[]; dropped: number }>>`
  - `resolveSeriesChildRecipients(args: { reportId: string; orgId: string; rule: SeriesRecipientRule; internalCc: string[] }): Promise<{ customer: string[]; cc: string[]; dropped: number }>` (INDEX signature; `dropped` is an additive field W01's `scheduledDeliveryStatus` 'partial' rule consumes)
  - `materializeDetachedRecipients(tx: SeriesTx, args: { reportId: string; orgId: string; rule: SeriesRecipientRule }): Promise<{ added: number; removedDropped: number }>`

Visibility: every query runs in the ambient DB context. In a partner request that is the caller's RLS (active/trial orgs only — the eligible set); in the worker and the sweep it is system. Contacts have no status column: "active contacts" in spec §3.5 means contacts with an email address (the `contacts` schema has none; `contacts.ts:40`).

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/reportSeries/targets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyTargetMode } from './targets';

const eligible = ['a', 'b', 'c'];

describe('applyTargetMode', () => {
  it("'all' is every eligible org minus the exclusion rows", () => {
    expect(applyTargetMode(eligible, 'all', new Set(['b']))).toEqual(['a', 'c']);
  });
  it("'selected' is exactly the listed eligible orgs", () => {
    expect(applyTargetMode(eligible, 'selected', new Set(['b', 'c']))).toEqual(['b', 'c']);
  });
  it('a listed org that is not eligible is never targeted in either mode', () => {
    expect(applyTargetMode(eligible, 'selected', new Set(['z']))).toEqual([]);
    expect(applyTargetMode(eligible, 'all', new Set(['z']))).toEqual(eligible);
  });
});
```

`apps/api/src/services/reportSeries/recipients.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isValidRecipientEmail, mergeSeriesRecipients } from './recipients';

describe('mergeSeriesRecipients (spec §3.5: (rule ∪ add) − remove; cc = internal CC)', () => {
  it('unions rule matches and adds, then subtracts removes by contact', () => {
    const out = mergeSeriesRecipients({
      ruleMatches: [
        { contactId: 'c1', email: 'owner@acme.test' },
        { contactId: 'c2', email: 'it@acme.test' },
      ],
      overrides: [
        { contactId: 'c3', email: 'cfo@acme.test', mode: 'add' },
        { contactId: 'c2', email: 'it@acme.test', mode: 'remove' },
      ],
      internalCc: ['noc@msp.test'],
    });
    expect(out.customer).toEqual(['owner@acme.test', 'cfo@acme.test']);
    expect(out.cc).toEqual(['noc@msp.test']);
  });

  it('a remove beats an add of the same contact', () => {
    const out = mergeSeriesRecipients({
      ruleMatches: [],
      overrides: [
        { contactId: 'c1', email: 'a@acme.test', mode: 'add' },
        { contactId: 'c1', email: 'a@acme.test', mode: 'remove' },
      ],
      internalCc: [],
    });
    expect(out.customer).toEqual([]);
  });

  it('dedupes emails case-insensitively, keeping the first spelling, and counts dropped addresses', () => {
    const out = mergeSeriesRecipients({
      ruleMatches: [
        { contactId: 'c1', email: 'Owner@Acme.test' },
        { contactId: 'c2', email: 'owner@acme.test' },
        { contactId: 'c3', email: null },
        { contactId: 'c4', email: 'not-an-email' },
      ],
      overrides: [],
      internalCc: ['noc@msp.test', 'NOC@msp.test', 'bad'],
    });
    expect(out.customer).toEqual(['Owner@Acme.test']);
    expect(out.cc).toEqual(['noc@msp.test']);
    expect(out.dropped).toBe(3);
  });

  it('isValidRecipientEmail is the builder/worker loose regex', () => {
    expect(isValidRecipientEmail(' a@b.co ')).toBe(true);
    expect(isValidRecipientEmail('a@b')).toBe(false);
    expect(isValidRecipientEmail(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing integration suite**

`apps/api/src/__tests__/integration/reportSeriesRecipients.integration.test.ts`:

```ts
/**
 * Multi-org report series W02 — target eligibility, recipient resolution and
 * detach materialization against real Postgres (spec §3.3, §3.5; plan Review
 * Focus 2).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reportSeries } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { resolveSeriesTargetOrgIds } from '../../services/reportSeries/targets';
import {
  materializeDetachedRecipients,
  resolveSeriesChildRecipients,
} from '../../services/reportSeries/recipients';

const system = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function contact(orgId: string, email: string, opts: { primary?: boolean; siteLevel?: boolean; roles?: string[] } = {}) {
  const id = randomUUID();
  let siteId: string | null = null;
  if (opts.siteLevel) {
    siteId = randomUUID();
    await db.execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${siteId}, ${orgId}, ${`site-${siteId.slice(0, 6)}`})`);
  }
  await db.execute(sql`
    INSERT INTO contacts (id, org_id, site_id, name, email, is_primary, roles)
    VALUES (${id}, ${orgId}, ${siteId}, ${email}, ${email}, ${opts.primary ?? false},
            ${`{${(opts.roles ?? []).join(',')}}`}::text[])`);
  return id;
}

async function childReport(orgId: string, seriesId: string) {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision)
    VALUES (${id}, ${orgId}, 'Monthly', 'executive_summary', 'monthly', ${seriesId}, 1)`);
  return id;
}

async function override(reportId: string, orgId: string, contactId: string, mode: 'add' | 'remove') {
  await db.execute(sql`
    INSERT INTO report_schedule_recipients (report_id, org_id, contact_id, mode)
    VALUES (${reportId}, ${orgId}, ${contactId}, ${mode})`);
}

describe('resolveSeriesTargetOrgIds', () => {
  it('counts only active/trial, non-deleted orgs of the series partner, per target mode', async () => {
    await system(async () => {
      const partner = await createPartner();
      const other = await createPartner();
      const active = await createOrganization({ partnerId: partner.id });
      const trial = await createOrganization({ partnerId: partner.id, status: 'trial' });
      const suspended = await createOrganization({ partnerId: partner.id, status: 'suspended' });
      const deleted = await createOrganization({ partnerId: partner.id, deletedAt: new Date() });
      const excluded = await createOrganization({ partnerId: partner.id });
      await createOrganization({ partnerId: other.id });

      const [all] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'All', type: 'executive_summary', schedule: 'monthly', targetMode: 'all',
      }).returning();
      await db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${all!.id}, ${excluded.id})`);
      expect(await resolveSeriesTargetOrgIds(all!, db)).toEqual([active.id, trial.id].sort());

      const [chosen] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'Chosen', type: 'executive_summary', schedule: 'monthly', targetMode: 'selected',
      }).returning();
      await db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id)
                           VALUES (${chosen!.id}, ${suspended.id}), (${chosen!.id}, ${trial.id})`);
      expect(await resolveSeriesTargetOrgIds(chosen!, db)).toEqual([trial.id]);
      expect(deleted.id).toBeDefined();
    });
  });
});

describe('resolveSeriesChildRecipients', () => {
  it('rule (org-level primary + roles) ∪ adds − removes; site-level primaries never match', async () => {
    await system(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const [series] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'S', type: 'executive_summary', schedule: 'monthly',
      }).returning();
      const report = await childReport(org.id, series!.id);
      await contact(org.id, 'primary@acme.test', { primary: true });
      await contact(org.id, 'site-primary@acme.test', { primary: true, siteLevel: true });
      const billing = await contact(org.id, 'billing@acme.test', { roles: ['billing'] });
      const extra = await contact(org.id, 'extra@acme.test');

      await override(report, org.id, extra, 'add');
      await override(report, org.id, billing, 'remove');

      const out = await resolveSeriesChildRecipients({
        reportId: report,
        orgId: org.id,
        rule: { primaryContact: true, roles: ['billing'] },
        internalCc: ['noc@msp.test'],
      });
      expect([...out.customer].sort()).toEqual(['extra@acme.test', 'primary@acme.test']);
      expect(out.cc).toEqual(['noc@msp.test']);
    });
  });
});

// Review Focus 2.
describe('materializeDetachedRecipients', () => {
  it('turns current rule matches into add rows, keeps explicit adds, and drops remove rows', async () => {
    await system(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const [series] = await db.insert(reportSeries).values({
        partnerId: partner.id, name: 'S', type: 'executive_summary', schedule: 'monthly',
      }).returning();
      const report = await childReport(org.id, series!.id);
      const primary = await contact(org.id, 'primary@acme.test', { primary: true });
      const removedMatch = await contact(org.id, 'ops@acme.test', { roles: ['technical'] });
      const explicit = await contact(org.id, 'extra@acme.test');
      await override(report, org.id, explicit, 'add');
      await override(report, org.id, removedMatch, 'remove');

      const result = await materializeDetachedRecipients(db, {
        reportId: report,
        orgId: org.id,
        rule: { primaryContact: true, roles: ['technical'] },
      });
      expect(result).toEqual({ added: 1, removedDropped: 1 });

      const rows = (await db.execute(sql`
        SELECT contact_id, mode FROM report_schedule_recipients WHERE report_id = ${report} ORDER BY contact_id`,
      )) as unknown as Array<{ contact_id: string; mode: string }>;
      expect(rows.map((r) => r.mode)).toEqual(['add', 'add']);
      expect(rows.map((r) => r.contact_id).sort()).toEqual([primary, explicit].sort());
    });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reportSeries/targets.test.ts src/services/reportSeries/recipients.test.ts`
Expected: FAIL — `Failed to resolve import "./targets"` / `"./recipients"`.

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesRecipients.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../../services/reportSeries/targets"`.

- [ ] **Step 4: Implement `targets.ts`**

```ts
/**
 * Multi-org report series — target set (spec §3.3 "Target set").
 * 'all'      = every ELIGIBLE org of the series partner minus the target rows;
 * 'selected' = exactly the target rows that are eligible.
 * Eligible = status IN SERIES_ELIGIBLE_ORG_STATUSES AND deleted_at IS NULL.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { organizations, reportSeriesOrgTargets } from '../../db/schema';
import {
  SERIES_ELIGIBLE_ORG_STATUSES,
  type ReportSeriesRow,
  type SeriesTargetMode,
  type SeriesTx,
} from './types';

export async function eligiblePartnerOrgs(
  partnerId: string,
  tx: SeriesTx,
): Promise<Array<{ id: string; name: string }>> {
  return tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      inArray(organizations.status, [...SERIES_ELIGIBLE_ORG_STATUSES]),
      isNull(organizations.deletedAt),
    ))
    .orderBy(asc(organizations.name), asc(organizations.id));
}

export function applyTargetMode(
  eligibleOrgIds: readonly string[],
  targetMode: SeriesTargetMode,
  listedOrgIds: ReadonlySet<string>,
): string[] {
  return eligibleOrgIds.filter((orgId) =>
    targetMode === 'all' ? !listedOrgIds.has(orgId) : listedOrgIds.has(orgId),
  );
}

export async function listSeriesTargetRows(seriesId: string, tx: SeriesTx): Promise<string[]> {
  const rows = await tx
    .select({ orgId: reportSeriesOrgTargets.orgId })
    .from(reportSeriesOrgTargets)
    .where(eq(reportSeriesOrgTargets.seriesId, seriesId));
  return rows.map((row) => row.orgId).sort();
}

export async function resolveSeriesTargetOrgIds(
  series: ReportSeriesRow,
  tx: SeriesTx,
): Promise<string[]> {
  // Sequential on purpose: `tx` may be a single transaction connection.
  const eligible = await eligiblePartnerOrgs(series.partnerId, tx);
  const listed = new Set(await listSeriesTargetRows(series.id, tx));
  return applyTargetMode(eligible.map((org) => org.id), series.targetMode, listed).sort();
}
```

- [ ] **Step 5: Implement `recipients.ts`**

```ts
/**
 * Multi-org report series — recipients (spec §3.5).
 *
 *   customer = (rule matches in the child's org ∪ child 'add' rows) − child 'remove' rows
 *   cc       = series.internal_cc (materialized as the child's config.emailRecipients)
 *
 * recipient_count is |customer| (INDEX ruling); internal CC is excluded.
 */
import { and, arrayOverlaps, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { contacts, reportScheduleRecipients } from '../../db/schema';
import type { SeriesRecipientRule, SeriesTx } from './types';

/** The same loose regex as ReportBuilder's chips and the schedule worker. */
export function isValidRecipientEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface RecipientContact {
  contactId: string;
  email: string | null;
}
export interface RecipientOverride extends RecipientContact {
  mode: 'add' | 'remove';
}
export interface SeriesRecipients {
  customer: string[];
  cc: string[];
  /** Candidates dropped for a missing or invalid address (W01 'partial'). */
  dropped: number;
}

function dedupeEmails(values: ReadonlyArray<string | null | undefined>): { emails: string[]; dropped: number } {
  const byKey = new Map<string, string>();
  let dropped = 0;
  for (const value of values) {
    if (!isValidRecipientEmail(value)) {
      dropped += 1;
      continue;
    }
    const email = value.trim();
    const key = email.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, email);
  }
  return { emails: [...byKey.values()], dropped };
}

export function mergeSeriesRecipients(input: {
  ruleMatches: RecipientContact[];
  overrides: RecipientOverride[];
  internalCc: readonly string[];
}): SeriesRecipients {
  const removed = new Set(
    input.overrides.filter((row) => row.mode === 'remove').map((row) => row.contactId),
  );
  const candidates = [
    ...input.ruleMatches,
    ...input.overrides.filter((row) => row.mode === 'add'),
  ].filter((row) => !removed.has(row.contactId));
  const customer = dedupeEmails(candidates.map((row) => row.email));
  const cc = dedupeEmails(input.internalCc);
  return { customer: customer.emails, cc: cc.emails, dropped: customer.dropped + cc.dropped };
}

function ruleCondition(rule: SeriesRecipientRule): SQL | undefined {
  const arms: SQL[] = [];
  // Org-level primary contact only (a site-level primary is a site's contact).
  if (rule.primaryContact) arms.push(and(eq(contacts.isPrimary, true), isNull(contacts.siteId))!);
  if (rule.roles.length > 0) arms.push(arrayOverlaps(contacts.roles, rule.roles));
  if (arms.length === 0) return undefined;
  return arms.length === 1 ? arms[0] : or(...arms);
}

async function loadRuleMatches(
  orgIds: readonly string[],
  rule: SeriesRecipientRule,
  tx: SeriesTx,
): Promise<Array<RecipientContact & { orgId: string }>> {
  const condition = ruleCondition(rule);
  if (!condition || orgIds.length === 0) return [];
  return tx
    .select({ orgId: contacts.orgId, contactId: contacts.id, email: contacts.email })
    .from(contacts)
    .where(and(inArray(contacts.orgId, [...orgIds]), isNotNull(contacts.email), condition));
}

async function loadOverrides(
  reportIds: readonly string[],
  tx: SeriesTx,
): Promise<Array<RecipientOverride & { reportId: string }>> {
  if (reportIds.length === 0) return [];
  return tx
    .select({
      reportId: reportScheduleRecipients.reportId,
      contactId: reportScheduleRecipients.contactId,
      mode: reportScheduleRecipients.mode,
      email: contacts.email,
    })
    .from(reportScheduleRecipients)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, reportScheduleRecipients.contactId),
        eq(contacts.orgId, reportScheduleRecipients.orgId),
      ),
    )
    .where(inArray(reportScheduleRecipients.reportId, [...reportIds]));
}

/** Two queries for any number of orgs (preview, detail, worker). */
export async function resolveSeriesRecipientsForOrgs(args: {
  orgIds: readonly string[];
  rule: SeriesRecipientRule;
  internalCc: readonly string[];
  childReportIdByOrg: ReadonlyMap<string, string>;
  tx?: SeriesTx;
}): Promise<Map<string, SeriesRecipients>> {
  const tx = args.tx ?? db;
  const matches = await loadRuleMatches(args.orgIds, args.rule, tx);
  const reportIds = args.orgIds
    .map((orgId) => args.childReportIdByOrg.get(orgId))
    .filter((id): id is string => typeof id === 'string');
  const overrides = await loadOverrides(reportIds, tx);

  const result = new Map<string, SeriesRecipients>();
  for (const orgId of args.orgIds) {
    const reportId = args.childReportIdByOrg.get(orgId);
    result.set(orgId, mergeSeriesRecipients({
      ruleMatches: matches.filter((row) => row.orgId === orgId),
      overrides: reportId ? overrides.filter((row) => row.reportId === reportId) : [],
      internalCc: args.internalCc,
    }));
  }
  return result;
}

export async function resolveSeriesChildRecipients(args: {
  reportId: string;
  orgId: string;
  rule: SeriesRecipientRule;
  internalCc: string[];
}): Promise<SeriesRecipients> {
  const byOrg = await resolveSeriesRecipientsForOrgs({
    orgIds: [args.orgId],
    rule: args.rule,
    internalCc: args.internalCc,
    childReportIdByOrg: new Map([[args.orgId, args.reportId]]),
  });
  return byOrg.get(args.orgId) ?? { customer: [], cc: [], dropped: 0 };
}

/**
 * Detach (spec §3.6, plan Contract concern 7): the standalone report keeps
 * mailing exactly the customers the series was mailing. Current rule matches
 * that are not removed become 'add' rows; 'remove' rows are dropped (they
 * mean nothing without a rule, and the ordinary resolver must never see one).
 */
export async function materializeDetachedRecipients(
  tx: SeriesTx,
  args: { reportId: string; orgId: string; rule: SeriesRecipientRule },
): Promise<{ added: number; removedDropped: number }> {
  const matches = await loadRuleMatches([args.orgId], args.rule, tx);
  const overrides = await loadOverrides([args.reportId], tx);
  const removed = new Set(overrides.filter((row) => row.mode === 'remove').map((row) => row.contactId));
  const toAdd = [...new Set(matches.map((row) => row.contactId))].filter((id) => !removed.has(id));

  let added = 0;
  if (toAdd.length > 0) {
    const inserted = await tx
      .insert(reportScheduleRecipients)
      .values(toAdd.map((contactId) => ({ reportId: args.reportId, orgId: args.orgId, contactId, mode: 'add' as const })))
      .onConflictDoNothing()
      .returning({ id: reportScheduleRecipients.id });
    added = inserted.length;
  }
  const dropped = await tx
    .delete(reportScheduleRecipients)
    .where(and(
      eq(reportScheduleRecipients.reportId, args.reportId),
      eq(reportScheduleRecipients.orgId, args.orgId),
      eq(reportScheduleRecipients.mode, 'remove'),
    ))
    .returning({ id: reportScheduleRecipients.id });
  return { added, removedDropped: dropped.length };
}
```

- [ ] **Step 6: Run everything**

Run: `cd apps/api && npx vitest run src/services/reportSeries/targets.test.ts src/services/reportSeries/recipients.test.ts`
Expected: PASS (7 tests).

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesRecipients.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/reportSeries/targets.ts apps/api/src/services/reportSeries/targets.test.ts \
        apps/api/src/services/reportSeries/recipients.ts apps/api/src/services/reportSeries/recipients.test.ts \
        apps/api/src/__tests__/integration/reportSeriesRecipients.integration.test.ts
git commit -m "feat(reports): report series target set and rule/override recipient resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: The reconciler, repair sweep and worker gate (`reconcile.ts`)

**Files:**
- Create: `apps/api/src/services/reportSeries/reconcile.ts`
- Test: `apps/api/src/services/reportSeries/reconcile.test.ts` (unit: sweep isolation, child config)
- Test: `apps/api/src/__tests__/integration/reportSeriesReconcile.integration.test.ts` (real Postgres)
- Modify: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` (allowlist + `AUD_SERIES`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`services/reportSeries/reconcile.ts` entry)

**Interfaces:**
- Consumes: `resolveSeriesTargetOrgIds` (Task 5), `captureChildExecutionScope`, `isSeriesOwnerEligible`, `ExecutionScopeColumns` (Task 4), `emptyReconcileResult`, `ReportSeriesRow`, `SeriesTx`, `ReconcileResult`, `SeriesGateDecision` (Task 3), `captureException` (`services/sentry`).
- Produces:
  - `reconcileSeries(seriesId: string, tx: SeriesTx): Promise<ReconcileResult>` (INDEX)
  - `reconcileAllSeries(options?: { limit?: number; reconcileOne?: (seriesId: string) => Promise<ReconcileResult> }): Promise<void>` (INDEX signature is the no-argument call; the options are a test seam)
  - `seriesChildGate(report: { id: string; orgId: string; seriesId: string; seriesRevision: number | null; archivedAt: Date | null }): Promise<SeriesGateDecision>` (INDEX)
  - `listSeriesChildren(seriesId: string, tx: SeriesTx): Promise<SeriesChildRow[]>`, `interface SeriesChildRow { id; orgId; seriesRevision; archivedAt; executionScopeUserId }`
  - `findSeriesNeedingReconcile(limit: number, tx?: SeriesTx): Promise<string[]>`
  - `seriesChildConfig(config: unknown, internalCc: readonly string[]): Record<string, unknown>`
  - `SERIES_SWEEP_LIMIT = 100`

**Algorithm (spec §3.3), per series, under a `FOR UPDATE` lock on the `report_series` row** (serializes the route, the sweep and the worker gate for the same series; the partial unique index is the backstop):

1. Target set = `resolveSeriesTargetOrgIds` (eligible orgs only).
2. Owner eligible? (`isSeriesOwnerEligible` — partner-level, once).
3. For each targeted org: active child → rewrite shared fields when `series_revision <> revision` (0 included) or its scope must change; else archived child (most recent) → unarchive the same row; else → insert. Scope is (re)captured when the child has none, or it was captured for a different user than the current owner, or the owner is no longer eligible (then it is set to the all-NULL "blocked" shape, which `completeExecutableScopePredicate` never polls).
4. Every active child whose org is not targeted → `archived_at = now()`.

In a partner request context RLS hides out-of-service orgs, and so their children: the target set and the child list shrink together, so nothing visible is archived wrongly; the invisible children are the system sweep's job within 5 minutes, and the worker gate refuses them in the meantime.

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/services/reportSeries/reconcile.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: dbMock,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../sentry', () => sentry);

import { reconcileAllSeries, seriesChildConfig } from './reconcile';
import { emptyReconcileResult } from './types';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// Review Focus 5.
describe('reconcileAllSeries', () => {
  it('isolates a failing series: the rest still reconcile and the sweep resolves', async () => {
    dbMock.execute.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const reconcileOne = vi.fn(async (id: string) => {
      if (id === 's2') throw new Error('boom');
      return emptyReconcileResult();
    });
    await expect(reconcileAllSeries({ reconcileOne })).resolves.toBeUndefined();
    expect(reconcileOne.mock.calls.map((call) => call[0])).toEqual(['s1', 's2', 's3']);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('is bounded: processes at most `limit` series and warns about the remainder', async () => {
    dbMock.execute.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const reconcileOne = vi.fn(async () => emptyReconcileResult());
    await reconcileAllSeries({ limit: 2, reconcileOne });
    expect(reconcileOne).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('repair sweep backlog'),
      expect.objectContaining({ limit: 2 }),
    );
  });
});

describe('seriesChildConfig', () => {
  it('replaces any emailRecipients with the series internal CC', () => {
    expect(seriesChildConfig({ columns: ['a'], emailRecipients: ['old@x.test'] }, ['noc@msp.test']))
      .toEqual({ columns: ['a'], emailRecipients: ['noc@msp.test'] });
  });
  it('omits emailRecipients entirely when there is no internal CC', () => {
    expect(seriesChildConfig({ columns: ['a'], emailRecipients: ['old@x.test'] }, [])).toEqual({ columns: ['a'] });
  });
  it('treats a non-object config as empty', () => {
    expect(seriesChildConfig(null, [])).toEqual({});
  });
});
```

- [ ] **Step 2: Write the failing integration suite**

`apps/api/src/__tests__/integration/reportSeriesReconcile.integration.test.ts`:

```ts
/**
 * Multi-org report series W02 — reconciler, repair sweep and worker gate
 * against real Postgres (spec §3.3, §3.4, §5 W02 "Reconciler integration").
 * Owner authority is REAL: resolveLiveReportAuthority / the partner resolver
 * read partner_users + role_permissions on their own system connection.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reports, reportSeries } from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import {
  reconcileAllSeries,
  reconcileSeries,
  seriesChildGate,
} from '../../services/reportSeries/reconcile';

const system = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function seedOwner(partnerId: string, orgAccess: 'all' | 'selected' = 'all') {
  const user = await createUser({ partnerId, email: `series-owner-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'reports', action: 'write' },
    { resource: 'reports', action: 'export' },
  ]);
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return user.id;
}

async function seedSeries(opts: { targetMode?: 'all' | 'selected'; internalCc?: string[] } = {}) {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme Dental' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Bolt Legal' });
  const owner = await seedOwner(partner.id);
  const series = await system(async () => {
    const [row] = await db.insert(reportSeries).values({
      partnerId: partner.id,
      name: 'Monthly summary',
      type: 'executive_summary',
      schedule: 'monthly',
      format: 'pdf',
      config: { columns: ['hostname'] },
      targetMode: opts.targetMode ?? 'all',
      internalCc: opts.internalCc ?? ['noc@msp.test'],
      ownerUserId: owner,
      createdBy: owner,
    }).returning();
    return row!;
  });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, owner, series };
}

const reconcile = (seriesId: string) => system(() => db.transaction((tx) => reconcileSeries(seriesId, tx)));

async function children(seriesId: string) {
  return system(() => db.select().from(reports).where(eq(reports.seriesId, seriesId)));
}
async function activeChildFor(seriesId: string, orgId: string) {
  return (await children(seriesId)).find((row) => row.orgId === orgId && row.archivedAt === null);
}

describe('reconcileSeries', () => {
  it('creates one org-owned child per eligible targeted org, capturing the owner scope per org', async () => {
    const s = await seedSeries();
    const result = await reconcile(s.series.id);
    expect(result).toMatchObject({ created: 2, updated: 0, archived: 0, unarchived: 0, blocked: [] });

    const rows = await children(s.series.id);
    expect(rows.map((row) => row.orgId).sort()).toEqual([s.orgA, s.orgB].sort());
    for (const row of rows) {
      expect(row.partnerId).toBeNull();
      expect(row.seriesRevision).toBe(1);
      expect(row.archivedAt).toBeNull();
      expect(row.portalSelfService).toBe(false);
      expect(row.type).toBe('executive_summary');
      expect(row.config).toEqual({ columns: ['hostname'], emailRecipients: ['noc@msp.test'] });
      expect(row.executionScopeUserId).toBe(s.owner);
      expect(row.executionScopeKind).toBe('unrestricted');
      expect(row.executionScopePrincipalKind).toBe('user');
    }
    // Idempotent.
    expect(await reconcile(s.series.id)).toMatchObject({ created: 0, updated: 0, archived: 0, unarchived: 0 });
  });

  it("'all' mode picks up a newly created org within one repair sweep", async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const late = await createOrganization({ partnerId: s.partnerId, name: 'Cobalt Dental' });
    await reconcileAllSeries();
    expect(await activeChildFor(s.series.id, late.id)).toBeDefined();
  });

  it('exclusion archives the child and keeps its runs; re-inclusion unarchives the SAME row', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    const runId = randomUUID();
    await system(() => db.execute(sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${child.id}, 'completed')`));

    await system(() => db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${s.series.id}, ${s.orgA})`));
    expect(await reconcile(s.series.id)).toMatchObject({ archived: 1 });
    expect(await activeChildFor(s.series.id, s.orgA)).toBeUndefined();
    expect(await system(() => db.execute(sql`SELECT id FROM report_runs WHERE id = ${runId}`))).toHaveLength(1);

    await system(() => db.execute(sql`DELETE FROM report_series_org_targets WHERE series_id = ${s.series.id}`));
    expect(await reconcile(s.series.id)).toMatchObject({ unarchived: 1, created: 0 });
    expect((await activeChildFor(s.series.id, s.orgA))?.id).toBe(child.id);
  });

  it('a revision bump rewrites every child; a sentinel-0 child is treated as stale', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const childB = (await activeChildFor(s.series.id, s.orgB))!;
    await system(() => db.update(reports).set({ seriesRevision: 0 }).where(eq(reports.id, childB.id)));
    await system(() => db.update(reportSeries)
      .set({ name: 'Monthly executive summary', revision: 2 })
      .where(eq(reportSeries.id, s.series.id)));

    expect(await reconcile(s.series.id)).toMatchObject({ updated: 2 });
    for (const row of await children(s.series.id)) {
      expect(row.name).toBe('Monthly executive summary');
      expect(row.seriesRevision).toBe(2);
    }
  });

  it('an org that leaves active status is archived by the sweep and unarchived (same row) when it returns', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgB))!;

    await system(() => db.execute(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${s.orgB}`));
    await reconcileAllSeries();
    expect(await activeChildFor(s.series.id, s.orgB)).toBeUndefined();

    await system(() => db.execute(sql`UPDATE organizations SET status = 'active' WHERE id = ${s.orgB}`));
    await reconcileAllSeries();
    expect((await activeChildFor(s.series.id, s.orgB))?.id).toBe(child.id);
  });

  it("an owner demoted to org_access='selected' blocks every child (all-NULL scope), never a fallback", async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.execute(sql`
      UPDATE partner_users SET org_access = 'selected', org_ids = ${`{${s.orgA},${s.orgB}}`}::uuid[]
       WHERE user_id = ${s.owner}`));

    const result = await reconcile(s.series.id);
    expect([...result.blocked].sort()).toEqual([s.orgA, s.orgB].sort());
    for (const row of await children(s.series.id)) {
      expect(row.executionScopeUserId).toBeNull();
      expect(row.executionScopeKind).toBeNull();
      expect(row.executionScopePrincipalKind).toBeNull();
    }
  });

  it('a deactivated owner blocks new children too', async () => {
    const s = await seedSeries();
    await system(() => db.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${s.owner}`));
    const result = await reconcile(s.series.id);
    expect(result.created).toBe(2);
    expect(result.blocked).toHaveLength(2);
  });
});

describe('seriesChildGate', () => {
  async function gateFor(s: Awaited<ReturnType<typeof seedSeries>>, orgId: string) {
    const child = (await children(s.series.id)).find((row) => row.orgId === orgId)!;
    return system(() => seriesChildGate({
      id: child.id,
      orgId: child.orgId!,
      seriesId: child.seriesId!,
      seriesRevision: child.seriesRevision,
      archivedAt: child.archivedAt,
    }));
  }

  it('runs a current child of an enabled series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    expect(await gateFor(s, s.orgA)).toBe('run');
  });

  it('skips a disabled series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.update(reportSeries).set({ enabled: false }).where(eq(reportSeries.id, s.series.id)));
    expect(await gateFor(s, s.orgA)).toBe('skip_disabled');
  });

  it('skips a child whose org was excluded after the job was queued (the row is still active)', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${s.series.id}, ${s.orgA})`));
    expect(await gateFor(s, s.orgA)).toBe('skip_untargeted');
  });

  it('reconciles a stale child first, then runs it', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.update(reportSeries).set({ name: 'Renamed', revision: 2 }).where(eq(reportSeries.id, s.series.id)));
    expect(await gateFor(s, s.orgA)).toBe('run');
    expect((await activeChildFor(s.series.id, s.orgA))?.name).toBe('Renamed');
  });

  // Review Focus 4.
  it("owner demoted to 'selected' still covering the org → blocked_no_authority", async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.execute(sql`
      UPDATE partner_users SET org_access = 'selected', org_ids = ${`{${s.orgA},${s.orgB}}`}::uuid[]
       WHERE user_id = ${s.owner}`));
    expect(await gateFor(s, s.orgA)).toBe('blocked_no_authority');
  });

  it('an archived child is skipped without touching the series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    await system(() => db.update(reports).set({ archivedAt: new Date() }).where(eq(reports.id, child.id)));
    expect(await gateFor(s, s.orgA)).toBe('skip_archived');
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reportSeries/reconcile.test.ts`
Expected: FAIL — `Failed to resolve import "./reconcile"`.

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesReconcile.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../../services/reportSeries/reconcile"`.

- [ ] **Step 4: Implement `reconcile.ts`**

```ts
/**
 * Multi-org report series — reconciler, repair sweep and worker gate (spec §3.3).
 *
 * The reconciler is the ONLY writer of a child's shared fields (name, type,
 * format, schedule, config, series_revision, execution scope). It runs
 *  - transactionally inside every series write (services/reportSeries/store.ts),
 *  - in the repair sweep on every check-schedules tick (reconcileAllSeries,
 *    system context), and
 *  - from the worker gate when a queued child's revision is stale.
 *
 * Archive, never delete: a child whose org leaves the target set (exclusion,
 * ineligibility) keeps its row, runs and evidence with archived_at set, and is
 * unarchived in place if the org comes back.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reports, reportSeries } from '../../db/schema';
import { captureException } from '../sentry';
import {
  captureChildExecutionScope,
  isSeriesOwnerEligible,
  type ExecutionScopeColumns,
} from './authority';
import { resolveSeriesTargetOrgIds } from './targets';
import {
  emptyReconcileResult,
  type ReconcileResult,
  type ReportSeriesRow,
  type SeriesGateDecision,
  type SeriesTx,
} from './types';

export const SERIES_SWEEP_LIMIT = 100;

/**
 * The all-NULL execution scope of a BLOCKED child (spec §3.4 "blocked: no
 * authority"). reports_execution_scope_shape_chk admits it (the legacy
 * shape); the worker's completeExecutableScopePredicate never polls it, so a
 * blocked child is never run with any authority at all.
 */
const BLOCKED_EXECUTION_SCOPE: ExecutionScopeColumns = {
  executionScopeVersion: null,
  executionScopeKind: null,
  executionScopeSiteIds: null,
  executionScopeUserId: null,
  executionScopeFingerprint: null,
  executionScopeCapturedAt: null,
  executionScopePrincipalKind: null,
};

export interface SeriesChildRow {
  id: string;
  orgId: string;
  seriesRevision: number | null;
  archivedAt: Date | null;
  executionScopeUserId: string | null;
}

/** A child's config: the series config with internal CC as emailRecipients. */
export function seriesChildConfig(config: unknown, internalCc: readonly string[]): Record<string, unknown> {
  const base: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
  delete base.emailRecipients;
  return internalCc.length > 0 ? { ...base, emailRecipients: [...internalCc] } : base;
}

function childSharedFields(series: ReportSeriesRow) {
  return {
    name: series.name,
    type: series.type,
    format: series.format,
    schedule: series.schedule,
    config: seriesChildConfig(series.config, series.internalCc),
    seriesRevision: series.revision,
  };
}

/** Every child of one series; active rows first, then most recently archived. */
export async function listSeriesChildren(seriesId: string, tx: SeriesTx): Promise<SeriesChildRow[]> {
  const rows = await tx
    .select({
      id: reports.id,
      orgId: reports.orgId,
      seriesRevision: reports.seriesRevision,
      archivedAt: reports.archivedAt,
      executionScopeUserId: reports.executionScopeUserId,
    })
    .from(reports)
    .where(eq(reports.seriesId, seriesId))
    .orderBy(desc(reports.archivedAt), desc(reports.updatedAt), desc(reports.id));
  // reports_series_child_shape_chk: a child always has an org.
  return rows.flatMap((row) => (row.orgId === null ? [] : [{ ...row, orgId: row.orgId }]));
}

async function updateSeriesChild(
  tx: SeriesTx,
  seriesId: string,
  child: Pick<SeriesChildRow, 'id' | 'orgId'>,
  set: Partial<typeof reports.$inferInsert>,
): Promise<void> {
  await tx
    .update(reports)
    .set(set)
    .where(and(eq(reports.id, child.id), eq(reports.orgId, child.orgId), eq(reports.seriesId, seriesId)));
}

export async function reconcileSeries(seriesId: string, tx: SeriesTx): Promise<ReconcileResult> {
  const result = emptyReconcileResult();
  const [series] = await tx
    .select()
    .from(reportSeries)
    .where(eq(reportSeries.id, seriesId))
    .limit(1)
    .for('update');
  if (!series) return result;

  const targetOrgIds = await resolveSeriesTargetOrgIds(series, tx);
  const targeted = new Set(targetOrgIds);
  const active = new Map<string, SeriesChildRow>();
  const archived = new Map<string, SeriesChildRow>();
  for (const child of await listSeriesChildren(seriesId, tx)) {
    if (child.archivedAt === null) active.set(child.orgId, child);
    else if (!archived.has(child.orgId)) archived.set(child.orgId, child);
  }

  const ownerUserId = series.ownerUserId;
  const ownerEligible = ownerUserId !== null
    && await isSeriesOwnerEligible(ownerUserId, series.partnerId, tx);
  const shared = childSharedFields(series);
  const now = new Date();

  for (const orgId of targetOrgIds) {
    const current = active.get(orgId);
    const scopeIsCurrent = current !== undefined
      && ownerEligible
      && current.executionScopeUserId !== null
      && current.executionScopeUserId === ownerUserId;

    let scope: ExecutionScopeColumns | null = null;
    if (!scopeIsCurrent) {
      const captured = ownerEligible && ownerUserId !== null
        ? await captureChildExecutionScope(ownerUserId, orgId, tx)
        : 'no_authority';
      if (captured === 'no_authority') {
        result.blocked.push(orgId);
        scope = BLOCKED_EXECUTION_SCOPE;
      } else {
        scope = captured;
      }
    }

    if (current) {
      // A still-blocked child is not rewritten just to re-blank its scope.
      const scopeChanges = scope !== null
        && !(scope === BLOCKED_EXECUTION_SCOPE && current.executionScopeUserId === null);
      if (current.seriesRevision === series.revision && !scopeChanges) continue;
      await updateSeriesChild(tx, seriesId, current, {
        ...shared,
        ...(scopeChanges && scope ? scope : {}),
        updatedAt: now,
      });
      result.updated += 1;
      continue;
    }

    const newScope = scope ?? BLOCKED_EXECUTION_SCOPE;
    const previous = archived.get(orgId);
    if (previous) {
      await updateSeriesChild(tx, seriesId, previous, {
        ...shared,
        ...newScope,
        archivedAt: null,
        updatedAt: now,
      });
      result.unarchived += 1;
      continue;
    }

    await tx.insert(reports).values({
      orgId,
      partnerId: null,
      seriesId,
      createdBy: series.createdBy,
      portalSelfService: false,
      ...shared,
      ...newScope,
    });
    result.created += 1;
  }

  for (const [orgId, child] of active) {
    if (targeted.has(orgId)) continue;
    await updateSeriesChild(tx, seriesId, child, { archivedAt: now, updatedAt: now });
    result.archived += 1;
  }
  return result;
}

/**
 * Series with STRUCTURAL drift: a targeted eligible org without an active
 * child, an active child at a stale revision (0 included), or an active child
 * of an org that is no longer targeted. Blocked children are deliberately not
 * drift (plan Contract concern 13). Random order so a persistently failing
 * series cannot starve the rest past the limit.
 */
export async function findSeriesNeedingReconcile(limit: number, tx: SeriesTx = db): Promise<string[]> {
  const rows = (await tx.execute(sql`
    WITH targets AS (
      SELECT s.id AS series_id, o.id AS org_id
        FROM report_series s
        JOIN organizations o ON o.partner_id = s.partner_id
       WHERE o.status IN ('active', 'trial')
         AND o.deleted_at IS NULL
         AND (
           (s.target_mode = 'all' AND NOT EXISTS (
              SELECT 1 FROM report_series_org_targets x WHERE x.series_id = s.id AND x.org_id = o.id))
           OR (s.target_mode = 'selected' AND EXISTS (
              SELECT 1 FROM report_series_org_targets x WHERE x.series_id = s.id AND x.org_id = o.id))
         )
    ),
    active_children AS (
      SELECT r.series_id, r.org_id, r.series_revision
        FROM reports r
       WHERE r.series_id IS NOT NULL AND r.archived_at IS NULL
    )
    SELECT s.id
      FROM report_series s
     WHERE EXISTS (
             SELECT 1 FROM targets t
              WHERE t.series_id = s.id
                AND NOT EXISTS (
                  SELECT 1 FROM active_children a WHERE a.series_id = t.series_id AND a.org_id = t.org_id))
        OR EXISTS (
             SELECT 1 FROM active_children a
              WHERE a.series_id = s.id
                AND (a.series_revision IS DISTINCT FROM s.revision
                     OR NOT EXISTS (
                       SELECT 1 FROM targets t WHERE t.series_id = a.series_id AND t.org_id = a.org_id)))
     ORDER BY random()
     LIMIT ${limit}
  `)) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * The repair sweep (spec §3.3 trigger 2), run on every check-schedules tick
 * BEFORE the due scan. Bounded, per-series error isolation (each series is its
 * own savepoint), logged. Picks up new orgs in 'all' mode and repairs anything
 * a crash left behind.
 */
export async function reconcileAllSeries(options: {
  limit?: number;
  reconcileOne?: (seriesId: string) => Promise<ReconcileResult>;
} = {}): Promise<void> {
  const limit = options.limit ?? SERIES_SWEEP_LIMIT;
  const reconcileOne = options.reconcileOne
    ?? ((seriesId: string) => db.transaction((tx) => reconcileSeries(seriesId, tx)));
  await withSystemDbAccessContext(async () => {
    const ids = await findSeriesNeedingReconcile(limit + 1);
    if (ids.length > limit) {
      console.warn('[reportSeries] repair sweep backlog exceeds one tick; the remainder rolls to the next tick', { limit });
    }
    for (const seriesId of ids.slice(0, limit)) {
      try {
        const result = await reconcileOne(seriesId);
        console.log('[reportSeries] repair sweep reconciled series', {
          seriesId,
          created: result.created,
          updated: result.updated,
          archived: result.archived,
          unarchived: result.unarchived,
          blocked: result.blocked.length,
        });
      } catch (err) {
        console.error('[reportSeries] repair sweep failed for one series; continuing', { seriesId, err });
        captureException(err);
      }
    }
  }, 'reportSeries.repairSweep');
}

/**
 * Worker gate (spec §3.3). Called by processRunScheduledReport for a row with
 * series_id set, BEFORE any authority resolution or run row. Closes the "job
 * queued before the org was excluded / the series was disabled / the owner
 * was demoted" races. A stale revision is reconciled first so the run uses the
 * current definition; the caller must re-read the row after 'run'.
 */
export async function seriesChildGate(report: {
  id: string;
  orgId: string;
  seriesId: string;
  seriesRevision: number | null;
  archivedAt: Date | null;
}): Promise<SeriesGateDecision> {
  if (report.archivedAt !== null) return 'skip_archived';
  return db.transaction(async (tx): Promise<SeriesGateDecision> => {
    const [series] = await tx
      .select()
      .from(reportSeries)
      .where(eq(reportSeries.id, report.seriesId))
      .limit(1)
      .for('update');
    if (!series) return 'skip_untargeted';
    if (!series.enabled) return 'skip_disabled';
    const targets = await resolveSeriesTargetOrgIds(series, tx);
    if (!targets.includes(report.orgId)) return 'skip_untargeted';
    if (series.ownerUserId === null || !(await isSeriesOwnerEligible(series.ownerUserId, series.partnerId, tx))) {
      return 'blocked_no_authority';
    }
    if (report.seriesRevision !== series.revision) await reconcileSeries(series.id, tx);
    const child = (await listSeriesChildren(series.id, tx)).find((row) => row.id === report.id);
    if (!child || child.archivedAt !== null) return 'skip_archived';
    if (child.executionScopeUserId === null || child.executionScopeUserId !== series.ownerUserId) {
      return 'blocked_no_authority';
    }
    return 'run';
  });
}
```

- [ ] **Step 5: Register the new query sites in the visibility scan**

In `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts`, add after the `AUD_CALLER_AUTHORIZED` constant:

```ts
const AUD_SERIES = 'series children carry their series type, and assertSeriesTypeSupported refuses every msp_staff (business) type at series create; the series type is immutable';
const SERIES_CHILD_PIN = 'series children are org-owned by construction (reports_series_child_shape_chk: series_id IS NULL OR org_id IS NOT NULL), so no series_id predicate can reach a partner-owned row';
```

and in `SITE_ALLOWLIST`, after the `src/services/reportRunDelivery.ts` entry:

```ts
  ['src/services/reportSeries/reconcile.ts', new Map([
    ['listSeriesChildren', pinned(1, `children of ONE series id, read by the reconciler / gate / series store in the caller's context; ${SERIES_CHILD_PIN}`, AUD_SERIES)],
    ['updateSeriesChild', pinned(1, `updates one child by id AND org_id AND series_id that listSeriesChildren just returned; ${SERIES_CHILD_PIN}`, AUD_SERIES)],
    ['findSeriesNeedingReconcile', pinned(1, `system-context repair-sweep drift scan; returns series ids only and shows nothing to a caller; ${SERIES_CHILD_PIN}`, AUD_SYSTEM)],
  ])],
```

- [ ] **Step 6: Register the reconciler in the partner-wide write contract**

In `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, directly after the `'services/portal/reportsSelfService.ts'` entry:

```ts
  'services/reportSeries/reconcile.ts': 'the multi-org report reconciler writes only ORG-owned series children: inserts carry a concrete org_id from the eligible target set, updates key on id + org_id + series_id, and reports_series_child_shape_chk forbids a partner-owned child. Its callers are services/reportSeries/store.ts (every entry point gated by canManagePartnerWidePolicies through requireSeriesPartner) and the schedule worker gate / repair sweep (system context, no caller)',
```

- [ ] **Step 7: Run everything**

Run: `cd apps/api && npx vitest run src/services/reportSeries/reconcile.test.ts src/routes/reports/partnerOwnedVisibility.scan.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/services/siteScope.projections.test.ts`
Expected: PASS. If the scan reports a different site count for a reconcile.ts scope, the code diverged from this plan — reconcile the code first, then the count.

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesReconcile.integration.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/reportSeries/reconcile.ts apps/api/src/services/reportSeries/reconcile.test.ts \
        apps/api/src/__tests__/integration/reportSeriesReconcile.integration.test.ts \
        apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts \
        apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(reports): report series reconciler, repair sweep and worker gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: `store.ts` — series CRUD, detail/status, preview, detach bookkeeping

**Files:**
- Create: `apps/api/src/services/reportSeries/store.ts`
- Test: `apps/api/src/services/reportSeries/store.test.ts` (pure helpers)
- Test: `apps/api/src/__tests__/integration/reportSeriesStore.integration.test.ts` (partner request context, real Postgres)
- Modify: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` (store allowlist)

**Interfaces:**
- Consumes: everything from Tasks 3–6; `canManagePartnerWidePolicies`, `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (`services/partnerWideAccess.ts`); `isUsableOrgStatus` (`services/tenantStatus.ts`); W01's `reportRuns.deliveryStatus`, `reportRuns.recipientCount`.
- Produces:
  - `type SeriesAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess' | 'user'>`
  - `seriesWriteAllowed(auth): boolean` — partner scope AND `canManagePartnerWidePolicies` AND a partner id.
  - `ccWidensDelivery(before, after): boolean`, `ruleWidensDelivery(before, after): boolean`, `seriesOrgState(input): SeriesOrgState`
  - `interface CreateSeriesInput`, `interface UpdateSeriesPatch`
  - `createSeries(input, auth, tx, options: { mayAddDelivery: boolean }): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }>`
  - `loadOwnSeries(seriesId, auth, tx?): Promise<ReportSeriesRow>` (throws `series_not_found`)
  - `updateSeries(seriesId, patch, auth, tx, options): Promise<{ series; reconcile }>`
  - `replaceSeriesTargets(seriesId, { targetMode, orgIds }, auth, tx, options): Promise<{ series; reconcile }>`
  - `transferSeriesOwner(seriesId, ownerUserId, auth, tx): Promise<{ series; previousOwnerUserId: string | null; reconcile }>`
  - `deleteSeries(seriesId, auth, tx): Promise<{ series: ReportSeriesRow; archivedChildren: number }>`
  - `listSeries(auth): Promise<SeriesDetail[]>` (every series of the caller's partner, each with its per-org status)
  - `getSeriesDetail(seriesId, auth): Promise<SeriesDetail>`
  - `previewSeriesRecipients(input: { targetMode; orgIds; recipientRule; internalCc; seriesId: string | null }, auth): Promise<SeriesRecipientPreview>`
  - `previewSavedSeriesRecipients(seriesId, auth): Promise<SeriesRecipientPreview>`
  - `finishDetach(tx, args: { seriesId; orgId; reportId }, auth): Promise<{ added: number; removedDropped: number }>`

All errors are `ReportSeriesError`: `series_write_denied` (403), `series_not_found` (404), `recipients_need_export_and_mfa` (403), `series_owner_ineligible` (400, from `authority.ts`).

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/services/reportSeries/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ccWidensDelivery, ruleWidensDelivery, seriesOrgState, seriesWriteAllowed } from './store';

const OWNER = '11111111-1111-4111-8111-111111111111';
const child = (userId: string | null) => ({ id: 'r', orgId: 'o', seriesRevision: 1, archivedAt: null, executionScopeUserId: userId });
const base = {
  orgStatus: 'active', orgDeletedAt: null, targeted: true, ownerEligible: true,
  ownerUserId: OWNER, child: child(OWNER), customerCount: 2, ccCount: 1,
};

describe('seriesWriteAllowed', () => {
  it('admits only a partner-scope, org_access=all caller with a partner id', () => {
    expect(seriesWriteAllowed({ scope: 'partner', partnerId: 'p', partnerOrgAccess: 'all' })).toBe(true);
    expect(seriesWriteAllowed({ scope: 'partner', partnerId: 'p', partnerOrgAccess: 'selected' })).toBe(false);
    expect(seriesWriteAllowed({ scope: 'organization', partnerId: 'p', partnerOrgAccess: null })).toBe(false);
    expect(seriesWriteAllowed({ scope: 'system', partnerId: null, partnerOrgAccess: null })).toBe(false);
  });
});

describe('delivery widening (INDEX recipient delivery gate)', () => {
  it('a new CC address widens; a removal or a case change does not', () => {
    expect(ccWidensDelivery(['a@x.test'], ['a@x.test', 'b@x.test'])).toBe(true);
    expect(ccWidensDelivery(['a@x.test', 'b@x.test'], ['a@x.test'])).toBe(false);
    expect(ccWidensDelivery(['a@x.test'], ['A@X.test'])).toBe(false);
  });
  it('turning primaryContact on or adding a role widens; narrowing does not', () => {
    expect(ruleWidensDelivery({ primaryContact: false, roles: [] }, { primaryContact: true, roles: [] })).toBe(true);
    expect(ruleWidensDelivery({ primaryContact: true, roles: ['billing'] }, { primaryContact: true, roles: ['billing', 'technical'] })).toBe(true);
    expect(ruleWidensDelivery({ primaryContact: true, roles: ['billing'] }, { primaryContact: false, roles: [] })).toBe(false);
  });
});

describe('seriesOrgState', () => {
  it.each([
    [{ ...base }, 'active'],
    [{ ...base, orgStatus: 'suspended' }, 'ineligible'],
    [{ ...base, orgDeletedAt: new Date() }, 'ineligible'],
    [{ ...base, targeted: false }, 'excluded'],
    [{ ...base, ownerEligible: false }, 'blocked_no_authority'],
    [{ ...base, child: child(null) }, 'blocked_no_authority'],
    [{ ...base, child: child('someone-else') }, 'blocked_no_authority'],
    [{ ...base, child: undefined }, 'blocked_no_authority'],
    [{ ...base, customerCount: 0, ccCount: 0 }, 'blocked_no_recipients'],
    [{ ...base, customerCount: 0, ccCount: 1 }, 'active'],
  ] as const)('%j → %s', (input, expected) => {
    expect(seriesOrgState(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Write the failing integration suite**

`apps/api/src/__tests__/integration/reportSeriesStore.integration.test.ts`:

```ts
/**
 * Multi-org report series W02 — the series store in a PARTNER REQUEST
 * context (RLS as breeze_app), exactly as the routes run it. Covers the spec
 * §5 W02 authority tests (narrowed/deactivated owner, transfer-owner
 * re-capture), series delete with history, and Review Focus 1 (detach does
 * not resurrect a child).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { reports, reportSeries } from '../../db/schema';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';
import { reconcileAllSeries } from '../../services/reportSeries/reconcile';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import {
  createSeries, deleteSeries, finishDetach, getSeriesDetail, replaceSeriesTargets,
  transferSeriesOwner, updateSeries, type CreateSeriesInput, type SeriesAuth,
} from '../../services/reportSeries/store';

const system = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function seedOwner(partnerId: string) {
  const user = await createUser({ partnerId, email: `series-store-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'reports', action: 'write' },
    { resource: 'reports', action: 'export' },
  ]);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user.id;
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme Dental' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Bolt Legal' });
  const owner = await seedOwner(partner.id);
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id, orgB.id],
    accessiblePartnerIds: [partner.id], currentPartnerId: partner.id, userId: owner,
  };
  const auth = { scope: 'partner', partnerId: partner.id, partnerOrgAccess: 'all', user: { id: owner } } as unknown as SeriesAuth;
  const inPartner = <T>(fn: (tx: typeof db) => Promise<T>) =>
    withDbAccessContext(ctx, () => db.transaction((tx) => fn(tx as unknown as typeof db)));
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, owner, ctx, auth, inPartner };
}

function input(owner: string, overrides: Partial<CreateSeriesInput> = {}): CreateSeriesInput {
  return {
    name: 'Monthly summary', type: 'executive_summary', format: 'pdf', schedule: 'monthly',
    config: {}, targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] },
    internalCc: [], enabled: true, ownerUserId: owner, ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try { await promise; return null; } catch (err) {
    if (err instanceof ReportSeriesError) return err.code;
    throw err;
  }
}

async function childrenOf(seriesId: string) {
  return system(() => db.select().from(reports).where(eq(reports.seriesId, seriesId)));
}

describe('series store (partner request context)', () => {
  it('create writes the series, its targets and one child per org in ONE transaction', async () => {
    const s = await seed();
    const created = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    expect(created.reconcile.created).toBe(2);
    expect(created.series.partnerId).toBe(s.partnerId);
    expect((await childrenOf(created.series.id)).map((c) => c.orgId).sort()).toEqual([s.orgA, s.orgB].sort());
  });

  it('create with an active rule is refused without the delivery gate, and writes nothing', async () => {
    const s = await seed();
    expect(await codeOf(s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
    const count = await system(() => db.select().from(reportSeries).where(eq(reportSeries.partnerId, s.partnerId)));
    expect(count).toHaveLength(0);
    // No rule, no CC: nothing is delivered, so no gate.
    const quiet = input(s.owner, { recipientRule: { primaryContact: false, roles: [] } });
    await expect(s.inPartner((tx) => createSeries(quiet, s.auth, tx, { mayAddDelivery: false }))).resolves.toBeDefined();
  });

  it('create refuses an owner of another partner (series_owner_ineligible) and a selected caller (series_write_denied)', async () => {
    const s = await seed();
    const foreign = await seedOwner((await createPartner()).id);
    expect(await codeOf(s.inPartner((tx) => createSeries(input(foreign), s.auth, tx, { mayAddDelivery: true }))))
      .toBe('series_owner_ineligible');
    const selected = { ...s.auth, partnerOrgAccess: 'selected' } as SeriesAuth;
    expect(await codeOf(s.inPartner((tx) => createSeries(input(s.owner), selected, tx, { mayAddDelivery: true }))))
      .toBe('series_write_denied');
  });

  it('a shared-field PATCH bumps the revision and rewrites children; a rule-only PATCH does not bump', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const renamed = await s.inPartner((tx) => updateSeries(series.id, { name: 'Renamed' }, s.auth, tx, { mayAddDelivery: false }));
    expect(renamed.series.revision).toBe(2);
    expect(renamed.reconcile.updated).toBe(2);
    const ruleOnly = await s.inPartner((tx) => updateSeries(series.id, { recipientRule: { primaryContact: false, roles: [] } }, s.auth, tx, { mayAddDelivery: false }));
    expect(ruleOnly.series.revision).toBe(2);
    expect(await codeOf(s.inPartner((tx) => updateSeries(series.id, { internalCc: ['noc@msp.test'] }, s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
  });

  it('targets: narrowing archives; re-adding an org while a rule is active needs the delivery gate', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const narrowed = await s.inPartner((tx) => replaceSeriesTargets(series.id, { targetMode: 'selected', orgIds: [s.orgA] }, s.auth, tx, { mayAddDelivery: false }));
    expect(narrowed.reconcile.archived).toBe(1);
    expect(await codeOf(s.inPartner((tx) => replaceSeriesTargets(series.id, { targetMode: 'all', orgIds: [] }, s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
  });

  it('transfer-owner re-captures every child\'s scope for the new owner', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const next = await seedOwner(s.partnerId);
    const moved = await s.inPartner((tx) => transferSeriesOwner(series.id, next, s.auth, tx));
    expect(moved.previousOwnerUserId).toBe(s.owner);
    expect(moved.reconcile.updated).toBe(2);
    for (const child of await childrenOf(series.id)) expect(child.executionScopeUserId).toBe(next);
  });

  it('detail reports excluded / blocked_no_authority / blocked_no_recipients / active per org', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    await system(() => db.execute(sql`
      INSERT INTO contacts (org_id, name, email, is_primary) VALUES (${s.orgA}, 'Owner', 'owner@acme.test', true)`));
    let detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    const state = (orgId: string) => detail.orgs.find((o) => o.orgId === orgId)?.state;
    expect(state(s.orgA)).toBe('active');
    expect(state(s.orgB)).toBe('blocked_no_recipients');

    await system(() => db.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${s.owner}`));
    detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    expect(state(s.orgA)).toBe('blocked_no_authority');

    await system(() => db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series.id}, ${s.orgB})`));
    detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    expect(state(s.orgB)).toBe('excluded');
    expect(detail.targets).toEqual([s.orgB]);
  });

  it('delete archives every child, keeps its runs, and SET NULLs series_id', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const [child] = await childrenOf(series.id);
    const runId = randomUUID();
    await system(() => db.execute(sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${child!.id}, 'completed')`));
    const out = await s.inPartner((tx) => deleteSeries(series.id, s.auth, tx));
    expect(out.archivedChildren).toBe(2);
    const after = await system(() => db.select().from(reports).where(eq(reports.id, child!.id)));
    expect(after[0]?.seriesId).toBeNull();
    expect(after[0]?.archivedAt).not.toBeNull();
    expect(await system(() => db.execute(sql`SELECT id FROM report_runs WHERE id = ${runId}`))).toHaveLength(1);
  });

  // Review Focus 1.
  it('detach bookkeeping un-targets the org so the next sweep does not mint a second child', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    await s.inPartner(async (tx) => {
      await tx.update(reports).set({ seriesId: null, seriesRevision: null }).where(eq(reports.id, child.id));
      await finishDetach(tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth);
    });
    await reconcileAllSeries();
    const forA = (await childrenOf(series.id)).filter((c) => c.orgId === s.orgA);
    expect(forA).toHaveLength(0);
    const standalone = await system(() => db.select().from(reports).where(eq(reports.id, child.id)));
    expect(standalone[0]?.archivedAt).toBeNull();
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reportSeries/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store"`.

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesStore.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../../services/reportSeries/store"`.

- [ ] **Step 4: Implement `store.ts`**

```ts
/**
 * Multi-org report series — the store behind /reports/series (spec §3.6).
 *
 * Every entry point re-asserts the partner-wide gate (requireSeriesPartner:
 * partner scope + canManagePartnerWidePolicies) and takes partner_id from the
 * token, never the body. Every write reconciles in the same transaction
 * (spec §3.3 trigger 1). Whether a write ADDS a delivery is decided here,
 * against the locked current row (INDEX recipient delivery gate); the route
 * only supplies whether the caller may add one.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  organizations,
  reportRuns,
  reports,
  reportSeries,
  reportSeriesOrgTargets,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { isUsableOrgStatus } from '../tenantStatus';
import { assertSeriesOwnerEligible, isSeriesOwnerEligible } from './authority';
import { ReportSeriesError, seriesNotFound } from './errors';
import { listSeriesChildren, reconcileSeries, type SeriesChildRow } from './reconcile';
import { materializeDetachedRecipients, resolveSeriesRecipientsForOrgs } from './recipients';
import {
  applyTargetMode,
  eligiblePartnerOrgs,
  listSeriesTargetRows,
  resolveSeriesTargetOrgIds,
} from './targets';
import {
  parseSeriesRecipientRule,
  recipientRuleIsActive,
  type ReconcileResult,
  type ReportDeliveryStatus,
  type ReportSeriesRow,
  type SeriesDetail,
  type SeriesOrgState,
  type SeriesOrgStatus,
  type SeriesRecipientPreview,
  type SeriesRecipientRule,
  type SeriesTargetMode,
  type SeriesTx,
} from './types';

export type SeriesAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess' | 'user'>;

const DELIVERY_GATE_MESSAGE =
  'Adding email recipients to a multi-org report requires the export permission and an MFA-verified session';

export function seriesWriteAllowed(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
): boolean {
  return auth.scope === 'partner'
    && typeof auth.partnerId === 'string'
    && auth.partnerId.length > 0
    && canManagePartnerWidePolicies(auth);
}

function requireSeriesPartner(auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>): string {
  if (!seriesWriteAllowed(auth)) {
    throw new ReportSeriesError('series_write_denied', 403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  }
  return auth.partnerId as string;
}

function requireDeliveryGate(mayAddDelivery: boolean): void {
  if (!mayAddDelivery) {
    throw new ReportSeriesError('recipients_need_export_and_mfa', 403, { message: DELIVERY_GATE_MESSAGE });
  }
}

export function ccWidensDelivery(before: readonly string[], after: readonly string[]): boolean {
  const known = new Set(before.map((email) => email.trim().toLowerCase()));
  return after.some((email) => !known.has(email.trim().toLowerCase()));
}

export function ruleWidensDelivery(before: SeriesRecipientRule, after: SeriesRecipientRule): boolean {
  return (after.primaryContact && !before.primaryContact)
    || after.roles.some((role) => !before.roles.includes(role));
}

function deliversAnything(rule: SeriesRecipientRule, internalCc: readonly string[]): boolean {
  return recipientRuleIsActive(rule) || internalCc.length > 0;
}

export function seriesOrgState(input: {
  orgStatus: string | null;
  orgDeletedAt: Date | null;
  targeted: boolean;
  ownerEligible: boolean;
  ownerUserId: string | null;
  child: SeriesChildRow | undefined;
  customerCount: number;
  ccCount: number;
}): SeriesOrgState {
  if (!isUsableOrgStatus(input.orgStatus) || input.orgDeletedAt !== null) return 'ineligible';
  if (!input.targeted) return 'excluded';
  if (
    !input.ownerEligible
    || !input.child
    || input.child.executionScopeUserId === null
    || input.child.executionScopeUserId !== input.ownerUserId
  ) {
    return 'blocked_no_authority';
  }
  if (input.customerCount === 0 && input.ccCount === 0) return 'blocked_no_recipients';
  return 'active';
}

export interface CreateSeriesInput {
  name: string;
  type: ReportSeriesRow['type'];
  format: ReportSeriesRow['format'];
  schedule: ReportSeriesRow['schedule'];
  config: Record<string, unknown>;
  targetMode: SeriesTargetMode;
  orgIds: string[];
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
  enabled: boolean;
  ownerUserId: string;
}

export async function createSeries(
  input: CreateSeriesInput,
  auth: SeriesAuth,
  tx: SeriesTx,
  options: { mayAddDelivery: boolean },
): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  if (deliversAnything(input.recipientRule, input.internalCc)) requireDeliveryGate(options.mayAddDelivery);
  await assertSeriesOwnerEligible(input.ownerUserId, partnerId, tx);

  const [series] = await tx
    .insert(reportSeries)
    .values({
      partnerId,
      name: input.name,
      type: input.type,
      format: input.format,
      schedule: input.schedule,
      config: input.config,
      targetMode: input.targetMode,
      recipientRule: input.recipientRule,
      internalCc: input.internalCc,
      enabled: input.enabled,
      ownerUserId: input.ownerUserId,
      createdBy: auth.user.id,
    })
    .returning();
  if (!series) throw new Error('report_series insert returned no row');
  if (input.orgIds.length > 0) {
    await tx.insert(reportSeriesOrgTargets).values(input.orgIds.map((orgId) => ({ seriesId: series.id, orgId })));
  }
  return { series, reconcile: await reconcileSeries(series.id, tx) };
}

export async function loadOwnSeries(
  seriesId: string,
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
  tx: SeriesTx = db,
): Promise<ReportSeriesRow> {
  const partnerId = requireSeriesPartner(auth);
  const [row] = await tx
    .select()
    .from(reportSeries)
    .where(and(eq(reportSeries.id, seriesId), eq(reportSeries.partnerId, partnerId)))
    .limit(1);
  if (!row) throw seriesNotFound();
  return row;
}

async function lockOwnSeries(seriesId: string, partnerId: string, tx: SeriesTx): Promise<ReportSeriesRow> {
  const [row] = await tx
    .select()
    .from(reportSeries)
    .where(and(eq(reportSeries.id, seriesId), eq(reportSeries.partnerId, partnerId)))
    .limit(1)
    .for('update');
  if (!row) throw seriesNotFound();
  return row;
}

export interface UpdateSeriesPatch {
  name?: string;
  format?: ReportSeriesRow['format'];
  schedule?: ReportSeriesRow['schedule'];
  config?: Record<string, unknown>;
  recipientRule?: SeriesRecipientRule;
  internalCc?: string[];
  enabled?: boolean;
}

/** Fields copied onto every child: changing one bumps the revision. */
const REVISION_FIELDS = ['name', 'format', 'schedule', 'config', 'internalCc'] as const;

export async function updateSeries(
  seriesId: string,
  patch: UpdateSeriesPatch,
  auth: SeriesAuth,
  tx: SeriesTx,
  options: { mayAddDelivery: boolean },
): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  const widens = (patch.internalCc !== undefined && ccWidensDelivery(current.internalCc, patch.internalCc))
    || (patch.recipientRule !== undefined
      && ruleWidensDelivery(parseSeriesRecipientRule(current.recipientRule), patch.recipientRule));
  if (widens) requireDeliveryGate(options.mayAddDelivery);

  const set: Partial<typeof reportSeries.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.format !== undefined) set.format = patch.format;
  if (patch.schedule !== undefined) set.schedule = patch.schedule;
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.recipientRule !== undefined) set.recipientRule = patch.recipientRule;
  if (patch.internalCc !== undefined) set.internalCc = patch.internalCc;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (REVISION_FIELDS.some((field) => patch[field] !== undefined)) set.revision = current.revision + 1;

  const [series] = await tx.update(reportSeries).set(set).where(eq(reportSeries.id, seriesId)).returning();
  return { series: series!, reconcile: await reconcileSeries(seriesId, tx) };
}

export async function replaceSeriesTargets(
  seriesId: string,
  input: { targetMode: SeriesTargetMode; orgIds: string[] },
  auth: SeriesAuth,
  tx: SeriesTx,
  options: { mayAddDelivery: boolean },
): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  const before = new Set(await resolveSeriesTargetOrgIds(current, tx));
  const eligible = await eligiblePartnerOrgs(partnerId, tx);
  const after = applyTargetMode(eligible.map((org) => org.id), input.targetMode, new Set(input.orgIds));
  const addsOrgs = after.some((orgId) => !before.has(orgId));
  if (addsOrgs && deliversAnything(parseSeriesRecipientRule(current.recipientRule), current.internalCc)) {
    requireDeliveryGate(options.mayAddDelivery);
  }

  // Replaces the rows the caller can SEE. Rows for orgs outside the caller's
  // RLS (out-of-service orgs) survive by design: they are not in any list the
  // caller was shown, so they are not the caller's to drop.
  await tx.delete(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, seriesId));
  if (input.orgIds.length > 0) {
    await tx
      .insert(reportSeriesOrgTargets)
      .values(input.orgIds.map((orgId) => ({ seriesId, orgId })))
      .onConflictDoNothing();
  }
  const [series] = await tx
    .update(reportSeries)
    .set({ targetMode: input.targetMode, revision: current.revision + 1, updatedAt: new Date() })
    .where(eq(reportSeries.id, seriesId))
    .returning();
  return { series: series!, reconcile: await reconcileSeries(seriesId, tx) };
}

export async function transferSeriesOwner(
  seriesId: string,
  ownerUserId: string,
  auth: SeriesAuth,
  tx: SeriesTx,
): Promise<{ series: ReportSeriesRow; previousOwnerUserId: string | null; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  await assertSeriesOwnerEligible(ownerUserId, partnerId, tx);
  const [series] = await tx
    .update(reportSeries)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(eq(reportSeries.id, seriesId))
    .returning();
  // Every child's scope names the previous owner, so the reconciler
  // re-captures all of them (spec §3.4 "Transfer owner").
  return { series: series!, previousOwnerUserId: current.ownerUserId, reconcile: await reconcileSeries(seriesId, tx) };
}

export async function deleteSeries(
  seriesId: string,
  auth: SeriesAuth,
  tx: SeriesTx,
): Promise<{ series: ReportSeriesRow; archivedChildren: number }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  const now = new Date();
  // The visible children; report_series_archive_children_before_delete
  // archives any the caller's RLS cannot see.
  const archived = await tx
    .update(reports)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(reports.seriesId, seriesId), isNull(reports.archivedAt)))
    .returning({ id: reports.id });
  await tx.delete(reportSeries).where(eq(reportSeries.id, seriesId));
  return { series: current, archivedChildren: archived.length };
}

export async function listSeries(auth: SeriesAuth): Promise<SeriesDetail[]> {
  const partnerId = requireSeriesPartner(auth);
  const rows = await db
    .select()
    .from(reportSeries)
    .where(eq(reportSeries.partnerId, partnerId))
    .orderBy(asc(reportSeries.name), asc(reportSeries.id));
  // Sequential: one request connection. A partner has tens of series, and
  // W03's grouped list needs every series' per-org status anyway.
  const details: SeriesDetail[] = [];
  for (const series of rows) details.push(await buildSeriesDetail(series));
  return details;
}

export async function getSeriesDetail(seriesId: string, auth: SeriesAuth): Promise<SeriesDetail> {
  return buildSeriesDetail(await loadOwnSeries(seriesId, auth));
}

/** Callers have already passed requireSeriesPartner and own `series`. */
async function buildSeriesDetail(series: ReportSeriesRow): Promise<SeriesDetail> {
  const seriesId = series.id;
  const partnerId = series.partnerId;
  const targets = await listSeriesTargetRows(seriesId, db);
  const targeted = new Set(await resolveSeriesTargetOrgIds(series, db));
  const orgRows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      status: organizations.status,
      deletedAt: organizations.deletedAt,
    })
    .from(organizations)
    .where(eq(organizations.partnerId, partnerId))
    .orderBy(asc(organizations.name), asc(organizations.id));
  const activeChildren = (await listSeriesChildren(seriesId, db)).filter((child) => child.archivedAt === null);
  const childByOrg = new Map(activeChildren.map((child) => [child.orgId, child]));

  const lastRuns = activeChildren.length === 0
    ? []
    : await db
      .selectDistinctOn([reportRuns.reportId], {
        reportId: reportRuns.reportId,
        status: reportRuns.status,
        deliveryStatus: reportRuns.deliveryStatus,
        recipientCount: reportRuns.recipientCount,
        completedAt: reportRuns.completedAt,
      })
      .from(reportRuns)
      .where(inArray(reportRuns.reportId, activeChildren.map((child) => child.id)))
      .orderBy(reportRuns.reportId, desc(reportRuns.createdAt));
  const runByReport = new Map(lastRuns.map((run) => [run.reportId, run]));

  const ownerEligible = series.ownerUserId !== null
    && await isSeriesOwnerEligible(series.ownerUserId, partnerId, db);
  const recipients = await resolveSeriesRecipientsForOrgs({
    orgIds: [...targeted],
    rule: parseSeriesRecipientRule(series.recipientRule),
    internalCc: series.internalCc,
    childReportIdByOrg: new Map(activeChildren.map((child) => [child.orgId, child.id])),
  });

  const orgs: SeriesOrgStatus[] = orgRows.map((org) => {
    const child = childByOrg.get(org.id);
    const resolved = recipients.get(org.id);
    const run = child ? runByReport.get(child.id) : undefined;
    return {
      orgId: org.id,
      orgName: org.name,
      state: seriesOrgState({
        orgStatus: org.status,
        orgDeletedAt: org.deletedAt,
        targeted: targeted.has(org.id),
        ownerEligible,
        ownerUserId: series.ownerUserId,
        child,
        customerCount: resolved?.customer.length ?? 0,
        ccCount: resolved?.cc.length ?? 0,
      }),
      childReportId: child?.id ?? null,
      lastRun: run
        ? {
          status: run.status,
          deliveryStatus: (run.deliveryStatus ?? null) as ReportDeliveryStatus | null,
          recipientCount: run.recipientCount ?? null,
          completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        }
        : null,
    };
  });
  return { series, targets, orgs };
}

export async function previewSeriesRecipients(
  input: {
    targetMode: SeriesTargetMode;
    orgIds: string[];
    recipientRule: SeriesRecipientRule;
    internalCc: string[];
    seriesId: string | null;
  },
  auth: SeriesAuth,
): Promise<SeriesRecipientPreview> {
  const partnerId = requireSeriesPartner(auth);
  const eligible = await eligiblePartnerOrgs(partnerId, db);
  const targetIds = applyTargetMode(eligible.map((org) => org.id), input.targetMode, new Set(input.orgIds));
  const childReportIdByOrg = new Map<string, string>();
  if (input.seriesId) {
    for (const child of await listSeriesChildren(input.seriesId, db)) {
      if (child.archivedAt === null) childReportIdByOrg.set(child.orgId, child.id);
    }
  }
  const byOrg = await resolveSeriesRecipientsForOrgs({
    orgIds: targetIds,
    rule: input.recipientRule,
    internalCc: input.internalCc,
    childReportIdByOrg,
  });
  const names = new Map(eligible.map((org) => [org.id, org.name]));
  let totalCustomerRecipients = 0;
  const orgsWithoutCustomerRecipient: Array<{ orgId: string; orgName: string }> = [];
  for (const orgId of targetIds) {
    const count = byOrg.get(orgId)?.customer.length ?? 0;
    totalCustomerRecipients += count;
    if (count === 0) orgsWithoutCustomerRecipient.push({ orgId, orgName: names.get(orgId) ?? '' });
  }
  return { totalCustomerRecipients, orgCount: targetIds.length, orgsWithoutCustomerRecipient };
}

export async function previewSavedSeriesRecipients(
  seriesId: string,
  auth: SeriesAuth,
): Promise<SeriesRecipientPreview> {
  const series = await loadOwnSeries(seriesId, auth);
  return previewSeriesRecipients({
    targetMode: series.targetMode,
    orgIds: await listSeriesTargetRows(seriesId, db),
    recipientRule: parseSeriesRecipientRule(series.recipientRule),
    internalCc: series.internalCc,
    seriesId,
  }, auth);
}

/**
 * Detach bookkeeping (plan Contract concern 7), called by POST
 * /reports/:id/detach inside its transaction AFTER it cleared series_id:
 * un-target the org without bumping the revision, then keep the org's current
 * customers receiving the now-standalone report.
 */
export async function finishDetach(
  tx: SeriesTx,
  args: { seriesId: string; orgId: string; reportId: string },
  auth: SeriesAuth,
): Promise<{ added: number; removedDropped: number }> {
  const partnerId = requireSeriesPartner(auth);
  const series = await lockOwnSeries(args.seriesId, partnerId, tx);
  if (series.targetMode === 'all') {
    await tx
      .insert(reportSeriesOrgTargets)
      .values({ seriesId: args.seriesId, orgId: args.orgId })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(reportSeriesOrgTargets)
      .where(and(
        eq(reportSeriesOrgTargets.seriesId, args.seriesId),
        eq(reportSeriesOrgTargets.orgId, args.orgId),
      ));
  }
  return materializeDetachedRecipients(tx, {
    reportId: args.reportId,
    orgId: args.orgId,
    rule: parseSeriesRecipientRule(series.recipientRule),
  });
}
```

- [ ] **Step 5: Register the store's query sites in the visibility scan**

In `partnerOwnedVisibility.scan.test.ts` `SITE_ALLOWLIST`, after the `reconcile.ts` entry from Task 6:

```ts
  ['src/services/reportSeries/store.ts', new Map([
    ['buildSeriesDetail', pinned(1, `latest run per active child id returned by listSeriesChildren for a series its callers (listSeries / getSeriesDetail) already loaded under requireSeriesPartner + eq(partner_id, token partner); ${SERIES_CHILD_PIN}`, AUD_SERIES)],
    ['deleteSeries', pinned(1, `archives children of ONE series the caller owns (requireSeriesPartner + FOR UPDATE lock on the series row); ${SERIES_CHILD_PIN}`, AUD_SERIES)],
  ])],
```

- [ ] **Step 6: Run everything**

Run: `cd apps/api && npx vitest run src/services/reportSeries/store.test.ts src/routes/reports/partnerOwnedVisibility.scan.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: PASS (`store.ts` mentions `canManagePartnerWidePolicies`, so it needs no write-coverage allowlist entry).

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesStore.integration.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/reportSeries/store.ts apps/api/src/services/reportSeries/store.test.ts \
        apps/api/src/__tests__/integration/reportSeriesStore.integration.test.ts \
        apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts
git commit -m "feat(reports): report series store (CRUD, status, preview, detach bookkeeping)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Recipient gate extraction, error mapper, schemas and the `/reports/series` routes

**Files:**
- Create: `apps/api/src/routes/reports/recipientGate.ts`, `recipientGate.test.ts`
- Modify: `apps/api/src/routes/reports/core.ts:104-141` (re-import the gate; no behaviour change)
- Create: `apps/api/src/routes/reports/seriesErrors.ts`
- Create: `apps/api/src/routes/reports/seriesSchemas.ts`
- Create: `apps/api/src/routes/reports/series.ts`
- Test: `apps/api/src/routes/reports/series.test.ts`
- Modify: `apps/api/src/routes/reports/index.ts` (mount `/series` first)
- Modify: `apps/api/src/services/mcpCoverage.ts:509-513` (`reports/series.ts` entry)

**Interfaces:**
- Consumes: the whole store (Task 7), `assertSeriesTypeSupported` / `assertSeriesConfigOrgAgnostic` (Task 3), `parseStoredReportConfig` and `reportTypeSchema` (`routes/reports/schemas.ts`), `CONTACT_ROLES` (`services/contacts/types.ts:59`), `formatZodError` / `zValidator` (`lib/validation.ts`), `writeRouteAudit` (`services/auditEvents.ts:144`).
- Produces:
  - `recipientGate.ts`: `RECIPIENTS_NEED_EXPORT_AND_MFA` (moved verbatim), `callerMaySetEmailRecipients(auth: Pick<AuthContext, 'token'>, permissions: UserPermissions | undefined): boolean`.
  - `seriesErrors.ts`: `seriesErrorResponse(c: Context, err: unknown): Response` (rethrows non-`ReportSeriesError`).
  - `seriesSchemas.ts`: `createSeriesSchema`, `updateSeriesSchema`, `replaceSeriesTargetsSchema`, `transferSeriesOwnerSchema`, `previewSeriesRecipientsSchema`, `seriesIdParamSchema`, `seriesRecipientRuleSchema`.
  - `series.ts`: `reportSeriesRoutes` — `GET /`, `POST /recipients/preview`, `POST /`, `GET /:id`, `GET /:id/recipients/preview`, `PATCH /:id`, `PUT /:id/targets`, `POST /:id/transfer-owner`, `DELETE /:id`. Response shapes per Contract concern 4c.

Audit actions (orgId `null` + `details.partnerId`, the partner-owned report precedent in `core.ts` POST `/`): `report_series.create`, `report_series.update`, `report_series.targets.replace`, `report_series.owner.transfer`, `report_series.delete`; each carries the `ReconcileResult` (except delete: `archivedChildren`).

- [ ] **Step 1: Write the failing gate parity test**

`apps/api/src/routes/reports/recipientGate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: (auth: { token?: { mfa?: boolean } }) => auth.token?.mfa === true,
}));

import { callerMaySetEmailRecipients, RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';

const withExport = { permissions: [{ resource: 'reports', action: 'export' }] };
const withoutExport = { permissions: [{ resource: 'reports', action: 'write' }] };
const mfa = { token: { mfa: true } } as never;
const noMfa = { token: { mfa: false } } as never;

describe('callerMaySetEmailRecipients (moved from core.ts, behaviour unchanged)', () => {
  it('requires reports:export AND a satisfied MFA session', () => {
    expect(callerMaySetEmailRecipients(mfa, withExport as never)).toBe(true);
    expect(callerMaySetEmailRecipients(noMfa, withExport as never)).toBe(false);
    expect(callerMaySetEmailRecipients(mfa, withoutExport as never)).toBe(false);
    expect(callerMaySetEmailRecipients(mfa, undefined)).toBe(false);
  });

  it('keeps the exact 403 body core.ts has always sent', () => {
    expect(RECIPIENTS_NEED_EXPORT_AND_MFA).toEqual({
      error: 'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
    });
  });
});
```

Run: `cd apps/api && npx vitest run src/routes/reports/recipientGate.test.ts`
Expected: FAIL — `Failed to resolve import "./recipientGate"`.

- [ ] **Step 2: Extract the gate**

Create `apps/api/src/routes/reports/recipientGate.ts`:

```ts
import { hasSatisfiedMfa, type AuthContext } from '../../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';

/**
 * A scheduled report with email recipients delivers a rendered export off
 * the platform on a timer, with no per-run confirmation — the same bulk
 * output `reports:export` already gates on the interactive download and
 * generate paths (`runs.ts`, `generate.ts`). Adding recipients needs that
 * permission plus a fresh-MFA session, not just `reports:write`.
 *
 * Moved verbatim from routes/reports/core.ts (multi-org report series W02) so
 * the series routes and the child recipient writer share ONE gate (INDEX
 * "Recipient delivery gate"). The permission set is not on AuthContext —
 * requirePermission stores it as c.get('permissions') — so it is an argument.
 */
export const RECIPIENTS_NEED_EXPORT_AND_MFA = {
  error:
    'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
} as const;

export function callerMaySetEmailRecipients(
  auth: Pick<AuthContext, 'token'>,
  permissions: UserPermissions | undefined,
): boolean {
  if (!permissions || !hasPermission(permissions, PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action)) {
    return false;
  }
  return hasSatisfiedMfa(auth);
}
```

In `apps/api/src/routes/reports/core.ts`, delete the local `RECIPIENTS_NEED_EXPORT_AND_MFA` constant and its doc comment (lines 104-116), replace `recipientExportGateFails` (lines 118-141) with the version below, add `import { callerMaySetEmailRecipients, RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';`, and drop `hasSatisfiedMfa` from the `../../middleware/auth` import and `hasPermission` from the permissions import (`grep -n "hasSatisfiedMfa\|hasPermission(" apps/api/src/routes/reports/core.ts` must then print nothing):

```ts
function recipientExportGateFails(
  config: unknown,
  permissions: UserPermissions | undefined,
  auth: AuthContext,
): boolean {
  if (reportConfigEmailRecipients(config).length === 0) return false;
  return !callerMaySetEmailRecipients(auth, permissions);
}
```

Run: `cd apps/api && npx vitest run src/routes/reports/recipientGate.test.ts src/routes/reports/core.partnerOwned.test.ts`
Expected: PASS — including the existing `report definition recipients require export + MFA` block (the parity pin for core.ts).

- [ ] **Step 3: Write the failing route tests**

`apps/api/src/routes/reports/series.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '44444444-4444-4444-8444-444444444444';

const state = vi.hoisted(() => ({
  auth: null as unknown,
  permissions: null as unknown,
  mfaSatisfied: true,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => { c.set('auth', state.auth); await next(); },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (c: any, next: () => Promise<void>) => { c.set('permissions', state.permissions); await next(); },
  hasSatisfiedMfa: () => state.mfaSatisfied,
}));
vi.mock('../../db', () => ({ db: { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn('tx')) } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

const store = vi.hoisted(() => ({
  createSeries: vi.fn(),
  updateSeries: vi.fn(),
  replaceSeriesTargets: vi.fn(),
  transferSeriesOwner: vi.fn(),
  deleteSeries: vi.fn(),
  listSeries: vi.fn(),
  getSeriesDetail: vi.fn(),
  loadOwnSeries: vi.fn(),
  previewSeriesRecipients: vi.fn(),
  previewSavedSeriesRecipients: vi.fn(),
}));
vi.mock('../../services/reportSeries/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportSeries/store')>();
  return { ...actual, ...store };
});

import { reportSeriesRoutes } from './series';
import { writeRouteAudit } from '../../services/auditEvents';
import { ReportSeriesError, seriesNotFound } from '../../services/reportSeries/errors';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const ALL = { permissions: [{ resource: '*', action: '*' }] };
const seriesRow = { id: SERIES_ID, partnerId: PARTNER_ID, name: 'Monthly summary', type: 'executive_summary', targetMode: 'all', revision: 1 };
const detail = { series: seriesRow, targets: [], orgs: [] };
const reconcile = { created: 1, updated: 0, archived: 0, unarchived: 0, blocked: [] };

function app() {
  const hono = new Hono();
  hono.route('/reports/series', reportSeriesRoutes);
  return hono;
}
function partnerAuth(partnerOrgAccess: 'all' | 'selected' = 'all') {
  return {
    user: { id: USER_ID, email: 'tech@example.com' }, scope: 'partner', orgId: null, partnerId: PARTNER_ID,
    partnerOrgAccess, accessibleOrgIds: [ORG_ID], canAccessOrg: (id: string) => id === ORG_ID, token: { mfa: true },
  };
}
function orgAuth() {
  return { ...partnerAuth(), scope: 'organization', orgId: ORG_ID, partnerOrgAccess: null };
}
const createBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  name: 'Monthly summary', type: 'executive_summary', schedule: 'monthly', ...overrides,
});
const post = (path: string, body: string) => app().request(path, { method: 'POST', headers: JSON_HEADERS, body });

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = partnerAuth();
  state.permissions = ALL;
  state.mfaSatisfied = true;
  store.createSeries.mockResolvedValue({ series: seriesRow, reconcile });
  store.updateSeries.mockResolvedValue({ series: { ...seriesRow, revision: 2 }, reconcile });
  store.replaceSeriesTargets.mockResolvedValue({ series: seriesRow, reconcile });
  store.transferSeriesOwner.mockResolvedValue({ series: seriesRow, previousOwnerUserId: USER_ID, reconcile });
  store.deleteSeries.mockResolvedValue({ series: seriesRow, archivedChildren: 3 });
  store.listSeries.mockResolvedValue([detail]);
  store.getSeriesDetail.mockResolvedValue(detail);
  store.loadOwnSeries.mockResolvedValue(seriesRow);
});

describe('series write gate (partner scope + org_access=all)', () => {
  it.each([['organization token', orgAuth()], ["'selected' partner user", partnerAuth('selected')]])(
    'refuses a %s with 403 series_write_denied and never reaches the store',
    async (_label, auth) => {
      state.auth = auth;
      const list = await app().request('/reports/series');
      expect(list.status).toBe(403);
      expect(await list.json()).toMatchObject({ error: 'series_write_denied' });
      const create = await post('/reports/series', createBody());
      expect(create.status).toBe(403);
      expect(store.listSeries).not.toHaveBeenCalled();
      expect(store.createSeries).not.toHaveBeenCalled();
    },
  );
});

describe('POST /reports/series', () => {
  it('rejects a one_time schedule (series are recurring-only) with a standard 400', async () => {
    const res = await post('/reports/series', createBody({ schedule: 'one_time' }));
    expect(res.status).toBe(400);
    expect(store.createSeries).not.toHaveBeenCalled();
  });

  it('rejects a business type with series_type_unsupported', async () => {
    const res = await post('/reports/series', createBody({ type: 'ar_aging' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'series_type_unsupported', type: 'ar_aging' });
  });

  it('rejects an org-specific config with series_config_org_specific naming the key', async () => {
    const res = await post('/reports/series', createBody({ config: { filters: { siteIds: [ORG_ID] } } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_config_org_specific', key: 'filters.siteIds' });
  });

  it('refuses config.emailRecipients (internalCc is its one home)', async () => {
    const res = await post('/reports/series', createBody({ config: { emailRecipients: ['a@b.test'] } }));
    expect(res.status).toBe(400);
    expect(store.createSeries).not.toHaveBeenCalled();
  });

  it("refuses 'selected' with no orgs, and a body that names a partner", async () => {
    expect((await post('/reports/series', createBody({ targetMode: 'selected', orgIds: [] }))).status).toBe(400);
    expect((await post('/reports/series', createBody({ partnerId: PARTNER_ID }))).status).toBe(400);
    expect(store.createSeries).not.toHaveBeenCalled();
  });

  it('refuses a target org the caller cannot access', async () => {
    const res = await post('/reports/series', createBody({ targetMode: 'selected', orgIds: [FOREIGN_ORG_ID] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_target_org_inaccessible', orgIds: [FOREIGN_ORG_ID] });
  });

  it('creates: owner defaults to the caller, the delivery capability is server-derived, the answer is a SeriesDetail', async () => {
    const res = await post('/reports/series', createBody({ internalCc: ['noc@msp.test'] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(detail);
    const [input, auth, tx, options] = store.createSeries.mock.calls[0]!;
    expect(input).toMatchObject({ ownerUserId: USER_ID, targetMode: 'all', recipientRule: { primaryContact: true, roles: [] }, internalCc: ['noc@msp.test'] });
    expect((auth as { partnerId: string }).partnerId).toBe(PARTNER_ID);
    expect(tx).toBe('tx');
    expect(options).toEqual({ mayAddDelivery: true });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'report_series.create', resourceType: 'report_series', resourceId: SERIES_ID,
      details: expect.objectContaining({ partnerId: PARTNER_ID, reconcile }),
    }));
  });

  it('passes mayAddDelivery=false without MFA or without reports:export (the store decides if it matters)', async () => {
    state.mfaSatisfied = false;
    await post('/reports/series', createBody());
    expect(store.createSeries.mock.calls[0]![3]).toEqual({ mayAddDelivery: false });
    state.mfaSatisfied = true;
    state.permissions = { permissions: [{ resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' }] };
    await post('/reports/series', createBody());
    expect(store.createSeries.mock.calls[1]![3]).toEqual({ mayAddDelivery: false });
  });

  it('maps ReportSeriesError from the store (owner ineligible → 400 with its reason)', async () => {
    store.createSeries.mockRejectedValue(new ReportSeriesError('series_owner_ineligible', 400, { reason: 'partner_access_not_all' }));
    const res = await post('/reports/series', createBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_owner_ineligible', reason: 'partner_access_not_all' });
  });
});

describe('PATCH /reports/series/:id', () => {
  const patch = (body: Record<string, unknown>) =>
    app().request(`/reports/series/${SERIES_ID}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

  it('refuses fields that are not shared definition fields (strict)', async () => {
    for (const body of [{ partnerId: PARTNER_ID }, { targetMode: 'selected' }, { type: 'compliance' }, { ownerUserId: USER_ID }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(store.updateSeries).not.toHaveBeenCalled();
  });

  it('refuses a one_time schedule', async () => {
    expect((await patch({ schedule: 'one_time' })).status).toBe(400);
  });

  it('parses config against the STORED type and the series rules', async () => {
    const res = await patch({ config: { filters: { deviceIds: [ORG_ID] } } });
    expect(store.loadOwnSeries).toHaveBeenCalledWith(SERIES_ID, expect.anything());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'series_config_org_specific', key: 'filters.deviceIds' });
  });

  it('answers 404 series_not_found from the store', async () => {
    store.updateSeries.mockRejectedValue(seriesNotFound());
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'series_not_found' });
  });

  it('updates and answers the fresh SeriesDetail', async () => {
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(store.updateSeries.mock.calls[0]![1]).toEqual({ name: 'Renamed' });
  });
});

describe('other series routes', () => {
  it('GET / answers { data: SeriesDetail[] }', async () => {
    const res = await app().request('/reports/series');
    expect(await res.json()).toEqual({ data: [detail] });
  });

  it('GET /:id rejects a non-uuid id before the store', async () => {
    expect((await app().request('/reports/series/not-a-uuid')).status).toBe(400);
    expect(store.getSeriesDetail).not.toHaveBeenCalled();
  });

  it('PUT /:id/targets validates accessibility and answers the SeriesDetail', async () => {
    const res = await app().request(`/reports/series/${SERIES_ID}/targets`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ targetMode: 'selected', orgIds: [ORG_ID] }),
    });
    expect(res.status).toBe(200);
    expect(store.replaceSeriesTargets.mock.calls[0]![1]).toEqual({ targetMode: 'selected', orgIds: [ORG_ID] });
  });

  it('POST /:id/transfer-owner answers the SeriesDetail and audits both owners', async () => {
    const next = '66666666-6666-4666-8666-666666666666';
    const res = await post(`/reports/series/${SERIES_ID}/transfer-owner`, JSON.stringify({ ownerUserId: next }));
    expect(res.status).toBe(200);
    expect(store.transferSeriesOwner.mock.calls[0]![1]).toBe(next);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'report_series.owner.transfer',
      details: expect.objectContaining({ previousOwnerUserId: USER_ID, ownerUserId: next }),
    }));
  });

  it('DELETE /:id answers { success, archivedChildren }', async () => {
    const res = await app().request(`/reports/series/${SERIES_ID}`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ success: true, archivedChildren: 3 });
  });

  it('POST /recipients/preview passes the unsaved form with seriesId null', async () => {
    store.previewSeriesRecipients.mockResolvedValue({ totalCustomerRecipients: 1, orgCount: 1, orgsWithoutCustomerRecipient: [] });
    const res = await post('/reports/series/recipients/preview', JSON.stringify({
      targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: ['billing'] },
    }));
    expect(res.status).toBe(200);
    expect(store.previewSeriesRecipients.mock.calls[0]![0]).toMatchObject({ seriesId: null, internalCc: [] });
  });
});

describe('mount order', () => {
  it('routes/reports/index.ts mounts /series before the core /:id routes', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src.indexOf("route('/series', reportSeriesRoutes)")).toBeGreaterThan(-1);
    expect(src.indexOf("route('/series', reportSeriesRoutes)")).toBeLessThan(src.indexOf("route('/', coreRoutes)"));
  });
});
```

Run: `cd apps/api && npx vitest run src/routes/reports/series.test.ts`
Expected: FAIL — `Failed to resolve import "./series"`.

- [ ] **Step 4: Implement the error mapper and schemas**

`apps/api/src/routes/reports/seriesErrors.ts`:

```ts
import type { Context } from 'hono';
import { ReportSeriesError } from '../../services/reportSeries/errors';

/**
 * The ONE mapper from ReportSeriesError to an HTTP answer (INDEX):
 * `{ error: code, ...body }` with the error's status. Anything else is
 * rethrown to the app's error handler (a 500 with the usual capture).
 */
export function seriesErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ReportSeriesError) {
    return c.json({ error: err.code, ...(err.body ?? {}) }, err.status);
  }
  throw err;
}
```

`apps/api/src/routes/reports/seriesSchemas.ts`:

```ts
import { z } from 'zod';
import { CONTACT_ROLES } from '../../services/contacts/types';
import { reportTypeSchema } from './schemas';

/** The same loose regex as ReportBuilder chips and the worker (schemas.ts emailRecipients). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const seriesRecipientRuleSchema = z.object({
  primaryContact: z.boolean(),
  roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length),
}).strict();

const internalCcSchema = z.array(z.string().trim().regex(EMAIL).max(254)).max(50);
/** Recurring only (INDEX): a one-time series would never run. */
const seriesScheduleSchema = z.enum(['daily', 'weekly', 'monthly']);
const formatSchema = z.enum(['csv', 'pdf', 'excel']);
const targetModeSchema = z.enum(['all', 'selected']);
const orgIdsSchema = z.array(z.string().guid()).max(1000);

/**
 * Loose (the builder round-trips presentation metadata); the route parses it
 * against the type's own schema (parseStoredReportConfig) and the series
 * rules. `emailRecipients` is refused: internalCc is its one home.
 */
const seriesConfigSchema = z.looseObject({}).superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, 'emailRecipients')) {
    ctx.addIssue({
      code: 'custom',
      path: ['emailRecipients'],
      message: 'Set internal CC addresses with internalCc, not config.emailRecipients',
    });
  }
});

function requireSelectedOrgs(value: { targetMode: 'all' | 'selected'; orgIds: string[] }, ctx: z.RefinementCtx): void {
  if (value.targetMode === 'selected' && value.orgIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['orgIds'], message: 'Chosen organizations needs at least one organization' });
  }
  if (new Set(value.orgIds).size !== value.orgIds.length) {
    ctx.addIssue({ code: 'custom', path: ['orgIds'], message: 'orgIds must not repeat' });
  }
}

export const createSeriesSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: reportTypeSchema,
  format: formatSchema.default('pdf'),
  schedule: seriesScheduleSchema,
  config: seriesConfigSchema.optional().default({}),
  targetMode: targetModeSchema.default('all'),
  orgIds: orgIdsSchema.default([]),
  recipientRule: seriesRecipientRuleSchema.default({ primaryContact: true, roles: [] }),
  internalCc: internalCcSchema.default([]),
  enabled: z.boolean().default(true),
  ownerUserId: z.string().guid().optional(),
}).strict().superRefine(requireSelectedOrgs);

/**
 * Shared definition fields only. `.strict()` refuses partnerId, type,
 * targetMode/orgIds (PUT /:id/targets) and ownerUserId (transfer-owner).
 */
export const updateSeriesSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  format: formatSchema.optional(),
  schedule: seriesScheduleSchema.optional(),
  config: seriesConfigSchema.optional(),
  recipientRule: seriesRecipientRuleSchema.optional(),
  internalCc: internalCcSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'No updates provided' });

export const replaceSeriesTargetsSchema = z.object({
  targetMode: targetModeSchema,
  orgIds: orgIdsSchema,
}).strict().superRefine(requireSelectedOrgs);

export const transferSeriesOwnerSchema = z.object({ ownerUserId: z.string().guid() }).strict();

export const previewSeriesRecipientsSchema = z.object({
  targetMode: targetModeSchema,
  orgIds: orgIdsSchema.default([]),
  recipientRule: seriesRecipientRuleSchema,
  internalCc: internalCcSchema.default([]),
}).strict().superRefine(requireSelectedOrgs);

export const seriesIdParamSchema = z.object({ id: z.string().guid() });
```

- [ ] **Step 5: Implement the routes**

`apps/api/src/routes/reports/series.ts`:

```ts
/**
 * Multi-org report series routes (spec §3.6), mounted at /reports/series
 * BEFORE the core /:id routes (routes/reports/index.ts). Thin: rules live in
 * services/reportSeries/*; this file gates, validates, maps errors through
 * seriesErrorResponse and audits. Every route requires partner scope with
 * org_access = 'all' (reads included — a series spans orgs a 'selected'
 * user cannot open).
 */
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import { db } from '../../db';
import { formatZodError, zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import {
  createSeries,
  deleteSeries,
  getSeriesDetail,
  listSeries,
  loadOwnSeries,
  previewSavedSeriesRecipients,
  previewSeriesRecipients,
  replaceSeriesTargets,
  seriesWriteAllowed,
  transferSeriesOwner,
  updateSeries,
} from '../../services/reportSeries/store';
import type { ReportSeriesRow } from '../../services/reportSeries/types';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from '../../services/reportSeries/validation';
import { callerMaySetEmailRecipients } from './recipientGate';
import { parseStoredReportConfig } from './schemas';
import { seriesErrorResponse } from './seriesErrors';
import {
  createSeriesSchema,
  previewSeriesRecipientsSchema,
  replaceSeriesTargetsSchema,
  seriesIdParamSchema,
  transferSeriesOwnerSchema,
  updateSeriesSchema,
} from './seriesSchemas';

export const reportSeriesRoutes = new Hono();

reportSeriesRoutes.use('*', authMiddleware);

const read = requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action);
const write = requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action);
const remove = requirePermission(PERMISSIONS.REPORTS_DELETE.resource, PERMISSIONS.REPORTS_DELETE.action);

function gate(auth: AuthContext): void {
  if (!seriesWriteAllowed(auth)) {
    throw new ReportSeriesError('series_write_denied', 403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  }
}

function assertTargetsAccessible(auth: AuthContext, orgIds: readonly string[]): void {
  const inaccessible = orgIds.filter((orgId) => !auth.canAccessOrg(orgId));
  if (inaccessible.length > 0) {
    throw new ReportSeriesError('series_target_org_inaccessible', 400, { orgIds: inaccessible });
  }
}

/** Same body shape as core.ts's stored-config refusal (path prefixed with `config`). */
function configValidationBody(error: z.ZodError) {
  return formatZodError({
    issues: error.issues.map((issue) => ({ ...issue, path: ['config', ...issue.path] })),
  });
}

function mayAddDelivery(c: Context, auth: AuthContext): boolean {
  return callerMaySetEmailRecipients(auth, c.get('permissions') as UserPermissions | undefined);
}

function auditSeries(c: Context, action: string, series: ReportSeriesRow, details: Record<string, unknown>): void {
  writeRouteAudit(c, {
    orgId: null,
    action,
    resourceType: 'report_series',
    resourceId: series.id,
    resourceName: series.name,
    details: { partnerId: series.partnerId, ...details },
  });
}

reportSeriesRoutes.get('/', requireScope('partner'), read, async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    return c.json({ data: await listSeries(auth) });
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});

reportSeriesRoutes.post(
  '/recipients/preview',
  requireScope('partner'),
  read,
  zValidator('json', previewSeriesRecipientsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const body = c.req.valid('json');
      assertTargetsAccessible(auth, body.orgIds);
      return c.json(await previewSeriesRecipients({ ...body, seriesId: null }, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.post('/', requireScope('partner'), write, zValidator('json', createSeriesSchema), async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    const body = c.req.valid('json');
    assertSeriesTypeSupported(body.type);
    const parsed = parseStoredReportConfig(body.type, body.config);
    if (!parsed.success) return c.json(configValidationBody(parsed.error), 400);
    assertSeriesConfigOrgAgnostic(parsed.data);
    assertTargetsAccessible(auth, body.orgIds);

    const created = await db.transaction((tx) => createSeries({
      ...body,
      type: body.type as ReportSeriesRow['type'],
      config: parsed.data,
      ownerUserId: body.ownerUserId ?? auth.user.id,
    }, auth, tx, { mayAddDelivery: mayAddDelivery(c, auth) }));

    auditSeries(c, 'report_series.create', created.series, {
      type: created.series.type,
      targetMode: created.series.targetMode,
      revision: created.series.revision,
      reconcile: created.reconcile,
    });
    return c.json(await getSeriesDetail(created.series.id, auth), 201);
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});

reportSeriesRoutes.get('/:id', requireScope('partner'), read, zValidator('param', seriesIdParamSchema), async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    return c.json(await getSeriesDetail(c.req.valid('param').id, auth));
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});

reportSeriesRoutes.get(
  '/:id/recipients/preview',
  requireScope('partner'),
  read,
  zValidator('param', seriesIdParamSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      return c.json(await previewSavedSeriesRecipients(c.req.valid('param').id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.patch(
  '/:id',
  requireScope('partner'),
  write,
  zValidator('param', seriesIdParamSchema),
  zValidator('json', updateSeriesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const { id } = c.req.valid('param');
      const patch = c.req.valid('json');
      let config: Record<string, unknown> | undefined;
      if (patch.config !== undefined) {
        // The series type is immutable, so reading it before the write
        // transaction cannot race.
        const current = await loadOwnSeries(id, auth);
        const parsed = parseStoredReportConfig(current.type, patch.config);
        if (!parsed.success) return c.json(configValidationBody(parsed.error), 400);
        assertSeriesConfigOrgAgnostic(parsed.data);
        config = parsed.data;
      }
      const updated = await db.transaction((tx) => updateSeries(
        id,
        { ...patch, ...(config !== undefined ? { config } : {}) },
        auth,
        tx,
        { mayAddDelivery: mayAddDelivery(c, auth) },
      ));
      auditSeries(c, 'report_series.update', updated.series, {
        changedFields: Object.keys(patch),
        revision: updated.series.revision,
        reconcile: updated.reconcile,
      });
      return c.json(await getSeriesDetail(id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.put(
  '/:id/targets',
  requireScope('partner'),
  write,
  zValidator('param', seriesIdParamSchema),
  zValidator('json', replaceSeriesTargetsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      assertTargetsAccessible(auth, body.orgIds);
      const replaced = await db.transaction((tx) =>
        replaceSeriesTargets(id, body, auth, tx, { mayAddDelivery: mayAddDelivery(c, auth) }));
      auditSeries(c, 'report_series.targets.replace', replaced.series, {
        targetMode: body.targetMode,
        orgCount: body.orgIds.length,
        revision: replaced.series.revision,
        reconcile: replaced.reconcile,
      });
      return c.json(await getSeriesDetail(id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.post(
  '/:id/transfer-owner',
  requireScope('partner'),
  write,
  zValidator('param', seriesIdParamSchema),
  zValidator('json', transferSeriesOwnerSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      gate(auth);
      const { id } = c.req.valid('param');
      const { ownerUserId } = c.req.valid('json');
      const moved = await db.transaction((tx) => transferSeriesOwner(id, ownerUserId, auth, tx));
      auditSeries(c, 'report_series.owner.transfer', moved.series, {
        previousOwnerUserId: moved.previousOwnerUserId,
        ownerUserId,
        reconcile: moved.reconcile,
      });
      return c.json(await getSeriesDetail(id, auth));
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);

reportSeriesRoutes.delete('/:id', requireScope('partner'), remove, zValidator('param', seriesIdParamSchema), async (c) => {
  try {
    const auth = c.get('auth');
    gate(auth);
    const { id } = c.req.valid('param');
    const deleted = await db.transaction((tx) => deleteSeries(id, auth, tx));
    auditSeries(c, 'report_series.delete', deleted.series, { archivedChildren: deleted.archivedChildren });
    return c.json({ success: true, archivedChildren: deleted.archivedChildren });
  } catch (err) {
    return seriesErrorResponse(c, err);
  }
});
```

- [ ] **Step 6: Mount and register**

`apps/api/src/routes/reports/index.ts` — import and mount FIRST:

```ts
import { Hono } from 'hono';
import { coreRoutes } from './core';
import { runsRoutes } from './runs';
import { dataRoutes } from './data';
import { generateRoutes } from './generate';
import { recipientsRoutes } from './recipients';
import { reportSeriesRoutes } from './series';

export const reportRoutes = new Hono();

// Multi-org report series (W02) go first: `/series` and `/series/:id` would
// otherwise reach core's `/:id` handlers.
reportRoutes.route('/series', reportSeriesRoutes);
// Mount data and generate routes first (they have /data/* and /generate prefixes
// that could conflict with /:id in core routes)
reportRoutes.route('/', dataRoutes);
reportRoutes.route('/', generateRoutes);
reportRoutes.route('/', runsRoutes);
reportRoutes.route('/', recipientsRoutes);
reportRoutes.route('/', coreRoutes);
```

`apps/api/src/services/mcpCoverage.ts`, after `'reports/runs.ts'`:

```ts
  // Multi-org report series (W02): generate_report lists and runs series
  // children like any org report; a series-management tool is a follow-up.
  'reports/series.ts': { tools: ['generate_report'] },
```

- [ ] **Step 7: Run everything**

Run: `cd apps/api && npx vitest run src/routes/reports/series.test.ts src/routes/reports/recipientGate.test.ts src/routes/reports/core.partnerOwned.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/routes/reports/partnerOwnedVisibility.scan.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/reports/recipientGate.ts apps/api/src/routes/reports/recipientGate.test.ts \
        apps/api/src/routes/reports/core.ts apps/api/src/routes/reports/seriesErrors.ts \
        apps/api/src/routes/reports/seriesSchemas.ts apps/api/src/routes/reports/series.ts \
        apps/api/src/routes/reports/series.test.ts apps/api/src/routes/reports/index.ts \
        apps/api/src/services/mcpCoverage.ts
git commit -m "feat(reports): /reports/series routes, shared recipient delivery gate, series error mapper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Schedule worker — due scan, gate, series recipients, repair sweep

**Files:**
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts` (imports; `validEmail`; `findDueReports` `pollable`; W01's `resolveScheduledReportRecipientSets` `mode` filter; new `resolveRunRecipientSets`, `loadGatedSeriesChild`, `recordSeriesSkip`; `processRunScheduledReport` head + W01 delivery seam; `processCheckSchedules`)
- Create: `apps/api/src/jobs/reportScheduleWorker.series.test.ts`
- Modify: `apps/api/src/jobs/reportScheduleWorker.due.test.ts` (new describe)
- Modify: `apps/api/src/jobs/reportScheduleWorker.test.ts` (schema-mock keys + reconcile mock)
- Modify: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` (`loadGatedSeriesChild`)

**Interfaces:**
- Consumes: `seriesChildGate`, `reconcileAllSeries` (Task 6); `resolveSeriesChildRecipients`, `isValidRecipientEmail` (Task 5); `parseSeriesRecipientRule`, `SeriesGateDecision` (Task 3); from W01 (its plan, Tasks 2–3): `ScheduledRecipientSets { customer; cc; recipients; dropped }`, `resolveScheduledReportRecipientSets(args)`, and the delivery tail in `processRunScheduledReport` that calls it and records `deliveryStatus` / `recipientCount: recipientSets.customer.length`.
- Produces: `resolveRunRecipientSets(args: { reportId: string; seriesId: string | null; orgId: string | null; config: Record<string, unknown> }): Promise<ScheduledRecipientSets>` — a series child's sets come from the series rule + overrides + internal CC; every other report returns W01's `resolveScheduledReportRecipientSets` unchanged. Because it returns W01's exact shape, W01's delivery tail (`recipientCount: recipientSets.customer.length`, `scheduledDeliveryStatus({ deliverable, dropped, send })`) needs no other edit, and the INDEX `recipient_count` ruling (series child = customer only) falls out of `customer` excluding the CC.

**Decision recorded here:** `remove` rows exist only on series children (Task 10 refuses them elsewhere). `resolveScheduledReportRecipients` still filters `mode = 'add'` — every existing row is `add`, so non-series output is byte-for-byte unchanged, and a `remove` row can never be mistaken for a recipient.

- [ ] **Step 1: Write the failing due-scan test**

Append to `apps/api/src/jobs/reportScheduleWorker.due.test.ts`:

```ts
describe('findDueReports — multi-org report series (W02)', () => {
  beforeEach(() => {
    selectCalls.length = 0;
    selectResults.length = 0;
  });

  it('never polls an archived child or a child of a disabled series, in BOTH statements, with no new params', async () => {
    selectResults.push([], [{ count: 0 }]);
    await findDueReports(new Date('2026-07-01T07:30:00Z'));
    const [dueQuery, skippedQuery] = selectCalls;
    for (const call of [dueQuery!, skippedQuery!]) {
      const where = compile(call.where);
      expect(where.sql).toContain('"reports"."archived_at" is null');
      expect(where.sql).toContain(
        'NOT EXISTS (SELECT 1 FROM report_series rs WHERE rs.id = "reports"."series_id" AND rs.enabled = false)',
      );
    }
    // The pollable prefix still binds exactly three params (one_time + the two
    // worker-excluded types), so the existing complete-scope offsets hold.
    expect(compile(dueQuery!.where).params.slice(0, 3)).toEqual(['one_time', 'ai_org_narrative', 'ai_fleet_design']);
  });
});
```

Run: `cd apps/api && npx vitest run src/jobs/reportScheduleWorker.due.test.ts`
Expected: FAIL — the new case's `"reports"."archived_at" is null` assertion.

- [ ] **Step 2: Write the failing worker series suite**

`apps/api/src/jobs/reportScheduleWorker.series.test.ts`:

```ts
/**
 * Multi-org report series W02 — the schedule worker's series gate, series
 * recipients and repair sweep (spec §3.3, §3.5; §5 W02 "Worker test").
 * db is faked positionally; the schema and drizzle are real so recorded WHERE
 * clauses compile to the SQL Postgres would receive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const q = vi.hoisted(() => ({
  selects: [] as unknown[][],
  wheres: [] as unknown[],
  inserts: [] as Array<Record<string, unknown>>,
  order: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); close = vi.fn(); },
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));
vi.mock('../db', () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit']) c[m] = () => c;
    c.where = (w: unknown) => { q.wheres.push(w); return c; };
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: vi.fn(() => { q.order.push('select'); return chain(q.selects.shift() ?? []); }),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          q.inserts.push(values);
          const done = Promise.resolve([{ id: 'run-1', ...values }]);
          return {
            returning: () => done,
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => done.then(resolve, reject),
          };
        },
      })),
      update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => false), getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../config/env', () => ({ breezeRole: () => 'all' }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const series = vi.hoisted(() => ({ gate: vi.fn(), sweep: vi.fn(), childRecipients: vi.fn() }));
vi.mock('../services/reportSeries/reconcile', () => ({
  seriesChildGate: series.gate,
  reconcileAllSeries: series.sweep,
}));
vi.mock('../services/reportSeries/recipients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/reportSeries/recipients')>()),
  resolveSeriesChildRecipients: series.childRecipients,
}));

import {
  processCheckSchedules,
  processRunScheduledReport,
  resolveRunRecipientSets,
  resolveScheduledReportRecipients,
} from './reportScheduleWorker';

const REPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SERIES_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const job = { type: 'run-scheduled-report' as const, reportId: REPORT_ID, occurrenceKey: 202610010900 };

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID, orgId: ORG_ID, partnerId: null, name: 'Monthly summary', type: 'executive_summary',
    schedule: 'monthly', format: 'pdf', config: {}, seriesId: SERIES_ID, seriesRevision: 1, archivedAt: null,
    executionScopePrincipalKind: 'user', executionScopeUserId: USER_ID, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  q.selects = [];
  q.wheres = [];
  q.inserts = [];
  q.order = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  series.sweep.mockImplementation(async () => { q.order.push('sweep'); });
});

describe('processRunScheduledReport — series gate', () => {
  it.each([
    ['skip_untargeted', 'series_skip_untargeted'],
    ['skip_disabled', 'series_skip_disabled'],
    ['skip_archived', 'series_skip_archived'],
    ['blocked_no_authority', 'series_blocked_no_authority'],
  ])('a child the gate answers %s is recorded as a skip and never generated', async (decision, reason) => {
    series.gate.mockResolvedValue(decision);
    q.selects = [[child()]];
    await processRunScheduledReport(job, { finalAttempt: true });
    expect(series.gate).toHaveBeenCalledWith({
      id: REPORT_ID, orgId: ORG_ID, seriesId: SERIES_ID, seriesRevision: 1, archivedAt: null,
    });
    expect(q.inserts).toEqual([expect.objectContaining({
      reportId: REPORT_ID, status: 'failed', errorMessage: reason, requestedByKind: null,
    })]);
    expect(q.order).toEqual(['select']);
  });

  it("on 'run' the worker re-reads the row and runs the CURRENT definition", async () => {
    series.gate.mockResolvedValue('run');
    // The re-read row is system-principal: the worker's early deny proves the
    // fresh row (not the queued one) is what runs.
    q.selects = [[child()], [child({ executionScopePrincipalKind: 'system', executionScopeUserId: null })]];
    await processRunScheduledReport(job, { finalAttempt: true });
    expect(q.order).toEqual(['select', 'select']);
    expect(q.inserts[0]).toMatchObject({ errorMessage: 'system_principal_definition' });
  });

  it('an ordinary report never reaches the series gate', async () => {
    q.selects = [[child({ seriesId: null, seriesRevision: null, executionScopePrincipalKind: 'system', executionScopeUserId: null })]];
    await processRunScheduledReport(job, { finalAttempt: true });
    expect(series.gate).not.toHaveBeenCalled();
    expect(q.inserts[0]).toMatchObject({ errorMessage: 'system_principal_definition' });
  });
});

describe('processCheckSchedules — repair sweep', () => {
  it('runs the sweep before the due scan', async () => {
    q.selects = [[], [{ count: 0 }]];
    await processCheckSchedules();
    expect(q.order).toEqual(['sweep', 'select', 'select']);
  });

  // Review Focus 5.
  it('still scans due reports when the sweep rejects', async () => {
    series.sweep.mockRejectedValue(new Error('sweep down'));
    q.selects = [[], [{ count: 0 }]];
    await expect(processCheckSchedules()).resolves.toBeUndefined();
    expect(q.order).toEqual(['select', 'select']);
  });
});

describe('resolveRunRecipientSets', () => {
  it('a series child: customer = rule/overrides, cc = internal CC, recipients = deduped union', async () => {
    q.selects = [[{ recipientRule: { primaryContact: true, roles: ['billing'] } }]];
    series.childRecipients.mockResolvedValue({ customer: ['a@acme.test'], cc: ['noc@msp.test', 'A@acme.test'], dropped: 1 });
    const out = await resolveRunRecipientSets({
      reportId: REPORT_ID, seriesId: SERIES_ID, orgId: ORG_ID, config: { emailRecipients: ['noc@msp.test'] },
    });
    expect(series.childRecipients).toHaveBeenCalledWith({
      reportId: REPORT_ID, orgId: ORG_ID, rule: { primaryContact: true, roles: ['billing'] }, internalCc: ['noc@msp.test'],
    });
    // recipient_count (INDEX ruling) is customer.length = 1: the CC is not a customer.
    expect(out).toEqual({
      customer: ['a@acme.test'],
      cc: ['noc@msp.test', 'A@acme.test'],
      recipients: ['a@acme.test', 'noc@msp.test'],
      dropped: 1,
    });
  });

  it('an ordinary report returns W01\'s sets unchanged (cc always empty)', async () => {
    q.selects = [[]];
    const out = await resolveRunRecipientSets({
      reportId: REPORT_ID, seriesId: null, orgId: ORG_ID, config: { emailRecipients: ['ops@x.test'] },
    });
    expect(out).toEqual({ customer: ['ops@x.test'], cc: [], recipients: ['ops@x.test'], dropped: 0 });
    expect(series.childRecipients).not.toHaveBeenCalled();
  });

  // Review Focus 2 (belt): a 'remove' row is never read as a recipient.
  it("resolveScheduledReportRecipients reads only mode = 'add' rows", async () => {
    q.selects = [[]];
    await resolveScheduledReportRecipients({ reportId: REPORT_ID, orgId: ORG_ID, config: {} });
    const { sql, params } = new PgDialect().sqlToQuery(q.wheres[0] as SQL);
    expect(sql).toContain('"report_schedule_recipients"."mode" = $');
    expect(params).toContain('add');
  });
});
```

Run: `cd apps/api && npx vitest run src/jobs/reportScheduleWorker.series.test.ts`
Expected: FAIL — `resolveRunRecipientSets` is not exported / the gate is never called.

- [ ] **Step 3: Implement the worker changes**

In `apps/api/src/jobs/reportScheduleWorker.ts`:

(a) Imports — add `reportSeries` to the `../db/schema` import list (`MAX_SCHEDULED_RECIPIENTS`, `ScheduledRecipientSets` and `resolveScheduledReportRecipientSets` are W01's, already in this file), and:

```ts
import { reconcileAllSeries, seriesChildGate } from '../services/reportSeries/reconcile';
import { isValidRecipientEmail, resolveSeriesChildRecipients } from '../services/reportSeries/recipients';
import { parseSeriesRecipientRule, type SeriesGateDecision } from '../services/reportSeries/types';
```

(b) In `findDueReports`, replace the `pollable` constant:

```ts
  // Applied to BOTH statements below — see WORKER_EXCLUDED_REPORT_TYPES.
  // Multi-org report series W02: an ARCHIVED child never schedules (spec
  // §3.3), and a child of a DISABLED series is not polled at all — the gate
  // would only record a skip row per org per occurrence (plan Contract
  // concern 8). Both are true for every non-series row and bind no params.
  const pollable = and(
    ne(reports.schedule, 'one_time'),
    notInArray(reports.type, [...WORKER_EXCLUDED_REPORT_TYPES]),
    isNull(reports.archivedAt),
    sql`NOT EXISTS (SELECT 1 FROM report_series rs WHERE rs.id = ${reports.seriesId} AND rs.enabled = false)`,
  )!;
```

(c) Replace `function validEmail(...) { ... }` with:

```ts
/** One regex for every recipient path (services/reportSeries/recipients.ts). */
const validEmail = isValidRecipientEmail;
```

(d) In W01's `resolveScheduledReportRecipientSets` (it replaced the body of `resolveScheduledReportRecipients`, which now delegates to it), add the mode arm to the contact query's `.where(and(...))`:

```ts
    .where(and(
      eq(reportScheduleRecipients.reportId, args.reportId),
      eq(reportScheduleRecipients.orgId, args.orgId),
      eq(contacts.orgId, args.orgId),
      // Multi-org report series W02: 'remove' rows are per-org exclusions on a
      // series child and never recipients. Every legacy row is 'add'.
      eq(reportScheduleRecipients.mode, 'add'),
    ));
```

(e) Directly after W01's `resolveScheduledReportRecipients`, add:

```ts
/**
 * Multi-org report series W02 (spec §3.5; INDEX recipient_count ruling). A
 * series child mails (rule matches ∪ 'add' rows − 'remove' rows) plus the
 * series internal CC (materialized as its config.emailRecipients). It returns
 * W01's ScheduledRecipientSets shape, so the delivery tail records
 * recipient_count = customer.length (CC excluded) and 'partial' from
 * `dropped` with no series branch of its own. Every other report returns
 * resolveScheduledReportRecipientSets byte for byte.
 */
export async function resolveRunRecipientSets(args: {
  reportId: string;
  seriesId: string | null;
  orgId: string | null;
  config: Record<string, unknown>;
}): Promise<ScheduledRecipientSets> {
  if (args.seriesId === null || args.orgId === null) {
    return resolveScheduledReportRecipientSets({
      reportId: args.reportId,
      orgId: args.orgId,
      config: args.config,
    });
  }
  const [series] = await db
    .select({ recipientRule: reportSeries.recipientRule })
    .from(reportSeries)
    .where(eq(reportSeries.id, args.seriesId))
    .limit(1);
  const internalCc = Array.isArray(args.config.emailRecipients)
    ? args.config.emailRecipients.filter((value): value is string => typeof value === 'string')
    : [];
  const { customer, cc, dropped } = await resolveSeriesChildRecipients({
    reportId: args.reportId,
    orgId: args.orgId,
    rule: parseSeriesRecipientRule(series?.recipientRule),
    internalCc,
  });
  const deduped = new Map<string, string>();
  for (const email of [...customer, ...cc]) {
    const key = email.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, email);
  }
  const all = [...deduped.values()];
  if (all.length > MAX_SCHEDULED_RECIPIENTS) {
    console.warn('[ReportScheduleWorker] Recipient union exceeds 50; truncating', {
      reportId: args.reportId,
      requested: all.length,
    });
  }
  return {
    customer,
    cc,
    recipients: all.slice(0, MAX_SCHEDULED_RECIPIENTS),
    dropped: dropped + Math.max(0, all.length - MAX_SCHEDULED_RECIPIENTS),
  };
}

type ScheduledReportRow = typeof reports.$inferSelect;

/**
 * Multi-org report series W02 — a skipped child leaves a failed run row
 * naming the gate decision (spec §3.3 "records the skip"), with the all-NULL
 * envelope the org-axis run predicates already admit.
 */
async function recordSeriesSkip(
  reportId: string,
  decision: Exclude<SeriesGateDecision, 'run'>,
): Promise<void> {
  console.warn('[ReportScheduleWorker] Series child skipped by the series gate', { reportId, decision });
  await db.insert(reportRuns).values({
    reportId,
    status: 'failed',
    completedAt: new Date(),
    errorMessage: `series_${decision}`,
    requestedByKind: null,
    requestedByUserId: null,
    requestedByPortalUserId: null,
  });
}

/**
 * Multi-org report series W02 (spec §3.3 "Worker gate"). Runs the gate and,
 * on 'run', re-reads the row: the gate may have reconciled a stale child, and
 * the run must use the CURRENT definition. null = skipped (recorded) or gone.
 */
async function loadGatedSeriesChild(
  report: ScheduledReportRow & { seriesId: string; orgId: string },
): Promise<ScheduledReportRow | null> {
  const decision = await seriesChildGate({
    id: report.id,
    orgId: report.orgId,
    seriesId: report.seriesId,
    seriesRevision: report.seriesRevision,
    archivedAt: report.archivedAt,
  });
  if (decision !== 'run') {
    await recordSeriesSkip(report.id, decision);
    return null;
  }
  const [fresh] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, report.id), ne(reports.schedule, 'one_time')))
    .limit(1);
  return fresh ?? null;
}
```

(f) At the top of `processRunScheduledReport`, replace the load (keep the `WORKER_EXCLUDED_REPORT_TYPES` block and its exact text — `reportScheduleWorker.contract.test.ts` pins `(WORKER_EXCLUDED_REPORT_TYPES as readonly string[]).includes(report.type)`):

```ts
  const [loadedReport] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, data.reportId), ne(reports.schedule, 'one_time')))
    .limit(1);
  if (!loadedReport) return; // deleted or switched to one_time since enqueue
  let report: NonNullable<typeof loadedReport> = loadedReport;
```

and, immediately after the existing `WORKER_EXCLUDED_REPORT_TYPES` early-return block:

```ts
  // Multi-org report series W02: a child passes the series gate (enabled,
  // still targeted, owner still eligible, current revision) BEFORE any
  // authority resolution or run row. Closes the "queued before the org was
  // excluded" race (spec §3.3).
  if (report.seriesId !== null && report.orgId !== null) {
    const gated = await loadGatedSeriesChild({ ...report, seriesId: report.seriesId, orgId: report.orgId });
    if (!gated) return;
    report = gated;
  }
```

(g) The W01 seam. W01 Task 3 made the post-generation delivery tail read `const recipientSets = await resolveScheduledReportRecipientSets({ reportId: report.id, orgId: owner.orgId ?? null, config });` and record `recipientCount: recipientSets.customer.length`. Change ONLY that call:

```ts
    const recipientSets = await resolveRunRecipientSets({
      reportId: report.id,
      seriesId: report.seriesId,
      orgId: owner.orgId ?? null,
      config,
    });
```

W01 left the `opts.finalAttempt` failure-notice call as `resolveScheduledReportRecipients({ … })`; replace it so a series child's failure notice reaches the same people as its report:

```ts
      const recipients = (await resolveRunRecipientSets({
        reportId: report.id,
        seriesId: report.seriesId,
        orgId: owner.orgId ?? null,
        config,
      })).recipients;
```

(h) `processCheckSchedules` — sweep first, isolated:

```ts
export async function processCheckSchedules(): Promise<void> {
  // Multi-org report series W02 (spec §3.3 trigger 2): the repair sweep runs
  // first so a child it creates is due in this same tick. It isolates each
  // series itself; this catch keeps a sweep-wide failure from costing every
  // ordinary scheduled report its tick.
  try {
    await reconcileAllSeries();
  } catch (err) {
    console.error('[ReportScheduleWorker] Report series repair sweep failed; continuing with the due scan', err);
    captureException(err);
  }

  const due = await findDueReports(new Date());
```

(the rest of the function is unchanged).

- [ ] **Step 4: Keep the existing worker suite's mocks complete**

In `apps/api/src/jobs/reportScheduleWorker.test.ts`, extend the `../db/schema` mock's `reports` object with `seriesId: 'reports.series_id', seriesRevision: 'reports.series_revision', archivedAt: 'reports.archived_at',`, its `reportScheduleRecipients` object with `mode: 'report_schedule_recipients.mode',`, add a sibling entry `reportSeries: { id: 'report_series.id', recipientRule: 'report_series.recipient_rule' },`, and add below the existing `vi.mock` calls:

```ts
vi.mock('../services/reportSeries/reconcile', () => ({
  reconcileAllSeries: vi.fn(async () => undefined),
  seriesChildGate: vi.fn(async () => 'run'),
}));
```

Every fixture row in that file has no `seriesId`, so none reaches the gate. If a pre-existing assertion enumerates the recipient query's WHERE equalities, add the `mode = 'add'` arm to its expectation — that is the one intended change.

- [ ] **Step 5: Register the new query site**

In `partnerOwnedVisibility.scan.test.ts` `SITE_ALLOWLIST`, extend the `src/jobs/reportScheduleWorker.ts` map:

```ts
    ['loadGatedSeriesChild', pinned(1, 'system DB context re-read by id of the series child the job named, after seriesChildGate admitted it; series children are org-owned (reports_series_child_shape_chk) and processRunScheduledReport re-authorizes it exactly like any org-owned row', AUD_WORKER)],
```

- [ ] **Step 6: Run the worker suites and contracts**

Run: `cd apps/api && npx vitest run src/jobs/reportScheduleWorker.series.test.ts src/jobs/reportScheduleWorker.due.test.ts src/jobs/reportScheduleWorker.test.ts src/jobs/reportScheduleWorker.contract.test.ts src/jobs/reportScheduleWorker.claimSql.test.ts src/routes/reports/partnerOwnedVisibility.scan.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.series.test.ts \
        apps/api/src/jobs/reportScheduleWorker.due.test.ts apps/api/src/jobs/reportScheduleWorker.test.ts \
        apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts
git commit -m "feat(reports): schedule worker series gate, series recipients and repair sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Child writers — `series_managed` refusals, Detach, recipient overrides, AI tool

**Files:**
- Modify: `apps/api/src/routes/reports/helpers.ts` (`reportDefinitionMetadataProjection` gains `seriesId`, `archivedAt`)
- Modify: `apps/api/src/routes/reports/core.ts` (PUT/reauthorize/DELETE refusal; `POST /:id/detach`; `'series'` in the `GET /:id` non-UUID guard)
- Modify: `apps/api/src/routes/reports/recipients.ts` (`mode` read/write; convert refusal; delivery gate on a child `add`)
- Modify: `apps/api/src/routes/reports/schemas.ts` (`addReportRecipientSchema.mode`)
- Modify: `apps/api/src/services/aiToolsFleet.ts:3224-3282` (update/delete refuse children; `series_id IS NULL` in both WHEREs)
- Test (append): `apps/api/src/routes/reports/core.partnerOwned.test.ts`, `apps/api/src/routes/reports/recipients.test.ts`, `apps/api/src/services/aiToolsFleet.reportAudience.test.ts`

**Interfaces:**
- Consumes: `seriesManagedRefusal` (Task 3), `ReportSeriesError` (Task 3), `finishDetach`, `seriesWriteAllowed` (Task 7), `seriesErrorResponse`, `callerMaySetEmailRecipients`, `RECIPIENTS_NEED_EXPORT_AND_MFA` (Task 8).
- Produces: `POST /reports/:id/detach` → 200 with the detached (now standalone, still active) report row; 403 `series_write_denied`; 409 `report_not_series_child`; 404. `POST /reports/:id/recipients` body `{ contactId, mode? }`; `GET /reports/:id/recipients` rows carry `mode`.

- [ ] **Step 1: Write the failing core tests**

In `apps/api/src/routes/reports/core.partnerOwned.test.ts`, add after the existing `vi.mock('../../services/siteScope', …)` block:

```ts
const seriesStore = vi.hoisted(() => ({
  finishDetach: vi.fn(async () => ({ added: 1, removedDropped: 0 })),
}));
vi.mock('../../services/reportSeries/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportSeries/store')>();
  return { ...actual, finishDetach: seriesStore.finishDetach };
});
```

and append at the end of the file:

```ts
/**
 * Multi-org report series W02 (spec §3.3 "Child writers", §3.6 Detach). A
 * child's shared fields belong to its series: PUT, reauthorize and DELETE
 * answer 409 series_managed; Detach is the one way out.
 */
describe('multi-org report series children (W02)', () => {
  const SERIES_ID = '77777777-7777-4777-8777-777777777777';
  function childRow(overrides: Record<string, unknown> = {}) {
    return {
      id: REPORT_ID, orgId: ORG_ID, partnerId: null, name: 'Monthly summary', type: 'executive_summary',
      config: {}, schedule: 'monthly', format: 'pdf', createdBy: USER_ID,
      executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null,
      executionScopeUserId: USER_ID,
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
      executionScopeCapturedAt: CAPTURED_AT, executionScopePrincipalKind: 'user', portalSelfService: false,
      seriesId: SERIES_ID, seriesRevision: 1, archivedAt: null, ...overrides,
    };
  }
  const standalone = () => childRow({ seriesId: null, seriesRevision: null });

  it('PUT on a child answers 409 series_managed and never updates', async () => {
    state.rows = [childRow(), childRow()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'series_managed', seriesId: SERIES_ID });
    expect(state.updates).toHaveLength(0);
  });

  it('reauthorize on a child answers 409 series_managed (its scope belongs to the series owner)', async () => {
    state.rows = [childRow(), childRow()];
    const res = await app().request(`/reports/${REPORT_ID}/reauthorize`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(state.updates).toHaveLength(0);
  });

  it('DELETE on a child answers 409 series_managed and deletes nothing', async () => {
    state.rows = [childRow(), childRow()];
    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(state.deletes).toHaveLength(0);
  });

  it('a standalone org report is still editable (byte-for-byte)', async () => {
    state.rows = [standalone(), standalone()];
    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });

  it('GET /reports/series on the core router is a 404 without any query', async () => {
    const res = await app().request('/reports/series');
    expect(res.status).toBe(404);
    expect(state.wheres).toHaveLength(0);
  });

  describe('POST /reports/:id/detach', () => {
    // Review Focus 1 + 2: finishDetach un-targets the org and materializes recipients.
    it('clears series_id + series_revision, hands off to finishDetach, and audits', async () => {
      state.rows = [childRow(), childRow()];
      const res = await app().request(`/reports/${REPORT_ID}/detach`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0]!.set).toMatchObject({ seriesId: null, seriesRevision: null });
      expect(seriesStore.finishDetach).toHaveBeenCalledWith(
        expect.anything(),
        { seriesId: SERIES_ID, orgId: ORG_ID, reportId: REPORT_ID },
        expect.objectContaining({ partnerId: PARTNER_ID }),
      );
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG_ID, action: 'report.detach', details: expect.objectContaining({ seriesId: SERIES_ID }),
      }));
    });

    it("refuses a 'selected' partner user before any read", async () => {
      state.auth = partnerAuth('selected');
      const res = await app().request(`/reports/${REPORT_ID}/detach`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'series_write_denied' });
      expect(state.wheres).toHaveLength(0);
    });

    it('refuses a standalone report and an archived child with 409 report_not_series_child', async () => {
      state.rows = [standalone(), standalone()];
      const first = await app().request(`/reports/${REPORT_ID}/detach`, { method: 'POST' });
      expect(first.status).toBe(409);
      expect(await first.json()).toEqual({ error: 'report_not_series_child' });
      state.rows = [childRow({ archivedAt: new Date() }), childRow({ archivedAt: new Date() })];
      expect((await app().request(`/reports/${REPORT_ID}/detach`, { method: 'POST' })).status).toBe(409);
      expect(state.updates).toHaveLength(0);
      expect(seriesStore.finishDetach).not.toHaveBeenCalled();
    });
  });
});
```

Run: `cd apps/api && npx vitest run src/routes/reports/core.partnerOwned.test.ts -t "multi-org report series children"`
Expected: FAIL — PUT answers 200, `/detach` answers 404.

- [ ] **Step 2: Implement the core changes**

`apps/api/src/routes/reports/helpers.ts` — in `reportDefinitionMetadataProjection`, after `portalSelfService`:

```ts
  // Multi-org report series W02: the write routes refuse a series child
  // (series_managed) and Detach reads both from the same locked projection.
  seriesId: reports.seriesId,
  archivedAt: reports.archivedAt,
```

`apps/api/src/routes/reports/core.ts`:

- Imports: add `isNull` to the `drizzle-orm` import, and

```ts
import { ReportSeriesError } from '../../services/reportSeries/errors';
import { finishDetach, seriesWriteAllowed } from '../../services/reportSeries/store';
import { seriesManagedRefusal } from '../../services/reportSeries/types';
import { seriesErrorResponse } from './seriesErrors';
```

- `GET /:id` guard list: `if (['runs', 'data', 'generate', 'templates', 'series'].includes(reportId)) {`

- PUT `/:id`, inside the transaction right after `if (!locked) return null;`:

```ts
      // Multi-org report series W02 (spec §3.3 "Child writers"): a child's
      // shared fields belong to its series; only recipient overrides and
      // Detach change a child outside the reconciler.
      if (locked.locked.seriesId) return { seriesManaged: locked.locked.seriesId };
```

  and in the response mapping, right after `if (!mutation) { return c.json(REPORT_NOT_FOUND, 404); }`:

```ts
    if ('seriesManaged' in mutation) {
      return c.json(seriesManagedRefusal(mutation.seriesManaged), 409);
    }
```

- POST `/:id/reauthorize`, right after `if (!locked) return { kind: 'not_found' as const };`:

```ts
      if (locked.locked.seriesId) {
        return { kind: 'series_managed' as const, seriesId: locked.locked.seriesId };
      }
```

  and first in the response mapping:

```ts
    if (result.kind === 'series_managed') {
      return c.json(seriesManagedRefusal(result.seriesId), 409);
    }
```

- DELETE `/:id`, right after `if (!locked) return null;`:

```ts
      // Exclude the org from the series (or detach it) instead: a deleted
      // child would be re-created by the next reconcile.
      if (locked.locked.seriesId) {
        return { kind: 'series_managed' as const, seriesId: locked.locked.seriesId };
      }
```

  and first in the response mapping (before `if (deleted === SYSTEM_MANAGED)`):

```ts
    if (deleted !== null && typeof deleted === 'object' && deleted.kind === 'series_managed') {
      return c.json(seriesManagedRefusal(deleted.seriesId), 409);
    }
```

- New route, directly after POST `/:id/reauthorize`:

```ts
// POST /reports/:id/detach — Multi-org report series W02 (spec §3.6, D5).
// Turns a series child into a standalone org report: clears series_id (no
// series revision bump), un-targets the org so the reconciler never mints a
// replacement, and keeps its current customers receiving it (finishDetach).
coreRoutes.post(
  '/:id/detach',
  requireScope('partner'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;
    const permissions = c.get('permissions') as UserPermissions | undefined;
    try {
      if (!seriesWriteAllowed(auth)) {
        throw new ReportSeriesError('series_write_denied', 403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      }
      const detached = await db.transaction(async (tx) => {
        const locked = await loadLockedDefinition(tx, reportId, auth, 'write', permissions);
        if (
          locked === SYSTEM_MANAGED
          || locked === PARTNER_WIDE_DENIED
          || locked === AUDIENCE_DENIED
          || !locked
        ) {
          return null;
        }
        const seriesId = locked.locked.seriesId;
        const orgId = locked.locked.orgId;
        if (!seriesId || !orgId || locked.locked.archivedAt !== null) {
          throw new ReportSeriesError('report_not_series_child', 409);
        }
        const [row] = await tx
          .update(reports)
          .set({ seriesId: null, seriesRevision: null, updatedAt: new Date() })
          .where(and(
            eq(reports.id, reportId),
            eq(reports.orgId, orgId),
            eq(reports.seriesId, seriesId),
            isNull(reports.archivedAt),
          ))
          .returning();
        if (!row) return null;
        const recipients = await finishDetach(tx, { seriesId, orgId, reportId }, auth);
        return { row, seriesId, orgId, recipients };
      });
      if (!detached) return c.json(REPORT_NOT_FOUND, 404);
      writeRouteAudit(c, {
        orgId: detached.orgId,
        action: 'report.detach',
        resourceType: 'report',
        resourceId: detached.row.id,
        resourceName: detached.row.name,
        details: {
          seriesId: detached.seriesId,
          recipientsMaterialized: detached.recipients.added,
          removeOverridesDropped: detached.recipients.removedDropped,
        },
      });
      return c.json(detached.row);
    } catch (err) {
      return seriesErrorResponse(c, err);
    }
  },
);
```

Run: `cd apps/api && npx vitest run src/routes/reports/core.partnerOwned.test.ts`
Expected: PASS (all pre-existing cases plus the new block).

- [ ] **Step 3: Write the failing recipient-route tests**

In `apps/api/src/routes/reports/recipients.test.ts` make the harness carry the permission set and the new insert method:

- `state`: add `permissionSet: { permissions: [{ resource: '*', action: '*' }] } as unknown,`, `gateMfa: true,`, `conflictUpdates: [] as unknown[],`.
- `requirePermission` mock: add `c.set('permissions', state.permissionSet);` before `await next();`.
- `../../middleware/auth` mock: add `hasSatisfiedMfa: () => state.gateMfa,`.
- `../../services/permissions` mock: add `REPORTS_EXPORT: { resource: 'reports', action: 'export' },` and
  `hasPermission: (perms: any, resource: string, action: string) => (perms?.permissions ?? []).some((p: any) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*')),`.
- `../../db/schema` mock: add `mode: 'recipients.mode',` to `reportScheduleRecipients`.
- `database().insert(...).values(...)` return object: add
  ```ts
  onConflictDoUpdate: vi.fn((config: unknown) => {
    state.conflictUpdates.push(config);
    return { returning: vi.fn(() => Promise.resolve([{ id: 'recipient-1' }])) };
  }),
  ```
- `beforeEach`: reset `state.permissionSet = { permissions: [{ resource: '*', action: '*' }] }; state.gateMfa = true; state.conflictUpdates.length = 0;`.

Append:

```ts
describe('series child recipient overrides (W02)', () => {
  const SERIES_ID = '77777777-7777-4777-8777-777777777777';
  const child = () => ({ id: REPORT_ID, orgId: ORG_ID, seriesId: SERIES_ID, config: { emailRecipients: ['noc@msp.test'] } });

  it("refuses mode 'remove' on an ordinary report (it would be ignored and still send)", async () => {
    const res = await app().request(`/${REPORT_ID}/recipients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: CONTACT_ID, mode: 'remove' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'recipient_mode_requires_series' });
    expect(state.inserted).toHaveLength(0);
  });

  it("stores a 'remove' override on a child, upserting the mode", async () => {
    state.getReport.mockResolvedValue(child());
    state.results.push([{ id: CONTACT_ID }]);
    const res = await app().request(`/${REPORT_ID}/recipients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: CONTACT_ID, mode: 'remove' }),
    });
    expect(res.status).toBe(201);
    expect(state.inserted[0]?.value).toMatchObject({ reportId: REPORT_ID, orgId: ORG_ID, contactId: CONTACT_ID, mode: 'remove' });
    expect(state.conflictUpdates[0]).toMatchObject({ set: { mode: 'remove' } });
  });

  it("an 'add' override on a child is a new delivery: export + MFA required", async () => {
    state.getReport.mockResolvedValue(child());
    state.gateMfa = false;
    const res = await app().request(`/${REPORT_ID}/recipients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: CONTACT_ID }),
    });
    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it('convert on a child answers 409 series_managed (it rewrites the series internal CC)', async () => {
    state.getReport.mockResolvedValue(child());
    const res = await app().request(`/${REPORT_ID}/recipients/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-mfa': 'satisfied' },
      body: JSON.stringify({ email: 'new@acme.test' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'series_managed', seriesId: SERIES_ID });
    expect(state.updated).toHaveLength(0);
  });
});
```

Run: `cd apps/api && npx vitest run src/routes/reports/recipients.test.ts`
Expected: FAIL — `mode` is stripped by the schema (the `remove` case answers 201/200) and convert answers 201.

- [ ] **Step 4: Implement the recipient changes**

`apps/api/src/routes/reports/schemas.ts`:

```ts
export const addReportRecipientSchema = z.object({
  contactId: z.string().guid(),
  // Multi-org report series W02: 'remove' is valid only on a series child.
  mode: z.enum(['add', 'remove']).optional(),
});
```

`apps/api/src/routes/reports/recipients.ts`:

- Imports:

```ts
import type { UserPermissions } from '../../services/permissions';
import { seriesManagedRefusal } from '../../services/reportSeries/types';
import { callerMaySetEmailRecipients, RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';
```

  (merge `type UserPermissions` into the existing `../../services/permissions` import.)

- GET projection: add `mode: reportScheduleRecipients.mode,` after `email: contacts.email,`.

- POST `/:id/recipients` — replace the body after `if (refusal || !orgId) return c.json(refusal ?? PARTNER_OWNED_REPORT, 409);`:

```ts
    const { contactId, mode } = c.req.valid('json');
    const seriesChild = typeof report.seriesId === 'string';
    // 'remove' means "exclude this rule match" — without a series rule it
    // would be silently ignored while the contact kept receiving the report.
    if (mode === 'remove' && !seriesChild) {
      return c.json({ error: 'recipient_mode_requires_series' }, 400);
    }
    // INDEX recipient delivery gate: an 'add' on a series child adds a delivery.
    if (
      seriesChild
      && (mode ?? 'add') === 'add'
      && !callerMaySetEmailRecipients(c.get('auth'), c.get('permissions') as UserPermissions | undefined)
    ) {
      return c.json(RECIPIENTS_NEED_EXPORT_AND_MFA, 403);
    }

    const [contact] = await db.select({ id: contacts.id })
      .from(contacts)
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.orgId, orgId),
      ))
      .limit(1);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);

    if (seriesChild) {
      const overrideMode = mode ?? 'add';
      const [override] = await db.insert(reportScheduleRecipients).values({
        reportId: report.id,
        orgId,
        contactId,
        mode: overrideMode,
      }).onConflictDoUpdate({
        target: [reportScheduleRecipients.reportId, reportScheduleRecipients.contactId],
        set: { mode: overrideMode },
      }).returning();
      return c.json({ data: override ?? null }, 201);
    }

    const [recipient] = await db.insert(reportScheduleRecipients).values({
      reportId: report.id,
      orgId,
      contactId,
    }).onConflictDoNothing().returning();

    return c.json({ data: recipient ?? null }, recipient ? 201 : 200);
```

- POST `/:id/recipients/convert` — right after its `if (refusal || !orgId) return …;` line:

```ts
    // Multi-org report series W02: convert rewrites config.emailRecipients,
    // which on a child IS the series internal CC.
    if (report.seriesId) return c.json(seriesManagedRefusal(report.seriesId), 409);
```

Run: `cd apps/api && npx vitest run src/routes/reports/recipients.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing AI-tool test**

Append to `apps/api/src/services/aiToolsFleet.reportAudience.test.ts`:

```ts
describe('generate_report never edits or deletes a multi-org series child (W02)', () => {
  const SERIES_ID = '77777777-7777-4777-8777-777777777777';
  const child = () => ({ ...definition('executive_summary'), seriesId: SERIES_ID });

  it.each(['update', 'delete'])('%s answers series_managed and writes nothing', async (action) => {
    selectReturning(child());
    const r = JSON.parse(await handlerFor('generate_report')({ action, reportId: 'rep1', name: 'x' }, partnerAuth()));
    expect(r.error).toBe('series_managed');
    expect(r.seriesId).toBe(SERIES_ID);
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('an ordinary update pins series_id IS NULL in its WHERE (no race with a concurrent adoption)', async () => {
    selectReturning({ ...definition('executive_summary'), seriesId: null });
    const updateWheres: unknown[] = [];
    mockDb.update.mockReturnValue({
      set: () => ({
        where: (w: unknown) => {
          updateWheres.push(w);
          return { returning: () => Promise.resolve([{ id: 'rep1' }]) };
        },
      }),
    });
    const r = JSON.parse(await handlerFor('generate_report')({ action: 'update', reportId: 'rep1', name: 'Renamed' }, partnerAuth()));
    expect(r.success).toBe(true);
    expect(new PgDialect().sqlToQuery(updateWheres[0] as SQL).sql).toContain('"reports"."series_id" is null');
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolsFleet.reportAudience.test.ts`
Expected: FAIL — `r.error` is undefined (the update succeeds).

- [ ] **Step 6: Implement the AI-tool refusal**

In `apps/api/src/services/aiToolsFleet.ts` add `import { seriesManagedRefusal } from './reportSeries/types';`. In the `update` branch, directly after `const existing = access.report;`:

```ts
        // Multi-org report series W02: a child's shared fields belong to its
        // series (spec §3.3 "Child writers").
        if (existing.seriesId) return JSON.stringify(seriesManagedRefusal(existing.seriesId));
```

and extend its WHERE to `and(eq(reports.id, existing.id), eq(reports.orgId, existing.orgId), isNull(reports.seriesId), access.predicate)`. In the `delete` branch, directly after `const existing = access.report;` add the same refusal, and extend the `tx.delete(reports)` WHERE the same way. (No new query site: `tool:generate_report` stays `pinned(8)` in the visibility scan.)

- [ ] **Step 7: Run everything this task touched plus the AI contracts**

Run: `cd apps/api && npx vitest run src/routes/reports src/services/aiToolsFleet.reportAudience.test.ts src/services/aiToolsFleet.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/services/siteScope.projections.test.ts`
Expected: PASS. (`src/routes/reports` is a substring filter — check the reported file count covers every `routes/reports/*.test.ts`.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/reports/helpers.ts apps/api/src/routes/reports/core.ts \
        apps/api/src/routes/reports/recipients.ts apps/api/src/routes/reports/schemas.ts \
        apps/api/src/services/aiToolsFleet.ts apps/api/src/routes/reports/core.partnerOwned.test.ts \
        apps/api/src/routes/reports/recipients.test.ts apps/api/src/services/aiToolsFleet.reportAudience.test.ts
git commit -m "feat(reports): series_managed refusals on every child writer, detach, recipient overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: List and runs additions (`seriesId`, `seriesName`, `archivedAt`, `?series`, `?includeArchived`)

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts` (`listReportsSchema`)
- Modify: `apps/api/src/routes/reports/core.ts` (`GET /` filters + projection; `GET /templates` archived filter)
- Modify: `apps/api/src/routes/reports/runs.ts` (`GET /runs` projection + join)
- Test (append): `apps/api/src/routes/reports/core.partnerOwned.test.ts` (harness gains `state.projections`)

**Interfaces:**
- Consumes: `reportSeries` (Task 1); W01's `GET /reports` projection (`orgName`, `lastDeliveryStatus`) and `GET /reports/runs` projection (`orgId`, `orgName`, `deliveryStatus`, `recipientCount`).
- Produces (INDEX "Existing endpoint additions"): `GET /reports` rows gain `seriesId`, `seriesName`, `archivedAt`; query `?series=only|exclude`, `?includeArchived=true` (archived rows hidden by default). `GET /reports/runs` rows gain `seriesId`, `seriesName`.

`report_series` is partner-axis, so an ORG token's left join yields `seriesName: null` while `seriesId` is still set — exactly what W03's "Managed by your MSP" badge needs, with no series detail leaking to the customer. Both filters only narrow the caller's existing tenant predicate.

- [ ] **Step 1: Write the failing tests**

In `core.partnerOwned.test.ts`, extend the harness: add `projections: [] as Array<Record<string, unknown> | undefined>,` to the hoisted `state`, add `state.projections.push(projection);` as the first line of the `select` mock, and `state.projections = [];` to the top-level `beforeEach`. Then append:

```ts
describe('list additions (W02)', () => {
  const whereSql = (i: number) => dialect.sqlToQuery(state.wheres[i] as SQL).sql;

  it('GET /reports hides archived children by default; includeArchived=true shows them', async () => {
    state.rows = [{ count: 0 }, null];
    expect((await app().request('/reports')).status).toBe(200);
    expect(whereSql(0)).toContain('"reports"."archived_at" is null');

    state.wheres = [];
    state.rows = [{ count: 0 }, null];
    await app().request('/reports?includeArchived=true');
    expect(whereSql(0)).not.toContain('"reports"."archived_at" is null');
  });

  it('?series=only keeps children, ?series=exclude drops them', async () => {
    state.rows = [{ count: 0 }, null];
    await app().request('/reports?series=only');
    expect(whereSql(0)).toContain('"reports"."series_id" is not null');
    state.wheres = [];
    state.rows = [{ count: 0 }, null];
    await app().request('/reports?series=exclude');
    expect(whereSql(0)).toContain('"reports"."series_id" is null');
  });

  it('rejects an unknown ?series value', async () => {
    expect((await app().request('/reports?series=sometimes')).status).toBe(400);
  });

  it('projects seriesId, archivedAt and seriesName on GET /reports', async () => {
    state.rows = [{ count: 0 }, null];
    await app().request('/reports');
    const list = state.projections.find((p) => p && 'seriesName' in p);
    expect(list).toBeDefined();
    expect(Object.keys(list!)).toEqual(expect.arrayContaining(['seriesId', 'archivedAt', 'seriesName']));
  });

  it('projects seriesId and seriesName on GET /reports/runs', async () => {
    state.rows = [{ count: 0 }, null];
    await app().request('/reports/runs');
    const runs = state.projections.find((p) => p && 'reportName' in p);
    expect(Object.keys(runs!)).toEqual(expect.arrayContaining(['seriesId', 'seriesName']));
  });

  it('GET /reports/templates never offers an archived child', async () => {
    state.rows = [{ count: 0 }, null];
    await app().request('/reports/templates');
    expect(whereSql(0)).toContain('"reports"."archived_at" is null');
  });
});
```

Run: `cd apps/api && npx vitest run src/routes/reports/core.partnerOwned.test.ts -t "list additions"`
Expected: FAIL — `"reports"."archived_at" is null` missing; `?series=sometimes` answers 200.

- [ ] **Step 2: Implement**

`apps/api/src/routes/reports/schemas.ts` — `listReportsSchema` gains (after `ownerScope`):

```ts
  ownerScope: z.enum(['organization', 'partner']).optional(),
  // Multi-org report series W02: narrowing only. 'only' = series children,
  // 'exclude' = everything else.
  series: z.enum(['only', 'exclude']).optional(),
  // Archived series children are hidden unless asked for.
  includeArchived: z.enum(['true', 'false']).optional(),
```

`apps/api/src/routes/reports/core.ts`:

- Imports: add `getTableColumns` and `isNotNull` to the `drizzle-orm` import (`isNull` came in Task 10) and `reportSeries` to the `../../db/schema` import.
- `GET /`, after the `ownerScope` filter:

```ts
    // Multi-org report series W02: narrowing filters; archived children are
    // hidden by default (spec §3.6).
    if (query.series === 'only') conditions.push(isNotNull(reports.seriesId));
    if (query.series === 'exclude') conditions.push(isNull(reports.seriesId));
    if (query.includeArchived !== 'true') conditions.push(isNull(reports.archivedAt));
```

- `GET /` list query: W01 turned the bare `db.select()` into a projection carrying `orgName` / `lastDeliveryStatus` with its own join(s). Add `seriesName` to that projection and one left join after W01's joins. The result must read:

```ts
    const reportsList = await db
      .select({
        ...getTableColumns(reports),
        orgName: organizations.name,          // W01 — keep exactly as merged
        lastDeliveryStatus: /* W01's expression, unchanged */,
        seriesName: reportSeries.name,
      })
      .from(reports)
      .leftJoin(organizations, eq(organizations.id, reports.orgId)) // W01 — keep exactly as merged
      .leftJoin(reportSeries, eq(reportSeries.id, reports.seriesId))
      .where(whereCondition)
      .orderBy(desc(reports.updatedAt), desc(reports.id))
      .limit(limit)
      .offset(offset);
```

  (The two lines marked W01 are whatever W01 merged; only `seriesName` and the `reportSeries` join are this task's. The count query needs no join.)

- `GET /templates`, after its `ownerScope` filter:

```ts
    // W02: an archived series child is history, not a template.
    conditions.push(isNull(reports.archivedAt));
```

`apps/api/src/routes/reports/runs.ts` `GET /runs` — add `reportSeries` to the schema import; in the data query's projection add, next to W01's `orgId` / `orgName`:

```ts
        seriesId: reports.seriesId,
        seriesName: reportSeries.name,
```

and after `.innerJoin(reports, eq(reportRuns.reportId, reports.id))` (and W01's organizations join) on the DATA query only:

```ts
      .leftJoin(reportSeries, eq(reportSeries.id, reports.seriesId))
```

- [ ] **Step 3: Run**

Run: `cd apps/api && npx vitest run src/routes/reports src/routes/reports/partnerOwnedVisibility.scan.test.ts`
Expected: PASS (the scan is unaffected: `reportSeries` is not a guarded table and no new `reports`/`reportRuns` query site was added).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/core.ts \
        apps/api/src/routes/reports/runs.ts apps/api/src/routes/reports/core.partnerOwned.test.ts
git commit -m "feat(reports): series fields and filters on the report and run lists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Org merge — the series pass in `mergeReports`

**Files:**
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (new `archiveCollidingSeriesChildren`; call it first in `mergeReports`; note)
- Create: `apps/api/src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts`
- Modify: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` (`archiveCollidingSeriesChildren`)

**Interfaces:**
- Consumes: `run`, `uuid` (module-local helpers, `orgMergeCustomExecutors.ts:72-76`); Task 2's `report_series_org_targets` repoint-dedupe policy.
- Produces: `mergeReports` also archives colliding series children (never deletes, never re-homes runs — Contract concern 2). `CUSTOM_WOULD_DROP_COUNTS.reports` is unchanged: this pass drops no definition.

**Statement order (all inside the merge's `SET CONSTRAINTS ALL DEFERRED` transaction, BEFORE `mergeReports`' generic repoint):**
1. Removes win: survivor-child `add` rows become `remove` where the loser's colliding child removes the same contact.
2. Drop loser-child override rows whose contact the survivor child already holds (the survivor's row — now carrying the winning mode — stays).
3. Re-home the remaining loser-child override rows onto the survivor's child (`report_id` only; `org_id` follows via the `report_schedule_recipients` repoint — the composite FKs are `DEFERRABLE`).
4. Archive the loser's colliding active child: it leaves `reports_series_active_child_uniq`, so the generic `reports` repoint cannot 23505; its runs and evidence stay attached (`sd_evidence_report_run_fk` is never touched).

A loser child with no survivor twin is simply repointed by the existing generic pass, and the deferred `reports_series_child_same_partner` trigger passes at COMMIT because merges are same-partner (`orgMerge.ts:294`).

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts` (rolled back, precedent `orgMergeCustomExecutors.integration.test.ts` "merges colliding portal report definitions"):

```ts
/**
 * Multi-org report series W02 — org merge (spec §5 W02 "Org merge
 * integration"). Two orgs with active children of the same series merge
 * without 23505 or 23503; the survivor keeps its child; the loser's child is
 * archived with its runs attached; overrides are unioned with removes
 * winning; target rows dedupe with the row surviving. Rolled back.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { CUSTOM_EXECUTORS } from '../../services/orgMergeCustomExecutors';
import { buildRepoint, buildRepointDedupe } from '../../services/orgMergeExecutors';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

class Rollback extends Error {}

describe('org merge — multi-org report series children', () => {
  it('archives the colliding loser child, keeps its runs, unions overrides (removes win), dedupes targets', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const series = randomUUID();
    const childL = randomUUID();
    const childS = randomUUID();
    const runL = randomUUID();
    const shared = randomUUID();
    const loserOnly = randomUUID();
    const removedByLoser = randomUUID();

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Series merge', ${`series-merge-${P.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`sm-l-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`sm-s-${S.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO report_series (id, partner_id, name, type, schedule, target_mode)
          VALUES (${series}::uuid, ${P}::uuid, 'Monthly', 'executive_summary', 'monthly', 'all')`);
        // Both orgs excluded -> the dedupe keeps exactly one exclusion row.
        await db.execute(sql`
          INSERT INTO report_series_org_targets (series_id, org_id)
          VALUES (${series}::uuid, ${L}::uuid), (${series}::uuid, ${S}::uuid)`);
        await db.execute(sql`
          INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision) VALUES
            (${childL}::uuid, ${L}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1),
            (${childS}::uuid, ${S}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1)`);
        await db.execute(sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runL}::uuid, ${childL}::uuid, 'completed')`);
        await db.execute(sql`
          INSERT INTO contacts (id, org_id, name, email) VALUES
            (${shared}::uuid, ${L}::uuid, 'Shared', ${`shared-${P}@example.com`}),
            (${loserOnly}::uuid, ${L}::uuid, 'Loser only', ${`only-${P}@example.com`}),
            (${removedByLoser}::uuid, ${L}::uuid, 'Removed', ${`removed-${P}@example.com`})`);

        // Mid-merge state (contacts already repointed), as in the portal-report case.
        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        await db.execute(sql`
          INSERT INTO report_schedule_recipients (report_id, org_id, contact_id, mode) VALUES
            (${childL}::uuid, ${L}::uuid, ${shared}::uuid, 'add'),
            (${childS}::uuid, ${S}::uuid, ${shared}::uuid, 'add'),
            (${childL}::uuid, ${L}::uuid, ${loserOnly}::uuid, 'add'),
            (${childL}::uuid, ${L}::uuid, ${removedByLoser}::uuid, 'remove'),
            (${childS}::uuid, ${S}::uuid, ${removedByLoser}::uuid, 'add')`);
        await db.execute(sql`UPDATE contacts SET org_id = ${S}::uuid WHERE org_id = ${L}::uuid`);

        const out = await CUSTOM_EXECUTORS.reports!(L, S);
        expect(out.dropped).toBe(0);
        expect(out.notes.join('\n')).toMatch(/archived 1 multi-org report child/);

        const targetsPolicy = getOrgMergePolicies().get('report_series_org_targets');
        expect(targetsPolicy).toEqual({ kind: 'repoint-dedupe', key: ['series_id'] });
        // buildRepointDedupe returns [dedupe DELETE, repoint UPDATE] (orgMergeExecutors.ts:51).
        for (const statement of buildRepointDedupe('report_series_org_targets', ['series_id'], undefined, L, S)) {
          await db.execute(statement);
        }
        await db.execute(buildRepoint('report_schedule_recipients', L, S));
        await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);

        const children = (await db.execute(sql`
          SELECT id, org_id, archived_at IS NOT NULL AS archived FROM reports
           WHERE series_id = ${series}::uuid ORDER BY archived`)) as unknown as Array<{ id: string; org_id: string; archived: boolean }>;
        expect(children).toEqual([
          { id: childS, org_id: S, archived: false },
          { id: childL, org_id: S, archived: true },
        ]);

        const runs = (await db.execute(sql`SELECT report_id FROM report_runs WHERE id = ${runL}::uuid`)) as unknown as Array<{ report_id: string }>;
        expect(runs).toEqual([{ report_id: childL }]);

        const overrides = (await db.execute(sql`
          SELECT contact_id, mode, org_id FROM report_schedule_recipients
           WHERE report_id = ${childS}::uuid ORDER BY contact_id`)) as unknown as Array<{ contact_id: string; mode: string; org_id: string }>;
        const byContact = new Map(overrides.map((row) => [row.contact_id, row.mode]));
        expect(byContact.get(shared)).toBe('add');
        expect(byContact.get(loserOnly)).toBe('add');
        expect(byContact.get(removedByLoser)).toBe('remove');
        expect(overrides.every((row) => row.org_id === S)).toBe(true);

        const targets = (await db.execute(sql`
          SELECT org_id FROM report_series_org_targets WHERE series_id = ${series}::uuid`)) as unknown as Array<{ org_id: string }>;
        expect(targets).toEqual([{ org_id: S }]);

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }, 120_000);

  it('a loser child with no survivor twin is simply repointed, still active', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const series = randomUUID();
    const childL = randomUUID();
    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Series merge 2', ${`series-merge2-${P.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`sm2-l-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`sm2-s-${S.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO report_series (id, partner_id, name, type, schedule)
          VALUES (${series}::uuid, ${P}::uuid, 'Monthly', 'executive_summary', 'monthly')`);
        await db.execute(sql`
          INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision)
          VALUES (${childL}::uuid, ${L}::uuid, 'Monthly', 'executive_summary', 'monthly', ${series}::uuid, 1)`);
        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const out = await CUSTOM_EXECUTORS.reports!(L, S);
        expect(out.moved).toBe(1);
        await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const rows = (await db.execute(sql`
          SELECT org_id, archived_at FROM reports WHERE id = ${childL}::uuid`)) as unknown as Array<{ org_id: string; archived_at: Date | null }>;
        expect(rows).toEqual([{ org_id: S, archived_at: null }]);
        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }, 120_000);
});
```

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts`
Expected: FAIL — the first case aborts with `duplicate key value violates unique constraint "reports_series_active_child_uniq"` (23505) from the generic repoint.

- [ ] **Step 2: Implement the series pass**

In `apps/api/src/services/orgMergeCustomExecutors.ts`, directly above `const mergeReports`:

```ts
// ---------------------------------------------------------------------------
// Multi-org report series W02: reports_series_active_child_uniq (org_id,
// series_id) WHERE series_id IS NOT NULL AND archived_at IS NULL collides when
// both orgs hold an active child of the same series. The survivor keeps its
// child. The loser's child is ARCHIVED in place — never deleted, and its runs
// are never re-homed: a run may be deliverable evidence, and
// sd_evidence_report_run_fk (report_run_id, report_id) -> report_runs(id,
// report_id) is NOT deferrable with no ON UPDATE action, so moving a run
// would abort the merge with 23503. The archived child then repoints into the
// survivor org with its history intact (the generic repoint below). Its
// recipient overrides are unioned onto the survivor's child; a 'remove' on
// either side wins over an 'add'.
// ---------------------------------------------------------------------------
async function archiveCollidingSeriesChildren(
  loser: string,
  survivor: string,
): Promise<{ archived: number; removesPromoted: number; recipientsDeduplicated: number; recipientsRehomed: number }> {
  const twin = sql`s.org_id = ${uuid(survivor)}
       AND s.series_id = t.series_id
       AND s.archived_at IS NULL
       AND t.archived_at IS NULL`;

  const removesPromoted = await run(sql`
    UPDATE report_schedule_recipients AS existing
       SET mode = 'remove'
      FROM report_schedule_recipients c
      JOIN reports t ON t.id = c.report_id
      JOIN reports s ON ${twin}
     WHERE t.org_id = ${uuid(loser)}
       AND t.series_id IS NOT NULL
       AND c.mode = 'remove'
       AND existing.report_id = s.id
       AND existing.contact_id = c.contact_id
       AND existing.mode = 'add'`);

  const recipientsDeduplicated = await run(sql`
    DELETE FROM report_schedule_recipients AS c
     USING reports t
      JOIN reports s ON ${twin}
     WHERE t.org_id = ${uuid(loser)}
       AND t.series_id IS NOT NULL
       AND c.report_id = t.id
       AND EXISTS (
         SELECT 1 FROM report_schedule_recipients existing
          WHERE existing.report_id = s.id
            AND existing.contact_id = c.contact_id
       )`);

  const recipientsRehomed = await run(sql`
    UPDATE report_schedule_recipients AS c
       SET report_id = s.id
      FROM reports t
      JOIN reports s ON ${twin}
     WHERE t.org_id = ${uuid(loser)}
       AND t.series_id IS NOT NULL
       AND c.report_id = t.id`);

  const archived = await run(sql`
    UPDATE reports t
       SET archived_at = now(), updated_at = now()
      FROM reports s
     WHERE t.org_id = ${uuid(loser)}
       AND t.series_id IS NOT NULL
       AND ${twin}`);

  return { archived, removesPromoted, recipientsDeduplicated, recipientsRehomed };
}
```

In `mergeReports`, make the series pass the FIRST statement (before the narrative pass):

```ts
const mergeReports: CustomMergeExecutor = async (loser, survivor) => {
  const series = await archiveCollidingSeriesChildren(loser, survivor);
  const narrative = await rehomeReportChildrenThenDelete(
```

and, after the fleet-design note block (before `return`):

```ts
  if (series.archived > 0) {
    notes.push(
      `reports: archived ${series.archived} multi-org report child definition(s) of the merged-away org whose series already had an active child in the survivor; their run history stays attached to the archived rows (report_schedule_recipients: ${series.recipientsRehomed} override(s) moved to the survivor's child, ${series.recipientsDeduplicated} duplicate(s) dropped, ${series.removesPromoted} add→remove promotion(s))`,
    );
  }
```

(`dropped` is unchanged — archiving is not a drop, so `CUSTOM_WOULD_DROP_COUNTS.reports` needs no series arm.)

- [ ] **Step 3: Register the raw-SQL sites**

In `partnerOwnedVisibility.scan.test.ts`, extend the `src/services/orgMergeCustomExecutors.ts` map:

```ts
    ['archiveCollidingSeriesChildren', pinned(8, 'org merge (platform admin, system context): every statement keys on t.org_id = <loser> and s.org_id = <survivor> with series_id IS NOT NULL; series children are org-owned (reports_series_child_shape_chk), so a partner-owned definition is never archived or joined', AUD_SYSTEM)],
```

(8 = `JOIN reports t` + `JOIN reports s` in each of the three recipient statements, plus `UPDATE reports t` + `FROM reports s` in the archive.)

- [ ] **Step 4: Run**

Run: `pnpm --filter=@breeze/api test:integration src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Expected: PASS.

Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.test.ts src/services/orgMerge.test.ts src/routes/reports/partnerOwnedVisibility.scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgMergeCustomExecutors.ts \
        apps/api/src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts \
        apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts
git commit -m "feat(reports): org merge archives colliding series children and unions their overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: Contract-suite gate, review, PR

**Files:** none new (fixes only, if a gate is red).

- [ ] **Step 1: Re-verify the base and the migration names**

Run: `git fetch origin main && git log --oneline -1 origin/main && git merge-base --is-ancestor origin/main HEAD && echo up-to-date`
Expected: `up-to-date` (else `git rebase origin/main`, re-run every step below).

Run: `ls apps/api/migrations | sort | tail -3`
Expected: the last two lines are `2026-11-09-110000-report-series.sql` and `2026-11-09-110100-reports-series-children.sql` (or a later pair you bumped to). Then `bash scripts/check-migration-naming.sh --against-ref origin/main` → exit 0.

- [ ] **Step 2: Typecheck and the full API unit run**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd apps/api && npx vitest run`
Expected: PASS — including `orgMerge.test.ts` (reds only in the full run), `partnerOwnedVisibility.scan.test.ts`, `partner-wide-write-coverage.test.ts`, `mcp-coverage.test.ts`, `siteScope.projections.test.ts`, `migrationRlsScope.test.ts`, `autoMigrate.test.ts`, `aiTools.userOwnedRelease.contract.test.ts`, `aiTools.descriptionBudget.contract.test.ts`, `reportScheduleWorker.contract.test.ts`, `schemas.configParity.test.ts`.

- [ ] **Step 3: The tenancy contract suites against real Postgres**

Run: `pnpm test-stack up` (worktree root), then:

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api test:integration \
  src/__tests__/integration/reportSeriesPartnerRls.integration.test.ts \
  src/__tests__/integration/reportSeriesRecipients.integration.test.ts \
  src/__tests__/integration/reportSeriesReconcile.integration.test.ts \
  src/__tests__/integration/reportSeriesStore.integration.test.ts \
  src/__tests__/integration/reportSeriesOrgMerge.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/reportsPartnerRls.integration.test.ts \
  src/__tests__/integration/reportsPartnerOwned.integration.test.ts \
  src/__tests__/integration/reportHistoryRls.integration.test.ts \
  src/__tests__/integration/portalReportRecipientsRls.integration.test.ts
cd apps/api && DATABASE_URL=$(grep '^DATABASE_URL=' ../../.env.test | cut -d= -f2-) pnpm db:check-drift
```

Expected: every suite PASS; drift `OK`. (`rls-coverage` asserts `report_series` via `PARTNER_TENANT_TABLES` and auto-discovers `report_series_org_targets`; `tenantCascade` asserts alphabetical order, completeness and FK children-before-parents; `orgCascadeFkOnDelete` proves the `ON DELETE SET NULL` users edges; `orgLifecycleFoundations` is the merge contract that requires every org-referencing constraint to be deferrable.)

Then: `pnpm test-stack down`. Confirm with `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'` that nothing this session started is left running.

- [ ] **Step 4: One independent review round**

Blast radius is high (tenancy, migration, org merge): run `/pr-review-toolkit:review-pr` on the branch with a Sonnet- or Opus-class reviewer, pointing it at the tenancy contract (`CLAUDE.md` "Tenant Isolation / RLS"), this plan's Contract concerns and the Review Focus list. Act only on confirmed, consequential findings; re-review only if a fix touches a high-blast-radius surface.

- [ ] **Step 5: Open the PR**

Base `main` (not a sibling branch — a stacked base runs no CI). Title: `feat(reports): multi-org report series backend (W02)`. The body must contain:

- **D6 exception to Partner-Wide-First:** `report_series` is partner-only (`partner_id NOT NULL`, shape 3); single-org definitions stay in `reports` and a one-org series is "Chosen orgs: [X]".
- **Tenancy registration checklist** (each a mechanical grep in the diff): `report_series` → `PARTNER_TENANT_TABLES`; `report_series_org_targets` → auto-discovered RLS, `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` (repoint-dedupe on `series_id`), `CORE_TENANT_EXPORT_POLICY`; new columns `reports.series_id|series_revision|archived_at` and `report_schedule_recipients.mode` → `CORE_TENANT_EXPORT_POLICY`; partner erasure discovers `report_series` by its `partner_id` column; every constraint trigger `DEFERRABLE INITIALLY IMMEDIATE`.
- **Contract concerns 1–13** from this plan, one line each (especially #2: merge archives rather than re-homes runs, and the latent 23503 in the existing narrative/portal passes).
- **Follow-ups filed:** (a) `rehomeReportChildrenThenDelete` 23503 on an evidence-linked run; (b) an AI/MCP tool for series management.
- `Closes #<W02 wave sub-issue>` (or `Refs` if a later PR completes the wave), and the attribution footer.

Run: `gh pr create --base main --title "feat(reports): multi-org report series backend (W02)" --body-file <body file>` then `gh pr checks <N> --watch`; when green, `gh pr merge <N>` (merge queue; never `--admin`).

---

## Self-review (done at plan time)

- **Spec coverage:** §3.2 tables/columns/triggers/registration → Tasks 1–2, 12; §3.3 reconciler, sweep, gate, `findDueReports`, child writers → Tasks 6, 9, 10; §3.4 authority + transfer-owner → Tasks 4, 7, 8; §3.5 recipients, `recipient_count` → Tasks 5, 9; §3.6 routes, detach, list/runs additions → Tasks 7, 8, 10, 11; §5 W02 tests → Tasks 1, 5, 6, 7, 9, 12, 13. Combine (§3.8) is W04; UI (§3.7) is W03.
- **Placeholders:** the only deliberately open text is the W01 seam (Task 9 (g), Task 11 Step 2), where W01's merged expressions must be kept verbatim; each names the exact replacement.
- **Type consistency:** `ReportSeriesError`, `SeriesDetail`, `ReconcileResult`, `SeriesGateDecision`, `ExecutionScopeColumns`, `SeriesTx`, `SeriesAuth`, `resolveRunRecipientSets` are defined once (Tasks 3, 4, 6, 7, 9) and used with the same signatures downstream.
