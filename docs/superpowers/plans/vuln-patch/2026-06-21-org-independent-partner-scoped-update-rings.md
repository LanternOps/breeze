# Org-Independent (Partner-Scoped) Update Rings & Approvals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make update rings (`patch_policies`) and patch approvals (`patch_approvals`) partner-scoped instead of org-scoped, so a single ring + its approval decisions flow to every org the ring is assigned to via configuration policies.

**Architecture:** Drop `org_id` from both tables, add `partner_id NOT NULL`, switch RLS from org-axis (`breeze_has_org_access`) to partner-axis (`breeze_has_partner_access`). Approvals are keyed `(partner_id, patch_id, COALESCE(ring_id, NIL))`: ring-specific or partner-wide blanket. Ring/approval management becomes partner/system scope only; org-scoped users keep read-only Compliance/Patches. `patch_jobs`, `patch_compliance_snapshots`, `device_patches`, `patches` are unchanged.

**Tech Stack:** PostgreSQL + Drizzle ORM, Hono routes, Vitest (unit + RLS + integration), Astro/React web, hand-written idempotent SQL migrations.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-06-21-org-independent-partner-scoped-update-rings-design.md`

## Global Constraints

- **Migration naming:** `YYYY-MM-DD-[a-z-]*.sql`, applied in `localeCompare` (lexicographic) order. Latest existing file is `2026-06-26-sso-verified-domains.sql`, so new migrations MUST sort after it — use prefix **`2026-06-27-`** with `-a-`/`-b-` infixes for same-day ordering. Verify ordering passes `apps/api/src/db/autoMigrate.test.ts`.
- **Migrations are idempotent:** `ADD COLUMN IF NOT EXISTS`, `DROP ... IF EXISTS`, `DROP POLICY IF EXISTS` then `CREATE POLICY`, `CREATE UNIQUE INDEX IF NOT EXISTS`. Re-applying is a no-op. **Never** add inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction). **Never** edit a shipped migration.
- **Cleanup statements report row counts:** any UPDATE/DELETE that fixes data must wrap in `DO $$ ... GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING '...', n; END IF; END $$;`.
- **NIL_UUID** sentinel: `'00000000-0000-0000-0000-000000000000'`.
- **RLS verification:** after each schema migration, verify as `breeze_app` that a cross-partner forge insert fails with `new row violates row-level security policy`.
- **Node:** prefix tooling with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Fresh worktree needs `pnpm install`.
- **Real-DB tests** go in `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING integration-test job; unit `test-api` has no DATABASE_URL and skips real-DB cases vacuously).

---

## File Structure

**Backend schema/migrations:**
- `apps/api/src/db/schema/patches.ts` — Drizzle: swap `orgId`→`partnerId` on `patchPolicies` + `patchApprovals`; rewrite the approvals unique index.
- `apps/api/migrations/2026-06-27-a-update-rings-partner-scope.sql` — rings migration (new).
- `apps/api/migrations/2026-06-27-b-patch-approvals-partner-scope.sql` — approvals migration (new).

**Backend routes/services:**
- `apps/api/src/routes/updateRings.ts` — partner resolution + scope gate.
- `apps/api/src/routes/patches/helpers.ts` — `upsertPatchApproval` + partner resolution.
- `apps/api/src/routes/patches/approvals.ts` — approve/decline/defer/bulk handlers.
- `apps/api/src/services/patchApprovalEvaluator.ts` — partner-scoped approval reads + cross-partner ring guard.
- `apps/api/src/services/aiToolsPolicyPrereqs.ts` — `manage_update_rings` + partner helpers.
- `apps/api/src/services/tenantCascade.ts` — move both tables to partner cascade.
- `packages/shared/src/validators/index.ts` — ring/approval validator partner field.

**Tests:**
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist + forge.
- `apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts` — new functional test (routes + dedup).

**Web:**
- `apps/web/src/components/patches/PatchesPage.tsx` — scope-aware tab/button gating.
- `apps/web/src/components/patches/PatchApprovalModal.tsx` — partner-wide approval gating.
- `apps/web/src/components/patches/UpdateRingForm.tsx` — drop all-orgs block.

---

## Task 1: Drizzle schema — partner-scope `patchPolicies` and `patchApprovals`

**Files:**
- Modify: `apps/api/src/db/schema/patches.ts:142-191`

**Interfaces:**
- Produces: `patchPolicies.partnerId`, `patchApprovals.partnerId` (uuid NOT NULL → `partners.id`); approvals unique index `patch_approvals_partner_patch_ring_unique` on `(partnerId, patchId, COALESCE(ringId, NIL))`.

- [ ] **Step 1: Add the `partners` import**

In `apps/api/src/db/schema/patches.ts`, the import block (lines 16-19) currently imports `organizations`, `devices`, `users`, `scripts`. Add `partners`:

```typescript
import { organizations } from './orgs';
import { partners } from './partners';
import { devices } from './devices';
import { users } from './users';
import { scripts } from './scripts';
```

> Verify the partners schema path: run `ls apps/api/src/db/schema/ | grep -i partner`. If the file is `partners.ts` the import above is correct; if `orgs.ts` re-exports `partners`, import it from there instead.

- [ ] **Step 2: Swap `orgId`→`partnerId` on `patchPolicies`**

Replace line 144 (`orgId: uuid('org_id').notNull().references(() => organizations.id),`) with:

```typescript
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
```

- [ ] **Step 3: Swap `orgId`→`partnerId` and rewrite the unique index on `patchApprovals`**

Replace `orgId: uuid('org_id').notNull().references(() => organizations.id),` (line 173) with:

```typescript
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
```

Replace the `(table) => ({ ... })` index block (lines 185-191) with:

```typescript
}, (table) => ({
  // Partner-scoped: one approval per (partner, patch, ring). NULL ring = partner-wide blanket.
  partnerPatchRingUnique: uniqueIndex('patch_approvals_partner_patch_ring_unique').on(
    table.partnerId,
    table.patchId,
    sql`COALESCE(${table.ringId}, '00000000-0000-0000-0000-000000000000')`
  )
}));
```

- [ ] **Step 4: Typecheck the schema package**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS, OR only errors in `updateRings.ts` / `approvals.ts` / `aiToolsPolicyPrereqs.ts` / `patchApprovalEvaluator.ts` referencing `.orgId` on these tables (those are fixed in later tasks). No error in `patches.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/patches.ts
git commit -m "refactor(patches): partner-scope patch_policies & patch_approvals schema"
```

---

## Task 2: Migration — `patch_policies` → partner scope

