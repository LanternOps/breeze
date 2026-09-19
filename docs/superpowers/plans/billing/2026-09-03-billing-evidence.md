---
tracking_issue: LanternOps/breeze#3205
---

# Billing Evidence Per Invoice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist, at generation time, exactly which devices every auto-counted invoice line billed — and what each period did NOT bill — so a customer dispute is settled from the record instead of from a re-derivation against today's fleet.

**Architecture:** Two new shape-1 org-tenant tables. `invoice_line_devices` holds one row per counted device per invoice line, with `counted_as = included | overage | flagged` and a `NOT NULL invoice_line_id`; `contract_billing_period_outcomes` holds one row per claimed billing period carrying the uncovered/flagged/billed-overage aggregates. Generation collects evidence in the existing line loop from a single `matchingDevicesForLine(snapshot, line)` call (so the quantity and the evidence list are the same computation), and writes it in chunks **after** the period claim, inside the same transaction. Reads are two keyset-paged endpoints; the customer-facing surface is an optional PDF appendix whose gate is a persisted column stamped at issuance by both issuance writers.

**Tech Stack:** Postgres 16 (`CREATE INDEX CONCURRENTLY` under `autoMigrate`'s `-- @no-transaction` directive), Drizzle ORM, Hono, Zod 4, pdfkit, Vitest (unit + `vitest.integration.config.ts` real-DB suites + `vitest.config.rls.ts`), React + react-i18next (8 locales), Astro.

**Spec:** `docs/superpowers/specs/billing/2026-09-03-billing-evidence-design.md`

**Wave:** #3205 W07 (wave sub-issue #4656). Branch from `main` **after W04 (`2026-09-03-contract-line-allowance-overage.md`) and W06 (`2026-09-03-device-coverage-lookup.md`) have merged**: `feature/3205-billing-evidence/wave-4656`.

Predecessor symbols this plan consumes, all from the W02/W04/W06 plans — **not** from the code in this worktree, which is pre-W02:

| Symbol | Owner | Shape |
|---|---|---|
| `DeviceSnapshotRow` | W02 `contractQuantities.ts` | `{ id, role, siteId }` — **this wave adds `hostname`** |
| `OrgDeviceSnapshot` | W02 `contractCoverage.ts` | `{ devices: readonly DeviceSnapshotRow[]; groups: ReadonlyMap<string, GroupMembers> }` |
| `CoverageLine`, `isDeviceLine`, `uncoveredByRole`, `UncoveredDevices` | W02 `contractCoverage.ts` | `{ total, byRole }` |
| `orgSnapshot(orgId, dc, groupIds)`, `groupIdsOf(lines)`, `resolvableLines(lines, snapshot)`, `EMPTY_SNAPSHOT` | W02 `contractService.ts` | module-local |
| `coverageMatch(line, row, snapshot)`, `matchReason`, `DEVICE_COUNTED_LINE_TYPES`, `CoverageMatchReason` | W06 `contractCoverage.ts` | `'org'\|'site'\|'role'\|'group'\|null` |
| `billableDeviceById(orgId, deviceId)` | W06 `contractQuantities.ts` | returns a `DeviceSnapshotRow` — same column list, so it gains `hostname` for free |
| `applyAllowance(counted, spec, mode) → ResolvedQuantity` `{ counted, billed, included, overage, overageMode }`, `billsOverage(r)` | W04 `contractAllowance.ts` | pure |
| `OverageSummary` `{ contractLineId, invoiceLineId, description, counted, included, overage, mode }` | W04 `contractService.ts` | both modes |
| `const { line: baseLine, pricedFrom }` / `const { line: overageInvoiceLine }` in `generateDueInvoice` | W04 `contractService.ts` | **the W04 predecessor contract** — the overage line's id must be in scope |
| `assertInTransaction(label)` | W04 `db/index.ts` | first statement of `generateDueInvoice` |
| `DeviceCoverageNotice({ uncovered, orgId })`, `OverageNotice` | W06 / W04 web | reused verbatim by the period-outcome view |

## Global Constraints

- **Three migrations, in this order and no other:** A (`-- @no-transaction`, `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` for the two composite-FK targets on the live `invoice_lines` / `contract_billing_periods`), B (both tables + complete forced RLS + four policies each + `breeze_app` grants + the three new columns), C (`CREATE OR REPLACE` of `breeze_device_child_orgid_tables()` adding the device-move exclusion). B references A's indexes; C is meaningless until B's table exists.
- Migrations must sort after the newest committed file. Re-run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -1` before creating them; W04's `2026-10-07-100000-contract-lines-allowance-overage.sql` is the floor once W04 merges. Use `2026-10-08-100000/100100/100200-…` unless something newer landed; then bump the date past it and keep the `-100000-` / `-100100-` / `-100200-` time components. **`2026-08-06` is a closed date block — never reach for `-g-`.**
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP POLICY IF EXISTS` then re-create), and carry no inner `BEGIN;`/`COMMIT;`.
- **Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`** — all six of them (`orgLifecycleFoundations.integration.test.ts` merge contract; W01 went red on exactly this in #4585).
- **`ON DELETE SET NULL` names its column list** (`… SET NULL (site_id)`, `… SET NULL (invoice_id)`): without it PG15 nulls every FK column including the `NOT NULL org_id` and aborts the parent delete with 23502.
- **Device delete and device org-move DETACH, never cascade.** `invoice_line_devices` joins `DEVICE_DETACH_DEVICE_ID_TABLES`; its `device_id` FK is **single-column** `ON DELETE SET NULL` (a composite `(device_id, org_id)` would forbid every cross-org device move). The table is in `INTENTIONALLY_NO_ORG_ID` and gets an **explicit, load-bearing** `UPDATE … SET device_id = NULL` in `moveOrg.ts`.
- **Registrations, all in this PR:** `CORE_ORG_CASCADE_DELETE_ORDER` (both tables, alphabetised — `contract_billing_period_outcomes` **before** `contract_billing_periods`, `invoice_line_devices` **before** `invoice_lines`, the `_`-before-`s` trap), `CORE_TENANT_EXPORT_POLICY` (both tables, **every** column, plus `device_appendix` and `evidence_version` on the existing `invoices` row), `orgMergeRegistry` `REPOINT_TABLES` (both), `DEVICE_DETACH_DEVICE_ID_TABLES`, `INTENTIONALLY_NO_ORG_ID` + the mirrored `core.ts` comment. **Neither table goes in `AUDIT_ADMIN_REQUIRED_TABLES`** and neither gets an rls-coverage allowlist entry (shape 1 is auto-discovered; an allowlist entry appearing means the shape was got wrong).
- **Evidence is written in the same transaction, AFTER the period claim.** The line loop only appends to an in-memory array; the period id does not exist until `claimed.length > 0`, and a lost claim deletes the draft. Any throw rolls the invoice, the claim and the evidence back together.
- **Inserts are chunked at 500 rows per statement** inside the generation transaction. All chunks are in the same transaction, so the all-or-nothing property is unchanged.
- **Disposition invariants** (per device line matching `M` devices with allowance `N`): `included` rows = `min(M, N)`, tail rows = `max(0, M − N)`, base invoice-line quantity = `N` under a fixed allowance **regardless of `M`**. `included + tail === M` is the only unconditional identity; **evidence row count ≠ invoice quantity** whenever an allowance is set. Tail rows go on the **overage** line under `bill` mode and on the **base** line under `flag` mode.
- **Code-unit ordering, never `localeCompare`:** `a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : (a.id < b.id ? -1 : 1)`. The promise is an identical assignment PROJECTION (`device_id → counted_as`), not byte-identical rows — `id` and `created_at` are fresh on every insert.
- **`invoices.evidence_version smallint NULL`** is the invoice-level recorded flag (`1` = written by W07, `NULL` = pre-W07 or never generated from a contract), copied verbatim onto a reissued draft. `recorded` is NEVER derived from a row count.
- **The PDF appendix gate is a persisted pair frozen at issuance**, never a render-time argument: `partners.invoice_device_appendix` (default), `invoices.device_appendix` (NULL = inherit pre-issue; the resolved concrete boolean after issue). **Both** issuance writers stamp it (`issueInvoice` and `quoteAcceptService`), and `loadInvoiceForRender` reads only the stamp.
- Run one test file with `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` with `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test`. The integration harness truncates per test — **seed inline in each test**, never in a shared `beforeAll`. `devices.site_id` is NOT NULL, so every device fixture needs a site.

---

## File map

| File | Change |
|---|---|
| `packages/shared/src/types/billing-enums.ts` (+ web/api consumers) | `INVOICE_LINE_DEVICE_COUNTED_AS` SSOT tuple + `InvoiceLineDeviceCountedAs` |
| `apps/api/migrations/2026-10-08-100000-billing-evidence-fk-targets.sql` (new) | `-- @no-transaction`; two `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` |
| `apps/api/migrations/2026-10-08-100100-billing-evidence.sql` (new) | enum, both tables, six deferrable composite FKs, indexes, forced RLS + 8 policies + grants, three columns |
| `apps/api/migrations/2026-10-08-100200-device-move-exclude-billing-evidence.sql` (new) | `CREATE OR REPLACE breeze_device_child_orgid_tables()` + exclusion |
| `apps/api/src/db/schema/invoices.ts` | `invoiceLineDeviceCountedAsEnum`, `invoiceLineDevices`, `invoices.deviceAppendix`/`evidenceVersion`, `invoice_lines_id_org_uq` |
| `apps/api/src/db/schema/contracts.ts` | `contractBillingPeriodOutcomes`, `contract_billing_periods_id_org_uq` |
| `apps/api/src/db/schema/orgs.ts` | `partners.invoiceDeviceAppendix` |
| `apps/api/src/__tests__/integration/billingEvidenceConstraints.integration.test.ts` (new) | FK / SET NULL column-list / cascade / unique truth table |
| `apps/api/src/__tests__/integration/billingEvidenceRls.integration.test.ts` (new) | forged cross-org insert 42501, cross-org invisibility, system context |
| `apps/api/src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts` (new) | **the blocking regression** — cross-org device move + the function-exclusion assertion |
| `apps/api/src/services/tenantCascade.ts` | two cascade entries |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | two table policies + two columns on `invoices` |
| `apps/api/src/services/orgMergeRegistry.ts` | two `REPOINT_TABLES` entries |
| `apps/api/src/routes/devices/core.ts` | `DEVICE_DETACH_DEVICE_ID_TABLES` + comment block |
| `apps/api/src/routes/devices/moveOrg.ts` (+ `moveOrg.test.ts`, `moveOrg.coverage.test.ts`) | explicit detach + `INTENTIONALLY_NO_ORG_ID` |
| `apps/api/src/db/autoMigrate.test.ts` | A carries `-- @no-transaction`; A → B → C sort order |
| `apps/api/src/services/contractQuantities.ts` | `hostname` on `DeviceSnapshotRow`, `snapshotContractDevices`, `billableDeviceById` |
| `apps/api/src/services/contractCoverage.ts` (+ `.test.ts`) | `matchingDevicesForLine`, `compareEvidenceDevices`, `orderDevicesForEvidence`; `quantityFor` delegates |
| `apps/api/src/services/contractService.ts` (+ `.test.ts`) | `PendingEvidence`, evidence collection, chunked insert, outcome row, `evidence_version` |
| `apps/api/src/__tests__/integration/billingEvidence.integration.test.ts` (new) | the headline generation suite |
| `apps/api/src/services/invoiceService.ts` | pre-generated reissue id map + evidence clone; `device_appendix` stamp at issue; `deviceCount` on detail; `updatePartnerBillingSettings` |
| `apps/api/src/services/quoteAcceptService.ts` (+ test) | second issuance writer stamps `device_appendix` |
| `apps/api/src/lib/sendComposer.ts`, `apps/api/src/routes/invoices/lifecycle.ts` (+ test) | `includeDeviceAppendix` + draft-guarded atomic update, 409 `INVOICE_ALREADY_ISSUED` |
| `apps/api/src/services/billingEvidence.ts` (new, + `.test.ts`) | `listInvoiceLineDevices`, `getPeriodOutcome` |
| `apps/api/src/routes/invoices/evidence.ts` (new, + `.test.ts`), `routes/invoices/index.ts` | `GET /invoices/:id/lines/:lineId/devices` |
| `apps/api/src/routes/contracts/periods.ts` (new, + `.test.ts`), `routes/contracts/index.ts` | `GET /contracts/:id/periods/:periodId/outcome` |
| `apps/api/src/services/invoicePdf.ts` (+ `invoicePdf.appendix.test.ts`, `invoicePdf.appendix.integration.test.ts`) | appendix load + fourth render argument |
| `packages/shared/src/validators/invoices.ts` (+ `.test.ts`) | `invoiceDeviceAppendix` on `partnerBillingSettingsSchema` |
| `apps/web/src/components/billing/invoiceTypes.ts` | `InvoiceLine.deviceCount`, `InvoiceLineDevice` |
| `apps/web/src/lib/api/contracts.ts` | `PeriodOutcome` |
| `apps/web/src/components/billing/InvoiceDetail.tsx` (+ `InvoiceDetail.devices.test.tsx`) | per-line disclosure, flagged sub-heading, not-recorded notice |
| `apps/web/src/components/billing/InvoiceSendComposer.tsx` (+ test) | appendix checkbox |
| `apps/web/src/components/billing/PartnerBillingSettings.tsx` (+ test) | appendix toggle |
| `apps/web/src/components/contracts/ContractDetail.tsx` (+ `ContractDetail.outcome.test.tsx`) | Outcome column + expander |
| `apps/web/src/locales/*/billing.json` | new keys in 8 locales |
| `apps/docs/src/content/docs/features/contracts.mdx`, `invoices.mdx` | evidence + appendix docs |
| `docs/release-notes/next-release-draft.md` | billing entry |

---

### Task 1: Migrations A/B/C, Drizzle schema, shared enum, constraint truth table

**Files:**
- Modify: `packages/shared/src/types/billing-enums.ts`
- Create: `apps/api/migrations/2026-10-08-100000-billing-evidence-fk-targets.sql`
- Create: `apps/api/migrations/2026-10-08-100100-billing-evidence.sql`
- Create: `apps/api/migrations/2026-10-08-100200-device-move-exclude-billing-evidence.sql`
- Modify: `apps/api/src/db/schema/invoices.ts`, `apps/api/src/db/schema/contracts.ts`, `apps/api/src/db/schema/orgs.ts`
- Modify: `apps/api/src/db/autoMigrate.test.ts`
- Create: `apps/api/src/__tests__/integration/billingEvidenceConstraints.integration.test.ts`

**Interfaces:**

```ts
// packages/shared/src/types/billing-enums.ts
export const INVOICE_LINE_DEVICE_COUNTED_AS = ['included', 'overage', 'flagged'] as const;
export type InvoiceLineDeviceCountedAs = (typeof INVOICE_LINE_DEVICE_COUNTED_AS)[number];

// apps/api/src/db/schema/invoices.ts
export const invoiceLineDeviceCountedAsEnum: PgEnum<['included','overage','flagged']>;
export const invoiceLineDevices: PgTable;  // id, invoiceLineId, invoiceId, orgId, deviceId, hostname, deviceRole, siteId, countedAs, createdAt
// invoices gains: deviceAppendix: boolean | null; evidenceVersion: number | null

// apps/api/src/db/schema/contracts.ts
export const contractBillingPeriodOutcomes: PgTable;  // contractBillingPeriodId (PK), orgId, contractId, invoiceId,
                                                      // snapshotDeviceTotal, uncoveredTotal, flaggedTotal,
                                                      // billedOverageTotal, uncoveredByRole, overages, generatedAt
// apps/api/src/db/schema/orgs.ts
// partners gains: invoiceDeviceAppendix: boolean  (NOT NULL DEFAULT false)
```

- [ ] **Step 1: Write the failing real-DB constraint truth table**

Create `apps/api/src/__tests__/integration/billingEvidenceConstraints.integration.test.ts`:

```ts
/**
 * #3205 W07 / #4656 — real-DB truth table for the billing-evidence constraints.
 * Mirrors contractLinesDeviceGroupConstraints (W02). Every assertion here is a
 * property the MIGRATIONS own, not the service layer.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, contracts, contractBillingPeriods, invoices, invoiceLines } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EV ${sfx}`, slug: `ev-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'EA', slug: `ea-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'EB', slug: `eb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `SA-${sfx}` }).returning({ id: sites.id });
    const [siteB] = await db.insert(sites).values({ orgId: oB!.id, name: `SB-${sfx}` }).returning({ id: sites.id });
    // devices.site_id is NOT NULL.
    const [devA] = await db.insert(devices).values({
      orgId: oA!.id, siteId: siteA!.id, agentId: `agent-a-${sfx}`, hostname: 'alpha-01',
      status: 'online', deviceRole: 'server', osType: 'linux', osVersion: '22.04',
    }).returning({ id: devices.id });
    const [cA] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: 'CA', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    const [invA] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: oA!.id, currencyCode: 'USD', status: 'draft',
    }).returning({ id: invoices.id });
    const [invB] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: oB!.id, currencyCode: 'USD', status: 'draft',
    }).returning({ id: invoices.id });
    const [lineA] = await db.insert(invoiceLines).values({
      invoiceId: invA!.id, orgId: oA!.id, sourceType: 'contract', description: 'Endpoints',
      quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
    }).returning({ id: invoiceLines.id });
    const [lineB] = await db.insert(invoiceLines).values({
      invoiceId: invB!.id, orgId: oB!.id, sourceType: 'contract', description: 'Other org',
      quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
    }).returning({ id: invoiceLines.id });
    const [perA] = await db.insert(contractBillingPeriods).values({
      contractId: cA!.id, orgId: oA!.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', invoiceId: invA!.id,
    }).returning({ id: contractBillingPeriods.id });
    return {
      orgA: oA!.id, orgB: oB!.id, siteA: siteA!.id, siteB: siteB!.id, devA: devA!.id,
      contractA: cA!.id, invA: invA!.id, invB: invB!.id, lineA: lineA!.id, lineB: lineB!.id, periodA: perA!.id,
    };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

function insertEvidence(f: F, o: {
  lineId?: string; invoiceId?: string; orgId?: string; deviceId?: string | null;
  hostname?: string; siteId?: string | null; countedAs?: string;
}) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, device_id, hostname, device_role, site_id, counted_as)
    VALUES (${o.lineId ?? f.lineA}::uuid, ${o.invoiceId ?? f.invA}::uuid, ${o.orgId ?? f.orgA}::uuid,
            ${o.deviceId === undefined ? f.devA : o.deviceId}::uuid, ${o.hostname ?? 'alpha-01'}, 'server',
            ${o.siteId === undefined ? f.siteA : o.siteId}::uuid, ${o.countedAs ?? 'included'}::invoice_line_device_counted_as)
    RETURNING id
  `));
}

function insertOutcome(f: F, o: { periodId?: string; orgId?: string; contractId?: string; invoiceId?: string | null }) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_billing_period_outcomes (contract_billing_period_id, org_id, contract_id, invoice_id)
    VALUES (${o.periodId ?? f.periodA}::uuid, ${o.orgId ?? f.orgA}::uuid, ${o.contractId ?? f.contractA}::uuid,
            ${o.invoiceId === undefined ? f.invA : o.invoiceId}::uuid)
    RETURNING contract_billing_period_id
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

describe('billing evidence constraints (real DB) #3205 W07', () => {
  runDb('accepts an ordinary evidence row', async () => {
    const f = await seed();
    await expect(insertEvidence(f, {})).resolves.toBeDefined();
  });

  runDb('composite line FK rejects an invoice line from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertEvidence(f, { lineId: f.lineB }),
      { code: '23503', constraint: 'invoice_line_devices_line_org_fk' },
    );
  });

  runDb('composite invoice FK rejects an invoice from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertEvidence(f, { invoiceId: f.invB }),
      { code: '23503', constraint: 'invoice_line_devices_invoice_org_fk' },
    );
  });

  runDb('composite site FK rejects a site from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertEvidence(f, { siteId: f.siteB }),
      { code: '23503', constraint: 'invoice_line_devices_site_org_fk' },
    );
  });

  runDb('invoice_line_id is NOT NULL', async () => {
    const f = await seed();
    await expectPgError(() => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, hostname, device_role, counted_as)
      VALUES (NULL, ${f.invA}::uuid, ${f.orgA}::uuid, 'alpha-01', 'server', 'included')
    `)), { code: '23502', constraint: undefined });
  });

  runDb('deleting the device nulls ONLY device_id — org_id and hostname survive (PG15 column list)', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM devices WHERE id = ${f.devA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT device_id, org_id, hostname, device_role, site_id FROM invoice_line_devices WHERE invoice_line_id = ${f.lineA}::uuid
    `));
    expect(rows).toEqual([{ device_id: null, org_id: f.orgA, hostname: 'alpha-01', device_role: 'server', site_id: f.siteA }]);
  });

  runDb('deleting the site nulls ONLY site_id (the 23502 regression the column list exists for)', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM devices WHERE id = ${f.devA}::uuid`));
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM sites WHERE id = ${f.siteA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT site_id, org_id, hostname FROM invoice_line_devices WHERE invoice_line_id = ${f.lineA}::uuid
    `));
    expect(rows).toEqual([{ site_id: null, org_id: f.orgA, hostname: 'alpha-01' }]);
  });

  runDb('deleting the invoice line cascades its evidence', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM invoice_lines WHERE id = ${f.lineA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM invoice_line_devices`));
    expect(rows).toEqual([{ n: 0 }]);
  });

  runDb('(invoice_line_id, device_id) is unique, and NULL device_ids do not collide', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await expectPgError(
      () => insertEvidence(f, {}),
      { code: '23505', constraint: 'invoice_line_devices_line_device_uq' },
    );
    await expect(insertEvidence(f, { deviceId: null, hostname: 'gone-1' })).resolves.toBeDefined();
    await expect(insertEvidence(f, { deviceId: null, hostname: 'gone-2' })).resolves.toBeDefined();
  });

  runDb('outcome: deleting the billing period cascades the outcome row', async () => {
    const f = await seed();
    await insertOutcome(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM contract_billing_periods WHERE id = ${f.periodA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM contract_billing_period_outcomes`));
    expect(rows).toEqual([{ n: 0 }]);
  });

  runDb('outcome: deleting the draft invoice nulls ONLY invoice_id and keeps the outcome row', async () => {
    const f = await seed();
    await insertOutcome(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM invoices WHERE id = ${f.invA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT invoice_id, org_id, contract_id, snapshot_device_total, uncovered_total, flagged_total, billed_overage_total
      FROM contract_billing_period_outcomes
    `));
    expect(rows).toEqual([{
      invoice_id: null, org_id: f.orgA, contract_id: f.contractA,
      snapshot_device_total: 0, uncovered_total: 0, flagged_total: 0, billed_overage_total: 0,
    }]);
  });

  runDb('outcome: the period composite FK rejects a period from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertOutcome(f, { orgId: f.orgB }),
      { code: '23503', constraint: 'cbp_outcomes_period_org_fk' },
    );
  });

  runDb('all six composite FKs are DEFERRABLE and both prerequisite unique indexes exist', async () => {
    await seed();
    const cons = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, condeferrable FROM pg_constraint
      WHERE conrelid IN ('invoice_line_devices'::regclass, 'contract_billing_period_outcomes'::regclass)
        AND contype = 'f'
      ORDER BY conname
    `));
    expect(cons).toEqual([
      { conname: 'cbp_outcomes_contract_org_fk', condeferrable: true },
      { conname: 'cbp_outcomes_invoice_org_fk', condeferrable: true },
      { conname: 'cbp_outcomes_period_org_fk', condeferrable: true },
      { conname: 'invoice_line_devices_invoice_org_fk', condeferrable: true },
      { conname: 'invoice_line_devices_line_org_fk', condeferrable: true },
      { conname: 'invoice_line_devices_site_org_fk', condeferrable: true },
    ]);
    const idx = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('invoice_lines_id_org_uq', 'contract_billing_periods_id_org_uq')
      ORDER BY indexname
    `));
    expect(idx).toEqual([{ indexname: 'contract_billing_periods_id_org_uq' }, { indexname: 'invoice_lines_id_org_uq' }]);
  });

  runDb('both tables have forced RLS, four policies each, and the breeze_app grants', async () => {
    await seed();
    const rls = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('invoice_line_devices', 'contract_billing_period_outcomes') ORDER BY relname
    `));
    expect(rls).toEqual([
      { relname: 'contract_billing_period_outcomes', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'invoice_line_devices', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const pol = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT tablename, count(*)::int AS n FROM pg_policies
      WHERE tablename IN ('invoice_line_devices', 'contract_billing_period_outcomes')
      GROUP BY tablename ORDER BY tablename
    `));
    expect(pol).toEqual([
      { tablename: 'contract_billing_period_outcomes', n: 4 },
      { tablename: 'invoice_line_devices', n: 4 },
    ]);
    const grants = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
      FROM information_schema.role_table_grants
      WHERE grantee = 'breeze_app' AND table_name IN ('invoice_line_devices', 'contract_billing_period_outcomes')
      GROUP BY table_name ORDER BY table_name
    `));
    expect(grants).toEqual([
      { table_name: 'contract_billing_period_outcomes', privs: 'DELETE,INSERT,SELECT,UPDATE' },
      { table_name: 'invoice_line_devices', privs: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingEvidenceConstraints.integration.test.ts
```
Expected: FAIL — `relation "invoice_line_devices" does not exist`.

- [ ] **Step 3: Shared enum SSOT**

Append to `packages/shared/src/types/billing-enums.ts` (it is already re-exported by `types/index.ts:796`):

```ts
/** #3205 W07: how a device was counted on the invoice line it is evidence for.
 *  `included` = inside the allowance (or no allowance); `overage` = billed on the
 *  sibling overage line; `flagged` = above the allowance under `flag` mode and
 *  therefore NOT billed. Order mirrors the shipped Postgres enum. */
