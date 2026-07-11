# Partner-owned config policies: selective org assignment (library model)

- **Date:** 2026-07-07
- **Issue:** [#2280](https://github.com/LanternOps/breeze/issues/2280)
- **Related:** epic #2135 (partner-wide-first), #1724 (established `partner = all orgs`), #2101 (partner-wide UI 400s), #2168 (backup still org-locked)
- **Status:** Approved — ready for implementation plan

## Problem

The partner-wide-first epic (#2135) gave configuration policies a reusable **ownership** axis (`org_id` XOR `partner_id`): a partner-owned policy is defined once and can span every org. It never added a **selective targeting** axis. The current assignment model forces all-or-one:

- **Partner-owned** policy → `validateAssignmentTarget` (`apps/api/src/services/configurationPolicy.ts:1177-1185`) permits **only** a `partner`-level assignment, which means literally *all* of the partner's orgs.
- **Org-owned** policy → may only be assigned within its single owning org.

There is no way to define one reusable policy and apply it to a **chosen subset of orgs**. This blocks the natural MSP onboarding workflow: define the standard policy once, then assign it to each customer org as they are brought on. #1724 introduced the `partner = all orgs` constraint that this design relaxes.

## Goals

- A partner-owned config policy acts as a **library definition**: it is **created empty** (reaches **zero** devices) and reaches nothing until explicitly assigned.
- It can be assigned to a selectable subset of orgs (and to lower levels — site / group / device — within those orgs), one at a time.
- A single "All orgs" toggle applies it partner-wide when wanted.
- Cross-partner assignment remains impossible (tenant isolation).

## Non-goals

- Bulk org-**group** / org-**tag** targeting. That is a future convenience layer; this design ships per-org multi-select only.
- Any change to the `backup` feature type, which is still org-locked pending #2168.
- Changing org-owned policy behavior in any way.

## Behavior change (scoped and intentional)

One deliberate behavior change, plus otherwise-additive work:

- **New partner-owned policies are created empty.** Today `crud.ts:95` auto-seeds a `partner`-level assignment on create, so "All organizations" ownership applies everywhere immediately. The library model removes that seed: a newly-created partner-owned policy reaches **0 devices** until assigned via the Organizations panel. The create-form option is relabeled accordingly.
- **Existing partner-owned policies are untouched** — they keep their already-seeded `partner`-level assignment and continue to apply to all orgs. No migration, no backfill.
- **Everything else is additive.** Allowing `organization`/`site`/`device_group`/`device` assignments for partner-owned policies changes no existing data; the resolver already resolves the new shape (only a write-side guard blocks it).

## Design

### Layer 0 — Create path: stop auto-seeding the partner assignment

**File:** `apps/api/src/routes/configurationPolicies/crud.ts` — POST `/` handler, partner-owned branch (`:82-104`).

Remove the `assignPolicy(policy.id, 'partner', auth.partnerId, ...)` seed at `:95` and its lockstep comment (`:83-94`). The policy is created with **no** assignment. Update the audit `details` to drop `autoAssignedPartnerWide: true`. The transaction reasoning about "committed-but-unassigned" no longer applies — empty is now the intended state.

**File:** `apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.tsx` — the ownerScope radio (`:247-266`).

Relabel the partner option from **"All organizations (partner-wide)"** to **"Partner library — assign to organizations after creating"** with helper copy: *"Create a reusable policy owned by your partner. It applies to no organizations until you assign it on the policy's Organizations tab."* No behavioral field change — still sends `ownerScope: 'partner'`.

### Layer 1 — Backend validator (the load-bearing change)

**File:** `apps/api/src/services/configurationPolicy.ts` — `validateAssignmentTarget` (currently `:1167-1257`).

Current behavior for a partner-owned policy (`policyOwner.partnerId` set):

```
if (level !== 'partner')  -> reject ("Partner-wide policies can only be assigned at the Partner level")
if (targetId !== partnerId) -> reject
```

New behavior: keep the `partner`-level branch (target must equal the policy's own partner), and add branches for `organization` / `site` / `device_group` / `device` that validate the **target resolves to an org owned by the policy's partner**:

- `organization`: target org exists AND `organizations.partner_id === policyOwner.partnerId`.
- `site`: site exists AND its org's `partner_id === policyOwner.partnerId`.
- `device_group`: group exists AND its org's `partner_id === policyOwner.partnerId`.
- `device`: device exists AND its org's `partner_id === policyOwner.partnerId`.

Any target whose owning org belongs to a different partner → `{ valid: false, error: 'Target is not in this partner' }`. This mirrors the existing org-owned cross-org rejection; it is the tenant-isolation backstop at the app layer (RLS is the real backstop — see Layer 4).

**Unchanged:**
- The org-owned branches (target must be within the single owning org).
- The `partner`-level rejection for **org-owned** policies (the footgun guard at `:1241-1252`).
- Resolution. `resolveEffectiveConfigWithExecutor` (`:1303-1391`) already:
  - collects `organization`-level assignments for `device.orgId` (`:1354-1356`), plus site/group/device/partner levels, and
  - admits partner-owned policies in its ownership filter (`:1389-1391`: `orgId IS NULL AND partnerId = org.partnerId`).
  A partner-owned policy carrying an org-level assignment for the device's org already flows through untouched. **No resolver edit, no schema change, no migration.**

**Authorization (route change required):** today the POST `/:id/assignments` route (`assignments.ts:70-88`) only gates `canManagePartnerWidePolicies(auth)` when `level === 'partner'`. Once partner-owned policies accept lower levels, that gate would be bypassed for an org-level assignment on a partner-owned policy. Extend it: for **any** partner-owned policy (`policy.orgId === null`), require `canManagePartnerWidePolicies(auth)` regardless of level — managing the partner library is a full-partner-access capability in v1. The DELETE route already applies this gate for `policy.orgId === null` (`:152`), so it needs no change. Single source of truth: `services/partnerWideAccess.ts`.

**AI tools:** `assign_policy_to_target` and `apply_configuration_policy` (`aiToolsConfigPolicy.ts`) call the same `validateAssignmentTarget`, so they are unblocked by this one change — no separate edit, but they must be covered by the sweep (see Layer 5).

### Layer 2 — API surface

No new endpoints. The panel is a thin client over existing routes:

- Orgs for the partner: existing org list endpoint (the same source the create-time ownerScope selector uses).
- `GET /configuration-policies/:id/assignments` — current assignments.
- `POST /configuration-policies/:id/assignments` — add (`{ level, targetId, priority? }`).
- `DELETE /configuration-policies/:id/assignments/:aid` — remove.

### Layer 3 — Frontend "Organizations" panel

**Location:** partner-owned policy detail page (`apps/web/src/components/configurationPolicies/`). Hidden entirely for org-owned policies.

**Behavior:**
- Master **"All orgs (partner-wide)"** toggle. ON → ensures the single `partner`-level assignment exists (targetId = partnerId). OFF → removes it.
- Searchable checklist of the partner's orgs. Each checked org = one `organization`-level assignment; unchecking removes it.
- **Mutual exclusivity:** turning "All orgs" ON removes all per-org `organization` assignments; checking any org removes the `partner` assignment. The two states never coexist, so the data model stays honest (one partner row = all, or N org rows = subset).
- Site / group / device precision stays in the existing generic **Assignments** tab, which is now reachable for partner-owned policies (previously it would 400 on save — cf. #2101).
- Mutations go through `runAction` so success/failure is always surfaced (per `apps/web/src/lib/runAction.ts` convention).

**Empty state:** no assignments → "This policy isn't applied to any organizations yet. Toggle *All orgs* or pick organizations below."

### Layer 4 — Tenant isolation (RLS)

`config_policy_assignments` RLS is unchanged and remains the real backstop. The new app-layer validation is defense-in-depth, not the enforcement boundary. A cross-partner assignment insert must still fail at the DB with `42501` even if the validator were bypassed.

### Layer 5 — Call-site sweep (per CLAUDE.md partner-wide playbook step 7)

Before "done", grep every path that creates a config-policy assignment or resolves effective config, to confirm none carries an independent `partner-owned ⇒ partner-level-only` assumption:
- `routes/configurationPolicies/assignments.ts`
- `services/aiToolsConfigPolicy.ts` (both assign tools)
- `services/configurationPolicy.ts` (`assignPolicy`, `validateAssignmentTarget`, resolver)
- any preview/diff path (`previewConfigChange` at `:1509`)

## Testing

Framework: Vitest (API unit + RLS/integration).

1. **`validateAssignmentTarget` unit tests** (new branches):
   - partner-owned + `organization` target in-partner → valid.
   - partner-owned + `organization` target out-of-partner → invalid.
   - partner-owned + `site`/`device_group`/`device` in-partner → valid; out-of-partner → invalid.
   - partner-owned + `partner` target = own partner → still valid; different partner → invalid (unchanged).
   - org-owned behavior unchanged (regression guard).

2. **Resolver test** (real DB):
   - Partner-owned policy assigned to org A only → device in org A resolves the policy; device in org B (same partner, unassigned) does **not**.
   - Same policy switched to "All orgs" (partner assignment) → both devices resolve it.

3. **Partner-RLS integration suite** (`configurationPolicyAssignmentsPartnerRls.integration.test.ts` or extend the existing config-policy partner suite):
   - Cross-partner forged assignment insert → `42501`.
   - App-layer cross-partner assignment via route → rejected (validation error, not a silent no-op).

## Rollout

No migration, no data backfill, no feature flag. Existing partner-owned policies keep their seeded `partner`-level assignment and behave identically. The one behavior change — new partner-owned policies created empty — affects only policies created after ship. Ship order: backend validator + route auth + create-path change (with tests) first (this alone unblocks the AI tools and the empty-create model), then the Organizations panel.

## Open questions

None blocking. Future: bulk org-group/org-tag targeting (deliberately deferred).
