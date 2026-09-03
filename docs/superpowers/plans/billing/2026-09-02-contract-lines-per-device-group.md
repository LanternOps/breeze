---
tracking_issue: LanternOps/breeze#3205
---

# Contract Lines Billed by Device Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `per_device_group` contract line type that bills the members of a device group, evaluating dynamic groups live at estimate and invoice time so a stale materialized membership can never be invoiced, and refusing to delete a group that a running contract bills.

**Architecture:** One new enum value and two columns on `contract_lines` (`device_group_id`, stamped `device_group_name`), guarded by a CHECK and two deferrable composite FKs. Membership comes from one read-only resolver in `groupMembership.ts` that the existing evaluator also uses. The wave 1 device snapshot becomes per-device so group membership, role and site compose in the pure helpers of `contractCoverage.ts`. All three group-delete surfaces call one transactional service that refuses while a draft/active/paused contract bills the group. Aggregate reads (list, MRR) degrade per contract instead of failing whole.

**Tech Stack:** Postgres 16, Drizzle ORM, Hono, Zod 4 (`z.string().guid()`), Vitest (unit + `vitest.integration.config.ts` real-DB suites), React + react-i18next (8 locales), Astro.

**Spec:** `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-group-design.md`

**Wave:** #3205 W02 (wave sub-issue #4648; feature request #4584). Branch from `main` after PR #4585 (wave 1) merges: `feature/3205-device-groups/wave-4648`.

## Global Constraints

- Migrations must sort after the newest committed file. Re-run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -1` before creating them; wave 1's `2026-10-05-100100-contract-lines-device-roles.sql` is the floor once #4585 merges. Use `2026-10-06-100000-…` and `2026-10-06-100100-…` unless something newer landed; then bump the date past it and keep the `-100000-` / `-100100-` time components.
- The enum value and any statement that references it must be in separate migration files (`autoMigrate` wraps each file in one transaction; Postgres refuses to use an enum value added in the same transaction).
- Migrations are idempotent (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add), no inner `BEGIN;`/`COMMIT;`.
- **Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`** (`orgLifecycleFoundations.integration.test.ts` merge contract).
- `contract_lines.device_group_id` and `device_group_name` go in the `included` bucket of `CORE_TENANT_EXPORT_POLICY`.
- Billing never reads a materialized dynamic membership and never writes membership rows. Dynamic groups are evaluated live through `resolveEffectiveGroupMembers`.
- A group line whose group cannot be evaluated throws `GROUP_EVALUATION_FAILED`; one whose group is gone resolves to quantity 0 with `unresolved: 'group_deleted'` on reads and throws `GROUP_DELETED` on generation. Never a silent zero.
- Every quantity for `per_device`, `per_device_role` and `per_device_group` lines on one contract comes from one `OrgDeviceSnapshot` per calculation, never from per-line `COUNT` queries. No cache is shared across the worker's per-contract transactions.
- Group lines carry no `site_id` (Zod and CHECK). The group's own `site_id` narrows billing to that site.
- Group deletion goes through `deleteDeviceGroup` on all three surfaces (`routes/groups.ts`, `routes/devices/groups.ts`, `aiToolsFleet.ts`).
- Run one test file with `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` with `DATABASE_URL` set to the test stack (`worktree-stack` skill, or `docker compose -f docker-compose.test.yml up -d` per `apps/api/vitest.integration.config.ts`).

---

## File map

| File | Change |
|---|---|
| `packages/shared/src/validators/contracts.ts` (+ `.test.ts`) | enum value, `deviceGroupId`, two-way refine |
| `apps/api/migrations/2026-10-06-100000-contract-line-type-per-device-group.sql` | enum value only |
| `apps/api/migrations/2026-10-06-100100-contract-lines-device-group.sql` | unique index, columns, CHECK, two composite FKs, partial index, preflight |
| `apps/api/src/db/schema/contracts.ts`, `devices.ts` | Drizzle mirror |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | two included columns |
| `apps/api/src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts` (new) | CHECK / FK / deferrable truth table |
| `apps/api/src/services/groupMembership.ts` (+ new `groupMembership.resolve.integration.test.ts` under `__tests__/integration/`) | `resolveEffectiveGroupMembers`, `GroupEvaluationError`, evaluator refactor |
| `apps/api/src/services/contractQuantities.ts` | per-device snapshot, `groupMembersForBilling` |
| `apps/api/src/services/contractCoverage.ts` (+ `.test.ts`) | `OrgDeviceSnapshot`, `GroupMembers`, group matching |
| `apps/api/src/services/contractTypes.ts` | three error codes, `unresolved` on estimate lines |
| `apps/api/src/services/contractService.ts` (+ `.test.ts`, `contractService.integration.test.ts`, new `contractDeviceGroups.integration.test.ts`) | cache/group resolution, quantities, estimate, generation, list/MRR isolation, writers, line mapper |
| `apps/api/src/services/deviceGroupDelete.ts` (new, + `deviceGroupDelete.integration.test.ts`) | transactional delete with billing refusal |
| `apps/api/src/routes/groups.ts`, `routes/devices/groups.ts`, `services/aiToolsFleet.ts` (+ tests) | call the delete service, 409 mapping |
| `apps/api/src/services/quoteToContract.ts`, `aiToolsContracts.ts` (+ tests) | spec type, guard, tool description |
| `apps/api/src/jobs/contractWorker.test.ts` | failure isolation case |
| `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` | group-line seed + assertions |
| `apps/web/src/lib/api/contracts.ts`, `components/contracts/lineTypes.ts`, `ContractEditor.tsx`, `ContractDetail.tsx`, `ContractsList.tsx`, `components/devices/DeviceGroupsPage.tsx` (+ tests) | group select, sub-labels, unresolved quantity, 409 modal |
| `apps/web/src/locales/*/billing.json`, `*/devices.json` | keys in 8 locales |
| `apps/docs/src/content/docs/features/contracts.mdx` | table row + notes |

---

