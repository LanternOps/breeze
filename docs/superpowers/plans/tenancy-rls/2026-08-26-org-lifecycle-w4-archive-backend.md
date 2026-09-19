---
tracking_issue: LanternOps/breeze#4074
wave: LanternOps/breeze#4078
---

# Org Lifecycle Wave 4: Archive Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class archive lifecycle: `POST …/archive` drains agents and lands the org on `archived` (hidden, read-only, billing-excluded) with a `purgeAt` retention timer feeding auto-erasure; `POST …/restore` reverses it before purge.

**Architecture:** Parameterize the existing offboarding pipeline via the Wave-1 `offboardingTarget` column (finalize lands `archived` instead of `churned`, stamping `archivedAt`/`purgeAt`). Credentials are suspended reversibly (reason-tagged), not revoked. Archived reads run in a Postgres `READ ONLY` transaction context. A purge sweeper CASes `archived → purging` and enqueues the existing tenant erasure; the erasure worker double-checks the status. Warning notifications at T-14d/T-1d.

**Tech Stack:** Hono routes, `services/tenantOffboarding.ts` / `tenantLifecycle.ts`, `db/index.ts` context machinery, BullMQ-adjacent sweeper, Vitest unit + integration.

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md` (Part 2)

## Global Constraints

- Wave-1 groundwork already shipped: `archived`/`purging` enum values (deny-by-default everywhere), `organizations.archived_at`, `purge_at`, `offboarding_target` (CHECK `IN ('churn','archive')`), export-policy classified. Wave 2 shipped the sweeper file layout in `tenantOffboarding.ts` (merge backstop cases) — extend, don't rework.
- Statuses stay deny-by-default on every normal surface: `archived`/`purging` never enter `computeAccessibleOrgIds`' normal set, `isUsableOrgStatus` stays `active|trial`. Archived visibility comes ONLY through the explicit read-only context below.
- Read-only enforcement is DB-level: the archived read context opens its transaction `READ ONLY` (`SET TRANSACTION READ ONLY` — writes fail SQLSTATE 25006). App-layer 409s are additive UX, not the boundary.
- Reversibility contract: archive entry must NOT hard-revoke (no `revokeOrganizationTenantAccess`); it uses reason-tagged suspension (`org_archived`) that restore can lift. What cannot be preserved (agents that honored uninstall) is enumerated in the restore response.
- Existing `DELETE /organizations/:id` keeps today's exact behavior (deprecated in docs); nothing reinterprets legacy `churned + deletedAt` rows.
- All new mutations: `requireScope('partner','system') + requireOrgWrite + requireMfa()`; audits for archive/restore/purge transitions; sweeper audits org-less where the org may be erased.
- Purge race contract: restore only valid from `archived` (410 from `purging`); the erasure worker verifies `status='purging'` for archive-purge jobs before deleting (merge-shell erasures — `merging`+deleted — must keep working unchanged).
- Env knobs via `envInt` (never raw `Number(process.env…)`): `ORG_ARCHIVE_DEFAULT_RETENTION_DAYS` (default 90), notification lead times fixed (14d/1d).
- Repo contracts: no new tables (no RLS/cascade registrations); new columns already classified in W1. New notification usage follows the existing notification machinery patterns.
- Branch: stacked. Dispatch CI manually before merge. Integration suites via `pnpm test:integration <paths>` (no `--`), per-worktree test stack.

---

### Task 1: Parameterized finalize + archive/restore service functions

**Files:**
- Modify: `apps/api/src/services/tenantOffboarding.ts` (finalize reads `offboarding_target`; begin gains a target+retention param)
- Modify: `apps/api/src/services/tenantLifecycle.ts` (add `suspendOrganizationTenantAccessReversibly(orgId)` + `liftArchiveSuspension(orgId)` — reason-tagged `org_archived` suspension of API keys/OAuth/enrollment analogous to the existing reason-tagged agent suspension; read what `revokeOrganizationTenantAccess` hard-revokes and implement the suspend/lift pair for each surface that supports a reversible flag; document any surface that only supports hard revocation and leave it untouched with a note)
- Create: `apps/api/src/services/orgArchive.ts` — `beginOrgArchive({orgId, retentionDays|null, actor})` (validate status ∈ {active,trial,suspended}; suspended skips the drain and finalizes immediately — no agents to drain; else begin offboarding with target='archive'), `restoreOrgFromArchive({orgId, actor})` (CAS `archived → active`, clear `archivedAt/purgeAt/offboardingTarget`, lift suspensions, `restoreOrganizationTenantAccess`-equivalent for the reversible parts, return `{recreateRequired: string[]}`), plus `computePurgeAt(retentionDays|null)`.
- Test: co-located unit tests for each (drizzle-mock per repo conventions; compiled-SQL assertions for the CAS UPDATEs).

**Steps (TDD):** failing unit tests for: finalize lands `archived`+stamps when target='archive' and `churned` when 'churn' (existing behavior pinned); begin stores target+`purge_at`; suspended-org immediate-finalize path; restore CAS from `archived` only (compiled SQL asserts `status = 'archived'` in WHERE); restore clears all three columns; reversible-suspend/lift pair round-trips. Implement; green; commit `feat(api): archive lifecycle services — parameterized finalize, reversible suspension, restore`.

---

### Task 2: Archive/restore endpoints

**Files:**
- Create: `apps/api/src/routes/orgArchive.ts` (mount `api.route('/orgs', orgArchiveRoutes)` in `index.ts` beside orgMerge)
- Test: `apps/api/src/routes/orgArchive.test.ts`

Endpoints: `POST /organizations/:id/archive` body `{retentionDays?: number|null}` (zod: int ≥ 1 ≤ 3650, nullable; default env) → 202 `{status: 'offboarding'|'archived', purgeAt}`; `POST /organizations/:id/restore` → 200 `{status: 'active', recreateRequired}` | 410 from `purging` | 409 from anything else. Copy orgMerge.ts's middleware chain + partner resolution + suspended-org access pattern (partner-id check via system-context load, NOT `canAccessOrg` — archived/suspended orgs fail it). Audits `org.archive.requested`/`org.archive.restored`. Route tests mirror `orgMerge.test.ts`'s harness: auth matrix, 410/409 cases, retention validation, enqueue/service-call assertions. Commit `feat(api): org archive/restore endpoints`.

---

### Task 3: Archived read context + includeArchived reads

**Files:**
- Modify: `apps/api/src/db/index.ts` — `withArchivedOrgReadContext(orgIds: string[], fn)`: mirrors `withDbAccessContext` but (a) sets the same GUCs with the archived org ids included in the accessible set (scope 'partner' with explicit ids, or a dedicated read-scope — read how the GUC serialization works and keep it consistent), and (b) issues `SET TRANSACTION READ ONLY` as the first statement inside the transaction. Reuse the existing transaction-opening machinery; never a bare pool.
- Modify: `apps/api/src/routes/orgs.ts` — org LIST gains `includeArchived=true` query param (partner scope only): archived orgs (status='archived', deletedAt NULL) of the caller's partner are fetched via the archived read context and appended, flagged `archived: true` in the response. Org DETAIL (`GET /organizations/:id`): when the target is archived and the caller's partner matches, serve the read through the archived context (read-only) instead of 404.
- Test: `apps/api/src/__tests__/integration/orgArchiveReadContext.integration.test.ts` — real Postgres: a write inside the archived context fails SQLSTATE `25006`; archived org visible via includeArchived and invisible without; cross-partner archived org stays invisible (RLS still applies — assert as breeze_app).

Commit `feat(api): READ ONLY archived-org read context + includeArchived org reads`.

---

### Task 4: Purge sweeper + notifications + erasure status check

**Files:**
- Modify: `apps/api/src/services/tenantOffboarding.ts` — extend the sweeper: (a) purge case: `status='archived' AND purge_at IS NOT NULL AND purge_at <= now()` → CAS `archived → purging` (atomic UPDATE … WHERE status='archived' RETURNING) → `enqueueTenantErasure` (via the unwedge helper) → audit `org.archive.purge_enqueued` (org-less); (b) warning cases: `purge_at` within 14d / 1d and corresponding notification not yet sent (track sent markers in `organizations.settings` jsonb keys via atomic jsonb_set, mirroring `mergePriorStatus` handling) → notify partner admins via the existing notification machinery (grep how other org-level notices are emitted — reuse; if only email exists, use it).
- Modify: `apps/api/src/jobs/tenantErasure.ts` — the worker double-checks before cascading: org must be (`purging`) OR (`merging` + deletedAt set) OR deletedAt set (legacy/admin path — read what the admin route guarantees and keep it working); refuse-and-log otherwise (audit `tenant.erasure.refused_status_guard`, org-less).
- Test: sweeper unit cases (CAS race: restore between SELECT and CAS → 0 rows, nothing enqueued; notification dedupe) + one integration case: archived org with past purgeAt → sweeper flips to purging + erasure enqueued + restore now 410; erasure worker refuses an org still `active`.

Commit `feat(api): archive purge sweeper with CAS + erasure status guard + retention warnings`.

---

### Task 5: Billing exclusion + wave wrap

- Billing: find the device-count surface the billing service reads (grep for the hosted billing count endpoint/query) and exclude orgs with `status IN ('archived','purging','merging')`; unit-test the filter (compiled SQL). Flag in the PR body that the billing repo's consumption must be verified by hand (zero CI there).
- Wrap: full unit + full integration + rls-coverage + drift; whole-branch review (controller dispatches); push; `gh workflow run CI --ref <branch>`; PR `feat(api): org lifecycle wave 4 — archive backend`, `Closes #4078`, release-note flag for the archive/restore feature + deprecated DELETE. **Stop at the open PR.**
