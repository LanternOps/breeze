# Contract Lines Billed by Device Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `per_device_role` contract line type that bills a set of device roles (e.g. switch + router + firewall) with quantities resolved automatically each period, and surface devices no line bills instead of billing them at zero silently.

**Architecture:** One new enum value and one `text[]` column on `contract_lines`, guarded by a CHECK that hard-codes the billable role list. All device-counted quantities on a contract (existing `per_device` and new `per_device_role`) derive from one grouped snapshot query per org, computed in memory by pure helpers in a new `contractCoverage.ts`, which also produce the "uncovered devices" warning returned by the estimate endpoint and by invoice generation. The web editor gains a role checkbox group; both contract pages show the coverage notice.

**Tech Stack:** Postgres 16, Drizzle ORM, Hono, Zod 4 (`z.string().guid()`), Vitest (unit + `vitest.integration.config.ts` real-DB suites), React + react-i18next (8 locales), Astro.

**Spec:** `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md`

## Global Constraints

- Migrations must sort after the newest committed file, `2026-10-02-100000-outbox-retention-indexes.sql`. Re-run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -1` before creating them; if something newer landed, bump the date past it (keep the `-100000-` / `-100100-` time components).
- The enum value and any statement that references it must be in separate migration files (`autoMigrate` wraps each file in one transaction; Postgres refuses to use an enum value added in the same transaction).
- Migrations are idempotent (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add), no inner `BEGIN;`/`COMMIT;`, cleanup statements report row counts via `RAISE WARNING`.
- `contract_lines.device_roles` is `text[]`, never `jsonb`. It goes in the `included` bucket of `CORE_TENANT_EXPORT_POLICY`.
- `'unknown'` is never a billable role, in Zod, in the CHECK, or in the web picker.
- A `per_device_role` row with null or empty roles must throw, never fall through to an unfiltered count.
- Every quantity for `per_device` and `per_device_role` lines on one contract comes from one `snapshotContractDevices(orgId)` call, never from per-line `COUNT` queries.
- Web mutation handlers use `runAction`. UI state in components uses `data-testid` for tests. New i18n keys go in all eight `apps/web/src/locales/*/billing.json` files (`localeParity.test.ts` fails otherwise).
- Red first: write the failing test, run it, watch it fail, then implement.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
  ```
- Run unit tests with `cd <pkg> && npx vitest run <path>` (never `pnpm --filter <pkg> test -- --run`). Integration tests need `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"` and run with `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/shared/src/validators/deviceRoles.ts` (new) | SSOT for `DEVICE_ROLES`, `BILLABLE_DEVICE_ROLES`, `DeviceRole`, `BillableDeviceRole` |
| `packages/shared/src/validators/index.ts` | Re-exports the new module; stops declaring `DEVICE_ROLES` itself |
| `packages/shared/src/validators/contracts.ts` | `contractLineInputSchema`: new type, `deviceRoles`, refines |
| `apps/api/migrations/2026-10-03-100000-contract-line-type-per-device-role.sql` (new) | Enum value only |
| `apps/api/migrations/2026-10-03-100100-contract-lines-device-roles.sql` (new) | Column, CHECK, site-ownership cleanup + composite FK |
| `apps/api/src/db/schema/contracts.ts` | Enum + `deviceRoles` column |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `device_roles` in `included` |
| `apps/api/src/services/contractQuantities.ts` | `countContractDevices(..., roles?)`, `snapshotContractDevices` |
| `apps/api/src/services/contractCoverage.ts` (new) | Pure: `isDeviceLine`, `quantityFor`, `uncoveredByRole` |
| `apps/api/src/services/contractService.ts` | Snapshot-based `resolveLineQty`, estimate `uncoveredDevices`, writers, `generateDueInvoice` |
| `apps/api/src/services/contractTypes.ts` | `SITE_NOT_IN_ORG` error code |
| `apps/api/src/services/quoteToContract.ts` | `NewContractLineSpec` gains the type + `deviceRoles` |
| `apps/api/src/jobs/contractWorker.ts` | Logs `uncoveredDevices` beside price-book gaps |
| `apps/api/src/services/aiToolsContracts.ts` | Tool description documents the new line shape |
| `apps/web/src/lib/api/contracts.ts` | Types |
| `apps/web/src/lib/deviceRoles.ts` | `BILLABLE_DEVICE_ROLES` |
| `apps/web/src/components/contracts/lineTypes.ts` (new) | Shared `LINE_TYPE_LABELS`, `AUTO_QTY_TYPES`, `SITE_SCOPED_TYPES` |
| `apps/web/src/components/contracts/DeviceCoverageNotice.tsx` (new) | Coverage warning / all-covered line |
| `apps/web/src/components/contracts/ContractEditor.tsx` | Role picker, payload, row sub-label, notice |
| `apps/web/src/components/contracts/ContractDetail.tsx` | Row sub-label, notice, generate toast |
| `apps/web/src/locales/*/billing.json` | Keys |
| `apps/docs/src/content/docs/features/contracts.mdx` | Line-type table row + coverage paragraph |

---

### Task 1: Shared validators — role tuples and `contractLineInputSchema`

**Files:**
- Create: `packages/shared/src/validators/deviceRoles.ts`
- Modify: `packages/shared/src/validators/index.ts:36-45` (and its import block at the top)
- Modify: `packages/shared/src/validators/contracts.ts:8-33`
- Test: `packages/shared/src/validators/deviceRoles.test.ts` (new), `packages/shared/src/validators/contracts.test.ts`

**Interfaces:**
- Produces: `BILLABLE_DEVICE_ROLES` (readonly tuple of 11), `BillableDeviceRole`, `DEVICE_ROLES` (12, `'unknown'` last), `DeviceRole`, all exported from `@breeze/shared`. `contractLineInputSchema` accepts `lineType: 'per_device_role'` with `deviceRoles: BillableDeviceRole[]` (min 1, no duplicates, only on that type) and `siteId` on `per_device | per_device_role`.

- [ ] **Step 1: Write the failing tuple test**

Create `packages/shared/src/validators/deviceRoles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BILLABLE_DEVICE_ROLES, DEVICE_ROLES } from './deviceRoles';