### Task 1: Shared validators — `per_device_group` and `deviceGroupId`

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts:9-48`
- Test: `packages/shared/src/validators/contracts.test.ts` (append after the `per_device_role` describe, line 174)

**Interfaces:**
- Produces: `CONTRACT_LINE_TYPES` includes `'per_device_group'`; `ContractLineInput.deviceGroupId?: string` (GUID); the two-way rule `lineType === 'per_device_group' ⇔ deviceGroupId !== undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/validators/contracts.test.ts`:

```ts
// #3205 wave 2: a per_device_group line bills the members of one device group.
// deviceGroupId is required on that type and forbidden on every other; a group
// line carries no site (the group's own site narrows it) and no roles.
describe('contractLineInputSchema — per_device_group (#3205 W02)', () => {
  const base = { description: 'VIP laptops', unitPrice: '40.00', taxable: true };
  const groupId = '33333333-3333-4333-8333-333333333333';
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('requires a GUID deviceGroupId on per_device_group', () => {
    expect(parse({ ...base, lineType: 'per_device_group' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: 'not-a-guid' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: groupId })).toBe(true);
  });

  it('rejects deviceGroupId on every other line type', () => {
    for (const lineType of ['flat', 'per_device', 'per_seat'] as const) {
      expect(parse({ ...base, lineType, deviceGroupId: groupId })).toBe(false);
    }
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server'], deviceGroupId: groupId })).toBe(false);
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '2', deviceGroupId: groupId })).toBe(false);
  });

  it('rejects siteId and deviceRoles on a group line', () => {
    const siteId = '22222222-2222-4222-8222-222222222222';
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: groupId, siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: groupId, deviceRoles: ['server'] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: the first and third `it` fail (`per_device_group` is not a valid enum value yet).

- [ ] **Step 3: Implement**

In `packages/shared/src/validators/contracts.ts`:

```ts
export const CONTRACT_LINE_TYPES = ['flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual'] as const;
```

Add the field after `deviceRoles`:

```ts
  // #3205 W02: the device group a per_device_group line bills. Dynamic groups
  // are evaluated live at estimate/invoice time. No siteId on this type — the
  // group's own site narrows it (contract_lines_device_group_chk).
  deviceGroupId: z.string().guid().optional(),
```

Add a refine after the duplicate-roles refine:

```ts
).refine(
  (l) => (l.lineType === 'per_device_group') === (l.deviceGroupId !== undefined),
  { message: 'deviceGroupId is required on per_device_group lines and not allowed on other line types', path: ['deviceGroupId'] }
);
```

The existing `siteId` refine (`per_device | per_device_role` only) and the two-way `deviceRoles` refine already reject a site or roles on a group line; do not change them.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: PASS, including the wave 1 `per_device_role` describe.

- [ ] **Step 5: Typecheck downstream and commit**

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json && cd ../../apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: `apps/api` now fails on the two exhaustive `never` switches in `contractService.ts` (`resolveLineQty` and `generateDueInvoice`) with `Type '"per_device_group"' is not assignable to type 'never'`, plus `CoverageLine.lineType` / `NewContractLineSpec.lineType` union mismatches. That is the compiler enforcing Tasks 4, 5 and 7. Commit the shared package alone:

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts
git commit -m "feat(shared): per_device_group contract line type + deviceGroupId validator (#3205 W02)"
```

---

### Task 2: Migrations, Drizzle schema, export policy, constraint truth table

**Files:**
- Create: `apps/api/migrations/2026-10-06-100000-contract-line-type-per-device-group.sql`
- Create: `apps/api/migrations/2026-10-06-100100-contract-lines-device-group.sql`
- Modify: `apps/api/src/db/schema/contracts.ts:15-17, 57-80`; `apps/api/src/db/schema/devices.ts:422-434`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:148`
- Create: `apps/api/src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts`

**Interfaces:**
- Produces: `contract_lines.device_group_id uuid NULL`, `contract_lines.device_group_name varchar(255) NULL`; `contractLines.deviceGroupId`, `contractLines.deviceGroupName` in Drizzle; unique index `device_groups_id_org_id_uniq`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts`:

```ts
/**
 * Real-DB truth table for the #3205 W02 contract_lines device-group invariants,
 * as breeze_app (forced RLS, no bypass). Mirrors contractLinesDeviceRolesConstraints.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, contracts, deviceGroups } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `GP ${sfx}`, slug: `gp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'GA', slug: `ga-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'GB', slug: `gb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `A-${sfx}` }).returning({ id: sites.id });
    const [gA] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `Group A ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [gB] = await db.insert(deviceGroups).values({ orgId: oB!.id, name: `Group B ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [cA] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: 'CA', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgA: oA!.id, orgB: oB!.id, siteA: siteA!.id, groupA: gA!.id, groupB: gB!.id, contractA: cA!.id };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

function insertLine(f: F, opts: { lineType: string; orgId?: string; groupId?: string | null; groupName?: string | null; siteId?: string | null }) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_group_id, device_group_name, site_id)
    VALUES (${f.contractA}::uuid, ${opts.orgId ?? f.orgA}::uuid, ${opts.lineType}::contract_line_type, 'g', 1.00, false,
            ${opts.groupId ?? null}::uuid, ${opts.groupName ?? null}, ${opts.siteId ?? null}::uuid)
    RETURNING id
  `));
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

async function expectPgError(operation: () => Promise<unknown>, expected: { code: string; constraint?: string }): Promise<void> {
  try { await operation(); } catch (error) { expect(pgErrorFields(error)).toEqual(expected); return; }
  throw new Error(`expected PostgreSQL ${expected.code}`);
}

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CHK = { code: '23514', constraint: 'contract_lines_device_group_chk' };

describe('contract_lines device-group invariants (real DB) #3205 W02', () => {
  runDb('accepts a group line with id + stamped name, and a group line whose group is gone (NULL id, name kept)', async () => {
    const f = await seed();
    await expect(insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: 'Group A' })).resolves.toBeDefined();
    await expect(insertLine(f, { lineType: 'per_device_group', groupId: null, groupName: 'Deleted group' })).resolves.toBeDefined();
  });

  runDb('rejects a group line without a stamped name', async () => {
    const f = await seed();
    await expectPgError(() => insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: null }), CHK);
  });

  runDb('rejects a group line with a site_id', async () => {
    const f = await seed();
    await expectPgError(() => insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: 'Group A', siteId: f.siteA }), CHK);
  });

  runDb('rejects group columns on every other line type', async () => {
    const f = await seed();
    await expectPgError(() => insertLine(f, { lineType: 'flat', groupId: f.groupA, groupName: 'Group A' }), CHK);
    await expectPgError(() => insertLine(f, { lineType: 'per_device', groupName: 'Group A' }), CHK);
  });

  runDb('composite group FK rejects a group from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertLine(f, { lineType: 'per_device_group', groupId: f.groupB, groupName: 'Group B' }),
      { code: '23503', constraint: 'contract_lines_device_group_org_fk' },
    );
  });

  runDb('composite contract FK rejects a line whose org differs from its contract', async () => {
    const f = await seed();
    await expectPgError(
      () => insertLine(f, { lineType: 'flat', orgId: f.orgB }),
      { code: '23503', constraint: 'contract_lines_contract_org_fk' },
    );
  });

  runDb('deleting the group nulls device_group_id and keeps device_group_name', async () => {
    const f = await seed();
    await insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: 'Group A' });
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_groups WHERE id = ${f.groupA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT device_group_id, device_group_name FROM contract_lines WHERE contract_id = ${f.contractA}::uuid
    `));
    expect(rows).toEqual([{ device_group_id: null, device_group_name: 'Group A' }]);
  });

  runDb('both composite FKs are deferrable and the (id, org_id) unique index exists', async () => {
    await seed();
    const cons = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, condeferrable FROM pg_constraint
      WHERE conrelid = 'contract_lines'::regclass
        AND conname IN ('contract_lines_device_group_org_fk', 'contract_lines_contract_org_fk')
      ORDER BY conname
    `));
    expect(cons).toEqual([
      { conname: 'contract_lines_contract_org_fk', condeferrable: true },
      { conname: 'contract_lines_device_group_org_fk', condeferrable: true },
    ]);
    const idx = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'device_groups' AND indexname = 'device_groups_id_org_id_uniq'
    `));
    expect(idx).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts`
Expected: FAIL (`column "device_group_id" of relation "contract_lines" does not exist`).

- [ ] **Step 3: Write Migration A**

`apps/api/migrations/2026-10-06-100000-contract-line-type-per-device-group.sql`:

```sql
-- #3205 W02: contract lines billed by device group. Spec:
-- docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-group-design.md
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate
-- wraps each file in one — so every statement referencing 'per_device_group'
-- lives in 2026-10-06-100100-contract-lines-device-group.sql, not here.
-- (Precedent: 2026-10-05-100000-contract-line-type-per-device-role.sql.)

ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_group';
```

- [ ] **Step 4: Write Migration B**

`apps/api/migrations/2026-10-06-100100-contract-lines-device-group.sql`:

```sql
-- #3205 W02: contract lines billed by device group — columns, invariant, FKs.
-- Companion to 2026-10-06-100000-contract-line-type-per-device-group.sql (enum value).

-- Composite-FK target. device_groups has only its PK today; the (id, org_id)
-- pair is what lets a referencing row prove the group is in its own org.
CREATE UNIQUE INDEX IF NOT EXISTS device_groups_id_org_id_uniq ON device_groups (id, org_id);

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_group_id uuid;
-- Stamped at line creation. Survives group deletion (the FK nulls only the id)
-- so a terminated contract's line still says what it billed.
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_group_name varchar(255);

-- Exactly: group lines carry a stamped name and no site; every other type
-- carries neither group column. device_group_id may be NULL on a group line
-- only after its group was deleted (see the FK below). The DB twin of
-- contractLineInputSchema (packages/shared/src/validators/contracts.ts).
-- (contract_lines_device_roles_chk already forces device_roles to NULL here.)
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_chk CHECK (
  CASE WHEN line_type = 'per_device_group'
    THEN device_group_name IS NOT NULL AND site_id IS NULL
    ELSE device_group_id IS NULL AND device_group_name IS NULL END
);

-- ON DELETE SET NULL (device_group_id), not RESTRICT: lines on cancelled or
-- expired contracts cannot be removed (assertEditable), so RESTRICT would pin a
-- group forever once any terminated contract had billed it. The delete service
-- (services/deviceGroupDelete.ts) refuses while a draft/active/paused contract
-- bills the group; the FK only ever nulls lines of terminated contracts.
-- DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED
-- and re-points parent and child org_id in separate statements
-- (orgLifecycleFoundations.integration.test.ts, "merge contract").
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_org_fk
  FOREIGN KEY (device_group_id, org_id) REFERENCES device_groups (id, org_id)
  ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS contract_lines_device_group_id_idx
  ON contract_lines (device_group_id) WHERE device_group_id IS NOT NULL;

-- Contract/org chain. The single-column contract FK stays (Drizzle declares
-- it); this composite one proves the line's org_id is its contract's org_id,
-- because generation selects lines by contract_id alone.
-- contract_lines is ENABLE + FORCE ROW LEVEL SECURITY and autoMigrate sets no
-- scope, so without the system scope the preflight below would count 0 rows on
-- managed Postgres (non-superuser admin) and the FK would then abort boot on the
-- rows it never saw. is_local = true scopes it to this file's transaction.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM contract_lines cl JOIN contracts c ON c.id = cl.contract_id
    WHERE c.org_id <> cl.org_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract_lines: % row(s) carry an org_id that differs from their contract; repair by hand before applying this migration', n;
  END IF;
END $$;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_contract_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_contract_org_fk
  FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
```

- [ ] **Step 5: Drizzle schema**

`apps/api/src/db/schema/contracts.ts`:

```ts
export const contractLineTypeEnum = pgEnum('contract_line_type', [
  'flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual'
]);
```

In `contractLines`, after `deviceRoles`:

```ts
  // #3205 W02: the device group a per_device_group line bills. Composite FK
  // (device_group_id, org_id) -> device_groups(id, org_id) ON DELETE SET NULL
  // (device_group_id), and contract_lines_device_group_chk, are SQL-only like
  // the site FK above. NULL id + non-null name = the group was deleted after a
  // terminated contract billed it.
  deviceGroupId: uuid('device_group_id'),
  deviceGroupName: varchar('device_group_name', { length: 255 }),
```

In its extra config, after `contract_lines_org_idx`:

```ts
  // Real partial index (WHERE device_group_id IS NOT NULL) created in SQL.
  index('contract_lines_device_group_id_idx').on(t.deviceGroupId),
```

`apps/api/src/db/schema/devices.ts`, `deviceGroups` table: add an extra-config callback (the table has none today):

```ts
}, (table) => ({
  // Composite-FK target for contract_lines(device_group_id, org_id) (#3205 W02).
  // Created in SQL migration 2026-10-06-100100; declared here for db:check-drift.
  idOrgUnique: uniqueIndex('device_groups_id_org_id_uniq').on(table.id, table.orgId),
}));
```

(`uniqueIndex` is already imported in that file for `devices_id_org_id_uniq`.)

- [ ] **Step 6: Export policy**

`apps/api/src/services/tenantExportPolicyRegistry.ts`, the `contract_lines` row: add `"device_group_id","device_group_name"` to `included` after `"device_roles"`.

- [ ] **Step 7: Run migrations, drift, and the truth table**

Run:
```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
export DATABASE_URL=<test stack url> && pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
```
Expected: all PASS; drift clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-06-100000-contract-line-type-per-device-group.sql apps/api/migrations/2026-10-06-100100-contract-lines-device-group.sql apps/api/src/db/schema/contracts.ts apps/api/src/db/schema/devices.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts
git commit -m "feat(billing): contract_lines device group columns, CHECK, deferrable composite FKs (#3205 W02)"
```

---

### Task 3: Membership resolution — `resolveEffectiveGroupMembers`

**Files:**
- Modify: `apps/api/src/services/groupMembership.ts` (imports lines 1-6; `evaluateGroupMembership` lines 243-364)
- Create: `apps/api/src/__tests__/integration/groupMembership.resolve.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export type GroupForResolution = Pick<typeof deviceGroups.$inferSelect, 'id' | 'orgId' | 'type' | 'siteId' | 'filterConditions'>;
export class GroupEvaluationError extends Error { readonly groupId: string; readonly reason: 'invalid_filter' | 'engine_error'; }
export interface EffectiveGroupMembers { matched: ReadonlySet<string>; pinned: ReadonlySet<string>; }
export async function resolveEffectiveGroupMembers(group: GroupForResolution): Promise<EffectiveGroupMembers>;
```

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/groupMembership.resolve.integration.test.ts`:

```ts
/**
 * resolveEffectiveGroupMembers (#3205 W02): the one read-only definition of
 * "who is in this group" shared by the evaluator and by contract billing.
 * Real DB: the filter engine compiles to SQL and RLS shapes what each context sees.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships } from '../../db/schema';
import { GroupEvaluationError, resolveEffectiveGroupMembers } from '../../services/groupMembership';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `RP ${sfx}`, slug: `rp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'RA', slug: `ra-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'RB', slug: `rb-${sfx}` },
    ]).returning({ id: organizations.id });
    const orgId = oA!.id;
    const [sA, sB] = await db.insert(sites).values([{ orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` }]).returning({ id: sites.id });
    const dev = (agent: string, role: string, siteId: string, extra: Record<string, unknown> = {}) => ({
      orgId, siteId, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online', deviceRole: role,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [srvA, srvB, wsA, ephemeralSrv] = await db.insert(devices).values([
      dev('srv-a', 'server', sA!.id), dev('srv-b', 'server', sB!.id), dev('ws-a', 'workstation', sA!.id),
      dev('srv-eph', 'server', sA!.id, { isEphemeral: true }),
    ]).returning({ id: devices.id });
    const [otherOrgDev] = await db.insert(devices).values([{ ...dev('srv-other', 'server', sA!.id), orgId: oB!.id, siteId: null }]).returning({ id: devices.id });
    return { orgId, orgB: oB!.id, siteA: sA!.id, siteB: sB!.id, srvA: srvA!.id, srvB: srvB!.id, wsA: wsA!.id, ephemeralSrv: ephemeralSrv!.id, otherOrgDev: otherOrgDev!.id };
  });
}

async function group(orgId: string, values: Partial<typeof deviceGroups.$inferInsert>) {
  return withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups).values({ orgId, name: 'G', type: 'static', ...values }).returning();
    return g!;
  });
}

const member = (groupId: string, deviceId: string, orgId: string, isPinned = false) =>
  withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({ groupId, deviceId, orgId, isPinned }));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ids = (s: ReadonlySet<string>) => [...s].sort();

describe('resolveEffectiveGroupMembers (real DB) #3205 W02', () => {
  runDb('static: every membership row is matched, nothing pinned', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'static' });
    await member(g.id, f.wsA, f.orgId); await member(g.id, f.srvB, f.orgId);
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.srvB, f.wsA].sort());
    expect(r.pinned.size).toBe(0);
  });

  runDb('dynamic: live filter matches ∪ pinned; ephemeral excluded; a stale materialized row is NOT consulted', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await member(g.id, f.wsA, f.orgId, true);        // pinned workstation: kept
    await member(g.id, f.srvA, f.orgId);             // materialized server: also a live match
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE devices SET device_role = 'workstation' WHERE id = ${f.srvB}::uuid`));
    await member(g.id, f.srvB, f.orgId);             // stale row: srvB is no longer a server
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.srvA]);       // not srvB (stale), not ephemeral
    expect(ids(r.pinned)).toEqual([f.wsA]);
  });

  runDb('dynamic with NULL filter: pinned only', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: null });
    await member(g.id, f.wsA, f.orgId, true); await member(g.id, f.srvA, f.orgId);
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(r.matched.size).toBe(0);
    expect(ids(r.pinned)).toEqual([f.wsA]);
  });

  runDb('dynamic with malformed non-null filter throws GroupEvaluationError(invalid_filter)', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: { nope: true } });
    await expect(withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g)))
      .rejects.toMatchObject({ name: 'GroupEvaluationError', groupId: g.id, reason: 'invalid_filter' });
    expect(new GroupEvaluationError(g.id, 'invalid_filter')).toBeInstanceOf(Error);
  });

  runDb('site-bound dynamic group: filter matches only inside the site', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.srvA]);
  });

  runDb('a membership row carrying another org_id is ignored', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'static' });
    await member(g.id, f.wsA, f.orgId);
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id) VALUES (${f.otherOrgDev}::uuid, ${g.id}::uuid, ${f.orgB}::uuid)
    `));
    const r = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
    expect(ids(r.matched)).toEqual([f.wsA]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/groupMembership.resolve.integration.test.ts`
Expected: FAIL (`resolveEffectiveGroupMembers is not a function`).

- [ ] **Step 3: Implement the resolver**

In `apps/api/src/services/groupMembership.ts`, after `isFilterConditionGroup` (line 61):

```ts
export type GroupForResolution = Pick<typeof deviceGroups.$inferSelect, 'id' | 'orgId' | 'type' | 'siteId' | 'filterConditions'>;

/** Thrown by resolveEffectiveGroupMembers when a dynamic group cannot be evaluated.
 *  Billing maps it to GROUP_EVALUATION_FAILED; never to a zero count. */
export class GroupEvaluationError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly reason: 'invalid_filter' | 'engine_error',
    cause?: unknown,
  ) {
    super(`device group ${groupId}: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'GroupEvaluationError';
  }
}

export interface EffectiveGroupMembers {
  /** What the group's definition selects: live filter matches (dynamic) or every row (static). */
  matched: ReadonlySet<string>;
  /** Pinned rows of a dynamic group (empty for static). The evaluator keeps them even when the filter no longer matches. */
  pinned: ReadonlySet<string>;
}

const SLOW_GROUP_EVALUATION_MS = 250;

/**
 * The one read-only definition of "who is in this group" (#3205 W02). Used by
 * evaluateGroupMembership (which then diffs and writes) and by contract billing
 * (which never writes). Every membership read predicates on group_id AND the
 * group's own org_id: the membership table's RLS is org-only, so a forged row
 * carrying another org_id and this group's id is visible to the system context.
 *
 * - static: matched = all rows, pinned = ∅
 * - dynamic, filter_conditions NULL: matched = ∅, pinned = pinned rows
 * - dynamic, malformed non-null filter: throws GroupEvaluationError('invalid_filter')
 * - dynamic, valid filter: matched = live evaluateFilter within the group's site,
 *   pinned = pinned rows; an engine error/timeout throws GroupEvaluationError('engine_error')
 */
export async function resolveEffectiveGroupMembers(group: GroupForResolution): Promise<EffectiveGroupMembers> {
  const rows = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, group.id), eq(deviceGroupMemberships.orgId, group.orgId)));

  if (group.type !== 'dynamic') {
    return { matched: new Set(rows.map((r) => r.deviceId)), pinned: new Set() };
  }
  const pinned = new Set(rows.filter((r) => r.isPinned).map((r) => r.deviceId));
  if (group.filterConditions === null || group.filterConditions === undefined) {
    return { matched: new Set(), pinned };
  }
  if (!isFilterConditionGroup(group.filterConditions)) {
    throw new GroupEvaluationError(group.id, 'invalid_filter');
  }
  const started = Date.now();
  let matched: Set<string>;
  try {
    const result = await evaluateFilter(group.filterConditions, {
      orgId: group.orgId,
      allowedSiteIds: group.siteId ? [group.siteId] : null,
    });
    matched = new Set(result.deviceIds);
  } catch (err) {
    throw new GroupEvaluationError(group.id, 'engine_error', err);
  }
  const ms = Date.now() - started;
  if (ms > SLOW_GROUP_EVALUATION_MS) {
    console.warn(`[groupMembership] slow filter evaluation for group ${group.id} (org ${group.orgId}): ${ms}ms`);
  }
  return { matched, pinned };
}
```

- [ ] **Step 4: Refactor `evaluateGroupMembership` to use it (behaviour unchanged)**

Replace lines 270-284 (from `const filterResults = await evaluateFilter(...)` through `const currentIds = ...`) with:

```ts
  const { matched: matchingIds, pinned: pinnedIds } = await resolveEffectiveGroupMembers(group);

  const currentMemberships = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, group.orgId)));

  const currentIds = new Set(currentMemberships.map(row => row.deviceId));
```

Keep every later statement as it is; where the verification block adds pinned rows to `expected`, it may keep iterating `currentMemberships` (same set as `pinnedIds`). The early returns before this point (`!group`, non-dynamic, invalid filter → return unchanged) stay exactly as they are, so the evaluator's behaviour on malformed filters does not change; only billing (Task 5) treats a malformed filter as an error.

- [ ] **Step 5: Run the new suite plus every existing evaluator suite**

Run:
```bash
cd apps/api && npx vitest run src/services/groupMembership.materialization.test.ts src/services/groupMembership.siteScope.test.ts src/services/groupMembership.manualMembership.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/groupMembership.resolve.integration.test.ts src/__tests__/integration/dynamicGroupMembershipMaterialization.integration.test.ts
```
Expected: all PASS with no test edits. If a mocked unit suite fails because it stubs `db.select` in a fixed call order, the membership read moved earlier — update that suite's mock order only, never its assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/groupMembership.ts apps/api/src/__tests__/integration/groupMembership.resolve.integration.test.ts
git commit -m "feat(groups): resolveEffectiveGroupMembers — one read-only membership definition (#3205 W02)"
```

---

### Task 4: Counting — per-device snapshot, group members, pure helpers

**Files:**
- Modify: `apps/api/src/services/contractQuantities.ts:46-63`
- Modify: `apps/api/src/services/contractCoverage.ts` (whole file)
- Modify: `apps/api/src/services/contractCoverage.test.ts` (whole file)
- Modify: any test that builds `DeviceSnapshotRow` with `n` — find with `grep -rln "siteId: .*, n: " apps/api/src --include='*.test.ts'` (expected: `contractCoverage.test.ts`, `contractService.test.ts`, `contractDeviceRoles.integration.test.ts`); convert fixtures to per-device rows in this task.

**Interfaces:**
- Produces:

```ts
// contractQuantities.ts
export interface DeviceSnapshotRow { id: string; role: string; siteId: string | null }
export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]>
export async function groupMembersForBilling(group: GroupForResolution): Promise<GroupMembers>
// contractCoverage.ts
export interface GroupMembers { siteId: string | null; memberIds: ReadonlySet<string> }
export interface OrgDeviceSnapshot { devices: readonly DeviceSnapshotRow[]; groups: ReadonlyMap<string, GroupMembers> }
export interface CoverageLine { lineType: ContractLineType; siteId: string | null; deviceRoles: readonly string[] | null; deviceGroupId: string | null }
export function isDeviceLine(line): boolean            // per_device | per_device_role | per_device_group
export function quantityFor(snapshot: OrgDeviceSnapshot, line: CoverageLine): number
export function uncoveredByRole(snapshot: OrgDeviceSnapshot, lines: readonly CoverageLine[]): UncoveredDevices
```

- [ ] **Step 1: Rewrite `contractCoverage.test.ts` against the per-device shape (failing)**

Replace the file with:

```ts
import { describe, it, expect } from 'vitest';
import { isDeviceLine, quantityFor, uncoveredByRole, type CoverageLine, type OrgDeviceSnapshot } from './contractCoverage';
import type { DeviceSnapshotRow } from './contractQuantities';

const A = 'site-a';
const B = 'site-b';
// One org: 2 workstations at A, 1 at B; 1 server at A; 1 switch at B; 1 unknown at A.
const devices: DeviceSnapshotRow[] = [
  { id: 'ws1', role: 'workstation', siteId: A },
  { id: 'ws2', role: 'workstation', siteId: A },
  { id: 'ws3', role: 'workstation', siteId: B },
  { id: 'srv1', role: 'server', siteId: A },
  { id: 'sw1', role: 'switch', siteId: B },
  { id: 'unk1', role: 'unknown', siteId: A },
];
const G_VIP = 'group-vip';       // ws1, srv1, and a decommissioned device not in the snapshot
const G_SITE_B = 'group-site-b'; // site-bound to B; members ws3 and (off-site) ws1
const snapshot: OrgDeviceSnapshot = {
  devices,
  groups: new Map([
    [G_VIP, { siteId: null, memberIds: new Set(['ws1', 'srv1', 'decommissioned-x']) }],
    [G_SITE_B, { siteId: B, memberIds: new Set(['ws3', 'ws1']) }],
  ]),
};
const line = (p: Partial<CoverageLine> & Pick<CoverageLine, 'lineType'>): CoverageLine =>
  ({ siteId: null, deviceRoles: null, deviceGroupId: null, ...p });

describe('isDeviceLine', () => {
  it('is true only for the three device-counted types', () => {
    for (const lineType of ['per_device', 'per_device_role', 'per_device_group'] as const) expect(isDeviceLine({ lineType })).toBe(true);
    for (const lineType of ['flat', 'per_seat', 'manual'] as const) expect(isDeviceLine({ lineType })).toBe(false);
  });
});

describe('quantityFor', () => {
  it.each<[string, CoverageLine, number]>([
    ['per_device org-wide counts every device', line({ lineType: 'per_device' }), 6],
    ['per_device scoped to a site', line({ lineType: 'per_device', siteId: A }), 4],
    ['per_device_role single role', line({ lineType: 'per_device_role', deviceRoles: ['server'] }), 1],
    ['per_device_role role set', line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }), 4],
    ['per_device_role scoped to a site', line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['workstation', 'switch'] }), 2],
    ['per_device_role with no matching devices', line({ lineType: 'per_device_role', deviceRoles: ['printer'] }), 0],
    ['per_device_group counts members present in the billable snapshot only', line({ lineType: 'per_device_group', deviceGroupId: G_VIP }), 2],
    ['per_device_group site-bound group ignores an off-site member', line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }), 1],
  ])('%s', (_name, l, expected) => {
    expect(quantityFor(snapshot, l)).toBe(expected);
  });

  it('throws for a non-device line type', () => {
    expect(() => quantityFor(snapshot, line({ lineType: 'flat' }))).toThrow(/not a device-counted/);
  });

  it('throws when a group line names a group missing from the snapshot, or no group at all', () => {
    expect(() => quantityFor(snapshot, line({ lineType: 'per_device_group', deviceGroupId: 'nope' }))).toThrow(/group nope is not in the snapshot/);
    expect(() => quantityFor(snapshot, line({ lineType: 'per_device_group' }))).toThrow(/without a device group/);
  });

  it('an empty group counts zero', () => {
    const s: OrgDeviceSnapshot = { devices, groups: new Map([['empty', { siteId: null, memberIds: new Set() }]]) };
    expect(quantityFor(s, line({ lineType: 'per_device_group', deviceGroupId: 'empty' }))).toBe(0);
  });

  it.each([['null', null], ['empty', []]] as const)('throws when a per_device_role line has %s device roles', (_n, deviceRoles) => {
    expect(() => quantityFor(snapshot, line({ lineType: 'per_device_role', deviceRoles }))).toThrow(/without device roles/);
  });
});

