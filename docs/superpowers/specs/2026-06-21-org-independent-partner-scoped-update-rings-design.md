# Org-Independent (Partner-Scoped) Update Rings & Approvals — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Branch/worktree:** `worktree-patching-org-independent-rings`

## Problem

Update rings (`patch_policies`) and patch approvals (`patch_approvals`) are bound to a single
organization today (`org_id NOT NULL`, org-axis RLS). To configure patching you must pick one org,
and approval decisions are stored per-org. But rings are meant to be reusable templates: a ring is
linked into a **configuration policy** (`featurePolicyId`, Pattern A linked policy), and the *config
policy* is what gets assigned to an org/site/device-group/device via the assignment hierarchy.

The org binding on the ring is therefore redundant and obstructive. We want to:

1. **Create update rings for "All Orgs"** — a ring is built once and reaches orgs only via config-policy assignment.
2. **Approve updates per ring (org-independent)** — one approval decision flows to every org a ring is assigned to.

## Decision: scope boundary = Partner

"Org-independent / All Orgs" means **all orgs under the same Partner (MSP)**, not platform-wide.
Rings and ring approvals move from **org-axis (RLS shape 1)** to **partner-axis (RLS shape 3)**.
Other partners/MSPs remain fully isolated. There is no system/global ring library in this change.

### Confirmed consequence (accepted)

Partner-axis RLS cannot be satisfied by org-scoped users: `breeze_accessible_partner_ids()` is empty
for them and `breeze_has_partner_access()` does not consider the org→partner relationship
(`apps/api/migrations/2026-04-11-partners-rls.sql:58-68`). Precedent partner-scoped routes
(`time_entries`, `huntress`) gate with `requireScope('partner','system')`.

Therefore **ring creation and update-approval become partner-admin / system-scope only.** Org-scoped
(end-customer) users lose the ability to create rings or approve updates. They retain **read-only**
Compliance and Patches tabs for their own devices (those remain org-scoped). This is the intended
MSP-centric behavior.

## Current state (reference)

| Entity | File | Org scoping today |
|---|---|---|
| `patch_policies` (rings) | `apps/api/src/db/schema/patches.ts:142-169` | `org_id` NOT NULL, org-axis RLS |
| `patch_approvals` | `apps/api/src/db/schema/patches.ts:171-191` | `org_id` NOT NULL + nullable `ring_id`; unique `(org_id, patch_id, COALESCE(ring_id, NIL))` |
| `patches` | `apps/api/src/db/schema/patches.ts:110-140` | Global catalog, no org |
| `device_patches` | `apps/api/src/db/schema/patches.ts:193-211` | `org_id` (stays org-scoped) |
| `patch_jobs` | `apps/api/src/db/schema/patches.ts:213-232` | `org_id` + `ring_id` (stays org-scoped) |
| `patch_compliance_snapshots` | `apps/api/src/db/schema/patches.ts:272-287` | `org_id` + `ring_id` (stays org-scoped) |
| Ring routes | `apps/api/src/routes/updateRings.ts` | `resolveOrgId` / `canAccessOrg(ring.orgId)` |
| Ring helpers | `apps/api/src/routes/updateRingsHelpers.ts` | device counts via config-policy assignments (org-agnostic) |
| Approval routes | `apps/api/src/routes/patches/approvals.ts` | org via body/query; `resolvePatchApprovalOrgIdForRing` |
| Approval upsert | `apps/api/src/routes/patches/helpers.ts:79-120` | raw SQL upsert on org+patch+ring index |
| Evaluator | `apps/api/src/services/patchApprovalEvaluator.ts:384-467` | manual → category → ring auto → policy/org fallback |
| AI tool | `apps/api/src/services/aiToolsPolicyPrereqs.ts:79-230` | `getOrgId(auth)` / `orgWhere(auth, patchPolicies.orgId)` |
| Web page | `apps/web/src/components/patches/PatchesPage.tsx` | 3 tabs; org from `useOrgStore`; All-Orgs blocks writes |
| Approval modal | `apps/web/src/components/patches/PatchApprovalModal.tsx:102-115` | requires ring OR `currentOrgId` |
| Ring form/list | `apps/web/src/components/patches/UpdateRingForm.tsx`, `UpdateRingList.tsx` | org injected by `fetchWithAuth` |

