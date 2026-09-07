---
tracking_issue: LanternOps/breeze#5080
wave_issue: LanternOps/breeze#5081
branch: feature/5080-config-policy-inheritance/wave-5081
---

# Config Policy Inheritance — W01 API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a validated, tenant-safe `parent_policy_id` on `configuration_policies`, ship the `config_policy_effective_feature_links` view, and expose the parent on the configuration-policy API, without yet switching any resolver.

**Architecture:** One idempotent migration adds the column, self-FK, CHECK, partial index, a `SECURITY DEFINER` compatibility function, two deferrable constraint triggers, and the `security_invoker` view. The service validates the parent inside the insert transaction (friendly 400), the triggers are the authority (23514). `GET /:id` embeds the parent (assembled links, read through RLS, not through `policyAccessCondition`) and the children; a names-only `eligible-parents` endpoint feeds the create picker; delete of a parent with children is 409.

**Tech Stack:** Hono, Drizzle ORM (`pgView(...).existing()`), PostgreSQL 16 (`security_invoker` views, constraint triggers), Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`).

**Spec:** `docs/superpowers/specs/config-policy/2026-09-06-config-policy-inheritance-design.md`

**Tracking:** feature LanternOps/breeze#5080, wave #5081. Branch `feature/5080-config-policy-inheritance/wave-5081`.

## Global Constraints

- Migration filename `2026-10-12-100000-config-policy-inheritance.sql`; before pushing, confirm it sorts after the newest file in `apps/api/migrations` on `origin/main` (`ls apps/api/migrations | sort | tail -1`), rename later in the day if not.
- Migration is idempotent, contains **no DML**, no inner `BEGIN`/`COMMIT`.
- FK on `parent_policy_id` is the default `NO ACTION`. Not `RESTRICT`, not `SET NULL`.
- SQL guards are two-valued: `COALESCE(..., false)` inside every boolean guard function and `IS NOT TRUE` at every call site, never `IF NOT f()`. A lookup miss in an authorization decision is a deny.
- `parent_policy_id` is immutable after insert (any change, including `NULL → value`, is rejected). Ownership (`org_id`, `partner_id`) changes are rejected unless `public.breeze_current_scope() = 'system'`.
- Ownership rule: org child → parent in the same org **or** partner-wide of the org's partner; partner-wide child → partner-wide parent of the same partner. Parent must have `parent_policy_id IS NULL`. `parent.id <> child.id`.
- View is `WITH (security_invoker = true)`, granted `SELECT` to `breeze_app`, declared in Drizzle with `.existing()`. An inherited row keeps the **parent link's `id`**.
- Error codes: `400 { error: 'INVALID_PARENT_POLICY' }`, `409 { error: 'POLICY_HAS_CHILDREN', children: [{ id, name }] }`, `403 { error: 'MFA required' }`.
- `policyAccessCondition` is **not** relaxed. The parent embed and the eligible-parents list are the only new read paths, both read-only.
- Every task: red test first, `pnpm --filter @breeze/api exec tsc --noEmit`, targeted tests, commit. Before the PR: the live-DB suites listed in Task 12.

---

### Task 1: Migration — column, FK, CHECK, index, compatibility function, constraint triggers, view

**Files:**
- Create: `apps/api/migrations/2026-10-12-100000-config-policy-inheritance.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing, auto-discovers), `apps/api/src/db/migrationRlsScope.test.ts` (existing, must stay green: no DML)

**Interfaces:**
- Produces: column `configuration_policies.parent_policy_id uuid NULL`; constraints `configuration_policies_parent_policy_id_fkey`, `configuration_policies_not_own_parent_chk`; index `config_policies_parent_policy_id_idx`; function `public.breeze_config_policy_parent_compatible(child_org uuid, child_partner uuid, parent_org uuid, parent_partner uuid) RETURNS boolean`; constraint names raised by the triggers: `configuration_policies_parent_immutable`, `configuration_policies_owner_immutable`, `configuration_policies_parent_guard`, `organizations_partner_config_policy_guard`; view `public.config_policy_effective_feature_links` with columns `id, config_policy_id, source_policy_id, feature_type, feature_policy_id, inline_settings, created_at, updated_at, inherited`.

- [ ] **Step 1: Write the migration**