describe('uncoveredByRole', () => {
  it('reports every device when only non-device lines exist', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'flat' })])).toEqual({
      total: 6, byRole: { workstation: 3, server: 1, switch: 1, unknown: 1 },
    });
  });

  it('reports nothing when an unscoped per_device line exists', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device' })])).toEqual({ total: 0, byRole: {} });
  });

  it('a site-scoped per_device line leaves the other site uncovered', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device', siteId: A })])).toEqual({ total: 2, byRole: { workstation: 1, switch: 1 } });
  });

  it('role lines cover only their roles; unknown is always uncovered', () => {
    const lines = [
      line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('a group line covers its billable members; a device on a group line and a role line is covered once', () => {
    const lines = [
      line({ lineType: 'per_device_group', deviceGroupId: G_VIP }),          // ws1, srv1
      line({ lineType: 'per_device_role', deviceRoles: ['server'] }),         // srv1 again
    ];
    expect(quantityFor(snapshot, lines[0]!) + quantityFor(snapshot, lines[1]!)).toBe(3); // billed on both
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 4, byRole: { workstation: 2, switch: 1, unknown: 1 } });
  });

  it('a site-bound group does not cover its off-site member', () => {
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B })])).toEqual({
      total: 5, byRole: { workstation: 2, server: 1, switch: 1, unknown: 1 },
    });
  });

  it('an empty group leaves everything uncovered', () => {
    const s: OrgDeviceSnapshot = { devices, groups: new Map([['empty', { siteId: null, memberIds: new Set() }]]) };
    expect(uncoveredByRole(s, [line({ lineType: 'per_device_group', deviceGroupId: 'empty' })]).total).toBe(6);
  });

  it('empty inventory is zero, not an error', () => {
    const s: OrgDeviceSnapshot = { devices: [], groups: new Map() };
    expect(uncoveredByRole(s, [line({ lineType: 'per_device_role', deviceRoles: ['server'] })])).toEqual({ total: 0, byRole: {} });
  });

  it.each([['null', null], ['empty', []]] as const)('throws for %s device roles even when inventory is empty', (_n, deviceRoles) => {
    const s: OrgDeviceSnapshot = { devices: [], groups: new Map() };
    expect(() => uncoveredByRole(s, [line({ lineType: 'per_device_role', deviceRoles })])).toThrow(/without device roles/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts`
Expected: FAIL (type errors on `OrgDeviceSnapshot`, `deviceGroupId`; runtime failures on group cases).

- [ ] **Step 3: Implement `contractQuantities.ts`**

Replace `DeviceSnapshotRow` and `snapshotContractDevices` (lines 46-63) with:

```ts
export interface DeviceSnapshotRow {
  id: string;
  role: string;
  siteId: string | null;
}

/** One snapshot of the org's billable devices, one row per device. Every
 *  device-counted quantity on a contract — and the coverage warning — derives
 *  from this single query, so a device reclassified between two per-line COUNTs
 *  can no longer be billed twice (or not at all) on the same invoice (#3205).
 *  Per-device (not grouped) since W02: group membership, role and site compose
 *  per device in contractCoverage. */
export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]> {
  return db
    .select({ id: devices.id, role: devices.deviceRole, siteId: devices.siteId })
    .from(devices)
    .where(and(...billableDeviceConds(orgId)));
}

/** Members of one group as billing sees them: matched ∪ pinned from the shared
 *  resolver. The intersection with the billable snapshot happens in
 *  contractCoverage (it iterates snapshot rows), so a decommissioned, ephemeral
 *  or moved-out device never counts whatever table or filter produced it.
 *  Throws GroupEvaluationError; the service maps it to GROUP_EVALUATION_FAILED. */
export async function groupMembersForBilling(group: GroupForResolution): Promise<GroupMembers> {
  const { matched, pinned } = await resolveEffectiveGroupMembers(group);
  return { siteId: group.siteId, memberIds: new Set([...matched, ...pinned]) };
}
```

Imports at the top of the file:

```ts
import { resolveEffectiveGroupMembers, type GroupForResolution } from './groupMembership';
import type { GroupMembers } from './contractCoverage';
```

(`count` is still used by `countContractDevices`; `countDistinct` by seats. Remove nothing else.)

- [ ] **Step 4: Implement `contractCoverage.ts`**

Replace the file with:

```ts
/**
 * Pure arithmetic over one org device snapshot (#3205). No DB, no I/O — the
 * service fetches the snapshot once (devices + the members of every group the
 * contract bills) and every device-counted line and the coverage warning are
 * computed here from that same snapshot.
 */
import type { ContractLineType } from '@breeze/shared';
import type { DeviceSnapshotRow } from './contractQuantities';

/** Members of one billed group. `siteId` is the GROUP's site (null = org-wide):
 *  billing counts a member only when its device is at that site. */
export interface GroupMembers {
  siteId: string | null;
  memberIds: ReadonlySet<string>;
}

export interface OrgDeviceSnapshot {
  devices: readonly DeviceSnapshotRow[];
  /** groupId -> members, for every group any line on the contract bills (matched ∪ pinned). */
  groups: ReadonlyMap<string, GroupMembers>;
}

/** The subset of a contract_lines row that coverage math needs. */
export interface CoverageLine {
  lineType: ContractLineType;
  siteId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroupId: string | null;
}

export interface UncoveredDevices {
  total: number;
  /** role -> count of billable devices no line on the contract bills. */
  byRole: Record<string, number>;
}

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return line.lineType === 'per_device' || line.lineType === 'per_device_role' || line.lineType === 'per_device_group';
}

function assertResolvable(line: CoverageLine, snapshot: OrgDeviceSnapshot): void {
  if (line.lineType === 'per_device_role' && (!line.deviceRoles || line.deviceRoles.length === 0)) {
    throw new Error('contractCoverage: per_device_role line without device roles');
  }
  if (line.lineType === 'per_device_group') {
    if (!line.deviceGroupId) throw new Error('contractCoverage: per_device_group line without a device group');
    if (!snapshot.groups.has(line.deviceGroupId)) throw new Error(`contractCoverage: group ${line.deviceGroupId} is not in the snapshot`);
  }
}

function lineMatches(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): boolean {
  if (line.siteId !== null && line.siteId !== row.siteId) return false;
  switch (line.lineType) {
    case 'per_device': return true;
    case 'per_device_role': return !!line.deviceRoles && line.deviceRoles.includes(row.role);
    case 'per_device_group': {
      const g = snapshot.groups.get(line.deviceGroupId!)!;
      return g.memberIds.has(row.id) && (g.siteId === null || g.siteId === row.siteId);
    }
    default: return false;
  }
}

/** Quantity for a device-counted line. Throws for any other type: the caller's
 *  switch is exhaustive and must not route flat/seat/manual here. */
export function quantityFor(snapshot: OrgDeviceSnapshot, line: CoverageLine): number {
  assertResolvable(line, snapshot);
  if (!isDeviceLine(line)) throw new Error(`quantityFor: ${line.lineType} is not a device-counted line type`);
  let n = 0;
  for (const row of snapshot.devices) if (lineMatches(line, row, snapshot)) n += 1;
  return n;
}

/** Billable devices that NO device-counted line on the contract bills, by role.
 *  Site scoping is exact; a site-bound group covers only members at its site;
 *  'unknown' rows can only be covered by a per_device line or a group. */
export function uncoveredByRole(snapshot: OrgDeviceSnapshot, lines: readonly CoverageLine[]): UncoveredDevices {
  for (const line of lines) assertResolvable(line, snapshot);
  const deviceLines = lines.filter(isDeviceLine);
  const byRole: Record<string, number> = {};
  let total = 0;
  for (const row of snapshot.devices) {
    if (deviceLines.some((l) => lineMatches(l, row, snapshot))) continue;
    byRole[row.role] = (byRole[row.role] ?? 0) + 1;
    total += 1;
  }
  return { total, byRole };
}
```

- [ ] **Step 5: Convert the other fixtures**

In every file found by `grep -rln "siteId: .*, n: " apps/api/src --include='*.test.ts'`, rewrite `{ role, siteId, n: k }` rows as `k` per-device rows with distinct ids, and pass `{ devices, groups: new Map() }` wherever a bare array was passed to `quantityFor` / `uncoveredByRole`. `contractDeviceRoles.integration.test.ts` asserts on `snapshotContractDevices` results: change its expectations from grouped counts to sorted `{ id, role, siteId }` rows (same devices, same predicates).

- [ ] **Step 6: Run**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v contractService | head`
Expected: coverage tests PASS; remaining tsc errors are only in `contractService.ts` (Task 5) and `quoteToContract.ts` / `aiToolsContracts.ts` (Task 7).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/contractQuantities.ts apps/api/src/services/contractCoverage.ts apps/api/src/services/contractCoverage.test.ts $(grep -rln "OrgDeviceSnapshot\|siteId: null }" apps/api/src --include='*.test.ts')
git commit -m "feat(billing): per-device snapshot + group membership in coverage helpers (#3205 W02)"
```

---

### Task 5: Service — group resolution, quantities, estimate, generation, list/MRR isolation, writers, line mapper

**Files:**
- Modify: `apps/api/src/services/contractTypes.ts:32-50` (error codes) and the `ContractEstimate` line type in the same file (grep `lines: Array<{ lineId`)
- Modify: `apps/api/src/services/contractService.ts` — imports (`:1-37`), cache + `resolveLineQty` (`:185-250`), `getContract` (`:135-142`), `listContracts` (`:144-184`), `computeContractEstimate` (`:263-281`), MRR (`:358-450`), `addContractLineToContract` (`:866-913`), `generateDueInvoice` (`:1055-1189`), `createContractWithLinesDetailed` (`:1205-1271`)
- Test: `apps/api/src/services/contractService.test.ts` (unit, mocked db), `apps/api/src/__tests__/integration/contractService.integration.test.ts`, create `apps/api/src/__tests__/integration/contractDeviceGroups.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 `GroupEvaluationError`, `GroupForResolution`; Task 4 `OrgDeviceSnapshot`, `GroupMembers`, `groupMembersForBilling`, `quantityFor`, `uncoveredByRole`.
- Produces: `ContractServiceErrorCode` + `'GROUP_NOT_IN_ORG' | 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED'`; `resolveLineQty` returns `{ quantity, live, unresolved?: 'group_deleted' }`; estimate lines carry `unresolved?`; `listContracts` rows carry `estimatedPeriodValue: string | null` and `estimateError?: 'GROUP_EVALUATION_FAILED'`; line reads carry `deviceGroup: { id, name, type } | null`; `assertGroupInOrg(tx, groupId, orgId)` returns `{ id, name, type, siteId }`.

- [ ] **Step 1: Write the failing headline integration test**

Create `apps/api/src/__tests__/integration/contractDeviceGroups.integration.test.ts`:

```ts
/**
 * #3205 W02 acceptance bar: billing a device group counts the LIVE membership,
 * never the materialized table, and the estimate (request context) agrees with
 * generation (system context). Real Postgres as breeze_app.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships,
  contracts, contractLines, contractBillingPeriods, invoices,
} from '../../db/schema';
import { evaluateGroupMembership } from '../../services/groupMembership';
import { computeContractEstimate, generateDueInvoice, listContracts, addContractLineToContract } from '../../services/contractService';
import { ContractServiceError, type ContractActor } from '../../services/contractTypes';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `BP ${sfx}`, slug: `bp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'BO', slug: `bo-${sfx}` }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [sA] = await db.insert(sites).values({ orgId, name: `A-${sfx}` }).returning({ id: sites.id });
    const dev = (agent: string, role: string, extra: Record<string, unknown> = {}) => ({
      orgId, siteId: sA!.id, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online', deviceRole: role,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [s1, s2, w1, decom, eph] = await db.insert(devices).values([
      dev('s1', 'server'), dev('s2', 'server'), dev('w1', 'workstation'),
      dev('decom', 'server', { status: 'decommissioned' }), dev('eph', 'server', { isEphemeral: true }),
    ]).returning({ id: devices.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId, name: 'Group contract', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    const actor: ContractActor = { userId: null, partnerId: p!.id, accessibleOrgIds: [orgId], permissions: null } as unknown as ContractActor;
    return { orgId, partnerId: p!.id, siteA: sA!.id, s1: s1!.id, s2: s2!.id, w1: w1!.id, decom: decom!.id, eph: eph!.id, contractId: c!.id, actor };
  });
}