export const INVOICE_LINE_DEVICE_COUNTED_AS = ['included', 'overage', 'flagged'] as const;
export type InvoiceLineDeviceCountedAs = (typeof INVOICE_LINE_DEVICE_COUNTED_AS)[number];
```

- [ ] **Step 4: Migration A — the concurrent FK targets**

Create `apps/api/migrations/2026-10-08-100000-billing-evidence-fk-targets.sql`:

```sql
-- @no-transaction
-- #3205 wave 7 / #4656. Composite-FK targets on EXISTING hot tables.
--
-- Built CONCURRENTLY because a plain CREATE UNIQUE INDEX takes a SHARE lock and
-- would block every invoice write for the duration on a busy tenant. The
-- `-- @no-transaction` directive above makes autoMigrate run this file OUTSIDE a
-- transaction, statement by statement (autoMigrate.ts:652-670), which is what
-- makes CONCURRENTLY legal. That same contract is why IF NOT EXISTS is
-- mandatory: a failed CONCURRENTLY build leaves an INVALID index behind that an
-- operator must DROP INDEX before the next deploy, and re-applying this file
-- must otherwise be a no-op.
--
-- Migration 2026-10-08-100100 REFERENCES both indexes and will simply fail to
-- apply until this file has succeeded. That separation is deliberate.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS invoice_lines_id_org_uq
  ON invoice_lines (id, org_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS contract_billing_periods_id_org_uq
  ON contract_billing_periods (id, org_id);
```

- [ ] **Step 5: Migration B — tables, RLS, columns**

Create `apps/api/migrations/2026-10-08-100100-billing-evidence.sql`:

```sql
-- #3205 wave 7 / #4656: per-invoice billing evidence + per-period outcomes.
-- Shape-1 org tenancy on both tables (auto-discovered by rls-coverage — do NOT
-- add either to an allowlist there). Requires 2026-10-08-100000 (FK targets).

DO $$ BEGIN
  CREATE TYPE invoice_line_device_counted_as AS ENUM ('included', 'overage', 'flagged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------ 1. device evidence
CREATE TABLE IF NOT EXISTS invoice_line_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_line_id uuid NOT NULL,
  -- Denormalized so the appendix and the per-invoice read need no join, and so
  -- the org cascade has a direct handle. The composite FK below proves it
  -- agrees with the line's own invoice.
  invoice_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- SINGLE-column FK on purpose. A composite (device_id, org_id) would forbid
  -- every cross-org device move: the evidence stays in the INVOICE's org while
  -- the device leaves it (see moveOrg's explicit detach + INTENTIONALLY_NO_ORG_ID).
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- Stamps captured from the generation snapshot. hostname is what keeps a
  -- detached row legible; device_role is what makes a later reclassification
  -- visible instead of silent. Width/nullability mirror devices.hostname
  -- (db/schema/devices.ts, varchar(255) NOT NULL), so this never needs a null branch.
  hostname varchar(255) NOT NULL,
  device_role text NOT NULL,
  site_id uuid,
  counted_as invoice_line_device_counted_as NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lineage. DEFERRABLE because org merge repoints parent and child org_id in
-- separate statements under SET CONSTRAINTS ALL DEFERRED (orgMerge.ts).
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_line_org_fk
    FOREIGN KEY (invoice_line_id, org_id) REFERENCES invoice_lines (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_invoice_org_fk
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The PG15 column list is mandatory: without it SET NULL nulls EVERY FK column
-- including the NOT NULL org_id, which aborts the parent delete with 23502.
-- Same lesson as ai_agent_op_evidence (2026-10-01-100000).
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_site_org_fk
    FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
    ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per device per line. device_id NULLs do not collide, so a detached
-- row never blocks a later insert.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_devices_line_device_uq
  ON invoice_line_devices (invoice_line_id, device_id);
-- Per-line read (the disclosure endpoint) AND the FK-child index for
-- invoice_line_devices_line_org_fk: without it every invoice_lines DELETE
-- seq-scans this table. The unique index above leads on the same column but is
-- (invoice_line_id, device_id); this one carries the read's keyset sort key.
CREATE INDEX IF NOT EXISTS invoice_line_devices_line_read_idx
  ON invoice_line_devices (invoice_line_id, hostname, id);
-- Per-invoice read (the PDF appendix) and the FK-child index for
-- invoice_line_devices_invoice_org_fk.
CREATE INDEX IF NOT EXISTS invoice_line_devices_invoice_read_idx
  ON invoice_line_devices (invoice_id, hostname, id);
-- Detach path (device delete + move-org) and "which invoices billed this device".
CREATE INDEX IF NOT EXISTS invoice_line_devices_device_idx
  ON invoice_line_devices (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_line_devices_org_idx ON invoice_line_devices (org_id);

ALTER TABLE invoice_line_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_line_devices;
CREATE POLICY breeze_org_isolation_select ON invoice_line_devices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_line_devices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_line_devices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_line_devices
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE is REQUIRED: the device hard-delete detach (deviceDeletion.ts) and the
-- move-org detach are UPDATEs run as breeze_app, and the org-merge repoint is an
-- org_id UPDATE. This table is deliberately NOT append-only and deliberately
-- absent from AUDIT_ADMIN_REQUIRED_TABLES for exactly that reason (decision 9).
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line_devices TO breeze_app;

-- ------------------------------------------------------------ 2. period outcome
CREATE TABLE IF NOT EXISTS contract_billing_period_outcomes (
  contract_billing_period_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  invoice_id uuid,
  -- Scalars first: jsonb is excludedOpen and never reaches a tenant export, so
  -- no fact may live ONLY in the digests below (decision 3).
  -- snapshot_device_total = 0 means "no snapshot was evaluated" (a flat-only
  -- contract), NOT "the org owns zero devices" — generation only builds a
  -- snapshot when a device-counted line exists.
  snapshot_device_total integer NOT NULL DEFAULT 0,
  uncovered_total integer NOT NULL DEFAULT 0,
  flagged_total integer NOT NULL DEFAULT 0,
  billed_overage_total integer NOT NULL DEFAULT 0,
  -- role -> count, mirroring UncoveredDevices.byRole.
  uncovered_by_role jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- W04 OverageSummary[] verbatim, BOTH modes.
  overages jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_period_org_fk
    FOREIGN KEY (contract_billing_period_id, org_id)
    REFERENCES contract_billing_periods (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Mirrors contract_billing_periods.invoice_id, which is itself SET NULL: a
-- deleted draft must not take the outcome row with it. Column list again
-- mandatory, same 23502 reason as above.
DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_invoice_org_fk
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
    ON DELETE SET NULL (invoice_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS cbp_outcomes_contract_idx
  ON contract_billing_period_outcomes (contract_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS cbp_outcomes_org_idx ON contract_billing_period_outcomes (org_id);

ALTER TABLE contract_billing_period_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_billing_period_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_billing_period_outcomes;
CREATE POLICY breeze_org_isolation_select ON contract_billing_period_outcomes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_billing_period_outcomes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_billing_period_outcomes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_billing_period_outcomes
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE for the org-merge repoint, same as the evidence table.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_billing_period_outcomes TO breeze_app;

-- ------------------------------------------------------------ 3. appendix gate
-- Partner default. A dedicated column, not a settings jsonb key: settings cards
-- replace sub-objects wholesale (#3597) and a stored `false` in jsonb is
-- ambiguous with "unset" (#3608). A NOT NULL DEFAULT column has no unset state.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS
  invoice_device_appendix boolean NOT NULL DEFAULT false;
-- Pre-issue: NULL = inherit the partner default; settable only while status='draft'.
-- AT issue: both issuance writers stamp the RESOLVED boolean here, and the
-- renderer reads only this column thereafter (decision 14a), so a later change to
-- the partner default cannot alter a sanctioned re-render of an issued invoice.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS device_appendix boolean;
-- 1 = evidence written at generation by W07; NULL = pre-W07, or an invoice never
-- generated from a contract. Invoice-level `recorded` flag (decision 15a) —
-- deliberately NOT per line, so a line that genuinely counted zero devices stays
-- distinguishable from a historical invoice. smallint, not boolean, so a future
-- change to what generation records can be told apart from version 1.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS evidence_version smallint;
```

- [ ] **Step 6: Migration C — the device-move exclusion (BLOCKING)**

Create `apps/api/migrations/2026-10-08-100200-device-move-exclude-billing-evidence.sql`. Copy the body **verbatim** from `apps/api/migrations/2026-09-17-pam-device-move-guard.sql`'s `breeze_device_child_orgid_tables()` definition and add one name:

```sql
-- #3205 wave 7 / #4656 — BLOCKING (spec decision 10a).
--
-- breeze_cascade_device_org_id() is an AFTER UPDATE trigger on devices that
-- restamps org_id on every table this function returns, DURING the devices
-- UPDATE itself and before any route code runs. The function discovers tables
-- dynamically from pg_class/pg_attribute (uuid device_id + uuid org_id), so
-- invoice_line_devices is auto-enrolled the moment it exists — and its
-- DEFERRABLE INITIALLY IMMEDIATE composite FKs to invoice_lines/invoices are
-- checked at the end of that same statement, raising 23503 and failing every
-- cross-org move of a billed device. Exactly the tickets_requester_contact_org_fk
-- shape documented in 2026-10-04-100000-ticket-requester-contact.sql.
--
-- Full current body copied from 2026-09-17-pam-device-move-guard.sql, with only
-- the billing-evidence table added to the deliberate exclusion list.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    AND t.relname NOT IN (
      'ai_agent_runs',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
```

Before writing this file, re-read the newest committed definition and diff it against the copy — if another wave has replaced `breeze_device_child_orgid_tables()` since, copy **that** body instead:

```bash
grep -rln "CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables" apps/api/migrations | sort | tail -1
```

- [ ] **Step 7: Drizzle mirror**

`apps/api/src/db/schema/invoices.ts` — import the SSOT tuple beside the others and add the enum after `paymentMethodEnum`:

```ts
import { INVOICE_STATUSES, INVOICE_LINE_SOURCE_TYPES, PAYMENT_METHODS, INVOICE_LINE_DEVICE_COUNTED_AS } from '@breeze/shared';

export const invoiceLineDeviceCountedAsEnum = pgEnum('invoice_line_device_counted_as', [...INVOICE_LINE_DEVICE_COUNTED_AS]);
```

Add to the `invoices` column list, after `documentLocale`:

```ts
  // #3205 W07 appendix gate. NULL pre-issue = "inherit partners.invoice_device_appendix";
  // both issuance writers stamp the RESOLVED boolean at issue and the renderer
  // reads ONLY this column afterwards, so a later partner-default change cannot
  // alter what a sanctioned re-render produces.
  deviceAppendix: boolean('device_appendix'),
  // #3205 W07: 1 = billing evidence written at generation. NULL = pre-W07 or
  // never generated from a contract. Invoice-level `recorded` flag — never
  // derived from an evidence row count.
  evidenceVersion: integer('evidence_version'),
```

> `smallint` has no dedicated Drizzle helper in use here; `integer(...)` maps to the same JS number and `db:check-drift` compares the column's declared SQL type only through the migration, which is the SSOT. If drift is reported, switch to `smallint('evidence_version')` from `drizzle-orm/pg-core` and re-run.

Add to the `invoiceLines` index array:

```ts
  // Composite-FK target for invoice_line_devices_line_org_fk (#3205 W07).
  // Built CONCURRENTLY by migration 2026-10-08-100000; declared here as an
  // ordinary uniqueIndex because db:check-drift compares definitions, not how
  // they were built.
  uniqueIndex('invoice_lines_id_org_uq').on(t.id, t.orgId),
```

Then the evidence table, after `invoiceLines`:

```ts
/**
 * #3205 W07 (#4656): which devices an auto-counted invoice line actually billed.
 *
 * One row per counted device per invoice line. `invoice_line_id` is NOT NULL in
 * every case — "uncovered" is an aggregate on contract_billing_period_outcomes,
 * never a row here. Written by generateDueInvoice inside the billing
 * transaction, AFTER the period claim; never mutated afterwards except by the
 * device-delete / move-org detaches and the org-merge repoint.
 *
 * SQL-ONLY constraints (declared in migration 2026-10-08-100100, deliberately
 * not mirrored here — same treatment as W01's site FK and W02's group FK):
 *   - (invoice_line_id, org_id) -> invoice_lines(id, org_id) ON DELETE CASCADE DEFERRABLE
 *   - (invoice_id, org_id)      -> invoices(id, org_id)      ON DELETE CASCADE DEFERRABLE
 *   - (site_id, org_id)         -> sites(id, org_id)         ON DELETE SET NULL (site_id) DEFERRABLE
 * The device_id FK IS single-column and IS mirrored below: a composite
 * (device_id, org_id) would forbid every cross-org device move.
 */
export const invoiceLineDevices = pgTable('invoice_line_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceLineId: uuid('invoice_line_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id'),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  deviceRole: text('device_role').notNull(),
  siteId: uuid('site_id'),
  countedAs: invoiceLineDeviceCountedAsEnum('counted_as').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('invoice_line_devices_line_device_uq').on(t.invoiceLineId, t.deviceId),
  index('invoice_line_devices_line_read_idx').on(t.invoiceLineId, t.hostname, t.id),
  index('invoice_line_devices_invoice_read_idx').on(t.invoiceId, t.hostname, t.id),
  index('invoice_line_devices_device_idx').on(t.deviceId).where(sql`${t.deviceId} IS NOT NULL`),
  index('invoice_line_devices_org_idx').on(t.orgId)
]);
```

> The `device_id` FK is written in SQL (`REFERENCES devices(id) ON DELETE SET NULL`) rather than as a Drizzle `.references()` to avoid an import cycle with `devices.ts` — the same reason `invoices.siteId` already carries a SQL-only FK. Add a one-line comment saying so beside `deviceId`.

`apps/api/src/db/schema/contracts.ts` — add to the `contractBillingPeriods` index array and then the outcome table:

```ts
  // Composite-FK target for cbp_outcomes_period_org_fk (#3205 W07). Built
  // CONCURRENTLY by migration 2026-10-08-100000.
  uniqueIndex('contract_billing_periods_id_org_uq').on(t.id, t.orgId),
```

```ts
/**
 * #3205 W07 (#4656): what one claimed billing period actually billed — and did
 * not bill. Exactly one row per contract_billing_periods row, written in the
 * same transaction immediately after the claim. A period with NO row was billed
 * before W07; that is the ONLY meaning of absence.
 *
 * snapshot_device_total = 0 means "no snapshot was evaluated" (a flat-only
 * contract), not "the org owns zero devices".
 *
 * SQL-ONLY constraints (migration 2026-10-08-100100):
 *   - (contract_billing_period_id, org_id) -> contract_billing_periods(id, org_id) ON DELETE CASCADE DEFERRABLE
 *   - (contract_id, org_id)                -> contracts(id, org_id)                ON DELETE CASCADE DEFERRABLE
 *   - (invoice_id, org_id)                 -> invoices(id, org_id)                 ON DELETE SET NULL (invoice_id) DEFERRABLE
 */
export const contractBillingPeriodOutcomes = pgTable('contract_billing_period_outcomes', {
  contractBillingPeriodId: uuid('contract_billing_period_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  contractId: uuid('contract_id').notNull(),
  invoiceId: uuid('invoice_id'),
  snapshotDeviceTotal: integer('snapshot_device_total').notNull().default(0),
  uncoveredTotal: integer('uncovered_total').notNull().default(0),
  flaggedTotal: integer('flagged_total').notNull().default(0),
  billedOverageTotal: integer('billed_overage_total').notNull().default(0),
  uncoveredByRole: jsonb('uncovered_by_role').notNull().default(sql`'{}'::jsonb`),
  overages: jsonb('overages').notNull().default(sql`'[]'::jsonb`),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  index('cbp_outcomes_contract_idx').on(t.contractId, desc(t.generatedAt)),
  index('cbp_outcomes_org_idx').on(t.orgId)
]);
```

`apps/api/src/db/schema/orgs.ts` — add beside `autoTaxHardware` on `partners`:

```ts
  // #3205 W07: partner default for the "Billed devices" appendix on invoice
  // PDFs. A dedicated column, for the reason autoEmailInvoiceOnQuoteAccept
  // states: settings cards replace sub-objects wholesale (#3597), and a column
  // keeps gate === read-back with no #3608 stored-false ambiguity. Resolved
  // ONCE at issue onto invoices.device_appendix; never read at render time.
  invoiceDeviceAppendix: boolean('invoice_device_appendix').notNull().default(false),
```

Export both new tables wherever `db/schema/index.ts` re-exports the invoice/contract modules (they use `export *`, so no edit is needed — confirm with `grep -n "schema/invoices\|schema/contracts" apps/api/src/db/schema/index.ts`).

- [ ] **Step 8: `autoMigrate.test.ts` — ordering and the directive**

> **Write this one BEFORE Step 4** and watch it fail (`expect(a).toBeGreaterThan(-1)` — no such file yet). Written after the migrations exist it is a confirmation, not a discriminator. It is listed here only so the migration bodies read in one place.

Append to `apps/api/src/db/autoMigrate.test.ts`, inside the existing migration-file describe:

```ts
  it('#3205 W07: the billing-evidence migrations sort A -> B -> C and A is no-transaction', () => {
    const dir = join(__dirname, '../../migrations');
    const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
    const a = files.findIndex((f) => f.endsWith('-billing-evidence-fk-targets.sql'));
    const b = files.findIndex((f) => f.endsWith('-billing-evidence.sql'));
    const c = files.findIndex((f) => f.endsWith('-device-move-exclude-billing-evidence.sql'));
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // A builds indexes CONCURRENTLY, which is illegal inside a transaction.
    expect(hasNoTransactionDirective(readFileSync(join(dir, files[a]!), 'utf8'))).toBe(true);
    // B and C are ordinary transactional files.
    expect(hasNoTransactionDirective(readFileSync(join(dir, files[b]!), 'utf8'))).toBe(false);
    expect(hasNoTransactionDirective(readFileSync(join(dir, files[c]!), 'utf8'))).toBe(false);
  });
```

(`readdirSync`, `readFileSync`, `join` and `hasNoTransactionDirective` are already imported by that file; add whichever is missing.)

- [ ] **Step 9: Migrate a fresh DB and run**

```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && pnpm db:migrate && pnpm db:check-drift
npx vitest run src/db/autoMigrate.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingEvidenceConstraints.integration.test.ts
```
Expected: migrate applies all three (A logged as `(no-transaction)`); `db:check-drift` clean; both suites PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/types/billing-enums.ts \
  apps/api/migrations/2026-10-08-100000-billing-evidence-fk-targets.sql \
  apps/api/migrations/2026-10-08-100100-billing-evidence.sql \
  apps/api/migrations/2026-10-08-100200-device-move-exclude-billing-evidence.sql \
  apps/api/src/db/schema/invoices.ts apps/api/src/db/schema/contracts.ts apps/api/src/db/schema/orgs.ts \
  apps/api/src/db/autoMigrate.test.ts \
  apps/api/src/__tests__/integration/billingEvidenceConstraints.integration.test.ts
git commit -m "feat(billing): invoice_line_devices + contract_billing_period_outcomes tables, RLS and appendix columns (#3205 W07)"
```

---

### Task 2: Every registration list, the move-org detach, RLS isolation, and the blocking device-move regression

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (two entries in `CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/orgMergeRegistry.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (+ `moveOrg.test.ts`)
- Modify: `apps/api/src/routes/devices/moveOrg.coverage.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/billingEvidenceRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts`

**Interfaces:** none new — this task is pure registration plus two real-DB suites.

> **This is the task that gets missed.** RLS coverage does not imply cascade coverage; they are separate contracts. Treat each row below as a mechanical grep, not a judgement call.

- [ ] **Step 1: Write the failing RLS isolation suite**

Create `apps/api/src/__tests__/integration/billingEvidenceRls.integration.test.ts`:

```ts
/**
 * #3205 W07 — tenant isolation for the two evidence tables, exercised as
 * breeze_app under a real org context (forced RLS, no bypass). Shape 1, so
 * rls-coverage auto-discovers them; this suite proves the policies actually bite.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, invoices, invoiceLines } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `RLS ${sfx}`, slug: `rls-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'RA', slug: `ra-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'RB', slug: `rb-${sfx}` },
    ]).returning({ id: organizations.id });
    await db.insert(sites).values({ orgId: oA!.id, name: `RA-${sfx}` });
    const mk = async (orgId: string, host: string) => {
      const [inv] = await db.insert(invoices)
        .values({ partnerId: p!.id, orgId, currencyCode: 'USD', status: 'draft' })
        .returning({ id: invoices.id });
      const [line] = await db.insert(invoiceLines).values({
        invoiceId: inv!.id, orgId, sourceType: 'contract', description: 'Endpoints',
        quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
      }).returning({ id: invoiceLines.id });
      await db.execute(sql`
        INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, device_id, hostname, device_role, counted_as)
        VALUES (${line!.id}::uuid, ${inv!.id}::uuid, ${orgId}::uuid, NULL, ${host}, 'server', 'included')
      `);
      return { invoiceId: inv!.id, lineId: line!.id };
    };
    const a = await mk(oA!.id, 'a-host-01');
    const b = await mk(oB!.id, 'b-host-01');
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, a, b };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ctxFor = (orgId: string, partnerId: string) =>
  ({ scope: 'organization' as const, orgId, partnerId, accessibleOrgIds: [orgId], userId: null });

describe('invoice_line_devices tenant isolation (real DB) #3205 W07', () => {
  runDb('a forged insert carrying another org id fails with 42501', async () => {
    const f = await seed();
    await expect(withDbAccessContext(ctxFor(f.orgA, f.partnerId), () => db.execute(sql`
      INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, hostname, device_role, counted_as)
      VALUES (${f.b.lineId}::uuid, ${f.b.invoiceId}::uuid, ${f.orgB}::uuid, 'forged', 'server', 'included')
    `))).rejects.toThrow(/new row violates row-level security policy|42501/);
  });

  runDb('org B rows are invisible in org A context, and vice versa', async () => {
    const f = await seed();
    const inA = await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () => db.execute(sql`
      SELECT hostname FROM invoice_line_devices ORDER BY hostname
    `));
    expect(inA).toEqual([{ hostname: 'a-host-01' }]);
    const inB = await withDbAccessContext(ctxFor(f.orgB, f.partnerId), () => db.execute(sql`
      SELECT hostname FROM invoice_line_devices ORDER BY hostname
    `));
    expect(inB).toEqual([{ hostname: 'b-host-01' }]);
  });

  runDb('the system context sees both', async () => {
    const f = await seed();
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT hostname FROM invoice_line_devices WHERE org_id IN (${f.orgA}::uuid, ${f.orgB}::uuid) ORDER BY hostname
    `));
    expect(rows).toEqual([{ hostname: 'a-host-01' }, { hostname: 'b-host-01' }]);
  });

  runDb('contract_billing_period_outcomes: a forged cross-org insert fails with 42501', async () => {
    const f = await seed();
    const period = await withSystemDbAccessContext(async () => {
      const rows = await db.execute(sql`
        INSERT INTO contracts (partner_id, org_id, name, interval_months, start_date, currency_code)
        VALUES (${f.partnerId}::uuid, ${f.orgB}::uuid, 'CB', 1, '2026-07-01', 'USD') RETURNING id
      `) as unknown as Array<{ id: string }>;
      const cid = rows[0]!.id;
      const p = await db.execute(sql`
        INSERT INTO contract_billing_periods (contract_id, org_id, period_start, period_end)
        VALUES (${cid}::uuid, ${f.orgB}::uuid, '2026-07-01', '2026-07-31') RETURNING id
      `) as unknown as Array<{ id: string }>;
      return { contractId: cid, periodId: p[0]!.id };
    });
    await expect(withDbAccessContext(ctxFor(f.orgA, f.partnerId), () => db.execute(sql`
      INSERT INTO contract_billing_period_outcomes (contract_billing_period_id, org_id, contract_id)
      VALUES (${period.periodId}::uuid, ${f.orgB}::uuid, ${period.contractId}::uuid)
    `))).rejects.toThrow(/new row violates row-level security policy|42501/);
  });
});
```

- [ ] **Step 2: Write the failing device-move regression (the BLOCKING one)**

Create `apps/api/src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts`:

```ts
/**
 * #3205 W07 decision 10a — THE BLOCKING REGRESSION.
 *
 * breeze_cascade_device_org_id() restamps org_id on every table
 * breeze_device_child_orgid_tables() returns, DURING the devices UPDATE and
 * before any route code runs. That function discovers tables dynamically, so
 * without migration 2026-10-08-100200 invoice_line_devices is auto-enrolled and
 * the initially-immediate composite FKs raise 23503, failing every cross-org
 * move of a billed device. A red here IS that failure.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, invoices, invoiceLines } from '../../db/schema';
import { moveDeviceToOrg } from '../../routes/devices/moveOrg';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `MV ${sfx}`, slug: `mv-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'MA', slug: `ma-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'MB', slug: `mb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `MA-${sfx}` }).returning({ id: sites.id });
    const [siteB] = await db.insert(sites).values({ orgId: oB!.id, name: `MB-${sfx}` }).returning({ id: sites.id });
    const [dev] = await db.insert(devices).values({
      orgId: oA!.id, siteId: siteA!.id, agentId: `agent-${sfx}`, hostname: 'billed-01',
      status: 'online', deviceRole: 'server', osType: 'linux', osVersion: '22.04',
    }).returning({ id: devices.id });
    const [inv] = await db.insert(invoices)
      .values({ partnerId: p!.id, orgId: oA!.id, currencyCode: 'USD', status: 'sent', invoiceNumber: `INV-${sfx}` })
      .returning({ id: invoices.id });
    const [line] = await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: oA!.id, sourceType: 'contract', description: 'Endpoints',
      quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
    }).returning({ id: invoiceLines.id });
    await db.execute(sql`
      INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, device_id, hostname, device_role, site_id, counted_as)
      VALUES (${line!.id}::uuid, ${inv!.id}::uuid, ${oA!.id}::uuid, ${dev!.id}::uuid, 'billed-01', 'server', ${siteA!.id}::uuid, 'included')
    `);
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, siteB: siteB!.id, deviceId: dev!.id, invoiceId: inv!.id, lineId: line!.id };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('cross-org device move with billing evidence (real DB) #3205 W07', () => {
  runDb('breeze_device_child_orgid_tables() does NOT return invoice_line_devices', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT 1 AS hit FROM public.breeze_device_child_orgid_tables() t(name) WHERE t.name = 'invoice_line_devices'
    `));
    // A future CREATE OR REPLACE of that function which drops the exclusion
    // fails HERE, not in production on a customer's device move.
    expect(rows).toEqual([]);
  });

  runDb('the move SUCCEEDS, the evidence keeps the invoice org, and device_id detaches', async () => {
    const f = await seed();
    // A 23503 raised inside this call is the exact failure the exclusion prevents.
    await withSystemDbAccessContext(() => moveDeviceToOrg({
      deviceId: f.deviceId, targetOrgId: f.orgB, targetSiteId: f.siteB, partnerId: f.partnerId, actorUserId: null,
    }));
    const ev = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT org_id, invoice_id, device_id, hostname, device_role FROM invoice_line_devices WHERE invoice_line_id = ${f.lineId}::uuid
    `));
    expect(ev).toEqual([{
      org_id: f.orgA,            // stays with the INVOICE's org
      invoice_id: f.invoiceId,
      device_id: null,           // moveOrg.ts's explicit detach — load-bearing, not a mirror
      hostname: 'billed-01',     // still legible after the detach
      device_role: 'server',
    }]);
    const inv = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT org_id FROM invoices WHERE id = ${f.invoiceId}::uuid
    `));
    expect(inv).toEqual([{ org_id: f.orgA }]);
    const dev = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT org_id FROM devices WHERE id = ${f.deviceId}::uuid
    `));
    expect(dev).toEqual([{ org_id: f.orgB }]);
  });
});
```

> Adjust the `moveDeviceToOrg` import/signature to whatever `routes/devices/moveOrg.ts` actually exports (read it first — the route handler may need to be exercised through the Hono app instead, in which case follow the pattern the existing `moveOrg` integration test uses). The assertions above are the contract; the invocation is not.

- [ ] **Step 3: Run both to verify they fail**

```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/billingEvidenceRls.integration.test.ts \
  src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts
```
Expected: the RLS suite PASSES already (migration B shipped the policies in Task 1 — that is the point of writing them in the creating migration). The device-move suite FAILS on the detach assertion (`device_id` still set) — migration C is in place from Task 1, so the trigger leaves the row alone, and nothing detaches it yet.

> If the RLS suite is red, stop: the policies or grants in migration B are wrong, and no later task can fix that.

- [ ] **Step 4: Run the four registration contract suites to see them go red**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected reds, and only these:
- `cascadeDelete.test.ts` — `invoice_line_devices: in NO set`.
- `moveOrg.coverage.test.ts` — `invoice_line_devices` has `org_id` and is device-managed but absent from both lists.
- `tenantCascade.integration.test.ts` — both tables missing from `CORE_ORG_CASCADE_DELETE_ORDER`.
- `tenant-export-policy.integration.test.ts` — both tables unclassified **and** `invoices.device_appendix` / `invoices.evidence_version` unclassified.
- `orgMergeRegistry.integration.test.ts` — both tables have no merge policy.
- `orgLifecycleFoundations.integration.test.ts` — **green** (Task 1 already made all six FKs deferrable).
- `rls-coverage.integration.test.ts` — **green** (shape 1, auto-discovered; if it is red, the policies are wrong, not the allowlist).

- [ ] **Step 5: `CORE_ORG_CASCADE_DELETE_ORDER`**

`apps/api/src/services/tenantCascade.ts`. Insert `'contract_billing_period_outcomes'` immediately **before** `'contract_billing_periods'`, and `'invoice_line_devices'` immediately **before** `'invoice_lines'` (after `'invoice_documents'`):

```ts
  // localeCompare puts the '_' in 'contract_billing_period_outcomes' ahead of
  // the 's' in 'contract_billing_periods' — the same prefix-extension trap
  // documented above for contact_external_links/contacts. Verify with
  // `node --eval "console.log('contract_billing_period_outcomes'.localeCompare('contract_billing_periods'))"`
  // (-1) before moving either line.
  'contract_billing_period_outcomes',
  'contract_billing_periods',
```

```ts
  'invoice_documents',
  // Same '_' < 's' prefix-extension trap: invoice_line_devices sorts BEFORE
  // invoice_lines. It is also the FK child, so children-before-parents and
  // alphabetical order agree here — but the runtime topological sort
  // (topologicalCascadeOrder) is what actually orders the DELETEs.
  'invoice_line_devices',
  'invoice_lines',
```

Do **not** add either table to `AUDIT_ADMIN_REQUIRED_TABLES` — `breeze_app` must be able to UPDATE both (decision 9).

- [ ] **Step 6: `CORE_TENANT_EXPORT_POLICY` — both tables AND two columns on `invoices`**

`apps/api/src/services/tenantExportPolicyRegistry.ts`. Add in alphabetical position:

```ts
  "contract_billing_period_outcomes": tablePolicy("org_id", {
    included: ["contract_billing_period_id","org_id","contract_id","invoice_id",
               "snapshot_device_total","uncovered_total","flagged_total",
               "billed_overage_total","generated_at"],
    reviewedIncluded: [], excludedSensitive: [],
    // DELIBERATE non-portability (#3205 W07 decision 3), not an oversight: these
    // two are jsonb, so the open-container rule excludes them from every tenant
    // export. The scalar totals above are the exported facts, and the billed
    // overage is additionally a real priced row in invoice_lines (fully
    // exported). Do NOT "fix" this by promoting either column to `included`.
    excludedOpen: ["uncovered_by_role","overages"],
  }),
```

```ts
  // hostname is ordinary customer inventory data — the same value
  // devices.hostname already exports — and stays `included`. It is also what
  // keeps a detached row (deleted or moved device) legible on a past invoice.
  "invoice_line_devices": tablePolicy("org_id", {
    included: ["id","invoice_line_id","invoice_id","org_id","device_id","hostname",
               "device_role","site_id","counted_as","created_at"],
    reviewedIncluded: [], excludedSensitive: [], excludedOpen: [],
  }),
```

**And extend the existing `invoices` row** — this is the registration that fires on a new COLUMN, not a new table. Append `"device_appendix","evidence_version"` to its `included` array (both are non-secret operational flags, the same class as `document_locale`).

- [ ] **Step 7: `orgMergeRegistry` — two plain repoints**

`apps/api/src/services/orgMergeRegistry.ts`, in `REPOINT_TABLES`, alphabetically:

```ts
  "contract_billing_period_outcomes",   // before "contract_billing_periods"
  "contract_billing_periods",
```

```ts
  "invoice_documents",
  "invoice_line_devices",               // before "invoice_lines"
  "invoice_lines",
```

Evidence follows its invoice's org, which under a merge is the survivor org — the same policy `invoices` and `invoice_lines` already carry, so evidence can never diverge from the document it evidences. Neither table goes in `SPECIAL` (the suite asserts the two sets are disjoint).

- [ ] **Step 8: `DEVICE_DETACH_DEVICE_ID_TABLES` + the `core.ts` comment block**

`apps/api/src/routes/devices/core.ts`. Add to the detach list (keep it alphabetical-ish, matching the existing style):

```ts
// invoice_line_devices (#3205 W07) also detaches: the row is billing evidence
// that must outlive the device it names — a past invoice still says which
// devices it charged for, by hostname, after a hard delete. Its device_id FK is
// declared ON DELETE SET NULL to match, and the table is deliberately NOT
// append-only so this generic UPDATE loop can run as breeze_app.
export const DEVICE_DETACH_DEVICE_ID_TABLES = [
  'abuse_endpoint_fingerprints', 'ai_agent_runs', 'invoice_line_devices', 'support_sessions', 'tickets',
] as const;
```

Append to the `CORE_DEVICE_ORG_DENORMALIZED_TABLES` doc comment block (mirroring `moveOrg.coverage.test.ts`'s `INTENTIONALLY_NO_ORG_ID`):

```
 * invoice_line_devices is deliberately ABSENT too (#3205 W07): it has both
 * org_id and device_id, but its org_id belongs to the INVOICE, which does not
 * move. Re-stamping it would break the (invoice_line_id, org_id) and
 * (invoice_id, org_id) composite FKs. It is additionally excluded from
 * breeze_device_child_orgid_tables() by migration
 * 2026-10-08-100200-device-move-exclude-billing-evidence.sql, because that
 * trigger would otherwise restamp it mid-UPDATE and raise 23503 before any
 * route code runs. moveOrg detaches device_id instead — an explicit,
 * LOAD-BEARING statement, not a mirror of the generic loop. It is listed in
 * INTENTIONALLY_NO_ORG_ID in moveOrg.coverage.test.ts.
```

- [ ] **Step 9: `INTENTIONALLY_NO_ORG_ID`**

`apps/api/src/routes/devices/moveOrg.coverage.test.ts`, in the set:

```ts
  // Has org_id AND device_id, but org_id belongs to the INVOICE and the invoice
  // does not move (#3205 W07). Re-stamping would break the composite FKs to
  // invoice_lines/invoices; the table is also excluded from
  // breeze_device_child_orgid_tables() so the devices-UPDATE trigger cannot
  // restamp it either — see the CORE_DEVICE_ORG_DENORMALIZED_TABLES comment in
  // core.ts.
  'invoice_line_devices',
```

- [ ] **Step 10: the explicit detach in `moveOrg.ts`**

`apps/api/src/routes/devices/moveOrg.ts`, immediately after the `ai_agent_runs` detach statement:

```ts
        // #3205 W07: billing evidence stays in the INVOICE's org — the invoice
        // and its lines do not move. UNLIKE the ai_agent_runs statement above,
        // which normally matches nothing because breeze_cascade_device_org_id()
        // has already run, this one is LOAD-BEARING: invoice_line_devices is
        // excluded from breeze_device_child_orgid_tables()
        // (2026-10-08-100200-…), so the trigger leaves the row entirely alone
        // and nothing else severs the now-cross-tenant device pointer. The row
        // keeps its hostname and device_role, so the past invoice stays legible.
        await tx.execute(
          sql`UPDATE invoice_line_devices SET device_id = NULL WHERE device_id = ${deviceId}::uuid`,
        );
```

Add the matching assertion to `apps/api/src/routes/devices/moveOrg.test.ts` beside the existing `ai_agent_runs` statement assertion:

```ts
  it('#3205 W07: severs the billing-evidence device pointer', () => {
    const stmts = executedStatements();   // the file's existing helper
    expect(stmts.some((s) => /UPDATE invoice_line_devices SET device_id = NULL/.test(s))).toBe(true);
  });
```

- [ ] **Step 11: Export/erasure round-trip seed**

`apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`: extend the existing invoice seed so the org under test has one `invoice_line_devices` row and one `contract_billing_period_outcomes` row, then assert:

```ts
    // #3205 W07: evidence is ordinary exported customer data...
    const evidence = archiveTable(archive, 'invoice_line_devices');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ hostname: 'roundtrip-01', device_role: 'server', counted_as: 'included' });
    // ...but the outcome row's jsonb digests are DELIBERATELY absent (decision 3).
    const outcome = archiveTable(archive, 'contract_billing_period_outcomes');
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ uncovered_total: 2, flagged_total: 0, billed_overage_total: 0, snapshot_device_total: 3 });
    expect(outcome[0]).not.toHaveProperty('uncovered_by_role');
    expect(outcome[0]).not.toHaveProperty('overages');
```

and that erasure of that org removes every row from both tables (the suite's existing post-erasure count sweep covers this once the tables are in `CORE_ORG_CASCADE_DELETE_ORDER` — verify the sweep is table-driven; if it is a hand-written list, add both names).

- [ ] **Step 12: Run everything this task touches**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/moveOrg.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/billingEvidenceRls.integration.test.ts \
  src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: all green. `rls-coverage` must be green with **zero** allowlist edits.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/services/orgMergeRegistry.ts apps/api/src/routes/devices/core.ts \
  apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts \
  apps/api/src/routes/devices/moveOrg.coverage.test.ts \
  apps/api/src/__tests__/integration/billingEvidenceRls.integration.test.ts \
  apps/api/src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts \
  apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "feat(billing): register billing evidence in every cascade/export/merge/device list + move-org detach (#3205 W07)"
```

---

### Task 3: `hostname` on the snapshot, `matchingDevicesForLine`, canonical ordering

**Files:**
- Modify: `apps/api/src/services/contractQuantities.ts` (`DeviceSnapshotRow`, `snapshotContractDevices`, W06's `billableDeviceById`)
- Modify: `apps/api/src/services/contractCoverage.ts` (+ `contractCoverage.test.ts`)
- Modify: any fixture that builds a `DeviceSnapshotRow` literal

**Interfaces:**

```ts
// contractQuantities.ts
export interface DeviceSnapshotRow { id: string; hostname: string; role: string; siteId: string | null }

// contractCoverage.ts
/** Every billable device this line bills, in snapshot order. The plural form of
 *  coverageMatch over the SAME matchReason core — W06's hand-off. */
export function matchingDevicesForLine(snapshot: OrgDeviceSnapshot, line: CoverageLine): DeviceSnapshotRow[];
/** UTF-16 code-unit comparison of hostname, then id. NEVER localeCompare. */
export function compareEvidenceDevices(a: DeviceSnapshotRow, b: DeviceSnapshotRow): number;
export function orderDevicesForEvidence(rows: readonly DeviceSnapshotRow[]): DeviceSnapshotRow[];
// quantityFor becomes matchingDevicesForLine(...).length — same signature, same result.
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/contractCoverage.test.ts` (the W02 fixtures and W06's `coverageMatch` describes stay untouched above):

```ts
// #3205 W07: matchingDevicesForLine is the ONLY device source generation uses.
// quantityFor === matchingDevicesForLine(...).length by construction, which is
// what forbids an invoice saying "12" beside eleven evidence rows.
describe('matchingDevicesForLine (#3205 W07)', () => {
  it('returns exactly the rows coverageMatch calls covered, for every fixture line', () => {
    for (const l of ALL_FIXTURE_LINES) {           // the shared W02/W06 line fixtures
      const expected = snapshot.devices.filter((r) => coverageMatch(l, r, snapshot) !== null);
      expect(matchingDevicesForLine(snapshot, l)).toEqual(expected);
    }
  });

  it('PARITY: quantityFor is exactly its length', () => {
    for (const l of ALL_FIXTURE_LINES) {
      expect(quantityFor(snapshot, l)).toBe(matchingDevicesForLine(snapshot, l).length);
    }
  });

  it('throws for a non-device line type, like quantityFor', () => {
    expect(() => matchingDevicesForLine(snapshot, line({ lineType: 'flat' })))
      .toThrow(/not a device-counted line type/);
    expect(() => matchingDevicesForLine(snapshot, line({ lineType: 'per_seat' })))
      .toThrow(/not a device-counted line type/);
  });

  it('carries hostname through from the snapshot row', () => {
    const rows = matchingDevicesForLine(snapshot, line({ lineType: 'per_device' }));
    expect(rows.every((r) => typeof r.hostname === 'string' && r.hostname.length > 0)).toBe(true);
  });
});

// Decision 6. localeCompare is locale- and ICU-version-dependent ('a' vs 'B'
// flips with collation, and Node's ICU data changes between releases), so it
// cannot underwrite a reproducibility promise. '<'/'>' on strings is a fixed
// code-unit comparison with no environment input. These cases are chosen so a
// switch to localeCompare FAILS here.
describe('orderDevicesForEvidence (#3205 W07)', () => {
  const row = (id: string, hostname: string): DeviceSnapshotRow => ({ id, hostname, role: 'server', siteId: null });

  it('orders uppercase before lowercase (code units, not collation)', () => {
    const out = orderDevicesForEvidence([row('i2', 'alpha'), row('i1', 'Alpha')]);
    expect(out.map((r) => r.hostname)).toEqual(['Alpha', 'alpha']);
  });

  it('breaks a duplicate-hostname tie on device id', () => {
    const out = orderDevicesForEvidence([row('bbb', 'dup'), row('aaa', 'dup')]);
    expect(out.map((r) => r.id)).toEqual(['aaa', 'bbb']);
  });

  it('orders non-ASCII hostnames by code unit, where collation would disagree', () => {
    const out = orderDevicesForEvidence([
      row('n3', 'zürich-01'), row('n1', 'ZÜRICH-02'), row('n2', '東京-01'), row('n0', 'zoo-01'),
    ]);
    // 'Z'(0x5A) < 'z'(0x7A); 'zoo' < 'zürich' because 'o'(0x6F) < 'ü'(0xFC);
    // CJK (0x6771) sorts after every Latin-1 code unit here.
    expect(out.map((r) => r.hostname)).toEqual(['ZÜRICH-02', 'zoo-01', 'zürich-01', '東京-01']);
  });

  it('does not mutate its input', () => {
    const input = [row('b', 'b-host'), row('a', 'a-host')];
    const copy = [...input];
    orderDevicesForEvidence(input);
    expect(input).toEqual(copy);
  });

  it('is a total order — sorting twice is idempotent', () => {
    const input = [row('c', 'dup'), row('a', 'dup'), row('b', 'Alpha')];
    const once = orderDevicesForEvidence(input);
    expect(orderDevicesForEvidence(once)).toEqual(once);
  });
});
```

Add the imports (`matchingDevicesForLine`, `orderDevicesForEvidence`, `type DeviceSnapshotRow`) to the file's existing import line, and add `hostname` to every `DeviceSnapshotRow` literal already in the file (`{ id: 'srv1', hostname: 'srv1', role: 'server', siteId: A }` — using the id as the hostname keeps the existing expectations readable, except where an ordering test needs a specific name).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts`
Expected: FAIL — `matchingDevicesForLine is not a function`, `orderDevicesForEvidence is not a function`, plus type errors on the `hostname` property.

- [ ] **Step 3: Implement `contractQuantities.ts`**

```ts
export interface DeviceSnapshotRow {
  id: string;
  /** Stamped onto billing evidence at generation (#3205 W07) so a past invoice
   *  stays legible after the device is deleted or moved to another org.
   *  devices.hostname is varchar(255) NOT NULL, so this never needs a null branch. */
  hostname: string;
  role: string;
  siteId: string | null;
}

export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]> {
  return db
    .select({ id: devices.id, hostname: devices.hostname, role: devices.deviceRole, siteId: devices.siteId })
    .from(devices)
    .where(and(...billableDeviceConds(orgId)));
}
```

Add `hostname: devices.hostname` to W06's `billableDeviceById` select as well — same column list, so the one-device coverage path gets it for free and tsc will demand it anyway.

- [ ] **Step 4: Implement `contractCoverage.ts`**

Replace `quantityFor` and add the two new exports (W06's private `matchReason` is the shared core — do not duplicate it):

```ts
/**
 * Every billable device this line bills. The plural transpose of W06's
 * `coverageMatch`, over the SAME `matchReason` core — `contractLinesCoveringDevice`
 * is one device × many lines, this is one line × many devices, and neither
 * re-implements matching.
 *
 * Generation calls this ONCE per device line and uses the one array for both the
 * quantity and the evidence rows, so the invoice can never say "12" beside
 * eleven rows. Snapshot order; call `orderDevicesForEvidence` for the canonical
 * order the evidence writer needs.
 */
export function matchingDevicesForLine(snapshot: OrgDeviceSnapshot, line: CoverageLine): DeviceSnapshotRow[] {
  assertResolvable(line, snapshot);
  if (!isDeviceLine(line)) throw new Error(`matchingDevicesForLine: ${line.lineType} is not a device-counted line type`);
  return snapshot.devices.filter((row) => matchReason(line, row, snapshot) !== null);
}

/** Quantity for a device-counted line. Throws for any other type: the caller's
 *  switch is exhaustive and must not route flat/seat/manual here. */
export function quantityFor(snapshot: OrgDeviceSnapshot, line: CoverageLine): number {
  return matchingDevicesForLine(snapshot, line).length;
}

/**
 * Canonical evidence order: UTF-16 code-unit comparison of hostname, then id.
 *
 * NOT localeCompare (#3205 W07 decision 6): collation is locale- and
 * ICU-version-dependent ('a' vs 'B' flips, and Node's ICU data changes between
 * releases), so it cannot underwrite a reproducibility promise. '<'/'>' on
 * strings is a fixed code-unit comparison with no environment input.
 *
 * The id tiebreak is load-bearing: hostnames are NOT unique in a fleet, and this
 * order decides which devices fall in the allowance and which in the overage
 * tail.
 */
export function compareEvidenceDevices(a: DeviceSnapshotRow, b: DeviceSnapshotRow): number {
  if (a.hostname < b.hostname) return -1;
  if (a.hostname > b.hostname) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Non-mutating canonical sort. */
export function orderDevicesForEvidence(rows: readonly DeviceSnapshotRow[]): DeviceSnapshotRow[] {
  return [...rows].sort(compareEvidenceDevices);
}
```

- [ ] **Step 5: Fix every `DeviceSnapshotRow` fixture**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -F "hostname" | head -40
grep -rln "role: '" src --include='*.test.ts' | xargs grep -ln "siteId:" | head -20
```
Every literal that lacks `hostname` is a compile error. Give each a distinct, stable hostname (`hostname: '<id>'` is fine outside the ordering tests); do **not** reuse one hostname across rows in a fixture whose assertions depend on order.

- [ ] **Step 6: Run**

```bash
cd apps/api && npx vitest run src/services/contractCoverage.test.ts src/services/contractQuantities
npx tsc --noEmit -p tsconfig.json 2>&1 | head
```
Expected: coverage tests PASS; remaining tsc errors, if any, are confined to `contractService.ts` (Task 4).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/contractQuantities.ts apps/api/src/services/contractCoverage.ts \
  apps/api/src/services/contractCoverage.test.ts $(grep -rln "DeviceSnapshotRow\|hostname:" apps/api/src --include='*.test.ts')
git commit -m "feat(billing): hostname on the device snapshot + matchingDevicesForLine and canonical evidence order (#3205 W07)"
```

---

### Task 4: Generation — collect in the line loop, write after the claim

**Files:**
- Modify: `apps/api/src/services/contractService.ts` (+ `contractService.test.ts`)
- Modify: `apps/api/src/jobs/contractWorker.test.ts`
- Create: `apps/api/src/__tests__/integration/billingEvidence.integration.test.ts`

**Interfaces:**

```ts
// contractService.ts — module-local, not exported
interface PendingEvidence {
  invoiceLineId: string;
  deviceId: string;
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: InvoiceLineDeviceCountedAs;   // '@breeze/shared'
}
/** 500 rows/statement (decision 16): a 5,000-device line becomes ten statements
 *  rather than one enormous parameter list inside the billing transaction. */
const EVIDENCE_INSERT_CHUNK = 500;
function chunksOf<T>(items: readonly T[], size: number): T[][];
```

`GenerateResult` is unchanged — nothing new is returned. What it already carries (`priceBookGaps`, `uncoveredDevices`, W04's `overages`) is what gets persisted.

- [ ] **Step 1: Write the failing headline integration suite**

Create `apps/api/src/__tests__/integration/billingEvidence.integration.test.ts`. Seed inline per test (the harness truncates); `devices.site_id` is NOT NULL.

```ts
/**
 * #3205 W07 (#4656) — the headline suite. Every assertion is about what
 * generateDueInvoice PERSISTED, never about what it returned.
 *
 * The disposition invariants, in the terms W04 bills in, for a device line
 * matching M devices with allowance N:
 *   included rows = min(M, N);  tail rows = max(0, M - N);
 *   base invoice-line quantity = N under a fixed allowance, REGARDLESS of M.
 * `included + tail === M` is the only unconditional identity — evidence row
 * count != invoice quantity for every allowance line.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, contracts, contractLines, invoices, invoiceLines,
         invoiceLineDevices, contractBillingPeriods, contractBillingPeriodOutcomes } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { removeLine, updateLine } from '../../services/invoiceService';

/** The generation path is system-scoped; these two draft-line writers are not. */
const ACTOR = { userId: null, partnerId: null, accessibleOrgIds: null } as const;

interface Seeded { partnerId: string; orgId: string; siteId: string; contractId: string }

async function seedContract(hostnames: string[], line: {
  lineType: 'per_device' | 'per_device_role' | 'per_seat' | 'flat' | 'manual';
  includedQuantity?: string | null; overageMode?: 'bill' | 'flag' | null; overageUnitPrice?: string | null;
  deviceRoles?: string[] | null; manualQuantity?: string | null;
}): Promise<Seeded> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EV ${sfx}`, slug: `ev-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: `EO ${sfx}`, slug: `eo-${sfx}` })
      .returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `ES-${sfx}` }).returning({ id: sites.id });
    if (hostnames.length) {
      await db.insert(devices).values(hostnames.map((h, i) => ({
        orgId: o!.id, siteId: s!.id, agentId: `agent-${sfx}-${i}`, hostname: h,
        status: 'online' as const, deviceRole: 'server', osType: 'linux', osVersion: '22.04',
      })));
    }
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: `C ${sfx}`, status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: line.lineType, description: 'Endpoints',
      unitPrice: '10.00', taxable: false, sortOrder: 0,
      includedQuantity: line.includedQuantity ?? null,
      overageMode: line.overageMode ?? null,
      overageUnitPrice: line.overageUnitPrice ?? null,
      deviceRoles: line.deviceRoles ?? null,
      manualQuantity: line.manualQuantity ?? null,
    });
    return { partnerId: p!.id, orgId: o!.id, siteId: s!.id, contractId: c!.id };
  });
}

const generate = (contractId: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(() =>
    generateDueInvoice(contractId, new Date('2026-07-01T12:00:00Z'))));

async function evidenceFor(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      lineId: invoiceLineDevices.invoiceLineId, hostname: invoiceLineDevices.hostname,
      countedAs: invoiceLineDevices.countedAs, deviceId: invoiceLineDevices.deviceId,
      siteId: invoiceLineDevices.siteId, deviceRole: invoiceLineDevices.deviceRole,
      orgId: invoiceLineDevices.orgId, invoiceId: invoiceLineDevices.invoiceId,
    })
    .from(invoiceLineDevices)
    .where(eq(invoiceLineDevices.invoiceId, invoiceId))
    .orderBy(invoiceLineDevices.hostname, invoiceLineDevices.id));
}

async function linesFor(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: invoiceLines.id, description: invoiceLines.description, quantity: invoiceLines.quantity })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
}

const hosts = (n: number, prefix = 'host') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('billing evidence at generation (real DB) #3205 W07', () => {
  // ---------------------------------------------------------------- matrix
  runDb('no allowance, M=12 -> 12 included on the base line, 0 tail, quantity 12.00', async () => {
    const f = await seedContract(hosts(12), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    expect(res.generated).toBe(true);
    const [base, ...rest] = await linesFor(res.invoiceId!);
    expect(rest).toEqual([]);                       // no overage line
    expect(base!.quantity).toBe('12.00');
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev).toHaveLength(12);
    expect(ev.every((r) => r.countedAs === 'included' && r.lineId === base!.id)).toBe(true);
    // "never 12 beside eleven rows"
    expect(Number(base!.quantity)).toBe(ev.length);
  });

  runDb('M=3, N=25, bill -> 3 included, 0 tail, but quantity is 25.00 (row count != quantity)', async () => {
    const f = await seedContract(hosts(3), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
    const res = await generate(f.contractId);
    const lines = await linesFor(res.invoiceId!);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('25.00');
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev).toHaveLength(3);
    expect(ev.every((r) => r.countedAs === 'included')).toBe(true);
  });

  runDb('M=25, N=25, either mode -> 25 included, 0 tail, quantity 25.00, no overage line', async () => {
    for (const mode of ['bill', 'flag'] as const) {
      const f = await seedContract(hosts(25), {
        lineType: 'per_device', includedQuantity: '25', overageMode: mode, overageUnitPrice: '12.00',
      });
      const res = await generate(f.contractId);
      const lines = await linesFor(res.invoiceId!);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.quantity).toBe('25.00');
      const ev = await evidenceFor(res.invoiceId!);
      expect(ev).toHaveLength(25);
      expect(ev.filter((r) => r.countedAs === 'included')).toHaveLength(25);
    }
  });

  runDb('M=30, N=25, bill -> 25 included on the base line + 5 overage on the OVERAGE line', async () => {
    const f = await seedContract(hosts(30), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
    const res = await generate(f.contractId);
    const lines = await linesFor(res.invoiceId!);
    expect(lines).toHaveLength(2);
    const [base, overage] = lines;
    expect(base!.quantity).toBe('25.00');
    expect(overage!.quantity).toBe('5.00');
    const ev = await evidenceFor(res.invoiceId!);
    const included = ev.filter((r) => r.countedAs === 'included');
    const tail = ev.filter((r) => r.countedAs === 'overage');
    expect(included).toHaveLength(25);
    expect(tail).toHaveLength(5);
    expect(included.every((r) => r.lineId === base!.id)).toBe(true);
    expect(tail.every((r) => r.lineId === overage!.id)).toBe(true);
    expect(included.length + tail.length).toBe(30);          // included + tail === M
    // The tail is the LAST five by (hostname, id).
    expect(tail.map((r) => r.hostname)).toEqual(['host-026', 'host-027', 'host-028', 'host-029', 'host-030']);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.billedOverageTotal).toBe(5);
    expect(outcome!.flaggedTotal).toBe(0);
  });

  runDb('M=30, N=25, flag -> 25 included + 5 flagged, BOTH on the base line, no overage invoice line', async () => {
    const f = await seedContract(hosts(30), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'flag', overageUnitPrice: null,
    });
    const res = await generate(f.contractId);
    const lines = await linesFor(res.invoiceId!);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('25.00');
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev.filter((r) => r.countedAs === 'included')).toHaveLength(25);
    const flagged = ev.filter((r) => r.countedAs === 'flagged');
    expect(flagged).toHaveLength(5);
    expect(flagged.every((r) => r.lineId === lines[0]!.id)).toBe(true);
    expect(ev).toHaveLength(30);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.flaggedTotal).toBe(5);
    expect(outcome!.billedOverageTotal).toBe(0);
  });

  // ---------------------------------------------------------------- ordering
  runDb('canonical order is code-unit hostname then device id — duplicates, mixed case, non-ASCII', async () => {
    // 4 devices, allowance 2, flag mode: the split is decided entirely by the order.
    const f = await seedContract(['dup', 'dup', 'Alpha', 'zürich'], {
      lineType: 'per_device', includedQuantity: '2', overageMode: 'flag',
    });
    const res = await generate(f.contractId);
    const ev = await evidenceFor(res.invoiceId!);
    // Code units: 'Alpha'(0x41) < 'dup'(0x64) < 'zürich'(0x7A). localeCompare
    // would put 'Alpha' and 'dup' the other way round under some collations, so
    // this assertion is what pins the comparator.
    expect(ev.map((r) => r.hostname)).toEqual(['Alpha', 'dup', 'dup', 'zürich']);
    expect(ev.map((r) => r.countedAs)).toEqual(['included', 'included', 'flagged', 'flagged']);
    // The two 'dup' rows split on device id — the tiebreak is load-bearing.
    const dups = ev.filter((r) => r.hostname === 'dup');
    expect(dups[0]!.deviceId! < dups[1]!.deviceId!).toBe(true);
  });

  runDb('determinism is an assignment PROJECTION: two runs over the same fleet agree on device -> counted_as', async () => {
    const f = await seedContract(hosts(30), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
    const first = await generate(f.contractId);
    // A second contract over the SAME org/snapshot.
    const second = await withSystemDbAccessContext(async () => {
      const [c2] = await db.insert(contracts).values({
        partnerId: f.partnerId, orgId: f.orgId, name: 'C2', status: 'active', intervalMonths: 1,
        startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
      }).returning({ id: contracts.id });
      await db.insert(contractLines).values({
        contractId: c2!.id, orgId: f.orgId, lineType: 'per_device', description: 'Endpoints',
        unitPrice: '10.00', taxable: false, sortOrder: 0,
        includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
      });
      return c2!.id;
    });
    const other = await generate(second);
    const proj = async (invoiceId: string) =>
      Object.fromEntries((await evidenceFor(invoiceId)).map((r) => [r.deviceId!, r.countedAs]));
    // Row `id` and `created_at` are fresh on every insert, so "byte-identical
    // rows" would be false as written. The PROJECTION is the promise.
    expect(await proj(other.invoiceId!)).toEqual(await proj(first.invoiceId!));
  });

  // ---------------------------------------------------------------- non-device lines
  runDb('per_seat, flat and manual lines write ZERO evidence rows and still get an outcome row', async () => {
    for (const spec of [
      { lineType: 'per_seat' as const, includedQuantity: '5', overageMode: 'flag' as const },
      { lineType: 'flat' as const },
      { lineType: 'manual' as const, manualQuantity: '3' },
    ]) {
      const f = await seedContract(hosts(4), spec);
      const res = await generate(f.contractId);
      expect(await evidenceFor(res.invoiceId!)).toEqual([]);
      const outcomes = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes)
        .where(eq(contractBillingPeriodOutcomes.invoiceId, res.invoiceId!)));
      expect(outcomes).toHaveLength(1);
    }
  });

  runDb('an OVER per_seat line contributes to flagged_total and overages with NO device rows (decision 7)', async () => {
    // Seats are users, not devices: seat evidence is out of scope, but the seat
    // line's silence still has to be reported on the period outcome.
    const f = await seedContractWithSeats(8, { lineType: 'per_seat', includedQuantity: '5', overageMode: 'flag' });
    const res = await generate(f.contractId);
    expect(await evidenceFor(res.invoiceId!)).toEqual([]);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.flaggedTotal).toBe(3);
    expect(outcome!.overages).toMatchObject([{ counted: 8, included: 5, overage: 3, mode: 'flag' }]);
    // No device-counted line, so no snapshot was evaluated.
    expect(outcome!.snapshotDeviceTotal).toBe(0);
  });

  runDb('a flat-only contract records snapshot_device_total = 0 AND evidence_version = 1', async () => {
    const f = await seedContract(hosts(7), { lineType: 'flat' });
    const res = await generate(f.contractId);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    // 0 means "no snapshot was evaluated", NOT "the org owns zero devices" —
    // the org above has seven. evidence_version = 1 is what says "measured
    // nothing" rather than "not recorded".
    expect(outcome!.snapshotDeviceTotal).toBe(0);
    expect(outcome!.uncoveredTotal).toBe(0);
    expect(outcome!.uncoveredByRole).toEqual({});
    expect(outcome!.overages).toEqual([]);
    const [inv] = await withSystemDbAccessContext(() => db.select({ v: invoices.evidenceVersion })
      .from(invoices).where(eq(invoices.id, res.invoiceId!)));
    expect(inv!.v).toBe(1);
  });

  runDb('uncovered totals equal uncoveredByRole for the same fixture, and snapshot_device_total is the snapshot length', async () => {
    // 5 devices; the line only bills the 'server' role, and 2 devices are printers.
    const f = await seedContract([], { lineType: 'per_device_role', deviceRoles: ['server'] });
    await withSystemDbAccessContext(async () => {
      await db.insert(devices).values([
        ...['s1', 's2', 's3'].map((h, i) => ({ orgId: f.orgId, siteId: f.siteId, agentId: `a-s-${i}`, hostname: h,
          status: 'online' as const, deviceRole: 'server', osType: 'linux', osVersion: '22.04' })),
        ...['p1', 'p2'].map((h, i) => ({ orgId: f.orgId, siteId: f.siteId, agentId: `a-p-${i}`, hostname: h,
          status: 'online' as const, deviceRole: 'printer', osType: 'linux', osVersion: '22.04' })),
      ]);
    });
    const res = await generate(f.contractId);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.snapshotDeviceTotal).toBe(5);
    expect(outcome!.uncoveredTotal).toBe(2);
    expect(outcome!.uncoveredByRole).toEqual({ printer: 2 });
    expect(res.uncoveredDevices).toEqual({ total: 2, byRole: { printer: 2 } });
    expect(await evidenceFor(res.invoiceId!)).toHaveLength(3);
  });

  // ---------------------------------------------------------------- atomicity
  runDb('a LOST claim race leaves zero evidence, zero outcomes, and no draft', async () => {
    const f = await seedContract(hosts(5), { lineType: 'per_device' });
    // Pre-insert the period row from OUTSIDE the generation transaction so the
    // claim's ON CONFLICT DO NOTHING loses.
    await withSystemDbAccessContext(() => db.insert(contractBillingPeriods).values({
      contractId: f.contractId, orgId: f.orgId, periodStart: '2026-07-01', periodEnd: '2026-07-31',
    }));
    const res = await generate(f.contractId);
    expect(res.generated).toBe(false);
    expect(res.skipped).toBe('already_billed');
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0 }]);
  });

  runDb('a throw AFTER the lines are written leaves no invoice, no claim, no evidence', async () => {
    const f = await seedContract(hosts(5), { lineType: 'per_device' });
    // Fail the OUTCOME insert specifically — the last write in the sequence, so
    // by the time it throws the draft, the lines, the claim and every evidence
    // chunk are already written. If any of them survives, the transaction
    // boundary is wrong.
    const originalInsert = db.insert.bind(db);
    const spy = vi.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      if (table === contractBillingPeriodOutcomes) throw new Error('injected outcome failure');
      return originalInsert(table as never);
    }) as never);
    await expect(generate(f.contractId)).rejects.toThrow(/injected outcome failure/);
    spy.mockRestore();
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv,
             (SELECT count(*) FROM contract_billing_periods)::int AS per
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0, per: 0 }]);
  });

  runDb('1,200 rows land across chunked statements in one transaction', async () => {
    const f = await seedContract(hosts(1200), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev).toHaveLength(1200);
    expect(new Set(ev.map((r) => r.deviceId)).size).toBe(1200);
    const [base] = await linesFor(res.invoiceId!);
    expect(base!.quantity).toBe('1200.00');
  }, 60_000);

  runDb('a throw injected on the THIRD chunk leaves zero evidence, no claim and no invoice', async () => {
    // Chunking must not weaken atomicity: all chunks are in the same
    // caller-supplied transaction, so a failure part-way through must take the
    // earlier chunks with it. Spy the insert and fail the third call.
    const f = await seedContract(hosts(1200), { lineType: 'per_device' });
    let evidenceInserts = 0;
    const originalInsert = db.insert.bind(db);
    const spy = vi.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      // Count ONLY evidence inserts; let every other insert through untouched.
      if (table === invoiceLineDevices && ++evidenceInserts === 3) throw new Error('injected chunk failure');
      return originalInsert(table as never);
    }) as never);
    await expect(generate(f.contractId)).rejects.toThrow(/injected chunk failure/);
    spy.mockRestore();
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv,
             (SELECT count(*) FROM contract_billing_periods)::int AS per
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0, per: 0 }]);
  }, 60_000);

  runDb('a GROUP_EVALUATION_FAILED throw leaves no invoice, no claim and no evidence', async () => {
    // The W02 failure mode, re-asserted with evidence in the picture: the group
    // resolution runs BEFORE createManualInvoice, so nothing at all is written.
    const f = await seedContractWithUnevaluableGroupLine();   // malformed filter_conditions
    await expect(generate(f.contractId)).rejects.toMatchObject({ code: 'GROUP_EVALUATION_FAILED' });
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv,
             (SELECT count(*) FROM contract_billing_periods)::int AS per
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0, per: 0 }]);
  });

  // ---------------------------------------------------------------- draft-line rules (decision 9)
  runDb('deleting a draft invoice LINE deletes its evidence (FK cascade)', async () => {
    const f = await seedContract(hosts(4), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    const [base] = await linesFor(res.invoiceId!);
    await withSystemDbAccessContext(() => removeLine(res.invoiceId!, base!.id, ACTOR));
    expect(await evidenceFor(res.invoiceId!)).toEqual([]);
  });

  runDb('editing a draft line QUANTITY leaves every evidence row and the period outcome untouched', async () => {
    // Evidence records what the GENERATION counted. An operator who hand-edits
    // the quantity afterwards is overriding the bill, not rewriting history —
    // and the outcome row stays the record of what the run actually measured.
    const f = await seedContract(hosts(4), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    const [base] = await linesFor(res.invoiceId!);
    const before = await evidenceFor(res.invoiceId!);
    const [outcomeBefore] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    await withSystemDbAccessContext(() => updateLine(res.invoiceId!, base!.id, { quantity: '2.00' }, ACTOR));
    expect(await evidenceFor(res.invoiceId!)).toEqual(before);
    const [outcomeAfter] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcomeAfter).toEqual(outcomeBefore);
  });
});
```

> The chunk-failure spy is the one place a mock is unavoidable in this suite — there is no fixture that makes the third of ten inserts fail on its own. Keep it narrow (only `invoiceLineDevices` inserts) and restore it in the same test; if the repo's `db` proxy resists `vi.spyOn`, inject the failure with a `BEFORE INSERT` trigger on `invoice_line_devices` that raises once past a row-count threshold, and drop the trigger in a `finally`.

- [ ] **Step 2: Run to verify it fails**

```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingEvidence.integration.test.ts
```
Expected: FAIL — every evidence assertion returns `[]`; every outcome query returns no rows. The two atomicity cases and the `per_seat`/`flat`/`manual` "zero rows" case pass vacuously for now — that is expected and they become real once the writer exists.

- [ ] **Step 3: Implement — imports and helpers**

`apps/api/src/services/contractService.ts`. Extend the schema import and add the module-local helpers near the other private helpers:

```ts
import {
  contracts, contractLines, contractBillingPeriods, contractBillingPeriodOutcomes,
  invoices, invoiceLineDevices,
} from '../db/schema';
import { matchingDevicesForLine, orderDevicesForEvidence, /* …existing… */ } from './contractCoverage';
import type { InvoiceLineDeviceCountedAs } from '@breeze/shared';
```

```ts
/**
 * #3205 W07: one device's row of billing evidence, collected during the line
 * loop and written only after the period claim succeeds (the period id does not
 * exist before then, and a lost claim deletes the draft anyway).
 */
interface PendingEvidence {
  invoiceLineId: string;
  deviceId: string;
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: InvoiceLineDeviceCountedAs;
}

/** 500 rows/statement (#3205 W07 decision 16). One statement for a 5,000-device
 *  line would build a single enormous parameter list inside the billing
 *  transaction. All chunks are in the SAME transaction, so the all-or-nothing
 *  property is unchanged. */
const EVIDENCE_INSERT_CHUNK = 500;

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

- [ ] **Step 4: Implement — collection inside W04's line loop**

Declare `const pendingEvidence: PendingEvidence[] = [];` beside W04's `const overages: OverageSummary[] = [];`.

In the loop, hold the ordered device array the switch produced:

```ts
  for (const l of lines) {
    let quantity: string;
    // The ONE device source for this line. `quantity` IS its length, so there is
    // no second walk to disagree with — which is why no runtime cross-check is
    // written here (a `matched.length !== Number(quantity)` guard would compare a
    // value to its own stringification and assert nothing). The real guarantee is
    // W06's quantityFor === matchingDevicesForLine(...).length, pinned by the
    // parity test in contractCoverage.test.ts.
    let ordered: DeviceSnapshotRow[] | null = null;
    switch (l.lineType) {
      case 'flat': quantity = '1'; break;
      case 'manual': quantity = l.manualQuantity ?? '0'; break;
      case 'per_device':
      case 'per_device_role':
      case 'per_device_group':
        assertRoleLineHasRoles(l);
        ordered = orderDevicesForEvidence(matchingDevicesForLine(snapshot, l));
        quantity = String(ordered.length);          // = counted, pre-allowance
        break;
      case 'per_seat': quantity = String(await countContractSeats(c.orgId)); break;
      default: {
        const _exhaustive: never = l.lineType;
        throw new ContractServiceError(`Unknown contract line type: ${String(l.lineType)}`, 500, 'INVALID_STATE');
      }
    }
```

Immediately after W04's `overages.push({...})` block, still inside the loop:

```ts
    // Evidence for THIS line, from the one array the quantity came from.
    // cut = min(included, M): with a fixed allowance above the count (M < N) the
    // base line bills N while only M devices exist, so every row is `included`
    // and there is no tail. Only rows past the allowance are the tail, and they
    // attach to the OVERAGE line under 'bill' mode and to the BASE line under
    // 'flag' mode (the flagged tail is the disputable set a human adjudicates).
    if (ordered) {
      const cut = r.included === null ? ordered.length : Math.min(r.included, ordered.length);
      for (const [i, row] of ordered.entries()) {
        const countedAs: InvoiceLineDeviceCountedAs =
          i < cut ? 'included' : r.overageMode === 'bill' ? 'overage' : 'flagged';
        if (countedAs === 'overage' && overageInvoiceLineId === null) {
          // Unreachable: countedAs 'overage' requires overageMode 'bill' AND
          // i >= cut, i.e. overage > 0, which is exactly billsOverage(r). Fail
          // loudly rather than filing evidence under a null line id.
          throw new ContractServiceError(
            `Overage evidence for contract line ${l.id} has no overage invoice line`, 500, 'INVALID_STATE');
        }
        pendingEvidence.push({
          invoiceLineId: countedAs === 'overage' ? overageInvoiceLineId : baseLine.id,
          deviceId: row.id, hostname: row.hostname, deviceRole: row.role, siteId: row.siteId, countedAs,
        });
      }
    }
  }
```

> This is the **W04 predecessor contract** in action: `overageInvoiceLineId` must already be captured from the second `addContractLine`'s returned `line`. If W04 landed without it, add `const { line: overageInvoiceLine } = await addContractLine(...)` / `overageInvoiceLineId = overageInvoiceLine.id;` before continuing — the bill-mode branch is unimplementable otherwise.

- [ ] **Step 5: Implement — the write, after the claim and before the pointer advance**

Between the `if (claimed.length === 0) { … }` early return and the "4. Advance the pointer" block:

```ts
  // 3b. Billing evidence (#3205 W07). The period id does not exist until the
  //     claim above succeeds, and a lost claim deletes the draft — so nothing is
  //     written before this point. Everything here is in the SAME caller-supplied
  //     transaction as the draft, the lines and the claim: a throw anywhere rolls
  //     all four back together.
  const periodId = claimed[0]!.id;
  for (const chunk of chunksOf(pendingEvidence, EVIDENCE_INSERT_CHUNK)) {
    await db.insert(invoiceLineDevices).values(
      chunk.map((p) => ({ ...p, invoiceId: inv.id, orgId: c.orgId })),
    );
  }
  // Invoice-level `recorded` flag. 1 = "W07 wrote evidence for this invoice",
  // even when that evidence is zero rows (a flat-only contract measured nothing,
  // which is different from a pre-W07 invoice that recorded nothing).
  await db.update(invoices).set({ evidenceVersion: 1 }).where(eq(invoices.id, inv.id));

  // Moved here from after the pointer advance: the outcome row needs the same
  // value the caller gets back, computed once.
  const uncoveredDevices = hasDeviceLine ? uncoveredByRole(snapshot, resolvableLines(lines, snapshot)) : null;
  await db.insert(contractBillingPeriodOutcomes).values({
    contractBillingPeriodId: periodId,
    orgId: c.orgId,
    contractId,
    invoiceId: inv.id,
    // 0 here means "no snapshot was evaluated", not "the org owns zero devices":
    // generation only builds a snapshot when a device-counted line exists.
    snapshotDeviceTotal: hasDeviceLine ? snapshot.devices.length : 0,
    uncoveredTotal: uncoveredDevices?.total ?? 0,
    uncoveredByRole: uncoveredDevices?.byRole ?? {},
    flaggedTotal: overages.filter((o) => o.mode === 'flag').reduce((n, o) => n + o.overage, 0),
    billedOverageTotal: overages.filter((o) => o.mode === 'bill').reduce((n, o) => n + o.overage, 0),
    overages,
  });
```

Delete the old `const uncoveredDevices = hasDeviceLine ? uncoveredByRole(...)` line further down (it is now computed above); the success `return` is otherwise unchanged, so no caller moves.

- [ ] **Step 6: Worker isolation test**

Append to `apps/api/src/jobs/contractWorker.test.ts`:

```ts
  it('#3205 W07: a contract whose evidence insert throws rolls that contract back and the sweep continues', async () => {
    // Two due contracts; the first throws inside generateDueInvoice.
    generateDueInvoiceMock
      .mockRejectedValueOnce(new Error('evidence insert failed'))
      .mockResolvedValueOnce({ generated: true, invoiceId: 'inv-2', autoIssue: false, actor: ACTOR, priceBookGaps: [], uncoveredDevices: null, overages: [] });
    const res = await runContractBillingSweep(new Date('2026-07-01T00:00:00Z'));
    expect(res).toMatchObject({ billed: 1, failed: 1 });
    expect(generateDueInvoiceMock).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 7: Run**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head
npx vitest run src/services/contractService.test.ts src/jobs/contractWorker.test.ts src/services/contractCoverage.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/billingEvidence.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractLineAllowance.integration.test.ts
```
Expected: tsc clean; all PASS. `contractLineAllowance.integration.test.ts` (W04's suite) is the regression check that adding evidence changed no invoice-line arithmetic.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts \
  apps/api/src/jobs/contractWorker.test.ts \
  apps/api/src/__tests__/integration/billingEvidence.integration.test.ts
git commit -m "feat(billing): write device evidence + a period outcome row at generation (#3205 W07)"
```

---

### Task 5: Reissue clones evidence through a pre-generated id map; both issuance writers stamp the appendix; the draft-guarded override

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts` (`voidInvoice` reissue clone, `issueInvoice`)
- Modify: `apps/api/src/services/quoteAcceptService.ts` (+ its test)
- Modify: `apps/api/src/lib/sendComposer.ts`
- Modify: `apps/api/src/routes/invoices/lifecycle.ts` (+ `lifecycle.test.ts`)
- Modify: `apps/api/src/__tests__/integration/invoiceService.reissue.integration.test.ts`

**Interfaces:**

```ts
// lib/sendComposer.ts — sendComposerSchema gains (still .strict()):
includeDeviceAppendix: z.boolean().optional();

// routes/invoices/lifecycle.ts — new module-local, applied BEFORE sendInvoiceEmail:
async function applyDeviceAppendixOverride(invoiceId: string, value: boolean): Promise<void>;
// 0 affected rows -> InvoiceServiceError('…', 409, 'INVOICE_ALREADY_ISSUED')
```

- [ ] **Step 1: Write the failing reissue tests**

Append to `apps/api/src/__tests__/integration/invoiceService.reissue.integration.test.ts`:

```ts
describe('reissue clones billing evidence (#3205 W07)', () => {
  runDb('every evidence row lands under the line that matches its hostnames — three parents, distinguishable sets', async () => {
    // Ordering-independence, asserted directly: the old clone built oldToNew
    // POSITIONALLY from RETURNING, which SQL does not promise to return in input
    // order. Three parents with disjoint hostname sets makes a reordered
    // RETURNING produce visibly wrong attribution instead of a silent one.
    const f = await seedInvoiceWithThreeEvidencedLines();   // 'a-*', 'b-*', 'c-*' per line
    const draft = await voidInvoice(f.invoiceId, { reason: 'test', reissue: true }, ACTOR);
    const rows = await withSystemDbAccessContext(() => db
      .select({ lineId: invoiceLineDevices.invoiceLineId, hostname: invoiceLineDevices.hostname,
                invoiceId: invoiceLineDevices.invoiceId, countedAs: invoiceLineDevices.countedAs })
      .from(invoiceLineDevices).where(eq(invoiceLineDevices.invoiceId, draft.invoice.id)));
    const newLines = await withSystemDbAccessContext(() => db
      .select({ id: invoiceLines.id, description: invoiceLines.description })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, draft.invoice.id)));
    const descOf = new Map(newLines.map((l) => [l.id, l.description]));
    for (const r of rows) {
      expect(descOf.get(r.lineId)).toBe(`Line ${r.hostname[0]!.toUpperCase()}`);
      expect(r.invoiceId).toBe(draft.invoice.id);
    }
    expect(rows).toHaveLength(9);
  });

  runDb('the voided invoice keeps its own evidence rows unchanged', async () => {
    const f = await seedInvoiceWithThreeEvidencedLines();
    const before = await evidenceRowsFor(f.invoiceId);
    await voidInvoice(f.invoiceId, { reason: 'test', reissue: true }, ACTOR);
    expect(await evidenceRowsFor(f.invoiceId)).toEqual(before);
  });

  runDb('a bundle CHILD line carrying evidence clones too, under the remapped child', async () => {
    const f = await seedInvoiceWithBundleChildEvidence();
    const draft = await voidInvoice(f.invoiceId, { reason: 'test', reissue: true }, ACTOR);
    const child = await withSystemDbAccessContext(() => db.select({ id: invoiceLines.id })
      .from(invoiceLines).where(and(eq(invoiceLines.invoiceId, draft.invoice.id), isNotNull(invoiceLines.parentLineId))));
    const rows = await evidenceRowsFor(draft.invoice.id);
    expect(rows.map((r) => r.invoiceLineId)).toEqual([child[0]!.id]);
  });

  runDb('a DETACHED source row clones as detached, hostname intact — never resurrected', async () => {
    const f = await seedInvoiceWithEvidence();
    await withSystemDbAccessContext(() => db.update(invoiceLineDevices)
      .set({ deviceId: null }).where(eq(invoiceLineDevices.invoiceId, f.invoiceId)));
    const draft = await voidInvoice(f.invoiceId, { reason: 'test', reissue: true }, ACTOR);
    const rows = await evidenceRowsFor(draft.invoice.id);
    expect(rows.every((r) => r.deviceId === null)).toBe(true);
    expect(rows.map((r) => r.hostname).sort()).toEqual(f.hostnames.slice().sort());
  });

  runDb('evidence_version is copied so the clone does not read as a pre-W07 invoice', async () => {
    const f = await seedInvoiceWithEvidence();      // evidence_version = 1
    const draft = await voidInvoice(f.invoiceId, { reason: 'test', reissue: true }, ACTOR);
    expect(draft.invoice.evidenceVersion).toBe(1);
  });

  runDb('void WITHOUT reissue clones nothing', async () => {
    const f = await seedInvoiceWithEvidence();
    await voidInvoice(f.invoiceId, { reason: 'test', reissue: false }, ACTOR);
    const all = await withSystemDbAccessContext(() => db.select().from(invoiceLineDevices));
    expect(all.map((r) => r.invoiceId)).toEqual(new Array(all.length).fill(f.invoiceId));
  });

  runDb('a child line whose parent is absent from the map THROWS rather than cloning as top-level', async () => {
    // Forge the condition the old `?? null` swallowed: a child whose parent row
    // is not among srcLines. The clone must fail loudly.
    const f = await seedInvoiceWithOrphanedChild();
    await expect(voidInvoice(f.invoiceId, { reason: 'test', reissue: true }, ACTOR))
      .rejects.toThrow(/Reissue clone: no mapping for line/);
  });
});
```

- [ ] **Step 2: Write the failing appendix-freeze tests**

Create `apps/api/src/__tests__/integration/invoicePdf.appendix.integration.test.ts` (its PDF-content assertions stay red until Task 7 — intended; this task turns the stamping ones green):

```ts
/**
 * #3205 W07 decision 14a — the appendix choice is FROZEN AT ISSUANCE and stable
 * across every sanctioned re-render. Not "byte-stable forever": the reset-link
 * path legitimately re-renders and rewrites the stored document
 * (invoicePdf.ts mints the public link into the bytes).
 */
describe('device appendix stamping (real DB) #3205 W07', () => {
  runDb('issueInvoice stamps the RESOLVED partner default onto invoices.device_appendix', async () => {
    for (const partnerDefault of [true, false]) {
      const f = await seedDraftInvoice({ invoiceDeviceAppendix: partnerDefault });
      await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
      const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
        .from(invoices).where(eq(invoices.id, f.invoiceId)));
      expect(inv!.a).toBe(partnerDefault);        // a concrete boolean, never NULL
    }
  });

  runDb('the quote-acceptance deposit invoice stamps it too (it never goes through issueInvoice)', async () => {
    const f = await seedAcceptableQuoteWithDeposit({ invoiceDeviceAppendix: true });
    const out = await withSystemDbAccessContext(() => acceptQuote(f.quoteId, f.acceptance));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix, s: invoices.status })
      .from(invoices).where(eq(invoices.id, out.invoiceId)));
    expect(inv!.s).toBe('sent');
    expect(inv!.a).toBe(true);
  });

  runDb('a per-invoice override set on the DRAFT wins over the partner default at issue', async () => {
    const f = await seedDraftInvoice({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => db.update(invoices).set({ deviceAppendix: true })
      .where(eq(invoices.id, f.invoiceId)));
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
      .from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(inv!.a).toBe(true);
  });

  runDb('flipping the partner default AFTER issue does not change the stamp', async () => {
    const f = await seedDraftInvoice({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
    await withSystemDbAccessContext(() => db.update(partners).set({ invoiceDeviceAppendix: true })
      .where(eq(partners.id, f.partnerId)));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
      .from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(inv!.a).toBe(false);
  });
});
```

- [ ] **Step 3: Write the failing route tests**

Append to `apps/api/src/routes/invoices/lifecycle.test.ts`:

```ts
describe('POST /:id/send — includeDeviceAppendix (#3205 W07)', () => {
  it('persists device_appendix on a DRAFT before issuing, then sends', async () => {
    const res = await app.request(`/${DRAFT_ID}/send`, {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ includeDeviceAppendix: true }),
    });
    expect(res.status).toBe(200);
    // The atomic update runs BEFORE sendInvoiceEmail (which issues, which
    // enqueues the async render) — the only ordering that survives the job.
    expect(callOrder).toEqual(['device_appendix_update', 'sendInvoiceEmail']);
  });

  it('409 INVOICE_ALREADY_ISSUED when the flag is present on a non-draft, and sends nothing', async () => {
    updateAffectedRows = 0;                       // the WHERE status='draft' matched nothing
    const res = await app.request(`/${SENT_ID}/send`, {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ includeDeviceAppendix: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INVOICE_ALREADY_ISSUED' });
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it('OMITTING the field on an issued invoice is unaffected', async () => {
    const res = await app.request(`/${SENT_ID}/send`, { method: 'POST', headers: JSON_AUTH, body: '{}' });
    expect(res.status).toBe(200);
  });

  it('400s on an unknown composer field (the .strict() guard still bites)', async () => {
    const res = await app.request(`/${DRAFT_ID}/send`, {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ includeDeviceAppendixx: true }),
    });
    expect(res.status).toBe(400);
  });

  it('composerOptions does NOT forward includeDeviceAppendix — the column is the channel', async () => {
    await app.request(`/${DRAFT_ID}/send`, {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ includeDeviceAppendix: true }),
    });
    expect(sendInvoiceEmailMock.mock.calls[0]![2]).not.toHaveProperty('includeDeviceAppendix');
  });
});
```

- [ ] **Step 4: Run all three to verify they fail**

```bash
cd apps/api && npx vitest run src/routes/invoices/lifecycle.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/invoiceService.reissue.integration.test.ts \
  src/__tests__/integration/invoicePdf.appendix.integration.test.ts
```
Expected: FAIL — no evidence on the clone, `device_appendix` is NULL after issue, and the composer rejects `includeDeviceAppendix` as an unknown key (400 where 200 is expected).

- [ ] **Step 5: Implement — pre-generated reissue ids + evidence clone**

`apps/api/src/services/invoiceService.ts`. Add `import { randomUUID } from 'node:crypto';` at the top and `invoiceLineDevices` to the schema import.

Replace the whole two-pass clone (from `const oldToNew = new Map<string, string>();` through the children insert) with:

```ts
    // Mint every new line id UP FRONT — parents AND children — so the map is
    // complete and order-independent before a single row is written.
    //
    // The old shape built the map POSITIONALLY from `.returning({ id })`
    // (`parents.forEach((l, i) => oldToNew.set(l.id, inserted[i]!.id))`), which
    // assumes RETURNING comes back in input order. Postgres does not promise
    // that. Today the consequence would be invisible (the map only re-pointed
    // parentLineId among sibling bundle rows); attach billing evidence to it and
    // a reordered RETURNING silently files device rows under the WRONG line.
    // Pre-generated uuids remove the assumption instead of adding a second one.
    // The children insert also never returned ids at all, so the map was
    // parents-only — evidence on a bundle child had nowhere to go.
    const oldToNew = new Map<string, string>(srcLines.map((l) => [l.id, randomUUID()]));
    const newId = (oldLineId: string): string => {
      const id = oldToNew.get(oldLineId);
      // The old child clone used `oldToNew.get(l.parentLineId!) ?? null`, which
      // silently PROMOTED a child to a top-level line when its parent was
      // missing. Throw instead.
      if (!id) throw new InvoiceServiceError(`Reissue clone: no mapping for line ${oldLineId}`, 500, 'INVALID_STATE');
      return id;
    };
    const parents = srcLines.filter((l) => l.parentLineId === null);
    if (parents.length) {
      await db.insert(invoiceLines).values(parents.map((l) => ({ id: newId(l.id), ...cloneValues(l, null) })));
    }
    const children = srcLines.filter((l) => l.parentLineId !== null);
    if (children.length) {
      await db.insert(invoiceLines).values(
        children.map((l) => ({ id: newId(l.id), ...cloneValues(l, newId(l.parentLineId!)) })),
      );
    }

    // #3205 W07: clone the evidence through the SAME map. Device pointers are
    // copied VERBATIM — device_id, hostname, device_role, site_id, counted_as —
    // so a row detached before the reissue (deleted or moved device) stays
    // detached on the clone rather than being resurrected.
    const srcEvidence = await db.select().from(invoiceLineDevices)
      .where(eq(invoiceLineDevices.invoiceId, invoiceId));
    for (const chunk of chunksOf(srcEvidence, 500)) {
      await db.insert(invoiceLineDevices).values(chunk.map((e) => ({
        invoiceLineId: newId(e.invoiceLineId), invoiceId: draft!.id, orgId: e.orgId,
        deviceId: e.deviceId, hostname: e.hostname, deviceRole: e.deviceRole,
        siteId: e.siteId, countedAs: e.countedAs,
      })));
    }
```

Add a local `chunksOf` to this file (same body as `contractService.ts`'s — two callers in two services is this repo's existing pattern; do not extract a shared util).

Add `evidenceVersion: inv.evidenceVersion` to the draft insert's `.values({ … })`, with:

```ts
      // #3205 W07 decision 15a: copied verbatim. document_locale is NOT copied
      // (it is an issue-time snapshot, restamped when this draft issues);
      // evidence_version IS, because the evidence itself is being cloned — a
      // clone must not read as a pre-W07 invoice.
```

- [ ] **Step 6: Implement — issuance stamping in BOTH writers**

`invoiceService.ts`, in `issueInvoice`'s `db.update(invoices).set({ … })` (the `partner` row is already read above, so this costs no extra query):

```ts
      // #3205 W07 decision 14a: resolve the appendix choice ONCE, here, and write
      // a concrete boolean. After this the column is a settled fact, not an
      // override-or-inherit tri-state, and loadInvoiceForRender reads ONLY this
      // column — so a later change to the partner default cannot alter what a
      // sanctioned re-render produces. Same two-writer rule document_locale
      // follows, for the same reason.
      deviceAppendix: inv.deviceAppendix ?? partner?.invoiceDeviceAppendix ?? false,
```

`quoteAcceptService.ts`, in the `issueFields` block beside `issueFields.documentLocale = renderLocale;`:

```ts
    // #3205 W07 decision 14a: this IS the invoice's issue moment (it never goes
    // through issueInvoice), so the appendix choice is frozen here too — the
    // same reason documentLocale is stamped on this line.
    issueFields.deviceAppendix = invoice!.deviceAppendix ?? partner?.invoiceDeviceAppendix ?? false;
```

If the `partner` row read in `quoteAcceptService` does not already select `invoiceDeviceAppendix`, add the column to that select — do **not** add a second query.

- [ ] **Step 7: Implement — the composer field and the draft-guarded override**

`apps/api/src/lib/sendComposer.ts`, inside the still-`.strict()` object:

```ts
  // #3205 W07: NOT a send option — the route persists it onto
  // invoices.device_appendix BEFORE issuing, because the PDF is rendered by an
  // async BullMQ job and deliverInvoiceEmail reuses a stored PDF. A flag passed
  // as a render argument would be dropped in the common path and silently lost
  // on any later re-render. composerOptions() deliberately does not forward it.
  includeDeviceAppendix: z.boolean().optional(),
```

`apps/api/src/routes/invoices/lifecycle.ts` — add the helper and call it from `/:id/send` only:

```ts
/**
 * #3205 W07 decision 14a: a DRAFT-GUARDED ATOMIC update, never a read-then-write.
 * A check-then-write would race a concurrent issue and mutate an issued invoice.
 * 0 affected rows means the invoice was not (or no longer) a draft -> 409, and
 * the send is REFUSED rather than proceeding while silently ignoring the flag.
 */
async function applyDeviceAppendixOverride(invoiceId: string, value: boolean): Promise<void> {
  const updated = await db.update(invoices)
    .set({ deviceAppendix: value, updatedAt: new Date() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'draft')))
    .returning({ id: invoices.id });
  if (updated.length === 0) {
    throw new InvoiceServiceError(
      'This invoice has already been issued — the billed-devices appendix can only be chosen while it is a draft',
      409, 'INVOICE_ALREADY_ISSUED',
    );
  }
}
```

```ts
invoiceLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const parsed = await parseComposerBody(c, sendComposerSchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const id = c.req.valid('param').id;
  try {
    // BEFORE sendInvoiceEmail (which issues, which enqueues the async render).
    if (parsed.data.includeDeviceAppendix !== undefined) {
      await applyDeviceAppendixOverride(id, parsed.data.includeDeviceAppendix);
    }
    return c.json({ data: await sendInvoiceEmail(id, invoiceActorFrom(c), composerOptions(parsed.data)) });
  } catch (err) { return handleServiceError(c, err); }
});
```

Leave `composerOptions` untouched. Do **not** add the field to `/:id/resend`: an already-issued invoice's appendix is frozen.

- [ ] **Step 8: Run**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head
npx vitest run src/routes/invoices/lifecycle.test.ts src/services/invoiceService.test.ts src/services/quoteAcceptService.test.ts src/lib/sendComposer.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/invoiceService.reissue.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/invoicePdf.appendix.integration.test.ts -t 'stamp'
```
Expected: the reissue suite and every stamping case PASS; the PDF-content cases stay red until Task 7.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/quoteAcceptService.ts \
  apps/api/src/lib/sendComposer.ts apps/api/src/routes/invoices/lifecycle.ts \
  apps/api/src/routes/invoices/lifecycle.test.ts \
  apps/api/src/__tests__/integration/invoiceService.reissue.integration.test.ts \
  apps/api/src/__tests__/integration/invoicePdf.appendix.integration.test.ts
git commit -m "feat(billing): clone evidence on reissue via pre-generated line ids; freeze the appendix choice at issuance (#3205 W07)"
```

---

### Task 6: Read service, two endpoints, and `deviceCount` on the invoice DETAIL read

**Files:**
- Create: `apps/api/src/services/billingEvidence.ts` (+ `billingEvidence.test.ts`)
- Create: `apps/api/src/routes/invoices/evidence.ts` (+ `evidence.test.ts`)
- Create: `apps/api/src/routes/contracts/periods.ts` (+ `periods.test.ts`)
- Modify: `apps/api/src/routes/invoices/index.ts`, `apps/api/src/routes/contracts/index.ts`
- Modify: `apps/api/src/services/invoiceService.ts` (`getInvoice` only) + `invoiceService.test.ts`

**Interfaces:**

```ts
// apps/api/src/services/billingEvidence.ts
export interface InvoiceLineDeviceRow {
  /** The EVIDENCE row's own id — the stable React key and cursor component.
   *  `deviceId ?? hostname` would collide across two detached rows sharing a
   *  hostname, which is exactly what a fleet with duplicate names produces. */
  id: string;
  deviceId: string | null;
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: InvoiceLineDeviceCountedAs;
}
export interface PeriodOutcome {
  contractBillingPeriodId: string;
  invoiceId: string | null;
  snapshotDeviceTotal: number;
  uncoveredTotal: number;
  flaggedTotal: number;
  billedOverageTotal: number;
  uncoveredByRole: Record<string, number>;
  overages: OverageSummary[];
  generatedAt: string;
}
export const INVOICE_LINE_DEVICES_MAX_LIMIT = 500;
export const INVOICE_LINE_DEVICES_DEFAULT_LIMIT = 100;

export async function listInvoiceLineDevices(
  invoiceId: string, lineId: string, opts: { limit: number; cursor?: string }, actor: InvoiceActor,
): Promise<{ recorded: boolean; total: number; devices: InvoiceLineDeviceRow[]; nextCursor: string | null }>;

export async function getPeriodOutcome(
  contractId: string, periodId: string, actor: ContractActor,
): Promise<{ recorded: boolean; outcome: PeriodOutcome | null }>;
```

Routes: `GET /invoices/:id/lines/:lineId/devices?limit&cursor` under `PERMISSIONS.INVOICES_READ`; `GET /contracts/:id/periods/:periodId/outcome` under `PERMISSIONS.CONTRACTS_READ`. Both `requireScope('partner', 'system')`; both 404 (never 403) on a cross-tenant id.

- [ ] **Step 1: Write the failing service unit tests**

Create `apps/api/src/services/billingEvidence.test.ts` (Drizzle mocks, following the existing `invoiceService.test.ts` mock shape in this repo):

```ts
/**
 * #3205 W07 — the read service. The two properties worth a unit test are the
 * ones a real DB would hide: `recorded` comes from the INVOICE, never a row
 * count; and same-parent ownership is a SQL predicate, not a post-fetch check.
 */
describe('listInvoiceLineDevices (#3205 W07)', () => {
  it('recorded follows invoices.evidence_version, NOT the row count', async () => {
    // A RECORDED invoice whose line counted zero devices is a real, reportable
    // outcome (a per_device_role line matching nothing) and must stay
    // distinguishable from a pre-W07 invoice.
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true); mockRows([]); mockTotal(0);
    await expect(listInvoiceLineDevices(INV, LINE, { limit: 100 }, ACTOR))
      .resolves.toEqual({ recorded: true, total: 0, devices: [], nextCursor: null });

    mockInvoice({ evidenceVersion: null }); mockLineBelongsToInvoice(true); mockRows([]); mockTotal(0);
    await expect(listInvoiceLineDevices(INV, LINE, { limit: 100 }, ACTOR))
      .resolves.toMatchObject({ recorded: false });
  });

  it('a line id belonging to a DIFFERENT invoice in the same org is 404, and never reaches the row fetch', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(false);
    await expect(listInvoiceLineDevices(INV, OTHER_INVOICES_LINE, { limit: 100 }, ACTOR))
      .rejects.toMatchObject({ status: 404, code: 'INVOICE_LINE_NOT_FOUND' });
    expect(evidenceRowSelectSpy).not.toHaveBeenCalled();
  });

  it('a cross-tenant invoiceId is 404, never 403', async () => {
    mockInvoiceNotVisible();
    await expect(listInvoiceLineDevices(OTHER_ORG_INV, LINE, { limit: 100 }, ACTOR))
      .rejects.toMatchObject({ status: 404 });
  });

  it('clamps limit to 500', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true); mockRows([]); mockTotal(0);
    await listInvoiceLineDevices(INV, LINE, { limit: 5000 }, ACTOR);
    expect(limitPassedToQuery()).toBe(501);          // 500 + the has-more probe
  });

  it('keyset pages on (hostname, id) and is stable across a boundary with duplicate hostnames', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true);
    mockRows([row('e1', 'dup'), row('e2', 'dup'), row('e3', 'dup')]); mockTotal(3);
    const page1 = await listInvoiceLineDevices(INV, LINE, { limit: 2 }, ACTOR);
    expect(page1.devices.map((d) => d.id)).toEqual(['e1', 'e2']);
    expect(page1.nextCursor).not.toBeNull();
    mockRows([row('e3', 'dup')]);
    const page2 = await listInvoiceLineDevices(INV, LINE, { limit: 2, cursor: page1.nextCursor! }, ACTOR);
    expect(page2.devices.map((d) => d.id)).toEqual(['e3']);
    expect(page2.nextCursor).toBeNull();
    // A ROW-VALUE comparison, not `hostname > x OR (hostname = x AND id > y)`.
    expect(cursorPredicateSql()).toMatch(/hostname[\s\S]*,[\s\S]*id[\s\S]*\)\s*>/);
  });

  it('rejects a malformed cursor with 400 rather than silently paging from the start', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true);
    await expect(listInvoiceLineDevices(INV, LINE, { limit: 10, cursor: 'not-base64url!!' }, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });
});

describe('getPeriodOutcome (#3205 W07)', () => {
  it('a period id belonging to a different contract is 404', async () => {
    mockContract(); mockPeriodBelongsToContract(false);
    await expect(getPeriodOutcome(CONTRACT, OTHER_CONTRACTS_PERIOD, ACTOR))
      .rejects.toMatchObject({ status: 404, code: 'PERIOD_NOT_FOUND' });
  });

  it('a pre-W07 period returns recorded:false with a null outcome', async () => {
    mockContract(); mockPeriodBelongsToContract(true); mockOutcome(null);
    await expect(getPeriodOutcome(CONTRACT, PERIOD, ACTOR)).resolves.toEqual({ recorded: false, outcome: null });
  });

  it('a recorded period returns the scalars and both jsonb digests', async () => {
    mockContract(); mockPeriodBelongsToContract(true);
    mockOutcome({ snapshotDeviceTotal: 12, uncoveredTotal: 2, flaggedTotal: 5, billedOverageTotal: 0,
                  uncoveredByRole: { printer: 2 }, overages: [{ mode: 'flag', overage: 5 }] });
    const out = await getPeriodOutcome(CONTRACT, PERIOD, ACTOR);
    expect(out.recorded).toBe(true);
    expect(out.outcome).toMatchObject({ uncoveredByRole: { printer: 2 }, flaggedTotal: 5, snapshotDeviceTotal: 12 });
  });
});
```

- [ ] **Step 2: Write the failing route tests**

Create `apps/api/src/routes/invoices/evidence.test.ts` and `apps/api/src/routes/contracts/periods.test.ts`, mirroring the existing route-test harness in each directory:

```ts
// evidence.test.ts
it('401 unauthenticated', async () => expect((await app.request(PATH)).status).toBe(401));
it('403 without invoices:read', async () => expect((await app.request(PATH, { headers: NO_PERM })).status).toBe(403));
it('404 for a cross-tenant invoice id', async () => expect((await app.request(OTHER_ORG_PATH, { headers: AUTH })).status).toBe(404));
it('404 for a line id from another invoice (same-parent ownership)', async () =>
  expect((await app.request(`/${INV}/lines/${OTHER_INVOICES_LINE}/devices`, { headers: AUTH })).status).toBe(404));
it('200 with the paged shape', async () => {
  const res = await app.request(`${PATH}?limit=2`, { headers: AUTH });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    data: { recorded: true, total: expect.any(Number), devices: expect.any(Array) },
  });
});
it('400 on limit=0, limit=501 and a non-numeric limit', async () => {
  for (const q of ['limit=0', 'limit=501', 'limit=abc']) {
    expect((await app.request(`${PATH}?${q}`, { headers: AUTH })).status).toBe(400);
  }
});
it('is mounted BEFORE invoiceCrudRoutes so /:id/lines/:lineId/devices is not swallowed', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
  expect(src.indexOf('invoiceEvidenceRoutes')).toBeLessThan(src.indexOf('invoiceCrudRoutes'));
});
```

```ts
// periods.test.ts — the same five gates against contracts:read, plus:
it('404 for a period id from another contract (same-parent ownership)', async () =>
  expect((await app.request(`/${CONTRACT}/periods/${OTHER_CONTRACTS_PERIOD}/outcome`, { headers: AUTH })).status).toBe(404));