```sql
-- Configuration policy inheritance (spec: docs/superpowers/specs/config-policy/
-- 2026-09-06-config-policy-inheritance-design.md).
--
-- 1. `configuration_policies.parent_policy_id` — one-level, create-only parent.
-- 2. Ownership rule enforced by a DEFERRABLE constraint trigger (org merge runs
--    SET CONSTRAINTS ALL DEFERRED and re-points parent and child in separate
--    statements; validation therefore happens at commit).
-- 3. `config_policy_effective_feature_links` — the child's own links plus the
--    parent's links for feature types the child lacks. security_invoker so the
--    base tables' RLS (incl. the *_partner_wide_select branches) applies to the
--    caller. An inherited row keeps the PARENT link's id: the normalized
--    per-feature settings tables are keyed by feature_link_id.
--
-- No DML, so no breeze.scope election. Idempotent.

ALTER TABLE public.configuration_policies
  ADD COLUMN IF NOT EXISTS parent_policy_id uuid;

ALTER TABLE public.configuration_policies
  DROP CONSTRAINT IF EXISTS configuration_policies_parent_policy_id_fkey;
ALTER TABLE public.configuration_policies
  ADD CONSTRAINT configuration_policies_parent_policy_id_fkey
  FOREIGN KEY (parent_policy_id) REFERENCES public.configuration_policies(id);

ALTER TABLE public.configuration_policies
  DROP CONSTRAINT IF EXISTS configuration_policies_not_own_parent_chk;
ALTER TABLE public.configuration_policies
  ADD CONSTRAINT configuration_policies_not_own_parent_chk
  CHECK (parent_policy_id IS NULL OR parent_policy_id <> id);

CREATE INDEX IF NOT EXISTS config_policies_parent_policy_id_idx
  ON public.configuration_policies (parent_policy_id)
  WHERE parent_policy_id IS NOT NULL;

-- Ownership compatibility. SECURITY DEFINER like breeze_guard_pam_device_org_move:
-- the RULE rejects cross-tenant edges; the service layer masks "not found".
CREATE OR REPLACE FUNCTION public.breeze_config_policy_parent_compatible(
  child_org uuid, child_partner uuid, parent_org uuid, parent_partner uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  -- STRICTLY two-valued. `parent_org = child_org` is NULL whenever parent_org IS
  -- NULL (a partner-wide parent); `NULL OR false` is NULL and `IF NOT NULL` never
  -- fires, so without the COALESCE a cross-partner parent was silently ACCEPTED
  -- (found by the live-DB forge in W01, PR #5099). Callers test `IS NOT TRUE`.
  SELECT COALESCE(
    CASE
      WHEN child_org IS NOT NULL THEN
        parent_org = child_org
        OR (parent_org IS NULL AND parent_partner IS NOT NULL
            AND parent_partner = (SELECT o.partner_id FROM public.organizations o WHERE o.id = child_org))
      WHEN child_partner IS NOT NULL THEN
        parent_org IS NULL AND parent_partner = child_partner
      ELSE false
    END,
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.breeze_config_policy_parent_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_policy_id IS DISTINCT FROM OLD.parent_policy_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_immutable',
        MESSAGE = 'configuration policy parent is set at create time and cannot change';
    END IF;
    IF (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.partner_id IS DISTINCT FROM OLD.partner_id)
       AND public.breeze_current_scope() <> 'system' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_owner_immutable',
        MESSAGE = 'configuration policy ownership can only change in system context';
    END IF;
  END IF;

  -- Outgoing edge: this row's parent.
  IF NEW.parent_policy_id IS NOT NULL THEN
    SELECT org_id, partner_id, parent_policy_id INTO p
      FROM public.configuration_policies WHERE id = NEW.parent_policy_id;
    IF NOT FOUND
       OR p.parent_policy_id IS NOT NULL
       OR public.breeze_config_policy_parent_compatible(NEW.org_id, NEW.partner_id, p.org_id, p.partner_id) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_guard',
        MESSAGE = 'parent configuration policy not found or not eligible';
    END IF;
  END IF;

  -- Incoming edges: rows that name this row as parent (ownership moves, one level).
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_policy_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.configuration_policies c WHERE c.parent_policy_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_guard',
        MESSAGE = 'a configuration policy with children cannot have a parent';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.configuration_policies c
       WHERE c.parent_policy_id = NEW.id
         AND public.breeze_config_policy_parent_compatible(c.org_id, c.partner_id, NEW.org_id, NEW.partner_id) IS NOT TRUE
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_guard',
        MESSAGE = 'ownership change would orphan child configuration policies';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS configuration_policies_parent_guard ON public.configuration_policies;
CREATE CONSTRAINT TRIGGER configuration_policies_parent_guard
  AFTER INSERT OR UPDATE OF parent_policy_id, org_id, partner_id
  ON public.configuration_policies
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_config_policy_parent_guard();

-- An org changing partner would orphan its children of partner-wide parents.
-- No code path does this today; the guard keeps the invariant independent of that.
CREATE OR REPLACE FUNCTION public.breeze_config_policy_org_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id AND EXISTS (
    SELECT 1
      FROM public.configuration_policies c
      JOIN public.configuration_policies p ON p.id = c.parent_policy_id
     WHERE c.org_id = NEW.id
       AND p.org_id IS NULL
       AND p.partner_id IS DISTINCT FROM NEW.partner_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'organizations_partner_config_policy_guard',
      MESSAGE = 'organization partner change would orphan child configuration policies';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS organizations_partner_config_policy_guard ON public.organizations;
CREATE CONSTRAINT TRIGGER organizations_partner_config_policy_guard
  AFTER UPDATE OF partner_id ON public.organizations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_config_policy_org_partner_guard();

CREATE OR REPLACE VIEW public.config_policy_effective_feature_links
  WITH (security_invoker = true) AS
  SELECT l.id, l.config_policy_id, l.config_policy_id AS source_policy_id,
         l.feature_type, l.feature_policy_id, l.inline_settings, l.created_at, l.updated_at,
         false AS inherited
    FROM public.config_policy_feature_links l
  UNION ALL
  SELECT pl.id, c.id AS config_policy_id, pl.config_policy_id AS source_policy_id,
         pl.feature_type, pl.feature_policy_id, pl.inline_settings, pl.created_at, pl.updated_at,
         true AS inherited
    FROM public.configuration_policies c
    JOIN public.config_policy_feature_links pl ON pl.config_policy_id = c.parent_policy_id
   WHERE c.parent_policy_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.config_policy_feature_links own
        WHERE own.config_policy_id = c.id AND own.feature_type = pl.feature_type
     );

GRANT SELECT ON public.config_policy_effective_feature_links TO breeze_app;
```

- [ ] **Step 2: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS (the file sorts last; no DML so the scope guard has nothing to flag).

Run: `bash scripts/check-migration-naming.sh --against-ref origin/main`
Expected: `check-migration-naming: OK`.