describe('device role tuples (#3205)', () => {
  it('DEVICE_ROLES is BILLABLE_DEVICE_ROLES plus a trailing unknown', () => {
    expect(DEVICE_ROLES).toEqual([...BILLABLE_DEVICE_ROLES, 'unknown']);
    expect(BILLABLE_DEVICE_ROLES).not.toContain('unknown');
    expect(BILLABLE_DEVICE_ROLES).toHaveLength(11);
  });

  it('is still exported from the validators barrel', async () => {
    const barrel = await import('./index');
    expect(barrel.DEVICE_ROLES).toBe(DEVICE_ROLES);
    expect(barrel.BILLABLE_DEVICE_ROLES).toBe(BILLABLE_DEVICE_ROLES);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/deviceRoles.test.ts`
Expected: FAIL, cannot resolve `./deviceRoles`.

- [ ] **Step 3: Create the module and move the tuple**

Create `packages/shared/src/validators/deviceRoles.ts`:

```ts
/**
 * Device-role SSOT (#3205 moved it here from the validators barrel).
 *
 * Lives in its own module so sibling validators (contracts.ts) can import it
 * directly. The barrel re-exports contracts.ts BEFORE the line where these
 * tuples used to be declared, so importing them back through index.ts during
 * schema construction was an initialization cycle waiting to happen.
 *
 * Adding a role here means also widening `contract_lines_device_roles_chk`
 * (migration 2026-10-03-100100) and the web mirror in apps/web/src/lib/deviceRoles.ts.
 */
export const BILLABLE_DEVICE_ROLES = [
  'workstation', 'server', 'printer', 'router', 'switch',
  'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas',
] as const;
export type BillableDeviceRole = typeof BILLABLE_DEVICE_ROLES[number];

/** `unknown` is the enrollment default: a classification gap, never a rate. */
export const DEVICE_ROLES = [...BILLABLE_DEVICE_ROLES, 'unknown'] as const;
export type DeviceRole = typeof DEVICE_ROLES[number];
```

In `packages/shared/src/validators/index.ts`:
1. Add `import { DEVICE_ROLES } from './deviceRoles';` directly under the existing `} from '../constants';` import (line 14). If `grep -n "DeviceRole\b" packages/shared/src/validators/index.ts` shows the type used in that file, import it too: `import { DEVICE_ROLES, type DeviceRole } from './deviceRoles';`.
2. Add `export * from './deviceRoles';` after `export * from './psa';` (line 35).
3. Delete the five lines that declare `DEVICE_ROLES` and `DeviceRole` (currently 41-45), leaving the `// Device Roles` section comment and the virtualization comment that follows.

- [ ] **Step 4: Run the tuple test and the whole shared suite**

Run: `cd packages/shared && npx vitest run src/validators/deviceRoles.test.ts && npx vitest run src/validators`
Expected: PASS, no regressions (the barrel test proves `DEVICE_ROLES` still resolves through `index.ts`).

- [ ] **Step 5: Write the failing line-schema tests**

Append to `packages/shared/src/validators/contracts.test.ts`:

```ts
// #3205: a per_device_role line bills a SET of device roles. deviceRoles is
// required on that type and forbidden on every other, mirrors the DB CHECK,
// never contains 'unknown' (a classification gap, not a rate) or duplicates.
describe('contractLineInputSchema — per_device_role (#3205)', () => {
  const base = { description: 'Network gear', unitPrice: '25.00', taxable: true };
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('requires a non-empty deviceRoles array on per_device_role', () => {
    expect(parse({ ...base, lineType: 'per_device_role' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: [] })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['switch', 'router', 'firewall'] })).toBe(true);
  });

  it('rejects deviceRoles on every other line type', () => {
    for (const lineType of ['flat', 'per_device', 'per_seat'] as const) {
      expect(parse({ ...base, lineType, deviceRoles: ['server'] })).toBe(false);
    }
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '2', deviceRoles: ['server'] })).toBe(false);
  });

  it('rejects unknown and unrecognised roles', () => {
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['unknown'] })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server', 'mainframe'] })).toBe(false);
  });

  it('rejects duplicate roles', () => {
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server', 'server'] })).toBe(false);
  });

  it('accepts siteId on per_device_role and still rejects it on flat / per_seat / manual', () => {
    const siteId = '22222222-2222-2222-2222-222222222222';
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['workstation'], siteId })).toBe(true);
    expect(parse({ ...base, lineType: 'flat', siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'per_seat', siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '1', siteId })).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: FAIL on the first `per_device_role` case (enum rejects the value, so `parse(... deviceRoles: [...])` returns `false` where `true` is expected).

- [ ] **Step 7: Implement the schema change**

In `packages/shared/src/validators/contracts.ts`, add the import and replace the `contractLineInputSchema` block (lines 8-33) with:

```ts
import { BILLABLE_DEVICE_ROLES } from './deviceRoles';

export const CONTRACT_LINE_TYPES = ['flat', 'per_device', 'per_device_role', 'per_seat', 'manual'] as const;
export type ContractLineType = typeof CONTRACT_LINE_TYPES[number];

export const contractLineInputSchema = z.object({
  lineType: z.enum(CONTRACT_LINE_TYPES),
  description: z.string().min(1).max(2000),
  // Multi-currency wave 3 (#3775): a catalog-sourced line is priced by the
  // server-side resolver in the CONTRACT's currency, so unitPrice is optional
  // when catalogItemId is set (and any client value is ignored there — the
  // resolver is authoritative, as is taxable). Non-catalog lines require it.
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  catalogItemId: z.string().guid().optional(),
  manualQuantity: money.optional(),
  siteId: z.string().guid().optional(),
  // #3205: the SET of roles a per_device_role line bills. 'unknown' is not a
  // rate; the DB CHECK (contract_lines_device_roles_chk) enforces the same list.
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  sortOrder: z.number().int().min(0).optional()
}).refine(
  (l) => l.unitPrice !== undefined || l.catalogItemId !== undefined,
  { message: 'unitPrice is required unless catalogItemId is set', path: ['unitPrice'] }
).refine(
  (l) => l.taxable !== undefined || l.catalogItemId !== undefined,
  { message: 'taxable is required unless catalogItemId is set', path: ['taxable'] }
).refine(
  (l) => l.lineType !== 'manual' || l.manualQuantity !== undefined,
  { message: 'manualQuantity is required for manual lines', path: ['manualQuantity'] }
).refine(
  (l) => l.lineType === 'per_device' || l.lineType === 'per_device_role' || l.siteId === undefined,
  { message: 'siteId is only valid on per_device and per_device_role lines', path: ['siteId'] }
).refine(
  // Two-way on purpose (stricter than the manualQuantity rule): the CHECK
  // constraint rejects roles on any other type, so the validator must too.
  (l) => (l.lineType === 'per_device_role') === (l.deviceRoles !== undefined),
  { message: 'deviceRoles is required on per_device_role lines and not allowed on other line types', path: ['deviceRoles'] }
).refine(
  (l) => l.deviceRoles === undefined || new Set(l.deviceRoles).size === l.deviceRoles.length,
  { message: 'deviceRoles must not contain duplicates', path: ['deviceRoles'] }
);
```

- [ ] **Step 8: Run the shared suite**

Run: `cd packages/shared && npx vitest run src/validators && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/validators/deviceRoles.ts packages/shared/src/validators/deviceRoles.test.ts packages/shared/src/validators/index.ts packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts
git commit -m "feat(shared): per_device_role contract line type + BILLABLE_DEVICE_ROLES (#3205)"
```

---

### Task 2: Migrations, Drizzle schema, export policy

**Files:**
- Create: `apps/api/migrations/2026-10-03-100000-contract-line-type-per-device-role.sql`
- Create: `apps/api/migrations/2026-10-03-100100-contract-lines-device-roles.sql`
- Modify: `apps/api/src/db/schema/contracts.ts:14-16, 56-74`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:148`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing), `pnpm db:check-drift`, `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` (existing)

**Interfaces:**
- Produces: enum `contract_line_type` has `per_device_role`; `contract_lines.device_roles text[]`; Drizzle `contractLines.deviceRoles: DeviceRole[] | null`; constraints `contract_lines_device_roles_chk` and `contract_lines_site_org_fk`; the old `contract_lines_site_fkey` is gone.

- [ ] **Step 1: Confirm the sort position**

Run: `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -1`
Expected: `2026-10-02-100000-outbox-retention-indexes.sql`. If newer, rename both files below to sort after it.

- [ ] **Step 2: Write Migration A**

Create `apps/api/migrations/2026-10-03-100000-contract-line-type-per-device-role.sql`:

```sql
-- #3205: contract lines billed by device role. Spec:
-- docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate
-- wraps each file in one — so every statement referencing 'per_device_role'
-- lives in 2026-10-03-100100-contract-lines-device-roles.sql, not here.
-- (Precedent: 2026-09-05-b-audit-actor-type-ai-agent.sql.)

ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_role';
```

- [ ] **Step 3: Write Migration B**

Create `apps/api/migrations/2026-10-03-100100-contract-lines-device-roles.sql`:

```sql
-- #3205: contract lines billed by device role — column, invariant, site ownership.
-- Companion to 2026-10-03-100000-contract-line-type-per-device-role.sql (enum value).

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_roles text[];

-- Role lines carry a non-empty, one-dimensional, null-free array of known
-- BILLABLE roles ('unknown' is a classification gap, never a rate); every other
-- line type carries NULL — not an empty array. This is the DB twin of
-- contractLineInputSchema (packages/shared/src/validators/contracts.ts).
-- Widen the list here when BILLABLE_DEVICE_ROLES grows.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_roles_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_roles_chk CHECK (
  CASE WHEN line_type = 'per_device_role' THEN
    device_roles IS NOT NULL
    AND cardinality(device_roles) > 0
    AND array_ndims(device_roles) = 1
    AND array_position(device_roles, NULL) IS NULL
    AND device_roles <@ ARRAY['workstation','server','printer','router','switch',
                              'firewall','access_point','phone','iot','camera','nas']::text[]
  ELSE device_roles IS NULL END
);

-- Site ownership. contract_lines_site_fkey (2026-06-15-d) referenced sites(id)
-- alone, so a site from ANOTHER org was accepted and the device count silently
-- returned zero. Clear any such rows (count logged — forensic trail), then
-- replace the FK with a composite one against sites_id_org_id_uniq (2026-07-23).
-- ON DELETE SET NULL (site_id): the column list (PG 15+) nulls only site_id; a
-- bare SET NULL would also null org_id, which is NOT NULL.
DO $$ DECLARE n int; BEGIN
  UPDATE contract_lines cl SET site_id = NULL
    FROM sites s WHERE cl.site_id = s.id AND s.org_id <> cl.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'cleaned % contract_lines rows whose site belonged to another org', n; END IF;
END $$;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_fkey;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_org_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE SET NULL (site_id);
```

- [ ] **Step 4: Run the migration-naming guard and the ordering test**

Run: `scripts/check-migration-naming.sh && cd apps/api && npx vitest run src/db/autoMigrate.test.ts`
Expected: guard prints OK; ordering test PASS.

- [ ] **Step 5: Update the Drizzle schema**

In `apps/api/src/db/schema/contracts.ts`:

Enum (lines 14-16):
```ts
export const contractLineTypeEnum = pgEnum('contract_line_type', [
  'flat', 'per_device', 'per_device_role', 'per_seat', 'manual'
]);
```

Add at the top, with the other imports:
```ts
import type { DeviceRole } from '@breeze/shared';
```

In `contractLines`, after `siteId: uuid('site_id'),`:
```ts
  // #3205: the SET of roles a per_device_role line bills. NULL on every other
  // type — enforced by contract_lines_device_roles_chk (SQL-only, like the
  // catalog_item_id / site_id FKs above). $type narrows the row to DeviceRole[]
  // so contractCoverage.ts needs no cast.
  deviceRoles: text('device_roles').array().$type<DeviceRole[]>(),
```

- [ ] **Step 6: Register the column in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts` line 148, insert `"device_roles"` after `"site_id"` in the `included` array of the `contract_lines` entry so it reads:

```ts
  "contract_lines": tablePolicy("org_id", {"included":["id","contract_id","org_id","line_type","description","catalog_item_id","unit_price","manual_quantity","site_id","device_roles","taxable","sort_order","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 7: Apply migrations locally and check drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx tsc --noEmit
```
Expected: both migrations apply (the second logs `cleaned 0 ...` only if rows existed, otherwise nothing); drift check clean; typecheck clean.

- [ ] **Step 8: Run the export-policy contract suite**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: PASS (it would fail with an unclassified `device_roles` column had Step 6 been skipped).

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-10-03-100000-contract-line-type-per-device-role.sql apps/api/migrations/2026-10-03-100100-contract-lines-device-roles.sql apps/api/src/db/schema/contracts.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): contract_lines.device_roles + per_device_role enum + site ownership FK (#3205)"
```

---

### Task 3: Counting — role filter, org snapshot, pure coverage helpers

**Files:**
- Modify: `apps/api/src/services/contractQuantities.ts`
- Create: `apps/api/src/services/contractCoverage.ts`
- Test: `apps/api/src/services/contractCoverage.test.ts` (new, unit), `apps/api/src/__tests__/integration/contractDeviceRoles.integration.test.ts` (new, real DB)

**Interfaces:**
- Produces:
  ```ts
  // contractQuantities.ts
  export interface DeviceSnapshotRow { role: string; siteId: string | null; n: number }
  export async function countContractDevices(orgId: string, siteId: string | null, roles?: readonly DeviceRole[]): Promise<number>
  export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]>
  // contractCoverage.ts
  export interface CoverageLine { lineType: 'flat'|'per_device'|'per_device_role'|'per_seat'|'manual'; siteId: string | null; deviceRoles: readonly string[] | null }
  export interface UncoveredDevices { total: number; byRole: Record<string, number> }
  export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean
  export function quantityFor(snapshot: readonly DeviceSnapshotRow[], line: CoverageLine): number
  export function uncoveredByRole(snapshot: readonly DeviceSnapshotRow[], lines: readonly CoverageLine[]): UncoveredDevices
  ```

- [ ] **Step 1: Write the failing pure-helper tests**

Create `apps/api/src/services/contractCoverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isDeviceLine, quantityFor, uncoveredByRole, type CoverageLine } from './contractCoverage';
import type { DeviceSnapshotRow } from './contractQuantities';

const A = 'site-a';
const B = 'site-b';
// One org: 2 workstations at A, 1 at B; 1 server at A; 1 switch at B; 1 unknown at A.
const snapshot: DeviceSnapshotRow[] = [
  { role: 'workstation', siteId: A, n: 2 },
  { role: 'workstation', siteId: B, n: 1 },
  { role: 'server', siteId: A, n: 1 },
  { role: 'switch', siteId: B, n: 1 },
  { role: 'unknown', siteId: A, n: 1 },
];
const line = (p: Partial<CoverageLine> & Pick<CoverageLine, 'lineType'>): CoverageLine =>
  ({ siteId: null, deviceRoles: null, ...p });

describe('isDeviceLine', () => {
  it('is true only for the two device-counted types', () => {
    expect(isDeviceLine({ lineType: 'per_device' })).toBe(true);
    expect(isDeviceLine({ lineType: 'per_device_role' })).toBe(true);
    for (const lineType of ['flat', 'per_seat', 'manual'] as const) expect(isDeviceLine({ lineType })).toBe(false);
  });
});

describe('quantityFor', () => {
  it.each<[string, CoverageLine, number]>([
    ['per_device org-wide counts every row', line({ lineType: 'per_device' }), 6],
    ['per_device scoped to a site', line({ lineType: 'per_device', siteId: A }), 4],
    ['per_device_role single role', line({ lineType: 'per_device_role', deviceRoles: ['server'] }), 1],
    ['per_device_role role set', line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }), 4],
    ['per_device_role scoped to a site', line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['workstation', 'switch'] }), 2],
    ['per_device_role with no matching devices', line({ lineType: 'per_device_role', deviceRoles: ['printer'] }), 0],
  ])('%s', (_name, l, expected) => {
    expect(quantityFor(snapshot, l)).toBe(expected);
  });

  it('throws for a non-device line type', () => {
    expect(() => quantityFor(snapshot, line({ lineType: 'flat' }))).toThrow(/not a device-counted/);
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
    expect(uncoveredByRole(snapshot, [line({ lineType: 'per_device', siteId: A })])).toEqual({
      total: 2, byRole: { workstation: 1, switch: 1 },
    });
  });

  it('role lines cover only their roles; unknown is always uncovered', () => {
    const lines = [
      line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('a site-scoped role line does not cover the same role at another site', () => {
    const lines = [line({ lineType: 'per_device_role', siteId: A, deviceRoles: ['workstation'] })];
    expect(uncoveredByRole(snapshot, lines)).toEqual({
      total: 4, byRole: { workstation: 1, server: 1, switch: 1, unknown: 1 },
    });
  });

  it('overlapping role lines report a device as covered once', () => {
    const lines = [
      line({ lineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['server', 'workstation', 'switch'] }),
    ];
    expect(uncoveredByRole(snapshot, lines)).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('empty inventory is zero, not an error', () => {
    expect(uncoveredByRole([], [line({ lineType: 'per_device_role', deviceRoles: ['server'] })])).toEqual({ total: 0, byRole: {} });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts`
Expected: FAIL, cannot resolve `./contractCoverage`.

- [ ] **Step 3: Implement `contractQuantities.ts`**

Replace the file contents with:

```ts
import { and, eq, ne, count, countDistinct, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizationUsers, users } from '../db/schema';
import type { DeviceRole } from '@breeze/shared';

/** The one set of "is this device billable" predicates. Every device count and
 *  the snapshot below MUST use it — never fork these conditions. */
function billableDeviceConds(orgId: string) {
  return [
    eq(devices.orgId, orgId),
    ne(devices.status, 'decommissioned' as never),
    // Quick Support ephemeral devices: an ad-hoc support session must never
    // bill a customer for a machine that existed for twenty minutes.
    eq(devices.isEphemeral, false),
  ];
}

/** Billable device count for an org, optionally narrowed to a site and/or a set
 *  of device roles (#3205). Excludes decommissioned + ephemeral.
 *  Must be called inside a db access context (system for the worker, request otherwise). */
export async function countContractDevices(
  orgId: string,
  siteId: string | null,
  roles?: readonly DeviceRole[],
): Promise<number> {
  const conds = billableDeviceConds(orgId);
  if (siteId) conds.push(eq(devices.siteId, siteId));
  if (roles && roles.length > 0) conds.push(inArray(devices.deviceRole, [...roles]));
  const [row] = await db.select({ n: count() }).from(devices).where(and(...conds));
  return Number(row?.n ?? 0);
}

export interface DeviceSnapshotRow {
  role: string;
  siteId: string | null;
  n: number;
}

/** One snapshot of the org's billable devices grouped by (role, site). Every
 *  device-counted quantity on a contract — and the coverage warning — derives
 *  from this single query, so a device reclassified between two per-line COUNTs
 *  can no longer be billed twice (or not at all) on the same invoice (#3205). */
export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]> {
  const rows = await db
    .select({ role: devices.deviceRole, siteId: devices.siteId, n: count() })
    .from(devices)
    .where(and(...billableDeviceConds(orgId)))
    .groupBy(devices.deviceRole, devices.siteId);
  return rows.map((r) => ({ role: r.role, siteId: r.siteId, n: Number(r.n) }));
}

/** Active-seat count for an org: distinct active users mapped via organization_users. */
export async function countContractSeats(orgId: string): Promise<number> {
  const [row] = await db.select({ n: countDistinct(organizationUsers.userId) })
    .from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active' as never)));
  return Number(row?.n ?? 0);
}
```

- [ ] **Step 4: Implement `contractCoverage.ts`**

Create `apps/api/src/services/contractCoverage.ts`:

```ts
/**
 * Pure arithmetic over one org device snapshot (#3205). No DB, no I/O — the
 * service fetches `snapshotContractDevices(orgId)` once and every device-counted
 * line and the coverage warning are computed here from that same snapshot.
 */
import type { DeviceSnapshotRow } from './contractQuantities';

/** The subset of a contract_lines row that coverage math needs. */
export interface CoverageLine {
  lineType: 'flat' | 'per_device' | 'per_device_role' | 'per_seat' | 'manual';
  siteId: string | null;
  deviceRoles: readonly string[] | null;
}

export interface UncoveredDevices {
  total: number;
  /** role -> count of billable devices no line on the contract bills. */
  byRole: Record<string, number>;
}

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return line.lineType === 'per_device' || line.lineType === 'per_device_role';
}

function lineMatches(line: CoverageLine, row: DeviceSnapshotRow): boolean {
  if (line.siteId !== null && line.siteId !== row.siteId) return false;
  if (line.lineType === 'per_device') return true;
  if (line.lineType === 'per_device_role') return (line.deviceRoles ?? []).includes(row.role);
  return false;
}

/** Quantity for a per_device / per_device_role line. Throws for any other type:
 *  the caller's switch is exhaustive and must not route flat/seat/manual here. */
export function quantityFor(snapshot: readonly DeviceSnapshotRow[], line: CoverageLine): number {
  if (!isDeviceLine(line)) {
    throw new Error(`quantityFor: ${line.lineType} is not a device-counted line type`);
  }
  let n = 0;
  for (const row of snapshot) if (lineMatches(line, row)) n += row.n;
  return n;
}

/** Billable devices that NO device-counted line on the contract bills, by role.
 *  Site scoping is exact: a role line scoped to site A does not cover that role
 *  at site B. 'unknown' rows can only be covered by a per_device line. */
export function uncoveredByRole(
  snapshot: readonly DeviceSnapshotRow[],
  lines: readonly CoverageLine[],
): UncoveredDevices {
  const deviceLines = lines.filter(isDeviceLine);
  const byRole: Record<string, number> = {};
  let total = 0;
  for (const row of snapshot) {
    if (deviceLines.some((l) => lineMatches(l, row))) continue;
    byRole[row.role] = (byRole[row.role] ?? 0) + row.n;
    total += row.n;
  }
  return { total, byRole };
}
```

- [ ] **Step 5: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Write the failing real-DB test**

Create `apps/api/src/__tests__/integration/contractDeviceRoles.integration.test.ts`:

```ts
/**
 * #3205 — device-role counting against a real Postgres as breeze_app.
 * Own fixture (not contractQuantities.integration.test.ts) so the existing
 * org-wide / per-site assertions there stay untouched.
 *
 * Fixture: partner → org → siteA + siteB
 *   w1 workstation A  | w2 workstation B | s1 server A | sw1 switch B
 *   u1 (role default 'unknown') A
 *   s2 server A decommissioned (excluded) | s3 server A ephemeral (excluded)
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices } from '../../db/schema';
import { countContractDevices, snapshotContractDevices } from '../../services/contractQuantities';

async function seed(): Promise<{ orgId: string; siteAId: string; siteBId: string }> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `RP ${sfx}`, slug: `rp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'ROrg', slug: `ro-${sfx}` })
      .returning({ id: organizations.id });
    const orgId = o!.id;
    const [sA, sB] = await db.insert(sites)
      .values([{ orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` }])
      .returning({ id: sites.id });
    const base = { orgId, osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' };
    await db.insert(devices).values([
      { ...base, siteId: sA!.id, agentId: `w1-${sfx}`, hostname: 'w1', status: 'online', deviceRole: 'workstation' },
      { ...base, siteId: sB!.id, agentId: `w2-${sfx}`, hostname: 'w2', status: 'online', deviceRole: 'workstation' },
      { ...base, siteId: sA!.id, agentId: `s1-${sfx}`, hostname: 's1', status: 'online', deviceRole: 'server' },
      { ...base, siteId: sB!.id, agentId: `sw1-${sfx}`, hostname: 'sw1', status: 'offline', deviceRole: 'switch' },
      { ...base, siteId: sA!.id, agentId: `u1-${sfx}`, hostname: 'u1', status: 'online' }, // deviceRole default 'unknown'
      { ...base, siteId: sA!.id, agentId: `s2-${sfx}`, hostname: 's2', status: 'decommissioned', deviceRole: 'server' },
      { ...base, siteId: sA!.id, agentId: `s3-${sfx}`, hostname: 's3', status: 'online', deviceRole: 'server', isEphemeral: true },
    ]);
    return { orgId, siteAId: sA!.id, siteBId: sB!.id };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('device-role contract counting (breeze_app, real DB) #3205', () => {
  runDb('countContractDevices without roles is unchanged (5 billable)', async () => {
    const { orgId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null))).toBe(5);
  });

  runDb('filters by a single role and excludes decommissioned + ephemeral', async () => {
    const { orgId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null, ['server']))).toBe(1);
  });

  runDb('filters by a role set', async () => {
    const { orgId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null, ['workstation', 'server']))).toBe(3);
  });

  runDb('site narrowing composes with roles', async () => {
    const { orgId, siteAId } = await seed();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, siteAId, ['workstation']))).toBe(1);
  });

  runDb('snapshotContractDevices groups billable devices by (role, site)', async () => {
    const { orgId, siteAId, siteBId } = await seed();
    const snap = await withSystemDbAccessContext(() => snapshotContractDevices(orgId));
    const sorted = [...snap].sort((a, b) => `${a.role}|${a.siteId}`.localeCompare(`${b.role}|${b.siteId}`));
    expect(sorted).toEqual([
      { role: 'server', siteId: siteAId, n: 1 },
      { role: 'switch', siteId: siteBId, n: 1 },
      { role: 'unknown', siteId: siteAId, n: 1 },
      { role: 'workstation', siteId: siteAId, n: 1 },
      { role: 'workstation', siteId: siteBId, n: 1 },
    ].sort((a, b) => `${a.role}|${a.siteId}`.localeCompare(`${b.role}|${b.siteId}`)));
    expect(snap.reduce((s, r) => s + r.n, 0)).toBe(5);
  });
});
```

- [ ] **Step 7: Run it (fails before Step 3 was applied; passes now)**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractDeviceRoles.integration.test.ts`
Expected: 5 tests PASS. Confirm in the output that the file actually ran (5 tests, not 0 skipped); `runIf` silently skips without `DATABASE_URL`.

- [ ] **Step 8: Run the neighbouring suites that mock or call these functions**

Run: `cd apps/api && npx vitest run src/services/actionIntents/exposureBudget.test.ts src/services/aiAgents/actRevalidation.test.ts && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractQuantities.integration.test.ts`
Expected: PASS (two-argument callers are unaffected).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/contractQuantities.ts apps/api/src/services/contractCoverage.ts apps/api/src/services/contractCoverage.test.ts apps/api/src/__tests__/integration/contractDeviceRoles.integration.test.ts
git commit -m "feat(api): role-filtered device counts, org device snapshot, pure coverage helpers (#3205)"
```

---

### Task 4: Service — snapshot-based quantities, estimate warning, line writers

**Files:**
- Modify: `apps/api/src/services/contractService.ts` (imports at 1-40; `DeviceCache`/`resolveLineQty`/`computeContractEstimate` at 178-218; `addContractLineToContract` insert at ~836-841; `createContractWithLinesDetailed` insert at ~1161-1171)
- Modify: `apps/api/src/services/contractTypes.ts:33-45` (error code union)
- Modify: `apps/api/src/services/quoteToContract.ts:27-38`
- Test: `apps/api/src/services/contractService.test.ts`, `apps/api/src/__tests__/integration/contractService.integration.test.ts`

**Interfaces:**
- Consumes: `snapshotContractDevices`, `DeviceSnapshotRow`, `quantityFor`, `uncoveredByRole`, `isDeviceLine`, `UncoveredDevices` (Task 3).
- Produces: `computeContractEstimate` returns `{ currencyCode, periodTotal, lines, uncoveredDevices: UncoveredDevices | null }`; `ContractServiceErrorCode` gains `'SITE_NOT_IN_ORG'`; `NewContractLineSpec.lineType` includes `'per_device_role'` and `deviceRoles?: DeviceRole[] | null`.

- [ ] **Step 1: Update the unit-test mocks that the MRR suite relies on, and write the new failing unit tests**

In `apps/api/src/services/contractService.test.ts`:

Change the `contractQuantities` mock (line 38) to:
```ts
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn(), countContractSeats: vi.fn(), snapshotContractDevices: vi.fn(),
}));
```
Change the import (line 59) to:
```ts
import { countContractDevices, countContractSeats, snapshotContractDevices } from './contractQuantities';
```
In `describe('summarizeActiveContractMrrByOrg (#3779)')` `beforeEach` (line ~539) add `vi.mocked(snapshotContractDevices).mockResolvedValue([]);`. In the test `'batches device counts: one call per distinct (orgId, siteId) across all orgs'` (line ~668) replace the two `countContractDevices` lines with:
```ts
    vi.mocked(snapshotContractDevices).mockResolvedValue([{ role: 'workstation', siteId: null, n: 2 }]);
    ...
    expect(vi.mocked(snapshotContractDevices).mock.calls.length).toBe(3); // one snapshot per org
```
and rename the test to `'batches device counts: one snapshot per org across all orgs'`.

Then append this new suite:

```ts
// #3205: device-counted lines resolve from ONE org snapshot; per_device_role
// with no roles is an invariant violation, never an unfiltered count.
describe('computeContractEstimate — per_device_role + uncoveredDevices (#3205)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const contract = { id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' };
  const lineRow = (p: Record<string, unknown>) => ({
    id: 'l1', contractId: 'c1', orgId: 'org1', description: 'x', unitPrice: '10.00', taxable: false,
    catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null, sortOrder: 0, ...p,
  });
  const snapshot = [
    { role: 'workstation', siteId: null, n: 3 },
    { role: 'server', siteId: null, n: 2 },
    { role: 'unknown', siteId: null, n: 1 },
  ];

  it('bills the role set from the snapshot and reports uncovered devices by role', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(snapshot);
    queueResult([contract]); // getOwnedContractOr404
    queueResult([lineRow({ lineType: 'per_device_role', deviceRoles: ['server'], unitPrice: '50.00' })]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.lines).toEqual([{ lineId: 'l1', lineType: 'per_device_role', quantity: 2, value: '100.00', live: true }]);
    expect(out.uncoveredDevices).toEqual({ total: 4, byRole: { workstation: 3, unknown: 1 } });
    expect(vi.mocked(snapshotContractDevices)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(countContractDevices)).not.toHaveBeenCalled();
  });

  it('uncoveredDevices is null when the contract has no device-counted line', async () => {
    queueResult([contract]);
    queueResult([lineRow({ lineType: 'flat' })]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.uncoveredDevices).toBeNull();
    expect(vi.mocked(snapshotContractDevices)).not.toHaveBeenCalled();
  });

  it('throws INVALID_STATE for a per_device_role row with no roles instead of counting every device', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(snapshot);
    queueResult([contract]);
    queueResult([lineRow({ lineType: 'per_device_role', deviceRoles: null })]);
    await expect(svc.computeContractEstimate('c1', actor)).rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });
  });
});
```

`getOwnedContractOr404` issues exactly one select (line 47), so the queue order above is contract row, then line rows.

- [ ] **Step 2: Run to verify the new suite fails**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts`
Expected: the three new tests FAIL (`uncoveredDevices` undefined / quantity 0); the MRR suite may fail too until Step 3.

- [ ] **Step 3: Implement the service changes**

In `apps/api/src/services/contractService.ts`:

Imports. Replace `import { countContractDevices, countContractSeats } from './contractQuantities';` with:
```ts
import { countContractSeats, snapshotContractDevices, type DeviceSnapshotRow } from './contractQuantities';
import { isDeviceLine, quantityFor, uncoveredByRole, type UncoveredDevices } from './contractCoverage';
```
Add `sites` to the `'../db/schema'` import list.

Replace the block from `type DeviceCache` through the end of `computeContractEstimate` with:

```ts
// ---- recurring-value estimate (live per_device/per_device_role/per_seat) ----
// One device snapshot per org (#3205): every device-counted line on a contract
// is computed from the same grouped query, so a device reclassified between two
// per-line COUNTs can no longer be billed twice or skipped on the same run.
type DeviceCache = Map<string, DeviceSnapshotRow[]>; // key orgId
type SeatCache = Map<string, number>;                // key orgId
type ContractLineRow = typeof contractLines.$inferSelect;

async function orgSnapshot(orgId: string, dc: DeviceCache): Promise<DeviceSnapshotRow[]> {
  let snap = dc.get(orgId);
  if (!snap) { snap = await snapshotContractDevices(orgId); dc.set(orgId, snap); }
  return snap;
}

function assertRoleLineHasRoles(line: Pick<ContractLineRow, 'id' | 'lineType' | 'deviceRoles'>): void {
  if (line.lineType === 'per_device_role' && (!line.deviceRoles || line.deviceRoles.length === 0)) {
    // Unreachable under contract_lines_device_roles_chk, but the row type allows
    // null — and a role line must NEVER degrade into an every-device count.
    throw new ContractServiceError(`Contract line ${line.id} is per_device_role but carries no device roles`, 500, 'INVALID_STATE');
  }
}

async function resolveLineQty(
  orgId: string, line: ContractLineRow, dc: DeviceCache, sc: SeatCache,
): Promise<{ quantity: number; live: boolean }> {
  switch (line.lineType) {
    case 'flat': return { quantity: 1, live: false };
    case 'manual': return { quantity: Number(line.manualQuantity ?? '0'), live: false };
    case 'per_device':
    case 'per_device_role': {
      assertRoleLineHasRoles(line);
      return { quantity: quantityFor(await orgSnapshot(orgId, dc), line), live: true };
    }
    case 'per_seat': {
      if (!sc.has(orgId)) sc.set(orgId, await countContractSeats(orgId));
      return { quantity: sc.get(orgId)!, live: true };
    }
    default: {
      // Exhaustiveness: a new line type is a compile error here, not a silent qty 0.
      const _exhaustive: never = line.lineType;
      throw new ContractServiceError(`Unknown contract line type: ${String(line.lineType)}`, 500, 'INVALID_STATE');
    }
  }
}

export interface ContractEstimate {
  currencyCode: string;
  periodTotal: string;
  lines: Array<{ lineId: string; lineType: ContractLineRow['lineType']; quantity: number; value: string; live: boolean }>;
  /** Devices no device-counted line bills (#3205). null when the contract has
   *  no per_device / per_device_role line, so the UI can tell "n/a" from "0". */
  uncoveredDevices: UncoveredDevices | null;
}

/** Per-line resolved quantities + values + period total for one contract, using
 *  live device/seat counts as of now. Powers the editor sidebar and detail. */
export async function computeContractEstimate(contractId: string, actor: ContractActor): Promise<ContractEstimate> {
  const contract = await getOwnedContractOr404(contractId, actor);
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  let total = 0;
  const out: ContractEstimate['lines'] = [];
  for (const l of lines) {
    const { quantity, live } = await resolveLineQty(contract.orgId, l, dc, sc);
    const value = Number(l.unitPrice) * quantity;
    total += value;
    out.push({ lineId: l.id, lineType: l.lineType, quantity, value: value.toFixed(2), live });
  }
  const uncoveredDevices = lines.some(isDeviceLine)
    ? uncoveredByRole(await orgSnapshot(contract.orgId, dc), lines)
    : null;
  return { currencyCode: contract.currencyCode, periodTotal: total.toFixed(2), lines: out, uncoveredDevices };
}
```

Add a site-ownership helper near `assertEditable` (line ~57):

```ts
/** A line may only be scoped to a site of ITS OWN org. The composite FK
 *  contract_lines_site_org_fk is the backstop; this is the 400 the operator sees. */
async function assertSiteInOrg(tx: DbExecutor, siteId: string, orgId: string): Promise<void> {
  const [row] = await tx.select({ id: sites.id }).from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!row) throw new ContractServiceError('Site does not belong to this organization', 400, 'SITE_NOT_IN_ORG');
}
```
(`DbExecutor` is the type `lockContract` already takes at line 90; reuse it.)

In `addContractLineToContract`, replace the `tx.insert(contractLines).values({...})` block with:

```ts
    const scopesSite = input.lineType === 'per_device' || input.lineType === 'per_device_role';
    const siteId = scopesSite ? (input.siteId ?? null) : null;
    if (siteId) await assertSiteInOrg(tx, siteId, c.orgId);
    const [row] = await tx.insert(contractLines).values({
      contractId, orgId: c.orgId, lineType: input.lineType, description: input.description,
      catalogItemId: input.catalogItemId ?? null, unitPrice,
      manualQuantity: input.lineType === 'manual' ? (input.manualQuantity ?? '0') : null,
      siteId,
      // #3205: roles only on per_device_role (CHECK-enforced); the validator
      // already guarantees a non-empty, duplicate-free, billable set.
      deviceRoles: input.lineType === 'per_device_role' ? (input.deviceRoles ?? null) : null,
      taxable, sortOrder: input.sortOrder ?? 0
    }).returning();
```

In `createContractWithLinesDetailed`, replace the `db.insert(contractLines).values({...})` block with:

```ts
    const scopesSite = l.lineType === 'per_device' || l.lineType === 'per_device_role';
    const siteId = scopesSite ? (l.siteId ?? null) : null;
    if (siteId) await assertSiteInOrg(db, siteId, spec.orgId);
    const [insertedLine] = await db.insert(contractLines).values({
      contractId: contract.id,
      orgId: spec.orgId,
      lineType: l.lineType,
      description: l.description,
      catalogItemId: l.catalogItemId ?? null,
      unitPrice: l.unitPrice,
      manualQuantity: l.lineType === 'manual' ? (l.manualQuantity ?? '0') : null,
      siteId,
      deviceRoles: l.lineType === 'per_device_role' ? (l.deviceRoles ?? null) : null,
      taxable: l.taxable,
      sortOrder: l.sortOrder ?? i,
    }).returning({ id: contractLines.id });
```
`createContractWithLinesDetailed` runs against bare `db` (its caller supplies the transaction context), so `db` is the right executor here. `DbExecutor` is the local type declared at `contractService.ts:63`.

In `apps/api/src/services/contractTypes.ts`, add to the `ContractServiceErrorCode` union:
```ts
  // #3205: a line's siteId names a site owned by a different organization.
  | 'SITE_NOT_IN_ORG'
```

In `apps/api/src/services/quoteToContract.ts`, change `NewContractLineSpec`:
```ts
export interface NewContractLineSpec {
  lineType: 'flat' | 'per_device' | 'per_device_role' | 'per_seat' | 'manual';
  description: string;
  unitPrice: string;
  taxable: boolean;
  catalogItemId?: string | null;
  manualQuantity?: string | null;
  siteId?: string | null;
  /** #3205: required (non-empty) when lineType is per_device_role, otherwise absent. */
  deviceRoles?: DeviceRole[] | null;
  sortOrder?: number;
  /** In-memory Phase 4 → Phase 5 correlation only; never persisted. */
  sourceQuoteLineId?: string | null;
}
```
with `import type { DeviceRole } from '@breeze/shared';` at the top of that file.

- [ ] **Step 4: Typecheck and run the unit suite**

Run: `cd apps/api && npx tsc --noEmit && npx vitest run src/services/contractService.test.ts src/services/quoteToContract.test.ts`
Expected: clean typecheck (the `never` guard compiles because every enum member is handled); all tests PASS including the three new ones and the renamed MRR test.

- [ ] **Step 5: Write the failing real-DB writer/estimate tests**

Append to `apps/api/src/__tests__/integration/contractService.integration.test.ts` (inside the file, after the CRUD describe; it already imports `sites`, `devices`, `contractLines`, `addContractLineToContract`, `createContract`):

```ts
describe('per_device_role lines (#3205)', () => {
  async function seedSitesAndDevices(orgId: string) {
    const sfx = Math.random().toString(36).slice(2, 8);
    return withSystemDbAccessContext(async () => {
      const [sA] = await db.insert(sites).values({ orgId, name: `A-${sfx}` }).returning({ id: sites.id });
      const base = { orgId, osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', status: 'online' as const };
      await db.insert(devices).values([
        { ...base, siteId: sA!.id, agentId: `w-${sfx}`, hostname: 'w', deviceRole: 'workstation' },
        { ...base, siteId: sA!.id, agentId: `s-${sfx}`, hostname: 's', deviceRole: 'server' },
        { ...base, siteId: sA!.id, agentId: `u-${sfx}`, hostname: 'u' }, // unknown
      ]);
      return { siteAId: sA!.id };
    });
  }

  it('persists deviceRoles and a site-scoped role line', async () => {
    const { actor, orgId } = await seedOrg();
    const { siteAId } = await seedSitesAndDevices(orgId);
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Roles', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    const line = await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device_role', description: 'Servers at A', unitPrice: '40.00', taxable: false,
      deviceRoles: ['server', 'nas'], siteId: siteAId,
    }, actor));
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.id, line.id)));
    expect(row!.deviceRoles).toEqual(['server', 'nas']);
    expect(row!.siteId).toBe(siteAId);
  });

  it('rejects a site that belongs to another org with SITE_NOT_IN_ORG', async () => {
    const { actor, orgId } = await seedOrg();
    const other = await seedOrg();
    const { siteAId: foreignSite } = await seedSitesAndDevices(other.orgId);
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Foreign', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await expect(withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device', description: 'Devices', unitPrice: '10.00', taxable: false, siteId: foreignSite,
    }, actor))).rejects.toMatchObject({ code: 'SITE_NOT_IN_ORG', status: 400 });
  });

  it('estimate resolves the role quantity and reports uncovered devices', async () => {
    const { actor, orgId } = await seedOrg();
    await seedSitesAndDevices(orgId);
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Est', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device_role', description: 'Servers', unitPrice: '40.00', taxable: false, deviceRoles: ['server'],
    }, actor));
    const est = await withSystemDbAccessContext(() => computeContractEstimate(c.id, actor));
    expect(est.lines[0]).toMatchObject({ lineType: 'per_device_role', quantity: 1, value: '40.00', live: true });
    expect(est.uncoveredDevices).toEqual({ total: 2, byRole: { workstation: 1, unknown: 1 } });
  });

  it('estimate uncoveredDevices is null for a contract with only flat lines', async () => {
    const { actor, orgId } = await seedOrg();
    await seedSitesAndDevices(orgId);
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Flat', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Fee', unitPrice: '100.00', taxable: false,
    }, actor));
    const est = await withSystemDbAccessContext(() => computeContractEstimate(c.id, actor));
    expect(est.uncoveredDevices).toBeNull();
  });
});
```
Add `computeContractEstimate` to the existing import from `'../../services/contractService'` at the top of the file.

- [ ] **Step 6: Run the integration file**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractService.integration.test.ts`
Expected: the four new tests PASS along with the existing ones. Confirm the count of tests ran went up by four.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts apps/api/src/services/contractTypes.ts apps/api/src/services/quoteToContract.ts apps/api/src/__tests__/integration/contractService.integration.test.ts
git commit -m "feat(api): snapshot-based line quantities, estimate uncoveredDevices, role-line writers (#3205)"
```

---

### Task 5: Invoice generation — role lines, one snapshot, `uncoveredDevices` in the result

**Files:**
- Modify: `apps/api/src/services/contractService.ts` (`GenerateResult` at ~934-944; `generateDueInvoice` at ~983-1110)
- Modify: `apps/api/src/jobs/contractWorker.ts:75-84`
- Test: `apps/api/src/services/contractService.test.ts`, `apps/api/src/__tests__/integration/contractService.integration.test.ts`

**Interfaces:**
- Consumes: `snapshotContractDevices`, `quantityFor`, `uncoveredByRole`, `isDeviceLine`, `assertRoleLineHasRoles` (Task 4).
- Produces: `GenerateResult.uncoveredDevices: UncoveredDevices | null` on every return path. The generate route (`apps/api/src/routes/contracts/generate.ts`) returns `result` verbatim, so the API response carries it with no route change.

- [ ] **Step 1: Write the failing unit test**

Append to `describe('generateDueInvoice surfaces price-book gaps (#3775)')` in `apps/api/src/services/contractService.test.ts` (it already defines `contract`, `asOf`, `queueRun`):

```ts
  // #3205
  it('bills per_device_role from one org snapshot and returns uncoveredDevices', async () => {
    vi.mocked(createManualInvoice).mockResolvedValue({ id: 'inv1' } as never);
    vi.mocked(addContractLine).mockResolvedValue({ line: { id: 'il1' }, pricedFrom: 'contract_snapshot' } as never);
    vi.mocked(snapshotContractDevices).mockResolvedValue([
      { role: 'server', siteId: null, n: 2 },
      { role: 'workstation', siteId: null, n: 5 },
      { role: 'unknown', siteId: null, n: 1 },
    ]);
    queueRun([
      { id: 'cl-1', lineType: 'per_device_role', description: 'Servers', unitPrice: '40.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: ['server'] },
      { id: 'cl-2', lineType: 'per_device_role', description: 'Workstations', unitPrice: '10.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: ['workstation'] },
    ]);

    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res.generated).toBe(true);
    expect(vi.mocked(snapshotContractDevices)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(countContractDevices)).not.toHaveBeenCalled();
    expect(vi.mocked(addContractLine).mock.calls[0]![1]).toMatchObject({ description: 'Servers', quantity: '2' });
    expect(vi.mocked(addContractLine).mock.calls[1]![1]).toMatchObject({ description: 'Workstations', quantity: '5' });
    expect(res.uncoveredDevices).toEqual({ total: 1, byRole: { unknown: 1 } });
  });

  it('returns uncoveredDevices: null when no device-counted line exists', async () => {
    vi.mocked(createManualInvoice).mockResolvedValue({ id: 'inv1' } as never);
    vi.mocked(addContractLine).mockResolvedValue({ line: { id: 'il1' }, pricedFrom: 'contract_snapshot' } as never);
    queueRun([{ id: 'cl-1', lineType: 'flat', description: 'Fee', unitPrice: '80.00', taxable: true, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null }]);
    const res = await svc.generateDueInvoice('c1', asOf);
    expect(res.uncoveredDevices).toBeNull();
    expect(vi.mocked(snapshotContractDevices)).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts -t "per_device_role from one org snapshot"`
Expected: FAIL (`uncoveredDevices` undefined; the switch still calls `countContractDevices`, which the mock resolves to `undefined` → quantity `'undefined'`).

- [ ] **Step 3: Implement**

In `apps/api/src/services/contractService.ts`:

`GenerateResult` gains a field:
```ts
  /** Devices no device-counted line billed on this run (#3205). null when the
   *  contract has no per_device / per_device_role line or nothing generated.
   *  Rides beside priceBookGaps: the worker logs it, the generate route returns it. */
  uncoveredDevices: UncoveredDevices | null;
```
Add `uncoveredDevices: null` to each of the four early returns (`not_due` ×2, `expired`, the zero-line guard, and `already_billed`).

In the line loop, take the snapshot once before the loop and replace the `per_device` case:

```ts
  // #3205: one snapshot per run. Every device-counted line and the coverage
  // figure below derive from it — never a per-line COUNT.
  const snapshot = lines.some(isDeviceLine) ? await snapshotContractDevices(c.orgId) : [];
  const priceBookGaps: PriceBookGap[] = [];
  for (const l of lines) {
    let quantity: string;
    switch (l.lineType) {
      case 'flat':
        quantity = '1';
        break;
      case 'manual':
        quantity = l.manualQuantity ?? '0';
        break;
      case 'per_device':
      case 'per_device_role':
        assertRoleLineHasRoles(l);
        quantity = String(quantityFor(snapshot, l));
        break;
      case 'per_seat':
        quantity = String(await countContractSeats(c.orgId));
        break;
      default: {
        // Exhaustiveness: adding a line type becomes a compile error here
        // (instead of silently billing qty 1).
        const _exhaustive: never = l.lineType;
        throw new ContractServiceError(`Unknown contract line type: ${String(l.lineType)}`, 500, 'INVALID_STATE');
      }
    }
```
and the final return becomes:
```ts
  const uncoveredDevices = lines.some(isDeviceLine) ? uncoveredByRole(snapshot, lines) : null;
  return { generated: true, invoiceId: inv.id, autoIssue: c.autoIssue, actor, priceBookGaps, uncoveredDevices };
```

In `apps/api/src/jobs/contractWorker.ts`, after the `for (const gap of res.priceBookGaps)` loop:

```ts
      // #3205: a role-billed contract with devices no line covers (unclassified
      // 'unknown' devices, or roles with no line) still bills — but never silently.
      if (res.uncoveredDevices && res.uncoveredDevices.total > 0) {
        console.warn(
          '[contract-billing] uncovered devices: contract %s has %d billable device(s) no line bills — %s',
          row.id, res.uncoveredDevices.total, JSON.stringify(res.uncoveredDevices.byRole)
        );
      }
```

- [ ] **Step 4: Typecheck and run the unit suite**

Run: `cd apps/api && npx tsc --noEmit && npx vitest run src/services/contractService.test.ts src/jobs/contractWorker.test.ts src/routes/contracts`
Expected: PASS. (`contractWorker.test.ts` exists alongside the worker; if it constructs `GenerateResult` fixtures, add `uncoveredDevices: null` to them.)

- [ ] **Step 5: Write the failing real-DB generation test**

Append inside `describe('per_device_role lines (#3205)')` in `contractService.integration.test.ts` (reuse `seedSitesAndDevices`; the file already imports `activateContract`, `generateDueInvoice`, `invoiceLines`, and `seedOrgWithUser` exists inside the generation describe — copy that helper into this describe or hoist it to file scope):

```ts
  it('generateDueInvoice bills the role quantity and returns uncoveredDevices', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    await seedSitesAndDevices(orgId);
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'RoleGen', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device_role', description: 'Servers', unitPrice: '40.00', taxable: false, deviceRoles: ['server'],
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T08:00:00Z')));

    const res = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T08:00:00Z')));
    expect(res.generated).toBe(true);
    expect(res.uncoveredDevices).toEqual({ total: 2, byRole: { workstation: 1, unknown: 1 } });
    const rows = await withSystemDbAccessContext(() =>
      db.select({ quantity: invoiceLines.quantity, description: invoiceLines.description })
        .from(invoiceLines).where(eq(invoiceLines.invoiceId, res.invoiceId!)));
    expect(rows).toEqual([{ quantity: '1.00', description: 'Servers' }]);
  });
```
If `invoiceLines.quantity` is stored with a different scale, match whatever the existing `per_device` generation test in this file asserts.

- [ ] **Step 6: Run it**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractService.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts apps/api/src/jobs/contractWorker.ts apps/api/src/__tests__/integration/contractService.integration.test.ts
git commit -m "feat(api): generateDueInvoice bills per_device_role from one snapshot, reports uncoveredDevices (#3205)"
```

---

### Task 6: Database invariants and export round-trip

**Files:**
- Create: `apps/api/src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` (`seedTwoOrgs` and the manifest assertions ~line 150)

**Interfaces:**
- Consumes: Migration B (Task 2).

- [ ] **Step 1: Write the constraint truth-table test**

Create `apps/api/src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts`:

```ts
/**
 * #3205 — contract_lines_device_roles_chk and contract_lines_site_org_fk,
 * exercised with raw SQL as breeze_app so the DATABASE (not Zod) is what
 * rejects each malformed row. Codes: 23514 check_violation, 23503 foreign_key_violation.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, contracts } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `KP ${sfx}`, slug: `kp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'KA', slug: `ka-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'KB', slug: `kb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `A-${sfx}` }).returning({ id: sites.id });
    const [siteB] = await db.insert(sites).values({ orgId: oB!.id, name: `B-${sfx}` }).returning({ id: sites.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: 'K', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgA: oA!.id, siteA: siteA!.id, siteB: siteB!.id, contractId: c!.id };
  });
}