it('200 { recorded: false, outcome: null } for a pre-W07 period', async () => {
  const res = await app.request(`/${CONTRACT}/periods/${OLD_PERIOD}/outcome`, { headers: AUTH });
  expect(await res.json()).toEqual({ data: { recorded: false, outcome: null } });
});
it('is mounted BEFORE contractCrudRoutes', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
  expect(src.indexOf('contractPeriodRoutes')).toBeLessThan(src.indexOf('contractCrudRoutes'));
});
```

Append to `apps/api/src/services/invoiceService.test.ts`:

```ts
it('#3205 W07 ruling 3: getInvoice adds deviceCount per line; listInvoices does NOT', async () => {
  const detail = await getInvoice(INV, ACTOR);
  expect(detail.lines.every((l) => typeof l.deviceCount === 'number')).toBe(true);
  const list = await listInvoices({}, ACTOR);
  expect(list.some((i: Record<string, unknown>) => 'deviceCount' in i)).toBe(false);
  // Exactly ONE grouped aggregate per detail view — never a per-row aggregate on
  // the invoice index.
  expect(groupedEvidenceCountQueries()).toHaveLength(1);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/billingEvidence.test.ts src/routes/invoices/evidence.test.ts src/routes/contracts/periods.test.ts src/services/invoiceService.test.ts`
Expected: FAIL — the three new modules do not exist; `deviceCount` is `undefined`.

- [ ] **Step 4: Implement `services/billingEvidence.ts`**

```ts
/**
 * #3205 W07 (#4656) — reading the billing evidence written at generation.
 *
 * Both entry points re-assert org access against the PARENT document and throw
 * 404 (never 403) on a mismatch, matching getInvoice/getCustomerInvoice. Both
 * also assert SAME-PARENT ownership in the SQL predicate rather than after the
 * fetch, so a valid line id from a different invoice in the same org is a 404
 * and never a read of someone else's evidence through a mismatched path.
 */
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { invoiceLineDevices, invoiceLines, contractBillingPeriods, contractBillingPeriodOutcomes } from '../db/schema';
import { getOwnedInvoiceOr404, requireInvoiceAccess } from './invoiceService';
import { getOwnedContractOr404 } from './contractService';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { ContractServiceError, type ContractActor } from './contractTypes';
import type { InvoiceLineDeviceCountedAs } from '@breeze/shared';

export const INVOICE_LINE_DEVICES_MAX_LIMIT = 500;
export const INVOICE_LINE_DEVICES_DEFAULT_LIMIT = 100;

export interface InvoiceLineDeviceRow {
  id: string;
  deviceId: string | null;
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: InvoiceLineDeviceCountedAs;
}

/** base64url of `hostname + NUL + id`. A NUL byte cannot occur in a hostname, so
 *  the split is unambiguous for every legal value — which a ':' or '|'
 *  separator would not be. */
const CURSOR_SEP = '\u0000';
function encodeCursor(hostname: string, id: string): string {
  return Buffer.from(hostname + CURSOR_SEP + id, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { hostname: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = raw.indexOf(CURSOR_SEP);
  const id = at === -1 ? '' : raw.slice(at + 1);
  // Reject rather than silently paging from the start: a caller with a corrupt
  // cursor would otherwise re-read page 1 forever and never notice.
  if (at === -1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new InvoiceServiceError('Invalid cursor', 400, 'INVALID_CURSOR');
  }
  return { hostname: raw.slice(0, at), id };
}

export async function listInvoiceLineDevices(
  invoiceId: string,
  lineId: string,
  opts: { limit: number; cursor?: string },
  actor: InvoiceActor,
): Promise<{ recorded: boolean; total: number; devices: InvoiceLineDeviceRow[]; nextCursor: string | null }> {
  // 404-on-cross-tenant, exactly like getInvoice.
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireInvoiceAccess(actor, inv);

  // Same-parent ownership, IN THE PREDICATE. A line id from another invoice —
  // even one in the same org — is 404 here and never reaches the row fetch.
  const [line] = await db.select({ id: invoiceLines.id }).from(invoiceLines)
    .where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId))).limit(1);
  if (!line) throw new InvoiceServiceError('Invoice line not found', 404, 'INVOICE_LINE_NOT_FOUND');

  const limit = Math.min(Math.max(1, opts.limit), INVOICE_LINE_DEVICES_MAX_LIMIT);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const [totals] = await db.select({ n: count() }).from(invoiceLineDevices)
    .where(eq(invoiceLineDevices.invoiceLineId, lineId));

  // Keyset on (hostname, id) — the same pair invoice_line_devices_line_read_idx
  // leads with, so any page is an index scan. The SQL collation here affects
  // PRESENTATION only: which device was billed is already settled in counted_as
  // by the code-unit order used at generation.
  const rows = await db.select({
      id: invoiceLineDevices.id, deviceId: invoiceLineDevices.deviceId,
      hostname: invoiceLineDevices.hostname, deviceRole: invoiceLineDevices.deviceRole,
      siteId: invoiceLineDevices.siteId, countedAs: invoiceLineDevices.countedAs,
    }).from(invoiceLineDevices)
    .where(and(
      eq(invoiceLineDevices.invoiceLineId, lineId),
      cursor
        ? sql`(${invoiceLineDevices.hostname}, ${invoiceLineDevices.id}) > (${cursor.hostname}, ${cursor.id}::uuid)`
        : undefined,
    ))
    .orderBy(asc(invoiceLineDevices.hostname), asc(invoiceLineDevices.id))
    .limit(limit + 1);                                     // +1 = the has-more probe

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    // Invoice-level, deliberately NOT per line (decision 15a): deriving this
    // from "this line has zero rows" would make a genuinely zero-device line
    // indistinguishable from a pre-W07 invoice.
    recorded: inv.evidenceVersion !== null,
    total: Number(totals?.n ?? 0),
    devices: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.hostname, last.id) : null,
  };
}

