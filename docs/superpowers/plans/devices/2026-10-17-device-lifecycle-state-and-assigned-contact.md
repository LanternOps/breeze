---
title: Device lifecycle state (#8836) + assigned contact (#8835) — combined implementation plan
date: 2026-10-17
status: draft — awaiting owner review; Open Decisions P-1..P-3 (§5) have recommended defaults and do not block L1
specs:
  - docs/superpowers/specs/device-lifecycle/2026-10-15-device-lifecycle-state-spec.md
  - docs/superpowers/specs/devices/2026-10-15-device-assigned-contact-spec.md
tracking_issue_8836: TBD — register_feature after approval (parent #8836, waves L1–L6)
tracking_issue_8835: TBD — register_feature after approval (parent #8835, waves C1–C4)
tracking_issue: TBD — two features; register #8836 and #8835 separately, one parent each
---

# Device Lifecycle State + Assigned Contact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agent devices an inventory lifecycle state (`in_service | spare | pending_disposal | disposed | lost_stolen`)
with a typed, detach-surviving history, and a single assigned contact with server-computed suggestions — one
shared history table, one plan, ten independently shippable PRs.

**Architecture:** Lifecycle state and assignment are columns on `devices` (the current projection). Every change
to either writes one row to `device_lifecycle_events` (Shape 1, created once in L1 in its final shape, with the
assignment columns reserved). All lifecycle writers go through `services/deviceLifecycleState.ts`; all assignment
writers go through `services/devicePrimaryContact.ts`. Both take the partner-export org lock before the device row
lock, so the later partner-export trigger redefinitions (L4, C4) change no writer's lock order.

**Tech Stack:** Hono + Drizzle (queries only) + hand-written SQL migrations, PostgreSQL 16 forced RLS, BullMQ
(group re-evaluation, offline effects, retention), Astro + React islands, Vitest (unit, integration, RLS coverage),
Playwright (`data-testid` only).

**Specs:** lifecycle spec (cited **L§section**, decisions **L-D n**) and assigned-contact spec (**C§section**,
**C-D n**). Both approved 2026-10-17 with every decision as recommended; L-D6 is a named owner exception. The
plan argues from the specs; executors read the cited spec section before each wave. Where this plan deviates from
a spec, §4 records the deviation and why (all came from the advisor quorum or the main-branch verification).

## Global Constraints

- Lifecycle enum, exact order: `in_service, spare, pending_disposal, disposed, lost_stolen` (pg type `device_lifecycle_state`, default `'in_service'`).
- Disposal method enum: `destroyed, recycled, resold, donated, returned_to_lessor, transferred, other` (pg type `device_disposal_method`).
- `disposed ⇒ Removed`: `CHECK (lifecycle_state <> 'disposed' OR status = 'decommissioned')` named `devices_lifecycle_disposed_removed_chk`.
- Offline-alert suppression: `spare` and `pending_disposal` **only** (L-D3). `lost_stolen` alerts normally.
- Billing unchanged: `billableDeviceConds` is not touched by any wave (L-D4).
- Lifecycle and assignment writers: user sessions only — `requireInteractiveSession()` + `devices:write` + `requireMfa()`; `DEVICES_DELETE` additionally when a lifecycle request carries `remove` (L-D7, §4 Δ6).
- Bulk cap: 500 ids, reuse `bulkDeviceIdsSchema` / `BULK_LIFECYCLE_MAX_DEVICES` (`routes/devices/schemas.ts:450`).
- Varchar caps: `lifecycle_note` and event `note` 1000; `disposal_reference` 255; `subject_label` 255; `subject_serial_number` 255; `primary_contact_source` 32; `device_sessions.principal_upn` 320; dismissal `identity` 400; `portal_branding.devices_scope` 16.
- Assignment source CHECK: `primary_contact_source IN ('manual','suggestion_accepted','directory')`; v1 never writes `directory`.
- Event `kind` CHECK: `transition | correction | assignment`. Event `source` CHECK: `single | bulk | remove_dialog | lifecycle_dialog | suggestion | contact_deleted | move_org`.
- Detached-row retention: `DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS`, default **400**, clamped **30..3650**, clock = `detached_at` (L-D6).
- Suggestion engine thresholds (C§Suggestion engine): window 30 days, minimum 8 h observed, leader ≥ 70 % and ≥ 2× runner-up, Intune freshness 30 days and `is_stale = false`.
- Migrations: `apps/api/migrations/2026-12-31-10HH00-<slug>.sql` slots in §2.1; idempotent; no inner `BEGIN`/`COMMIT`; RLS in the same file as the table; `pnpm db:check-drift` after. Newest committed migration at plan time: `2026-12-30-120900-trust-page-templates.sql` — re-check before committing (the naming hook enforces sort-after-newest with `localeCompare`).
- No migration in this plan writes rows, so none sets `breeze.scope`; `migrationRlsScope.test.ts` and `migrationPartnerExportLocks.test.ts` must agree (each wave with a migration runs both).
- Every PG composite FK referencing an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`; column-list `ON DELETE SET NULL (<col>)` wherever the child row must survive.
- Web: every mutation through `runAction`; every new en key in all **8** locale dirs (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`, `apps/web/src/lib/i18n/localeParity.test.ts`; the specs say 7 — 8 is current).
- AI tool schemas: optional fields use `.optional()`, never `z.undefined()`.
- No customer names, hostnames or IPs in code, tests, docs or PR text.
- Never `pnpm --filter <pkg> test -- --run <path>`; use `cd apps/api && npx vitest run <file>` (unit) and `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>` (integration, on `pnpm test-stack up`). `tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=12288`, read the exit code, never pipe to `tail`.

## Review Focus

1. **A device leaving `spare` for `in_service` while still offline, when the pre-spare offline alert is still open.** Expect exactly one open offline alert, not two (the re-arm effect must dedupe against the open alert). Test added to Task L4.2.
2. **Bulk "mark disposed" over a mixed selection where some devices are already Removed.** Expect `decommissioned_at` unchanged on the already-Removed ones (purge clock not restarted), and the confirm copy counts both groups. Tests in L1.3 (service) and L3.1 (route).
3. **Device move-org while a lifecycle or assignment write is in flight on the same device.** Expect one side to win cleanly (409 `STATE_CHANGED` or the move proceeds), never `40P01` or `23503`. Integration test in L4.4 (after the trigger change) and L1.5 (detach before flip).
4. **Contact deleted through the site cascade (not `deleteContact`) while devices point at it.** Expect `primary_contact_id`, `_source`, `_set_at` all NULL (the provenance trigger fires on the RI update) and the history row still shows "Deleted contact". Integration test in C1.2.
5. **Portal user in `assigned` scope with `contact_id` NULL, and the portal opened through `enable_self_service` rather than `enable_devices`.** Expect an empty list and an empty CSV, never the org list. Route test in C3.6.

---

## 1. Wave map

One PR per wave, merged in this order. Each wave is independently shippable: the default `in_service` and the NULL
assignment make every wave invisible until used. Integration suites run only in the `integration-test` CI job and
on a local test stack, never via `pnpm test`.

| # | Wave | PR title | Depends on | Migration | Tenancy shape | Contract suites that fire |
|---|---|---|---|---|---|---|
| 1 | **L1** schema, registrations, service, single routes, Restore guard, removal extraction, detached-row retention | `feat(devices): device lifecycle state — schema, service and API (#8836 L1)` | — | `2026-12-31-100000-device-lifecycle-state.sql` | new Shape 1 table + `devices` columns | rls-coverage, tenantCascade, cascadeDelete, moveOrg.coverage, tenant-export-policy, tenantExportErasureRoundtrip, orgMergeRegistry (+ `orgMerge.test.ts`), orgLifecycleFoundations, deviceOwnershipEpochs (exact exclusion set), devicePublicProjection, selfManagedDbContextRoutes, migrationRlsScope, migrationPartnerExportLocks, autoMigrate, new `deviceChildOrgidExclusions.contract.test.ts`, retentionMetrics, workerReadiness |
| 2 | **L2** web: badge, dialog, Lifecycle card, filter field, group re-evaluation, list column + chips | `feat(web): device lifecycle state on the device page and list (#8836 L2)` | L1, **#7324 W1** (for the column task only) | none | — | filterEngine trust-tier tests, dynamicGroupReevaluation (integration), no-silent-mutations, localeParity, `DeviceList.test.tsx`, columnVisibility |
| 3 | **L3** bulk route + bulk bar + Remove dialog "Also mark as" | `feat(devices): bulk lifecycle state and Remove-dialog marking (#8836 L3)` | L2 | none | per-device tx | bulkLifecycle.mountorder, selfManagedDbContextRoutes, bulk gating contract (`DeviceList.test.tsx`), no-silent-mutations, localeParity |
| 4 | **L4** behaviour: offline suppression + re-arm, event payloads, automation trigger, AI filter, Partner API + trigger | `feat(devices): lifecycle-aware offline alerts, automation, AI and Partner API (#8836 L4)` | L1 | `2026-12-31-100100-partner-export-devices-lifecycle.sql` | trigger redefinition | partnerApi dtoSafety + exportSafety.classification, partnerApiExportWatermark (integration), new `partnerExportDevicesTrigger.contract.test.ts`, aiToolsDeviceScope, aiToolsSiteScope, aiToolIndex, migrationPartnerExportLocks, localeParity |
| 5 | **L5** reports, shared predicate, disposal-register route, docs | `feat(reports): lifecycle in device inventory and hardware lifecycle reports (#8836 L5)` | L1 | none | partner/system read route | report generation tests, routeScope (no new page), new register route test |
| 6 | **C1** assignment columns, PATCH, DTO, history, move-org clear, contact-delete pre-clear, filter, typeahead, editor, list column | `feat(devices): assigned contact on devices (#8835 C1)` | L1 (events table), L2 (DeviceList merge rule), #7324 W1 | `2026-12-31-100300-device-primary-contact.sql`, `2026-12-31-100400-device-primary-contact-index.sql` (`@no-transaction`) | composite FK on `devices` | tenant-export-policy, tenantExportErasureRoundtrip, tenantCascade (topological), orgLifecycleFoundations, devicePublicProjection, moveOrg.coverage, migrationRlsScope, autoMigrate, dynamicGroupReevaluation, no-silent-mutations, localeParity |
| 7 | **C2** suggestion engine, `principal_upn` ingest, dismissals table, banner, review drawer, bulk accept | `feat(devices): assignment suggestions and dismissals (#8835 C2)` | C1 | `2026-12-31-100500-device-primary-contact-dismissals.sql` | new Shape 1 table | rls-coverage, tenantCascade, cascadeDelete, moveOrg.coverage, tenant-export-policy, tenantExportErasureRoundtrip, orgMergeRegistry, deviceOwnershipEpochs (exact exclusion set), `deviceChildOrgidExclusions.contract.test.ts`, bulkLifecycle.mountorder, selfManagedDbContextRoutes, localeParity |
| 8 | **C3** bulk assign, contact drawer, reports, AI params, ticket prefill, portal scope, "Clear assigned contact" in lifecycle dialogs | `feat(devices): bulk assign, contact drawer, portal scope and ticket prefill (#8835 C3)` | C2, L3 | none | portal scope | bulk gating contract, aiToolsDeviceScope, aiToolsSiteScope, aiToolIndex, portal device routes, settings rule 9, no-silent-mutations, localeParity |
| 9 | **C4** Partner API fields + trigger redefinition | `feat(partner-api): assigned contact on the device export (#8835 C4)` | C1, **L4** | `2026-12-31-100600-partner-export-devices-primary-contact.sql` | trigger redefinition | `partnerExportDevicesTrigger.contract.test.ts`, partnerApiExportWatermark, dtoSafety, exportSafety.classification, migrationPartnerExportLocks |
| 10 | **L6** manual-asset lifecycle parity | `feat(devices): lifecycle state on manual assets (#8836 L6)` | L5 | `2026-12-31-100700-manual-asset-lifecycle-state.sql` | column on Shape 1 table | tenant-export-policy, `mergedListFilter` tests, localeParity |

L4 and L5 touch disjoint files and may be built in parallel worktrees after L1; they still **merge** in the order
above. L6 floats: it may merge any time after L5 because it holds the last slot.

## 2. Cross-cutting rules

### 2.1 Migration slots and order

Slots are reserved **in merge order**. If a wave's slot no longer sorts after the newest committed migration
when it is committed (the naming hook rejects it), keep the `2026-12-31-10` prefix and take the next free `HHMMSS`
after the newest; say so in the PR. Never reorder two of this plan's migrations relative to each other: L4's
trigger body must be committed before C4's.

| Slot | Wave | File |
|---|---|---|
| 100000 | L1 | `2026-12-31-100000-device-lifecycle-state.sql` |
| 100100 | L4 | `2026-12-31-100100-partner-export-devices-lifecycle.sql` |
| 100200 | — | unused (spare, so an L-wave fix-up migration can still sort before C1) |
| 100300 | C1 | `2026-12-31-100300-device-primary-contact.sql` |
| 100400 | C1 | `2026-12-31-100400-device-primary-contact-index.sql` (`-- @no-transaction`) |
| 100500 | C2 | `2026-12-31-100500-device-primary-contact-dismissals.sql` |
| 100600 | C4 | `2026-12-31-100600-partner-export-devices-primary-contact.sql` |
| 100700 | L6 | `2026-12-31-100700-manual-asset-lifecycle-state.sql` |

Cross-plan: the tag-registry plan (`plan/8837-8833-tags-bulk-edit`) holds `2026-12-30-19HH00`. If any of its
waves has not merged when L1 merges, its slots stop sorting after the newest and it must re-slot. The orchestrator
owns that sequencing.

### 2.2 Function redefinition ledger (each redefinition keeps every earlier column)

Two SQL functions are redefined by this plan. Each `CREATE OR REPLACE` **starts from the last committed body at
implementation time** (`git grep -l` over migrations, newest by `localeCompare`), copies it verbatim, and appends.
A static contract test pins each one so a later redefinition that drops an entry goes red in Test API.

**`public.breeze_partner_export_devices_update()`** — statement trigger; three `IS DISTINCT FROM` comparisons
(two UNION arms + the UPDATE `WHERE`), six `ROW(...)` lists.

| Order | Defined in | ROW column list (identical in all six lists, appended at the end) |
|---|---|---|
| 0 | `2026-07-18-partner-export-org-locks.sql:310` (only definition on main) | `org_id, site_id, hostname, display_name, os_type, device_role, is_virtual, virtualization_platform, os_version, os_build, architecture, enrolled_at, link_group_id, link_group_role, tags, custom_fields` (16) |
| 1 | L4 `…100100…` | 0 + `lifecycle_state, lifecycle_state_changed_at` (18) |
| 2 | C4 `…100600…` | 1 + `primary_contact_id, primary_contact_source, primary_contact_set_at` (21) |

**`public.breeze_device_child_orgid_tables()`** — drives `breeze_cascade_device_org_id()`, the AFTER UPDATE OF
`org_id` trigger that restamps every table with uuid `device_id` + `org_id` columns, **except** its `NOT IN` list.
Both new tables must stay in the source org (or be deleted) on move-org, so both are excluded.

| Order | Defined in | `NOT IN` list |
|---|---|---|
| 0 | `2026-12-27-170000-pam-org-move-unactuated-elevation-restamp.sql:44` (last on main) | the 12 names there (`ai_agent_runs` … `elevation_requests`); 11 of them carry uuid `device_id` + `org_id` (`pam_ledger_retirements` has no `org_id`) |
| 1 | L1 `…100000…` | 0 + `'device_lifecycle_events'` |
| 2 | C2 `…100500…` | 1 + `'device_primary_contact_dismissals'` |

Contract tests: `apps/api/src/db/partnerExportDevicesTrigger.contract.test.ts` (created L4, extended C4) and
`apps/api/src/db/deviceChildOrgidExclusions.contract.test.ts` (created L1, extended C2). **Existing exact-set pin:**
`apps/api/src/__tests__/integration/deviceOwnershipEpochs.integration.test.ts:423-449` asserts the *effective* exclusion set
(tables with uuid `device_id` + `org_id` that the function does not return) with `toEqual` over 11 sorted names. L1 adds
`'device_lifecycle_events'` and C2 adds `'device_primary_contact_dismissals'` to that array (kept sorted); it reds only in
the Integration Tests job. Both: find the
lexicographically-last migration (`localeCompare`, the `autoMigrate` order) that contains
`FUNCTION public.<name>(`, slice that function's body, parse, and assert. Neither test passes vacuously: each
asserts a non-zero match count first.

### 2.3 Lock order (every lifecycle or assignment write)

Move-org takes partner-export org locks, then the device row (`moveDeviceOrgInTransaction.ts` — order documented near `:11`; device `FOR UPDATE` ~`:443-448`). The
devices export trigger requests the org lock *after* the row is written (`2026-07-18-…:339`). A writer that locks
the device row first and then makes a listed column change would deadlock against a concurrent move. So, from the
wave each writer ships (not from L4/C4), every writer:

1. calls `lockDeviceExportOrgs(tx, orgIds)` — `SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[...]::uuid[])`
   with `orgIds` sorted ascending (the function raises P0001 on out-of-order acquisition; it takes the partner
   shared lock itself);
2. then `SELECT … FROM devices WHERE id = $1 FOR UPDATE`, re-checking `org_id` (and `site_id` where the route
   authorised one) against the authorised values → `409 STATE_CHANGED` if the device moved;
3. then writes.

`lockDeviceExportOrgs(tx: DbTx, orgIds: readonly string[]): Promise<void>` lives in a new
`apps/api/src/services/partnerExportLocks.ts` (L1 Task L1.3). Set-based writers (bulk assign, contact-delete
pre-clear) pass every org they touch; the bulk routes are single-org by construction. Because the lock is taken
from day one, L4 and C4 change only the trigger body — no writer changes lock order at those waves.

### 2.4 `DeviceList.tsx` merge rule

`apps/web/src/components/devices/DeviceList.tsx` (and `DevicesPage.tsx`, `columnVisibility.ts`,
`bulkActionGating.ts`) are touched by L2, L3, C1, C2 (page entry) and C3 here, and by the tag-registry plan's 8833
W2/W4 and 8837 W04. **Every `DeviceList.tsx` wave lands one at a time: before opening the next such PR, rebase on
`main` after the previous one merged and re-run `DeviceList.test.tsx` and `DeviceList.unified.test.tsx`.** Never
stack two of them.

**#7324 W1 first.** #7324's W1 (device-list column catalog + `exportValue`, being planned in parallel as
plan-asset-c from `origin/spec/7324-custom-fields-reports-export`) must merge before L2's column task and C1's
column task. Both new columns (`lifecycle`, `assignedTo`) are registered through that catalog with an
`exportValue`: `lifecycle` exports the raw enum value (`spare`), `assignedTo` exports the contact's email, or
`''` when unassigned or restricted. If #7324 W1 has not merged when L2 is otherwise ready, ship L2 without
Task L2.4 and land L2.4 as its own PR after #7324 W1 (it is self-contained).

### 2.5 Registration matrix

| Registration | `device_lifecycle_events` (L1) | `device_primary_contact_dismissals` (C2) | `devices` new columns (L1, C1) | `device_sessions.principal_upn` (C1) | `portal_branding.devices_scope` (C1) | `manual_assets.lifecycle_state` (L6) |
|---|---|---|---|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | yes — between `device_ip_history` (`:565`) and `device_link_groups` (`:569`), per the file's ordering comment | yes — alphabetical slot per the file's comment | — | — | — | — |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts:644`) | **no** — the L-D6 exception: device delete detaches, so purge never deletes disposal evidence | yes (FK `ON DELETE CASCADE`) | — | — | — | — |
| `DEVICE_DETACH_DEVICE_ID_TABLES` (`core.ts:208`) | **yes** (`cascadeDelete.test.ts:160` requires exactly one set) | no | — | — | — | — |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`core.ts:315`) | **no** — stays in source org; add to `INTENTIONALLY_NO_ORG_ID` (`moveOrg.coverage.test.ts:35`) **and** the comment block in `core.ts` | **no** — deleted before the flip; same two entries | — | — | — | — |
| `breeze_device_child_orgid_tables()` `NOT IN` | yes (§2.2) | yes (§2.2) | — | — | — | — |
| move-org explicit step (`moveDeviceOrgInTransaction.ts`, **before** the `.update(devices)` org flip at ~`:497`, next to the `manual_assets` detach at ~`:316`) | `UPDATE … SET device_id = NULL` (after writing the C1 `move_org` assignment event, if any) | `DELETE … WHERE device_id = $1` | C1: `primaryContactId: null` in the org-flip statement itself (~`:497`) | — | — | — |
| `orgMergeRegistry.ts` `REPOINT_TABLES` (`:772`) | plain `repoint` (near `device_ip_history` `:933`) | plain `repoint` (`UNIQUE(device_id, identity)` cannot collide across orgs) | no change (`devices` already repoint, `:960`) | — | — | — |
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | new entry, every column `included` | new entry, every column `included` | `devices` (`:438`) `included` += the 4 lifecycle (L1) and 3 contact (C1) columns | `device_sessions` (`:408`) `included` += `principal_upn` | `portal_branding` (`:714`) `included` += `devices_scope` | `manual_assets` `included` += its new columns |
| `rls-coverage` allowlists | none (Shape 1, auto-discovered) | none | — | — | — | — |
| `AUDIT_ADMIN_REQUIRED_TABLES` | no (not append-only at the DB level; no route updates rows) | no | — | — | — | — |
| `selfManagedDbContextRoutes.ts` | `PUT /devices/:id/lifecycle`, `POST /devices/bulk/lifecycle`, and `DELETE /devices/:id` (§4 Δ4) | `POST /devices/bulk/primary-contact`, `POST /devices/bulk/primary-contact/accept-suggestions` | — | — | — | — |
| partner-wide-write-coverage / site-ceiling-write-coverage | not applicable (`org_id NOT NULL`, not a governance table) — state in PR | same | — | — | — | — |

`org_id NOT NULL` justification (both tables): per-device inventory/custody records and per-device dismissals,
not config or policy; a partner-wide row is not a coherent concept (L§Tenancy, C§Users & scope).

### 2.6 CI traps (read before each PR)

- `pnpm test` runs none of: `rls-coverage` (own config: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`), `tenantCascade.integration`, `tenant-export-policy.integration`, `tenantExportErasureRoundtrip.integration`, `orgMergeRegistry.integration`, `orgLifecycleFoundations.integration`, `partnerApiExportWatermark.integration`, `dynamicGroupReevaluation.integration`, or any new `*.integration.test.ts`. Run them on `pnpm test-stack up` (or a `pnpm wt-stack` with root `.env` copied, AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET`), then `pnpm test-stack down`.
- A missing org-merge policy reds only the full unit `orgMerge.test.ts` suites; run all three (`routes/`, `jobs/`, `services/orgMerge.test.ts`).
- A stacked PR (base ≠ `main`) gets no CI: `gh workflow run CI --ref <branch>`. These waves should each target `main`.
- Vitest path filters are substring matches: list sibling files explicitly (e.g. `DeviceList.test.tsx DeviceList.unified.test.tsx`), and check the reported file count.
- The `aiToolIndex.test.ts` cap is rendered bytes (< 6656) — parameter additions normally do not change the index text, but run it.
- `exportSafety.classification.ts:28` defaults `devices` fields to `customer-authored`; new Partner API fields need no exception, but the `dtoSafety` snapshot changes — update it deliberately, never with `-u` blind.

---

## 3. Quorum outcome

Position formed first (Opus 5.5), then Codex `gpt-6-astra` `xhigh`, read-only, on the wave split, the L-D6
detach exception's access/retention rules, and the trigger-redefinition ordering. Verdict on all three:
**AGREE-WITH-CHANGES**. Every change below was verified against `main` and adopted; nothing is left in dispute.

| # | Codex finding | Adopted as |
|---|---|---|
| Q1a | The move-org detach must run **before** the device's org UPDATE, not beside `ai_agent_runs` (after it): the DEFERRABLE INITIALLY IMMEDIATE composite FK checks at the end of that statement (`moveDeviceOrgInTransaction.ts:294-308`). | §2.5 move-org row; L1.5 |
| Q1b | `breeze_device_child_orgid_tables()` independently discovers and restamps any `device_id`+`org_id` table; the TS lists alone do not stop it. | §2.2 ledger; L1.1, C2.1; contract test |
| Q2 | Tenant export is a platform-admin + MFA reader (`middleware/platformAdmin.ts:18`, `routes/admin/tenantExport.ts:29`), not the scope/`devices:read` conjunction. | L-D6 "system-scope" reader = platform-admin tenant export; L1.7 asserts the export carries detached rows and the register route refuses org scope |
| Q3a | Single-row transactions are not a lock-order exemption: lifecycle locks the device then the trigger requests the export lock; move-org locks in the other order. | §2.3 (pre-lock from day one in every writer); L4.4 concurrency test |
| Q3b | Strengthen the trigger contract test: three comparison pairs, identical ordered columns, non-zero matches. | §2.2; L4.5 |
| O1 | `PATCH /devices/:id` admits machine principals; `primaryContactId` cannot be a server-controlled targeting field unless its writers are interactive sessions. | §4 Δ6; C1.3 field-level guard |
| O2 | `device_sessions` rows are restamped on move, so `device_sessions.org_id = devices.org_id` does not exclude prior-customer evidence. | §4 Δ7; C2.2 lower bound = current `device_ownership_epochs.started_at` |
| O3 | Accept-suggestion needs the `expectedPrimaryContactId` check under a row lock; PATCH updates by id alone today (`core.ts:2292-2296`). | §2.3 step 2; C1.3, C2.4 |
| O4 | Extracting removal helpers does not fix DELETE's premature "post-commit" teardown; DELETE must become self-managed too. Re-evaluation uses `requestDeviceGroupReevaluationAfterCommit`. | §4 Δ4; L1.4 |
| O5 | With nullable contact ids and no snapshots, "erased contact → B" and "unassigned → B" are indistinguishable. | §4 Δ8: `from_contact_present` / `to_contact_present` booleans |
| O6 | Retention needs a partial index on `detached_at`, worker init/shutdown, readiness and metrics-name registration. | L1.7 |
| O7 | Marking a bulk action "ungated" does not render it in the removed-only menu (`DeviceList.tsx:1350`); the menu block and the pinned expectations must change. | L3.3, C3.1 |

---

## 4. Deviations from the specs (each with its reason)

| Δ | Spec said | Plan does | Why |
|---|---|---|---|
| Δ1 | L§Data model: events table with lifecycle columns only | L1 creates the table in its **final** shape: `kind` admits `assignment`; `from_state`/`to_state` nullable with kind CHECKs; reserved `from_contact_id`, `to_contact_id`, `from_contact_present`, `to_contact_present`; `detached_at` | C-D4 shares the table. C1 then needs no DDL on a populated table, and both features' rows share one detach/access/retention rule |
| Δ2 | L§Surfaces: `GET /devices/:id/lifecycle-events` only | adds `GET /devices/lifecycle-register?orgId=` (L5) | L-D6 access rule needs an enforceable reader for detached rows |
| Δ3 | L§Suggested wave split: `deviceRemoval.ts` extraction in wave 3 | in L1 | L1's `PUT` accepts `remove`, which needs the shared pre-commit pointer clear and post-commit teardown |
| Δ4 | L§Side effects: only the new routes self-managed | `DELETE /devices/:id` also becomes self-managed | Codex O4: its teardown currently runs before the outer commit |
| Δ5 | L§Transitions step 1: "no partner lock" | every writer takes the partner-export org lock before the device lock (§2.3) | Codex Q3a; "no partner *admission* lock" still holds |
| Δ6 | C§Permissions: assignment uses PATCH's guards (scope + `devices:write` + MFA) | a PATCH body carrying `primaryContactId`, `acceptSuggestion` or `expectedPrimaryContactId` additionally requires an interactive user session (403 `INTERACTIVE_SESSION_REQUIRED`); bulk assignment routes use `requireInteractiveSession()` | Codex O1; the spec's own rationale (C§"Agent-reported evidence never writes the column") needs it |
| Δ7 | C§Suggestion engine: sessions counted when `device_sessions.org_id = devices.org_id` | sessions counted only from the current ownership epoch's `started_at` (`device_ownership_epochs`, `devices.ownership_epoch`), intervals clipped to it | Codex O2: session rows are restamped on move |
| Δ8 | C-D4 approved (b) without a column shape | assignment rows store contact ids only (no name/email snapshot) plus `*_contact_present` booleans | contact erasure stays complete; "Deleted contact" stays representable (Codex O5) |
| Δ9 | C§Partner-export: trigger gains `primary_contact_id` | gains `primary_contact_id, primary_contact_source, primary_contact_set_at` | the Partner API exposes all three |
| Δ10 | C§Portal: "`enable_devices` decides whether the page exists" | the existing gate (`featureFlags.ts:70-88`: visible when `enable_devices` OR `enable_self_service` OR no row) is unchanged; `devices_scope` filters whatever the gate admits | verified on main; see P-1 |
| Δ11 | Specs: 7 locales | 8 locale dirs | current tree |

---

## 5. Open Decisions (for the owner; each has a default the plan uses)

**P-1. Portal "Off" vs the legacy self-service gate (C3.6).** On main, devices are visible to portal users when
`enable_devices` is true **or** `enable_self_service` is not false (or there is no settings row). So the spec's
three-way control cannot mean "Off" for a portal with self-service on.
- (a) Keep the gate; the control writes `enable_devices` + `devices_scope`; when self-service keeps devices
  visible the editor shows "Shown because self-service is on" and the Off option is disabled with that reason.
- (b) Make `enable_devices` the sole gate (behaviour change for every portal with self-service on and
  `enable_devices` false — their device page disappears).
- **Recommend (a)** — no existing portal changes behaviour; `assigned` scope is enforced server-side regardless of
  which flag opened the gate. Settings place count stays 1 → 1.

**P-2. `manual_assets.retired_at` mapping (L6, L-D8 sub-question).**
- (a) Independent: `retired_at` keeps its meaning (out of use); lifecycle state is separate; the asset modal shows both.
- (b) `retired_at` set ⇔ `pending_disposal | disposed`.
- **Recommend (a)** — retirement precedes disposal and a forced coupling recreates the drift the spec removes.

**P-3. Retention override per org (L-D6).** v1 is env-only (`DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS`).
- (a) env only in v1; a `device_lifecycle` config-policy field `lifecycleHistoryRetentionDays` later if asked.
- (b) add the policy field in L1.
- **Recommend (a)** — the owner's rule names an env default; a policy knob adds a settings home (rule 9) for a value nobody has asked to vary.

---

## Wave L1 — schema, registrations, service, single routes, Restore guard, removal extraction, retention

**Branch:** `feature/<8836-parent#>-device-lifecycle/wave-<L1 sub#>` · **Migration:** `apps/api/migrations/2026-12-31-100000-device-lifecycle-state.sql`
**Tenancy shape:** Shape 1 (`breeze_has_org_access(org_id)`) table + columns on `devices`.
**Read first:** `docs/agents/tenancy-rls.md`, `apps/api/migrations/README.md`, L§Data model, L§Transitions, L§Side effects, L-D6.

### Task L1.1: Migration — enums, `devices` columns, CHECK, events table, detach trigger, RLS, child-orgid exclusion

**Files:**
- Create: `apps/api/migrations/2026-12-31-100000-device-lifecycle-state.sql`
- Create: `apps/api/src/db/schema/deviceLifecycleEvents.ts` (export from `apps/api/src/db/schema/index.ts`)
- Modify: `apps/api/src/db/schema/devices.ts` (four columns, near `maintenance_started_by` `:120`)
- Create: `apps/api/src/__tests__/integration/deviceLifecycleEvents.integration.test.ts`
- Create: `apps/api/src/db/deviceChildOrgidExclusions.contract.test.ts`
- Modify: `apps/api/src/__tests__/integration/deviceOwnershipEpochs.integration.test.ts` (`:437` expected exclusion array += `'device_lifecycle_events'`, sorted)

**Interfaces:**
- Produces: pg types `device_lifecycle_state`, `device_disposal_method`; Drizzle `deviceLifecycleStateEnum`, `deviceDisposalMethodEnum`; `devices.lifecycleState | lifecycleStateChangedAt | lifecycleStateChangedBy | lifecycleNote`; table `device_lifecycle_events` with columns exactly: `id, org_id, device_id, manual_asset_id, subject_label, subject_serial_number, kind, from_state, to_state, note, disposal_method, disposal_reference, disposed_at, from_contact_id, to_contact_id, from_contact_present, to_contact_present, source, actor_user_id, created_at, detached_at`; Drizzle `deviceLifecycleEvents`; exported TS types `DeviceLifecycleState`, `DeviceDisposalMethod`, `DeviceLifecycleEventKind = 'transition'|'correction'|'assignment'`, `DeviceLifecycleEventSource` (the seven sources in Global Constraints) in `packages/shared/src/types/deviceLifecycle.ts`.
- Constraints (names fixed): `devices_lifecycle_disposed_removed_chk`; `device_lifecycle_events_one_subject_chk` (`num_nonnulls(device_id, manual_asset_id) <= 1`); `device_lifecycle_events_kind_chk`; `device_lifecycle_events_source_chk`; `device_lifecycle_events_kind_shape_chk`:
  `(kind IN ('transition','correction') AND to_state IS NOT NULL AND from_contact_id IS NULL AND to_contact_id IS NULL AND NOT from_contact_present AND NOT to_contact_present) OR (kind = 'assignment' AND from_state IS NULL AND to_state IS NULL AND disposal_method IS NULL AND disposal_reference IS NULL AND disposed_at IS NULL)` (the disposal-fields CHECK alone evaluates NULL, i.e. passes, when `to_state` is NULL);
  `device_lifecycle_events_correction_chk` (`kind <> 'correction' OR (from_state = 'disposed' AND to_state = 'disposed')`);
  `device_lifecycle_events_disposal_fields_chk` (L§Data model text, unchanged);
  `device_lifecycle_events_contact_present_chk` (`(from_contact_id IS NULL OR from_contact_present) AND (to_contact_id IS NULL OR to_contact_present)`).
- FKs: `(device_id, org_id) → devices(id, org_id) ON DELETE SET NULL (device_id)`; `(manual_asset_id, org_id) → manual_assets(id, org_id) ON DELETE SET NULL (manual_asset_id)` (target `manual_assets_id_org_id_uniq`); `(from_contact_id, org_id)` and `(to_contact_id, org_id) → contacts(id, org_id) ON DELETE SET NULL (<col>)` (target `contacts_id_org_id_uniq`); all `DEFERRABLE INITIALLY IMMEDIATE`. `actor_user_id → users(id) ON DELETE SET NULL`. `lifecycle_state_changed_by → users(id) ON DELETE SET NULL`.
- Indexes: `device_lifecycle_events_org_created_idx (org_id, created_at DESC)`, `device_lifecycle_events_device_created_idx (device_id, created_at DESC)`, `device_lifecycle_events_disposed_idx (org_id, disposed_at) WHERE to_state = 'disposed'`, `device_lifecycle_events_detached_idx (detached_at) WHERE device_id IS NULL AND manual_asset_id IS NULL`.
- Trigger: `device_lifecycle_events_stamp_detached` `BEFORE UPDATE OF device_id, manual_asset_id … FOR EACH ROW WHEN (num_nonnulls(OLD.device_id, OLD.manual_asset_id) > 0 AND num_nonnulls(NEW.device_id, NEW.manual_asset_id) = 0)` → `NEW.detached_at := now()`.
- RLS: `ENABLE` + `FORCE`; four policies `device_lifecycle_events_{select,insert,update,delete}` each `breeze_current_scope() = 'system' OR breeze_has_org_access(org_id)` (USING and WITH CHECK where applicable), created inside `pg_policies` existence checks. Grants as the nearest Shape 1 precedent (`device_ip_history`).
- `CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()` = §2.2 order 1.

- [ ] **Step 1: Write the failing integration test** `deviceLifecycleEvents.integration.test.ts`:

```ts
it('CHECK rejects lifecycle_state = disposed on an active device (23514)')
it('accepts disposed on a decommissioned device')
it('as breeze_app, inserting an event for another org fails 42501; the same insert in the caller org succeeds')
it('deleting the device sets device_id NULL, stamps detached_at, keeps subject_label and subject_serial_number')
it('deleting the manual asset detaches a manual_asset_id row and stamps detached_at')
it('detached_at is not stamped while one subject remains, nor on an UPDATE that does not null a subject')
it('kind_shape_chk: assignment row with to_state set fails; transition row with to_contact_id set fails')
it('correction_chk: correction with from_state spare fails')
it('deleting a referenced contact nulls to_contact_id and keeps to_contact_present = true')
it('breeze_device_child_orgid_tables() does not list device_lifecycle_events')
it('composite FKs are DEFERRABLE INITIALLY IMMEDIATE (pg_constraint.condeferrable and NOT condeferred)')
```

- [ ] **Step 2: Write the failing static test** `deviceChildOrgidExclusions.contract.test.ts`:

```ts
const REQUIRED_EXCLUSIONS = [ /* all 12 NOT IN names from 2026-12-27-170000 */, 'device_lifecycle_events' ];
it('the last migration defining breeze_device_child_orgid_tables excludes every required table', () => {
  const { file, body } = lastDefinition('breeze_device_child_orgid_tables');   // localeCompare over apps/api/migrations/*.sql
  expect(file).toMatch(/^2026-12-31-100000-/);                                   // update when a later wave redefines it
  const excluded = parseNotInList(body);
  expect(excluded.length).toBeGreaterThan(0);
  expect(REQUIRED_EXCLUSIONS.filter((t) => !excluded.includes(t))).toEqual([]);
});
```

- [ ] **Step 3: Run both — expect FAIL** (`relation "device_lifecycle_events" does not exist`; static test: last file is `2026-12-27-170000-…`).
  `pnpm test-stack up`; `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceLifecycleEvents.integration.test.ts`; `cd apps/api && npx vitest run src/db/deviceChildOrgidExclusions.contract.test.ts`.
- [ ] **Step 4: Write the migration.** Order: types (`DO … EXCEPTION WHEN duplicate_object`); `ALTER TABLE devices ADD COLUMN IF NOT EXISTS` ×4; drop-if-exists + add `devices_lifecycle_disposed_removed_chk` (validates instantly — every row is `in_service`); table + constraints + indexes; trigger function + `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`; RLS + policies; the `breeze_device_child_orgid_tables()` redefinition copied verbatim from the last body plus one name. No row writes, no `set_config`.
- [ ] **Step 5: Drizzle schema** for both; `pnpm db:check-drift` — expect no drift.
- [ ] **Step 6: Run both tests + (stack) `deviceOwnershipEpochs.integration.test.ts` (red until its array gains the new name) + `cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts src/db/autoMigrate.test.ts` — expect PASS.**
- [ ] **Step 7: Commit** `feat(devices): device_lifecycle_events table, lifecycle columns and disposed⇒removed CHECK`.

### Task L1.2: Registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/routes/devices/core.ts` (`DEVICE_DETACH_DEVICE_ID_TABLES`, the intentionally-no-org comment block), `apps/api/src/routes/devices/moveOrg.coverage.test.ts` (`INTENTIONALLY_NO_ORG_ID`)

**Interfaces:**
- Export entry: `tablePolicy('org_id', { included: [<all 21 columns>], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`; `devices.included` += `lifecycle_state, lifecycle_state_changed_at, lifecycle_state_changed_by, lifecycle_note`.
- PR text states why the table is **not** in `CORE_DEVICE_CASCADE_DELETE_TABLES` (L-D6 named exception) and not in `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (source-org history).

- [ ] **Step 1: Run the static contract tests and watch them fail on the new table:** `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts` (expect `device_lifecycle_events: in NO set`; moveOrg passes until Step 2 adds the detach set, then fails `missing`). Then on the test stack: `test:rls-coverage`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts` — record the failing assertion names in the PR.
- [ ] **Step 2: Add the five registrations** (§2.5 column 1).
- [ ] **Step 3: Re-run** the two static tests, the three unit `orgMerge.test.ts` files, and on the stack `test:rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations` — expect PASS.
- [ ] **Step 4: Commit** `feat(devices): register device_lifecycle_events in cascade, merge, export and device lists`.

### Task L1.3: `setDeviceLifecycleState` service + export-lock helper

**Files:**
- Create: `apps/api/src/services/partnerExportLocks.ts`, `apps/api/src/services/deviceLifecycleState.ts`
- Test: `apps/api/src/services/deviceLifecycleState.test.ts`, `apps/api/src/services/partnerExportLocks.test.ts`

**Interfaces:**
- Consumes: `decommissionDeviceInTransaction(tx, …)` (`services/deviceDecommission.ts:22`); `clearReplacementPointersInTransaction` from L1.4.
- Produces:
  - `lockDeviceExportOrgs(tx: DbTx, orgIds: readonly string[]): Promise<void>` — dedupes, sorts ascending, one `breeze_partner_export_lock_orgs_exclusive` call; no-op on empty.
  - `lifecycleSuppressesOfflineAlerts(state: DeviceLifecycleState): boolean` — `true` for `spare`, `pending_disposal` only (consumed by L4).
  - `class DeviceLifecycleStateError extends Error { code: 'DEVICE_NOT_REMOVED'|'DISPOSAL_FIELDS_NOT_ALLOWED'|'DISPOSAL_METHOD_REQUIRED'|'NOTE_REQUIRED'|'STATE_CHANGED'|'NOT_FOUND'; status: 400|404|409 }`.
  - `setDeviceLifecycleState(tx: DbTx, input: SetLifecycleInput): Promise<SetLifecycleResult>` where
    `SetLifecycleInput = { deviceId; authorizedOrgId; authorizedSiteId?: string|null; state: DeviceLifecycleState; note?: string; disposal?: { method: DeviceDisposalMethod; reference?: string; disposedAt?: string /* YYYY-MM-DD */ }; remove?: { uninstallAgent: boolean }; expectedState?: DeviceLifecycleState; source: 'single'|'bulk'|'remove_dialog'; actorUserId: string }` and
    `SetLifecycleResult = { changed: boolean; device: DeviceRow; event: DeviceLifecycleEventRow | null; removed: boolean; uninstallQueued: boolean; postCommit: DeviceRemovalPostCommit | null; rearmOffline: boolean }`.
    `rearmOffline` is computed now (from suppressing → non-suppressing while `status = 'offline'`) and acted on in L4.
- Order inside (fixed): `lockDeviceExportOrgs([authorizedOrgId])` → `SELECT … FOR UPDATE` → org/site/`expectedState` re-checks → rule checks (L§Transitions 1–4) → if `disposed` and not Removed: `decommissionDeviceInTransaction` + `clearReplacementPointersInTransaction` → `UPDATE devices` (state, `changed_at = now()`, `changed_by`, `lifecycle_note`) → `INSERT` event (snapshots: `subject_label = coalesce(display_name, hostname)`, `subject_serial_number` from `device_hardware`). Same-state without disposal fields → `{ changed: false }`, no write. `disposed → disposed` with disposal fields → new `kind = 'correction'` event, device row's note/changed_at updated, original event untouched.

- [ ] **Step 1: Write failing tests** (`deviceLifecycleState.test.ts`, Drizzle mocks per `breeze-testing`):

```ts
it('active device → disposed without remove throws DEVICE_NOT_REMOVED (409)')
it('active device → disposed with remove calls decommission BEFORE the devices UPDATE')
it('already-Removed device → disposed does not call decommissionDeviceInTransaction (decommissioned_at untouched)')
it('disposal fields on → spare throw DISPOSAL_FIELDS_NOT_ALLOWED (400)')
it('→ disposed without disposal.method throws DISPOSAL_METHOD_REQUIRED (400)')
it('disposed → spare without note throws NOTE_REQUIRED (400); with note succeeds and status stays decommissioned')
it('same-state write is a no-op: no UPDATE, no INSERT, changed=false')
it('disposed → disposed with a reference writes kind=correction and never updates the earlier event')
it('expectedState mismatch throws STATE_CHANGED (409)')
it('device moved to another org after authorisation throws STATE_CHANGED')
it('calls lockDeviceExportOrgs before the FOR UPDATE select')            // call-order assertion on the mock
it('rearmOffline is true for spare → in_service while offline, false for lost_stolen → in_service')
it('lifecycleSuppressesOfflineAlerts: spare/pending_disposal true; in_service/lost_stolen/disposed false')
```
  `partnerExportLocks.test.ts`: `it('sorts and dedupes org ids before one lock call')`, `it('does nothing for an empty list')`.
- [ ] **Step 2: Run — expect FAIL** (module not found). `cd apps/api && npx vitest run src/services/deviceLifecycleState.test.ts src/services/partnerExportLocks.test.ts`
- [ ] **Step 3: Implement both modules** to the Interfaces above.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(devices): setDeviceLifecycleState service with export-lock-first ordering`.

### Task L1.4: `deviceRemoval.ts` extraction; DELETE becomes self-managed

**Files:**
- Create: `apps/api/src/services/deviceRemoval.ts`
- Modify: `apps/api/src/routes/devices/core.ts` (DELETE `:2473`; pointer clear `:2529-2538`; teardown `:2539-2557`), `apps/api/src/middleware/selfManagedDbContextRoutes.ts`
- Test: `apps/api/src/services/deviceRemoval.test.ts`, existing DELETE route tests, `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`

**Interfaces:**
- Produces: `clearReplacementPointersInTransaction(tx: DbTx, deviceId: string): Promise<void>`; `type DeviceRemovalPostCommit = { deviceId: string; orgId: string }`; `runDeviceRemovalPostCommit(p: DeviceRemovalPostCommit): Promise<void>` (remote-session teardown + agent WS disconnect, errors logged and captured, never thrown).
- DELETE `/devices/:id` runs `runOutsideDbContext` → `withDbAccessContext` (its own transaction) → after it resolves, `runDeviceRemovalPostCommit`. Self-managed entry `{ method: 'DELETE', pattern: /^\/api\/v1\/devices\/[^/]+\/?$/ }`.

- [ ] **Step 1: Failing tests:** `it('DELETE runs session teardown only after the transaction committed')` (teardown mock asserts the tx-commit spy fired first); `it('a failed decommission transaction runs no teardown')`; `it('replacement pointers are cleared inside the decommission transaction')`; `selfManagedDbContextRoutes.test.ts`: `it('DELETE /api/v1/devices/:id is self-managed')`, and the same for `PUT /api/v1/devices/:id/lifecycle` (used by L1.6).
- [ ] **Step 2: Run — expect FAIL.** `cd apps/api && npx vitest run src/services/deviceRemoval.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/routes/devices/core.delete` (list the DELETE test files explicitly; check the count).
- [ ] **Step 3: Extract and rewire.** Behaviour of DELETE is otherwise unchanged (same audit, same response).
- [ ] **Step 4: Run — expect PASS**, plus the existing `DeviceDetailPage.removeDialog.test.tsx` is untouched.
- [ ] **Step 5: Commit** `refactor(devices): shared removal helpers; DELETE teardown runs after commit`.

### Task L1.5: Move-org detach and Restore guard

**Files:**
- Modify: `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts` (before the org flip ~`:497`, beside the `manual_assets` detach ~`:316`), `apps/api/src/services/deviceLifecycle.ts` (`restoreRemovedDevice` `:192`, under its existing `FOR UPDATE`)
- Test: `apps/api/src/__tests__/integration/deviceLifecycleEvents.integration.test.ts` (extend), `apps/api/src/services/deviceLifecycle.test.ts`

**Interfaces:**
- `restoreRemovedDevice` throws `DeviceLifecycleError('DEVICE_DISPOSED', 409)` with message `Undo the disposal first.` when the locked row has `lifecycle_state = 'disposed'`; bulk restore reports it per device.

- [ ] **Step 1: Failing tests:** integration `it('move-org detaches the device events (device_id NULL, org_id unchanged, detached_at set) and the move succeeds with no 23503')`; `it('org merge repoints events to the survivor org')`; `it('a Restore racing a set-disposed: one 409, no 23514, no 40P01')` (two connections); unit `it('restoreRemovedDevice refuses a disposed device with DEVICE_DISPOSED before any UPDATE')`; `it('restore of a spare Removed device leaves lifecycle_state spare')`.
- [ ] **Step 2: Run — expect FAIL** (23503 on move; restore returns 500 from 23514).
- [ ] **Step 3: Implement** the detach statement and the guard.
- [ ] **Step 4: `status:` writer sweep (L-D2).** `git grep -n -E "update\(devices\)|UPDATE (public\.)?devices" apps/api/src` and list every writer that sets `status`; for each, record in the PR whether it can set a non-`decommissioned` status on a decommissioned row (expected: only `restoreRemovedDevice`). Add `it('heartbeat for a disposed device does not 500')` to the agent heartbeat route test if the heartbeat writer touches `status` without a decommissioned guard.
- [ ] **Step 5: Run — expect PASS. Commit** `feat(devices): lifecycle events stay with the source org on move; Restore refuses disposed devices`.

### Task L1.6: Routes `PUT /devices/:id/lifecycle`, `GET /devices/:id/lifecycle-events`; DTO

**Files:**
- Create: `apps/api/src/routes/devices/lifecycleState.ts` (mounted in `routes/devices/index.ts` before `coreRoutes`, next to `bulkLifecycleRoutes` `:138`); `packages/shared/src/validators/deviceLifecycle.ts`
- Modify: `apps/api/src/routes/devices/helpers.ts` (`PUBLIC_DEVICE_FIELDS` `:20-50`), `apps/api/src/routes/devices/core.ts` (list select `:1313` and mapper `:1537`, detail), `apps/api/src/middleware/selfManagedDbContextRoutes.ts`
- Test: `apps/api/src/routes/devices/lifecycleState.test.ts`, `apps/api/src/routes/devices/devicePublicProjection.contract.test.ts`, `apps/api/src/routes/devices/bulkLifecycle.mountorder.test.ts`

**Interfaces:**
- Validators: `setLifecycleStateSchema = z.object({ state: z.enum(LIFECYCLE_STATES), note: z.string().max(1000).optional(), disposal: z.object({ method: z.enum(DISPOSAL_METHODS), reference: z.string().max(255).optional(), disposedAt: isoDate.optional() }).strict().optional(), remove: z.object({ uninstallAgent: z.boolean() }).strict().optional(), expectedState: z.enum(LIFECYCLE_STATES).optional() }).strict()`.
- `PUT` guard chain: `requireScope('organization','partner','system')` → `requireInteractiveSession()` → `requirePermission(devices:write)` → `requireMfa()` → device access (org + site reach, 404 cross-org, 403 site-confined) → if `remove`: `DEVICES_DELETE`. Response `200 { device, event, uninstallQueued? }`; errors map `DeviceLifecycleStateError.status`/`code`. After commit: `writeRouteAudit('device.lifecycle_state_change', { from, to, source, disposalMethod? })`, `runDeviceRemovalPostCommit` when removed. (Event publish, group re-evaluation and re-arm are wired in L2/L4.)
- `GET /devices/:id/lifecycle-events?page&limit` (`devices:read`, device access): `WHERE device_id = $id ORDER BY created_at DESC`; returns `{ data: LifecycleEventDto[], pagination }` with `LifecycleEventDto = { id, kind, fromState, toState, note, disposalMethod, disposalReference, disposedAt, fromContactId, toContactId, fromContactPresent, toContactPresent, source, actorUserId, actorName, createdAt }`.
- DTO: `lifecycleState`, `lifecycleStateChangedAt`, `lifecycleNote` added to `PUBLIC_DEVICE_FIELDS` and the list/detail responses.

- [ ] **Step 1: Failing route tests** (`lifecycleState.test.ts`):

```ts
it('API-key principal is refused 403 even with devices:write')            // requireInteractiveSession
it('session without devices:write → 403; without MFA → MFA challenge')
it('remove present without DEVICES_DELETE → 403; with it → 200 and uninstallQueued per uninstallAgent')
it('cross-org device → 404; site-confined tech outside the site → 403')
it('active → disposed without remove → 409 DEVICE_NOT_REMOVED')
it('GET lifecycle-events never returns rows of another device or detached rows')
it('GET /devices and GET /devices/:id include lifecycleState, lifecycleStateChangedAt, lifecycleNote')
```
  plus `devicePublicProjection.contract.test.ts` gains the three fields; `bulkLifecycle.mountorder.test.ts` asserts `lifecycleStateRoutes` mounts before `coreRoutes`.
- [ ] **Step 2: Run — expect FAIL.** `cd apps/api && npx vitest run src/routes/devices/lifecycleState.test.ts src/routes/devices/devicePublicProjection.contract.test.ts src/routes/devices/bulkLifecycle.mountorder.test.ts`
- [ ] **Step 3: Implement** routes, validators, DTO, self-managed entry.
- [ ] **Step 4: Run — expect PASS**; typecheck `apps/api` and `packages/shared` (12 GB heap, exit code).
- [ ] **Step 5: Commit** `feat(devices): PUT /devices/:id/lifecycle and lifecycle history API`.

### Task L1.7: Detached-row retention job (L-D6) and export reader check

**Files:**
- Create: `apps/api/src/jobs/deviceLifecycleEventRetention.ts`, `apps/api/src/jobs/deviceLifecycleEventRetention.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (`'device-lifecycle-event-retention': '33 8 * * *'` — daily ≡3 (mod 5) lane; hour 8 holds 3/13/23/43; re-check), `apps/api/src/services/retentionMetrics.ts` (`RETENTION_JOB_NAMES` += `'device_lifecycle_event_retention'`, sorted), `apps/api/src/services/workerRegistry.ts` (next to `removedDevicePurge` `:816`), `apps/api/src/jobs/workerReadinessManifest.ts`, `.env.example` (commented `DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS=400`)
- Test: extend `deviceLifecycleEvents.integration.test.ts`; `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` fixture gains one detached row

**Interfaces:**
- Mirrors `jobs/ipHistoryRetention.ts`: `DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS, 400, 3650, LOG_PREFIX)` with a floor of 30 applied after resolve; `pruneInCtidBatches({ table: 'device_lifecycle_events', where: sql\`device_id IS NULL AND manual_asset_id IS NULL AND detached_at <= ${cutoff}\`, … })`; `recordRetentionRun('device_lifecycle_event_retention', …)`. Exports `getDeviceLifecycleEventRetentionQueue()`, `createDeviceLifecycleEventRetentionWorker()`.

- [ ] **Step 1: Failing tests:** unit `it('default is 400 days; env 10 clamps to 30; env 99999 clamps to 3650')`; `it('where clause never matches an attached row')`; integration `it('prunes a row detached 401 days ago, keeps one detached 399 days ago and an attached row created 5 years ago')`; `it('tenant export of the org includes detached rows (platform-admin reader)')`; `retentionMetrics.test.ts` sorted-names assertion.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement and register.**
- [ ] **Step 4: Run — expect PASS** (unit: `deviceLifecycleEventRetention.test.ts`, `retentionMetrics.test.ts`, `scheduleRegistry` tests, `workerRegistry` tests; integration on the stack).
- [ ] **Step 5: Commit** `feat(devices): retain detached lifecycle events for DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS`.

**L1 exit gate:** all of §1 row 1's suites green (unit + stack), `tsc --noEmit` exit 0 for `apps/api`, `packages/shared`; PR body names the L-D6 exception and the CORE_DEVICE_CASCADE_DELETE_TABLES omission.

---

## Wave L2 — web: badge, dialog, Lifecycle card, filter field, re-evaluation, list column + chips

**Branch:** `feature/<8836-parent#>-device-lifecycle/wave-<L2 sub#>` · **Migration:** none.
**Read first:** L§Surfaces (Device page, Device list), §2.4.

### Task L2.1: Filter field + group re-evaluation (API)

**Files:**
- Modify: `apps/api/src/services/filterEngine.ts` (`FILTER_FIELDS` `:73`, next to `status`; `SERVER_CONTROLLED_FILTER_FIELDS` `:232`), `packages/shared/src/types/filters.ts` (field union if it enumerates keys), `apps/api/src/events/deviceEvents.ts` (`mapChangedFieldsToFilterFields`), `apps/api/src/routes/devices/lifecycleState.ts` (call `requestDeviceGroupReevaluationAfterCommit({ deviceId, orgId, reason: 'lifecycle_state', changedFields: ['lifecycleState'] })` when `changed`)
- Test: `apps/api/src/services/filterEngine*.test.ts` (trust-tier suite), `apps/api/src/events/deviceEvents.test.ts`, `apps/api/src/__tests__/integration/dynamicGroupReevaluation.integration.test.ts`

**Interfaces:** fields `lifecycleState` (enum, operators `equals | notEquals | in | notIn`) and `lifecycleStateChangedAt` (date, the date operator set incl. `olderThanDays`); both server-controlled (allowed for execution targeting).

- [ ] **Step 1: Failing tests:** `it('lifecycleState and lifecycleStateChangedAt are server-controlled')`; `it('mapChangedFieldsToFilterFields maps lifecycleState')`; integration `it('a lifecycleState = pending_disposal group gains the device on PUT and loses it on the next PUT')`.
- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — PASS. Step 5: Commit** `feat(devices): lifecycleState filter fields and group re-evaluation`.

### Task L2.2: `LifecycleStateDialog` + badge

**Files:**
- Create: `apps/web/src/components/devices/LifecycleStateDialog.tsx`, `LifecycleStateDialog.test.tsx`, `LifecycleStateBadge.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (badge beside the status pill, status maps `:161-172`; actions-menu entry), `RemoveDeviceDialog.tsx` (export its agent-radio section as `RemoveAgentChoice` for reuse), locales ×8 (`devices` namespace)

**Interfaces:**
- `LifecycleStateDialog({ device: { id, status, lifecycleState }, open, onClose, onSaved(device) })`. Radio of five states; note (required when leaving `disposed`); for `disposed`: method select (required), reference, date; when the device is active and `disposed` is picked, embeds `RemoveAgentChoice` defaulting to *Uninstall* and submit copy `Remove and mark disposed`; "Still billable" hint for `spare | pending_disposal | lost_stolen` (L-D4). Submits `PUT /devices/:id/lifecycle` through `runAction` with `expectedState`. A 409 `STATE_CHANGED` shows "This device changed — reload".
- `LifecycleStateBadge` renders nothing for `in_service`; `data-testid="device-lifecycle-badge"`.

- [ ] **Step 1: Failing tests:** `it('badge hidden for in_service')`; `it('embedded Remove section only when active and disposed is selected')`; `it('method required for disposed; note required when leaving disposed')`; `it('submits through runAction with expectedState')`; `it('shows still-billable hint for spare')`.
- [ ] **Step 2: Run — expect FAIL.** `cd apps/web && npx vitest run src/components/devices/LifecycleStateDialog.test.tsx`
- [ ] **Step 3: Implement**; all strings in 8 locales.
- [ ] **Step 4: Run** the test + `src/lib/__tests__/no-silent-mutations.test.ts` + `src/lib/i18n/localeParity.test.ts` + `DeviceDetailPage.removeDialog.test.tsx` — PASS.
- [ ] **Step 5: Commit** `feat(web): lifecycle state dialog and badge`.

### Task L2.3: Lifecycle card in `DeviceInfoTab`

**Files:** Modify `apps/web/src/components/devices/DeviceInfoTab.tsx`; create `DeviceLifecycleCard.tsx` + test; locales ×8.

**Interfaces:** card shows state, who/when (`lifecycleStateChangedAt` NULL → "Not recorded"), and a timeline from `GET /devices/:id/lifecycle-events`; assignment rows (C1+) render "Assigned to X" / "Unassigned" / "Deleted contact" from `*ContactId` + `*ContactPresent` (implemented here so C1 needs no card change).

- [ ] **Step 1: Failing tests:** `it('renders Not recorded for a never-changed device')`; `it('renders correction events as a correction of the disposal')`; `it('renders an assignment row whose contact was deleted as Deleted contact')`.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit** `feat(web): device lifecycle card and history timeline`.

### Task L2.4: List column + quick chips (after #7324 W1; §2.4)

**Files:** Modify `apps/web/src/components/devices/columnVisibility.ts` (`COLUMN_IDS`/`COLUMN_LABELS`, not in `DEFAULT_VISIBLE_COLUMNS`), the #7324 W1 column catalog, `DeviceList.tsx` (`Device` type, `sortValue` `:714`, `columnDefs` `:1599`, chips near `:2349`), `apps/web/src/components/filters/filterFields.ts` (`lifecycleState`, `lifecycleStateChangedAt`); locales ×8.

**Interfaces:** column id `lifecycle`, `exportValue` = raw enum; chips In service / Spare / Pending disposal / Lost / Disposed; the Disposed chip also sets `includeDecommissioned` (default-hide `:1108-1116`). Agent-only: yes (manual rows have no lifecycle until L6 — L6 removes it from `AGENT_ONLY_COLUMNS` `:451`).

- [ ] **Step 1: Failing tests** (`DeviceList.test.tsx`): `it('Disposed chip turns on includeDecommissioned and shows a disposed removed device')`; `it('lifecycle column is off by default and sorts by enum order')`; `columnVisibility.test.ts` registry assertion.
- [ ] **Step 2–4: FAIL → implement → PASS** (`DeviceList.test.tsx DeviceList.unified.test.tsx columnVisibility.test.ts`). **Step 5: Commit** `feat(web): lifecycle column and quick chips on the device list`.

---

## Wave L3 — bulk route, bulk bar, Remove-dialog "Also mark as"

**Read first:** L§Surfaces (Bulk, Remove dialog), §2.4, `routes/devices/bulkLifecycle.ts:92` (`/bulk/restore` pattern).

### Task L3.1: `POST /devices/bulk/lifecycle`

**Files:** Modify `apps/api/src/routes/devices/bulkLifecycle.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, `packages/shared/src/validators/deviceLifecycle.ts`; test `apps/api/src/routes/devices/bulkLifecycle.lifecycleState.test.ts`, `bulkLifecycle.mountorder.test.ts`.

**Interfaces:** body `{ deviceIds: bulkDeviceIdsSchema, state, note?, disposal?, remove? }`; guards as L1.6; `runBulkIsolated` (`lib/bulkOps.ts`) — one `setDeviceLifecycleState` transaction per device with `source: 'bulk'`; response `200 { succeeded: string[], failed: { deviceId, code }[] }`; one audit row, one `requestDeviceGroupReevaluationAfterCommit({ changedFields: ['lifecycleState'] })` and (from L4) one `device.lifecycle_state_changed` publish per changed device; post-commit teardown per removed device.

- [ ] **Step 1: Failing tests:** `it('501 ids → 400')`; `it('API-key principal → 403')`; `it('one device failing DEVICE_NOT_REMOVED does not roll back the others')`; `it('already-Removed devices keep decommissioned_at; active ones are removed when remove is present')`; `it('same-state devices are reported succeeded with no event')`; mount-order + self-managed entries.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit** `feat(devices): bulk lifecycle state route`.

### Task L3.2: Remove dialog "Also mark as"

**Files:** Modify `apps/web/src/components/devices/RemoveDeviceDialog.tsx` (+ test), `apps/api/src/routes/devices/core.ts` DELETE (accept optional `{ alsoMark?: { state: 'spare'|'pending_disposal'|'disposed', disposal? } }`), locales ×8.

**Interfaces:** DELETE with `alsoMark` first calls `lockDeviceExportOrgs(tx, [orgId])` (§2.3 — `decommissionDeviceInTransaction` UPDATEs the device row, so the export lock must precede it), then runs `decommissionDeviceInTransaction`, then in the **same** transaction `setDeviceLifecycleState({ …, source: 'remove_dialog' })` (device is Removed by then, so `remove` is never passed; its own `lockDeviceExportOrgs` call is a no-op for an already-held org — the SQL function skips held orgs, `2026-07-22-partner-export-lock-upgrade-hardening.sql` `IF org_id = ANY(held_orgs) THEN CONTINUE`). DELETE without `alsoMark` is unchanged. Select default *Leave unchanged*; `Disposed` reveals the method (required) field.

- [ ] **Step 1: Failing tests:** API `it('DELETE with alsoMark takes the export lock before the decommission UPDATE')` (call order); `it('DELETE with alsoMark=disposed writes one remove_dialog event and leaves decommissioned_at as set by this removal')`; `it('DELETE with alsoMark rolls back the removal when the lifecycle step fails')`; web `it('Leave unchanged is the default and sends no alsoMark')`.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit** `feat(devices): mark lifecycle state from the Remove dialog`.

### Task L3.3: Bulk bar entry + gating (§2.4 rule applies)

**Files:** Modify `apps/web/src/components/devices/DeviceList.tsx` (active menu block **and** the removed-selection block ~`:1350`/`:3068-3088`), `DevicesPage.tsx` (`runBulkAction` `:1600`), `bulkActionGating.ts`, `DeviceList.test.tsx`; create `BulkLifecycleStateDialog.tsx` + test; locales ×8.

**Interfaces:** action id `'set-lifecycle-state'` in `INTENTIONALLY_UNGATED_BULK_ACTIONS` (`:130`). `REMOVED_ONLY_BULK_ACTIONS` stays `['permanent-delete','restore']`. The all-removed menu expectation (`DeviceList.test.tsx:1578`) becomes `['compare','permanent-delete','restore','set-lifecycle-state']`. Confirm copy for mixed selections: `{n} will be removed and marked disposed, {m} are already removed`. Bulk call through `runAction` without `successMessage`; per-device failures summarised.

- [ ] **Step 1: Failing tests:** the updated `:1578` expectation; the exactly-one-set test (`:1593`) includes `set-lifecycle-state`; `it('mixed selection confirm counts removed and active devices')`.
- [ ] **Step 2–4: FAIL → implement → PASS** (`DeviceList.test.tsx DeviceList.unified.test.tsx BulkLifecycleStateDialog.test.tsx` + no-silent-mutations + localeParity). **Step 5: Commit** `feat(web): bulk set lifecycle state, including removed-only selections`.

### Task L3.4: E2E (L§Test & rollout, E2E)

**Files:** Create `e2e-tests/tests/device-lifecycle-state.spec.ts` (`data-testid` only: `device-lifecycle-badge`, `lifecycle-state-dialog`, `device-list-chip-disposed`, `bulk-set-lifecycle-state`).
- [ ] Write the flow: mark a device spare from the device page → badge visible and Spare chip count +1 → remove two devices → bulk-mark both disposed with method `destroyed` and a certificate number → both appear under the Disposed chip. Run it against a `worktree-stack`; expect PASS; commit `test(e2e): device lifecycle state flow`.

---

## Wave L4 — offline suppression + re-arm, payloads, automation, AI, Partner API + trigger

**Migration:** `apps/api/migrations/2026-12-31-100100-partner-export-devices-lifecycle.sql`. **Read first:** L§Operational behaviour, L§Surfaces (Partner API, Automation, AI), §2.2, §2.3.

### Task L4.1: Suppression on both offline paths

**Files:** Modify `apps/api/src/services/offlineAlertEffects.ts` (`admitOfflineAlertRule` `:135`, read `lifecycleState` from the row returned by `lockCurrentOfflineObservation` at `:148`), `apps/api/src/services/alertConditions/handlers/offline.ts` (`evaluate`); tests beside each.

**Interfaces:** both call `lifecycleSuppressesOfflineAlerts`. Effect path: a suppressed admission finishes the effect (no retry) and records outcome `lifecycle_suppressed` in its result/log. Handler path: returns the handler's not-passed result with reason `lifecycle_suppressed`.

- [ ] **Step 1: Failing tests (each with a positive control):** `it('in_service offline device admits an alert; the same input on spare admits none')`; same for `pending_disposal`; `it('lost_stolen admits an alert')`; handler: `it('legacy {type:"status"} rule passes for in_service and not for pending_disposal')`; `it('entering spare does not resolve an open offline alert')`.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit** `feat(alerts): suppress offline alerts for spare and pending_disposal devices`.

### Task L4.2: Re-arm when leaving a suppressing state while offline

**Files:** Modify `apps/api/src/services/deviceLifecycleState.ts` (act on `rearmOffline`); test `deviceLifecycleState.test.ts`, `apps/api/src/__tests__/integration/offlineLifecycleRearm.integration.test.ts`.

**Interfaces:** inside the same transaction, when `rearmOffline`: `insertOfflineEffect({ transitionId: \`lifecycle:${event.id}\`, orgId, deviceId }, { type: 'alert-plan', observation })` with `observation.observedLastSeenAt` = the locked row's `last_seen_at` truncated to ms (ISO). Only `alert-plan` — no second `device.offline` event. Ephemeral and parked devices skip (as `persistOfflineTransition`). Before implementing, grep consumers of `offline_transition_effects.transition_id` / `offlineTransitionId`; if any parses the id as the detector's format, use a UUID derived with `offlineEffectId(\`lifecycle:${event.id}\`, 'transition')` instead and note it in the PR.

- [ ] **Step 1: Failing tests:** `it('spare → in_service while offline produces exactly one offline alert')`; **Review Focus 1:** `it('spare → in_service while the pre-spare offline alert is still open does not open a second alert')`; `it('retrying the same lifecycle event does not insert a second effect')` (deterministic id); `it('spare → in_service while online inserts no effect')`.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit** `feat(alerts): re-arm offline alerting when a device returns to service while offline`.

### Task L4.3: Events, payloads, automation trigger, AI filter

**Files:** Modify `apps/api/src/services/eventBus.ts` (union + payload type), `apps/api/src/routes/devices/lifecycleState.ts` and `bulkLifecycle.ts` (publish after commit), `device.online`/`device.offline` publishers (payload `lifecycleState` snapshot), `apps/web/src/components/automations/AutomationForm.tsx` (`getEventTypeOptions` `:187`), `apps/api/src/services/aiToolSchemas.ts` (`:204-211`), `apps/api/src/services/aiToolsDevice.ts` (`query_devices` handler `:160-264`, `get_device_details`), `aiAgentSdkTools.ts` (`query_devices` ~`:1713`); locales ×8.

**Interfaces:** event `device.lifecycle_state_changed` payload `{ deviceId, orgId, fromState, toState, actorUserId, source, disposalMethod? }`; `query_devices` param `lifecycleState: z.enum(LIFECYCLE_STATES).optional()`; rows gain `lifecycleState`.

- [ ] **Step 1: Failing tests:** `it('publishes device.lifecycle_state_changed only after commit and only when changed')`; `it('device.offline payload carries lifecycleState')`; `it('query_devices filters by lifecycleState')`; `it('get_device_details returns lifecycleState, lifecycleStateChangedAt and lifecycleNote')`; AutomationForm option test; `aiToolsDeviceScope.contract.test.ts`, `aiToolsSiteScope.contract.test.ts`, `aiToolIndex.test.ts` stay green.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit** `feat(devices): lifecycle event, automation trigger and AI filter`.

### Task L4.4: Partner API field + trigger migration

**Files:** Create `apps/api/migrations/2026-12-31-100100-partner-export-devices-lifecycle.sql`; modify `apps/api/src/routes/partnerApi/devices.ts` (select `:61-101`, `makeRecord` `:110`), `routes/partnerApi/schemas.ts` (`partnerDeviceExportRecordSchema` `:141`), `dtoSafety` snapshot; test `apps/api/src/__tests__/integration/partnerApiExportWatermark.integration.test.ts`, `apps/api/src/__tests__/integration/deviceLifecycleMoveRace.integration.test.ts`.

**Interfaces:** record `lifecycle: { state: DeviceLifecycleState; changedAt: string | null }`. Migration = §2.2 order 1, copied verbatim from `2026-07-18-partner-export-org-locks.sql:310` with the two columns appended to all six ROW lists; no row writes.

- [ ] **Step 1: Failing tests:** watermark `it('a lifecycle-only change advances partner_export_updated_at')`; **Review Focus 3:** `it('PUT lifecycle racing move-org on the same device: no 40P01, no 23503; loser gets 409 STATE_CHANGED or the move wins')` (two connections, repeated 20×); `dtoSafety` snapshot diff reviewed.
- [ ] **Step 2–4: FAIL → migrate → PASS** (+ `migrationPartnerExportLocks.test.ts`, `exportSafety.classification.test.ts`). **Step 5: Commit** `feat(partner-api): lifecycle on the device export and cursor trigger`.

### Task L4.5: Trigger contract test

**Files:** Create `apps/api/src/db/partnerExportDevicesTrigger.contract.test.ts`.

**Interfaces:** `REQUIRED_COLUMNS` = §2.2 order 1 list (18, ordered). Assertions: last defining file is `2026-12-31-100100-…`; the body has exactly 3 `IS DISTINCT FROM` comparisons; each comparison's `old_row.` and `new_row.` ROW lists are equal after stripping the prefix; every list equals `REQUIRED_COLUMNS` in order; match count > 0.

- [ ] **Step 1: Write it before L4.4's migration (do L4.5 Step 1 first, then L4.4)** — run: FAIL (last defining file is `2026-07-18-…`, 16 columns). After L4.4's migration: PASS. **Step 2: Commit** `test(partner-api): pin the devices export trigger column list`.

**L4 release note:** Partner API consumers run one full resync to see `lifecycle` on every device (defaulted rows do not advance the cursor).

---

## Wave L5 — reports, shared predicate, disposal register, docs

### Task L5.1: Shared predicate

**Files:** Modify `packages/shared/src/utils/hardwareLifecycle.ts` (+ test).
**Interfaces:** `isRefreshDemand(state): boolean` (`in_service` only); `isAvailableSupply(state): boolean` (`spare`); `isLeaving(state): boolean` (`pending_disposal | lost_stolen | disposed`).
- [ ] Failing test table over all five states → implement → PASS → commit `feat(shared): lifecycle predicates for refresh planning`.

### Task L5.2: `device_inventory` report

**Files:** Modify `apps/api/src/services/reportGenerationService.ts` (`readDeviceInventoryRows` fixed select ~`:392`, row type, CSV/PDF column lists — confirm whether the PDF renderer keeps its own list and change both), report config validator (`filters.lifecycleStates[]`, default all); tests beside.
**Interfaces:** columns `lifecycleState, lifecycleStateChangedAt, disposalMethod, disposalReference, disposedAt` (latest `to_state = 'disposed'` event via `LEFT JOIN LATERAL … ORDER BY created_at DESC LIMIT 1`, so a correction supersedes).
- [ ] Failing tests: `it('removed and disposed devices still appear (no status filter)')`; `it('disposal columns come from the latest disposed or correction event')`; `it('lifecycleStates filter narrows rows')`; `it('PDF and CSV carry the new columns')` → implement → PASS → commit.

### Task L5.3: `hardware_lifecycle` report

**Files:** Modify `apps/api/src/services/hardwareLifecycleReport.ts` (`:170-176`) + test.
- [ ] Failing tests: `it('spare rows are included and labelled spare')`; `it('pending_disposal and lost_stolen are excluded from the replacement schedule')`; `it('summary reports N spares on hand')` → implement with L5.1 predicates → PASS → commit.

### Task L5.4: `GET /devices/lifecycle-register` (L-D6 reader)

**Files:** Modify `apps/api/src/routes/devices/lifecycleState.ts` (static path; mounted before core already); test `lifecycleState.register.test.ts`.
**Interfaces:** `requireScope('partner','system')` → `requirePermission(devices:read)` → org-access check for `orgId` (404 when the partner cannot reach it). Query `{ orgId, from?, to?, includeAttached?: boolean (default true), page, limit }`; rows `kind IN ('transition','correction') AND to_state = 'disposed'` plus `detached: boolean`, `subjectLabel`, `subjectSerialNumber`, disposal fields, `disposedAt`, `createdAt`.
- [ ] Failing tests: `it('org-scope user with devices:read → 403')` (negative control for the L-D6 rule); `it('partner user without org access → 404')`; `it('returns detached and attached disposal rows; never assignment rows')` → implement → PASS → commit `feat(devices): disposal register API for partner scope`.

### Task L5.5: Docs

**Files:** `apps/docs/` Devices page (lifecycle section: two axes, `disposed ⇒ Removed`, the L-D6 disposal-register exception, `DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS`), upgrade note (new migrations, one optional env var). Use the `update-breeze-docs` skill. Commit `docs(devices): lifecycle state`.

---

## Wave C1 — assignment columns, PATCH, DTO, history, move-org clear, contact-delete pre-clear, filter, typeahead, editor, column

**Migrations:** `2026-12-31-100300-device-primary-contact.sql`, `2026-12-31-100400-device-primary-contact-index.sql`. **Read first:** C§Data model, C§API, C§Web UI, §2.3, §2.5.

### Task C1.1: Migrations A and B

**Files:** Create both migrations; modify `apps/api/src/db/schema/devices.ts`, `apps/api/src/db/schema/sessions.ts` (`principal_upn`), `apps/api/src/db/schema/portal.ts` (`devices_scope`); test `apps/api/src/__tests__/integration/devicePrimaryContact.integration.test.ts`.

**Interfaces:** exactly C§Tenancy sketch file A (constraint names `devices_primary_contact_source_chk`, `devices_primary_contact_coherent_chk`, `devices_primary_contact_org_fk`; trigger `devices_primary_contact_clear` `BEFORE UPDATE OF primary_contact_id … WHEN (NEW.primary_contact_id IS NULL AND OLD.primary_contact_id IS NOT NULL)`), plus `portal_branding.devices_scope varchar(16) NOT NULL DEFAULT 'organization'` with `portal_branding_devices_scope_chk IN ('organization','assigned')`. File B: `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_org_primary_contact_idx ON devices(org_id, primary_contact_id) WHERE primary_contact_id IS NOT NULL`. No change to the events table (L1 reserved it).

- [ ] **Step 1: Failing integration tests:** `it('cross-org contact cannot be assigned (23503)')`; `it('coherent_chk rejects id without source')`; **Review Focus 4:** `it('site-cascade contact delete nulls id, source and set_at via the trigger on the RI update')`; `it('FK is DEFERRABLE INITIALLY IMMEDIATE')`; `it('an assignment-only UPDATE takes no partner-export advisory lock')` (pg_locks probe; pre-C4 baseline).
- [ ] **Step 2–4: FAIL → migrate → PASS** (+ `migrationRlsScope`, `migrationPartnerExportLocks`, `autoMigrate`, `pnpm db:check-drift`). **Step 5: Commit**.

### Task C1.2: Registrations

**Files:** `tenantExportPolicyRegistry.ts` (§2.5 columns 3–5); `tenantCascade` needs no list change — run `tenantCascade.integration.test.ts` to prove the new `devices → contacts` SET NULL edge sorts topologically with no cycle.
- [ ] Run tenant-export-policy, tenantExportErasureRoundtrip, tenantCascade, orgLifecycleFoundations (merge contract: the new FK is deferrable), orgMergeRegistry — FAIL on export policy first → register → PASS → commit.

### Task C1.3: `devicePrimaryContact` service + PATCH

**Files:** Create `apps/api/src/services/devicePrimaryContact.ts` (+ test); modify `apps/api/src/routes/devices/schemas.ts` (`updateDeviceSchema` `:207-228`), `core.ts` PATCH (`:2118-~2353`), `apps/api/src/services/contactReach.ts` (create if no shared helper exists; extract from `routes/orgContacts.ts:94-112`).

**Interfaces:**
- `canReachContact(auth, contact: { orgId; siteId: string | null }): boolean`.
- `setDevicePrimaryContact(tx, { deviceId, authorizedOrgId, contactId: string | null, expectedPrimaryContactId?: string | null, source: 'manual' | 'suggestion_accepted', eventSource: DeviceLifecycleEventSource, actorUserId }): Promise<{ changed: boolean; from: string | null; to: string | null }>` — §2.3 order (export lock → `FOR UPDATE` → `expectedPrimaryContactId` compare → 409 `ASSIGNMENT_CHANGED`); same id → no-op (keeps `set_at`, no event, no audit); otherwise UPDATE + `kind = 'assignment'` event (`from/to_contact_id`, `*_present = id IS NOT NULL`).
- PATCH: body keys `primaryContactId`, `acceptSuggestion`, `expectedPrimaryContactId` require `isInteractiveUserSession(auth)` → else 403 `INTERACTIVE_SESSION_REQUIRED` (§4 Δ6); contact not reachable → 403; audit `device.primary_contact.set|cleared { from, to, source }`; `requestDeviceGroupReevaluationAfterCommit({ changedFields: ['primaryContactId'] })`. (`acceptSuggestion` recompute lands in C2; C1 rejects `acceptSuggestion: true` with 400 `NOT_AVAILABLE`.)

- [ ] **Step 1: Failing tests:** C§Test notes PATCH list verbatim, plus `it('API-key PATCH with primaryContactId → 403 INTERACTIVE_SESSION_REQUIRED; API-key PATCH without it still works')`; `it('expectedPrimaryContactId mismatch → 409 ASSIGNMENT_CHANGED (checked under FOR UPDATE)')`; `it('writes one assignment event; repeat writes none')`.
- [ ] **Step 2–4: FAIL → implement → PASS. Step 5: Commit**.

### Task C1.4: DTO, move-org clear, contact-delete pre-clear, filter field

**Files:** `routes/devices/helpers.ts` (`PUBLIC_DEVICE_FIELDS`), `core.ts` list/detail (`primaryContact: { id, name, email } | { id, restricted: true } | null` via joined lookup like `siteName` `:1793`), `moveDeviceOrgInTransaction.ts` (`primaryContactId: null` in the org-flip statement ~`:497`; before the flip, write a `move_org` assignment event in the source org when an assignment existed — it is then detached with the rest), `services/contacts/crud.ts` (`deleteContact` `:736`: `lockDeviceExportOrgs([orgId])` → `UPDATE devices SET primary_contact_id = NULL WHERE org_id = $org AND primary_contact_id = $contact RETURNING id` → one `contact_deleted` event + audit per device → re-evaluation after commit), `filterEngine.ts` (`primaryContactId` string field, `equals | in | isNull | isNotNull`, server-controlled); tests beside each + `dynamicGroupReevaluation.integration.test.ts`.
- [ ] Failing tests: `devicePublicProjection.contract.test.ts` new fields; `it('restricted contact renders { id, restricted: true }')`; integration `it('move-org clears the assignment, writes a move_org event in the source org, and the event is detached')`; `it('a site change inside the org leaves the assignment')`; `it('the move audit records primaryContactCleared: <old id>')`; `it('assigning a parked device (unassignedPool/assignParkedDevice.ts:285, same engine) clears a stale assignment with no extra code')`; `it('device-list search matches the assignee name and email')` (list search predicate in `core.ts` list handler); `it('deleteContact clears, audits and re-evaluates each device')`; `it('primaryContactId isNull group gains/loses the device on clear/assign')` → implement → PASS → commit.

### Task C1.5: Web — `ContactTypeahead`, device-page editor, list column (§2.4)

**Files:** Create `apps/web/src/components/shared/ContactTypeahead.tsx` (+ test) from `ManualAssetModal.tsx:164-198,576-603`, using `GET /orgs/organizations/:id/contacts?q=` (add `q` ILIKE param in `routes/orgContacts.ts:47-55`); migrate `ManualAssetModal`; modify `DeviceInfoTab.tsx` ("Assigned to" row, inline-edit pattern `:865-925`, `runAction` PATCH with `expectedPrimaryContactId`); `DeviceList.tsx` + `columnVisibility.ts` + #7324 catalog (`assignedTo`, not default-visible, not in `AGENT_ONLY_COLUMNS`, `exportValue` = email); `filters/filterFields.ts` + contact-picker value input; "Unassigned" chip → `isNull`; locales ×8.
- [ ] Failing tests: typeahead `it('queries the server with q and debounces')`; `it('ManualAssetModal still assigns a contact')`; DeviceInfoTab `it('clearing shows Unassigned and sends null')`; DeviceList `it('assignedTo column renders manual-asset rows from assigned_contact_id')`; `orgContacts` `it('q filters by name or email, ILIKE escaped')` → implement → PASS (+ no-silent-mutations, localeParity) → commit.

---

## Wave C2 — suggestions, `principal_upn`, dismissals, banner, review drawer, bulk accept

**Migration:** `2026-12-31-100500-device-primary-contact-dismissals.sql`. **Read first:** C§Suggestion engine, §4 Δ7.

### Task C2.1: Dismissals table + registrations

**Files:** migration (table per C§Dismissal memory; `UNIQUE (device_id, identity)`; index `(org_id)`; RLS Shape 1, four policies; `breeze_device_child_orgid_tables()` = §2.2 order 2); `db/schema/devicePrimaryContactDismissals.ts`; registrations §2.5 column 2 (cascade order, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `INTENTIONALLY_NO_ORG_ID` + core.ts comment, merge repoint, export); move-org `DELETE` before the devices UPDATE; extend `deviceChildOrgidExclusions.contract.test.ts` (`REQUIRED_EXCLUSIONS` += dismissals, last file `…100500…`) and `deviceOwnershipEpochs.integration.test.ts` (expected exclusion array += `'device_primary_contact_dismissals'`, sorted).
- [ ] Failing: rls-coverage (auto), `devicePrimaryContactDismissalsRls.integration.test.ts` (42501 cross-tenant + positive control), cascadeDelete, moveOrg.coverage, tenantCascade, tenant-export-policy, orgMergeRegistry, the static exclusions test; integration `it('move-org deletes dismissals and the move succeeds')` → implement → PASS → commit.

### Task C2.2: `principal_upn` ingest + suggestion engine

**Files:** `routes/agents/sessions.ts` (`:172-180`, write `principal_upn` only when `isObservablePrincipal` passes and the session is console); create `apps/api/src/services/primaryContactSuggestions.ts` (+ test, + SQL-fixture integration test).

**Interfaces:** `computePrimaryContactSuggestion(tx, { deviceId, orgId, now }): Promise<{ suggestion: Suggestion | null; conflicts: Suggestion[] }>`, `Suggestion = { contactId, source: 'intune' | 'session' | 'os_username', identity: string, confidence: 'high' | 'medium' | 'low' }`; `listPrimaryContactSuggestions(tx, { orgId, page, limit })` (set-based, one statement per source). Session window lower bound = `max(now - 30 d, current epoch started_at)` where the epoch is `device_ownership_epochs` at `devices.ownership_epoch`; open sessions count to `now`. Ambiguity resolved org-wide before any reach check; dismissed identities removed before precedence.
- [ ] Failing tests: the C§Test notes engine list verbatim, plus **§4 Δ7:** `it('sessions from before the latest move are ignored even though device_sessions.org_id was restamped')`; `it('an RDP session UPN is never written to principal_upn')` → implement → PASS → commit.

### Task C2.3: Suggestion + dismissal endpoints

**Files:** `routes/devices/primaryContact.ts` (mounted before core): `GET /devices/:id/primary-contact-suggestion`, `GET /devices/primary-contact-suggestions?orgId=`, `POST /devices/:id/primary-contact-dismissals { identity }`, `DELETE /devices/:id/primary-contact-dismissals/:identity` (writes: interactive session + `devices:write` + MFA); mount-order test.
- [ ] Failing tests: `it('a caller who cannot reach the unique contact gets null, not another contact')`; `it('dismissing session:upn:x keeps intune:upn:x suggestible')`; mount order → implement → PASS → commit.

### Task C2.4: Accept (single + bulk)

**Files:** PATCH `acceptSuggestion` path (replaces C1's 400), `POST /devices/bulk/primary-contact/accept-suggestions` (`requireInteractiveSession`, ≤500 items, per-item outcomes `accepted | suggestion_changed | assignment_changed | forbidden`, self-managed), via `setDevicePrimaryContact(…, source: 'suggestion_accepted', eventSource: 'suggestion')`; recompute happens **after** the §2.3 row lock.
- [ ] Failing tests: `it('stale banner → 409 SUGGESTION_CHANGED')`; `it('concurrent manual assignment → ASSIGNMENT_CHANGED for the accept')`; `it('client cannot set source suggestion_accepted without acceptSuggestion')`; bulk outcomes → implement → PASS → commit.

### Task C2.5: Web — banner, show-dismissed, review drawer (§2.4)

**Files:** `DeviceInfoTab.tsx` banner; `DevicesPage.tsx` "N assignment suggestions" entry + `AssignmentSuggestionsDrawer.tsx` (hash state `#suggestions`), "Accept all on this page"; locales ×8.
- [ ] Failing tests: banner variants (unassigned / reassign / conflicting with no accept button); drawer accept-all sends `expectedPrimaryContactId` per row → implement → PASS → commit.

---

## Wave C3 — bulk assign, contact drawer, reports, AI, tickets, portal scope, "Clear assigned contact"

### Task C3.1: `POST /devices/bulk/primary-contact` + bulk menu (§2.4)

**Files:** `routes/devices/bulkPrimaryContact.ts` (mounted before core; `requireInteractiveSession`; single-org: every device in the contact's org else 400 with ids; `lockDeviceExportOrgs([orgId])` then one set-based UPDATE `… RETURNING id, old primary_contact_id` via CTE; one event + audit + re-evaluation per changed device); web `BulkAssignContactDialog.tsx`, `DeviceList.tsx` (both menu blocks), `bulkActionGating.ts` (`'assign-contact'` → `INTENTIONALLY_UNGATED_BULK_ACTIONS`; all-removed expectation `:1578` += `'assign-contact'`), `DevicesPage.tsx` `runBulkAction`.
- [ ] Failing tests: `it('mixed-org selection → 400 with offending ids')`; `it('one event per changed device, none for unchanged')`; gating tests; `it('UI refuses a cross-org selection before the request')` → implement → PASS → commit.

### Task C3.2: "Clear assigned contact" in the lifecycle dialogs

**Files:** `deviceLifecycleState.ts` (`SetLifecycleInput.clearPrimaryContact?: boolean` → calls `setDevicePrimaryContact(tx, { contactId: null, eventSource: 'lifecycle_dialog', … })` in the same transaction after the lifecycle UPDATE), validators, `LifecycleStateDialog.tsx`, `BulkLifecycleStateDialog.tsx`, `RemoveDeviceDialog.tsx` (when "Also mark as" is set).
**Interfaces:** checkbox shown and pre-ticked only when the target is `spare | pending_disposal | disposed` **and** the device (or any selected device) has an assignee; never clears silently.
- [ ] Failing tests: `it('→ spare with clearPrimaryContact writes a transition and an assignment event in one tx')`; `it('rolls back both when the lifecycle step fails')`; web `it('checkbox absent for in_service and for unassigned devices')` → implement → PASS → commit.

### Task C3.3: Contact drawer + Devices count

**Files:** `GET /orgs/contacts/:contactId/devices` (`organizations:read` + `devices:read`, site-reach filtered) in `routes/orgContacts.ts`; `ContactsCard.tsx` "Devices" column + `#contact=<id>` drawer with "Assigned devices".
- [ ] Failing tests: `it('site-confined caller sees only reachable devices')`; drawer hash navigation → implement → PASS → commit.

### Task C3.4: Reports + AI params

**Files:** `reportGenerationService.ts` (`assignedContactName`, `assignedContactEmail`; manual-asset arm from `assigned_contact_id`; `filters.assignment: 'any'|'assigned'|'unassigned'`); `aiToolSchemas.ts`, `aiToolsDevice.ts`, `aiAgentSdkTools.ts` (`assignedContactId?: z.string().uuid().optional()`, `unassigned?: z.boolean().optional()`; rows gain `assignedContactName`). Do **not** fix the pre-existing `query_devices` `tags` no-op here (C§AI) — it is a separate follow-up issue.
- [ ] Failing tests: report rows for both arms; `assignment` filter; `query_devices` filters; aiToolsDeviceScope, aiToolsSiteScope, aiToolIndex green → implement → PASS → commit.

### Task C3.5: Ticket prefill + "New ticket" from the device

**Files:** `DeviceTicketsTab.tsx` (button → `CreateTicketPage` with `#orgId=…&deviceId=…`); `CreateTicketPage.tsx` (`:223-240,385`: visible, clearable requester prefill from the device's assignee; sends `requesterContactId`); portal ticket device picker filtered in `assigned` scope + server re-check on submit.
- [ ] Failing tests: `it('prefills requester visibly and lets the tech clear it')`; `it('no prefill when a requester is already chosen')`; server: `it('alert/automation/AI ticket creation never sets requester from the assignment')` (grep-backed list of ticket-creating services in the PR) → implement → PASS → commit.

### Task C3.6: Portal `devices_scope` (P-1 default (a))

**Files:** `routes/portal/devices.ts` (`:21,61-80`) and `services/portal/deviceReadModel.ts:18` (list + CSV: in `assigned` scope add `devices.primary_contact_id = portalUser.contact_id AND devices.org_id = portalUser.org_id`; NULL `contact_id` → empty); `OrgPortalSettingsEditor.tsx` (`:20,80,107`: three-way control Off / Assigned devices only / All organization devices writing `enable_devices` + `devices_scope`; Off disabled with "Shown because self-service is on" when `enable_self_service` keeps devices visible); `routes/portal/branding.ts:111`; "Mine" chip in `organization` scope; locales ×8.
**Settings rule 9 (PR text):** home `OrgPortalSettingsEditor.tsx` (org Portal card); level org; resolver `portalDevicesEnabledMiddleware` + `devices_scope` read; places configured 1 → 1.
- [ ] Failing tests: **Review Focus 5:** `it('assigned scope, null contact_id, gate opened by self-service → empty list and empty CSV')`; `it('assigned scope returns only the user\'s devices for list and CSV')`; `it('organization scope unchanged')`; editor control test → implement → PASS → commit.

### Task C3.7: Linked manual assets (C§Linked manual assets)

**Files:** the manual-asset link dialog (where `linked_device_id` is set; locate from `ManualAssetModal.tsx`), the device page "Manual record" card.
**Interfaces:** linking a manual asset that has `assigned_contact_id` to an **unassigned** device offers "Also assign <name> to this device" (unticked; calls PATCH with `primaryContactId`, `expectedPrimaryContactId: null`); when both are set and differ, the card shows both names. Nothing syncs automatically.
- [ ] Failing tests: `it('offers the copy only when the device is unassigned')`; `it('shows the difference when both are set and differ')` → implement → PASS → commit.

### Task C3.8: Docs

`apps/docs/` Devices page (assignment, suggestions, review drawer as the backfill), portal settings (device scope + the self-service note from P-1), ticket creation (requester prefill). Use `update-breeze-docs`. Commit `docs(devices): assigned contact`.

---

## Wave C4 — Partner API fields + trigger redefinition

**Migration:** `2026-12-31-100600-partner-export-devices-primary-contact.sql` = §2.2 order 2, copied from L4's body.

### Task C4.1: Migration, record fields, contract + watermark tests

**Files:** migration; `routes/partnerApi/devices.ts` + `schemas.ts` (`primaryContactId`, `primaryContactSource`, `primaryContactSetAt` — ids only, no name/email); `partnerExportDevicesTrigger.contract.test.ts` (`REQUIRED_COLUMNS` += 3, last file `…100600…`); `partnerApiExportWatermark.integration.test.ts`; `dtoSafety` snapshot.
- [ ] Failing tests: contract test (last file still `…100100…`); watermark `it('an assignment change advances the cursor')`, `it('a deleteContact pre-clear advances the cursor')`, `it('an RI-fired SET NULL on the site-cascade path advances the cursor')`; C1.1's "assignment-only UPDATE takes no export lock" probe is **inverted** here (now it must take the org lock, already pre-taken by every writer per §2.3) → migrate → PASS → commit.
- [ ] Release note: Partner API consumers resync once to see assignment fields.

---

## Wave L6 — manual-asset lifecycle parity (P-2 default (a))

**Migration:** `2026-12-31-100700-manual-asset-lifecycle-state.sql`: `manual_assets.lifecycle_state device_lifecycle_state NOT NULL DEFAULT 'in_service'`, `lifecycle_state_changed_at`, `lifecycle_state_changed_by`, `lifecycle_note` (no `disposed ⇒` CHECK: manual assets have no Removed state; `disposed` is allowed directly). Export policy `manual_assets.included` += 4.

### Task L6.1: Service + route + list parity

**Files:** generalise `setDeviceLifecycleState` into `setAssetLifecycleState(tx, { subject: { kind: 'device', deviceId } | { kind: 'manual_asset', manualAssetId }, … })` (device path unchanged; manual path writes events with `manual_asset_id`); `PUT /manual-assets/:id/lifecycle`; `ManualAssetModal.tsx`; `mergedListFilter.ts` (client-side filter path); remove `lifecycle` from `AGENT_ONLY_COLUMNS`; bulk route accepts manual ids only if the existing bulk selection model already carries them (else defer, note in PR).
- [ ] Failing tests: `it('manual asset → disposed writes an event with manual_asset_id and no device_id')`; `it('retired_at is unchanged by any lifecycle transition')` (P-2 (a)); `it('lifecycle chip filters manual rows through mergedListFilter')`; tenant-export-policy → implement → PASS → commit.

---

## 6. Verification per PR (all waves)

1. Targeted unit files listed in the wave, run one file group at a time (`npx vitest run <files>`), reading the file count.
2. `tsc --noEmit` for every touched package with `NODE_OPTIONS=--max-old-space-size=12288`; exit code 0.
3. Waves with a migration or registration: the stack suites in that wave's §1 row, then `pnpm test-stack down`.
4. Web waves: `cd apps/web && npx vitest run` on the touched component tests + `no-silent-mutations` + `localeParity`.
5. One independent code review round per PR (Sonnet reviewer), re-review only if a fix touched tenancy/locking.
6. PR body: `Closes #<wave sub-issue>`, `Refs #8836` or `Refs #8835`; for L1 the L-D6 exception paragraph; for C3 the settings rule-9 block.

## 7. Follow-ups to file (not in this plan)

- `device.decommissioned` is declared and subscribed but never published (L§Automation adjacent finding).
- `query_devices` declares `tags` but the handler never applies it (C§AI).
- Billing by lifecycle state as a partner setting (L-D4 (c)).
- Disposal-register report type + UI over `GET /devices/lifecycle-register`.
- Durable re-evaluation outbox for contact deletes that bypass `deleteContact` (C§Out of scope, #8832 follow-up).