function insertLine(f: { orgA: string; contractId: string }, lineType: string, rolesSql: ReturnType<typeof sql>, siteId: string | null = null) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_roles, site_id)
    VALUES (${f.contractId}::uuid, ${f.orgA}::uuid, ${lineType}::contract_line_type, 'k', 1.00, false, ${rolesSql}, ${siteId}::uuid)
  `));
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('contract_lines device-role invariants (real DB) #3205', () => {
  runDb('accepts a valid role set on per_device_role and NULL on other types', async () => {
    const f = await seed();
    await expect(insertLine(f, 'per_device_role', sql`ARRAY['server','nas']::text[]`)).resolves.toBeDefined();
    await expect(insertLine(f, 'flat', sql`NULL`)).resolves.toBeDefined();
  });

  runDb.each([
    ['NULL roles on a role line', 'per_device_role', sql`NULL`],
    ['empty array on a role line', 'per_device_role', sql`ARRAY[]::text[]`],
    ['a NULL element', 'per_device_role', sql`ARRAY['server', NULL]::text[]`],
    ["'unknown'", 'per_device_role', sql`ARRAY['unknown']::text[]`],
    ['an unrecognised role', 'per_device_role', sql`ARRAY['mainframe']::text[]`],
    ['a 2-D array', 'per_device_role', sql`ARRAY[['server']]::text[]`],
    ['an empty array on a flat line', 'flat', sql`ARRAY[]::text[]`],
    ['roles on a per_device line', 'per_device', sql`ARRAY['server']::text[]`],
  ])('rejects %s with 23514', async (_name, lineType, rolesSql) => {
    const f = await seed();
    await expect(insertLine(f, lineType, rolesSql)).rejects.toMatchObject({ code: '23514' });
  });

  runDb('rejects a site owned by another org with 23503 (composite FK)', async () => {
    const f = await seed();
    await expect(insertLine(f, 'per_device', sql`NULL`, f.siteB)).rejects.toMatchObject({ code: '23503', constraint_name: 'contract_lines_site_org_fk' });
    await expect(insertLine(f, 'per_device', sql`NULL`, f.siteA)).resolves.toBeDefined();
  });

  runDb('deleting a site nulls only site_id on its lines (org_id survives)', async () => {
    const f = await seed();
    await insertLine(f, 'per_device_role', sql`ARRAY['server']::text[]`, f.siteA);
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM sites WHERE id = ${f.siteA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT site_id, org_id FROM contract_lines WHERE contract_id = ${f.contractId}::uuid`));
    expect((rows as unknown as Array<{ site_id: string | null; org_id: string }>)[0]).toEqual({ site_id: null, org_id: f.orgA });
  });
});
```
If the postgres.js error exposes the constraint under `constraint` rather than `constraint_name`, match on whichever `pamDeviceMoveGuard.integration.test.ts` uses (it asserts `{ code: '23514', constraint: '...' }`) and adjust the 23503 assertion to `{ code: '23503', constraint: 'contract_lines_site_org_fk' }`. If deleting a site is blocked by some other FK in the fixture (devices etc. are not seeded here, so it should not be), note it rather than weakening the test.

- [ ] **Step 2: Run it**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts`
Expected: all cases PASS (confirm the count: 1 + 8 + 1 + 1 = 11).