async function addGroup(orgId: string, values: Partial<typeof deviceGroups.$inferInsert>) {
  return withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups).values({ orgId, name: `G ${Math.random().toString(36).slice(2, 6)}`, type: 'static', ...values }).returning();
    return g!;
  });
}

async function addGroupLine(f: Awaited<ReturnType<typeof seed>>, groupId: string, groupName: string) {
  return withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, lineType: 'per_device_group', description: 'Group', unitPrice: '10.00',
    taxable: false, deviceGroupId: groupId, deviceGroupName: groupName,
  }).returning({ id: contractLines.id }));
}

const runDb = it.runIf(!!process.env.DATABASE_URL);
const requestCtx = (f: Awaited<ReturnType<typeof seed>>) => ({ scope: 'partner' as const, partnerId: f.partnerId, orgId: null, userId: null, accessibleOrgIds: [f.orgId] });

describe('per_device_group billing (real DB) #3205 W02', () => {
  runDb('HEADLINE: a stale materialized dynamic membership is never billed; estimate and generation agree', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => evaluateGroupMembership(g.id));       // materializes s1, s2
    // s2 stops being a server WITHOUT any group re-evaluation (the #4630 gap).
    await withSystemDbAccessContext(() => db.update(devices).set({ deviceRole: 'workstation' }).where(eq(devices.id, f.s2)));
    const rows = await withSystemDbAccessContext(() => db.select().from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, g.id)));
    expect(rows.map((r) => r.deviceId).sort()).toEqual([f.s1, f.s2].sort());     // table is stale: still says 2
    await addGroupLine(f, g.id, g.name);

    const est = await withDbAccessContext(requestCtx(f) as never, () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]).toMatchObject({ lineType: 'per_device_group', quantity: 1, live: true });

    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    expect(gen.generated).toBe(true);
    const [inv] = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT quantity FROM invoice_lines WHERE invoice_id = ${gen.invoiceId}::uuid
    `)) as Array<{ quantity: string }>;
    expect(Number(inv!.quantity)).toBe(1);
  });

  runDb('static group ∩ billable: decommissioned and ephemeral members do not count', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'static' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values([
      { groupId: g.id, deviceId: f.s1, orgId: f.orgId }, { groupId: g.id, deviceId: f.decom, orgId: f.orgId }, { groupId: g.id, deviceId: f.eph, orgId: f.orgId },
    ]));
    await addGroupLine(f, g.id, g.name);
    const est = await withDbAccessContext(requestCtx(f) as never, () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]!.quantity).toBe(1);
    expect(est.uncoveredDevices).toEqual({ total: 2, byRole: { server: 1, workstation: 1 } }); // s2, w1
  });

  runDb('a pinned member outside the filter counts; a member outside a site-bound group\'s site does not', async () => {
    const f = await seed();
    const [sB] = await withSystemDbAccessContext(() => db.insert(sites).values({ orgId: f.orgId, name: 'B' }).returning({ id: sites.id }));
    await withSystemDbAccessContext(() => db.update(devices).set({ siteId: sB!.id }).where(eq(devices.id, f.s2)));
    const g = await addGroup(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER }); // matches s1 only (s2 is at B)
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values([
      { groupId: g.id, deviceId: f.w1, orgId: f.orgId, isPinned: true },   // pinned workstation at A: counts
      { groupId: g.id, deviceId: f.s2, orgId: f.orgId, isPinned: true },   // pinned server at B: off-site, ignored
    ]));
    await addGroupLine(f, g.id, g.name);
    const est = await withDbAccessContext(requestCtx(f) as never, () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]!.quantity).toBe(2); // s1 + w1
  });

  runDb('a malformed filter fails generation loudly and rolls everything back; the list degrades per contract', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'dynamic', filterConditions: { broken: true } });
    await addGroupLine(f, g.id, g.name);
    await expect(withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z')))))
      .rejects.toMatchObject({ code: 'GROUP_EVALUATION_FAILED', status: 500, details: { groupId: g.id, reason: 'invalid_filter' } });
    const invs = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(invs).toHaveLength(0);
    const periods = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractId)));
    expect(periods).toHaveLength(0);
    const [c] = await withSystemDbAccessContext(() => db.select().from(contracts).where(eq(contracts.id, f.contractId)));
    expect(c!.nextBillingAt).toBe('2026-07-01');
    await expect(withDbAccessContext(requestCtx(f) as never, () => computeContractEstimate(f.contractId, f.actor))).rejects.toBeInstanceOf(ContractServiceError);
    const list = await withDbAccessContext(requestCtx(f) as never, () => listContracts({ orgId: f.orgId }, f.actor));
    expect(list[0]).toMatchObject({ id: f.contractId, estimatedPeriodValue: null, estimateError: 'GROUP_EVALUATION_FAILED' });
  });

  runDb('a deleted group: estimate shows unresolved, generation refuses with GROUP_DELETED', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'static' });
    await addGroupLine(f, g.id, g.name);
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_groups WHERE id = ${g.id}::uuid`));
    const est = await withDbAccessContext(requestCtx(f) as never, () => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]).toMatchObject({ quantity: 0, unresolved: 'group_deleted' });
    await expect(withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z')))))
      .rejects.toMatchObject({ code: 'GROUP_DELETED', status: 409 });
  });

  runDb('writer stamps the group name and rejects a group from another org', async () => {
    const f = await seed();
    const g = await addGroup(f.orgId, { type: 'static', name: 'VIP' });
    const other = await seed();
    const foreign = await addGroup(other.orgId, { type: 'static' });
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'draft' }).where(eq(contracts.id, f.contractId)));
    const line = await withDbAccessContext(requestCtx(f) as never, () => addContractLineToContract(f.contractId,
      { lineType: 'per_device_group', description: 'VIP', unitPrice: '5.00', taxable: false, deviceGroupId: g.id }, f.actor));
    expect(line).toMatchObject({ deviceGroupId: g.id, deviceGroupName: 'VIP', siteId: null });
    await expect(withDbAccessContext(requestCtx(f) as never, () => addContractLineToContract(f.contractId,
      { lineType: 'per_device_group', description: 'X', unitPrice: '5.00', taxable: false, deviceGroupId: foreign.id }, f.actor)))
      .rejects.toMatchObject({ code: 'GROUP_NOT_IN_ORG', status: 400 });
  });
});
```

Adjust `ContractActor` construction and `withDbAccessContext` arguments to match how `contractService.integration.test.ts` builds them (`seedOrg()` there returns a real actor; copy that shape). The assertions are the contract; the fixture plumbing follows the sibling file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractDeviceGroups.integration.test.ts`
Expected: FAIL (tsc errors and/or `Unknown contract line type: per_device_group`).

