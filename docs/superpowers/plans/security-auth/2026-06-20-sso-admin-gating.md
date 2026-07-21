# SSO `sso:admin` Gating (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configuring an org's SSO provider a distinct `sso:admin` capability (separate from general `orgs:write`), without locking out any current SSO admin.

**Architecture:** Add an `sso:admin` permission to the shared catalog; swap the SSO provider routes' permission gate from `organizations:write` to `sso:admin`; ship a one-time backfill migration granting `sso:admin` to every role that currently holds `organizations:write`; ensure every provider mutation writes an audit event for visibility.

**Tech Stack:** Hono routes, Drizzle, hand-written SQL migrations, Vitest. Plan A is **Plan A of 2** from `docs/superpowers/specs/security-auth/2026-06-20-sso-domain-ownership-design.md` (Plan B — domain verification — is a separate plan, written after A lands).

## Global Constraints

- New permissions live in `packages/shared/src/constants/permissions.ts` (`PERMISSION_GRANTS`); the API's `PERMISSIONS`, `KNOWN_PERMISSIONS`, and `ASSIGNABLE_PERMISSIONS` derive from it automatically.
- `permissions` table has **no** unique constraint on `(resource, action)` — guard catalog inserts with `WHERE NOT EXISTS`, never `ON CONFLICT (resource, action)`.
- `role_permissions` has a composite PK `(role_id, permission_id)` — `ON CONFLICT (role_id, permission_id) DO NOTHING` is valid and is the idempotency mechanism.
- Wildcard (`*`,`*`) roles satisfy `requirePermission('sso','admin')` at check time via the wildcard, so the backfill only targets roles with an **explicit** `organizations:write` row.
- Migrations: idempotent, `YYYY-MM-DD-<slug>.sql`, sort after the current latest; no inner `BEGIN/COMMIT`; cleanup statements report row counts. Never edit a shipped migration.
- `@breeze/shared` has no build step — validate it with `pnpm --filter @breeze/shared typecheck`.
- Node: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

---

### Task 1: Add the `sso:admin` permission to the shared catalog

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (the `PERMISSION_GRANTS` object, near the `ORGS_*` block ~line 72-74)
- Test: `apps/api/src/services/permissions.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `PERMISSION_GRANTS.SSO_ADMIN = { resource: 'sso', action: 'admin' }`, consumed by Task 2/3 as `PERMISSIONS.SSO_ADMIN`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/services/permissions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PERMISSIONS, isAssignablePermission, isKnownPermission } from './permissions';

describe('sso:admin permission (security review #2 H-2)', () => {
  it('is defined in the catalog as resource=sso action=admin', () => {
    expect(PERMISSIONS.SSO_ADMIN).toEqual({ resource: 'sso', action: 'admin' });
  });

  it('is a known, assignable permission', () => {
    const p = { resource: 'sso', action: 'admin' };
    expect(isKnownPermission(p)).toBe(true);
    expect(isAssignablePermission(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/permissions.test.ts -t "sso:admin permission"`
Expected: FAIL — `PERMISSIONS.SSO_ADMIN` is `undefined`.

- [ ] **Step 3: Add the catalog entry**

In `packages/shared/src/constants/permissions.ts`, add after the `ORGS_DELETE` line:

```ts
  // SSO administration: configure providers + manage verified domains. A
  // higher-trust capability than organizations:write (security review #2 H-2).
  SSO_ADMIN: { resource: 'sso', action: 'admin' },
```

- [ ] **Step 4: Run test + shared typecheck to verify pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/permissions.test.ts -t "sso:admin permission"`
Expected: PASS.
Run: `cd /Users/toddhebebrand/breeze && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/permissions.ts apps/api/src/services/permissions.test.ts
git commit -m "feat(security): add sso:admin permission to the catalog (review #2 H-2)"
```

---

### Task 2: Gate the SSO provider routes on `sso:admin`

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — the four mutating provider routes' `requirePermission(...)` lines:
  - `POST /providers` (~line 428)
  - `PATCH /providers/:id` (~line 512)
  - `DELETE /providers/:id` (~line 573)
  - `POST /providers/:id/status` (~line 624)
  - `POST /providers/:id/test` (~line 675)
- Test: `apps/api/src/routes/sso.test.ts` (extend; `requirePermission` is already mocked there as a `vi.fn`)

**Interfaces:**
- Consumes: `PERMISSIONS.SSO_ADMIN` from Task 1.
- Produces: the five provider-mutation routes require `('sso','admin')`. (Read routes `GET /providers`, `GET /providers/:id` are unchanged.)

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/sso.test.ts`, add (the file already imports `requirePermission`-related mocks; import the symbol if not present: `import { requirePermission } from '../middleware/auth';`):

