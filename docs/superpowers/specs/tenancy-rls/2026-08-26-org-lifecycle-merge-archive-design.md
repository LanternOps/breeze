---
tracking_issue: LanternOps/breeze#4074
---

# Org Lifecycle: Merge + Archive — Design

**Date:** 2026-08-26
**Status:** Approved design, pre-implementation
**Owner decisions locked:** merge = same-partner, loser erased via cascade after re-tenanting (no tombstone org); archive = hidden + read-only + agents disconnect + billing stops + retention timer → auto-erase; scope = merge + archive only (other lifecycle gaps listed as roadmap, not built here).

## Motivation

- **Merge:** duplicate orgs are trivially creatable — `organizations.name`/`slug` have no uniqueness of any kind (`apps/api/src/db/schema/orgs.ts:111-142`). The concrete driving case: an org was renamed by creating a *new* org under the new name instead of renaming the existing one; quotes (and other commerce history) now live under both orgs and must be consolidated. Broader drivers: accidental duplicates, client acquisitions, onboarding cleanup.
- **Archive:** the only lifecycle exits today are `status` flips (which silently hide the org from every partner route via `computeAccessibleOrgIds`, `apps/api/src/middleware/auth.ts:346`) and the UI "delete" (soft: `status='churned' + deletedAt`, `apps/api/src/routes/orgs.ts:1873-1888`, with **no undelete path**). There is no first-class "client offboarded: keep data readable, stop billing, purge later" state.

## Current machinery this design builds on (verified)

| Machinery | Where | Reuse |
|---|---|---|
| Org-scoped table inventory: `CORE_ORG_CASCADE_DELETE_ORDER`, 272 tables, CI-enforced complete | `apps/api/src/services/tenantCascade.ts:64-391` | Source of truth for the merge registry's coverage contract |
| Runtime FK topo-sort `topologicalCascadeOrder()` (returns **children-first**, for deletion) | `tenantCascade.ts:538-613` | Merge uses the **reversed** order (parents first); see caveats below |
| Queued tenant erasure (BullMQ, platform-admin, per-table transactions, `attempts: 1`) | `apps/api/src/jobs/tenantErasure.ts`, `routes/admin/tenantErasure.ts` | Final disposal of the merged-away shell and of purged archives |
| Offboarding drain pipeline (begin/abort/finalize + 72h sweeper) | `apps/api/src/services/tenantOffboarding.ts` | Archive reuses it, parameterized (see `offboardingTarget`) |
| Access revoke/restore + agent credential sever | `apps/api/src/services/tenantLifecycle.ts:102,253,349` | Archive entry/exit — with a new *reversible* suspension variant |
| Device move-org 85-table re-point loop + WS 4040 force-close | `apps/api/src/routes/devices/moveOrg.ts`, `routes/devices/core.ts:118-156` | Pattern precedent; merge subsumes it at org granularity |
| Tenant export ZIP | `apps/api/src/services/tenantExport.ts` | Optional forensic snapshot **only** — NOT a rollback artifact (per-table fresh transactions, policy-excluded columns; it is lossy and non-atomic) |

## Constraints discovered (these shape the whole design)