**Files:**
- Create: `apps/api/migrations/2026-06-27-a-update-rings-partner-scope.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (ordering regression — no edit, just run)

**Interfaces:**
- Consumes: `organizations.partner_id` for backfill; `breeze_has_partner_access(partner_id)` function (exists since `2026-04-11-partners-rls.sql`).
- Produces: `patch_policies.partner_id NOT NULL`, partner-axis RLS, no `org_id`.

- [ ] **Step 1: Write the migration file**

Create `apps/api/migrations/2026-06-27-a-update-rings-partner-scope.sql`:

```sql
-- Make update rings (patch_policies) partner-scoped instead of org-scoped.
-- Rings reach orgs only via configuration-policy assignment, so the org binding
-- is dropped in favour of partner ownership. Idempotent + forward-only.

-- 1. Add partner_id (nullable first for backfill).
ALTER TABLE patch_policies ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- 2. Backfill partner_id from each ring's org.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE patch_policies p
     SET partner_id = o.partner_id
    FROM organizations o
   WHERE p.org_id = o.id
     AND p.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'patch_policies partner backfill: % rows', n; END IF;
END $$;

-- 3. Enforce NOT NULL once backfilled.
ALTER TABLE patch_policies ALTER COLUMN partner_id SET NOT NULL;

-- 4. Drop the old org-axis RLS policies.
DROP POLICY IF EXISTS breeze_org_isolation_select ON patch_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON patch_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON patch_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON patch_policies;

-- 5. Drop org_id (FK + column).
ALTER TABLE patch_policies DROP COLUMN IF EXISTS org_id;

-- 6. Partner-axis RLS.
ALTER TABLE patch_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON patch_policies;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON patch_policies;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON patch_policies;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON patch_policies;
CREATE POLICY breeze_partner_isolation_select ON patch_policies
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON patch_policies
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON patch_policies
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON patch_policies
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 7. Index for partner-filtered list queries.
CREATE INDEX IF NOT EXISTS patch_policies_partner_id_idx ON patch_policies (partner_id);
```

- [ ] **Step 2: Apply migrations against an empty Postgres and verify ordering**

Run the migration ordering regression + a fresh-DB apply (this catches sort-order bugs and SQL errors):

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
```

Expected: PASS (the new file sorts last after `2026-06-26-*`).

- [ ] **Step 3: Apply to the local dev DB and forge-verify as breeze_app**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx -e "import('./src/db/autoMigrate').then(m=>m.autoMigrate()).then(()=>process.exit(0))"
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO patch_policies (partner_id, kind, name) VALUES (gen_random_uuid(), 'ring', 'forge');"
```

Expected: the INSERT fails with `new row violates row-level security policy for table "patch_policies"` (breeze_app has no partner access in a bare psql session).

- [ ] **Step 4: Verify no schema drift**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift`
Expected: no drift between `patches.ts` and the migrated DB.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-27-a-update-rings-partner-scope.sql
git commit -m "feat(db): partner-scope patch_policies migration"
```

---

## Task 3: Migration — `patch_approvals` → partner scope (with dedup)

**Files:**
- Create: `apps/api/migrations/2026-06-27-b-patch-approvals-partner-scope.sql`

**Interfaces:**
- Consumes: `organizations.partner_id`; existing unique index `patch_approvals_org_patch_ring_unique`.
- Produces: `patch_approvals.partner_id NOT NULL`; unique index `patch_approvals_partner_patch_ring_unique`; partner-axis RLS.

- [ ] **Step 1: Write the migration file**

Create `apps/api/migrations/2026-06-27-b-patch-approvals-partner-scope.sql`:

```sql
-- Make patch_approvals partner-scoped. A ring-specific row (ring_id set) approves
-- that ring everywhere; a ring_id IS NULL row is a partner-wide blanket approval.
-- Idempotent + forward-only.

-- 1. Add partner_id (nullable first).
ALTER TABLE patch_approvals ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- 2. Backfill partner_id from each approval's org.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE patch_approvals a
     SET partner_id = o.partner_id
    FROM organizations o
   WHERE a.org_id = o.id
     AND a.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'patch_approvals partner backfill: % rows', n; END IF;
END $$;

-- 3. Dedup collisions BEFORE the new unique index. Two orgs under one partner can
-- both hold a (patch, ring) approval that now collapses onto the same partner key.
-- Keep one deterministic winner per (partner_id, patch_id, COALESCE(ring_id,NIL)):
-- status precedence approved>deferred>rejected>pending, then latest updated_at,
-- then latest id. Delete the losers and report the count (forensic trail).
DO $$
DECLARE n bigint;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY partner_id, patch_id, COALESCE(ring_id, '00000000-0000-0000-0000-000000000000')
             ORDER BY CASE status
                        WHEN 'approved' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'rejected' THEN 2
                        ELSE 3
                      END,
                      updated_at DESC,
                      id DESC
           ) AS rn
      FROM patch_approvals
  )
  DELETE FROM patch_approvals WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'patch_approvals dedup on partner-scope: % duplicate rows removed', n; END IF;
END $$;

-- 4. Swap the unique index org->partner.
DROP INDEX IF EXISTS patch_approvals_org_patch_ring_unique;
CREATE UNIQUE INDEX IF NOT EXISTS patch_approvals_partner_patch_ring_unique
  ON patch_approvals (partner_id, patch_id, COALESCE(ring_id, '00000000-0000-0000-0000-000000000000'));

-- 5. Drop old org-axis RLS policies.
DROP POLICY IF EXISTS breeze_org_isolation_select ON patch_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON patch_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_update ON patch_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON patch_approvals;

-- 6. Enforce NOT NULL, drop org_id.
ALTER TABLE patch_approvals ALTER COLUMN partner_id SET NOT NULL;
ALTER TABLE patch_approvals DROP COLUMN IF EXISTS org_id;

-- 7. Partner-axis RLS.
ALTER TABLE patch_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON patch_approvals;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON patch_approvals;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON patch_approvals;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON patch_approvals;
CREATE POLICY breeze_partner_isolation_select ON patch_approvals
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON patch_approvals
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON patch_approvals
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON patch_approvals
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

CREATE INDEX IF NOT EXISTS patch_approvals_partner_id_idx ON patch_approvals (partner_id);
```

- [ ] **Step 2: Apply + verify ordering**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (the `-b-` file sorts after the `-a-` file).

- [ ] **Step 3: Apply to dev DB + forge-verify**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx -e "import('./src/db/autoMigrate').then(m=>m.autoMigrate()).then(()=>process.exit(0))"
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO patch_approvals (partner_id, patch_id, status) VALUES (gen_random_uuid(), gen_random_uuid(), 'approved');"
```

Expected: fails with `new row violates row-level security policy for table "patch_approvals"`.

- [ ] **Step 4: Drift check + commit**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
git add apps/api/migrations/2026-06-27-b-patch-approvals-partner-scope.sql
git commit -m "feat(db): partner-scope patch_approvals migration with dedup"
```

---

## Task 4: RLS coverage allowlist + partner forge test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (PARTNER_TENANT_TABLES map)
- Create: `apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts`

**Interfaces:**
- Consumes: `withSystemDbAccessContext`, `withDbAccessContext`, `partners`, `organizations`, `patchPolicies`, `patchApprovals`, `patches` from db/schema.

- [ ] **Step 1: Add both tables to the partner allowlist**

In `rls-coverage.integration.test.ts`, the `PARTNER_TENANT_TABLES` map (around lines 112-167), add two entries (keep them grouped with the other patch entries / alphabetical as the file does):

```typescript
  ['patch_policies', 'partner_id'],
  ['patch_approvals', 'partner_id'],