- [ ] **Step 3: Seed a role line into the export round-trip**

In `tenantExportErasureRoundtrip.integration.test.ts`, inside `seedTwoOrgs()` before `return { partnerId, orgA, orgB, prohibitedSentinels };`, add:

```ts
  // #3205: a per_device_role line, so the archive's contract_lines.json is
  // exercised with the text[] column populated.
  const contractId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO contracts (id, partner_id, org_id, name, interval_months, start_date, currency_code)
    VALUES (${contractId}, ${partnerId}, ${orgA}, ${'Roundtrip contract ' + suffix}, 1, '2026-07-01', 'USD')
  `);
  await db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_roles)
    VALUES (${contractId}, ${orgA}, 'per_device_role', 'Network gear', 25.00, false, ARRAY['switch','router','firewall']::text[])
  `);
```
and next to the `sites.json` assertion (~line 154):
```ts
    expect(byName.get('contracts.json')?.rowCount).toBe(1);
    expect(byName.get('contract_lines.json')?.rowCount).toBe(1);
```
If the erasure half of the suite counts remaining rows per table, `contracts`/`contract_lines` are already in `CORE_ORG_CASCADE_DELETE_ORDER` and will be erased with the org; no list change is needed.

- [ ] **Step 4: Run both export suites**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "test(api): contract_lines device_roles CHECK + site-org FK truth table; export roundtrip seeds a role line (#3205)"
```

---

### Task 7: AI `manage_contracts` tool — make the new line shape discoverable

**Files:**
- Modify: `apps/api/src/services/aiToolsContracts.ts:185-192` (the `line` parameter description)
- Test: `apps/api/src/services/aiToolsContracts.manageContracts.test.ts`

**Interfaces:**
- Consumes: `contractLineInputSchema` (Task 1) through the existing `linePayload` wrapper; no handler change.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('manage_contracts')` in `aiToolsContracts.manageContracts.test.ts`:

```ts
  // #3205
  it('add_line accepts a per_device_role line with deviceRoles and forwards it verbatim', async () => {
    const line = {
      lineType: 'per_device_role', description: 'Network gear', unitPrice: '25.00', taxable: true,
      deviceRoles: ['switch', 'router', 'firewall'],
    };
    const out = await getTool().handler({ action: 'add_line', contractId: 'contract-1', line }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith('contract-1', line, actor);
    expect(JSON.parse(out)).toEqual({ id: 'line-1', contractId: 'contract-1' });
  });

  it('add_line with per_device_role but no deviceRoles returns VALIDATION_ERROR naming the field', async () => {
    const out = await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line: { lineType: 'per_device_role', description: 'x', unitPrice: '1.00', taxable: false } },
      auth,
    );
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('deviceRoles');
    expect(contractService.addContractLineToContract).not.toHaveBeenCalled();
  });

  it('documents per_device_role and deviceRoles in the tool schema so the model can discover them', () => {
    const desc = JSON.stringify(getTool().definition.input_schema);
    expect(desc).toContain('per_device_role');
    expect(desc).toContain('deviceRoles');
    expect(desc).toContain('unknown');
  });
```

- [ ] **Step 2: Run to verify the schema test fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsContracts.manageContracts.test.ts`
Expected: the first two PASS already (validation is shared), the third FAILS (description lacks the strings).

- [ ] **Step 3: Update the description**

Replace the `line` property description in `aiToolsContracts.ts` with:

```ts
          line: {
            type: 'object',
            description:
              'Contract line input. lineType is one of flat | per_device | per_device_role | per_seat | manual. ' +
              'per_device counts the org\'s billable devices (optionally one site via siteId). ' +
              'per_device_role counts only devices whose role is in deviceRoles — a non-empty array of ' +
              'workstation, server, printer, router, switch, firewall, access_point, phone, iot, camera, nas ' +
              '(never "unknown": unclassified devices are reported as uncovered, not billed); siteId is optional there too. ' +
              'manual requires manualQuantity. ' +
              'With catalogItemId set, unitPrice/taxable are resolved from the catalog ' +
              'price book in the CONTRACT\'s currency (any supplied values are ignored) and add_line fails with ' +
              'NO_PRICE_FOR_CURRENCY (409) when the item has no price in that currency — never converted; add a ' +
              'non-catalog line with an explicit unitPrice instead. Without catalogItemId, unitPrice is required.',
          },