- [ ] **Step 3: Error codes and estimate line type (`contractTypes.ts`)**

Add to `ContractServiceErrorCode`:

```ts
  // #3205 W02: a line's deviceGroupId names a group owned by a different organization.
  | 'GROUP_NOT_IN_ORG'
  // #3205 W02: a dynamic group's filter could not be evaluated (malformed, engine
  // error, 500 ms timeout). Never a zero count — generation aborts, list degrades.
  | 'GROUP_EVALUATION_FAILED'
  // #3205 W02: a per_device_group line whose group was deleted (device_group_id
  // NULL). Reads show it unresolved; generation refuses.
  | 'GROUP_DELETED'
```

In the `ContractEstimate` interface, the `lines` element gains `unresolved?: 'group_deleted'`.

- [ ] **Step 4: Cache, group loading, `resolveLineQty`**

In `contractService.ts` imports: add `deviceGroups` to the `'../db/schema'` import; replace the two wave 1 imports with

```ts
import { countContractSeats, snapshotContractDevices, groupMembersForBilling, type DeviceSnapshotRow } from './contractQuantities';
import { isDeviceLine, quantityFor, uncoveredByRole, type UncoveredDevices, type OrgDeviceSnapshot, type GroupMembers } from './contractCoverage';
import { GroupEvaluationError } from './groupMembership';
```

Replace the cache block and `orgSnapshot` (lines 191-199) with:

```ts
// One device snapshot per org PER CALCULATION (#3205): every device-counted line
// on a contract is computed from the same query, and every billed group is
// evaluated once per calculation. Never shared across the worker's per-contract
// transactions — "at generation time" must stay literally true.
interface OrgSnapshotEntry { devices: DeviceSnapshotRow[]; groups: Map<string, GroupMembers> }
type DeviceCache = Map<string, OrgSnapshotEntry>; // key orgId
type SeatCache = Map<string, number>;              // key orgId
type ContractLineRow = typeof contractLines.$inferSelect;

const EMPTY_SNAPSHOT: OrgDeviceSnapshot = { devices: [], groups: new Map() };

function groupIdsOf(lines: readonly Pick<ContractLineRow, 'lineType' | 'deviceGroupId'>[]): string[] {
  return [...new Set(lines.filter((l) => l.lineType === 'per_device_group' && l.deviceGroupId).map((l) => l.deviceGroupId!))];
}

/** The org's snapshot with the members of every group in `groupIds` resolved
 *  (once per calculation). A group id that does not come back — deleted between
 *  the line read and here, or not in this org — is simply absent from the map;
 *  callers treat that like a null id (GROUP_DELETED / unresolved). */
async function orgSnapshot(orgId: string, dc: DeviceCache, groupIds: readonly string[] = []): Promise<OrgDeviceSnapshot> {
  let entry = dc.get(orgId);
  if (!entry) { entry = { devices: await snapshotContractDevices(orgId), groups: new Map() }; dc.set(orgId, entry); }
  const missing = groupIds.filter((id) => !entry!.groups.has(id));
  if (missing.length > 0) {
    const rows = await db.select({
      id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type,
      siteId: deviceGroups.siteId, filterConditions: deviceGroups.filterConditions,
    }).from(deviceGroups).where(and(inArray(deviceGroups.id, missing), eq(deviceGroups.orgId, orgId)));
    for (const g of rows) {
      try {
        entry.groups.set(g.id, await groupMembersForBilling(g));
      } catch (err) {
        if (err instanceof GroupEvaluationError) {
          throw new ContractServiceError(
            `Device group "${g.name}" could not be evaluated (${err.reason})`, 500, 'GROUP_EVALUATION_FAILED',
            { groupId: g.id, groupName: g.name, reason: err.reason },
          );
        }
        throw err;
      }
    }
  }
  return entry;
}

/** Lines the pure helpers can resolve: a group line whose group is absent from
 *  the snapshot (deleted) covers nothing and is left out. */
function resolvableLines(lines: readonly ContractLineRow[], snapshot: OrgDeviceSnapshot): ContractLineRow[] {
  return lines.filter((l) => l.lineType !== 'per_device_group' || (l.deviceGroupId !== null && snapshot.groups.has(l.deviceGroupId)));
}
```

Replace `resolveLineQty`:

```ts
async function resolveLineQty(
  orgId: string, line: ContractLineRow, dc: DeviceCache, sc: SeatCache,
): Promise<{ quantity: number; live: boolean; unresolved?: 'group_deleted' }> {
  switch (line.lineType) {
    case 'flat': return { quantity: 1, live: false };
    case 'manual': return { quantity: Number(line.manualQuantity ?? '0'), live: false };
    case 'per_device':
    case 'per_device_role': {
      assertRoleLineHasRoles(line);
      return { quantity: quantityFor(await orgSnapshot(orgId, dc), line), live: true };
    }
    case 'per_device_group': {
      if (line.deviceGroupId === null) return { quantity: 0, live: true, unresolved: 'group_deleted' };
      const snapshot = await orgSnapshot(orgId, dc, [line.deviceGroupId]);
      if (!snapshot.groups.has(line.deviceGroupId)) return { quantity: 0, live: true, unresolved: 'group_deleted' };
      return { quantity: quantityFor(snapshot, line), live: true };
    }
    case 'per_seat': {
      if (!sc.has(orgId)) sc.set(orgId, await countContractSeats(orgId));
      return { quantity: sc.get(orgId)!, live: true };
    }
    default: {
      const _exhaustive: never = line.lineType;
      throw new ContractServiceError(`Unknown contract line type: ${String(line.lineType)}`, 500, 'INVALID_STATE');
    }
  }
}
```

- [ ] **Step 5: Estimate, list, MRR**

`computeContractEstimate`: push `unresolved` through and resolve groups before coverage:

```ts
  for (const l of lines) {
    const { quantity, live, unresolved } = await resolveLineQty(contract.orgId, l, dc, sc);
    const value = Number(l.unitPrice) * quantity;
    total += value;
    out.push({ lineId: l.id, lineType: l.lineType, quantity, value: value.toFixed(2), live, ...(unresolved ? { unresolved } : {}) });
  }
  let uncoveredDevices: UncoveredDevices | null = null;
  if (lines.some(isDeviceLine)) {
    const snapshot = await orgSnapshot(contract.orgId, dc, groupIdsOf(lines));
    uncoveredDevices = uncoveredByRole(snapshot, resolvableLines(lines, snapshot));
  }
```

`listContracts`: wrap the per-contract loop body:

```ts
  for (const c of rows) {
    let total = 0;
    let estimateError: 'GROUP_EVALUATION_FAILED' | undefined;
    try {
      for (const l of byContract.get(c.id) ?? []) {
        const { quantity } = await resolveLineQty(c.orgId, l, dc, sc);
        total += Number(l.unitPrice) * quantity;
      }
    } catch (err) {
      // #3205 W02: one un-evaluable group must not fail the whole list.
      if (err instanceof ContractServiceError && err.code === 'GROUP_EVALUATION_FAILED') estimateError = err.code;
      else throw err;
    }
    out.push(estimateError
      ? { ...c, estimatedPeriodValue: null, estimateError }
      : { ...c, estimatedPeriodValue: total.toFixed(2) });
  }
```

`summarizeActiveContractMrrByOrg`: same catch around the inner loop; on `GROUP_EVALUATION_FAILED`, `console.warn('[contracts] MRR rollup skipped contract %s: %s', c.id, err.message)` and `continue`.

- [ ] **Step 6: Generation**

In `generateDueInvoice` replace the snapshot line and the switch cases:

```ts
  const hasDeviceLine = lines.some(isDeviceLine);
  const dc: DeviceCache = new Map();
  const snapshot = hasDeviceLine ? await orgSnapshot(c.orgId, dc, groupIdsOf(lines)) : EMPTY_SNAPSHOT;
  // #3205 W02: a group line whose group is gone must never bill zero silently.
  for (const l of lines) {
    if (l.lineType === 'per_device_group' && (l.deviceGroupId === null || !snapshot.groups.has(l.deviceGroupId))) {
      throw new ContractServiceError(
        `Contract line "${l.description}" bills device group "${l.deviceGroupName ?? ''}", which no longer exists`,
        409, 'GROUP_DELETED', { contractLineId: l.id, deviceGroupName: l.deviceGroupName },
      );
    }
  }
```

Place this block BEFORE `createManualInvoice` (step 1 of the function) so nothing is written first. In the switch, add `case 'per_device_group':` to the `per_device` / `per_device_role` branch (the `assertRoleLineHasRoles` call is a no-op for it). Coverage at the end: `uncoveredByRole(snapshot, resolvableLines(lines, snapshot))`.

- [ ] **Step 7: Writers and the line mapper**

After `assertSiteInOrg`:

```ts
async function assertGroupInOrg(tx: DbExecutor, groupId: string, orgId: string) {
  const [row] = await tx.select({ id: deviceGroups.id, name: deviceGroups.name, type: deviceGroups.type, siteId: deviceGroups.siteId })
    .from(deviceGroups).where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, orgId))).limit(1);
  if (!row) throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
  return row;
}

/** Postgres 23503 on contract_lines_device_group_org_fk = the group vanished
 *  between assertGroupInOrg and the insert (deleteDeviceGroup holds FOR UPDATE
 *  on the group row, so the insert waited and then lost). Same answer. */
function isGroupFkViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const node = e?.cause ?? e;
  return node?.code === '23503' && node?.constraint_name === 'contract_lines_device_group_org_fk';
}
```

In `addContractLineToContract`, before the insert:

```ts
    const siteId = (input.lineType === 'per_device' || input.lineType === 'per_device_role') ? (input.siteId ?? null) : null;
    if (siteId) await assertSiteInOrg(tx, siteId, c.orgId);
    const group = input.lineType === 'per_device_group' && input.deviceGroupId
      ? await assertGroupInOrg(tx, input.deviceGroupId, c.orgId) : null;
```

and in the values: `deviceGroupId: group?.id ?? null, deviceGroupName: group?.name ?? null,`. Wrap the insert in `try { … } catch (err) { if (isGroupFkViolation(err)) throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG'); throw err; }`. Note `isDeviceLine` is no longer the site predicate (group lines are device lines but not site-scopable); define `const SITE_SCOPABLE = new Set(['per_device', 'per_device_role'])` once at module level and use it in both writers.

Same three changes in `createContractWithLinesDetailed` (using `db` as the executor). Rename `assertSpecRoleLine` → `assertSpecDeviceSetLine` and extend it:

```ts
function assertSpecDeviceSetLine(line: NewContractSpec['lines'][number]): void {
  if (roleLineIsInvalid(line, BILLABLE_DEVICE_ROLE_SET)) {
    throw new ContractServiceError('per_device_role line requires at least one device role', 400, 'INVALID_STATE');
  }
  if (line.lineType === 'per_device_group' && !line.deviceGroupId) {
    throw new ContractServiceError('per_device_group line requires deviceGroupId', 400, 'INVALID_STATE');
  }
}
```

Line mapper, after `getOwnedContractOr404`:

```ts
/** #3205 W02: label group lines without a second fetch. Matched on (id, org_id)
 *  as defence in depth beside the composite FK; null when the group is gone
 *  (the stamped deviceGroupName still says what it was). */
async function withDeviceGroup<T extends { deviceGroupId: string | null; orgId: string }>(lines: T[]) {
  const ids = [...new Set(lines.map((l) => l.deviceGroupId).filter((x): x is string => x !== null))];
  const groups = ids.length === 0 ? [] : await db
    .select({ id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type })
    .from(deviceGroups).where(inArray(deviceGroups.id, ids));
  const byKey = new Map(groups.map((g) => [`${g.id}|${g.orgId}`, { id: g.id, name: g.name, type: g.type }]));
  return lines.map((l) => ({ ...l, deviceGroup: l.deviceGroupId ? (byKey.get(`${l.deviceGroupId}|${l.orgId}`) ?? null) : null }));
}
```

`getContract` returns `lines: await withDeviceGroup(lines)`. `listContracts` does not return lines (only totals), so nothing else changes there.

- [ ] **Step 8: Unit tests (`contractService.test.ts`)**

Add, following the file's existing Drizzle-mock pattern for `resolveLineQty` / snapshot cases:

```ts
describe('per_device_group quantities (#3205 W02)', () => {
  it('evaluates a group once for two contracts in one estimate/list calculation', async () => { /* mock deviceGroups select → one row; spy groupMembersForBilling; two contracts, same group; expect 1 call */ });
  it('maps GroupEvaluationError to GROUP_EVALUATION_FAILED with groupId/groupName/reason', async () => { /* groupMembersForBilling rejects; expect ContractServiceError code+details */ });
  it('a null-group line resolves to quantity 0 with unresolved=group_deleted on the estimate', async () => { /* … */ });
  it('listContracts returns estimatedPeriodValue null + estimateError for the failing contract and a value for its neighbour', async () => { /* … */ });
});
```

Write each body against the mocks the file already uses (`vi.mock('../db', …)` with chained `select().from().where()` resolvers) — copy the closest existing wave 1 test (`resolveLineQty role path reads the snapshot once per org`) and vary the fixtures.

- [ ] **Step 9: Run everything touched**

Run:
```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head
npx vitest run src/services/contractService.test.ts src/services/contractCoverage.test.ts src/routes/contracts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractDeviceGroups.integration.test.ts src/__tests__/integration/contractService.integration.test.ts src/__tests__/integration/contractDeviceRoles.integration.test.ts src/__tests__/integration/contractQuantities.integration.test.ts
```
Expected: tsc clean except `quoteToContract.ts` / `aiToolsContracts.ts` (Task 7); all listed suites PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/contractTypes.ts apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts apps/api/src/__tests__/integration/contractDeviceGroups.integration.test.ts apps/api/src/__tests__/integration/contractService.integration.test.ts
git commit -m "feat(billing): per_device_group quantities — live group evaluation, estimate/generation, list+MRR isolation, writers (#3205 W02)"
```

---

### Task 6: Group deletion — one service, three surfaces

**Files:**
- Create: `apps/api/src/services/deviceGroupDelete.ts`
- Create: `apps/api/src/__tests__/integration/deviceGroupDelete.integration.test.ts`
- Modify: `apps/api/src/routes/groups.ts:779-847` (+ imports `:1-20`), `apps/api/src/routes/devices/groups.ts:307-364` (+ imports `:1-13`), `apps/api/src/services/aiToolsFleet.ts:1248-1269`
- Test: `apps/api/src/routes/groups_update_delete.test.ts`, `apps/api/src/routes/devices/groups*.test.ts` (find the delete cases with `grep -ln "DELETE" apps/api/src/routes/devices/*.test.ts`), `apps/api/src/services/aiToolsFleet*.test.ts` (grep `action: 'delete'`)

**Interfaces:**
- Produces:

```ts
export class DeviceGroupDeleteError extends Error {
  code: 'NOT_FOUND' | 'HAS_CHILDREN' | 'BILLED_BY_CONTRACTS';
  contractCount?: number;
  contracts?: Array<{ id: string; name: string; status: string }>;
}
export async function listContractsBillingGroup(executor, groupId: string): Promise<Array<{ id; name; status }>>  // draft|active|paused only
export async function deleteDeviceGroup(groupId: string, orgId: string): Promise<{ group: { id; name; orgId }; affectedDeviceIds: string[] }>
```

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/deviceGroupDelete.integration.test.ts`:

```ts
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, devices, deviceGroups, deviceGroupMemberships, groupMembershipLog, contracts, contractLines } from '../../db/schema';
import { deleteDeviceGroup, DeviceGroupDeleteError } from '../../services/deviceGroupDelete';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `DP ${sfx}`, slug: `dp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'DO', slug: `do-${sfx}` }).returning({ id: organizations.id });
    const [d] = await db.insert(devices).values({ orgId: o!.id, agentId: `d-${sfx}`, hostname: 'd', status: 'online', osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1' }).returning({ id: devices.id });
    const [g] = await db.insert(deviceGroups).values({ orgId: o!.id, name: 'VIP', type: 'static' }).returning();
    await db.insert(deviceGroupMemberships).values({ groupId: g!.id, deviceId: d!.id, orgId: o!.id });
    await db.insert(groupMembershipLog).values({ groupId: g!.id, deviceId: d!.id, orgId: o!.id, action: 'added', reason: 'manual' });
    return { partnerId: p!.id, orgId: o!.id, deviceId: d!.id, group: g! };
  });
}

async function contractWithGroupLine(f: Awaited<ReturnType<typeof seed>>, status: string) {
  return withSystemDbAccessContext(async () => {
    const [c] = await db.insert(contracts).values({ partnerId: f.partnerId, orgId: f.orgId, name: `C-${status}`, status: status as never, intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD' }).returning({ id: contracts.id });
    await db.insert(contractLines).values({ contractId: c!.id, orgId: f.orgId, lineType: 'per_device_group', description: 'g', unitPrice: '1.00', taxable: false, deviceGroupId: f.group.id, deviceGroupName: f.group.name });
    return c!.id;
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('deleteDeviceGroup (real DB) #3205 W02', () => {
  runDb.each(['draft', 'active', 'paused'])('refuses while a %s contract bills the group', async (status) => {
    const f = await seed();
    const contractId = await contractWithGroupLine(f, status);
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId))).rejects.toMatchObject({
      name: 'DeviceGroupDeleteError', code: 'BILLED_BY_CONTRACTS', contractCount: 1,
      contracts: [{ id: contractId, name: `C-${status}`, status }],
    });
    const still = await withSystemDbAccessContext(() => db.select().from(deviceGroups).where(eq(deviceGroups.id, f.group.id)));
    expect(still).toHaveLength(1);
  });

  runDb.each(['cancelled', 'expired'])('deletes when only a %s contract references it; the line keeps its stamped name', async (status) => {
    const f = await seed();
    const contractId = await contractWithGroupLine(f, status);
    const res = await withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId));
    expect(res).toEqual({ group: { id: f.group.id, name: 'VIP', orgId: f.orgId }, affectedDeviceIds: [f.deviceId] });
    const [line] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.contractId, contractId)));
    expect(line).toMatchObject({ deviceGroupId: null, deviceGroupName: 'VIP' });
    const logs = await withSystemDbAccessContext(() => db.select().from(groupMembershipLog).where(eq(groupMembershipLog.groupId, f.group.id)));
    expect(logs).toHaveLength(0);
  });

  runDb('refuses a group with children, and NOT_FOUND for a group in another org', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.insert(deviceGroups).values({ orgId: f.orgId, name: 'child', type: 'static', parentId: f.group.id }));
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId))).rejects.toMatchObject({ code: 'HAS_CHILDREN' });
    const other = await seed();
    await expect(withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, other.orgId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(new DeviceGroupDeleteError('NOT_FOUND', 'x')).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceGroupDelete.integration.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/deviceGroupDelete.ts`:

```ts
/**
 * The one way to delete a device group (#3205 W02). Three surfaces call it:
 * DELETE /groups/:id, DELETE /devices/groups/:id, and the AI manage_groups tool.
 * Callers keep their own auth/site checks, audit write and peripheral-policy
 * scheduling; this module owns the transactional part.
 *
 * Refuses while a draft/active/paused contract has a per_device_group line on
 * the group. Lines on cancelled/expired contracts cannot be removed
 * (contractService.assertEditable), so they do not block: the FK nulls their
 * device_group_id and the stamped device_group_name keeps the history.
 *
 * FOR UPDATE on the group row makes the check race-safe: a concurrent line
 * insert takes FOR KEY SHARE on the same row (its composite FK), so one side
 * waits for the other and the loser fails cleanly.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, deviceGroups, deviceGroupMemberships, groupMembershipLog } from '../db/schema';

export type DeviceGroupDeleteCode = 'NOT_FOUND' | 'HAS_CHILDREN' | 'BILLED_BY_CONTRACTS';

export class DeviceGroupDeleteError extends Error {
  constructor(
    public readonly code: DeviceGroupDeleteCode,
    message: string,
    public readonly contracts?: Array<{ id: string; name: string; status: string }>,
  ) {
    super(message);
    this.name = 'DeviceGroupDeleteError';
  }
  get contractCount(): number | undefined { return this.contracts?.length; }
}

type Executor = Pick<typeof db, 'select'>;
const BLOCKING_STATUSES = ['draft', 'active', 'paused'] as const;

/** Contracts that still bill the group. Terminated contracts are not listed. */
export async function listContractsBillingGroup(executor: Executor, groupId: string) {
  return executor
    .select({ id: contracts.id, name: contracts.name, status: contracts.status })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(eq(contractLines.deviceGroupId, groupId), inArray(contracts.status, [...BLOCKING_STATUSES] as never)))
    .groupBy(contracts.id, contracts.name, contracts.status)
    .orderBy(contracts.name);
}

export interface DeleteDeviceGroupResult {
  group: { id: string; name: string; orgId: string };
  affectedDeviceIds: string[];
}