```

> These tables no longer have `org_id`, so they automatically drop out of org auto-discovery — no `ORG_AXIS_POLICY_EXCLUDED_TABLES` entry is needed.

- [ ] **Step 2: Run the RLS coverage contract test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run -c vitest.config.rls-coverage.ts`
Expected: PASS — `patch_policies` and `patch_approvals` are recognised as partner-axis; no "missing policy" failure.

- [ ] **Step 3: Write the failing forge test**

Create `apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts`. Model it on the existing `scripts` partner-forge block. Re-seed fixtures per the file's conventions (avoid module-scope memoization — `beforeEach` TRUNCATE wipes them):

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { withSystemDbAccessContext, withDbAccessContext } from '../../db';
import { partners } from '../../db/schema/partners';
import { organizations } from '../../db/schema/orgs';
import { patchPolicies } from '../../db/schema/patches';

const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function partnerContext(partnerId: string) {
  return { scope: 'partner' as const, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null };
}

describe('patch_policies RLS — partner isolation forge', () => {
  let partnerAId: string;
  let partnerBId: string;
  let ringAId: string | null = null;

  async function ensureFixtures(): Promise<void> {
    if (partnerAId) return;
    await withSystemDbAccessContext(async () => {
      const seeded = await db.insert(partners).values([
        { name: `Ring A ${runSuffix}`, slug: `ring-a-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
        { name: `Ring B ${runSuffix}`, slug: `ring-b-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
      ]).returning({ id: partners.id });
      partnerAId = seeded[0]!.id;
      partnerBId = seeded[1]!.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (ringAId) await db.delete(patchPolicies).where(eq(patchPolicies.id, ringAId!));
      if (partnerAId) await db.delete(partners).where(eq(partners.id, partnerAId));
      if (partnerBId) await db.delete(partners).where(eq(partners.id, partnerBId));
    });
  });

  it('partner A can INSERT and SELECT its own ring', async () => {
    await ensureFixtures();
    const inserted = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.insert(patchPolicies).values({ partnerId: partnerAId, kind: 'ring', name: `forge-${runSuffix}` })
        .returning({ id: patchPolicies.id })
    );
    expect(inserted).toHaveLength(1);
    ringAId = inserted[0]!.id;
    const visible = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ringAId!))
    );
    expect(visible.map((r) => r.id)).toEqual([ringAId]);
  });

  it('partner B cannot SELECT partner A ring', async () => {
    await ensureFixtures();
    if (!ringAId) throw new Error('seed test must run first');
    const visibleToB = await withDbAccessContext(partnerContext(partnerBId), async () =>
      db.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ringAId!))
    );
    expect(visibleToB).toEqual([]);
  });

  it('partner B INSERT forging partner A partner_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(partnerBId), async () =>
        db.insert(patchPolicies).values({ partnerId: partnerAId, kind: 'ring', name: `forge-x-${runSuffix}` })
      );
    } catch (err) { caught = err; }
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "patch_policies"/);
  });
});
```

- [ ] **Step 4: Run the forge test (expect FAIL first only if schema not applied, else PASS)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run src/__tests__/integration/update-rings-partner-scope.integration.test.ts`
Expected: PASS (schema + migrations from Tasks 1-3 are applied). If the partners insert errors on a missing column (e.g. `slug`/`type`/`plan`), adjust the seed to match the actual `partners` schema columns first.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts
git commit -m "test(rls): partner-axis coverage + forge for patch rings/approvals"
```

---

## Task 5: `updateRings.ts` — partner resolution + scope gate

**Files:**
- Modify: `apps/api/src/routes/updateRings.ts`

**Interfaces:**
- Produces: `resolvePartnerId(auth, requestedPartnerId?)` and `resolveListPartnerIds(auth, requestedPartnerId?)` local helpers (mirror the existing `resolveOrgId`/`resolveListOrgIds`); all `/update-rings` routes filter on `patchPolicies.partnerId`.

- [ ] **Step 1: Add partner resolution helpers**

Below the existing `resolveListOrgIds` (ends ~line 82), add:

```typescript
function resolvePartnerId(
  auth: { scope: 'system' | 'partner' | 'organization'; partnerId: string | null },
  requestedPartnerId?: string
): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    return { error: 'Update rings are managed at partner scope', status: 403 };
  }
  if (requestedPartnerId) {
    if (auth.scope === 'partner' && auth.partnerId !== requestedPartnerId) {
      return { error: 'Access denied to this partner', status: 403 };
    }
    return { partnerId: requestedPartnerId };
  }
  if (auth.partnerId) return { partnerId: auth.partnerId };
  return { error: 'partnerId is required', status: 400 };
}

function resolveListPartnerIds(
  auth: { scope: 'system' | 'partner' | 'organization'; partnerId: string | null },
  requestedPartnerId?: string
): { partnerIds: string[] | null } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    return { error: 'Update rings are managed at partner scope', status: 403 };
  }
  if (requestedPartnerId) {
    if (auth.scope === 'partner' && auth.partnerId !== requestedPartnerId) {
      return { error: 'Access denied to this partner', status: 403 };
    }
    return { partnerIds: [requestedPartnerId] };
  }
  if (auth.partnerId) return { partnerIds: [auth.partnerId] };
  if (auth.scope === 'system') return { partnerIds: null }; // all partners
  return { error: 'partnerId is required', status: 400 };
}
```

- [ ] **Step 2: Replace `orgId` with `partnerId` in the zod schemas**

In `createRingSchema` (line 146) replace `orgId: z.string().guid().optional(),` with `partnerId: z.string().guid().optional(),`. In `listRingsSchema` (lines 134-136) replace `orgId` with `partnerId` likewise. (`updateRingSchema` has no org field — leave it.)

- [ ] **Step 3: Gate routes to partner/system scope**

In every `updateRingRoutes.<verb>(...)` definition, change `requireScope('organization', 'partner', 'system')` to:

```typescript
  requireScope('partner', 'system'),