1. **~14 tables hard-collide** on a naive `UPDATE … SET org_id = survivor`: `ai_budgets`, `portal_branding`, `org_ticket_settings`, `pam_org_config`, `client_ai_org_policies`, `client_ai_tenant_mappings` (also `UNIQUE(entra_tenant_id)`), `google_workspace_connections`, `user_risk_policies`, `m365_connections (org_id, profile)`, `backup_configs` (default partial), `contacts` (primary partial), `audit_baselines` (active partial), `pax8_orders` (draft partial), `audit_log_chain` (genesis row). **~22 more collide probabilistically**: `tenant_variables (org_id,key)`, `discovered_assets (org_id,ip_address)`, `sso_verified_domains (org_id,domain)`, `catalog_item_org_pricing`, `plugin_installations`, `playbook_definitions`, `alert_correlation_groups`, `incidents`, `fleet_findings`, `action_intents`, etc.
2. **4 append-only tables physically cannot move**: `audit_logs`, `audit_log_chain`, `audit_chain_anchors`, `ml_feedback_events` have `BEFORE UPDATE` triggers that unconditionally `RAISE` for every role; the only escape (`breeze_audit_admin` + `breeze.allow_audit_retention` GUC) covers DELETE only. `audit_logs` additionally maintains a per-org hash chain. The loser's audit trail therefore **cannot be re-tenanted** — it is deleted by the follow-up erasure (owner-accepted).
3. **13 composite child FKs `(x, org_id) → parent(id, org_id)` are `ON UPDATE NO ACTION`, non-deferrable** (`invoice_lines/documents/payments → invoices`, `quote_orders/recipients/order_lines → quotes`, `contacts → sites`, `contact_external_links → contacts`, `devices → device_link_groups`, `elevation_audit → elevation_requests`, `fleet_remediation_runs → fleet_findings`, `pax8_* → contract_lines`). A parent-only or child-only re-point fails at statement end.
4. **3 partner-export state tables are trigger-maintained** (`partner_export_configuration_org_state`, `partner_export_device_material_state`, `partner_export_site_material_state`); `breeze_app` has DML revoked — only their SECURITY DEFINER triggers may write them, and those triggers take **ordered advisory locks** (`breeze_partner_export_lock_orgs_exclusive`, `apps/api/migrations/2026-07-23-partner-export-material-state-hardening.sql`).
5. **Same-partner only** is structural: `users` (and 10 other tables) carry composite FKs `(org_id, partner_id) → organizations(id, partner_id)`. Cross-partner merge is a partner migration, out of scope.
6. **Durable capabilities embed the loser's orgId**: public quote-acceptance tokens carry `orgId` and every public quote route matches `(quote_id, claims.orgId)` (`apps/api/src/services/quoteAcceptToken.ts:42`, `routes/quotesPublic.ts:59`). Naive merge breaks every sent quote link — the exact artifact this feature exists to consolidate.
7. **Dangling references with no FK**: `partner_users.orgIds uuid[]`, `organization_users.siteIds[]/deviceGroupIds[]`, `config_policy_assignments.target_id`, the partner-settings org-ordering array (`services/orgOrdering.ts`), and integration mapping tables keyed by `integration_id` (huntress/s1/pax8/unifi org mappings).

---

# Part 1 — Merge Organizations

## API surface

| Endpoint | Gate | Behavior |
|---|---|---|
| `POST /orgs/:loserId/merge-preview` `{survivorId}` | partner/system scope + `orgs:write` + MFA | Synchronous. Validates same-partner, both orgs usable, not quick_support/internal-special. Returns per-table loser row counts, computed conflict report (which rows would be dropped and why), size verdict. |
| `POST /orgs/:loserId/merge` `{survivorId, confirmName}` | same + `confirmName` must equal loser's name exactly | Enqueues the merge job (202). Refuses if preview size verdict was `too-large` (see thresholds). |
| `GET /orgs/merge-runs/:id` | partner/system | Job status + result summary (per-table moved/dropped counts). |

Job id `org-merge-<loserId>` so double-POST coalesces (mirrors `tenant-erasure-<orgId>`).

## Execution (BullMQ worker, `concurrency: 1`, `attempts: 1`)

**Phase A — Fence (outside the main tx):**
1. CAS loser `status → 'merging'` (new transient enum value). Refuse unless current status ∈ {active, trial, suspended}. `merging` is excluded from `accessibleOrgIds` and from `isUsableOrgStatus` → API ingress and agent REST/WS/mTLS all stop resolving the loser.
2. Force-close loser agents' WS (code 4040) and sever in-flight sessions; bump auth/permission epochs for affected users so cached JWTs die.
3. Short drain wait (default 30s, configurable) for in-flight requests/queued workers writing under the loser's context.