export async function deleteDeviceGroup(groupId: string, orgId: string): Promise<DeleteDeviceGroupResult> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: deviceGroups.id, name: deviceGroups.name, orgId: deviceGroups.orgId })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, orgId)))
      .for('update');
    if (!group) throw new DeviceGroupDeleteError('NOT_FOUND', 'Group not found');

    const [child] = await tx.select({ id: deviceGroups.id }).from(deviceGroups).where(eq(deviceGroups.parentId, groupId)).limit(1);
    if (child) throw new DeviceGroupDeleteError('HAS_CHILDREN', 'Cannot delete group with child groups');

    const billing = await listContractsBillingGroup(tx, groupId);
    if (billing.length > 0) {
      throw new DeviceGroupDeleteError(
        'BILLED_BY_CONTRACTS',
        `Group is billed by ${billing.length} contract(s); remove those contract lines first`,
        billing.map((b) => ({ id: b.id, name: b.name, status: String(b.status) })),
      );
    }

    const affected = await tx.select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, groupId));
    await tx.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, groupId));
    // group_membership_log FKs device_groups with no ON DELETE (#3313).
    await tx.delete(groupMembershipLog).where(eq(groupMembershipLog.groupId, groupId));
    await tx.delete(deviceGroups).where(eq(deviceGroups.id, groupId));

    return { group, affectedDeviceIds: affected.map((a) => a.deviceId) };
  });
}
```

- [ ] **Step 4: Run the service test**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceGroupDelete.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Route unit tests (failing first)**

In `apps/api/src/routes/groups_update_delete.test.ts`: add to the module mocks

```ts
const { deleteDeviceGroup } = vi.hoisted(() => ({ deleteDeviceGroup: vi.fn() }));
vi.mock('../services/deviceGroupDelete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/deviceGroupDelete')>();
  return { ...actual, deleteDeviceGroup };
});
```

and tests:

```ts
describe('DELETE /groups/:id — billed groups (#3205 W02)', () => {
  it('returns 409 with contractCount only when the caller lacks contracts:read', async () => {
    deleteDeviceGroup.mockRejectedValueOnce(Object.assign(new DeviceGroupDeleteError('BILLED_BY_CONTRACTS', 'billed', [{ id: 'c1', name: 'Acme', status: 'active' }]), {}));
    // mock db.select for getGroupWithAccess as the existing delete tests do
    const res = await app.request(`/groups/${GROUP_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'billed', code: 'GROUP_IN_USE_BY_CONTRACTS', contractCount: 1 });
  });
  it('includes the contracts when the caller has contracts:read', async () => { /* set c.get('permissions') via the auth mock to include { resource: 'contracts', action: 'read' }; expect contracts: [{ id: 'c1', name: 'Acme', status: 'active' }] */ });
  it('maps HAS_CHILDREN to 400 and calls deleteDeviceGroup with the group org', async () => { /* … */ });
  it('on success schedules peripheral reconciliation for every affected device and audits', async () => { deleteDeviceGroup.mockResolvedValueOnce({ group: { id: GROUP_ID, name: 'G', orgId: ORG_ID }, affectedDeviceIds: [DEVICE_ID, DEVICE_ID_2] }); /* expect schedulePeripheralPolicyDevice called twice with 'group_deleted' */ });
});
```

Add the equivalent 409 / 400 / success cases to the `routes/devices/groups` delete test file and an AI-tool case in the `aiToolsFleet` test that covers `manage_groups` (`action: 'delete'` → returns `{ error: 'Group is billed by 1 contract(s); remove those contract lines first' }`). Run them; expected FAIL (routes still inline the delete).

- [ ] **Step 6: Wire the three surfaces**

`routes/groups.ts` — imports: add `hasPermission` to the `../services/permissions` import and

```ts
import { deleteDeviceGroup, DeviceGroupDeleteError } from '../services/deviceGroupDelete';
```

Replace the handler body from `// Check for child groups` through the group delete with:

```ts
    let result: Awaited<ReturnType<typeof deleteDeviceGroup>>;
    try {
      result = await deleteDeviceGroup(id, group.orgId);
    } catch (err) {
      if (err instanceof DeviceGroupDeleteError) {
        if (err.code === 'NOT_FOUND') return c.json({ error: 'Group not found' }, 404);
        if (err.code === 'HAS_CHILDREN') return c.json({ error: 'Cannot delete group with child groups' }, 400);
        // #3205 W02: a draft/active/paused contract bills this group. Contract
        // names are contract data — disclose them only to a contracts reader.
        const perms = c.get('permissions') as UserPermissions | undefined;
        const canReadContracts = !!perms && hasPermission(perms, PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
        return c.json({
          error: err.message, code: 'GROUP_IN_USE_BY_CONTRACTS', contractCount: err.contractCount,
          ...(canReadContracts ? { contracts: err.contracts } : {}),
        }, 409);
      }
      throw err;
    }

    await Promise.all(result.affectedDeviceIds.map((deviceId) =>
      schedulePeripheralPolicyDevice(deviceId, 'group_deleted').catch((error) => {
        console.error(`[groups] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      })
    ));
```

Keep the audit write and the `mapGroupRow(group, 0)` response. Remove the now-unused `groupMembershipLog` import if nothing else in the file uses it (`grep -n groupMembershipLog apps/api/src/routes/groups.ts`).

`routes/devices/groups.ts` — same shape (imports from `'../../services/deviceGroupDelete'` and `hasPermission`/`PERMISSIONS` from `'../../services/permissions'`), replacing everything from `const affectedMemberships` through the group delete; response stays `{ success: true }`. This route now also refuses `HAS_CHILDREN` (400), which it never checked before.

`aiToolsFleet.ts` — in `action === 'delete'`, replace from `const affectedMemberships` through `scheduleAiGroupPeripheralReconciliation(...)` with:

```ts
        let result: Awaited<ReturnType<typeof deleteDeviceGroup>>;
        try {
          result = await deleteDeviceGroup(existing.id, existing.orgId);
        } catch (err) {
          if (err instanceof DeviceGroupDeleteError) return JSON.stringify({ error: err.message, code: err.code });
          throw err;
        }
        await scheduleAiGroupPeripheralReconciliation(result.affectedDeviceIds);
```

with the import `import { deleteDeviceGroup, DeviceGroupDeleteError } from './deviceGroupDelete';`. Remove `groupMembershipLog` from that file's schema import if it is now unused.

- [ ] **Step 7: Run route, AI-tool and delete-log suites**

Run: `cd apps/api && npx vitest run src/routes/groups src/routes/devices/groups src/services/aiToolsFleet && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/groupDeleteMembershipLog.integration.test.ts src/__tests__/integration/deviceGroupDelete.integration.test.ts`
Expected: PASS. (`groupDeleteMembershipLog.integration.test.ts` proves the log rows still go.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/deviceGroupDelete.ts apps/api/src/__tests__/integration/deviceGroupDelete.integration.test.ts apps/api/src/routes/groups.ts apps/api/src/routes/devices/groups.ts apps/api/src/services/aiToolsFleet.ts apps/api/src/routes/groups_update_delete.test.ts $(git diff --name-only apps/api/src/routes/devices apps/api/src/services | grep test)
git commit -m "feat(groups): one transactional deleteDeviceGroup for all three surfaces; 409 while a running contract bills the group (#3205 W02)"
```

---

### Task 7: Quote-to-contract spec, AI `manage_contracts` description, worker isolation test

**Files:**
- Modify: `apps/api/src/services/quoteToContract.ts:29-42`
- Modify: `apps/api/src/services/aiToolsContracts.ts:281-294` (the `line` description)
- Test: `apps/api/src/services/aiToolsContracts.manageContracts.test.ts`, `apps/api/src/jobs/contractWorker.test.ts`, the `createContractWithLinesDetailed` cases in `contractService.test.ts`

- [ ] **Step 1: Failing tests**

`aiToolsContracts.manageContracts.test.ts` — beside the wave 1 role cases:

```ts
it('add_line accepts a per_device_group line and rejects one without deviceGroupId', async () => {
  const groupId = '33333333-3333-4333-8333-333333333333';
  await run({ action: 'add_line', contractId: CONTRACT_ID, line: { lineType: 'per_device_group', description: 'VIP', unitPrice: '5.00', taxable: false, deviceGroupId: groupId } });
  expect(addContractLineToContract).toHaveBeenCalledWith(CONTRACT_ID, expect.objectContaining({ deviceGroupId: groupId }), expect.anything());
  const bad = JSON.parse(await run({ action: 'add_line', contractId: CONTRACT_ID, line: { lineType: 'per_device_group', description: 'VIP', unitPrice: '5.00', taxable: false } }));
  expect(bad.error).toMatch(/deviceGroupId/);
});
it('the manage_contracts description names per_device_group, deviceGroupId and the groupId-condition caveat', () => {
  const desc = aiTools.get('manage_contracts')!.definition.input_schema.properties.line.description as string;
  expect(desc).toContain('per_device_group');
  expect(desc).toContain('deviceGroupId');
  expect(desc).toMatch(/evaluated live/i);
  expect(desc).toMatch(/groupId/);
});
```

`contractWorker.test.ts`:

```ts
it('a GROUP_EVALUATION_FAILED contract is logged and reported, and the next contract still generates', async () => {
  dueRows.push({ id: 'c1' }, { id: 'c2' });
  generateDueInvoiceMock
    .mockRejectedValueOnce(Object.assign(new Error('group failed'), { code: 'GROUP_EVALUATION_FAILED' }))
    .mockResolvedValueOnce({ generated: true, invoiceId: 'inv2', autoIssue: false, priceBookGaps: [], uncoveredDevices: null });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const summary = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
    expect(generateDueInvoiceMock).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledWith('[ContractWorker] generation failed', 'contractId=c1', 'group failed');
    expect(summary).toMatchObject({ billed: 1, failed: 1 });
  } finally { err.mockRestore(); }
});
```

(Match `summary`'s real shape from the existing tests in that file.)

`contractService.test.ts` — `createContractWithLinesDetailed` rejects a `per_device_group` spec line without `deviceGroupId` (400 `INVALID_STATE`) and stamps `deviceGroupName` from the group row when given one.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsContracts.manageContracts.test.ts src/jobs/contractWorker.test.ts src/services/contractService.test.ts`
Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

`quoteToContract.ts`:

```ts
export interface NewContractLineSpec {
  lineType: 'flat' | 'per_device' | 'per_device_role' | 'per_device_group' | 'per_seat' | 'manual';
  …
  /** #3205: required (non-empty) when lineType is per_device_role, otherwise absent. */
  deviceRoles?: DeviceRole[] | null;
  /** #3205 W02: required when lineType is per_device_group, otherwise absent. Name is stamped by the writer. */
  deviceGroupId?: string | null;
  …
}
```

`aiToolsContracts.ts` `line` description — insert after the `per_device_role` sentence:

```ts
              'per_device_group counts the members of one device group named by deviceGroupId (a device group UUID in the ' +
              'contract\'s org). Static groups bill their current members; dynamic groups are evaluated live from their filter at ' +
              'estimate and invoice time (a filter condition on groupId still reads that other group\'s cached membership). ' +
              'No siteId on this type — the group\'s own site narrows it. ' +
```

Worker: no code change (per-contract catch already isolates); the test documents it.

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run src/services/aiToolsContracts.manageContracts.test.ts src/jobs/contractWorker.test.ts src/services/contractService.test.ts`
Expected: tsc clean; PASS.

```bash
git add apps/api/src/services/quoteToContract.ts apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiToolsContracts.manageContracts.test.ts apps/api/src/jobs/contractWorker.test.ts apps/api/src/services/contractService.test.ts
git commit -m "feat(billing): per_device_group in quote→contract spec and AI manage_contracts; worker isolation test (#3205 W02)"
```

---

### Task 8: Tenant export and erasure round-trip

**Files:**
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts:113-142` and its assertions on `contract_lines.json`

- [ ] **Step 1: Extend the seed (failing until the columns are asserted)**

After the wave 1 `per_device_role` line insert:

```ts
  // #3205 W02: a per_device_group line, so contract_lines.json carries
  // device_group_id + device_group_name and erasure has to remove the line,
  // the group and the contract in FK order.
  const groupId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO device_groups (id, org_id, name, type) VALUES (${groupId}, ${orgA}, ${'Roundtrip group ' + suffix}, 'static')
  `);
  await db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_group_id, device_group_name)
    VALUES (${contractId}, ${orgA}, 'per_device_group', 'VIP', 40.00, false, ${groupId}, ${'Roundtrip group ' + suffix})
  `);
```

Where the test reads the archive, assert the `contract_lines.json` entry for that line has `device_group_id === groupId` and `device_group_name === 'Roundtrip group ' + suffix` (follow the file's existing pattern for `device_roles`), that the row count for `contract_lines` is now 2, and after erasure that `device_groups`, `contract_lines` and `contracts` for `orgA` are all empty.

- [ ] **Step 2: Run**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "test(billing): export/erasure round-trip covers a per_device_group line (#3205 W02)"
```

---

### Task 9: Web — API types, line-type module, editor group select, i18n

**Files:**
- Modify: `apps/web/src/lib/api/contracts.ts:52, 63-84`
- Modify: `apps/web/src/components/contracts/lineTypes.ts`
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx` (state `:132-139`; reference-data fetch near `:231`; `roleLineMissingRoles` `:396`; `addLine` `:577-612`; line-row sub-label `:919-921`; type select `onChange` `:995`; add the group select beside the `per_device_role` fieldset `:1067-1092`)
- Create: `apps/web/src/components/contracts/ContractEditor.groups.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

- [ ] **Step 1: Failing test**

Create `ContractEditor.groups.test.tsx` by copying `ContractEditor.roles.test.tsx` (same mocks) and replacing the cases:

```tsx
describe('ContractEditor — per_device_group (#3205 W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) return resp({ data: [{ id: 'g-1', name: 'VIP laptops', type: 'static' }, { id: 'g-2', name: 'All servers', type: 'dynamic' }] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [{ lineId: 'l1', lineType: 'per_device_group', quantity: 0, value: '0.00', live: true, unresolved: 'group_deleted' }], uncoveredDevices: null } }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
  });

  it('shows the group select only for per_device_group, no site select, and clears it on type change', async () => {
    renderEdit();
    expect(screen.queryByTestId('contract-line-group')).toBeNull();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    const select = await screen.findByTestId('contract-line-group');
    await within(select).findByRole('option', { name: /All servers/ });
    expect(screen.queryByTestId('contract-line-site')).toBeNull();
    fireEvent.change(select, { target: { value: 'g-2' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'flat' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    expect((await screen.findByTestId('contract-line-group') as HTMLSelectElement).value).toBe('');
  });

  it('disables Add until a group is picked, then sends deviceGroupId and no siteId', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'VIP' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    const select = await screen.findByTestId('contract-line-group');
    await within(select).findByRole('option', { name: /VIP laptops/ });
    fireEvent.change(select, { target: { value: 'g-1' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const body = (api.addContractLine as any).mock.calls[0][1];
    expect(body).toMatchObject({ lineType: 'per_device_group', deviceGroupId: 'g-1' });
    expect(body.siteId).toBeUndefined();
  });

  it('labels a group line with its live name and dynamic hint, a deleted group by its stamped name, and shows "group deleted" as the quantity', async () => {
    renderEdit([
      { id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_group', description: 'Old', catalogItemId: null, unitPrice: '5.00', manualQuantity: null, siteId: null, deviceRoles: null, deviceGroupId: null, deviceGroupName: 'Retired group', deviceGroup: null, taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'l2', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_group', description: 'Servers', catalogItemId: null, unitPrice: '5.00', manualQuantity: null, siteId: null, deviceRoles: null, deviceGroupId: 'g-2', deviceGroupName: 'All servers', deviceGroup: { id: 'g-2', name: 'All servers', type: 'dynamic' }, taxable: false, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z' },
    ]);
    expect((await screen.findByTestId('line-group-0')).textContent).toContain('Retired group');
    expect(screen.getByTestId('line-group-0').textContent).toMatch(/deleted/i);
    expect(screen.getByTestId('line-group-1').textContent).toContain('All servers');
    expect(screen.getByTestId('line-group-1').textContent).toMatch(/dynamic/i);
    expect((await screen.findByTestId('line-qty-0')).textContent).toMatch(/group deleted/i);
  });
});
```

(`line-qty-<idx>` is the test id to add on the editor's live-quantity cell; if the cell already has one, use it.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor.groups.test.tsx`
Expected: FAIL.

- [ ] **Step 3: API types**

`apps/web/src/lib/api/contracts.ts`: on the list row type, `estimatedPeriodValue?: string | null; estimateError?: 'GROUP_EVALUATION_FAILED';`. On `ContractLine` after `deviceRoles`:

```ts
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null;
```

On `ContractEstimateLine`: `unresolved?: 'group_deleted';`.

- [ ] **Step 4: `lineTypes.ts`**

```ts
  per_device_group: 'contracts.shared.lineType.perDeviceGroup',
```

in `LINE_TYPE_LABELS` (between `per_device_role` and `per_seat`), and `'per_device_group'` in `AUTO_QTY_TYPES`. `SITE_SCOPED_TYPES` unchanged.

- [ ] **Step 5: Editor**

State: `const [lineGroupId, setLineGroupId] = useState('');` and `const [deviceGroupsList, setDeviceGroupsList] = useState<Array<{ id: string; name: string; type: 'static' | 'dynamic' }>>([]);`. Beside the sites fetch (`/orgs/sites?organizationId=${forOrg}`), fetch groups for the same org:

```ts
    fetchWithAuth(`/device-groups?orgId=${forOrg}&limit=200`).then(async (res) => {
      if (!res.ok) return;
      const body = await res.json();
      const items = Array.isArray(body.data) ? body.data : [];
      setDeviceGroupsList(items.map((g: { id: string; name: string; type: 'static' | 'dynamic' }) => ({ id: g.id, name: g.name, type: g.type })));
    }).catch(() => { /* the select stays empty; Add stays disabled for this type */ });
```

Guard: `const groupLineMissingGroup = lineType === 'per_device_group' && !lineGroupId;` and add it to the `addLine` early-return, to the Add button's `disabled`, and to the `useCallback` deps. Payload: `deviceGroupId: lineType === 'per_device_group' ? lineGroupId : undefined,` (siteId already excluded by `SITE_SCOPED_TYPES`). Reset `setLineGroupId('')` after a successful add and in the type-select `onChange`.

Group select, rendered where `lineType === 'per_device_group'`:

```tsx
                  {lineType === 'per_device_group' && (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {t('contracts.contractEditor.addLine.deviceGroup')}
                      <select
                        value={lineGroupId} onChange={(e) => setLineGroupId(e.target.value)}
                        data-testid="contract-line-group"
                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        <option value="">{t('contracts.contractEditor.addLine.selectGroup')}</option>
                        {deviceGroupsList.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}{g.type === 'dynamic' ? ` (${t('contracts.shared.dynamicGroup')})` : ''}
                          </option>
                        ))}
                      </select>
                      {!lineGroupId && <span className="text-amber-600 dark:text-amber-500">{t('contracts.contractEditor.addLine.deviceGroupRequired')}</span>}
                    </label>
                  )}
```

Line-row sub-label, after the roles sub-label:

```tsx
                            {l.lineType === 'per_device_group'
                              ? <span className="block text-xs text-muted-foreground" data-testid={`line-group-${idx}`}>
                                  {l.deviceGroup
                                    ? `${l.deviceGroup.name}${l.deviceGroup.type === 'dynamic' ? ` · ${t('contracts.shared.dynamicGroup')}` : ''}`
                                    : t('contracts.shared.deletedGroup', { name: l.deviceGroupName ?? '' })}
                                </span>
                              : null}
```

Live-quantity cell (the one fed by the estimate, near `:335`): when the estimate line for this row has `unresolved === 'group_deleted'`, render `t('contracts.shared.values.groupDeleted')` instead of the number, with `data-testid={`line-qty-${idx}`}` on the cell.

- [ ] **Step 6: i18n**

`en/billing.json`: `contracts.shared.lineType.perDeviceGroup: "Per device group"`, `contracts.shared.dynamicGroup: "dynamic"`, `contracts.shared.deletedGroup: "{{name}} (deleted group)"`, `contracts.shared.values.groupDeleted: "group deleted"`, `contracts.contractEditor.addLine.deviceGroup: "Device group (bills its members; dynamic groups are evaluated at billing time)"`, `contracts.contractEditor.addLine.selectGroup: "Select a group"`, `contracts.contractEditor.addLine.deviceGroupRequired: "Pick a group."`.

Same keys in the other seven locales:

| key | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|
| perDeviceGroup | Pro Gerätegruppe | Por grupo de dispositivos | Par groupe d'appareils | Per gruppo di dispositivi | Por grupo de dispositivos | Cihaz grubu başına |
| dynamicGroup | dynamisch | dinámico | dynamique | dinamico | dinâmico | dinamik |
| deletedGroup | {{name}} (gelöschte Gruppe) | {{name}} (grupo eliminado) | {{name}} (groupe supprimé) | {{name}} (gruppo eliminato) | {{name}} (grupo excluído) | {{name}} (silinmiş grup) |
| values.groupDeleted | Gruppe gelöscht | grupo eliminado | groupe supprimé | gruppo eliminato | grupo excluído | grup silindi |
| addLine.deviceGroup | Gerätegruppe (berechnet ihre Mitglieder; dynamische Gruppen werden zur Abrechnung ausgewertet) | Grupo de dispositivos (factura a sus miembros; los grupos dinámicos se evalúan al facturar) | Groupe d'appareils (facture ses membres; les groupes dynamiques sont évalués à la facturation) | Gruppo di dispositivi (fattura i suoi membri; i gruppi dinamici sono valutati alla fatturazione) | Grupo de dispositivos (cobra seus membros; grupos dinâmicos são avaliados no faturamento) | Cihaz grubu (üyeleri faturalandırılır; dinamik gruplar faturalama sırasında değerlendirilir) |
| addLine.selectGroup | Gruppe auswählen | Selecciona un grupo | Sélectionner un groupe | Seleziona un gruppo | Selecione um grupo | Bir grup seçin |
| addLine.deviceGroupRequired | Wählen Sie eine Gruppe. | Elige un grupo. | Choisissez un groupe. | Scegli un gruppo. | Escolha um grupo. | Bir grup seçin. |

- [ ] **Step 7: Run**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor src/lib/i18n && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: PASS (including the wave 1 `roles` and `autosave` editor suites and the `tr-TR` parity test); tsc clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api/contracts.ts apps/web/src/components/contracts/lineTypes.ts apps/web/src/components/contracts/ContractEditor.tsx apps/web/src/components/contracts/ContractEditor.groups.test.tsx apps/web/src/locales/*/billing.json
git commit -m "feat(web): per_device_group line type — group select, sub-labels, unresolved quantity (#3205 W02)"
```

---

### Task 10: Web — detail page, contracts list, Device Groups delete modal

**Files:**
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx:374-391` and its estimate/generate rendering
- Modify: `apps/web/src/components/contracts/ContractsList.tsx:488` (already renders "—" for null; add a title/tooltip when `estimateError` is set)
- Modify: `apps/web/src/components/devices/DeviceGroupsPage.tsx:725-755`
- Test: `apps/web/src/components/contracts/ContractDetail.groups.test.tsx` (new, copy `ContractDetail.roles.test.tsx`), `apps/web/src/components/devices/DeviceGroupsPage.staticGroups.test.tsx` (add delete cases)
- Modify: the locale file that owns `deviceGroupsPage.failedToDeleteGroup` (`grep -rl failedToDeleteGroup apps/web/src/locales/en/`) in all 8 locales

- [ ] **Step 1: Failing tests**

`ContractDetail.groups.test.tsx`: a group line renders the live name + "dynamic", a deleted-group line renders the stamped name with "deleted", and an estimate line with `unresolved: 'group_deleted'` renders "group deleted" in the quantity cell.

`DeviceGroupsPage.staticGroups.test.tsx`, in the delete flow:

```tsx
it('shows the billing contracts from a 409 body in the delete modal', async () => {
  // mock DELETE /device-groups/:id → { ok: false, status: 409, json: async () => ({ code: 'GROUP_IN_USE_BY_CONTRACTS', contractCount: 2, contracts: [{ id: 'c1', name: 'Acme MSA', status: 'active' }, { id: 'c2', name: 'Beta', status: 'draft' }] }) }
  // open the delete modal for a group, confirm
  expect(await screen.findByText(/billed by 2 contract/i)).toHaveTextContent('Acme MSA, Beta');
});
it('shows the count-only variant when the body has no contracts array, and the generic message for other failures', async () => { /* 409 without contracts → "billed by 1 contract"; 500 → "Failed to delete group" */ });
```

- [ ] **Step 2: Implement**

`ContractDetail.tsx` line rows — the same sub-label block as the editor (without the `data-testid` index; use `data-testid={`contract-detail-line-group-${l.id}`}`); the estimate table's quantity cell renders `t('contracts.shared.values.groupDeleted')` when `unresolved === 'group_deleted'`.

`ContractsList.tsx:488`: `title={ctr.estimateError ? t('contracts.list.estimateUnavailable') : undefined}` on the cell (key: en "Estimate unavailable: a device group on this contract could not be evaluated"; translate in all locales).

`DeviceGroupsPage.tsx` `handleConfirmDelete`:

```tsx
      if (!response.ok) {
        if (response.status === 409) {
          const body = await response.json().catch(() => null) as
            { contractCount?: number; contracts?: Array<{ name: string }> } | null;
          if (body?.contractCount) {
            const names = body.contracts?.map((c) => c.name).join(', ');
            throw new Error(names
              ? t('deviceGroupsPage.billedByContracts', { count: body.contractCount, names })
              : t('deviceGroupsPage.billedByContractsCount', { count: body.contractCount }));
          }
        }
        throw new Error(t('deviceGroupsPage.failedToDeleteGroup'));
      }