```

(There are seven routes: POST `/`, GET `/`, GET `/:id`, PATCH `/:id`, DELETE `/:id`, GET `/:id/patches`, GET `/:id/compliance` — apply to all.)

- [ ] **Step 4: Rewrite the POST `/` create handler partner resolution + insert**

Replace the org resolution + insert (lines 273-296) so it resolves partner and inserts `partnerId`:

```typescript
    const partnerResult = resolvePartnerId(auth, data.partnerId ?? c.req.query('partnerId'));
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);
    const { partnerId } = partnerResult;

    const [ring] = await db
      .insert(patchPolicies)
      .values({
        partnerId,
        kind: 'ring',
        name: data.name,
        description: data.description ?? null,
        enabled: data.enabled ?? true,
        ringOrder: data.ringOrder ?? 0,
        deferralDays: data.deferralDays ?? 0,
        deadlineDays: data.deadlineDays ?? null,
        gracePeriodHours: data.gracePeriodHours ?? 4,
        categories: data.categories ?? [],
        excludeCategories: data.excludeCategories ?? [],
        sources: data.sources ?? null,
        autoApprove: data.autoApprove ?? DEFAULT_RING_AUTO_APPROVE,
        categoryRules: data.categoryRules ?? [],
        targets: data.targets ?? {},
        createdBy: auth.user.id,
      })
      .returning();
```

Then update the `writeRouteAudit` call in this handler: replace `orgId,` with `partnerId,` (the audit helper accepts a partner context; if `writeRouteAudit` requires an `orgId`, pass `orgId: null` and add `partnerId` — check the helper signature and match it).

- [ ] **Step 5: Replace `canAccessOrg(ring.orgId)` access checks in GET/PATCH/DELETE/:id/patches/:id/compliance**

In each `/:id*` handler, the pattern `if (!auth.canAccessOrg(ring.orgId)) return c.json({ error: 'Access denied' }, 403);` becomes a partner check. Since `auth` has no `canAccessPartner`, inline it:

```typescript
    if (auth.scope !== 'system' && auth.partnerId !== ring.partnerId) {
      return c.json({ error: 'Access denied' }, 403);
    }
```

- [ ] **Step 6: Replace the LIST handler org filtering**

In GET `/` replace the `resolveListOrgIds` usage + `eq(patchPolicies.orgId, ...)`/`inArray(patchPolicies.orgId, ...)` with `resolveListPartnerIds` and partner filtering:

```typescript
    const listResult = resolveListPartnerIds(auth, c.req.query('partnerId'));
    if ('error' in listResult) return c.json({ error: listResult.error }, listResult.status);
    const { partnerIds } = listResult;
    const partnerCond = partnerIds === null
      ? undefined
      : partnerIds.length === 1
        ? eq(patchPolicies.partnerId, partnerIds[0]!)
        : inArray(patchPolicies.partnerId, partnerIds);
```

Use `partnerCond` where the old org condition was applied (combine with the existing `eq(patchPolicies.kind, 'ring')` via `and(...)`, dropping `undefined` conditions).

- [ ] **Step 7: Fix the `:id/patches` and `:id/compliance` approval reads**

In those two handlers, the approval subquery filters `eq(patchApprovals.orgId, ring.orgId)`. Replace with `eq(patchApprovals.partnerId, ring.partnerId)`. The device-scoping in `:id/compliance` (`eq(devices.orgId, ring.orgId)`) is no longer valid — a partner ring spans many orgs. Replace device resolution with the config-policy-assignment-based device set already used by `resolveRingDeviceCounts` in `updateRingsHelpers.ts` (call/extend that helper to return device ids for the ring), and read approvals by `(partnerId, ringId)`.

> If reworking `:id/compliance` device resolution is large, split it into its own follow-up task; the route may temporarily return compliance across the ring's assigned devices via `resolveRingDeviceCounts`. Do NOT leave an `eq(devices.orgId, ring.partnerId)` type bug.

- [ ] **Step 8: Typecheck + run updateRings tests**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/updateRings.test.ts
```

Expected: typecheck clean for `updateRings.ts`; existing route tests updated/passing (update any test asserting org behavior to partner behavior).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/updateRings.ts apps/api/src/routes/updateRingsHelpers.ts
git commit -m "feat(update-rings): partner-scope routes, gate to partner/system"
```

---

## Task 6: Approval routes + `upsertPatchApproval` → partner

**Files:**
- Modify: `apps/api/src/routes/patches/helpers.ts`
- Modify: `apps/api/src/routes/patches/approvals.ts`

**Interfaces:**
- Produces: `upsertPatchApproval({ partnerId, patchId, ringId, ... })`; `resolvePatchApprovalPartnerIdForRing(auth, requestedPartnerId?, ringId?)`.

- [ ] **Step 1: Rewrite `upsertPatchApproval` to key on partner**

In `helpers.ts`, change the `values.orgId` parameter to `partnerId`, the INSERT column list `org_id`→`partner_id`, the bound `${values.orgId}`→`${values.partnerId}`, and the `ON CONFLICT (org_id, patch_id, COALESCE(ring_id, ${NIL_UUID}::uuid))` to `ON CONFLICT (partner_id, patch_id, COALESCE(ring_id, ${NIL_UUID}::uuid))`:

```typescript
export async function upsertPatchApproval(values: {
  partnerId: string;
  patchId: string;
  ringId: string | null;
  status: 'approved' | 'rejected' | 'deferred' | 'pending';
  approvedBy?: string | null;
  approvedAt?: Date | null;
  deferUntil?: Date | null;
  notes?: string | null;
}) {
  const approvedAtIso = values.approvedAt ? values.approvedAt.toISOString() : null;
  const deferUntilIso = values.deferUntil ? values.deferUntil.toISOString() : null;
  await db.execute(sql`
    INSERT INTO patch_approvals (id, partner_id, patch_id, ring_id, status, approved_by, approved_at, defer_until, notes, created_at, updated_at)
    VALUES (
      gen_random_uuid(), ${values.partnerId}, ${values.patchId}, ${values.ringId}, ${values.status},
      ${values.approvedBy ?? null}, ${approvedAtIso}, ${deferUntilIso}, ${values.notes ?? null}, NOW(), NOW()
    )
    ON CONFLICT (partner_id, patch_id, COALESCE(ring_id, ${NIL_UUID}::uuid))
    DO UPDATE SET
      status = EXCLUDED.status, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
      defer_until = EXCLUDED.defer_until, notes = EXCLUDED.notes, updated_at = NOW()
  `);
}
```

- [ ] **Step 2: Replace `resolvePatchApprovalOrgIdForRing` with a partner resolver**

Replace `resolvePatchApprovalOrgIdForRing` (and the `resolvePatchApprovalOrgId` it falls back to) with:

```typescript
export async function resolvePatchApprovalPartnerIdForRing(
  auth: { scope: 'system' | 'partner' | 'organization'; partnerId: string | null },
  requestedPartnerId?: string,
  ringId?: string | null
): Promise<{ partnerId: string } | { error: string; status: 400 | 403 | 404 }> {
  if (auth.scope === 'organization') {
    return { error: 'Patch approvals are managed at partner scope', status: 403 };
  }
  if (ringId) {
    const [ring] = await db
      .select({ partnerId: patchPolicies.partnerId })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, ringId))
      .limit(1);
    if (!ring) return { error: 'Update ring not found', status: 404 };
    if (auth.scope !== 'system' && auth.partnerId !== ring.partnerId) {
      return { error: 'Access denied to this update ring', status: 403 };
    }
    return { partnerId: ring.partnerId };
  }
  if (requestedPartnerId) {
    if (auth.scope === 'partner' && auth.partnerId !== requestedPartnerId) {
      return { error: 'Access denied to this partner', status: 403 };
    }
    return { partnerId: requestedPartnerId };
  }
  if (auth.partnerId) return { partnerId: auth.partnerId };
  return { error: 'partnerId is required', status: 400 };
}
```

- [ ] **Step 3: Update approve/decline/defer/bulk handlers in `approvals.ts`**

For each handler (`/:id/approve`, `/:id/decline`, `/:id/defer`, `/bulk-approve`, and GET `/approvals`):
- Change `requireScope('organization', 'partner', 'system')` → `requireScope('partner', 'system')`.
- Replace the `resolvePatchApprovalOrgIdForRing(auth, data.orgId ?? c.req.query('orgId') ?? undefined, data.ringId ?? null)` call with `resolvePatchApprovalPartnerIdForRing(auth, data.partnerId ?? c.req.query('partnerId') ?? undefined, data.ringId ?? null)` and rename `targetOrgId`→`targetPartnerId`.
- In each `upsertPatchApproval({ ... })` call, replace `orgId: targetOrgId,` with `partnerId: targetPartnerId,`.
- In each `writeRouteAudit({ orgId: targetOrgId, ... })`, replace with the partner-aware audit context (`partnerId: targetPartnerId`, `orgId: null` if required by the helper).
- In GET `/approvals`, replace the `eq(patchApprovals.orgId, ...)` list filter with `eq(patchApprovals.partnerId, targetPartnerId)`.

- [ ] **Step 4: Update the approval zod schemas**

In the approval validators (`approvalActionSchema` and the list-approvals query schema in `approvals.ts`), replace any `orgId: z.string().guid().optional()` with `partnerId: z.string().guid().optional()`. Keep `ringId` as-is.

- [ ] **Step 5: Typecheck + tests**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/patches
```