export interface PeriodOutcome {
  contractBillingPeriodId: string;
  invoiceId: string | null;
  snapshotDeviceTotal: number;
  uncoveredTotal: number;
  flaggedTotal: number;
  billedOverageTotal: number;
  uncoveredByRole: Record<string, number>;
  overages: unknown[];
  generatedAt: string;
}

export async function getPeriodOutcome(
  contractId: string, periodId: string, actor: ContractActor,
): Promise<{ recorded: boolean; outcome: PeriodOutcome | null }> {
  await getOwnedContractOr404(contractId, actor);          // 404 on cross-tenant
  const [period] = await db.select({ id: contractBillingPeriods.id }).from(contractBillingPeriods)
    .where(and(eq(contractBillingPeriods.id, periodId), eq(contractBillingPeriods.contractId, contractId))).limit(1);
  if (!period) throw new ContractServiceError('Billing period not found', 404, 'PERIOD_NOT_FOUND');

  const [row] = await db.select().from(contractBillingPeriodOutcomes)
    .where(eq(contractBillingPeriodOutcomes.contractBillingPeriodId, periodId)).limit(1);
  // No row means exactly one thing: this period was billed before W07.
  if (!row) return { recorded: false, outcome: null };
  return {
    recorded: true,
    outcome: {
      contractBillingPeriodId: row.contractBillingPeriodId,
      invoiceId: row.invoiceId,
      snapshotDeviceTotal: row.snapshotDeviceTotal,
      uncoveredTotal: row.uncoveredTotal,
      flaggedTotal: row.flaggedTotal,
      billedOverageTotal: row.billedOverageTotal,
      uncoveredByRole: (row.uncoveredByRole ?? {}) as Record<string, number>,
      overages: (row.overages ?? []) as unknown[],
      generatedAt: row.generatedAt.toISOString(),
    },
  };
}
```

Export `getOwnedInvoiceOr404` from `invoiceService.ts` and `getOwnedContractOr404` from `contractService.ts` if they are not already exported (`requireInvoiceAccess` already is) — do **not** re-implement either check here.

- [ ] **Step 5: Implement the two route files and mount them**

`apps/api/src/routes/invoices/evidence.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  listInvoiceLineDevices, INVOICE_LINE_DEVICES_DEFAULT_LIMIT, INVOICE_LINE_DEVICES_MAX_LIMIT,
} from '../../services/billingEvidence';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceEvidenceRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(INVOICE_LINE_DEVICES_MAX_LIMIT).default(INVOICE_LINE_DEVICES_DEFAULT_LIMIT),
  cursor: z.string().max(512).optional(),
});