**Phase B — Re-tenant (single transaction, system DB context):**
1. `SELECT breeze_partner_export_lock_orgs_exclusive(ARRAY[loser, survivor])` — both orgs' export advisory locks, UUID-sorted, **before any row writes**, so the export triggers' lock hierarchy cannot deadlock mid-merge.
2. `SET CONSTRAINTS ALL DEFERRED` — enabled by the prep migration below.
3. Walk the merge registry in **parents-first** order: `reverse(topologicalCascadeOrder())` as the baseline, with registry-declared explicit ordering overrides where trigger dependencies demand it (deferrable FKs do not defer trigger validation). Tables whose parent+child pairs still fight triggers use a single-statement wCTE (registry-declared `custom`).
4. Conflicts are **recomputed inside this transaction** (the preview is advisory; the world may have changed).
5. Post-pass fixups: array/no-FK dangling references (§constraint 7), integration mapping dedupe (survivor's mapping wins; loser's row deleted), `organization_external_links` re-pointed (unique is partner-scoped — no collision, but a duplicate-`system` link pair is recorded in the result summary for operator review).
6. Insert `org_merge_events` row + org-less audit events (`org.merge.completed`, `orgId: null`, mirroring `tenant.erasure.*` so they survive the erasure) with the full per-table summary.
7. Mark loser `deletedAt = now()`, keep `status = 'merging'` (terminal shell).

**Phase C — Dispose (after commit):**
1. Enqueue existing tenant erasure for the loser shell (only the org row + the 4 append-only audit tables remain). Enqueue-failure safety: the offboarding sweeper re-enqueues any org in `merging + deletedAt` older than 1h (outbox-style backstop; the erasure job itself is `attempts: 1` with per-table commits, which is acceptable for an already-empty shell).
2. Audit `org.merge.erasure_enqueued`.

**Failure:** any Phase-B error rolls back the whole transaction; job writes `org.merge.failed` audit (org-less) and flips loser back `merging → <prior status>`. Partial merges are never visible.

**Implementation amendments (Wave 2, sanctioned):** (1) Phase B step 7 (loser `deletedAt` stamp) is impossible inside the single transaction — the organizations-row UPDATE requires the partner-export *exclusive* advisory lock while Phase B holds the *shared* one, and upgrades are refused; the stamp runs in a retried follow-up transaction, with a sweeper backstop (`org_merge_events` existence discriminates "committed, stamp lost" → stamp+erase from "fence set, job died" → unfence). (2) The registry walk is two-pass (resolve: all dedupe/deactivation writes; then move: all repoints) because `ON UPDATE CASCADE` action triggers are non-deferrable and would drag colliding children into the survivor before their dedupe runs. (3) Dedupe targets with NO ACTION/RESTRICT children (plugin_installations, playbook_definitions, discovered_assets, incidents, pam_signer_groups) re-home children onto the survivor's row (incidents: neutralize `source_ref`) instead of bare deletes — enforced by a contract test. (4) Loser `api_keys`/`enrollment_keys` are revoked *and* repointed (spec's "revoked, not repointed" kept in spirit: the credentials are dead; the rows move for audit continuity). (5) Registry covers 281 tables (272 cascade + associates + extras), not 272.

## The merge-policy registry (the core contract)

New `apps/api/src/services/orgMergeRegistry.ts`. **Every table in `getOrgCascadeDeleteOrder()` (272) plus every `ASSOCIATED_SYSTEM_SCOPED_TABLES` entry (7) plus the non-cascade org-FK tables (`accounting_connections`, `partner_invoice_sequences`, 3 export-state tables) must have an explicit entry — there is no default.** A CI contract test (`orgMergeRegistry.integration.test.ts`, Integration Tests job) fails on any missing, extra, or non-existent table — same pattern and same blind-spot warning as the export-policy registry (a PR on a stale base can go green; the integration job is the real gate).

Policy classes:

| Class | Semantics | Examples |
|---|---|---|
| `repoint` | `UPDATE t SET org_id = :survivor WHERE org_id = :loser` | quotes, invoices, contracts, tickets, devices, sites, alerts, most history (~200 tables) |
| `keep-survivor` | Singleton/config: if survivor has a row (per declared unique key), DELETE loser's; else repoint | `portal_branding`, `ai_budgets`, `org_ticket_settings`, `pam_org_config`, `m365_connections`, `google_workspace_connections`, `client_ai_*`, `user_risk_policies` |
| `repoint-dedupe` | Delete loser rows colliding on the declared unique key, repoint the rest; dropped rows counted in the summary | `tenant_variables`, `discovered_assets`, `sso_verified_domains`, `catalog_item_org_pricing`, `plugin_installations`, `playbook_definitions`, `alert_correlation_groups`, `contact_external_links`, `incidents`, `fleet_findings`, `action_intents`, usage-period tables |
| `custom` | Hand-written wCTE / multi-step logic | `users` + `organization_users` (email is globally unique — users move; duplicate org-memberships deduped), `portal_users` (no email unique — dedupe by email into survivor, keep earliest, relink `linkedUserId`), `contacts` (+ primary-contact partial unique), ticket join tables (`ticket_alert_links`, `time_entries`, `ticket_parts` via joins, as in `moveOrg.ts:193-205`), `devices` (null `linkGroupId` where the link group dissolves, as in `moveOrg.ts:146-164`), `audit_baselines` (active partial unique) |
| `leave-for-erasure` | Not touched; rows die with the loser via erasure | `audit_logs`, `audit_log_chain`, `audit_chain_anchors`, `ml_feedback_events` |
| `derived` | Never written by the merge; regenerated by SECURITY DEFINER triggers as their parents move; postcondition-verified only | the 3 `partner_export_*_state` tables |

Each entry declares: policy class, unique-collision key (where applicable), explicit ordering constraints (before/after table X), and a one-line rationale. Extension tables register via the existing `withExtensionOrgCascade` analog (`withExtensionMergePolicy`).

## Prep migration

