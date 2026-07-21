# Vulnerability Risk-Acceptance Governance (RBAC) — Design

**Date:** 2026-06-23
**Branch:** `feat/be16-vuln-phase1`
**Status:** Approved (brainstorm) → ready for implementation plan
**Feature:** BE-16 Vulnerability Management — Enhancement Phase 1

## Problem

`POST /vulnerabilities/:id/accept-risk` and `POST /vulnerabilities/:id/reopen` are
gated by `devices:write`. That permission is held by the stock **Org Technician**
role (`apps/api/src/db/seed.ts`, `SYSTEM_ROLES` → Org Technician grants
`devices:read`, `devices:write`, `devices:execute`). The result: a default
technician can **unilaterally waive a critical / KEV finding** — too low a bar for
a security-governance action.

We add a dedicated capability so that accepting (and reopening) risk requires an
explicit, higher-trust grant that admins and a purpose-built approver role hold,
but ordinary technicians do not.

## Scope

In scope (Enhancement Phase 1):

- New permission `vulnerabilities:accept_risk`.
- Re-gate `accept-risk` and `reopen` on it.
- New stock roles "Security Approver" (org) and "Partner Security Approver"
  (partner).
- Migration + seed reconciliation + contract tests + web UI gating.

**Deferred (explicitly out of scope):** dual-control / second-approver co-sign for
critical/KEV waivers. See "Deferred: dual-control" below. There is no existing
two-distinct-approver machinery in the codebase (only maker/checker
`requester ≠ approver` guards on PAM elevations, audit baselines, CIS hardening),
so co-sign is a separate 1–2 week feature with its own spec.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Permission shape | New **`vulnerabilities`** resource, action `accept_risk` | Clean semantic grouping in the role editor; future-proofs Phase 2+ vuln actions; Partner Admin `*:*` still satisfies it. Read/mitigate/remediate stay on `devices:*`. |
| Reopen gating | **Same new permission** as accept-risk | Reopen un-waives a finding (clears `acceptedBy`/`acceptedUntil`) — it is the reversal of the privileged act, so the same approver owns both. Mental model: "managing risk-acceptance = one permission." |
| Mitigate gating | **Unchanged** (`devices:write`) | Mitigate asserts a compensating control is in place (technician work) and is reversible via the now-gated reopen. Accept-risk is the formal waiver. |
| Dual-control | **Deferred** | Biggest governance win is the RBAC gate; co-sign is a separate feature (no existing machinery). |
| Approver role | **Both scopes, minimal perms** | Breeze serves internal-IT (org) and MSPs (partner). The accept-risk route already accepts org + partner + system callers. |

## Architecture

The RBAC model is a flat `{resource, action}` grant set:

- **Registry:** `packages/shared/src/constants/permissions.ts` (`PERMISSION_GRANTS`)
  is the single source of truth. The API re-exports it as `PERMISSIONS`
  (`apps/api/src/services/permissions.ts`); the web derives
  `PermissionResource`/`PermissionAction` types from it.
- **Catalog:** `apps/api/src/db/seed.ts` `DEFAULT_PERMISSIONS` mirrors the registry
  with human descriptions; `seedPermissions()` inserts any missing
  `(resource, action)` rows (idempotent, exact-pair match).
- **Roles:** `SYSTEM_ROLES` in seed.ts; `seedRoles()` find-or-creates each role and
  `onConflictDoNothing()`-inserts its grants — additive and idempotent.
- **Enforcement:** `requirePermission(resource, action)` middleware; `hasPermission`
  supports `*` wildcards. Web mirrors with `usePermissions().can(...)` (UX-only;
  every route re-checks server-side).

### Changes

**1. Permission registry — `packages/shared/src/constants/permissions.ts`**

```ts
// Vulnerability management (BE-16) — governance capability
VULN_RISK_ACCEPT: { resource: 'vulnerabilities', action: 'accept_risk' },
```

**2. Seed catalog — `apps/api/src/db/seed.ts` `DEFAULT_PERMISSIONS`**

```ts
{ resource: 'vulnerabilities', action: 'accept_risk',
  description: 'Waive (accept risk) and reopen vulnerability findings' },
```

**3. Route gating — `apps/api/src/routes/vulnerabilities.ts`**

- `accept-risk` and `reopen`: swap `requireVulnerabilityWrite` for
  `requirePermission(PERMISSIONS.VULN_RISK_ACCEPT.resource, PERMISSIONS.VULN_RISK_ACCEPT.action)`.
- `mitigate`: keep `requireVulnerabilityWrite` (devices:write) — comment the
  asymmetry.
- Router-level `requireVulnerabilityRead` (devices:read), scope, and the per-device
  site gate are unchanged. Any approver therefore still needs `devices:read`
  (included in the new roles).

**4. Stock roles — `SYSTEM_ROLES`**

- **Org Admin:** add `vulnerabilities:accept_risk`.
- **Partner Admin:** covered by `*:*` (no change).
- **New "Security Approver"** (org scope): `devices:read`,
  `vulnerabilities:accept_risk`.
- **New "Partner Security Approver"** (partner scope): `devices:read`,
  `organizations:read`, `vulnerabilities:accept_risk`.