// #3205 W07: which devices this invoice line billed. Read-only (no runAction on
// the web side); 404 — never 403 — on a cross-tenant invoice OR a line
// belonging to a different invoice.
invoiceEvidenceRoutes.get('/:id/lines/:lineId/devices', scopes, readPerm,
  zValidator('param', lineParam), zValidator('query', listQuery), async (c) => {
    const { id, lineId } = c.req.valid('param');
    const { limit, cursor } = c.req.valid('query');
    try { return c.json({ data: await listInvoiceLineDevices(id, lineId, { limit, cursor }, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
```

`apps/api/src/routes/contracts/periods.ts` — the same shape against `PERMISSIONS.CONTRACTS_READ`, `contractActorFrom`, `handleContractError`, path `/:id/periods/:periodId/outcome`, param schema `{ id, periodId }`, no query:

```ts
export const contractPeriodRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const periodParam = z.object({ id: z.string().guid(), periodId: z.string().guid() });

contractPeriodRoutes.get('/:id/periods/:periodId/outcome', scopes, readPerm,
  zValidator('param', periodParam), async (c) => {
    const { id, periodId } = c.req.valid('param');
    try { return c.json({ data: await getPeriodOutcome(id, periodId, contractActorFrom(c)) }); }
    catch (err) { return handleContractError(c, err); }
  });
```

Mount both **before** the param-matcher CRUD routers:

```ts
// routes/invoices/index.ts
invoiceRoutes.route('/', invoicePdfRoutes);        // /:id/pdf (Phase 5)
invoiceRoutes.route('/', invoiceEvidenceRoutes);   // /:id/lines/:lineId/devices (#3205 W07)
invoiceRoutes.route('/', invoiceCrudRoutes);       // /, /:id, /:id/lines... (param matchers last)
```

```ts
// routes/contracts/index.ts
contractRoutes.route('/', contractLineRoutes);     // /:id/lines, /:id/lines/:lineId
contractRoutes.route('/', contractPeriodRoutes);   // /:id/periods/:periodId/outcome (#3205 W07)
contractRoutes.route('/', contractCrudRoutes);     // /, /:id (param matchers last)
```

- [ ] **Step 6: Implement `deviceCount` on the DETAIL read only**

`apps/api/src/services/invoiceService.ts`, inside `getInvoice`, after the `lines` select:

```ts
  // #3205 W07 ruling 3: ONE grouped aggregate per invoice-detail view. It is
  // deliberately NOT added to listInvoices or any other list endpoint, where it
  // would put a per-row aggregate on the invoice index. A line whose count is 0
  // renders no disclosure toggle at all, so a pre-W07 invoice's line table is
  // unchanged.
  const evidenceCounts = await db
    .select({ lineId: invoiceLineDevices.invoiceLineId, n: count() })
    .from(invoiceLineDevices)
    .where(eq(invoiceLineDevices.invoiceId, invoiceId))
    .groupBy(invoiceLineDevices.invoiceLineId);
  const deviceCountByLine = new Map(evidenceCounts.map((r) => [r.lineId, Number(r.n)]));
  const linesWithDeviceCount = lines.map((l) => ({ ...l, deviceCount: deviceCountByLine.get(l.id) ?? 0 }));
```

and return `lines: linesWithDeviceCount`. Leave `listInvoices` and `getCustomerInvoice` untouched.

- [ ] **Step 6b: Outcome SUMMARY scalars on the contract detail read**

The contract detail's Outcome **column** needs a value for every period at once; fetching per row would be one request per period. `getContract` therefore LEFT JOINs the outcome scalars onto each period — the same "aggregate on the DETAIL read only" precedent as `deviceCount`. The **expanded** panel still calls `GET /contracts/:id/periods/:periodId/outcome`, which is where the two jsonb digests (`uncoveredByRole`, `overages`) live; they are deliberately not on the detail payload.

`apps/api/src/services/contractService.ts`, in `getContract`, replace the `periods` select with:

```ts
  // #3205 W07: the per-period outcome SUMMARY, one LEFT JOIN, so the billing
  // history table can show an Outcome column without a request per row. The
  // jsonb digests are NOT here — the expander fetches those from
  // GET /contracts/:id/periods/:periodId/outcome.
  const periods = await db
    .select({
      id: contractBillingPeriods.id,
      contractId: contractBillingPeriods.contractId,
      orgId: contractBillingPeriods.orgId,
      periodStart: contractBillingPeriods.periodStart,
      periodEnd: contractBillingPeriods.periodEnd,
      invoiceId: contractBillingPeriods.invoiceId,
      generatedAt: contractBillingPeriods.generatedAt,
      // null across the board = billed before W07 -> the UI renders "Not recorded".
      snapshotDeviceTotal: contractBillingPeriodOutcomes.snapshotDeviceTotal,
      uncoveredTotal: contractBillingPeriodOutcomes.uncoveredTotal,
      flaggedTotal: contractBillingPeriodOutcomes.flaggedTotal,
      billedOverageTotal: contractBillingPeriodOutcomes.billedOverageTotal,
    })
    .from(contractBillingPeriods)
    .leftJoin(contractBillingPeriodOutcomes,
      eq(contractBillingPeriodOutcomes.contractBillingPeriodId, contractBillingPeriods.id))
    .where(eq(contractBillingPeriods.contractId, contractId))
    .orderBy(desc(contractBillingPeriods.periodStart));
```

Assert it in `apps/api/src/services/contractService.test.ts`:

```ts
it('#3205 W07: getContract periods carry the outcome summary scalars, and null for a pre-W07 period', async () => {
  const { periods } = await getContract(CONTRACT, ACTOR);
  expect(periods[0]).toMatchObject({ snapshotDeviceTotal: 12, uncoveredTotal: 2, flaggedTotal: 0, billedOverageTotal: 0 });
  expect(periods[1]).toMatchObject({ snapshotDeviceTotal: null, uncoveredTotal: null });
  // The jsonb digests stay off the detail payload.
  expect(periods[0]).not.toHaveProperty('uncoveredByRole');
  expect(periods[0]).not.toHaveProperty('overages');
});
```

- [ ] **Step 7: Run**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head
npx vitest run src/services/billingEvidence.test.ts src/routes/invoices/evidence.test.ts \
  src/routes/contracts/periods.test.ts src/services/invoiceService.test.ts src/routes/invoices/invoices.test.ts
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/billingEvidence.ts apps/api/src/services/billingEvidence.test.ts \
  apps/api/src/routes/invoices/evidence.ts apps/api/src/routes/invoices/evidence.test.ts \
  apps/api/src/routes/contracts/periods.ts apps/api/src/routes/contracts/periods.test.ts \
  apps/api/src/routes/invoices/index.ts apps/api/src/routes/contracts/index.ts \
  apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts \
  apps/api/src/services/contractService.ts
git commit -m "feat(billing): keyset-paged evidence + period-outcome reads and deviceCount on the invoice detail (#3205 W07)"
```

---

### Task 7: PDF appendix (flagged filtered before the cap) and the partner billing setting

**Files:**
- Modify: `apps/api/src/services/invoicePdf.ts`
- Create: `apps/api/src/services/invoicePdf.appendix.test.ts`
- Modify: `apps/api/src/__tests__/integration/invoicePdf.appendix.integration.test.ts` (the content cases from Task 5)
- Modify: `packages/shared/src/validators/invoices.ts` (+ `invoices.test.ts`)
- Modify: `apps/api/src/services/invoiceService.ts` (`updatePartnerBillingSettings`)
- Modify: `apps/api/src/routes/invoices/settings.test.ts`

**Interfaces:**

```ts
// apps/api/src/services/invoicePdf.ts
/** One invoice line's billed devices, ready to draw. `flagged` rows are already
 *  filtered out in SQL — they were not charged. */
export interface InvoiceAppendixLine {
  lineId: string;
  description: string;
  devices: { hostname: string; deviceRole: string; countedAs: 'included' | 'overage' }[];
}
export interface InvoiceDeviceAppendix {
  lines: InvoiceAppendixLine[];
  /** Rows beyond APPENDIX_ROW_CAP that were not printed. 0 = nothing truncated. */
  omitted: number;
}
export const APPENDIX_ROW_CAP = 2000;
/** Fourth argument, optional — the function stays PURE and its existing
 *  pure-buffer test keeps calling it with three. */
export function renderInvoicePdfBuffer(
  invoice: InvoiceRow, lines: InvoiceLineRow[], branding: InvoiceBranding, appendix?: InvoiceDeviceAppendix | null,
): Promise<Buffer>;
// renderInvoicePdf(invoiceId) keeps its SINGLE-argument signature. There is no
// options parameter and there must not be one (spec Findings).

// packages/shared/src/validators/invoices.ts
// partnerBillingSettingsSchema gains: invoiceDeviceAppendix: z.boolean().optional()
```

- [ ] **Step 1: Write the failing pure-render tests**

Create `apps/api/src/services/invoicePdf.appendix.test.ts`:

```ts
/**
 * #3205 W07 — the appendix is drawn by the PURE renderer from a prepared
 * structure. No DB here; the gate and the SQL filter are covered by the
 * integration suite.
 */
import { describe, it, expect } from 'vitest';
import { renderInvoicePdfBuffer, APPENDIX_ROW_CAP, type InvoiceDeviceAppendix } from './invoicePdf';
import { INVOICE_FIXTURE, LINES_FIXTURE, BRANDING_FIXTURE } from './__fixtures__/invoicePdf';   // existing fixtures

const text = async (appendix?: InvoiceDeviceAppendix | null) =>
  (await renderInvoicePdfBuffer(INVOICE_FIXTURE, LINES_FIXTURE, BRANDING_FIXTURE, appendix)).toString('latin1');

const dev = (hostname: string, countedAs: 'included' | 'overage' = 'included') =>
  ({ hostname, deviceRole: 'server', countedAs });

describe('renderInvoicePdfBuffer device appendix (#3205 W07)', () => {
  it('the existing three-argument call still produces a %PDF- buffer with no appendix', async () => {
    const buf = await renderInvoicePdfBuffer(INVOICE_FIXTURE, LINES_FIXTURE, BRANDING_FIXTURE);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.toString('latin1')).not.toContain('Billed devices');
  });

  it('null / empty appendix draws nothing', async () => {
    expect(await text(null)).not.toContain('Billed devices');
    expect(await text({ lines: [], omitted: 0 })).not.toContain('Billed devices');
  });

  it('draws a heading per invoice line and a row per device', async () => {
    const out = await text({ lines: [
      { lineId: 'l1', description: 'Endpoints', devices: [dev('alpha-01'), dev('beta-02')] },
      { lineId: 'l2', description: 'Servers', devices: [dev('srv-01')] },
    ], omitted: 0 });
    expect(out).toContain('Billed devices');
    expect(out).toContain('Endpoints');
    expect(out).toContain('alpha-01');
    expect(out).toContain('beta-02');
    expect(out).toContain('Servers');
    expect(out).toContain('srv-01');
  });

  it('labels overage rows without implying they were free', async () => {
    const out = await text({ lines: [{ lineId: 'l1', description: 'Endpoints', devices: [dev('over-01', 'overage')] }], omitted: 0 });
    expect(out).toContain('Overage');
  });

  it('emits the truncation line when omitted > 0, and not otherwise', async () => {
    const many = Array.from({ length: APPENDIX_ROW_CAP }, (_, i) => dev(`h-${i}`));
    expect(await text({ lines: [{ lineId: 'l1', description: 'Endpoints', devices: many }], omitted: 0 }))
      .not.toContain('more devices');
    expect(await text({ lines: [{ lineId: 'l1', description: 'Endpoints', devices: many }], omitted: 37 }))
      .toContain('37 more devices');
  }, 30_000);
});
```

- [ ] **Step 2: Extend the integration suite with the content cases**

Append to `apps/api/src/__tests__/integration/invoicePdf.appendix.integration.test.ts`:

```ts
describe('appendix rendering is gated by the STAMP only (#3205 W07)', () => {
  runDb('absent when both flags are false', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: false });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(pdf.toString('latin1')).not.toContain('Billed devices');
  });

  runDb('present with the partner flag on at issue', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: true });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(pdf.toString('latin1')).toContain('Billed devices');
  });

  runDb('present with the partner flag off and the per-invoice override on at issue', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: false, draftOverride: true });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(pdf.toString('latin1')).toContain('Billed devices');
  });

  runDb('ABSENT with the partner flag on and the per-invoice override explicitly false', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: true, draftOverride: false });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(pdf.toString('latin1')).not.toContain('Billed devices');
  });

  runDb('FREEZE: flipping the partner default after issue does not change a sanctioned re-render', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => db.update(partners)
      .set({ invoiceDeviceAppendix: true }).where(eq(partners.id, f.partnerId)));
    // The reset-link path legitimately re-renders and rewrites the stored bytes.
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(pdf.toString('latin1')).not.toContain('Billed devices');
    // ...and the mirror case.
    const g = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: true });
    await withSystemDbAccessContext(() => db.update(partners)
      .set({ invoiceDeviceAppendix: false }).where(eq(partners.id, g.partnerId)));
    const out = await withSystemDbAccessContext(() => renderInvoicePdf(g.invoiceId));
    expect(out.pdf.toString('latin1')).toContain('Billed devices');
  });

  runDb('flagged rows NEVER appear in the rendered bytes (ruling 4)', async () => {
    const f = await seedIssuedInvoiceWithEvidence({
      invoiceDeviceAppendix: true,
      devices: [{ hostname: 'billed-01', countedAs: 'included' }, { hostname: 'flagged-99', countedAs: 'flagged' }],
    });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    const out = pdf.toString('latin1');
    expect(out).toContain('billed-01');
    expect(out).not.toContain('flagged-99');       // not charged -> never on the customer's document
  });

  runDb('FLAGGED-BEFORE-CAP: 1,900 included + 500 flagged prints 1,900 rows and NO truncation line', async () => {
    // The filter is in the SQL, applied BEFORE the 2,001-row cap. Applied after,
    // this line would spend 500 of its cap on rows that are never printed and
    // then falsely claim truncation.
    const f = await seedIssuedInvoiceWithEvidence({
      invoiceDeviceAppendix: true,
      devices: [
        ...Array.from({ length: 1900 }, (_, i) => ({ hostname: `inc-${String(i).padStart(4, '0')}`, countedAs: 'included' as const })),
        ...Array.from({ length: 500 }, (_, i) => ({ hostname: `flg-${String(i).padStart(4, '0')}`, countedAs: 'flagged' as const })),
      ],
    });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    const out = pdf.toString('latin1');
    expect(out).toContain('inc-0000');
    expect(out).toContain('inc-1899');
    expect(out).not.toContain('flg-');
    expect(out).not.toMatch(/more devices/);
  }, 120_000);

  runDb('a DRAFT renders the appendix in preview and still persists nothing', async () => {
    const f = await seedDraftInvoiceWithEvidence({ draftOverride: true });
    const out = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(out.documentId).toBeNull();
    expect(out.pdf.toString('latin1')).toContain('Billed devices');
    const docs = await withSystemDbAccessContext(() => db.select().from(invoiceDocuments)
      .where(eq(invoiceDocuments.invoiceId, f.invoiceId)));
    expect(docs).toEqual([]);
  });
});
```

> A **draft** has no stamp yet (`device_appendix` is the raw override, `NULL` = inherit), so `loadInvoiceForRender` resolves `invoice.deviceAppendix ?? partner.invoiceDeviceAppendix` **only when `status === 'draft'`**. Once issued, the column is a settled boolean and the partner row is never consulted. Write it exactly that way — a single `?? partner…` expression for all statuses would silently un-freeze every issued invoice.

- [ ] **Step 3: Run to verify they fail**

```bash
cd apps/api && npx vitest run src/services/invoicePdf.appendix.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/invoicePdf.appendix.integration.test.ts
```
Expected: FAIL — `renderInvoicePdfBuffer` takes three arguments; no PDF contains "Billed devices".

- [ ] **Step 4: Implement the loader**

`apps/api/src/services/invoicePdf.ts`. Add above `loadInvoiceForRender`:

```ts
export const APPENDIX_ROW_CAP = 2000;

export interface InvoiceAppendixLine {
  lineId: string;
  description: string;
  devices: { hostname: string; deviceRole: string; countedAs: 'included' | 'overage' }[];
}
export interface InvoiceDeviceAppendix { lines: InvoiceAppendixLine[]; omitted: number }

/**
 * #3205 W07: the "Billed devices" appendix rows for one invoice.
 *
 * The `counted_as <> 'flagged'` filter is IN THE SQL, applied BEFORE the cap
 * (ruling 4 + Codex item 10): flagged devices were not charged, so printing them
 * on the customer's document would read as a charge — and filtering after the
 * cap would let a line with 1,900 billed and 500 flagged devices spend its cap
 * on rows that are never printed and then falsely claim truncation.
 */
async function loadDeviceAppendix(invoiceId: string): Promise<InvoiceDeviceAppendix> {
  // Exact printable total under the SAME filter, so the truncation line can name
  // a real number. One extra count on a render is cheap; a truncation line that
  // names a wrong number is worse than an extra query.
  const [printableTotal] = await db.select({ n: count() }).from(invoiceLineDevices)
    .where(and(eq(invoiceLineDevices.invoiceId, invoiceId), ne(invoiceLineDevices.countedAs, 'flagged')));
  const rows = await db
    .select({
      lineId: invoiceLineDevices.invoiceLineId,
      description: invoiceLines.description,
      sortOrder: invoiceLines.sortOrder,
      hostname: invoiceLineDevices.hostname,
      deviceRole: invoiceLineDevices.deviceRole,
      countedAs: invoiceLineDevices.countedAs,
    })
    .from(invoiceLineDevices)
    .innerJoin(invoiceLines, eq(invoiceLines.id, invoiceLineDevices.invoiceLineId))
    .where(and(
      eq(invoiceLineDevices.invoiceId, invoiceId),
      ne(invoiceLineDevices.countedAs, 'flagged'),
    ))
    .orderBy(asc(invoiceLines.sortOrder), asc(invoiceLineDevices.hostname), asc(invoiceLineDevices.id))
    .limit(APPENDIX_ROW_CAP);

  const omitted = Math.max(0, Number(printableTotal?.n ?? 0) - APPENDIX_ROW_CAP);
  const byLine = new Map<string, InvoiceAppendixLine>();
  for (const r of rows) {
    let entry = byLine.get(r.lineId);
    if (!entry) { entry = { lineId: r.lineId, description: r.description ?? '', devices: [] }; byLine.set(r.lineId, entry); }
    entry.devices.push({ hostname: r.hostname, deviceRole: r.deviceRole, countedAs: r.countedAs as 'included' | 'overage' });
  }
  return { lines: [...byLine.values()], omitted };
}
```

Add `ne`, `asc`, `count` to this file's `drizzle-orm` import and `invoiceLineDevices` to its schema import.

In `loadInvoiceForRender`, after the `partner` read:

```ts
  // #3205 W07 decision 14a: the renderer reads the STAMP, never the partner row —
  // a change to the partner default cannot alter what an issued invoice renders.
  // A DRAFT has no stamp yet (device_appendix is still the raw override, NULL =
  // inherit), so preview resolves the inheritance; once issued it is a settled
  // boolean. Do NOT collapse these two branches into one `?? partner…`
  // expression — that would silently un-freeze every issued invoice.
  const includeDeviceAppendix = invoice.status === 'draft'
    ? (invoice.deviceAppendix ?? partner?.invoiceDeviceAppendix ?? false)
    : invoice.deviceAppendix === true;
  const appendix = includeDeviceAppendix ? await loadDeviceAppendix(invoiceId) : null;
```

and add `appendix` to the returned object (widen the return type accordingly). In `renderInvoicePdf`, pass it through: `renderInvoicePdfBuffer(loaded.invoice, loaded.lines, loaded.branding, loaded.appendix)`. `renderInvoicePdf` keeps its single-argument signature and its existing upsert; **no re-render path is added**.

- [ ] **Step 5: Implement the draw**

`renderInvoicePdfBuffer` gains the fourth optional argument and, after the totals/footer block and before `doc.end()`:

```ts
      // ---- #3205 W07: "Billed devices" appendix -------------------------------
      // Only `included` and `overage` rows reach here (loadDeviceAppendix filters
      // `flagged` in SQL): a device that was NOT charged must never appear on the
      // customer's document, where its presence would read as a charge. Flagged
      // devices are operator evidence and live on the internal invoice detail.
      if (appendix && appendix.lines.length > 0) {
        doc.addPage();
        let ay = 50;
        doc.fillColor('#111827').fontSize(14).font('Helvetica-Bold').text('Billed devices', left, ay);
        ay += 22;
        doc.fillColor('#6b7280').fontSize(9).font('Helvetica')
          .text('The devices counted on each line of this invoice at the time it was generated.', left, ay, { width: contentWidth });
        ay += 20;
        const colRoleX = left + contentWidth * 0.55;
        const colCountedX = left + contentWidth * 0.78;
        for (const group of appendix.lines) {
          if (ay > doc.page.height - 140) { doc.addPage(); ay = 50; }
          doc.fillColor('#1f2937').fontSize(10).font('Helvetica-Bold')
            .text(`${group.description} — ${group.devices.length}`, left, ay, { width: contentWidth });
          ay += 15;
          doc.fillColor('#9ca3af').fontSize(8).font('Helvetica-Bold');
          doc.text('Hostname', left, ay);
          doc.text('Role', colRoleX, ay);
          doc.text('Counted as', colCountedX, ay, { width: contentWidth * 0.22, align: 'right' });
          ay += 12;
          for (const d of group.devices) {
            // Same page-break idiom as the line table above.
            if (ay > doc.page.height - 140) { doc.addPage(); ay = 50; }
            doc.fillColor('#1f2937').fontSize(9).font('Helvetica');
            doc.text(d.hostname, left, ay, { width: contentWidth * 0.52, ellipsis: true });
            doc.text(d.deviceRole, colRoleX, ay, { width: contentWidth * 0.2, ellipsis: true });
            doc.fillColor('#6b7280')
              .text(d.countedAs === 'overage' ? 'Overage' : 'Included', colCountedX, ay, { width: contentWidth * 0.22, align: 'right' });
            ay += 12;
          }
          ay += 8;
        }
        if (appendix.omitted > 0) {
          if (ay > doc.page.height - 120) { doc.addPage(); ay = 50; }
          doc.fillColor('#6b7280').fontSize(9).font('Helvetica-Oblique')
            .text(`… and ${appendix.omitted} more devices — see the invoice in Breeze.`, left, ay, { width: contentWidth });
        }
      }
```

The appendix text is English, like every other label in this renderer (`INVOICE`, `FROM`, `BILL TO`, `Subtotal`) — the PDF has no translation table and this wave does not add one.

- [ ] **Step 6: Implement the partner setting**

`packages/shared/src/validators/invoices.ts`, in `partnerBillingSettingsSchema` beside `autoEmailInvoiceOnQuoteAccept`:

```ts
  // #3205 W07: include the "Billed devices" appendix on invoice PDFs. Default
  // OFF (partners.invoice_device_appendix NOT NULL DEFAULT false). Resolved once
  // at issue onto invoices.device_appendix and frozen there.
  invoiceDeviceAppendix: z.boolean().optional(),
```

Add a validator case to `packages/shared/src/validators/invoices.test.ts` asserting the field is optional, boolean, and rejected as a string.

`apps/api/src/services/invoiceService.ts`, `updatePartnerBillingSettings`: add `invoiceDeviceAppendix?: boolean;` to the `patch` type and, beside the `autoTaxHardware` line:

```ts
  if (patch.invoiceDeviceAppendix !== undefined) set.invoiceDeviceAppendix = patch.invoiceDeviceAppendix;
```

Add to `apps/api/src/routes/invoices/settings.test.ts`:

```ts
  it('#3205 W07: PATCH /partner/billing-settings round-trips invoiceDeviceAppendix', async () => {
    const res = await app.request('/partner/billing-settings', {
      method: 'PATCH', headers: JSON_AUTH,
      body: JSON.stringify({ ...VALID_SETTINGS, invoiceDeviceAppendix: true }),
    });
    expect(res.status).toBe(200);
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({ invoiceDeviceAppendix: true });
  });
```

- [ ] **Step 7: Run**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | head
cd ../../packages/shared && npx vitest run src/validators/invoices.test.ts
cd ../../apps/api && npx vitest run src/services/invoicePdf.appendix.test.ts src/services/invoicePdf.test.ts src/routes/invoices/settings.test.ts src/services/invoiceService.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/invoicePdf.appendix.integration.test.ts
```
Expected: all PASS, including the pre-existing pure `%PDF-` assertion with three arguments.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/invoicePdf.ts apps/api/src/services/invoicePdf.appendix.test.ts \
  apps/api/src/__tests__/integration/invoicePdf.appendix.integration.test.ts \
  packages/shared/src/validators/invoices.ts packages/shared/src/validators/invoices.test.ts \
  apps/api/src/services/invoiceService.ts apps/api/src/routes/invoices/settings.test.ts
git commit -m "feat(billing): billed-devices PDF appendix gated by the frozen stamp, flagged rows filtered before the cap (#3205 W07)"
```

---

### Task 8: Web — invoice-line disclosure, period outcome, settings + send toggles, i18n in eight locales

**Files:**
- Modify: `apps/web/src/components/billing/invoiceTypes.ts`
- Create: `apps/web/src/components/billing/InvoiceLineDevices.tsx` (+ `InvoiceLineDevices.test.tsx`)
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx` (+ `InvoiceDetail.devices.test.tsx`)
- Modify: `apps/web/src/components/billing/InvoiceSendComposer.tsx` (+ its test)
- Modify: `apps/web/src/components/billing/PartnerBillingSettings.tsx` (+ its test)
- Modify: `apps/web/src/lib/api/contracts.ts`
- Create: `apps/web/src/components/contracts/PeriodOutcomeRow.tsx` (+ `PeriodOutcomeRow.test.tsx`)
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (+ `ContractDetail.outcome.test.tsx`)
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**

```ts
// apps/web/src/components/billing/invoiceTypes.ts
export interface InvoiceLine { /* …existing… */ deviceCount: number }
export interface InvoiceLineDevice {
  id: string;                 // the EVIDENCE row id — the React key
  deviceId: string | null;    // null = the device was deleted or moved out
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: 'included' | 'overage' | 'flagged';
}

// apps/web/src/lib/api/contracts.ts
/** ContractBillingPeriod gains the outcome SUMMARY scalars from Task 6 Step 6b.
 *  All four null = a period billed before W07 -> "Not recorded". */
export interface ContractBillingPeriod {
  /* …existing… */
  snapshotDeviceTotal: number | null;
  uncoveredTotal: number | null;
  flaggedTotal: number | null;
  billedOverageTotal: number | null;
}
export interface PeriodOutcome {
  contractBillingPeriodId: string;
  invoiceId: string | null;
  snapshotDeviceTotal: number;
  uncoveredTotal: number;
  flaggedTotal: number;
  billedOverageTotal: number;
  uncoveredByRole: Record<string, number>;
  overages: OverageSummary[];
  generatedAt: string;
}
export async function fetchPeriodOutcome(contractId: string, periodId: string): Promise<{ recorded: boolean; outcome: PeriodOutcome | null }>;

// apps/web/src/components/billing/invoiceApi.ts (or the existing billing fetch module)
export async function fetchInvoiceLineDevices(
  invoiceId: string, lineId: string, opts: { limit: number; cursor?: string },
): Promise<{ recorded: boolean; total: number; devices: InvoiceLineDevice[]; nextCursor: string | null }>;

// apps/web/src/components/billing/InvoiceLineDevices.tsx
export default function InvoiceLineDevices(props: { invoiceId: string; line: InvoiceLine }): JSX.Element | null;

// apps/web/src/components/contracts/PeriodOutcomeRow.tsx
/** `period` carries the SUMMARY scalars the contract detail already returned
 *  (all four null = a pre-W07 period). The full outcome — the two jsonb
 *  digests — is fetched lazily on expand. */
export default function PeriodOutcomeRow(props: {
  contractId: string; orgId: string; period: ContractBillingPeriod;
}): JSX.Element;
```

`fetchWithAuth` auto-injects `orgId`, so neither fetch passes one explicitly.

- [ ] **Step 1: Write the failing web tests**

Create `apps/web/src/components/billing/InvoiceLineDevices.test.tsx`:

```tsx
/**
 * #3205 W07 — the per-line device disclosure. Read-only, so no runAction is
 * involved (and none should be added).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InvoiceLineDevices from './InvoiceLineDevices';

const line = (over: Partial<InvoiceLine> = {}) => ({ id: 'l1', deviceCount: 2, ...BASE_LINE, ...over });
const device = (over: Partial<InvoiceLineDevice> = {}) => ({
  id: 'e1', deviceId: 'd1', hostname: 'alpha-01', deviceRole: 'server', siteId: null, countedAs: 'included' as const, ...over,
});

describe('InvoiceLineDevices (#3205 W07)', () => {
  beforeEach(() => { fetchSpy.mockReset(); });

  it('renders no toggle when deviceCount is 0', () => {
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 0 })} />);
    expect(screen.queryByTestId('invoice-line-devices-toggle-l1')).toBeNull();
  });

  it('fetches ONCE on first expand and not again on collapse+expand', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, total: 2, devices: [device(), device({ id: 'e2', deviceId: 'd2', hostname: 'beta-02' })], nextCursor: null });
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-l1')).toBeTruthy());
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keys rows by the EVIDENCE id — two detached rows sharing a hostname render as two rows', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, total: 2, nextCursor: null, devices: [
      device({ id: 'e1', deviceId: null, hostname: 'dup' }),
      device({ id: 'e2', deviceId: null, hostname: 'dup' }),
    ]});
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-device-e1')).toBeTruthy());
    expect(screen.getByTestId('invoice-line-device-e2')).toBeTruthy();
    // `deviceId ?? hostname` as a key would have collapsed these two into one.
  });

  it('shows the device-removed marker for a null deviceId', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, total: 1, nextCursor: null, devices: [device({ deviceId: null })] });
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 1 })} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-device-removed-e1')).toBeTruthy());
  });

  it('renders FLAGGED devices under their own sub-heading BELOW the billed rows', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, total: 2, nextCursor: null, devices: [
      device({ id: 'e1', hostname: 'billed-01', countedAs: 'included' }),
      device({ id: 'e2', hostname: 'flagged-99', countedAs: 'flagged' }),
    ]});
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-flagged-l1')).toBeTruthy());
    const billed = screen.getByTestId('invoice-line-devices-l1');
    const flagged = screen.getByTestId('invoice-line-devices-flagged-l1');
    // An unbilled device must never be misread as a charge.
    expect(billed.compareDocumentPosition(flagged) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows "showing N of M" when the page is short of the total', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, total: 1240, nextCursor: 'c', devices: [device()] });
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 1240 })} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-showing-l1').textContent).toContain('1240'));
  });

  it('renders an explicit EMPTY list — never the not-recorded notice — when a recorded fetch returns zero rows', async () => {
    // The evidence was deleted between the detail read (deviceCount > 0, so the
    // toggle rendered) and the expand. `recorded: true` with an empty list means
    // "zero devices counted", which is a real, reportable outcome — NOT the
    // pre-W07 "not recorded" case, which is an invoice-level notice rendered by
    // InvoiceDetail, never by this component.
    fetchSpy.mockResolvedValue({ recorded: true, total: 0, nextCursor: null, devices: [] });
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 2 })} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-empty-l1')).toBeTruthy());
    expect(screen.queryByTestId('invoice-devices-not-recorded')).toBeNull();
  });

  it('surfaces a load failure instead of rendering an empty list', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-error-l1')).toBeTruthy());
  });
});
```

Create `apps/web/src/components/billing/InvoiceDetail.devices.test.tsx`:

```tsx
describe('InvoiceDetail device evidence (#3205 W07)', () => {
  it('renders the not-recorded notice ONCE above the line table when evidenceVersion is null', () => {
    renderDetail({ invoice: { ...INVOICE, evidenceVersion: null }, lines: [LINE_A, LINE_B] });
    expect(screen.getAllByTestId('invoice-devices-not-recorded')).toHaveLength(1);
    const notice = screen.getByTestId('invoice-devices-not-recorded');
    const table = screen.getByTestId('invoice-detail-lines');
    expect(notice.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders NO notice for a recorded invoice, even when a line has zero devices', () => {
    renderDetail({ invoice: { ...INVOICE, evidenceVersion: 1 }, lines: [{ ...LINE_A, deviceCount: 0 }] });
    expect(screen.queryByTestId('invoice-devices-not-recorded')).toBeNull();
  });

  it('renders a toggle only for lines with deviceCount > 0', () => {
    renderDetail({ invoice: { ...INVOICE, evidenceVersion: 1 }, lines: [{ ...LINE_A, deviceCount: 3 }, { ...LINE_B, deviceCount: 0 }] });
    expect(screen.getByTestId(`invoice-line-devices-toggle-${LINE_A.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`invoice-line-devices-toggle-${LINE_B.id}`)).toBeNull();
  });

  it('ruling 3: the invoice LIST payload carries no deviceCount', async () => {
    await renderList();
    const body = JSON.parse(listFetchSpy.mock.results[0]!.value.bodyText);
    expect(body.data.every((i: Record<string, unknown>) => !('deviceCount' in i))).toBe(true);
  });
});
```

Create `apps/web/src/components/contracts/PeriodOutcomeRow.test.tsx`:

```tsx
/**
 * #3205 W07 — the Outcome cell reads the SUMMARY scalars the contract detail
 * already returned (Task 6 Step 6b); the expander lazily fetches the full
 * outcome for the two jsonb digests. So the column costs zero extra requests
 * and the endpoint is only hit when a human actually opens a period.
 */
const period = (over: Partial<ContractBillingPeriod> = {}) => ({
  id: 'p1', periodStart: '2026-07-01', periodEnd: '2026-07-31', invoiceId: 'inv1',
  generatedAt: '2026-07-01T00:00:00.000Z',
  snapshotDeviceTotal: 12, uncoveredTotal: 0, flaggedTotal: 0, billedOverageTotal: 0, ...over,
});

describe('PeriodOutcomeRow (#3205 W07)', () => {
  beforeEach(() => { fetchSpy.mockReset(); });

  it('renders "Not recorded" for a pre-W07 period (null scalars) and does not expand', () => {
    render(<PeriodOutcomeRow contractId="c1" orgId="o1" period={period({
      snapshotDeviceTotal: null, uncoveredTotal: null, flaggedTotal: null, billedOverageTotal: null })} />);
    expect(screen.getByTestId('period-outcome-summary-p1').textContent).toContain('Not recorded');
    expect(screen.queryByTestId('period-outcome-toggle-p1')).toBeNull();
  });

  it('renders "No device lines" when snapshotDeviceTotal is 0', () => {
    render(<PeriodOutcomeRow contractId="c1" orgId="o1" period={period({ snapshotDeviceTotal: 0 })} />);
    // 0 means "no snapshot was evaluated", NOT "the org owns zero devices".
    expect(screen.getByTestId('period-outcome-summary-p1').textContent).toContain('No device lines');
  });

  it('renders "All billed" when nothing was uncovered or flagged', () => {
    render(<PeriodOutcomeRow contractId="c1" orgId="o1" period={period()} />);
    expect(screen.getByTestId('period-outcome-summary-p1').textContent).toContain('All billed');
  });

  it('renders the uncovered and flagged counts from the summary, with no fetch until expand', async () => {
    render(<PeriodOutcomeRow contractId="c1" orgId="o1"
      period={period({ snapshotDeviceTotal: 40, uncoveredTotal: 37, flaggedTotal: 3 })} />);
    const summary = screen.getByTestId('period-outcome-summary-p1').textContent!;
    expect(summary).toContain('37');
    expect(summary).toContain('3');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('expands to the full outcome, fetching once', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, outcome: {
      contractBillingPeriodId: 'p1', invoiceId: 'inv1', snapshotDeviceTotal: 40,
      uncoveredTotal: 37, flaggedTotal: 3, billedOverageTotal: 0,
      uncoveredByRole: { printer: 37 },
      overages: [{ contractLineId: 'cl1', invoiceLineId: null, description: 'Endpoints', counted: 30, included: 27, overage: 3, mode: 'flag' }],
      generatedAt: '2026-07-01T00:00:00.000Z',
    }});
    render(<PeriodOutcomeRow contractId="c1" orgId="o1"
      period={period({ snapshotDeviceTotal: 40, uncoveredTotal: 37, flaggedTotal: 3 })} />);
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-p1')).toBeTruthy());
    // Reuses W06's DeviceCoverageNotice and W04's OverageNotice verbatim — the
    // persisted shapes are exactly what those components already take.
    expect(screen.getByTestId('device-coverage-notice')).toBeTruthy();
    expect(screen.getByTestId('overage-notice')).toBeTruthy();
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

Append to `apps/web/src/components/billing/PartnerBillingSettings.test.tsx` and `InvoiceSendComposer.test.tsx`:

```tsx
  it('#3205 W07: the appendix checkbox round-trips', async () => {
    renderSettings({ partner: { ...PARTNER, invoiceDeviceAppendix: true } });
    const box = await screen.findByTestId('partner-billing-device-appendix') as HTMLInputElement;
    expect(box.checked).toBe(true);                    // read back as `=== true`
    await userEvent.click(box);
    await userEvent.click(screen.getByTestId('partner-billing-save'));
    expect(saveSpy.mock.calls[0]![0]).toMatchObject({ invoiceDeviceAppendix: false });
  });
```

```tsx
  it('#3205 W07: defaults to the partner setting and sends the field ONLY when changed', async () => {
    renderComposer({ partnerDeviceAppendix: true });
    const box = screen.getByTestId('invoice-send-include-device-appendix') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(screen.getByTestId('invoice-send-confirm'));
    expect(onSend.mock.calls[0]![0]).not.toHaveProperty('includeDeviceAppendix');
    onSend.mockClear();
    await userEvent.click(box);
    await userEvent.click(screen.getByTestId('invoice-send-confirm'));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ includeDeviceAppendix: false });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/billing/InvoiceLineDevices src/components/billing/InvoiceDetail.devices src/components/contracts/PeriodOutcomeRow src/components/billing/PartnerBillingSettings src/components/billing/InvoiceSendComposer`
Expected: FAIL — the two new components do not exist; the two checkboxes are not rendered.

- [ ] **Step 3: i18n — the `en` keys**

`apps/web/src/locales/en/billing.json`. Add under `invoiceDetail`:

```json
    "devices": {
      "title": "Billed devices",
      "toggle": "Devices ({{count}})",
      "notRecorded": "Device detail was not recorded for this invoice.",
      "hostname": "Hostname",
      "role": "Role",
      "countedAs": "Counted as",
      "included": "Included",
      "overage": "Overage",
      "removed": "Device removed",
      "showing": "Showing {{shown}} of {{total}}",
      "flaggedHeading": "Flagged, not billed",
      "empty": "No devices were counted for this line.",
      "loadError": "Could not load the device list."
    }
```

under `contracts.contractDetail.billingHistory`:

```json
      "outcome": "Outcome",
      "outcomeAllBilled": "All billed",
      "outcomeUncovered": "{{count}} uncovered",
      "outcomeFlagged": "{{count}} flagged",
      "outcomeNoDeviceLines": "No device lines",
      "outcomeNotRecorded": "Not recorded",
      "outcomeToggle": "Show period outcome",
      "outcomeDevicesEvaluated": "Devices evaluated: {{count}}",
      "outcomeBilledOverage": "Billed overage: {{count}}"
```

under `partnerBillingSettings.defaults`:

```json
      "deviceAppendix": "Include billed devices appendix on invoice PDFs",
      "deviceAppendixHelp": "Adds a page listing every device counted on each invoice line. Off by default; the choice is frozen when an invoice is issued."
```

under `invoiceActions.composer`:

```json
      "includeDeviceAppendixLabel": "Include billed devices appendix"
```

- [ ] **Step 4: i18n — the other seven locales**

Same key paths, same nesting. `de-DE`:

```json
"devices": { "title": "Abgerechnete Geräte", "toggle": "Geräte ({{count}})", "notRecorded": "Für diese Rechnung wurden keine Gerätedetails erfasst.", "hostname": "Hostname", "role": "Rolle", "countedAs": "Gezählt als", "included": "Enthalten", "overage": "Mehrverbrauch", "removed": "Gerät entfernt", "showing": "{{shown}} von {{total}} werden angezeigt", "flaggedHeading": "Markiert, nicht abgerechnet", "empty": "Für diese Position wurden keine Geräte gezählt.", "loadError": "Die Geräteliste konnte nicht geladen werden." }
"outcome": "Ergebnis", "outcomeAllBilled": "Alles abgerechnet", "outcomeUncovered": "{{count}} nicht abgedeckt", "outcomeFlagged": "{{count}} markiert", "outcomeNoDeviceLines": "Keine Gerätepositionen", "outcomeNotRecorded": "Nicht erfasst", "outcomeToggle": "Periodenergebnis anzeigen", "outcomeDevicesEvaluated": "Ausgewertete Geräte: {{count}}", "outcomeBilledOverage": "Abgerechneter Mehrverbrauch: {{count}}"
"deviceAppendix": "Anhang mit abgerechneten Geräten in Rechnungs-PDFs aufnehmen", "deviceAppendixHelp": "Fügt eine Seite mit allen Geräten hinzu, die auf jeder Rechnungsposition gezählt wurden. Standardmäßig deaktiviert; die Auswahl wird bei Rechnungsstellung eingefroren."
"includeDeviceAppendixLabel": "Anhang mit abgerechneten Geräten einschließen"
```

`es-419`:

```json
"devices": { "title": "Dispositivos facturados", "toggle": "Dispositivos ({{count}})", "notRecorded": "No se registró el detalle de dispositivos para esta factura.", "hostname": "Nombre de host", "role": "Rol", "countedAs": "Contado como", "included": "Incluido", "overage": "Excedente", "removed": "Dispositivo eliminado", "showing": "Mostrando {{shown}} de {{total}}", "flaggedHeading": "Marcados, no facturados", "empty": "No se contaron dispositivos para esta línea.", "loadError": "No se pudo cargar la lista de dispositivos." }
"outcome": "Resultado", "outcomeAllBilled": "Todo facturado", "outcomeUncovered": "{{count}} sin cobertura", "outcomeFlagged": "{{count}} marcados", "outcomeNoDeviceLines": "Sin líneas de dispositivos", "outcomeNotRecorded": "No registrado", "outcomeToggle": "Ver resultado del período", "outcomeDevicesEvaluated": "Dispositivos evaluados: {{count}}", "outcomeBilledOverage": "Excedente facturado: {{count}}"
"deviceAppendix": "Incluir el anexo de dispositivos facturados en los PDF de facturas", "deviceAppendixHelp": "Agrega una página con todos los dispositivos contados en cada línea de la factura. Desactivado de forma predeterminada; la elección se congela al emitir la factura."
"includeDeviceAppendixLabel": "Incluir el anexo de dispositivos facturados"
```

`fr-CA` **and** `fr-FR` (identical strings; both files must carry every key — the parity test checks keys, not text):

```json
"devices": { "title": "Appareils facturés", "toggle": "Appareils ({{count}})", "notRecorded": "Le détail des appareils n'a pas été enregistré pour cette facture.", "hostname": "Nom d'hôte", "role": "Rôle", "countedAs": "Compté comme", "included": "Inclus", "overage": "Dépassement", "removed": "Appareil supprimé", "showing": "Affichage de {{shown}} sur {{total}}", "flaggedHeading": "Signalés, non facturés", "empty": "Aucun appareil n'a été compté pour cette ligne.", "loadError": "Impossible de charger la liste des appareils." }
"outcome": "Résultat", "outcomeAllBilled": "Tout facturé", "outcomeUncovered": "{{count}} non couverts", "outcomeFlagged": "{{count}} signalés", "outcomeNoDeviceLines": "Aucune ligne d'appareils", "outcomeNotRecorded": "Non enregistré", "outcomeToggle": "Afficher le résultat de la période", "outcomeDevicesEvaluated": "Appareils évalués : {{count}}", "outcomeBilledOverage": "Dépassement facturé : {{count}}"
"deviceAppendix": "Inclure l'annexe des appareils facturés dans les PDF de factures", "deviceAppendixHelp": "Ajoute une page listant chaque appareil compté sur chaque ligne de facture. Désactivé par défaut ; le choix est figé à l'émission de la facture."
"includeDeviceAppendixLabel": "Inclure l'annexe des appareils facturés"
```

`it-IT`:

```json
"devices": { "title": "Dispositivi fatturati", "toggle": "Dispositivi ({{count}})", "notRecorded": "Il dettaglio dei dispositivi non è stato registrato per questa fattura.", "hostname": "Nome host", "role": "Ruolo", "countedAs": "Conteggiato come", "included": "Incluso", "overage": "Eccedenza", "removed": "Dispositivo rimosso", "showing": "Visualizzati {{shown}} di {{total}}", "flaggedHeading": "Segnalati, non fatturati", "empty": "Nessun dispositivo è stato conteggiato per questa riga.", "loadError": "Impossibile caricare l'elenco dei dispositivi." }
"outcome": "Esito", "outcomeAllBilled": "Tutto fatturato", "outcomeUncovered": "{{count}} non coperti", "outcomeFlagged": "{{count}} segnalati", "outcomeNoDeviceLines": "Nessuna riga dispositivi", "outcomeNotRecorded": "Non registrato", "outcomeToggle": "Mostra l'esito del periodo", "outcomeDevicesEvaluated": "Dispositivi valutati: {{count}}", "outcomeBilledOverage": "Eccedenza fatturata: {{count}}"
"deviceAppendix": "Includi l'appendice dei dispositivi fatturati nei PDF delle fatture", "deviceAppendixHelp": "Aggiunge una pagina con tutti i dispositivi conteggiati su ogni riga della fattura. Disattivata per impostazione predefinita; la scelta viene congelata all'emissione."
"includeDeviceAppendixLabel": "Includi l'appendice dei dispositivi fatturati"
```

`pt-BR`:

```json
"devices": { "title": "Dispositivos faturados", "toggle": "Dispositivos ({{count}})", "notRecorded": "O detalhe de dispositivos não foi registrado para esta fatura.", "hostname": "Nome do host", "role": "Função", "countedAs": "Contado como", "included": "Incluído", "overage": "Excedente", "removed": "Dispositivo removido", "showing": "Mostrando {{shown}} de {{total}}", "flaggedHeading": "Sinalizados, não faturados", "empty": "Nenhum dispositivo foi contado para esta linha.", "loadError": "Não foi possível carregar a lista de dispositivos." }
"outcome": "Resultado", "outcomeAllBilled": "Tudo faturado", "outcomeUncovered": "{{count}} sem cobertura", "outcomeFlagged": "{{count}} sinalizados", "outcomeNoDeviceLines": "Sem linhas de dispositivos", "outcomeNotRecorded": "Não registrado", "outcomeToggle": "Mostrar o resultado do período", "outcomeDevicesEvaluated": "Dispositivos avaliados: {{count}}", "outcomeBilledOverage": "Excedente faturado: {{count}}"
"deviceAppendix": "Incluir o apêndice de dispositivos faturados nos PDFs das faturas", "deviceAppendixHelp": "Adiciona uma página listando cada dispositivo contado em cada linha da fatura. Desativado por padrão; a escolha é congelada na emissão."
"includeDeviceAppendixLabel": "Incluir o apêndice de dispositivos faturados"
```

`tr-TR`:

```json
"devices": { "title": "Faturalanan cihazlar", "toggle": "Cihazlar ({{count}})", "notRecorded": "Bu fatura için cihaz ayrıntısı kaydedilmedi.", "hostname": "Ana bilgisayar adı", "role": "Rol", "countedAs": "Sayım türü", "included": "Dahil", "overage": "Aşım", "removed": "Cihaz kaldırıldı", "showing": "{{total}} kayıttan {{shown}} tanesi gösteriliyor", "flaggedHeading": "İşaretlendi, faturalanmadı", "empty": "Bu satır için hiçbir cihaz sayılmadı.", "loadError": "Cihaz listesi yüklenemedi." }
"outcome": "Sonuç", "outcomeAllBilled": "Tümü faturalandı", "outcomeUncovered": "{{count}} kapsam dışı", "outcomeFlagged": "{{count}} işaretlendi", "outcomeNoDeviceLines": "Cihaz satırı yok", "outcomeNotRecorded": "Kaydedilmedi", "outcomeToggle": "Dönem sonucunu göster", "outcomeDevicesEvaluated": "Değerlendirilen cihazlar: {{count}}", "outcomeBilledOverage": "Faturalanan aşım: {{count}}"
"deviceAppendix": "Fatura PDF'lerine faturalanan cihazlar ekini dahil et", "deviceAppendixHelp": "Her fatura satırında sayılan tüm cihazları listeleyen bir sayfa ekler. Varsayılan olarak kapalıdır; seçim fatura düzenlendiğinde dondurulur."
"includeDeviceAppendixLabel": "Faturalanan cihazlar ekini dahil et"
```

- [ ] **Step 5: Implement `InvoiceLineDevices.tsx`**

```tsx
/**
 * #3205 W07: the devices this invoice line billed, disclosed on demand.
 *
 * READ-ONLY — no runAction (that guard is for mutations). Fetches once on first
 * expand and caches in component state; collapsing does not discard it.
 *
 * Rows are keyed by the EVIDENCE row id, never `deviceId ?? hostname`: two
 * detached rows (deleted or moved devices) can share a hostname, which is
 * exactly what a fleet with duplicate names produces.
 *
 * `flagged` devices render BELOW the billed rows under their own sub-heading
 * (ruling 4). They were not charged, so an operator must never be able to read
 * them as a charge.
 */
export default function InvoiceLineDevices({ invoiceId, line }: { invoiceId: string; line: InvoiceLine }) {
  const { t } = useTranslation('billing');
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error' | 'ready'; total: number; devices: InvoiceLineDevice[] }>(
    { status: 'idle', total: 0, devices: [] });

  if (line.deviceCount === 0) return null;      // no evidence -> no affordance at all

  const load = useCallback(async () => {
    if (state.status !== 'idle') return;        // fetch ONCE
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const data = await fetchInvoiceLineDevices(invoiceId, line.id, { limit: 100 });
      setState({ status: 'ready', total: data.total, devices: data.devices });
    } catch {
      setState((s) => ({ ...s, status: 'error' }));
    }
  }, [invoiceId, line.id, state.status]);

  const billed = state.devices.filter((d) => d.countedAs !== 'flagged');
  const flagged = state.devices.filter((d) => d.countedAs === 'flagged');
  // ...toggle button data-testid={`invoice-line-devices-toggle-${line.id}`}
  // ...billed table   data-testid={`invoice-line-devices-${line.id}`}
  // ...each row       data-testid={`invoice-line-device-${d.id}`}
  // ...removed marker data-testid={`invoice-line-device-removed-${d.id}`}
  // ...flagged block  data-testid={`invoice-line-devices-flagged-${line.id}`}  (rendered AFTER billed)
  // ...footer         data-testid={`invoice-line-devices-showing-${line.id}`}  when devices.length < total
  // ...empty          data-testid={`invoice-line-devices-empty-${line.id}`}
  // ...error          data-testid={`invoice-line-devices-error-${line.id}`}
}
```

- [ ] **Step 6: Wire `InvoiceDetail.tsx`**

Above the `<div className="overflow-x-auto" …>` scroll region that wraps `invoice-detail-lines`:

```tsx
{/* #3205 W07 decision 15a: ONCE, above the table, driven by the INVOICE. Deriving
    it per line from "zero device rows" would make a genuinely zero-device line
    (a role line matching nothing — a real, reportable outcome) look like a
    pre-W07 invoice. */}
{invoice.evidenceVersion === null && (
  <p className="mb-2 text-xs text-muted-foreground" data-testid="invoice-devices-not-recorded">
    {t('invoiceDetail.devices.notRecorded')}
  </p>
)}
```

Inside the line `<tr>`'s description cell, after `lineBlurb(l)`:

```tsx
<InvoiceLineDevices invoiceId={invoice.id} line={l} />
```

- [ ] **Step 7: Wire `ContractDetail.tsx`**

Add an **Outcome** `<th>` to the `contract-periods` header (and bump both `colSpan={3}` to `4`), then render `<PeriodOutcomeRow contractId={contract.id} orgId={contract.orgId} period={p} />` inside each period row. The row reads the summary scalars the detail payload already carries (Task 6 Step 6b) and lazily calls `fetchPeriodOutcome(contractId, period.id)` on expand. It renders:

- summary cell `data-testid={`period-outcome-summary-${p.id}`}`: `Not recorded` when `snapshotDeviceTotal === null`; `No device lines` when it is `0`; otherwise the uncovered/flagged counts, or `All billed` when both are 0;
- expander `data-testid={`period-outcome-toggle-${p.id}`}` (absent for a pre-W07 period);
- expanded panel `data-testid={`period-outcome-${p.id}`}` containing `<DeviceCoverageNotice uncovered={{ total: outcome.uncoveredTotal, byRole: outcome.uncoveredByRole }} orgId={contract.orgId} />` and `<OverageNotice overages={outcome.overages} />` — both W06/W04 components take exactly the shapes the outcome row persists, so nothing is rendered by hand.

- [ ] **Step 8: Wire the two checkboxes**

`PartnerBillingSettings.tsx`: a checkbox beside `partner-billing-auto-email-invoice`, `data-testid="partner-billing-device-appendix"`, loaded as `p.invoiceDeviceAppendix === true` (a `NOT NULL DEFAULT false` column has no unset state, so `=== true` is exact — this is deliberately not the `!== false` shape `autoEmailInvoiceOnQuoteAccept` needs), saved as `invoiceDeviceAppendix: deviceAppendix`, and **added to the save-deps array**.

`InvoiceSendComposer.tsx`: a checkbox beside `invoice-send-include-pdf`, `data-testid="invoice-send-include-device-appendix"`, initialised from the partner setting passed in as a prop, and included in the emitted options **only when the operator changed it** (mirroring how `includePdf` is only sent when false):

```tsx
    if (includeDeviceAppendix !== partnerDeviceAppendix) opts.includeDeviceAppendix = includeDeviceAppendix;
```

- [ ] **Step 9: Run**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | head
npx vitest run src/components/billing/InvoiceLineDevices src/components/billing/InvoiceDetail \
  src/components/billing/InvoiceSendComposer src/components/billing/PartnerBillingSettings \
  src/components/contracts/PeriodOutcomeRow src/components/contracts/ContractDetail src/lib/i18n
```
Expected: all PASS, including `localeParity.test.ts` and `translationCoverage.test.ts` across all eight locales.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/billing/invoiceTypes.ts \
  apps/web/src/components/billing/InvoiceLineDevices.tsx apps/web/src/components/billing/InvoiceLineDevices.test.tsx \
  apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/components/billing/InvoiceDetail.devices.test.tsx \
  apps/web/src/components/billing/InvoiceSendComposer.tsx apps/web/src/components/billing/InvoiceSendComposer.test.tsx \
  apps/web/src/components/billing/PartnerBillingSettings.tsx apps/web/src/components/billing/PartnerBillingSettings.test.tsx \
  apps/web/src/components/contracts/PeriodOutcomeRow.tsx apps/web/src/components/contracts/PeriodOutcomeRow.test.tsx \
  apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractDetail.outcome.test.tsx \
  apps/web/src/lib/api/contracts.ts apps/web/src/locales/*/billing.json
git commit -m "feat(billing): invoice device disclosure, period outcome view, appendix toggles, 8-locale strings (#3205 W07)"
```

---

### Task 9: Docs and release notes

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx`
- Modify: `apps/docs/src/content/docs/features/invoices.mdx`
- Modify: `docs/release-notes/next-release-draft.md`

- [ ] **Step 1: `contracts.mdx`**

Add a "What each billing period recorded" section after the billing-history material, stating:

- Breeze records the exact devices behind every auto-counted line **at generation** and never re-derives them; a device reclassified, deleted or moved afterwards cannot change what a past invoice says it billed.
- Each billed period also records how many devices no line on that contract billed, **by role**, plus the flagged and billed overage totals. The contract's billing history shows this per period.
- **Uncovered device identity is not stored** — a period says *how many* and *by which role*, never *which ones*. "Which devices are uncovered right now?" is answered live on the device Billing panel and the contract's coverage notice, against today's fleet.
- Periods billed before this release have no outcome row and show "Not recorded".
- A period on a contract with no device-counted line shows "No device lines" — that is an absence of measurement, not a measurement of zero.

- [ ] **Step 2: `invoices.mdx`**

Add a "Billed devices" section stating:

- Every auto-counted line on a contract-generated invoice can be expanded to the exact devices it billed, with each device's role and how it was counted (Included / Overage / **Flagged, not billed**).
- A device deleted or moved to another organisation afterwards still appears on the past invoice **by hostname**, marked "Device removed".
- The optional **billed-devices appendix** on the invoice PDF is **off by default**. Turn it on for every invoice under Billing settings, or per invoice from the send dialog while the invoice is still a draft. Flagged devices are never printed — they were not charged.
- The choice is **frozen when the invoice is issued**: changing the partner default later does not alter an already-issued invoice's PDF, and the per-invoice choice cannot be changed after issue.
- Invoices generated before this release have no device detail and say so.
- Editing a draft line's quantity by hand does **not** rewrite its device evidence — the evidence records what the generation run counted. Deleting a draft line deletes its evidence with it.

- [ ] **Step 3: Release notes**

Append under the billing section of `docs/release-notes/next-release-draft.md`:

```md
- **Billing evidence per invoice.** Contract-generated invoices now record the exact devices behind every auto-counted line, at generation time, and each billed period records what it did *not* bill (uncovered devices by role, flagged and billed overage totals). Expand any counted line on the invoice detail to see the devices; a device deleted or moved later still appears by hostname. An optional "Billed devices" appendix can be printed on the invoice PDF — off by default, set per partner or per draft invoice, and frozen once the invoice is issued. Invoices generated before this release have no device detail and say so; there is no backfill, because the device set was never stored to backfill from.
```

- [ ] **Step 4: Verify and commit**

```bash
cd apps/docs && pnpm build 2>&1 | tail -5
```
Expected: builds clean.

```bash
git add apps/docs/src/content/docs/features/contracts.mdx apps/docs/src/content/docs/features/invoices.mdx docs/release-notes/next-release-draft.md
git commit -m "docs(billing): billing evidence, period outcomes and the PDF device appendix (#3205 W07)"
```

---

### Task 10: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Manual probes as `breeze_app` (the spec's manual section)**

With the test stack up:

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```

```sql
-- Must fail: new row violates row-level security policy (42501).
SET LOCAL breeze.org_id = '<org A uuid>';
INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, hostname, device_role, counted_as)
VALUES ('<org B line>', '<org B invoice>', '<org B uuid>', 'forged', 'server', 'included');

-- Must fail: null value in column "invoice_line_id" violates not-null constraint (23502).
INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, hostname, device_role, counted_as)
VALUES (NULL, '<org A invoice>', '<org A uuid>', 'x', 'server', 'included');

-- Must NOT list invoice_line_devices.
SELECT * FROM public.breeze_device_child_orgid_tables() t(name) WHERE t.name LIKE 'invoice%';
```

Then, through the UI: hard-delete a device that a past invoice billed and confirm the invoice still lists it by hostname with "Device removed"; move a billed device to another organisation and confirm the move succeeds and the past invoice is unchanged.

- [ ] **Step 2: Full local verification on a fresh test stack**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../web && npx tsc --noEmit -p tsconfig.json && cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
pnpm lint
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
# fresh DB
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test
export DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test
export POSTGRES_PASSWORD=breeze_test
cd apps/api && pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/billingEvidenceConstraints.integration.test.ts \
  src/__tests__/integration/billingEvidenceRls.integration.test.ts \
  src/__tests__/integration/billingEvidenceDeviceMove.integration.test.ts \
  src/__tests__/integration/billingEvidence.integration.test.ts \
  src/__tests__/integration/invoicePdf.appendix.integration.test.ts \
  src/__tests__/integration/invoiceService.reissue.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractLineAllowance.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all green, `db:check-drift` clean, and **zero** allowlist edits in `rls-coverage.integration.test.ts`.

- [ ] **Step 3: Tear down the test stack, push, open the PR**

```bash
git push -u origin feature/3205-billing-evidence/wave-4656
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): billing evidence per invoice (#3205 W07)" --body "$(cat <<'EOF'
Closes #4656
Refs #3205

Spec: `docs/superpowers/specs/billing/2026-09-03-billing-evidence-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-03-billing-evidence.md`

## What

- **`invoice_line_devices`** records one row per counted device per invoice line at generation — hostname, role, site and `counted_as` (`included` / `overage` / `flagged`) — so an invoice line that says "Servers × 12" names the twelve. Written from a single `matchingDevicesForLine(snapshot, line)` call, so the quantity and the evidence are the same computation and an invoice can never say "12" beside eleven rows.
- **`contract_billing_period_outcomes`** records one row per claimed period: uncovered total + by-role digest, flagged and billed overage totals, and the snapshot size. "Silence is a bug" is now persisted, not just returned. Every claimed period gets a row, so "no row" means exactly one thing — billed before this wave.
- **Uncovered device IDENTITY is deliberately not persisted** (spec decision 2): a period says how many and by which role, never which ones. W06's coverage lookup answers "which devices are uncovered right now" against the live fleet.
- Evidence is written **after** the period claim in the **same** transaction, chunked at 500 rows/statement; a lost claim or any throw rolls the invoice, the claim and the evidence back together.
- **Reissue** now mints every clone line id up front (parents and children) and throws on a map miss, replacing a positional `RETURNING` map that SQL never promised to order; evidence clones through it with device pointers verbatim, so a detached row stays detached.
- **Reads**: `GET /invoices/:id/lines/:lineId/devices` (keyset-paged on `(hostname, id)`) and `GET /contracts/:id/periods/:periodId/outcome`. Both 404 — never 403 — on a cross-tenant id, and both assert same-parent ownership in the SQL predicate. `deviceCount` is added to the invoice DETAIL read only, never a list endpoint.
- **PDF**: an optional "Billed devices" appendix, off by default. The gate is a persisted pair (`partners.invoice_device_appendix` + `invoices.device_appendix`) resolved once at issue by **both** issuance writers and read only from the stamp thereafter — so a later partner-default change cannot alter a sanctioned re-render. Flagged devices are filtered in SQL **before** the 2,000-row cap and never printed: they were not charged.
- Tenancy: two shape-1 tables with forced RLS and complete policies in their creating migration; six `DEFERRABLE INITIALLY IMMEDIATE` composite FKs; `ON DELETE SET NULL` with explicit PG15 column lists; registered in the org cascade, export policy, org-merge repoint and device-detach lists; and **excluded from `breeze_device_child_orgid_tables()`**, without which every cross-org move of a billed device would fail with 23503.

## Migrations

- `2026-10-08-100000-billing-evidence-fk-targets.sql` — `-- @no-transaction`; `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` for `invoice_lines_id_org_uq` and `contract_billing_periods_id_org_uq` on live tables.
- `2026-10-08-100100-billing-evidence.sql` — the enum, both tables, six deferrable composite FKs, read/FK indexes, forced RLS + four policies + `breeze_app` grants per table, and `partners.invoice_device_appendix` / `invoices.device_appendix` / `invoices.evidence_version`.
- `2026-10-08-100200-device-move-exclude-billing-evidence.sql` — `CREATE OR REPLACE breeze_device_child_orgid_tables()` adding `invoice_line_devices` to the exclusion list. **Deploying the second without the third is the one unsafe interleaving**; they ship together and an integration test proves the window is closed.

## Tests

Real-DB constraint truth table (composite FKs, PG15 SET NULL column lists, cascades, the `(line, device)` unique with non-colliding NULLs, deferrability, forced RLS + policy count + grants); RLS isolation (42501 forge, cross-org invisibility, system context); the blocking cross-org device-move regression plus a direct assertion that the discovery function does not return the table; the generation disposition matrix (`M < N`, `M = N`, both overage modes, no allowance) with `included + tail === M` asserted in every case; determinism as an assignment projection; code-unit ordering over duplicate, mixed-case and non-ASCII hostnames; lost-claim and mid-generation-throw atomicity; a 1,200-row chunked write; reissue ordering-independence over three distinguishable parents, bundle children, detached rows and the orphan-parent throw; issuance stamping at both writers and the freeze across a re-render; the draft-guarded 409; keyset paging, `recorded`-from-the-invoice and same-parent-ownership service units; both route gates; PDF appendix presence/absence across all four flag combinations, flagged rows never rendered, and flagged-filtered-before-the-cap; web disclosure, flagged sub-heading, evidence-id keying, the once-above-the-table not-recorded notice, period outcome variants, both checkboxes, and eight-locale parity.

## Not in scope

No backfill (there is no source to backfill from — the snapshot was never stored, so any "backfill" would be a re-derivation against today's fleet, which is the lie this wave removes). No seat evidence, no portal / public-pay-link exposure (#4562), no QuickBooks mapping change, no row-level uncovered table, no immutability trigger (it would break the device-delete detach and the org-merge repoint), no retention/pruning.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
EOF
)"
```

Stop here. Do not merge. Report the PR URL and anything that was skipped or failed.