Expected: clean; update existing approval route tests from org to partner assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/patches/helpers.ts apps/api/src/routes/patches/approvals.ts
git commit -m "feat(patches): partner-scope approval upsert + routes"
```

---

## Task 7: `patchApprovalEvaluator.ts` — partner reads + cross-partner ring guard

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`

**Interfaces:**
- Consumes: `organizations.partnerId`.
- Produces: `resolveApprovedPatchesForDevice(deviceId, orgId, ringConfig)` unchanged signature, but manual-approval read is partner-scoped (partner derived from `orgId`), and a ring whose `partnerId` ≠ the device-org's partner is ignored (treated as no ring).

- [ ] **Step 1: Resolve the device-org's partner inside the function**

Near the top of `resolveApprovedPatchesForDevice` (after `orgId` is available), add a single lookup:

```typescript
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = orgRow?.partnerId ?? null;
  if (!partnerId) return []; // org without a partner cannot have approvals
```

- [ ] **Step 2: Switch the manual-approval query to partner**

Replace the manual approvals query (lines 301-316) `eq(patchApprovals.orgId, orgId)` with `eq(patchApprovals.partnerId, partnerId)`:

```typescript
  const manualApprovals = await db
    .select({ patchId: patchApprovals.patchId, status: patchApprovals.status, ringId: patchApprovals.ringId })
    .from(patchApprovals)
    .where(and(
      eq(patchApprovals.partnerId, partnerId),
      inArray(patchApprovals.patchId, patchIds),
      eq(patchApprovals.status, 'approved')
    ));
```

> The partner-wide blanket (`ring_id IS NULL`) and ring-specific rows are both returned here; the existing `manualApprovalSet` construction already keys on `patchId`. If the set must distinguish ring-specific vs partner-wide, build it as before — a `ring_id IS NULL` row applies regardless of the device's ring, a `ring_id = ringConfig.ringId` row applies for that ring.

- [ ] **Step 3: Guard against a cross-partner ring link**

Where `ringConfig.ringId` is resolved/loaded, ensure the ring belongs to `partnerId`. If the evaluator loads the ring row, add `&& ring.partnerId === partnerId` to the acceptance; otherwise add a guard so a config policy that mistakenly links another partner's ring is ignored:

```typescript
  // A config policy could reference a ring from another partner (featurePolicyId
  // is an unconstrained uuid). Partner-scoped approvals must not cross that line.
  if (ringConfig.ringId && ringConfig.ringPartnerId && ringConfig.ringPartnerId !== partnerId) {
    ringConfig = { ...ringConfig, ringId: null };
  }
```

> If `ApprovalEvaluationConfig` does not carry the ring's partner, add `ringPartnerId` when the caller builds it (the caller loads the ring; have it select `partnerId` too). Update the type accordingly.

- [ ] **Step 4: Remove the org/policy-level fallback**

The `if (!ringConfig.ringId) { ... policyAutoApprove ... }` block (lines ~395-407) was the legacy org/policy path. Per the spec it is removed: with no ring there is no policy-level auto-approve. Replace that block with:

```typescript
  // No ring linked → only manual approvals apply (partner-wide blanket handled above).
  if (!ringConfig.ringId) {
    return null;
  }
```

- [ ] **Step 5: Run evaluator unit tests (write the precedence cases)**

Add/adjust unit tests in `apps/api/src/services/patchApprovalEvaluator.test.ts` covering: (a) ring-specific manual approval wins; (b) partner-wide (`ringId NULL`) manual approval applies under any ring; (c) ring auto-approve by severity; (d) a cross-partner ring is ignored. Run:

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/patchApprovalEvaluator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(patches): partner-scoped approval evaluation + cross-partner ring guard"
```

---

## Task 8: Shared validators — `partnerId` on ring/approval schemas

**Files:**
- Modify: `packages/shared/src/validators/index.ts`

- [ ] **Step 1: Swap org→partner in any shared ring/approval schema**

Grep the file for ring/approval schemas that carry `orgId`:

```bash
grep -n "orgId" packages/shared/src/validators/index.ts | grep -iE "ring|approv|patch"
```

For each match in a ring or patch-approval schema, replace `orgId: z.string().guid()...` with `partnerId: z.string().guid()...` (preserve `.optional()`/nullability). Leave `ringAutoApproveSchema` unchanged (no org field).

- [ ] **Step 2: Typecheck shared + dependents**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: clean (no build script on `@breeze/shared`; use typecheck).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/validators/index.ts
git commit -m "refactor(validators): partner field on update-ring/approval schemas"
```

---

## Task 9: AI tool `manage_update_rings` → partner

**Files:**
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.ts`

**Interfaces:**
- Produces: `getPartnerId(auth)` + `partnerWhere(auth, col)` helpers; `manage_update_rings` operates on `patchPolicies.partnerId` and requires partner/system scope.

- [ ] **Step 1: Add partner helpers**

Next to `getOrgId`/`orgWhere` (lines 46-52), add:

```typescript
function getPartnerId(auth: AuthContext): string | null {
  return auth.partnerId ?? null;
}