- Technicians / Viewers: unchanged (no grant).

Because a user holds a single role per membership (`organizationUsers.roleId` /
`partnerUsers.roleId`), Security Approver is a standalone focused role (like
Partner Billing), not an add-on to a technician role.

**5. Migration — `apps/api/migrations/2026-06-29-vuln-risk-accept-permission.sql`**

> Filename note: migrations apply in lexicographic order and the repo's timeline
> already runs ahead of the wall clock (latest is `2026-06-28-pam-signer-groups.sql`).
> Name the file so it sorts **after** the latest existing migration — `2026-06-29-…`
> at time of writing — and confirm with the `apps/api/src/db/autoMigrate.test.ts`
> ordering regression. (Re-confirm the latest migration at implementation time.)

Idempotent, modeled on `2026-06-25-sso-admin-permission-backfill.sql` and
`2026-06-19-billing-roles.sql`:

1. `INSERT ... WHERE NOT EXISTS` the `vulnerabilities:accept_risk` permission row
   (the `permissions` table has no unique(resource,action) constraint — guard with
   `WHERE NOT EXISTS`).
2. Grant it to the global **Org Admin** system role
   (`partner_id IS NULL AND scope='organization' AND name='Org Admin' AND is_system`),
   NOT EXISTS guard, `RAISE WARNING` with the row count.
3. Create the two new global system roles (NOT EXISTS guard on
   `partner_id IS NULL AND scope=… AND name=… AND is_system`) and grant each its
   permission set.
4. **No backfill to `devices:write` holders** — that would re-open the hole. Only
   future accept/reopen calls are re-gated; existing `accepted` findings are
   untouched. On a fresh DB the migration runs before seed.ts and both converge to
   the same end state.

**6. Web — `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx`**

- `const { can } = usePermissions();` then `const canAcceptRisk = can('vulnerabilities','accept_risk');`
- Hide/disable the **Accept risk** button and the **reopen** control when
  `!canAcceptRisk`. Mitigate stays gated on a `devices:write` check.
- Mutations already route through `runAction` (no-silent-mutations) — no change to
  that wiring.

## Tenancy / RLS

No new tables. `vulnerabilities` (catalog) and `device_vulnerabilities` are
existing; their RLS is unchanged. The new permission is metadata in the existing
`permissions` / `role_permissions` tables (already RLS-governed). No new tenancy
shape.

## Testing

- **`apps/api/src/db/seed.test.ts`** — seed↔registry consistency: every
  `SYSTEM_ROLES` permission key resolves in `DEFAULT_PERMISSIONS`, and
  `PERMISSION_GRANTS` ↔ `DEFAULT_PERMISSIONS` stay in sync. Update expected
  role/permission sets for the new perm + two roles.
- **`apps/api/src/services/permissions.test.ts`** — registry assertions (known /
  assignable permission sets) updated for the new grant.
- **`apps/api/src/__tests__/integration/seed-idempotency.integration.test.ts`** —
  re-seed must not duplicate the new role/permission.
- **`apps/api/src/routes/vulnerabilities.test.ts`** — RBAC functional assertions:
  - a caller with `devices:write` but **not** `vulnerabilities:accept_risk`
    (Org Technician shape) → **403** on `accept-risk` and `reopen`;
  - a caller holding `vulnerabilities:accept_risk` → passes the gate;
  - `mitigate` still works for a `devices:write` caller.
- **`apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx`** — the
  Accept-risk / reopen control is hidden/disabled without the permission and
  present with it.
- Run the API suite for affected files single-fork (pinned Node
  `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`); verify the migration against
  a throwaway `postgres:16` (or `pnpm db:check-drift`); then end-to-end on the
  worktree stack (`pnpm wt-stack up`, same-origin `:55019`,
  admin@breeze.local / BreezeAdmin123!, synthetic CVE-2025-CLAUDE-* findings).

## Deferred: dual-control (second-approver co-sign)

Open product question raised and **deferred** to a follow-on spec: should
critical/KEV risk-acceptance require a *second, distinct* approver to co-sign
(true dual-control / four-eyes), rather than a single approver's unilateral
waiver?

Findings that shape that future spec:

- The generic `approval_requests` table (`apps/api/src/db/schema/approvals.ts`,
  Shape-6 user-id scoped, mobile/AI-oriented) exists, but **no true dual-approval
  lifecycle** is implemented anywhere — only maker/checker `requester ≠ approver`
  guards (PAM elevations `routes/pam.ts:480`, audit baselines, CIS hardening).
- A real co-sign flow needs a new lifecycle (pending → first-signed →
  second-approved) and a distinct-approver constraint — estimated 1–2 weeks,
  warranting its own brainstorm + spec.

Also considered and deferred: requiring **MFA / step-up** on accept-risk
(currently none, since it queues no command). Adjacent to the dual-control
question; left out of this RBAC-focused phase.

## Out of scope

- Dual-control / co-sign (above).
- MFA / step-up on accept-risk.
- Changing read / mitigate / remediate gating.
- Per-severity differentiation of the gate (one permission covers all severities;
  severity-tiered approval is part of the deferred dual-control work).