```

Locale keys (`deviceGroupsPage` namespace): `billedByContracts: "This group is billed by {{count}} contract(s): {{names}}. Remove those contract lines first."`, `billedByContractsCount: "This group is billed by {{count}} contract(s). Remove those contract lines first."` (+ seven translations in the same style as Task 9's table).

- [ ] **Step 3: Run**

Run: `cd apps/web && npx vitest run src/components/contracts src/components/devices/DeviceGroupsPage src/lib/i18n && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: PASS; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractDetail.groups.test.tsx apps/web/src/components/contracts/ContractsList.tsx apps/web/src/components/devices/DeviceGroupsPage.tsx apps/web/src/components/devices/DeviceGroupsPage.staticGroups.test.tsx apps/web/src/locales
git commit -m "feat(web): group line labels on detail, list estimate fallback, 409 billing refusal in the group delete modal (#3205 W02)"
```

---

### Task 11: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx:33-45`

- [ ] **Step 1: Edit**

Add the table row after "Per device role":

```md
| Per device group | Counts the members of one device group at billing time × unit price. Static groups bill their current members; dynamic groups are evaluated from their filter when the estimate or invoice is computed |
```

Replace the paragraph after the table with:

```md
Per-device and per-device-role lines can be scoped to a specific **site** so you bill only the devices at that location. A per-device-group line is not site-scoped: make the group itself site-bound instead. Per-seat lines always bill the organization's whole active-user count and cannot be site-scoped. A line can link to a [catalog item](/features/product-catalog/), which prefills its description and price.

Dynamic groups on a contract are evaluated live when the estimate or invoice is computed, not from the member list cached on the Device Groups page, so a device that changed since the group was last refreshed is still billed correctly. The one exception is a filter condition that tests membership in *another* group, which reads that group's cached list. A group billed by a draft, active or paused contract cannot be deleted until the line is removed; a group deleted after a contract ended stays on that contract's lines by name.
```

- [ ] **Step 2: Build and commit**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds.

```bash
git add apps/docs/src/content/docs/features/contracts.mdx
git commit -m "docs(contracts): per device group lines (#3205 W02)"
```

---

### Task 12: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Full local verification on a fresh test stack**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../web && npx tsc --noEmit -p tsconfig.json && cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
pnpm lint
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
# fresh DB
export DATABASE_URL=<test stack url> && cd apps/api && pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts \
  src/__tests__/integration/groupMembership.resolve.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/deviceGroupDelete.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractDeviceRoles.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts \
  src/__tests__/integration/dynamicGroupMembershipMaterialization.integration.test.ts \
  src/__tests__/integration/groupDeleteMembershipLog.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all green. Then the manual checks from the spec's Testing section (psql CHECK probes as `breeze_app`; group delete through the UI against an active and a cancelled contract).

- [ ] **Step 2: Tear down the test stack, push, open the PR**

```bash
git push -u origin feature/3205-device-groups/wave-4648
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): contract lines billed by device group (#3205 W02)" --body "$(cat <<'EOF'
Closes #4648
Refs #4584
Refs #3205

Spec: `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-group-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md`

## What

- New `per_device_group` contract line type. Static groups bill their current members; dynamic groups are evaluated LIVE at estimate and invoice time through a new read-only `resolveEffectiveGroupMembers` that the group evaluator also uses (one definition of membership). A stale materialized membership can never be invoiced (#4630 is the product-wide staleness bug; billing does not depend on it).
- The wave 1 device snapshot is per-device now, so group, role and site compose exactly in the pure coverage helpers; overlap still bills twice and covers once.
- A group that cannot be evaluated fails the estimate and generation loudly (`GROUP_EVALUATION_FAILED`, full rollback); the contracts list and MRR rollup degrade per contract instead of failing whole.
- Deleting a group goes through one transactional `deleteDeviceGroup` on all three surfaces (two routes + AI `manage_groups`); refused with 409 while a draft/active/paused contract bills it (contract names only for `contracts:read`). Lines on ended contracts keep the stamped group name after deletion.
- Tenancy: unique `device_groups(id, org_id)`, composite `(device_group_id, org_id)` and `(contract_id, org_id)` FKs, both `DEFERRABLE INITIALLY IMMEDIATE` for org merge; a group line carries no `site_id` (Zod + CHECK).

## Migrations

- `2026-10-06-100000-contract-line-type-per-device-group.sql` — enum value only.
- `2026-10-06-100100-contract-lines-device-group.sql` — unique index, two columns, CHECK, two deferrable composite FKs, partial index, contract/org preflight (raises on a pre-existing mismatch).

## Tests

Shared validator; CHECK/FK/deferrable truth table; resolver (static, dynamic ∪ pinned, NULL filter, malformed filter, site-bound, forged-org row); the headline stale-membership test with request-vs-system parity; ephemeral/decommissioned/off-site members; failure rollback + list degradation; deleted-group handling; delete service by contract status + children; route/AI 409 mapping with permission-gated disclosure; worker isolation; export/erasure round-trip; web editor/detail/list/delete-modal; locale parity.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
EOF
)"
```

Stop here. Do not merge. Report the PR URL and anything that was skipped or failed.