## Target data model

### `patch_policies` (rings)
- **Drop `org_id`.** Add `partner_id uuid NOT NULL REFERENCES partners(id)`.
- All other columns unchanged (`kind`, `autoApprove`, `categoryRules`, `schedule`, `ringOrder`,
  `deferralDays`, `deadlineDays`, `gracePeriodHours`, `categories`, `excludeCategories`, targeting, etc.).
- Semantics: a partner-level template; reaches orgs only via config-policy `featurePolicyId` + assignment.

### `patch_approvals`
- **Drop `org_id`.** Add `partner_id uuid NOT NULL REFERENCES partners(id)`.
- New unique key: **`(partner_id, patch_id, COALESCE(ring_id, NIL_UUID))`**.
  - `ring_id` set → approval for that specific ring; flows to every org the ring is assigned to.
  - `ring_id IS NULL` → **partner-wide blanket approval** across all that partner's rings
    (today's org-wide fallback, lifted to partner — the "keep partner wide" decision).

### Unchanged (stay org-scoped)
`patches` (global), `device_patches`, `patch_jobs`, `patch_compliance_snapshots`. Their `ring_id`
columns now FK a partner-scoped ring. **Job creation must verify** the referenced ring's `partner_id`
equals the device-org's `partner_id` (app-layer check, since RLS no longer ties them through org).

## Tenancy / RLS

- Switch both tables to partner-axis: `breeze_has_partner_access(partner_id)` on SELECT/INSERT/UPDATE/DELETE.
- `rls-coverage.integration.test.ts`: add both to `PARTNER_TENANT_TABLES`; they leave org auto-discovery
  (no `org_id`). No `ORG_AXIS_POLICY_EXCLUDED_TABLES` entry needed (org_id fully removed).
- Add functional `breeze_app` forge tests: partner A cannot SELECT/INSERT partner B's rings or approvals.

## Migration & backfill

New dated, idempotent migrations (`YYYY-MM-DD-*`); never edit shipped files. Ordering: do rings before
approvals if the approval migration references ring partner data; use `-a-`/`-b-` infixes if same-day
dependent.

1. Add nullable `partner_id` to `patch_policies` and `patch_approvals` (`ADD COLUMN IF NOT EXISTS`).
2. Backfill from the row's org:
   `UPDATE patch_policies p SET partner_id = o.partner_id FROM organizations o WHERE p.org_id = o.id AND p.partner_id IS NULL;`
   (same for `patch_approvals`). Wrap each in the `DO $$ ... GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING ...` pattern.
3. **Dedup approvals before the new unique index.** Two orgs under one partner can each hold a
   `ring_id IS NULL` approval for the same patch → collision on `(partner_id, patch_id, NIL)`.
   Collapse to one deterministic winner per `(partner_id, patch_id, NIL)` group:
   status precedence `approved > deferred > rejected > pending`, then latest `updated_at`. Delete losers;
   `RAISE WARNING` the collapsed count. Ring-specific rows cannot collide (`ring_id` globally unique).
4. `SET NOT NULL` on `partner_id` (both). Drop old org RLS policies, old unique index, and `org_id` column.
   Add partner RLS policies, the new unique index, and a `partner_id` btree index.
5. Verify as `breeze_app` per the RLS workflow (forge cross-partner insert must fail).

## API / service / AI-tool changes

- **`/update-rings` routes** (`updateRings.ts`): gate `requireScope('partner','system')`. Replace
  `resolveOrgId` / `canAccessOrg(ring.orgId)` with `resolvePartnerId(auth, body.partnerId)` +
  `canAccessPartner(partnerId)`. List/get/patch/delete filter on `partner_id`. `:id/patches` and
  `:id/compliance` resolve devices via the ring's config-policy assignments (already org-agnostic in
  `updateRingsHelpers.ts`) and read approvals by `(partner_id, ring_id)`.
