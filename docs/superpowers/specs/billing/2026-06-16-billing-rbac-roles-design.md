# Billing RBAC: dedicated roles, tightened grants, permission-aware UI

**Date:** 2026-06-16
**Status:** Approved (design)
**Author:** Claude (with Todd)

## Problem

The three billing features — Product Catalog, Invoices, Recurring Contracts — are fully
RBAC-gated on the API (`requirePermission()` + `requireScope('partner','system')`), and the
`catalog`/`invoices`/`contracts` permissions are seeded onto partner system roles. But:

1. **No dedicated billing role exists.** Outside of Partner Admin (`*:*`), billing access only
   rides on **Partner Technician** — a broad operational role (device execute, scripts execute,
   etc.). You cannot grant *just* billing without also handing out technician capabilities.
2. **Partner Technician was over-granted.** The feature backfill migrations gave Technician full
   `invoices:send` (issue/void/record-payment) and `contracts:manage` (activate/cancel) because it
   held `tickets:write`. A technician can void invoices and cancel contracts — broader than intended.
3. **The web UI is permission-blind.** Nav gates by scope only; action buttons always render and
   rely on a server 403. Users see controls they can't use.

## Decisions (locked)

- **Two new global partner-scope system roles:**
  - **Partner Billing** — full billing: every action on `catalog`, `invoices`, `contracts`.
  - **Partner Billing Viewer** — read-only: `catalog:read`, `invoices:read`, `invoices:export`,
    `contracts:read`.
- **Strip billing from existing roles:** remove ALL `catalog`/`invoices`/`contracts` grants from
  **Partner Technician**, and remove `catalog:read` from **Partner Viewer**. Billing access then
  lives solely in Partner Admin + the two new roles.
- **UI hiding:** hide Invoices/Contracts/Catalog nav items when the user lacks the matching `:read`
  permission, AND hide write/send/manage/delete action buttons when the user lacks the matching
  grant. Requires exposing the user's permission set to the browser.

## Data model facts that shape the implementation

- System roles are **global singleton rows** (`partner_id = NULL, is_system = true`), with one
  exception: **Partner Admin** is cloned per-partner at registration (with the `*:*` wildcard, so
  admins keep everything automatically — no change needed). So a new global role + edits to the
  global Technician/Viewer rows cover all existing and future partners. Per-partner custom roles are
  untouched.
- `roles` has **no unique constraint** beyond the PK, so inserts must be `NOT EXISTS`-guarded.
- On a **fresh DB**, migrations run before `seed.ts`, so the feature backfill migrations no-op
  (roles don't exist yet) and **`seed.ts` is authoritative**. On an **existing DB** (prod EU/US),
  roles exist and the backfills already granted Technician/Viewer the billing perms, so the
  **migration must revoke them**. Both paths must converge to the same end state.
- `seed.ts` `DEFAULT_PERMISSIONS` lists `catalog` but **not** `invoices`/`contracts` (those rows are
  created only by the feature migrations). Add them so the seed path is self-consistent.
- Permission cache is **5-min TTL** (Redis version + in-memory). A pure-SQL migration is picked up
  automatically on next refresh — no code-side cache bump needed.

## Part A — Roles & permissions

**New migration** `apps/api/migrations/2026-06-19-billing-roles.sql` (dated to sort after all
existing backfills; idempotent, mirrors the `NOT EXISTS`-guard pattern from the existing billing
migrations):

1. Create the two roles (`partner_id = NULL, scope = 'partner', is_system = true`), guarded by
   `NOT EXISTS` on `(partner_id IS NULL, scope, name, is_system)`.
2. Grant perms via `NOT EXISTS`-guarded `role_permissions` inserts:
   - Partner Billing ← all permissions where `resource IN ('catalog','invoices','contracts')`.
   - Partner Billing Viewer ← `catalog:read`, `invoices:read`, `invoices:export`, `contracts:read`.
3. Revoke from the global system rows only (`partner_id IS NULL AND is_system = true`):
   - Partner Technician ← delete all `catalog`/`invoices`/`contracts` grants.
   - Partner Viewer ← delete `catalog:read`.
   - Each `DELETE` wrapped in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING
     'revoked % …', n; END IF; END $$;` per the repo cleanup-statement convention.

**`seed.ts`** (fresh-install authority):
- Add `invoices` (read/write/send/export) and `contracts` (read/write/manage) entries to
  `DEFAULT_PERMISSIONS`.
- Add `Partner Billing` and `Partner Billing Viewer` to `SYSTEM_ROLES` with their permission lists.
- Remove `catalog:read`/`catalog:write` from `Partner Technician`; remove `catalog:read` from
  `Partner Viewer`.
- Verify `seedRoles` re-grant is idempotent so it co-exists with the migration on a fresh DB.

## Part B — Expose permissions to the browser

- Extend `GET /users/me` to include `permissions: [{ resource, action }]` via the existing
  `getUserPermissions()` (route already authenticated; `/me` is fetched at startup).
- Web: add `permissions` to the `User` type + auth store, populated from the `/me` fetch.
- Add a wildcard-aware `hasPermission(perms, resource, action)` helper on the web mirroring the
  server check (`*` resource/action match).

## Part C — Permission-aware UI hiding

- **Sidebar** (`apps/web/src/components/layout/Sidebar.tsx`): extend `NavItem` with
  `requiredPermission?: { resource, action }`; set Invoices→`invoices:read`,
  Contracts→`contracts:read`, Product Catalog→`catalog:read` (keep existing `partnerScopeOnly`).
  Hide via the same inline pattern as the scope check.
- **Action gating** on the pages (hide buttons; server still enforces):
  - Invoices: create/edit/delete → `invoices:write`; issue/send/void/record-payment →
    `invoices:send`; PDF/export → `invoices:export`.
  - Contracts: create/edit/delete-draft/add-line → `contracts:write`;
    activate/pause/resume/cancel/generate → `contracts:manage`.
  - Catalog: create/edit → `catalog:write`; archive → `catalog:delete`.

## Testing

- **API:** unit test `/me` includes permissions (Drizzle mock per `breeze-testing`). Migration
  ordering covered by `autoMigrate.test`. Optional integration assertion: Technician no longer holds
  billing perms; Partner Billing holds the full set.
- **Web:** Sidebar hides nav by permission; action buttons hidden by permission (vitest + jsdom,
  mocked auth store).
- **Agent:** no changes.

## Operational note (deploy)

On existing prod (EU/US), any user **currently on Partner Technician who does billing loses access**
within ≤5 min (cache TTL) once this migration runs. They must be reassigned to **Partner Billing**
(or **Partner Billing Viewer**). This is the intended effect — but it needs a heads-up / comms
before deploy.

## Out of scope

- No "Org"-scope billing roles (billing is partner-scoped by `requireScope`).
- No migration of existing user→role assignments (operators reassign as needed).
- No Stripe/portal changes (customer-facing portal routes are intentionally un-RBAC'd).