- [ ] **Step 3: Apply to a local database and replay**

Run (with the wt-stack or test-stack Postgres up, `DATABASE_URL` set): `pnpm db:migrate && pnpm db:migrate`
Expected: second run is a no-op (no errors, `NOTICE`s at most).

Run: `pnpm db:check-drift`
Expected: passes. If it reports the view, fix `apps/api/scripts/check-drift.ts` to ignore `relkind = 'v'`; never remove the view from the migration.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-12-100000-config-policy-inheritance.sql
git commit -m "feat(config-policy): parent_policy_id + effective-links view migration"
```

---

### Task 2: Drizzle schema — column, self-reference, existing view

**Files:**
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:1-16` (imports), `:70-86` (table), append view after `configPolicyFeatureLinks`
- Test: `apps/api/src/db/schema/configurationPolicies.inheritance.test.ts` (create)

**Interfaces:**
- Produces: `configurationPolicies.parentPolicyId` (nullable uuid column); `export const configPolicyEffectiveFeatureLinks` (pgView, `.existing()`), columns `id, configPolicyId, sourcePolicyId, featureType, featurePolicyId, inlineSettings, createdAt, updatedAt, inherited`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/db/schema/configurationPolicies.inheritance.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getViewSelectedFields } from 'drizzle-orm';
import { configurationPolicies, configPolicyEffectiveFeatureLinks } from './configurationPolicies';