`YYYY-MM-DD-org-merge-deferrable-fks.sql` (dated at implementation time; idempotent, `DO $$` guards):
- ALTER the 13 composite FKs to `DEFERRABLE INITIALLY IMMEDIATE` (drop + re-add `NOT VALID`+`VALIDATE` is unnecessary — `ALTER TABLE … ALTER CONSTRAINT … DEFERRABLE` suffices; no revalidation, metadata-only).
- Add `merging` (and archive's `archived`, `purging` — see Part 2) to `org_status` enum. Enum additions are `ALTER TYPE … ADD VALUE IF NOT EXISTS`, which cannot run inside the migration-runner transaction — use the established committed-enum workaround already present in the migrations dir (separate early file if needed).
- Create `org_merge_events` (see below).

## `org_merge_events` table

```
id uuid PK, partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
loser_org_id uuid NOT NULL,          -- NO FK: the org is erased by design
loser_org_name varchar(255) NOT NULL,
survivor_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
actor_user_id uuid, summary jsonb NOT NULL,  -- per-table moved/dropped counts
created_at timestamptz NOT NULL DEFAULT now()
```

- **Tenancy shape 3 (partner-axis)**: RLS `breeze_has_partner_access(partner_id)`; register in `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`.
- No `org_id` column → not in the org-cascade list and not in the export-policy registry (by construction). `summary` is jsonb → if this table ever gains an `org_id` column, it becomes `excludedOpen`; noted here so the ADD COLUMN trap is pre-answered.
- Cascade behavior: survivor erasure removes its merge rows via FK CASCADE; partner erasure likewise.

## Sent-quote (and durable-capability) continuity

- `quoteAcceptToken` verification: when the token's `orgId` doesn't match the quote's current org, look up `org_merge_events` (`loser_org_id = claims.orgId AND survivor_org_id = quote.org_id AND partner match`); accept if the persisted token identity still matches. Same treatment for quote-recipient links. This is spec-critical — it is the owner's driving use case.
- Enrollment keys and API keys of the loser are **revoked, not repointed** (they are org-bound capabilities; the summary lists them). Loser-org rows in queues/caches are invalidated by the fence + epoch bump.

## Thresholds

Preview computes total movable rows. Above a configurable cap (default 500k rows), execution is refused with guidance to run during a maintenance window (env-var override to lift). Rationale: single-tx WAL/lock footprint; typical duplicate-org merges are tiny.

## Web UI

`OrganizationsPage` detail header gains **Merge into…** (partner scope + MFA): modal = survivor picker (same partner, excludes loser/quick_support) → preview render (per-domain counts + would-drop conflicts) → typed-name confirm → progress → result summary. Mutations via `runAction`. Archived/merging orgs excluded from survivor picker.

---

# Part 2 — Archive Organization

## State machine

```
active|trial ──archive──▶ offboarding (drain, target=archive) ──finalize──▶ archived ──purgeAt──▶ purging ──erasure──▶ gone
                                   │                                  │
                                   └──────────── abort ◀── restore ───┘   (restore only from `archived`)
```

- New columns on `organizations`: `archivedAt timestamptz`, `purgeAt timestamptz` (NULL = never purge), `offboardingTarget varchar` (`'churn'` default | `'archive'`).
- New enum values: `archived`, `purging` (and merge's `merging`).

## Entry

`POST /orgs/:id/archive {retentionDays?: number | null}` (partner scope + `orgs:write` + MFA). Default retention 90 days; `null` = keep forever. Sets `offboardingTarget='archive'` and runs the existing `beginOrganizationOffboarding` drain (72h window, agent uninstall-intent delivery). **Finalization is parameterized**: `finalizeOrganizationOffboarding` currently hardcodes `churned` and its race-check asks "still offboarding→churned" (`tenantOffboarding.ts:539`) — it reads `offboardingTarget` and lands on `archived`, stamping `archivedAt` + `purgeAt`. The sweeper (`sweepOffboardingTenants`) needs no intent inference — it's on the row.

**Credential handling must be reversible** (today's `revokeOrganizationTenantAccess` revokes API keys/OAuth and expires enrollment keys one-way — `tenantLifecycle.ts:253` — which would make "restorable" a lie): archive uses a suspension variant that flags credentials `suspended_reason='org_archived'` instead of hard-revoking, mirroring the existing reason-tagged agent suspension. What cannot be preserved is documented in-product: agents that honored the uninstall intent must re-enroll after restore.

## Hidden + read-only

- `archived` (and `purging`, `merging`) stay **excluded** from `computeAccessibleOrgIds` and `isUsableOrgStatus` — invisible to every normal request, worker, agent, and RLS context. No change to any of the 272 tables' policies.
- Explicit archived reads: routes that support `includeArchived` (org list, org detail, quotes/invoices/tickets read views) resolve the archived org into a **dedicated read context** — `withArchivedOrgReadContext(orgIds, fn)` in `apps/api/src/db/index.ts` that (a) includes archived orgs in the RLS org set and (b) opens the transaction `SET TRANSACTION READ ONLY`. Read-onlyness is enforced by **Postgres** (`25006 read_only_sql_transaction` on any write), not middleware — covering public routes, workers, and anything else that might obtain the context. App-layer mutation guards are additive UX (clean 409s), not the enforcement boundary.
- Web UI: "Archived" filter section in OrganizationsPage; archived org detail renders read-only with a Restore button and the purge countdown.

## Billing stops

Archived orgs are excluded from device counts and billing rollups. Concretely: the hosted billing device-count surface the `breeze-billing` service reads must filter `status NOT IN ('archived','purging','merging')` — flagged as an explicit integration checkpoint (billing repo has zero CI; verify by hand against the deployed query).

## Purge

- Sweeper (extends the offboarding sweeper cadence): for orgs with `status='archived' AND purgeAt <= now()`, **CAS `archived → 'purging'`** then enqueue tenant erasure. The CAS is the race guard: restore (`POST /orgs/:id/restore`) succeeds only from `archived`; once `purging`, restore returns 410. The erasure worker double-checks `status='purging'` before deleting (today it verifies nothing — this check is added).
- Warning notifications at T-14d and T-1d to partner admins (existing notification machinery), plus an audit event at purge enqueue.

## Restore

`POST /orgs/:id/restore` (partner scope + `orgs:write` + MFA): valid only from `archived`. Clears `archivedAt`/`purgeAt`/`offboardingTarget`, status → `active`, runs `restoreOrganizationTenantAccess` + lifts `org_archived` credential suspensions. Response enumerates what needs manual recreation (uninstalled agents, any hard-expired material).

## Relation to existing delete

- `DELETE /orgs/:id` keeps today's exact behavior (churned + deletedAt) for API compatibility; marked deprecated in docs with pointer to archive.
- The **web UI delete flow is replaced by Archive** (the current confirm modal's "cannot be undone" copy is wrong anyway — it's a soft delete).
- Existing `churned + deletedAt` rows are **left untouched** — legacy terminal records; no backfill, no reinterpretation.

---

# Security / tenancy checklist (repo contracts)

- `org_merge_events`: shape-3 RLS in the same migration; `PARTNER_TENANT_TABLES` allowlist; no cascade/export registration needed (no `org_id` column); verify cross-partner forge fails 42501 as `breeze_app`.
- New columns on `organizations` (`archivedAt`, `purgeAt`, `offboardingTarget`): `organizations` is in `CORE_ORG_CASCADE_DELETE_ORDER` → **each new column must be classified in `CORE_TENANT_EXPORT_POLICY`** (all three are `included`: timestamps + enum-ish varchar).
- Merge job runs under `withSystemDbAccessContext`; archived reads under the new READ ONLY context; no bare pool.
- All new mutation endpoints: MFA + scope gates matching existing org delete; merge additionally requires typed-name confirm (server-verified).
- Status-enum additions must be swept through every `status IN (…)` site: `computeAccessibleOrgIds`, `bearerTokenAuth`, `partnerApiAuth`, `tenantStatus.ts` (`isUsableOrgStatus`, `getActiveOrgTenant`, `isAgentTenantActive`), suspended-lifecycle escape hatch (`orgs.ts:1580-1640` — `merging`/`purging`/`archived` are NOT valid suspended-exit statuses), org form dropdown (archived/merging/purging are **not** manually settable — excluded from `createOrganizationSchema`/update schema; only the lifecycle endpoints set them).

# Testing

- **Registry contract** (Integration Tests): every required table has exactly one policy; no unknown tables; ordering constraints acyclic.
- **Merge integration** (real Postgres): two seeded orgs with fixtures for every collision class (singleton both-sides, tenant_variable key overlap, duplicate portal_user email, quotes + quote_orders + recipients composite-FK chain, device + link group, contacts with primary flag) → merge → assert survivor totals, dropped counts in summary, loser empty except audit tables, erasure enqueued, `org_merge_events` written; re-run merge job is a no-op (idempotent by job id + status guard). Forge a cross-partner merge → 403/422.
- **Quote-token continuity**: sign token under loser org, merge, public route resolves via merge mapping.
- **Archive integration**: archive → drain → finalize lands `archived` with `purgeAt`; archived org invisible in default list, visible with `includeArchived`; write inside archived read context fails `25006`; restore from `archived` works and from `purging` returns 410; sweeper CAS + erasure status check; billing count excludes archived.
- **RLS coverage** suite updated for `org_merge_events`; export-policy suite updated for the three new org columns.
- Unit: registry policy execution per class against Drizzle mocks with compiled-SQL assertions (per the vacuous-assertion lessons — assert via PgDialect, both SET and WHERE).

# Out of scope — roadmap items (file as GitHub issues when the feature is registered)

1. **Duplicate-org prevention**: per-partner duplicate-name warning (or soft unique) at org create — would have prevented the driving incident.
2. Org → site conversion (fold an org in as a site of another org).
3. Partner → partner org transfer.
4. Offboarding UX bundle (export → archive → purge as one guided flow).
5. Site move between orgs (`updateSiteSchema` strips `orgId` today).
6. Undelete for legacy `churned + deletedAt` orgs.

# Risks

| Risk | Mitigation |
|---|---|
| Single-tx WAL/lock footprint on large orgs | Preview threshold + refusal; maintenance-window override; merge is fenced so lock contention is against background readers only |
| Trigger interactions not fully enumerable up front | Registry ordering overrides + wCTE escape hatch; integration fixtures per collision class; conflicts recomputed in-tx |
| Erasure enqueue lost after merge commit | Sweeper backstop re-enqueues `merging + deletedAt` shells |
| Billing exclusion unverifiable in CI (separate repo, zero CI) | Explicit manual verification step in the implementation plan |
| Restore promises more than it can deliver | Reversible suspension for credentials; explicit in-product list of what re-enrollment requires |