```

- [ ] **Step 4: Run the tool suites**

Run: `cd apps/api && npx vitest run src/services/aiToolsContracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiToolsContracts.manageContracts.test.ts
git commit -m "feat(ai): manage_contracts documents per_device_role + deviceRoles (#3205)"
```

---

### Task 8: Web — types, shared line-type module, editor role picker, coverage notice, i18n

**Files:**
- Modify: `apps/web/src/lib/api/contracts.ts:19, 47-60, 62-74, 236-244`
- Modify: `apps/web/src/lib/deviceRoles.ts` (add `BILLABLE_DEVICE_ROLES`)
- Create: `apps/web/src/components/contracts/lineTypes.ts`
- Create: `apps/web/src/components/contracts/DeviceCoverageNotice.tsx`
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx` (label maps 42-50; state ~145-150; `addLine` ~575-600; row 915-932; type select ~995; site picker 1067-1079; add button 1124; estimate panel 1139-1165)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`
- Test: `apps/web/src/components/contracts/ContractEditor.roles.test.tsx` (new), `apps/web/src/components/contracts/DeviceCoverageNotice.test.tsx` (new), `apps/web/src/lib/i18n/localeParity.test.ts` (existing)

**Interfaces:**
- Produces:
  ```ts
  // lib/api/contracts.ts
  export type ContractLineType = 'flat' | 'per_device' | 'per_device_role' | 'per_seat' | 'manual';
  export interface UncoveredDevices { total: number; byRole: Record<string, number> }
  // ContractEstimate gains uncoveredDevices: UncoveredDevices | null; ContractLine gains deviceRoles: string[] | null
  // lib/deviceRoles.ts
  export const BILLABLE_DEVICE_ROLES: readonly Exclude<DeviceRole, 'unknown'>[]
  // components/contracts/lineTypes.ts
  export const LINE_TYPE_LABELS: Record<ContractLineType, string>; export const AUTO_QTY_TYPES: Set<ContractLineType>; export const SITE_SCOPED_TYPES: Set<ContractLineType>;
  // components/contracts/DeviceCoverageNotice.tsx
  export function formatUncoveredBreakdown(byRole: Record<string, number>): string
  export default function DeviceCoverageNotice(props: { uncovered: UncoveredDevices | null | undefined }): JSX.Element | null
  ```

- [ ] **Step 1: Types and constants**

`apps/web/src/lib/api/contracts.ts`:
```ts
export type ContractLineType = 'flat' | 'per_device' | 'per_device_role' | 'per_seat' | 'manual';

/** Devices no device-counted line on the contract bills (#3205). null = not applicable. */
export interface UncoveredDevices {
  total: number;
  byRole: Record<string, number>;
}
```
Add `uncoveredDevices: UncoveredDevices | null;` to `ContractEstimate`, and `deviceRoles: string[] | null;` to `ContractLine` after `siteId`.

`apps/web/src/lib/deviceRoles.ts`, after `DeviceRole`:
```ts
/** Roles a contract line may bill (#3205). `unknown` is a classification gap, not a rate. */
export const BILLABLE_DEVICE_ROLES = DEVICE_ROLES.filter(
  (r): r is Exclude<DeviceRole, 'unknown'> => r !== 'unknown',
);
```

Create `apps/web/src/components/contracts/lineTypes.ts`:
```ts
import type { ContractLineType } from '../../lib/api/contracts';

// One copy (#3205): ContractEditor and ContractDetail each carried their own
// label map, which is how a new type gets added to one and missed in the other.
export const LINE_TYPE_LABELS: Record<ContractLineType, string> = {
  flat: 'contracts.shared.lineType.flat',
  per_device: 'contracts.shared.lineType.perDevice',
  per_device_role: 'contracts.shared.lineType.perDeviceRole',
  per_seat: 'contracts.shared.lineType.perSeat',
  manual: 'contracts.shared.lineType.manual',
};

/** Quantity resolved by the generator from live counts; the editor shows "auto". */
export const AUTO_QTY_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role', 'per_seat']);

/** Types that accept an optional siteId narrowing the device count. */
export const SITE_SCOPED_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role']);
```

- [ ] **Step 2: Write the failing coverage-notice test**

Create `apps/web/src/components/contracts/DeviceCoverageNotice.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DeviceCoverageNotice, { formatUncoveredBreakdown } from './DeviceCoverageNotice';