describe('configuration policy inheritance schema', () => {
  it('declares parent_policy_id as a nullable uuid', () => {
    const col = getTableColumns(configurationPolicies).parentPolicyId;
    expect(col.name).toBe('parent_policy_id');
    expect(col.notNull).toBe(false);
  });

  it('declares the effective-links view with the contract columns', () => {
    const fields = getViewSelectedFields(configPolicyEffectiveFeatureLinks);
    expect(Object.keys(fields).sort()).toEqual([
      'configPolicyId', 'createdAt', 'featurePolicyId', 'featureType', 'id',
      'inherited', 'inlineSettings', 'sourcePolicyId', 'updatedAt',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/configurationPolicies.inheritance.test.ts`
Expected: FAIL — `configPolicyEffectiveFeatureLinks` is not exported / `parentPolicyId` undefined.

- [ ] **Step 3: Implement**

In the import block add `pgView` and `type AnyPgColumn` to the `drizzle-orm/pg-core` import. In the `configurationPolicies` table, after `partnerId`:

```ts
  // One-level, create-only parent (config-policy inheritance). Lazy
  // `(): AnyPgColumn =>` self-reference, same pattern as aiAgents.scheduleId.
  // Default FK action (NO ACTION): a parent with children cannot be deleted
  // alone; org cascade deletes parent and children in one statement.
  parentPolicyId: uuid('parent_policy_id').references((): AnyPgColumn => configurationPolicies.id),
```

and in the index callback: `parentPolicyIdIdx: index('config_policies_parent_policy_id_idx').on(table.parentPolicyId).where(sql\`${table.parentPolicyId} IS NOT NULL\`),`.

After `configPolicyFeatureLinks`:

```ts
// The child's own feature links plus the parent's links for feature types the
// child has no link of its own. Managed by migration
// 2026-10-12-100000-config-policy-inheritance.sql (security_invoker), hence
// `.existing()` — drizzle-kit never touches it. `id` is the UNDERLYING link id:
// an inherited row keeps the parent link's id so joins on
// config_policy_*_settings.feature_link_id keep working. Resolvers, agent
// delivery, and workers read THIS; link CRUD keeps reading
// configPolicyFeatureLinks (contract test: services/featureLinkReaders.contract.test.ts, W02).
export const configPolicyEffectiveFeatureLinks = pgView('config_policy_effective_feature_links', {
  id: uuid('id').notNull(),
  configPolicyId: uuid('config_policy_id').notNull(),
  sourcePolicyId: uuid('source_policy_id').notNull(),
  featureType: configFeatureTypeEnum('feature_type').notNull(),
  featurePolicyId: uuid('feature_policy_id'),
  inlineSettings: jsonb('inline_settings'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  inherited: boolean('inherited').notNull(),
}).existing();
```

- [ ] **Step 4: Run the test and typecheck**

Run: `cd apps/api && npx vitest run src/db/schema/configurationPolicies.inheritance.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. If `getViewSelectedFields` is not exported by the installed drizzle version, assert on `Object.keys(configPolicyEffectiveFeatureLinks)` filtered to the nine column names instead.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/configurationPolicies.ts apps/api/src/db/schema/configurationPolicies.inheritance.test.ts
git commit -m "feat(config-policy): schema — parentPolicyId column + existing effective-links view"
```

---

### Task 3: Ownership compatibility helper + error classes

**Files:**
- Modify: `apps/api/src/services/configPolicyOwnership.ts` (append)
- Test: `apps/api/src/services/configPolicyOwnership.test.ts` (existing file; append a describe)

**Interfaces:**
- Produces:
  ```ts
  export type PolicyOwnerRef = { orgId: string | null; partnerId: string | null };
  export function isCompatibleParent(
    child: PolicyOwnerRef & { orgPartnerId: string | null },
    parent: PolicyOwnerRef & { parentPolicyId: string | null; id: string },
    childId?: string,
  ): boolean;
  export class InvalidParentPolicyError extends Error { readonly code = 'INVALID_PARENT_POLICY' }
  export class PolicyHasChildrenError extends Error {
    readonly code = 'POLICY_HAS_CHILDREN';
    constructor(public readonly children: { id: string; name: string }[]) { ... }
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('isCompatibleParent', () => {
  const P = 'partner-1', O = 'org-1', O2 = 'org-2';
  const root = (o: string | null, p: string | null, id = 'parent') => ({ id, orgId: o, partnerId: p, parentPolicyId: null });
  it.each([
    ['org child ← same-org parent', { orgId: O, partnerId: null, orgPartnerId: P }, root(O, null), true],
    ['org child ← partner-wide parent of own partner', { orgId: O, partnerId: null, orgPartnerId: P }, root(null, P), true],
    ['org child ← other-org parent', { orgId: O, partnerId: null, orgPartnerId: P }, root(O2, null), false],
    ['org child ← other partner-wide', { orgId: O, partnerId: null, orgPartnerId: P }, root(null, 'partner-2'), false],
    ['partner child ← same partner-wide', { orgId: null, partnerId: P, orgPartnerId: null }, root(null, P), true],
    ['partner child ← org parent', { orgId: null, partnerId: P, orgPartnerId: null }, root(O, null), false],
    ['parent that has a parent', { orgId: O, partnerId: null, orgPartnerId: P }, { ...root(O, null), parentPolicyId: 'grand' }, false],
  ])('%s → %s', (_n, child, parent, expected) => {
    expect(isCompatibleParent(child, parent)).toBe(expected);
  });
  it('rejects self-parenting', () => {
    expect(isCompatibleParent({ orgId: O, partnerId: null, orgPartnerId: P }, root(O, null, 'me'), 'me')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/configPolicyOwnership.test.ts`
Expected: FAIL — `isCompatibleParent` is not a function.

- [ ] **Step 3: Implement**

```ts
export type PolicyOwnerRef = { orgId: string | null; partnerId: string | null };

/** Mirror of public.breeze_config_policy_parent_compatible (migration 2026-10-12-100000). */
export function isCompatibleParent(
  child: PolicyOwnerRef & { orgPartnerId: string | null },
  parent: PolicyOwnerRef & { parentPolicyId: string | null; id: string },
  childId?: string,
): boolean {
  if (childId && parent.id === childId) return false;
  if (parent.parentPolicyId !== null) return false; // one level
  if (child.orgId) {
    return parent.orgId === child.orgId
      || (parent.orgId === null && parent.partnerId !== null && parent.partnerId === child.orgPartnerId);
  }
  if (child.partnerId) return parent.orgId === null && parent.partnerId === child.partnerId;
  return false;
}

export class InvalidParentPolicyError extends Error {
  readonly code = 'INVALID_PARENT_POLICY' as const;
  constructor() { super('Parent configuration policy not found or not eligible'); this.name = 'InvalidParentPolicyError'; }
}

export class PolicyHasChildrenError extends Error {
  readonly code = 'POLICY_HAS_CHILDREN' as const;
  constructor(public readonly children: { id: string; name: string }[]) {
    super('Configuration policy has child policies that inherit from it');
    this.name = 'PolicyHasChildrenError';
  }
}
```

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/configPolicyOwnership.test.ts` → PASS.

```bash
git add apps/api/src/services/configPolicyOwnership.ts apps/api/src/services/configPolicyOwnership.test.ts
git commit -m "feat(config-policy): isCompatibleParent + inheritance error classes"
```

---

### Task 4: Shared validator — `parentPolicyId` on create only

**Files:**
- Modify: `packages/shared/src/validators/index.ts:528-544`
- Test: `packages/shared/src/validators/configPolicy.test.ts` (create if no existing test covers `createConfigPolicySchema`; otherwise append)

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createConfigPolicySchema, updateConfigPolicySchema } from './index';

describe('config policy inheritance validators', () => {
  it('accepts an optional guid parentPolicyId on create', () => {
    const ok = createConfigPolicySchema.safeParse({ name: 'child', parentPolicyId: '0b8f2c1e-1111-4a2b-9c3d-000000000001' });
    expect(ok.success).toBe(true);
    expect(createConfigPolicySchema.safeParse({ name: 'child', parentPolicyId: 'nope' }).success).toBe(false);
  });
  it('update schema strips/rejects parentPolicyId (immutable)', () => {
    const parsed = updateConfigPolicySchema.parse({ name: 'x', parentPolicyId: '0b8f2c1e-1111-4a2b-9c3d-000000000001' } as never);
    expect('parentPolicyId' in parsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`cd packages/shared && npx vitest run src/validators/configPolicy.test.ts`).

- [ ] **Step 3: Implement** — add to `createConfigPolicySchema`:

```ts
  // One-level, create-only inheritance. Validated server-side against the
  // ownership rule (same org, or partner-wide of the org's partner). Absent from
  // updateConfigPolicySchema on purpose: parent_policy_id is immutable.
  parentPolicyId: z.string().guid().optional(),
```

`updateConfigPolicySchema` is unchanged (zod objects strip unknown keys by default; the test asserts that).

- [ ] **Step 4: Run → PASS; commit**

```bash
git add packages/shared/src/validators/index.ts packages/shared/src/validators/configPolicy.test.ts
git commit -m "feat(shared): parentPolicyId on createConfigPolicySchema"
```

---

### Task 5: Service — create with parent validation, delete 409, parent/children embeds, eligible parents

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` — `createConfigPolicy` (:234-252), `getConfigPolicy` (:254-273), `listConfigPolicies` (:275+, ensure `parentPolicyId` is in each row), `deleteConfigPolicy` (:411-433); add `listEligibleParentPolicies`, `getParentLinkFeatureTypes`
- Test: `apps/api/src/services/configurationPolicy.inheritance.test.ts` (create; Drizzle mock pattern from `configurationPolicy.test.ts`)

**Interfaces:**
- Consumes: Task 3 helpers/errors; Task 2 column.
- Produces:
  ```ts
  createConfigPolicy(owner, data: { name; description?; status?; parentPolicyId?: string }, userId)
  getConfigPolicy(id, auth) → { ...policy, parentPolicyId, featureLinks,
      parentPolicy: { id, name, status, orgId, featureLinks } | null, childPolicies: { id, name }[] }
  listEligibleParentPolicies(auth, sel: { ownerScope: 'organization'; orgId: string } | { ownerScope: 'partner' })
      → { id: string; name: string; ownerScope: 'organization' | 'partner' }[]
  getParentLinkFeatureTypes(parentId: string) → string[]        // RLS read, no access condition
  deleteConfigPolicy(id, auth)  // throws PolicyHasChildrenError
  ```

- [ ] **Step 1: Failing tests** (mock `db` per the existing file's pattern; assert on behaviour, not SQL text)

```ts
describe('createConfigPolicy with parentPolicyId', () => {
  it('inserts parentPolicyId when the parent is compatible', async () => { /* parent row: same org, parentPolicyId null → insert values include parentPolicyId */ });
  it('throws InvalidParentPolicyError when the parent is not visible', async () => { /* select returns [] */ });
  it('throws InvalidParentPolicyError when the parent belongs to another org', async () => {});
  it('throws InvalidParentPolicyError when the parent itself has a parent', async () => {});
  it('maps a 23503 on configuration_policies_parent_policy_id_fkey to InvalidParentPolicyError', async () => { /* insert rejects with {code:'23503', constraint_name:'configuration_policies_parent_policy_id_fkey'} */ });
});
describe('deleteConfigPolicy', () => {
  it('throws PolicyHasChildrenError listing children before deleting', async () => {});
  it('maps a 23503 on the self-FK to PolicyHasChildrenError', async () => {});
});
describe('getConfigPolicy', () => {
  it('embeds parentPolicy with assembled links and childPolicies', async () => {});
  it('returns parentPolicy null and childPolicies [] for a root policy', async () => {});
});
describe('listEligibleParentPolicies', () => {
  it('organization scope: root policies of that org plus partner-wide of its partner', async () => {});
  it('partner scope: root partner-wide policies of the caller partner only', async () => {});
});
```

Fill each body with the mock chain the existing `configurationPolicy.test.ts` uses (`vi.mock('../db')` + `mockDb.select.mockReturnValueOnce(chain([...]))`); the assertions are: `insert(...).values` receives `parentPolicyId`; the right error class is thrown; the returned object has the fields above.

- [ ] **Step 2: Run → FAIL** (`cd apps/api && npx vitest run src/services/configurationPolicy.inheritance.test.ts`).

- [ ] **Step 3: Implement**

`createConfigPolicy`:

```ts
export async function createConfigPolicy(
  owner: { orgId: string; partnerId?: null } | { orgId?: null; partnerId: string },
  data: { name: string; description?: string; status?: 'active' | 'inactive' | 'archived'; parentPolicyId?: string },
  userId: string
) {
  return db.transaction(async (tx) => {
    if (data.parentPolicyId) {
      // Read through the caller's RLS context (an org token sees a partner-wide
      // parent via configuration_policies_partner_wide_select). No row lock: a
      // FOR KEY SHARE would apply the UPDATE policy, which that branch does not
      // satisfy; the FK closes the delete race (23503 → same 400 below).
      const [parent] = await tx
        .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId,
                  partnerId: configurationPolicies.partnerId, parentPolicyId: configurationPolicies.parentPolicyId })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.id, data.parentPolicyId))
        .limit(1);
      let orgPartnerId: string | null = null;
      if (owner.orgId) {
        const [org] = await tx.select({ partnerId: organizations.partnerId })
          .from(organizations).where(eq(organizations.id, owner.orgId)).limit(1);
        orgPartnerId = org?.partnerId ?? null;
      }
      if (!parent || !isCompatibleParent(
        { orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null, orgPartnerId }, parent)) {
        throw new InvalidParentPolicyError();
      }
    }
    try {
      const [policy] = await tx.insert(configurationPolicies).values({
        orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
        name: data.name, description: data.description ?? null,
        status: data.status ?? 'active', createdBy: userId,
        parentPolicyId: data.parentPolicyId ?? null,
      }).returning();
      if (!policy) throw new Error('Failed to create configuration policy');
      return policy;
    } catch (err) {
      const code = pgErrorCode(err);
      const constraint = String((pgErrorNode(err) as { constraint_name?: string } | undefined)?.constraint_name ?? '');
      if ((code === '23503' && constraint === 'configuration_policies_parent_policy_id_fkey')
          || (code === '23514' && constraint.startsWith('configuration_policies_parent'))) {
        throw new InvalidParentPolicyError();
      }
      throw err;
    }
  });
}
```

(`pgErrorCode` / `pgErrorNode` come from `../utils/pgErrors`. If `pgErrorNode` does not expose `constraint_name` for Drizzle-wrapped errors, extend it there the way `isPgUniqueViolation` reads the constraint — do not hand-roll a second walker.)

`getConfigPolicy` — after `featureLinks`:

```ts
  let parentPolicy: { id: string; name: string; status: string; orgId: string | null; featureLinks: Awaited<ReturnType<typeof listFeatureLinks>> } | null = null;
  if (policy.parentPolicyId) {
    // Deliberately NOT through policyAccessCondition: that gate hides partner-wide
    // policies from org-scoped get/list so the org UI never offers to EDIT the
    // MSP's shared policies. This embed is read-only, exists only for a policy the
    // caller can already see, and the parent's rows are already SELECT-visible
    // under RLS (the same visibility the agent path relies on).
    const [parent] = await db.select({ id: configurationPolicies.id, name: configurationPolicies.name,
                                       status: configurationPolicies.status, orgId: configurationPolicies.orgId })
      .from(configurationPolicies).where(eq(configurationPolicies.id, policy.parentPolicyId)).limit(1);
    if (parent) parentPolicy = { ...parent, featureLinks: await listFeatureLinks(parent.id) };
  }
  const childPolicies = await db.select({ id: configurationPolicies.id, name: configurationPolicies.name })
    .from(configurationPolicies).where(eq(configurationPolicies.parentPolicyId, id)).orderBy(asc(configurationPolicies.name));
  return { ...policy, featureLinks, parentPolicy, childPolicies };
```

`listConfigPolicies`: confirm the row select includes `parentPolicyId` (it uses `getTableColumns` or an explicit list — if explicit, add `parentPolicyId: configurationPolicies.parentPolicyId`).

`deleteConfigPolicy` — between the ownership gate and the delete:

```ts
  const children = await db.select({ id: configurationPolicies.id, name: configurationPolicies.name })
    .from(configurationPolicies).where(eq(configurationPolicies.parentPolicyId, id));
  if (children.length > 0) throw new PolicyHasChildrenError(children);
  try {
    const [deleted] = await db.delete(configurationPolicies).where(and(...conditions)).returning();
    return deleted ?? null;
  } catch (err) {
    if (pgErrorCode(err) === '23503') throw new PolicyHasChildrenError([]); // race: child created after the check
    throw err;
  }
```

New functions:

```ts
export async function listEligibleParentPolicies(
  auth: AuthContext,
  sel: { ownerScope: 'organization'; orgId: string } | { ownerScope: 'partner' },
): Promise<{ id: string; name: string; ownerScope: 'organization' | 'partner' }[]> {
  const rootOnly = isNull(configurationPolicies.parentPolicyId);
  let where: SQL;
  if (sel.ownerScope === 'partner') {
    if (!auth.partnerId) return [];
    where = and(rootOnly, isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, auth.partnerId))!;
  } else {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
      .where(eq(organizations.id, sel.orgId)).limit(1);
    const own = eq(configurationPolicies.orgId, sel.orgId);
    where = org?.partnerId
      ? and(rootOnly, or(own, and(isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, org.partnerId))))!
      : and(rootOnly, own)!;
  }
  // Names only. RLS is the visibility authority here (an org token sees its
  // partner's partner-wide rows through the SELECT-only branch); the app-layer
  // filter above narrows to the ownership rule.
  const rows = await db.select({ id: configurationPolicies.id, name: configurationPolicies.name, orgId: configurationPolicies.orgId })
    .from(configurationPolicies).where(where).orderBy(asc(configurationPolicies.name));
  return rows.map(r => ({ id: r.id, name: r.name, ownerScope: r.orgId === null ? 'partner' : 'organization' }));
}

/** Feature types linked on a prospective parent (RLS read). Used by the MFA-by-effectiveness gate. */
export async function getParentLinkFeatureTypes(parentId: string): Promise<string[]> {
  const rows = await db.select({ featureType: configPolicyFeatureLinks.featureType })
    .from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, parentId));
  return rows.map(r => r.featureType);
}
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.inheritance.test.ts
git commit -m "feat(config-policy): service — parent validation, 409 on children, parent/children embeds, eligible parents"
```

---

### Task 6: Routes — POST with parent (+ MFA gate), DELETE 409, GET embeds, eligible-parents endpoint

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/crud.ts` (POST :52-152, DELETE :212-244; add `GET /eligible-parents` **before** `GET /:id`)
- Modify: `apps/api/src/routes/configurationPolicies/schemas.ts` (add `eligibleParentsQuerySchema`)
- Test: `apps/api/src/routes/configurationPolicies/crud.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 service functions and errors; `hasSatisfiedMfa` from `../../middleware/auth`; `MFA_GATED_FEATURE_TYPES` from `./featureLinks`.
- Produces: `GET /configuration-policies/eligible-parents?ownerScope=organization&orgId=<uuid>` | `?ownerScope=partner` → `{ data: { id, name, ownerScope }[] }`.

- [ ] **Step 1: Failing tests** (existing crud.test.ts harness)

```ts
it('POST with parentPolicyId passes it to createConfigPolicy', ...);           // expect service called with data.parentPolicyId
it('POST maps InvalidParentPolicyError to 400 INVALID_PARENT_POLICY', ...);
it('POST with a parent that has a maintenance link requires MFA (403)', ...);  // getParentLinkFeatureTypes → ['maintenance'], hasSatisfiedMfa false
it('DELETE maps PolicyHasChildrenError to 409 POLICY_HAS_CHILDREN with children', ...);
it('GET /eligible-parents (organization) requires canAccessOrg and returns names only', ...);
it('GET /eligible-parents (partner) requires partner scope', ...);
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

`schemas.ts`:

```ts
export const eligibleParentsQuerySchema = z.discriminatedUnion('ownerScope', [
  z.object({ ownerScope: z.literal('organization'), orgId: z.string().guid() }),
  z.object({ ownerScope: z.literal('partner') }),
]);
```

`crud.ts` POST — after the owner-scope checks and before either `createConfigPolicy` call:

```ts
    // MFA follows effectiveness: creating a child of a parent that carries a
    // patch/maintenance link makes that link effective on the new policy.
    if (data.parentPolicyId) {
      const parentTypes = await getParentLinkFeatureTypes(data.parentPolicyId);
      if (parentTypes.some((t) => MFA_GATED_FEATURE_TYPES.has(t)) && !hasSatisfiedMfa(auth)) {
        return c.json({ error: 'MFA required' }, 403);
      }
    }
```

Wrap both `createConfigPolicy(...)` calls: pass `data` through (it now carries `parentPolicyId`) and catch `InvalidParentPolicyError` → `return c.json({ error: 'INVALID_PARENT_POLICY', message: err.message }, 400)`. Add `parentPolicyId: policy.parentPolicyId ?? null` to the audit `details`.

DELETE — extend the catch:

```ts
      if (err instanceof PolicyHasChildrenError) {
        return c.json({ error: 'POLICY_HAS_CHILDREN', children: err.children }, 409);
      }
```

New route, placed **above** `GET /:id` so `eligible-parents` is not captured as an id:

```ts
crudRoutes.get(
  '/eligible-parents',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('query', eligibleParentsQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const sel = c.req.valid('query');
    if (sel.ownerScope === 'partner') {
      if (!auth.partnerId || auth.scope === 'organization') return c.json({ error: 'Partner scope required' }, 403);
    } else if (!auth.canAccessOrg(sel.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    return c.json({ data: await listEligibleParentPolicies(auth, sel) });
  }
);
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
git add apps/api/src/routes/configurationPolicies/crud.ts apps/api/src/routes/configurationPolicies/schemas.ts apps/api/src/routes/configurationPolicies/crud.test.ts
git commit -m "feat(config-policy): routes — create with parent, 409 on children, eligible-parents"
```

---

### Task 7: Feature-link DELETE — maintenance revert gate

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts:66-80` (comment), `:483` (gate)
- Test: `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` (append)

- [ ] **Step 1: Failing tests**

```ts
it('DELETE of a maintenance override whose parent has a maintenance link requires MFA', ...); // policy.parentPolicy.featureLinks has maintenance; hasSatisfiedMfa false → 403
it('DELETE of a maintenance link on a root policy stays ungated', ...);
it('DELETE of a patch link stays gated regardless of parent', ...);
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — replace line 483's condition:

```ts
    // Patch removal stays unconditionally gated. Maintenance removal used to be
    // exempt because removal ENDS suppression; with inheritance, removing a
    // child's maintenance override RESTORES the parent's window, so that one
    // transition is gated too (spec: MFA follows effectiveness).
    const parentHasSameType = !!policy.parentPolicy?.featureLinks?.some(
      (l: { featureType: string }) => l.featureType === existingLink.featureType,
    );
    const revertRestoresGatedParent = existingLink.featureType === 'maintenance' && parentHasSameType;
    if ((existingLink.featureType === 'patch' || revertRestoresGatedParent) && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }
```

Update the "REMOVAL IS DELIBERATELY NOT GATED" paragraph at lines 76-79 to state the exception.

- [ ] **Step 4: Run → PASS; commit**

```bash
git add apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts
git commit -m "feat(config-policy): gate maintenance-override revert when the parent has a window"
```

---

### Task 8: Export-policy registry + partner API shape

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:138` (add `"parent_policy_id"` to `included`)
- Modify: `apps/api/src/routes/partnerApi/configuration.ts:236-285` (`policySource`)
- Test: `apps/api/src/routes/partnerApi/configuration.test.ts` (existing; append) and the live suites in Task 12

- [ ] **Step 1: Failing test** — in `configuration.test.ts` assert the compiled `policySource` SQL contains `'parentPolicyId', cp.parent_policy_id` and a `parent_closure` CTE.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

Registry: append `"parent_policy_id"` to the `included` array of the `configuration_policies` entry, with a comment: `// parent_policy_id may point at a partner-wide parent outside an org export; there is no import path, documented in the spec`.

`policySource`: add `'parentPolicyId', cp.parent_policy_id,` to the `jsonb_build_object`, and include the parent closure so an unassigned baseline is exported alongside its children. Replace the `JOIN ( SELECT policy_id, org_id, ... FROM assignment_orgs GROUP BY policy_id, org_id ) ao` with:

```sql
    JOIN (
      SELECT policy_id, org_id, MAX(partner_export_updated_at) AS partner_export_updated_at,
             MAX(material_updated_at) AS material_updated_at
      FROM (
        SELECT policy_id, org_id, partner_export_updated_at, material_updated_at FROM assignment_orgs
        UNION ALL
        -- Parent closure: a child's parent is exported for the same org binding
        -- even when the parent has no assignment of its own.
        SELECT child.parent_policy_id AS policy_id, ao.org_id, ao.partner_export_updated_at, ao.material_updated_at
        FROM assignment_orgs ao
        JOIN public.configuration_policies child ON child.id = ao.policy_id
        WHERE child.parent_policy_id IS NOT NULL
      ) u GROUP BY policy_id, org_id
    ) ao ON ao.policy_id = cp.id
```

If the partner-API DTO in `packages/shared` (search `sourceScope` under `packages/shared/src`) is strict, add `parentPolicyId: z.string().uuid().nullable()`.

- [ ] **Step 4: Run → PASS; commit**

```bash
git add apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/partnerApi/configuration.ts apps/api/src/routes/partnerApi/configuration.test.ts
git commit -m "feat(config-policy): export classification + partner export parentPolicyId and parent closure"
```

---

### Task 9: Integration suite — ownership, triggers, view, delete, cascade

**Files:**
- Create: `apps/api/src/__tests__/integration/configPolicyInheritance.integration.test.ts`

**Interfaces:**
- Consumes: `withDbAccessContext`, `DbAccessContext` from `../../db`; the `partnerContext` / `orgContext` / `SYSTEM_CTX` helpers copied from `configPolicyPartnerWideSelect.integration.test.ts:80-110`; `createConfigPolicy`, `deleteConfigPolicy` from the service; `configPolicyEffectiveFeatureLinks` from the schema.

- [ ] **Step 1: Write the suite** (each `it` is one property; seed two partners P1/P2, orgs A1, A2 under P1, B1 under P2; clean up in `afterEach` under `SYSTEM_CTX`)

```ts
describe('config policy inheritance (live DB)', () => {
  it('org token: child of same-org parent and of own partner-wide parent succeed', ...);
  it('org token: parent in another org, another partner-wide, or a parent that has a parent → InvalidParentPolicyError', ...);
  it('forged insert as breeze_app bypassing the service: cross-org parent → 23514 configuration_policies_parent_guard', ...);
  it('UPDATE parent_policy_id NULL→value is rejected (configuration_policies_parent_immutable)', ...);
  it('UPDATE org_id outside system scope is rejected; in system scope with the whole family moving it succeeds at commit', ...);
  it('view: child sees own link for overridden type, parent link (inherited=true, parent link id) otherwise; parent sees only its own', ...);
  it('view under org context: partner-wide parent links are visible to the org child (partner_wide_select branch)', ...);
  it('view under agent-shaped context (currentPartnerId set): same visibility', ...);
  it('delete parent alone → PolicyHasChildrenError; delete child then parent → ok', ...);
  it('org cascade: single DELETE WHERE org_id removes parent and child together', ...);
});
```

For the forged insert use `withDbAccessContext(orgContext(A1, P1), () => db.execute(sql\`INSERT INTO configuration_policies (org_id, name, parent_policy_id) VALUES (...)\`))` and assert `pgErrorCode(err) === '23514'` and the constraint name. For the system-scope family move, run inside one `db.transaction` with `SET CONSTRAINTS ALL DEFERRED` and `set_config('breeze.scope','system',true)`, update the child's `org_id` first, then the parent's, then commit; assert both rows moved.

- [ ] **Step 2: Run it against the test stack**

Run: `pnpm test-stack up` (see `worktree-stack` skill) then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/configPolicyInheritance.integration.test.ts`
Expected: all PASS. Confirm in the output that the file **ran** (test count > 0), not skipped.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/configPolicyInheritance.integration.test.ts
git commit -m "test(config-policy): inheritance integration suite — ownership, triggers, view, delete, cascade"
```

---

### Task 10: AI tools and other `createConfigPolicy` callers compile-check

**Files:**
- Modify only if `tsc` demands: `apps/api/src/services/aiToolsConfigPolicy.ts`, `apps/api/src/scripts/migrateToConfigPolicies.ts`, `apps/api/src/routes/softwareInventory.ts` (`ensureDefaultConfigPolicyLink`)

- [ ] **Step 1:** `grep -rn "createConfigPolicy(" apps/api/src --include='*.ts' | grep -v test` and `grep -rn "deleteConfigPolicy(" ...`. For each caller confirm the new optional field and the new error do not change behaviour (AI tools do not pass `parentPolicyId`; callers of `deleteConfigPolicy` in AI tools must surface `PolicyHasChildrenError` as a tool error string, not a crash — add the `instanceof` branch where they already handle `PartnerWideWriteDeniedError`).
- [ ] **Step 2:** `cd apps/api && npx tsc --noEmit` → clean. Run `npx vitest run src/services/aiToolsConfigPolicy.test.ts`.
- [ ] **Step 3:** Commit if anything changed: `git commit -m "chore(config-policy): surface PolicyHasChildrenError in AI tool delete"`.

---

### Task 11: OpenAPI / docs touch (API only)

**Files:**
- Modify: the OpenAPI/route doc for configuration policies if one exists (`grep -rln "configuration-policies" apps/api/src/openapi apps/docs/src/content 2>/dev/null`); add `parentPolicyId` to the create body and the GET response, the `eligible-parents` endpoint, and the 409.

- [ ] **Step 1:** Make the doc edits (no code). W03 owns the user-facing docs page; this task is only the API reference if it is generated from or checked against source.
- [ ] **Step 2:** Commit: `git commit -m "docs(api): configuration policy inheritance fields and endpoints"`.

---

### Task 12: Live-DB contract suites, then PR

- [ ] **Step 1:** With the test stack up, run and confirm each **ran** and passed:

```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgMerge
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts src/__tests__/integration/configurationPoliciesPartnerRls.integration.test.ts
```

- [ ] **Step 2:** As `breeze_app`, forge a cross-tenant parent and confirm the failure (`docker exec -it <test-postgres> psql -U breeze_app -d breeze` → `INSERT ... parent_policy_id = <other org's policy>` → `23514`).
- [ ] **Step 3:** `pnpm --filter @breeze/api test --run src/routes/configurationPolicies src/services/configurationPolicy src/services/configPolicyOwnership` green; `pnpm lint`.
- [ ] **Step 4:** Merge `origin/main` into the branch, re-run Step 3, push, open the PR with `Closes #<wave sub-issue>`, run `pr-review-toolkit:review-pr`, fix confirmed findings inline, and **stop at the open PR** (orchestrator merges on green).