function partnerWhere(auth: AuthContext, partnerIdCol: any): SQL | undefined {
  if (auth.scope === 'system') return undefined; // all partners
  if (auth.partnerId) return eq(partnerIdCol, auth.partnerId);
  // org scope or partnerless: match nothing
  return sql`false`;
}
```

- [ ] **Step 2: Rewrite the handler branches**

In the `manage_update_rings` handler (lines 108-230):
- Replace `const orgId = getOrgId(auth);` with `const partnerId = getPartnerId(auth);` and add an early scope check at the top of the handler:

```typescript
      if (auth.scope === 'organization') {
        return JSON.stringify({ error: 'Update rings are managed at partner scope. Switch to a partner/admin context.' });
      }
```

- In `list`/`get`/`update`, replace `orgWhere(auth, patchPolicies.orgId)` with `partnerWhere(auth, patchPolicies.partnerId)`.
- In `create`, replace `if (!orgId) return ...'Organization context required'...` with `if (!partnerId) return JSON.stringify({ error: 'Partner context required' });` and change the insert `orgId,` → `partnerId,`.

- [ ] **Step 3: Typecheck + AI-tool tests**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiToolsPolicyPrereqs.test.ts
```

Expected: clean; update any test asserting org behavior.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiToolsPolicyPrereqs.ts
git commit -m "feat(ai): partner-scope manage_update_rings tool"
```

---

## Task 10: Cascade lists — move rings/approvals to partner cascade

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`

**Interfaces:**
- Consumes: existing `ORG_CASCADE_DELETE_ORDER`; the partner-cascade path (locate it).

- [ ] **Step 1: Remove both tables from `ORG_CASCADE_DELETE_ORDER`**

Delete the lines `'patch_approvals',` and `'patch_policies',` from the `ORG_CASCADE_DELETE_ORDER` array. Leave `'patch_compliance_reports'`, `'patch_compliance_snapshots'`, `'patch_jobs'` (still org-scoped).

- [ ] **Step 2: Find the partner cascade order and add both tables**

```bash
grep -n "PARTNER_CASCADE\|partner.*delete.*order\|deletePartner" apps/api/src/services/tenantCascade.ts apps/api/src/services/*.ts
```

If a `PARTNER_CASCADE_DELETE_ORDER` (or equivalent partner-deletion table list) exists, insert `'patch_policies'` and `'patch_approvals'` into it in **localeCompare-sorted** position (delete approvals before policies if the list is dependency-ordered, since `patch_approvals.ring_id` FKs `patch_policies`). If no partner-cascade list exists, the FK from `patch_policies.partner_id → partners.id` will block partner deletion unless `ON DELETE CASCADE` is set; add a follow-up note and prefer an explicit partner-cascade entry over changing FK semantics.

- [ ] **Step 3: Run the cascade contract test**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run src/services/tenantCascade
```

Expected: PASS — the list-contract test (alpha-order + completeness) accepts the moved entries. If it fails on ordering, fix the insert position (recall: a prefix-extension sibling sorts by `localeCompare`, not by eye).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts
git commit -m "refactor(cascade): patch rings/approvals follow partner deletion, not org"
```

---

## Task 11: Web — `PatchesPage.tsx` scope-aware gating

**Files:**
- Modify: `apps/web/src/components/patches/PatchesPage.tsx`

**Interfaces:**
- Consumes: `getJwtClaims()` from `apps/web/src/lib/authScope.ts` (`{ scope, partnerId }`).

- [ ] **Step 1: Derive partner-management capability**

After `const allOrgsMode = currentOrgId === null;` (line 58), add:

```typescript
  const { scope } = getJwtClaims();
  // Rings + approvals are partner-scoped: only partner/system users manage them.
  const canManageRings = scope === 'partner' || scope === 'system';
  const RING_SCOPE_HINT = 'Update rings are managed at the partner level';
```

Add the import at the top: `import { getJwtClaims } from '../../lib/authScope';`

- [ ] **Step 2: Hide the Update Rings tab for org-scoped users**

Change the `tabs` memo (lines 85-92) so the rings tab is conditional:

```typescript
  const tabs = useMemo(
    () => [
      { id: 'compliance' as TabKey, label: 'Compliance', icon: <BarChart3 className="h-4 w-4" /> },
      { id: 'patches' as TabKey, label: 'Patches', icon: <FileCog className="h-4 w-4" /> },
      ...(canManageRings ? [{ id: 'rings' as TabKey, label: 'Update Rings', icon: <Layers className="h-4 w-4" /> }] : [])
    ],
    [canManageRings]
  );
```

- [ ] **Step 3: Enable the New Ring button in all-orgs mode for partner/system**

Change the create-ring button (lines 519-520) so it is enabled when `canManageRings` (no longer gated on `allOrgsMode`):

```typescript
              disabled={!canManageRings}
              title={!canManageRings ? RING_SCOPE_HINT : undefined}
```

- [ ] **Step 4: Typecheck web + run page test**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/patches
```

Expected: clean. If a test stubs `getJwtClaims`, mock it to return `{ scope: 'partner', partnerId: 'p1', orgId: null }`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/patches/PatchesPage.tsx
git commit -m "feat(web): partner-scoped Update Rings tab + create gating"
```

---

## Task 12: Web — `PatchApprovalModal.tsx` partner-wide approval

**Files:**
- Modify: `apps/web/src/components/patches/PatchApprovalModal.tsx`

- [ ] **Step 1: Allow approval without a selected org for partner/system**

Replace the early block (lines 106-110) that requires `ringId || currentOrgId`:

```typescript
    // Approval is partner-scoped. A partner/system user can approve partner-wide
    // (no ring) or ring-scoped (ring selected). Org-scoped users cannot approve.
    const { scope } = getJwtClaims();
    if (scope === 'organization') {
      setSubmitError('Patch approvals are managed at the partner level');
      return;
    }
```

Add `import { getJwtClaims } from '../../lib/authScope';` if not present. Remove the now-dead `!ringId && !currentOrgId` guard.

- [ ] **Step 2: Send partnerId/ringId, not orgId**

In the request body/query where the modal POSTs to `/patches/{id}/approve|decline|defer`, drop `orgId` and rely on `ringId` (when a ring is selected) or `partnerId` from `getJwtClaims().partnerId` for the partner-wide case. Update the `canResolveOrg`/warning logic (lines 239-242) to a partner-scope message or remove it (org users no longer reach this modal).

- [ ] **Step 3: Typecheck + test**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/patches/PatchApprovalModal.test.tsx
```

Expected: clean (adjust test mocks for `getJwtClaims`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/patches/PatchApprovalModal.tsx
git commit -m "feat(web): partner-wide patch approval in all-orgs mode"
```

---

## Task 13: Web — `UpdateRingForm.tsx` drop all-orgs block