describe('DeviceCoverageNotice (#3205)', () => {
  it('renders nothing when not applicable', () => {
    const { container } = render(<DeviceCoverageNotice uncovered={null} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('confirms full coverage at zero', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 0, byRole: {} }} />);
    expect(screen.getByTestId('contract-coverage-ok')).toBeInTheDocument();
  });
  it('warns with the count and a per-role breakdown, largest first, using role labels', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 5, byRole: { printer: 2, unknown: 3 } }} />);
    const el = screen.getByTestId('contract-coverage-warning');
    expect(el.textContent).toContain('5');
    expect(el.textContent).toContain('3 Unknown, 2 Printer');
  });
  it('formatUncoveredBreakdown sorts descending and labels roles', () => {
    expect(formatUncoveredBreakdown({ access_point: 1, server: 4 })).toBe('4 Server, 1 Access Point');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/contracts/DeviceCoverageNotice.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the notice**

Create `apps/web/src/components/contracts/DeviceCoverageNotice.tsx` (match the `useTranslation(...)` namespace call used at the top of `ContractEditor.tsx`; it resolves `contracts.*` keys from `billing.json`):

```tsx
import { useTranslation } from 'react-i18next';
import { getDeviceRoleLabel } from '@/lib/deviceRoles';
import type { UncoveredDevices } from '../../lib/api/contracts';

/** "3 Unknown, 2 Printer" — largest bucket first. */
export function formatUncoveredBreakdown(byRole: Record<string, number>): string {
  return Object.entries(byRole)
    .sort(([, a], [, b]) => b - a)
    .map(([role, n]) => `${n} ${getDeviceRoleLabel(role)}`)
    .join(', ');
}

/**
 * #3205: devices on the org that no device-counted line on the contract bills.
 * null/undefined = not applicable (no per_device / per_device_role line) →
 * render nothing; 0 = every device is covered; >0 = warn with the breakdown.
 */
export default function DeviceCoverageNotice({ uncovered }: { uncovered: UncoveredDevices | null | undefined }) {
  const { t } = useTranslation('billing');
  if (!uncovered) return null;
  if (uncovered.total === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="contract-coverage-ok">
        {t('contracts.shared.coverage.allCovered')}
      </p>
    );
  }
  return (
    <p
      className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      data-testid="contract-coverage-warning"
    >
      {t('contracts.shared.coverage.uncovered', { count: uncovered.total, breakdown: formatUncoveredBreakdown(uncovered.byRole) })}
    </p>
  );
}
```

- [ ] **Step 5: Add the i18n keys to all eight locales**

In each `apps/web/src/locales/<locale>/billing.json`, add under `contracts.shared.lineType` the key `perDeviceRole`, add a new `contracts.shared.coverage` object with `uncovered` and `allCovered`, add `contracts.contractEditor.addLine.deviceRoles` and `deviceRolesRequired`, and `contracts.contractDetail.toast.uncoveredDevices`. Values:

| locale | perDeviceRole | coverage.uncovered | coverage.allCovered | addLine.deviceRoles | addLine.deviceRolesRequired | contractDetail.toast.uncoveredDevices |
|---|---|---|---|---|---|---|
| en | Per device role | {{count}} devices on this organization are not billed by any line: {{breakdown}} | Every device on this organization is billed by a line on this contract. | Device roles (a device is billed when its role is one of these) | Pick at least one role. | Invoice generated, but {{count}} devices are not billed by any line on this contract: {{breakdown}} |
| de-DE | Pro Geräterolle | {{count}} Geräte dieser Organisation werden von keiner Position abgerechnet: {{breakdown}} | Jedes Gerät dieser Organisation wird von einer Position dieses Vertrags abgerechnet. | Geräterollen (ein Gerät wird abgerechnet, wenn seine Rolle eine davon ist) | Mindestens eine Rolle auswählen. | Rechnung erstellt, aber {{count}} Geräte werden von keiner Position dieses Vertrags abgerechnet: {{breakdown}} |
| es-419 | Por rol de dispositivo | {{count}} dispositivos de esta organización no se facturan en ninguna línea: {{breakdown}} | Todos los dispositivos de esta organización se facturan en una línea de este contrato. | Roles de dispositivo (se factura un dispositivo cuando su rol es uno de estos) | Elige al menos un rol. | Factura generada, pero {{count}} dispositivos no se facturan en ninguna línea de este contrato: {{breakdown}} |
| fr-CA | Par rôle d'appareil | {{count}} appareils de cette organisation ne sont facturés par aucune ligne : {{breakdown}} | Chaque appareil de cette organisation est facturé par une ligne de ce contrat. | Rôles d'appareil (un appareil est facturé lorsque son rôle est l'un de ceux-ci) | Choisissez au moins un rôle. | Facture générée, mais {{count}} appareils ne sont facturés par aucune ligne de ce contrat : {{breakdown}} |
| fr-FR | Par rôle d'appareil | {{count}} appareils de cette organisation ne sont facturés par aucune ligne : {{breakdown}} | Chaque appareil de cette organisation est facturé par une ligne de ce contrat. | Rôles d'appareil (un appareil est facturé lorsque son rôle est l'un de ceux-ci) | Sélectionnez au moins un rôle. | Facture générée, mais {{count}} appareils ne sont facturés par aucune ligne de ce contrat : {{breakdown}} |
| it-IT | Per ruolo dispositivo | {{count}} dispositivi di questa organizzazione non sono fatturati da alcuna riga: {{breakdown}} | Ogni dispositivo di questa organizzazione è fatturato da una riga di questo contratto. | Ruoli dispositivo (un dispositivo viene fatturato quando il suo ruolo è uno di questi) | Seleziona almeno un ruolo. | Fattura generata, ma {{count}} dispositivi non sono fatturati da alcuna riga di questo contratto: {{breakdown}} |
| pt-BR | Por função do dispositivo | {{count}} dispositivos desta organização não são cobrados por nenhuma linha: {{breakdown}} | Todos os dispositivos desta organização são cobrados por uma linha deste contrato. | Funções do dispositivo (um dispositivo é cobrado quando sua função é uma destas) | Escolha pelo menos uma função. | Fatura gerada, mas {{count}} dispositivos não são cobrados por nenhuma linha deste contrato: {{breakdown}} |
| tr-TR | Cihaz rolüne göre | Bu kuruluştaki {{count}} cihaz hiçbir satırda faturalandırılmıyor: {{breakdown}} | Bu kuruluştaki her cihaz bu sözleşmedeki bir satırda faturalandırılıyor. | Cihaz rolleri (rolü bunlardan biri olan cihazlar faturalandırılır) | En az bir rol seçin. | Fatura oluşturuldu, ancak bu sözleşmedeki {{count}} cihaz hiçbir satırda faturalandırılmıyor: {{breakdown}} |

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/components/contracts/DeviceCoverageNotice.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing editor tests**

Create `apps/web/src/components/contracts/ContractEditor.roles.test.tsx`. Copy the mock block (lines 1-40) from `ContractEditor.test.tsx` verbatim, then:

```tsx
const contract = {
  id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft', billingTiming: 'advance',
  intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: null, autoIssue: false, autoRenew: false,
  renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

describe('ContractEditor — per_device_role (#3205)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: { total: 2, byRole: { unknown: 2 } } },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
  });

  // Edit mode = a `detail` prop ({ contract, lines, periods }), exactly as
  // ContractEditor.autosave.test.tsx renders it.
  function renderEdit(lines: unknown[] = []) {
    return render(<ContractEditor detail={{ contract: contract as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);
  }

  it('shows the role picker only for per_device_role and clears it when the type changes', async () => {
    renderEdit();
    expect(screen.queryByTestId('contract-line-roles')).toBeNull();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_role' } });
    expect(await screen.findByTestId('contract-line-roles')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-line-role-unknown')).toBeNull();
    fireEvent.click(screen.getByTestId('contract-line-role-switch'));
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'flat' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_role' } });
    expect((screen.getByTestId('contract-line-role-switch') as HTMLInputElement).checked).toBe(false);
  });

  it('disables Add until a role is picked, then sends deviceRoles and siteId', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_role' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Network gear' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('contract-line-role-switch'));
    fireEvent.click(screen.getByTestId('contract-line-role-router'));
    const site = await screen.findByTestId('contract-line-site');
    await within(site).findByRole('option', { name: 'HQ' });
    fireEvent.change(site, { target: { value: 'site-1' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({
      lineType: 'per_device_role', deviceRoles: ['switch', 'router'], siteId: 'site-1',
    });
  });

  it('lists the roles under a role line and shows the coverage warning from the estimate', async () => {
    renderEdit([{
      id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_role', description: 'Network gear',
      catalogItemId: null, unitPrice: '25.00', manualQuantity: null, siteId: null, deviceRoles: ['switch', 'router'],
      taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }]);
    expect((await screen.findByTestId('line-roles-0')).textContent).toBe('Switch, Router');
    expect((await screen.findByTestId('contract-coverage-warning')).textContent).toContain('2 Unknown');
  });
});
```
`contract-line-desc`, `contract-line-type`, `contract-line-site`, and `add-line-btn` are the existing test ids in `ContractEditor.tsx`; `contract-line-roles`, `contract-line-role-<role>`, and `line-roles-<idx>` are added in Step 8.

- [ ] **Step 7: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor.roles.test.tsx`
Expected: FAIL (no `contract-line-roles`, no `line-roles-0`, no coverage warning).

- [ ] **Step 8: Implement the editor changes**

In `apps/web/src/components/contracts/ContractEditor.tsx`:

1. Delete the local `LINE_TYPE_LABELS` and `AUTO_QTY_TYPES` (lines 42-50) and import instead:
   ```ts
   import { LINE_TYPE_LABELS, AUTO_QTY_TYPES, SITE_SCOPED_TYPES } from './lineTypes';
   import DeviceCoverageNotice from './DeviceCoverageNotice';
   import { BILLABLE_DEVICE_ROLES, getDeviceRoleIcon, getDeviceRoleLabel, type DeviceRole } from '@/lib/deviceRoles';
   ```
2. State, beside `lineSiteId` (line ~150):
   ```ts
   const [lineRoles, setLineRoles] = useState<Exclude<DeviceRole, 'unknown'>[]>([]);
   ```
3. Line-type `<select>` `onChange` (line ~995): `onChange={(e) => { setLineType(e.target.value as ContractLineType); setLineSiteId(''); setLineRoles([]); }}`.
4. `addLine` payload (line ~583-590): change `siteId:` to `siteId: SITE_SCOPED_TYPES.has(lineType) && lineSiteId ? lineSiteId : undefined,` and add `deviceRoles: lineType === 'per_device_role' ? lineRoles : undefined,`. In the success branch after `setLineQty('1');` add `setLineRoles([]);`. At the top guard add `|| (lineType === 'per_device_role' && lineRoles.length === 0)` to the early `return`.
5. Add button (line 1124): `disabled={busy || !lineDesc.trim() || catalogPriceUnresolved || (lineType === 'per_device_role' && lineRoles.length === 0)}`.
6. Site picker condition (line 1067): `{SITE_SCOPED_TYPES.has(lineType) && (` … unchanged body.
7. Role picker, immediately before the site picker block:
   ```tsx
   {lineType === 'per_device_role' && (
     <fieldset className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2" data-testid="contract-line-roles">
       <legend className="mb-1">{t('contracts.contractEditor.addLine.deviceRoles')}</legend>
       <div className="flex flex-wrap gap-2">
         {BILLABLE_DEVICE_ROLES.map((role) => {
           const Icon = getDeviceRoleIcon(role);
           const checked = lineRoles.includes(role);
           return (
             <label
               key={role}
               className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm ${checked ? 'border-primary bg-primary/10 text-foreground' : 'bg-background text-muted-foreground hover:text-foreground'}`}
             >
               <input
                 type="checkbox" className="sr-only" checked={checked}
                 onChange={() => setLineRoles((prev) => (checked ? prev.filter((r) => r !== role) : [...prev, role]))}
                 data-testid={`contract-line-role-${role}`}
               />
               <Icon className="h-3.5 w-3.5" />
               {getDeviceRoleLabel(role)}
             </label>
           );
         })}
       </div>
       {lineRoles.length === 0 && (
         <span className="text-amber-600 dark:text-amber-500">{t('contracts.contractEditor.addLine.deviceRolesRequired')}</span>
       )}
     </fieldset>
   )}
   ```
8. Line row (lines 917-921): replace the site sub-label with
   ```tsx
   {SITE_SCOPED_TYPES.has(l.lineType) && l.siteId
     ? <span className="block text-xs text-muted-foreground">{siteName(l.siteId)}</span>
     : null}
   {l.lineType === 'per_device_role' && l.deviceRoles
     ? <span className="block text-xs text-muted-foreground" data-testid={`line-roles-${idx}`}>{l.deviceRoles.map(getDeviceRoleLabel).join(', ')}</span>
     : null}
   ```
9. Estimate panel: after the `includesLiveCounts` paragraph (line ~1157) add `<DeviceCoverageNotice uncovered={liveEstimate?.uncoveredDevices} />`.

- [ ] **Step 9: Run the editor suites and typecheck**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor && npx tsc --noEmit`
Expected: PASS (new and existing editor tests), clean typecheck.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/api/contracts.ts apps/web/src/lib/deviceRoles.ts apps/web/src/components/contracts/lineTypes.ts apps/web/src/components/contracts/DeviceCoverageNotice.tsx apps/web/src/components/contracts/DeviceCoverageNotice.test.tsx apps/web/src/components/contracts/ContractEditor.tsx apps/web/src/components/contracts/ContractEditor.roles.test.tsx apps/web/src/locales
git commit -m "feat(web): per_device_role line editor with role picker + device coverage notice (#3205)"
```

---

### Task 9: Web — contract detail page and generate toast

**Files:**
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (label map 35-39; generate handler 149-172; estimate stat 305-308; line rows 339-351)
- Test: `apps/web/src/components/contracts/ContractDetail.roles.test.tsx` (new)

**Interfaces:**
- Consumes: `LINE_TYPE_LABELS`, `AUTO_QTY_TYPES` (Task 8), `DeviceCoverageNotice`, `formatUncoveredBreakdown`, `UncoveredDevices`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/contracts/ContractDetail.roles.test.tsx`. Copy the mock block and `detail` fixture from `ContractDetail.generate.test.tsx` (lines 1-58), then:

```tsx
const roleLine = {
  id: 'cl-2', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_role' as const, description: 'Network gear',
  catalogItemId: null, unitPrice: '25.00', manualQuantity: null, siteId: null, deviceRoles: ['switch', 'firewall'],
  taxable: false, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
};

describe('ContractDetail — per_device_role (#3205)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
  });

  it('renders the role list under the line and "auto" as its quantity', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [], uncoveredDevices: null } }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);
    const row = await screen.findByTestId('contract-detail-line-cl-2');
    expect(row.textContent).toContain('Switch, Firewall');
    expect(row.textContent).toContain('auto');
  });

  it('shows the coverage warning from the estimate', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [], uncoveredDevices: { total: 3, byRole: { printer: 1, unknown: 2 } } },
    }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('contract-coverage-warning')).textContent).toContain('2 Unknown, 1 Printer');
  });

  it('generate now warns when the API reports uncovered devices', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [], uncoveredDevices: null } }));
    vi.mocked(contractsApi.generateContractInvoice).mockResolvedValue(resp({
      data: { generated: true, invoiceId: 'inv-9', autoIssue: false, priceBookGaps: [], uncoveredDevices: { total: 2, byRole: { unknown: 2 } } },
    }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('generate-now-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    const warn = showToast.mock.calls.find((c) => (c[0] as { type: string }).type === 'warning')![0] as { message: string };
    expect(warn.message).toContain('2 Unknown');
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-9'));
  });
});
```
`generate-now-btn` is the existing id of the Generate button in `ContractDetail.tsx`; `contract-detail-line-<id>` is the existing row id.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractDetail.roles.test.tsx`
Expected: FAIL on all three.