```ts
it('gates provider mutations on sso:admin, not organizations:write', () => {
  // requirePermission is a vi.fn mock; assert the route registered the sso:admin gate.
  expect(vi.mocked(requirePermission)).toHaveBeenCalledWith('sso', 'admin');
  // organizations:write must no longer gate provider create/update/activate.
  expect(vi.mocked(requirePermission)).not.toHaveBeenCalledWith('organizations', 'write');
});
```

(Note: `requirePermission` is invoked at module-load when routes register, so the calls are recorded once `./sso` is imported. If the existing mock is `vi.fn((res, act) => async (c, next) => ...)`, calls record `(res, act)`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/sso.test.ts -t "gates provider mutations on sso:admin"`
Expected: FAIL — routes still call `requirePermission('organizations','write')`.

- [ ] **Step 3: Swap the guard on all five routes**

In `apps/api/src/routes/sso.ts`, replace each of the five occurrences:

```ts
requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
```

with:

```ts
requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
```

(Leave the `GET /providers` and `GET /providers/:id` read routes untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/sso.test.ts --no-file-parallelism`
Expected: PASS — the new assertion passes and all existing SSO route tests still pass (they assert behavior through the mocked permission gate, which is unaffected by the resource/action values).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(security): gate SSO provider routes on sso:admin (review #2 H-2)"
```

---

### Task 3: Backfill `sso:admin` to existing `organizations:write` roles

**Files:**
- Create: `apps/api/migrations/2026-06-25-sso-admin-permission-backfill.sql` (date must sort after the current latest migration; if a later-dated migration exists, bump the date accordingly)
- Test: `apps/api/src/__tests__/integration/ssoAdminBackfill.integration.test.ts`

**Interfaces:**
- Consumes: the `permissions` and `role_permissions` tables; the `(organizations, write)` catalog row convention.
- Produces: a `(sso, admin)` catalog row; a `role_permissions` grant for every role holding `(organizations, write)`.

- [ ] **Step 1: Write the failing test**

The backfill is a one-time data migration, so the test exercises the **backfill SQL logic directly** against a freshly-seeded role (it does not rely on autoMigrate's one-time application). Create `apps/api/src/__tests__/integration/ssoAdminBackfill.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createRole, grantRolePermissions } from './db-utils';

// The exact backfill statements from the migration, run here against a seeded
// role so we validate the SQL logic (and its idempotency) independent of when
// autoMigrate applied the real one-time migration.
const ENSURE_PERMISSION = sql`
  INSERT INTO permissions (resource, action, description)
  SELECT 'sso', 'admin', 'Manage SSO providers and verified domains'
  WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'sso' AND action = 'admin');
`;
const BACKFILL = sql`
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, s.id
  FROM role_permissions rp
  JOIN permissions w ON w.id = rp.permission_id AND w.resource = 'organizations' AND w.action = 'write'
  CROSS JOIN (SELECT id FROM permissions WHERE resource = 'sso' AND action = 'admin' LIMIT 1) s
  ON CONFLICT (role_id, permission_id) DO NOTHING;
`;

async function roleHasSsoAdmin(db: ReturnType<typeof getTestDb>, roleId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ${roleId} AND p.resource = 'sso' AND p.action = 'admin' LIMIT 1;
  `);
  return (rows as unknown as unknown[]).length > 0;
}

describe('sso:admin backfill migration', () => {
  it('grants sso:admin to a role with organizations:write, and not to one without', async () => {
    const db = getTestDb();
    const partner = await createPartner({});
    const writeRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(writeRole.id, [{ resource: 'organizations', action: 'write' }]);
    const otherRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(otherRole.id, [{ resource: 'devices', action: 'read' }]);

    await db.execute(ENSURE_PERMISSION);
    await db.execute(BACKFILL);

    expect(await roleHasSsoAdmin(db, writeRole.id)).toBe(true);
    expect(await roleHasSsoAdmin(db, otherRole.id)).toBe(false);
  });

  it('is idempotent on re-run', async () => {
    const db = getTestDb();
    const partner = await createPartner({});
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: 'organizations', action: 'write' }]);

    await db.execute(ENSURE_PERMISSION);
    await db.execute(BACKFILL);
    await db.execute(ENSURE_PERMISSION);
    await db.execute(BACKFILL); // second run must not throw or duplicate

    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ${role.id} AND p.resource = 'sso' AND p.action = 'admin';
    `);
    expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ssoAdminBackfill.integration.test.ts`
Expected: FAIL — the migration file doesn't exist yet, but more importantly run it AFTER writing the migration; if run first it may pass against an existing `sso:admin` row from a prior task. (This test validates the SQL that the migration will contain — write the migration in Step 3, then this test confirms the SQL is correct and idempotent. The "failing" state is: without the migration's SQL, a plain `createRole`+`organizations:write` role has no `sso:admin` — assert that precondition in the test if desired.)

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-06-25-sso-admin-permission-backfill.sql`:

```sql
-- Security review #2 (H-2): introduce sso:admin and backfill it to every role
-- that currently holds organizations:write, so no existing SSO admin loses the
-- ability to configure providers when the gate moves from orgs:write to
-- sso:admin. Wildcard ('*','*') roles satisfy sso:admin at check time, so they
-- need no row here. Idempotent.

-- 1. Ensure the sso:admin catalog row exists exactly once (permissions has no
--    unique(resource,action), so guard with WHERE NOT EXISTS).
INSERT INTO permissions (resource, action, description)
SELECT 'sso', 'admin', 'Manage SSO providers and verified domains'
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'sso' AND action = 'admin');

-- 2. Grant sso:admin to every role with an explicit organizations:write row.
--    Report the count for the forensic trail.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, s.id
  FROM role_permissions rp
  JOIN permissions w ON w.id = rp.permission_id AND w.resource = 'organizations' AND w.action = 'write'
  CROSS JOIN (SELECT id FROM permissions WHERE resource = 'sso' AND action = 'admin' LIMIT 1) s
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'sso:admin backfill granted % role(s)', n;
END $$;
```

- [ ] **Step 4: Run test + migration-ordering test to verify pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ssoAdminBackfill.integration.test.ts`
Expected: PASS (both cases).
Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/db/autoMigrate.test.ts`
Expected: PASS (filename sorts correctly, idempotency preserved).

- [ ] **Step 5: Verify drift + commit**

Run: `cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift (the migration adds no schema objects — data-only backfill).

```bash
git add apps/api/migrations/2026-06-25-sso-admin-permission-backfill.sql apps/api/src/__tests__/integration/ssoAdminBackfill.integration.test.ts
git commit -m "feat(security): backfill sso:admin to organizations:write roles (review #2 H-2)"
```

---

### Task 4: Audit every provider mutation (visibility)

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — confirm/add `writeRouteAudit(...)` on `POST /providers`, `PATCH /providers/:id`, `POST /providers/:id/status` (create/update already call it; ensure the status route does, with action `sso.provider.status_change`).
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: `writeRouteAudit(c, { orgId, action, resourceType, resourceId, ... })` from `services/auditEvents.ts`.
- Produces: an audit row on every provider mutation (`sso.provider.create` / `.update` / `.status_change`).

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/sso.test.ts`, add a case for the status route (mock `writeRouteAudit` or assert via the existing audit mock; mirror the create-route audit assertion already in the file):

```ts
it('writes an audit event when a provider status changes', async () => {
  // ...wire a valid /providers/:id/status request (reuse existing helpers)...
  expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'sso.provider.status_change', resourceType: 'sso_provider' }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/sso.test.ts -t "audit event when a provider status changes"`
Expected: FAIL if the status route doesn't yet emit that exact action.

- [ ] **Step 3: Add the audit call**

In the `POST /providers/:id/status` handler in `apps/api/src/routes/sso.ts`, after the status update succeeds, add:

```ts
writeRouteAudit(c, {
  orgId: updated.orgId,
  action: 'sso.provider.status_change',
  resourceType: 'sso_provider',
  resourceId: updated.id,
  resourceName: updated.name,
  details: { status: updated.status },
});
```

(Confirm the create handler emits `sso.provider.create` and update emits `sso.provider.update` — they already do; no change needed if so.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/sso.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(security): audit SSO provider status changes (review #2 H-2)"
```

---

## Deferred from this plan (explicit)

- **Email / in-app notification of SSO config changes to org admins.** The spec called for "audit + notify"; this plan delivers the **audit** half (concrete, tested). There is no clean general "notify org admins of a security event" helper today (the notification dispatcher is alert-specific), so building the notify path would mean a speculative audience-enumeration + template task. Deferred to its own small plan/PR once a general admin-notification helper exists. The visibility requirement is met by the audit trail in the interim.
- **Domain verification** (the `sso_verified_domains` table, DNS-TXT flow, callback enforcement, re-check job, admin UI) — that is **Plan B**, a separate plan written after Plan A lands.

## Self-Review

- **Spec coverage:** Plan A maps to the spec's "Plan A — `sso:admin` permission & gating" section in full (permission, route gating, backfill, audit). The notify half is explicitly deferred with rationale above. Domain verification is Plan B (out of scope here, by design).
- **Placeholders:** none — every code/SQL step shows the actual content.
- **Type consistency:** `PERMISSIONS.SSO_ADMIN` (Task 1) is the symbol used in Task 2; audit action strings (`sso.provider.create|update|status_change`) are consistent; backfill SQL in the test (Task 3 Step 1) matches the migration (Step 3) verbatim.