**Files:**
- Modify: `apps/web/src/components/patches/UpdateRingForm.tsx`

- [ ] **Step 1: Remove the all-orgs create block; send partnerId**

In `handleRingSubmit` (lines 414-418) remove:

```typescript
    if (!isEditing && allOrgsMode) {
      showToast({ message: SELECT_ORG_HINT, type: 'error' });
      return;
    }
```

The POST body no longer needs an org; `fetchWithAuth` injecting `?orgId=` is now irrelevant. For partner/system create, the API resolves partner from `auth.partnerId`; for a system user with multiple partners, include `partnerId` from `getJwtClaims().partnerId` in the body if available (optional — partner-scoped users resolve server-side).

- [ ] **Step 2: Typecheck + test + commit**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/patches
git add apps/web/src/components/patches/UpdateRingForm.tsx
git commit -m "feat(web): create update rings in all-orgs (partner) mode"
```

---

## Task 14: Functional route integration test (scope + cross-partner)

**Files:**
- Modify: `apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts`

- [ ] **Step 1: Add route-level cases**

Append `describe` blocks (using the test app harness already used by other route integration tests — copy the bootstrap from a sibling `*.integration.test.ts`) asserting:
- An **organization**-scope request to `POST /update-rings` returns **403**.
- A **partner**-scope request creates a ring (201) and lists only its own partner's rings.
- A second partner cannot GET the first partner's ring (**403/404**).
- Approving a patch with a `ringId` from another partner returns **403**.
- A **partner-wide** approval (`ringId` omitted) upserts a `(partner_id, patch_id, ring_id NULL)` row and is visible to that partner only.

(Write concrete request/expect pairs following the sibling file's `app.request(...)` + auth-context-injection pattern.)

- [ ] **Step 2: Run**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run src/__tests__/integration/update-rings-partner-scope.integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts
git commit -m "test(integration): partner scope + cross-partner denial for rings/approvals"
```

---

## Task 15: Full verification + drift

**Files:** none (verification only)

- [ ] **Step 1: API affected tests (single-fork, per CLAUDE.md flakiness note)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/updateRings.test.ts src/routes/patches src/services/patchApprovalEvaluator.test.ts src/services/aiToolsPolicyPrereqs.test.ts
```

Expected: PASS.

- [ ] **Step 2: RLS coverage + integration**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run -c vitest.config.rls-coverage.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run src/__tests__/integration/update-rings-partner-scope.integration.test.ts src/services/tenantCascade.integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Drift + web typecheck**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit
```

Expected: no drift; web typecheck clean.

- [ ] **Step 4: Final commit (if any test fixtures changed)**

```bash
git add -A && git commit -m "chore: finalize partner-scoped update rings & approvals" || echo "nothing to commit"
```

---

## Task 16: Approval-status READ paths → partner (`list.ts`, `compliance.ts`)

> Added after Task 6 surfaced a plan gap: 8 files outside the original plan still reference the removed `patchPolicies.orgId` / `patchApprovals.orgId`. Tasks 16-18 close it. Run order: after Task 10, before Task 14.

**Files:**
- Modify: `apps/api/src/routes/patches/helpers.ts` (add shared helper)
- Modify: `apps/api/src/routes/patches/list.ts:156`
- Modify: `apps/api/src/routes/patches/compliance.ts:45,53,56,120-124,161`

**Interfaces:**
- Produces: `resolvePartnerIdForOrg(orgId: string): Promise<string | null>` in `helpers.ts` (SELECT partner_id FROM organizations WHERE id = orgId; null if none). Reused by Tasks 17-18.

- [ ] **Step 1: Add `resolvePartnerIdForOrg` to `helpers.ts`**

```typescript
export async function resolvePartnerIdForOrg(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.partnerId ?? null;
}
```
Import `organizations` from the schema if not already imported.

- [ ] **Step 2: Fix `list.ts:156`**

The handler filters approval status by `?orgId`. Resolve the org's partner first, then filter `patchApprovals` by partner (and keep the existing `ringId` filter if present):
```typescript
const partnerId = await resolvePartnerIdForOrg(query.orgId);
// if partnerId is null, there are no approvals: skip the join / return empty approval map
... eq(patchApprovals.partnerId, partnerId) ...
```
If `query.orgId` is absent (partner/system viewing all), derive partner from `auth.partnerId` when available, else leave approvals unfiltered by partner only if the route already gates partner/system. Match the file's existing control flow; do not broaden scope.

- [ ] **Step 3: Fix `compliance.ts`**

This handler overloads `effectiveOrgId` for BOTH device scoping (stays org-scoped — KEEP) and approval scoping (now partner). Introduce a separate `effectivePartnerId`:
- Line 45: the ring lookup must select `patchPolicies.partnerId` (not `orgId`). Replace the `canAccessOrg(ring.orgId)` gate (line 53) with the partner check `auth.scope !== 'system' && auth.partnerId !== ring.partnerId` → 403, and set `effectivePartnerId = ring.partnerId`. For the non-ring path, set `effectivePartnerId = await resolvePartnerIdForOrg(effectiveOrgId)`.
- Lines 120-124: `eq(patchApprovals.orgId, effectiveOrgId)` → `eq(patchApprovals.partnerId, effectivePartnerId)`.
- Line 161 (raw SQL `pa.org_id = ${devicePatches.orgId}`): `patch_approvals` has no `org_id`. Rewrite the join so `pa.partner_id` equals the device-org's partner. Since `device_patches` is org-scoped, join through the org's partner — e.g. resolve `effectivePartnerId` once and bind it: `pa.partner_id = ${effectivePartnerId}`. Verify the rewritten SQL returns the same approved set it did before (just keyed on partner).
- `device_patches.orgId` and any `patchJobs.orgId` / `patchComplianceSnapshots.orgId` references in this file STAY unchanged (those tables remain org-scoped).

- [ ] **Step 4: Verify**