- [ ] **Step 3: Implement**

In `apps/web/src/components/contracts/ContractDetail.tsx`:
1. Delete the local `LINE_TYPE_LABELS` (lines 35-39); import `{ LINE_TYPE_LABELS, AUTO_QTY_TYPES }` from `'./lineTypes'`, `DeviceCoverageNotice, { formatUncoveredBreakdown }` from `'./DeviceCoverageNotice'`, `getDeviceRoleLabel` from `'@/lib/deviceRoles'`, and add `UncoveredDevices` to the type import from `'../../lib/api/contracts'`.
2. Line row (lines 341-347):
   ```tsx
   <td className="px-3 py-2">
     {t(/* i18n-dynamic */ LINE_TYPE_LABELS[l.lineType])}
     {l.lineType === 'per_device_role' && l.deviceRoles
       ? <span className="block text-xs text-muted-foreground">{l.deviceRoles.map(getDeviceRoleLabel).join(', ')}</span>
       : null}
   </td>
   ...
   <td className="px-3 py-2 text-right">
     {AUTO_QTY_TYPES.has(l.lineType)
       ? <span className="text-muted-foreground">{t('contracts.shared.values.auto')}</span>
       : (l.lineType === 'manual' ? (l.manualQuantity ?? '0') : '1')}
   </td>
   ```
3. Estimate stat (line 306-308): after the `<dd>` value, inside the same `<dd>`, add `<DeviceCoverageNotice uncovered={estimate?.uncoveredDevices} />`.
4. Generate handler: widen the `runAction` generic to `{ data?: { invoiceId?: string; priceBookGaps?: PriceBookGap[]; uncoveredDevices?: UncoveredDevices | null } }` and, after the `priceBookGaps` toast block, add:
   ```ts
   // #3205: a role-billed contract with devices no line covers still billed —
   // say so, with the breakdown, before navigating to the invoice.
   const uncovered = result?.data?.uncoveredDevices;
   if (uncovered && uncovered.total > 0) {
     showToast({
       type: 'warning',
       message: t('contracts.contractDetail.toast.uncoveredDevices', {
         count: uncovered.total, breakdown: formatUncoveredBreakdown(uncovered.byRole),
       }),
     });
   }
   ```

- [ ] **Step 4: Run the detail suites and typecheck**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractDetail && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractDetail.roles.test.tsx
git commit -m "feat(web): contract detail shows role lines, coverage notice, uncovered-devices toast on generate (#3205)"
```

---

### Task 10: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx:37-44`

- [ ] **Step 1: Update the Contract Lines table and note**

Replace the table and the paragraph under it with:

```md
| Line type | How quantity is determined |
|-----------|----------------------------|
| Flat | A fixed amount each period, regardless of count |
| Per device | Counts the customer's devices at billing time × unit price |
| Per device role | Counts the customer's devices whose role is in the line's set (for example switch + router + firewall, or workstation + server) at billing time × unit price |
| Per seat | Counts the customer's seats/users at billing time × unit price |
| Manual | A fixed quantity you set × unit price |

Per-device, per-device-role and per-seat lines can be scoped to a specific **site** so you bill only the devices or seats at that location. A line can link to a [catalog item](/features/product-catalog/), which prefills its description and price.

Device roles come from the agent's classification (or a manual override on the device). A device whose role is still **Unknown** is never billed by a per-device-role line. The contract's estimate and each generated invoice report how many devices on the organization are not billed by any line, broken down by role, so you can classify them or add a line before the next period.
```

- [ ] **Step 2: Build the docs site**

Run: `cd apps/docs && pnpm build 2>&1 | tail -5`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/features/contracts.mdx
git commit -m "docs: per-device-role contract lines and the device coverage warning (#3205)"
```

---

### Task 11: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Merge main and rebuild**

```bash
git fetch origin main && git merge origin/main
pnpm install --frozen-lockfile
```
Resolve conflicts if any (migration name ceiling may have moved: re-run the Task 2 Step 1 check and rename both migrations if needed; the files are unmerged so renaming is allowed).

- [ ] **Step 2: Typecheck and lint everything touched**

```bash
(cd packages/shared && npx tsc --noEmit)
(cd apps/api && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
pnpm lint
```
Expected: all clean.

- [ ] **Step 3: Unit suites**

```bash
(cd packages/shared && npx vitest run)
(cd apps/api && npx vitest run src/services/contract src/services/aiToolsContracts src/routes/contracts src/jobs/contractWorker src/db/autoMigrate.test.ts)
(cd apps/web && npx vitest run src/components/contracts src/lib/i18n)
```
Expected: PASS.

- [ ] **Step 4: Contract and integration suites (real DB)**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/contractDeviceRoles.integration.test.ts \
  src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/quickSupportChain.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS. Check every file reports a non-zero test count.

- [ ] **Step 5: Manual DB check as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT conname FROM pg_constraint WHERE conrelid = 'contract_lines'::regclass ORDER BY 1;"
```
Expected: `contract_lines_device_roles_chk` and `contract_lines_site_org_fk` present, `contract_lines_site_fkey` absent.

- [ ] **Step 6: File the follow-up issue for device groups, then open the PR and stop**

```bash
gh issue create --repo LanternOps/breeze \
  --title "Bill contracts by device group (per_device_group line type)" \
  --label enhancement --label roadmap --label category:billing --label priority:p3 --label effort:m --label status:considering \
  --body "$(cat <<'EOF'
## Description

Follow-up to #3205, which shipped billing by device role. The second half of that proposal, a `per_device_group` contract line type billing the members of a static or dynamic device group, was deferred.

## Why deferred

Dynamic group membership is materialized on device change (`services/groupMembership.ts::evaluateGroupMembership`), not evaluated on read. Billing off a group would invoice whatever the last evaluation wrote, so generation needs a forced re-evaluation (or a live filter evaluation) or it bills stale counts. That needs its own design and an integration test proving generation re-evaluates.

## Shape

Columns only on `contract_lines` (`device_group_id uuid`, composite FK to `device_groups(id, org_id)` — the unique index does not exist yet), a `per_device_group` enum value in its own migration file, `snapshotContractDevices` extended (or a sibling) to group by membership, and the same coverage-warning treatment as role lines.
EOF
)"

git push -u origin billing-by-units
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): contract lines billed by device role (#3205)" --body "$(cat <<'EOF'
Closes #3205 (device-role half; device groups moved to the follow-up issue filed with this PR).

Spec: `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-role.md`

## What

- New `per_device_role` contract line type billing a SET of device roles (`contract_lines.device_roles text[]`, CHECK-enforced against the billable list; `unknown` is never billable).
- All device-counted quantities on a contract (existing `per_device` too) now come from one grouped snapshot per org, so a role change mid-generation cannot double-bill or skip a device.
- The estimate endpoint and invoice generation report devices no line bills, by role. Editor and detail pages show it; the generate dialog and the billing worker warn on it. Auto-issue still proceeds.
- Site ownership on `contract_lines.site_id` is now enforced (composite FK to `sites(id, org_id)` with `ON DELETE SET NULL (site_id)`, plus a `SITE_NOT_IN_ORG` 400). Previously a foreign-org site was accepted and silently counted zero.
- `DEVICE_ROLES` moved to `packages/shared/src/validators/deviceRoles.ts` (same package exports) with `BILLABLE_DEVICE_ROLES` beside it.

## Migrations

- `2026-10-03-100000-contract-line-type-per-device-role.sql` — enum value only.
- `2026-10-03-100100-contract-lines-device-roles.sql` — column, CHECK, foreign-org site cleanup (count logged), composite FK.

## Tests

Shared validator cases; pure coverage helpers; real-DB role counting + snapshot; CHECK / FK truth table; service unit + integration (writers, estimate, generation); AI tool; web editor/detail/notice; export policy + erasure round-trip; locale parity.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
EOF
)"
```

Stop here. Do not merge. Report the PR URL, the follow-up issue number, and anything that was skipped or failed.