- **Approval routes** (`patches/approvals.ts`, `bulk-approve`, `:id/approve|decline|defer`): drop org
  resolution; resolve partner (from the selected ring, else from auth for partner-wide). Gate
  `requireScope('partner','system')`. Upsert on the new partner key in `patches/helpers.ts`.
- **Validators** (`packages/shared/src/validators/index.ts`): optional `orgId` → optional `partnerId`
  in ring create/list and approval schemas. Keep `ringAutoApproveSchema` fail-closed behavior.
- **AI tools** (`manage_update_rings` + approval tools in `aiToolsPolicyPrereqs.ts`): replace
  `getOrgId`/`orgWhere(patchPolicies.orgId)` with partner equivalents; require partner/system scope;
  return a clear error string when invoked in org scope.

## Approval evaluation (`patchApprovalEvaluator.ts`)

Resolve the device's partner via `device → org → partner_id`, resolve the device's effective ring via
its config policy, then decide in order:

1. Manual ring approval `(partner_id, ring_id, patch_id)` — any status (approved/rejected/deferred).
2. Manual partner-wide approval `(partner_id, patch_id, ring_id IS NULL)`.
3. Ring category rule (`category_rules`).
4. Ring auto-approve (`auto_approve` severities + deferral window).

Remove the legacy org/policy-level fallback (it was org-scoped).

## Frontend (`/patches`)

- **Update Rings tab:** primary mode is now "All Orgs" for partner/system users; remove the
  "select an organization" gate on create/edit/delete. Reuse `PageScopeIndicator`
  ("Shared across all organizations").
- **Approvals (`PatchList` + `PatchApprovalModal`):** enable approve/decline/defer in All-Orgs mode;
  drop the "select an org" requirement. Action is partner-wide unless a ring is selected (then
  ring-scoped). `RingSelector` lists partner rings.
- **Org-scoped users:** hide/disable the Update Rings tab and approval actions (they 403 at the API);
  keep read-only Compliance + Patches for their own devices. Sidebar nav unchanged.

## Cascade lists

- **Remove** `patch_policies` and `patch_approvals` from org-cascade
  (`tenantCascade.ts ORG_CASCADE_DELETE_ORDER` and `core.ts` device/org-delete lists) — deleting an org
  must NOT delete partner-owned rings/approvals. Add them to the **partner-cascade** path.
- `patch_jobs` and `patch_compliance_snapshots` remain in org-cascade (still org-scoped).
- Keep ring delete as soft-delete (`enabled=false`) so referencing jobs/snapshots stay valid.

## Testing

- RLS contract (allowlist) + functional forge: partner A vs partner B isolation on both tables.
- Migration test: backfill correctness + the `ring_id IS NULL` approval dedup/collision case.
- Route tests: org-scoped request → 403 on ring CRUD and approvals; partner CRUD + approval succeed;
  cross-partner access denied; job creation rejects a ring from another partner.
- Evaluator unit tests: ring approval vs partner-wide vs category vs auto-approve precedence.
- Web tests: All-Orgs ring create + approve enabled for partner user; org user sees read-only and no
  ring/approval actions.

## Risks / notes

- **Behavior change:** org-scoped users lose ring/approval management (accepted, see "Confirmed consequence").
- **Approval dedup** in migration is the highest-risk step — it deletes data. Must report row counts.
- **Cross-partner ring reference** on org-scoped `patch_jobs` is only enforced at app layer; cover with a test.
- `breeze.current_partner_id` IS set in session context for org-scoped users, but
  `breeze_has_partner_access` ignores it — do not rely on it to grant org-user access.