```bash
NODE_OPTIONS=--max-old-space-size=8192 PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/patches
```
Expected: no errors in `list.ts`/`compliance.ts`/`helpers.ts`; patches route tests pass. Update any test asserting the old org-keyed approval read.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/patches/helpers.ts apps/api/src/routes/patches/list.ts apps/api/src/routes/patches/compliance.ts
git commit -m "fix(patches): partner-scope approval-status reads in list/compliance"
```

---

## Task 17: Device install gate + Fleet AI writes → partner (`devices/patches.ts`, `aiToolsFleet.ts`)

**Files:**
- Modify: `apps/api/src/routes/devices/patches.ts:125,248,386`
- Modify: `apps/api/src/services/aiToolsFleet.ts:380,395-404,415-425,438-449`

**Interfaces:**
- Consumes: `resolvePartnerIdForOrg` (Task 16) and `upsertPatchApproval` (Task 6, partner-keyed).

- [ ] **Step 1: Fix `devices/patches.ts` install gate**

Rename `getApprovedPatchIdsForOrg(orgId, patchIds)` → `getApprovedPatchIdsForPartner(partnerId, patchIds)` and change the query to `eq(patchApprovals.partnerId, partnerId)` (line 125). At the two call sites (lines 248, 386), derive the partner from the device's org: `const partnerId = await resolvePartnerIdForOrg(device.orgId); if (!partnerId) { /* no approvals → treat all as unapproved (fail-safe, existing behavior) */ }`. This is the safety-critical install gate — confirm the empty-partner path still blocks (does not auto-approve) installs.

- [ ] **Step 2: Fix `aiToolsFleet.ts` approval writes**

The four write branches (approve 395-404, defer 415-425, bulk_approve 438-449) and the compliance read (380) currently insert/`onConflictDoUpdate` on `[patchApprovals.orgId, patchApprovals.patchId]`. That conflict target does NOT match the new expression unique index. REPLACE each ad-hoc insert/upsert with a call to the shared `upsertPatchApproval({ partnerId, patchId, ringId: null, status, approvedBy, ... })` from `patches/helpers.ts` (it correctly targets `(partner_id, patch_id, COALESCE(ring_id, NIL))`). Derive `partnerId` from `auth.partnerId ?? await resolvePartnerIdForOrg(getOrgId(auth))`. The compliance-read aggregate (380) becomes `eq(patchApprovals.partnerId, partnerId)`.
- `patchJobs.orgId` (485-495) and `patchComplianceSnapshots.orgId` (365-369) STAY org-scoped — do not change them.

- [ ] **Step 3: Verify**

```bash
NODE_OPTIONS=--max-old-space-size=8192 PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/devices src/services/aiToolsFleet.test.ts
```
Expected: clean; update affected tests to partner behavior. If a fleet test asserted the old `[orgId, patchId]` upsert, switch it to assert the `upsertPatchApproval` call / partner key.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/devices/patches.ts apps/api/src/services/aiToolsFleet.ts
git commit -m "fix(patches): partner-scope device install gate + fleet AI approvals"
```

---

## Task 18: Ring lookup/validation + legacy route + migration script → partner

**Files:**
- Modify: `apps/api/src/routes/patchPolicies.ts:23-37,53,103,110,119,122`
- Modify: `apps/api/src/services/configurationPolicy.ts:1307,1329-1338,1379-1388`
- Modify: `apps/api/src/services/configPolicyPatching.ts:190,294,374`
- Modify: `apps/api/src/scripts/migrateToConfigPolicies.ts:183,457,610`

**Interfaces:**
- Consumes: `resolvePartnerIdForOrg` (Task 16); `auth.partnerId`.

- [ ] **Step 1: `patchPolicies.ts` (legacy read route) → partner filters**

`ensureOrgAccess(policy.orgId, auth)` (23-37, 53) → a partner check `auth.scope !== 'system' && auth.partnerId !== policy.partnerId` → 403. The four list filters (103, 110, 119, 122) collapse to `eq(patchPolicies.partnerId, auth.partnerId)` for partner scope (the `inArray(orgId, accessibleOrgIds)` case becomes a single partner equality), `eq(patchPolicies.partnerId, <resolved partner>)` for a system caller filtering by a specific partner, and gate org-scope callers out (`requireScope('partner','system')` if not already). Mirror the partner-resolution style from `updateRings.ts` (Task 5).

- [ ] **Step 2: `configurationPolicy.ts` feature-policy validation → partner**

`FEATURE_TABLE_MAP.patch` (1307) `orgIdCol: patchPolicies.orgId` → `partnerIdCol: patchPolicies.partnerId` (rename the map field consistently with how the generic path at 1374-1388 consumes it). `validateFeaturePolicyExists` (1329-1338) currently compares `eq(patchPolicies.orgId, orgId)`; the `patch` branch must validate the ring belongs to the partner: derive partner via `await resolvePartnerIdForOrg(orgId)` (the function still receives the config policy's orgId) and compare `eq(patchPolicies.partnerId, partnerId)`. Keep all OTHER feature tables' org-axis validation unchanged — only the `patch` entry moves to partner.

- [ ] **Step 3: `configPolicyPatching.ts` ring reference resolution → partner**

`resolvePatchPolicyReference(orgId, featurePolicyId)` (190) → `(partnerId, featurePolicyId)` with `eq(patchPolicies.partnerId, partnerId)`. The two call sites (294, 374) pass `row.orgId` (the config policy's org) — derive partner first: `const partnerId = await resolvePartnerIdForOrg(row.orgId)` and pass it. The `configPolicy_uuid` fallback path (uses `configurationPolicies.orgId`) STAYS unchanged.

- [ ] **Step 4: `migrateToConfigPolicies.ts` (one-shot script) → partner**

Mechanical: `selectDistinct({ partnerId: patchPolicies.partnerId })` (183), and the two per-scope fetches (457, 610) `eq(patchPolicies.partnerId, partnerId)`, iterating partner ids. If this script is confirmed already-run/dead, a top-of-file note is acceptable, but it must still COMPILE.

- [ ] **Step 5: Verify (this should make the FULL project typecheck clean)**

```bash
NODE_OPTIONS=--max-old-space-size=8192 PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/patchPolicies.test.ts src/services/configurationPolicy.test.ts src/services/configPolicyPatching.test.ts
```
Expected: with Tasks 7-9 and 16-17 also done, `tsc` should now report ZERO `patchPolicies.orgId`/`patchApprovals.orgId` errors across the project. (Run the grep `grep -rn "patchApprovals\.orgId\|patchPolicies\.orgId" apps/api/src | grep -v test` — expect no hits.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/patchPolicies.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/configPolicyPatching.ts apps/api/src/scripts/migrateToConfigPolicies.ts
git commit -m "fix(patches): partner-scope ring validation, legacy route, migration script"
```

---

## Notes / risks carried from the spec

- **Behavior change (accepted):** org-scoped users lose ring creation + update-approval; they keep read-only Compliance/Patches. The Update Rings tab and approval modal are hidden/blocked client-side AND enforced server-side (403).
- **Optional future enhancement (NOT in scope):** to let org-scoped users *read* (not write) their partner's rings, use the `scripts` dual-axis pattern — a read-only own-partner branch `... OR partner_id = breeze_current_partner_id()` on the SELECT policy only. Deferred per the approved design.
- **Highest-risk step:** Task 3 Step 1 approval dedup (deletes data). It is row-counted via `RAISE WARNING`. Production `patch_approvals` should be inspected for `(partner, patch, NULL-ring)` collisions before rollout.
- **Cross-partner ring reference** on org-scoped `patch_jobs` / config-policy links is only enforced at the app layer (Task 7 Step 3 guard + Task 14 test). `featurePolicyId` is an unconstrained uuid.
- **`writeRouteAudit` partner context:** verify the helper accepts a partner-only context; if it hard-requires `orgId`, pass `orgId: null` and add `partnerId` (check its signature when editing Tasks 5/6).
```
