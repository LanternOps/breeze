/**
 * Multi-currency wave 6 (#3778), Task 14 — the OWNER-APPROVED ACTIVE-CONTRACT
 * CURRENCY RESTAMP, proved against real Postgres.
 *
 * WHY IT EXISTS. Pre-wave-2 ACTIVE contracts stamped 'USD' under a non-USD org
 * bill USD forever: wave 2 removed issueInvoice's partner-currency overwrite
 * and changeContractCurrency is draft-only, while generateDueInvoice faithfully
 * propagates the stale stamp. The escape hatch restamps such a contract — but
 * ONLY when it owns no unbilled monetary rows, re-checked under its row lock.
 *
 * "Unbilled monetary rows" is concrete in THIS schema: time_entries and
 * ticket_parts carry no contract_id, so contract-qualified time/parts are not a
 * queryable relation and belong to the ORG preflight. What IS queryable, and
 * what the five blockers cover:
 *   (1) a contract_billing_periods invoice currently in draft,
 *   (2) a reissue DESCENDANT of one (cycle-safe replaces_invoice_id walk),
 *   (3) any draft invoice line carrying source_contract_id = this contract,
 *   (4) an org-wide source_type='contract' line the service cannot attribute,
 *   (5) a period row failing the explicit lineage proof.
 *
 * Predicate (3) is keyed on invoice_lines.source_contract_id — the DURABLE
 * column added by migration 2026-09-02-a — NOT on current contract_lines
 * membership, because removeContractLine is permitted on ACTIVE contracts and
 * would otherwise erase the evidence. That escape is asserted directly below.
 *
 * No fixture memoization: integration/setup.ts TRUNCATEs partners/organizations
 * before every test, so each test re-seeds fresh.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ / SMTP side effects are not the correctness under test
// (same rationale as the wave-6 gate slices). Everything monetary is real.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/invoicePdf', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
}));

import { and, eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  catalogItemPrices, contractBillingPeriods, contractLines, contracts, invoiceLines, invoices,
} from '../../db/schema';
import {
  activateContract, addContractLineToContract, changeContractCurrency, createContract,
  generateDueInvoice, removeContractLine,
} from '../../services/contractService';
import type { ContractActor } from '../../services/contractTypes';
import {
  addContractLine, addManualLine, createManualInvoice, issueInvoice, voidInvoice,
} from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { createCatalogItemWithPrice } from './db-utils';
import { seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const START_DATE = '2026-07-01';
const ACTIVATE_AT = new Date('2026-07-01T00:00:00Z');
const BILL_AT = new Date('2026-07-01T06:00:00Z');

/** Route-populated actor carrying VERIFIED contracts:manage evidence. */
function manageActor(f: GateOrgFixture): ContractActor {
  return { ...f.actor, permissions: new Set(['contracts:read', 'contracts:write', 'contracts:manage']) };
}
/** Exactly what the route's own CONTRACTS_WRITE middleware grants. */
function writeOnlyActor(f: GateOrgFixture): ContractActor {
  return { ...f.actor, permissions: new Set(['contracts:read', 'contracts:write']) };
}
function invActor(f: GateOrgFixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}

/** An ACTIVE contract with one flat line, stamped in `currency`. */
async function seedActiveContract(
  f: GateOrgFixture, currency = 'USD', unitPrice = '500.00',
): Promise<{ contractId: string; lineId: string }> {
  return withSystemDbAccessContext(async () => {
    const c = await createContract({
      orgId: f.orgId, name: 'Legacy MSA', billingTiming: 'advance', intervalMonths: 1,
      startDate: START_DATE, currencyCode: currency,
    }, f.actor);
    const line = await addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed services', unitPrice, taxable: false,
    } as never, f.actor);
    await activateContract(c.id, f.actor, ACTIVATE_AT);
    return { contractId: c.id, lineId: line.id };
  });
}

async function contractCurrency(contractId: string): Promise<string | undefined> {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ currencyCode: contracts.currencyCode })
    .from(contracts).where(eq(contracts.id, contractId)).limit(1));
  return row?.currencyCode;
}

async function generate(contractId: string, asOf = BILL_AT) {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => generateDueInvoice(contractId, asOf)));
}

describe.runIf(RUN)('ACTIVE-contract currency restamp (#3778, Task 14)', () => {
  // -------------------------------------------------------------------------
  // Gates that run BEFORE any eligibility read
  // -------------------------------------------------------------------------
  it('denies contracts:write-only (ACTIVE_CHANGE_FORBIDDEN 403) and never restamps', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, writeOnlyActor(f),
    ))).rejects.toMatchObject({ code: 'ACTIVE_CHANGE_FORBIDDEN', status: 403 });

    expect(await contractCurrency(contractId)).toBe('USD');
  });

  it('denies a direct-service caller carrying NO permission evidence (fail-closed)', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    // This is exactly the shape contractWorker / generateDueInvoice would have.
    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true },
      { ...f.actor, permissions: new Set<string>() },
    ))).rejects.toMatchObject({ code: 'ACTIVE_CHANGE_FORBIDDEN', status: 403 });
  });

  it('requires confirmActiveChange (ACTIVE_CHANGE_CONFIRMATION_REQUIRED 400)', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR' }, manageActor(f),
    ))).rejects.toMatchObject({ code: 'ACTIVE_CHANGE_CONFIRMATION_REQUIRED', status: 400 });

    expect(await contractCurrency(contractId)).toBe('USD');
  });

  // -------------------------------------------------------------------------
  // Blocker (1)+(2): draft period invoices and their reissue descendants
  // -------------------------------------------------------------------------
  it('(1) rejects UNBILLED_MONETARY_ROWS naming the generated draft invoice', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    expect(gen.generated).toBe(true);

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS',
      status: 409,
      details: { draftInvoiceIds: [gen.invoiceId] },
    });

    expect(await contractCurrency(contractId)).toBe('USD');
  });

  it('(2) rejects when the period invoice was voided-and-REISSUED into a new draft', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    const originalId = gen.invoiceId!;

    await withSystemDbAccessContext(() => issueInvoice(originalId, invActor(f)));
    const { invoice: reissued } = await withSystemDbAccessContext(() =>
      voidInvoice(originalId, 'correction', { reissue: true }, invActor(f)));

    // The period row still points at the ORIGINAL (now void) invoice; the live
    // draft is only reachable through the replaces_invoice_id descendant walk.
    expect(reissued.id).not.toBe(originalId);
    expect(reissued.status).toBe('draft');

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS',
      status: 409,
      details: { draftInvoiceIds: [reissued.id] },
    });
  });

  it('(2b) a CYCLIC replaces_invoice_id chain terminates and still rejects — it does not hang', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    const a = gen.invoiceId!;

    // Hand-forge a two-node cycle: a -> b -> a. Only raw SQL can build this;
    // no service path can, which is precisely why the walk must be defensive.
    const b = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(invoices).values({
        partnerId: f.partnerId, orgId: f.orgId, status: 'draft',
        currencyCode: 'USD', replacesInvoiceId: a,
      }).returning({ id: invoices.id });
      await db.update(invoices).set({ replacesInvoiceId: row!.id }).where(eq(invoices.id, a));
      return row!.id;
    });

    const started = Date.now();
    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f),
    // A cycle is BROKEN_CONTRACT_LINEAGE by predicate 5(e) — the point of the
    // test is that the walk TERMINATES and blocks, never that it hangs or,
    // worse, silently reports the contract eligible.
    ))).rejects.toMatchObject({ code: 'BROKEN_CONTRACT_LINEAGE', status: 409 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(b).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Blocker (3): direct contract-source lines — and the codex escape
  // -------------------------------------------------------------------------
  it('(3) rejects when a contract-source line sits on some OTHER draft invoice', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');

    // A hand-built USD draft that is NOT a billing-period invoice.
    const draftId = await withSystemDbAccessContext(async () => {
      const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: 'USD' }, invActor(f));
      await db.insert(invoiceLines).values({
        invoiceId: inv.id, orgId: f.orgId, sourceType: 'contract',
        sourceId: lineId, sourceContractId: contractId,
        description: 'Managed services', quantity: '1', unitPrice: '500.00',
        taxable: false, customerVisible: true, lineTotal: '500.00',
      });
      return inv.id;
    });

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', status: 409, details: { draftInvoiceIds: [draftId] },
    });
  });

  it('(3b) THE ESCAPE: removing the contract line does NOT make the contract eligible', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    const draftId = gen.invoiceId!;

    // removeContractLine is permitted on an ACTIVE contract. Before #3778 this
    // erased the only evidence tying the live draft line to the contract.
    await withSystemDbAccessContext(() => removeContractLine(contractId, lineId, f.actor));
    const [remaining] = await withSystemDbAccessContext(() => db
      .select({ n: sql<number>`count(*)::int` }).from(contractLines)
      .where(eq(contractLines.contractId, contractId)));
    expect(remaining!.n).toBe(0);

    // The draft line's source_id now dangles — but source_contract_id survived.
    const [line] = await withSystemDbAccessContext(() => db
      .select({ sourceContractId: invoiceLines.sourceContractId, sourceId: invoiceLines.sourceId })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, draftId)).limit(1));
    expect(line!.sourceContractId).toBe(contractId);

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({ code: 'UNBILLED_MONETARY_ROWS', status: 409 });

    expect(await contractCurrency(contractId)).toBe('USD');
  });

  it('(3c) a NULL-lineage draft line whose source_id still resolves to a LIVE line of this contract blocks too', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');

    // Wave-6 review round: a pre-migration row (durable lineage NULL) whose
    // polymorphic source_id STILL points at a live contract_lines row of this
    // contract is attributable, so it must block. Blocker (4) cannot catch it —
    // (4) fires only when the source_id resolves to nothing.
    const draftId = await withSystemDbAccessContext(async () => {
      const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: 'USD' }, invActor(f));
      await db.insert(invoiceLines).values({
        invoiceId: inv.id, orgId: f.orgId, sourceType: 'contract',
        sourceId: lineId, sourceContractId: null,
        description: 'Pre-migration contract line', quantity: '1', unitPrice: '250.00',
        taxable: false, customerVisible: true, lineTotal: '250.00',
      });
      return inv.id;
    });

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', status: 409, details: { draftInvoiceIds: [draftId] },
    });

    expect(await contractCurrency(contractId)).toBe('USD');
  });

  // -------------------------------------------------------------------------
  // Blocker (4): legacy / unattributable contract-source lines
  // -------------------------------------------------------------------------
  it('(4) a legacy contract-source line with NULL lineage and a dangling source_id → ORPHANED_CONTRACT_SOURCE', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    // Simulate a pre-migration row the backfill could not attribute: raw SQL is
    // the only way in, because the service layer now refuses to write one.
    const orphanLineId = await withSystemDbAccessContext(async () => {
      const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: 'USD' }, invActor(f));
      const [row] = await db.insert(invoiceLines).values({
        invoiceId: inv.id, orgId: f.orgId, sourceType: 'contract',
        sourceId: '00000000-0000-4000-8000-00000000dead', sourceContractId: null,
        description: 'Legacy contract line', quantity: '1', unitPrice: '10.00',
        taxable: false, customerVisible: true, lineTotal: '10.00',
      }).returning({ id: invoiceLines.id });
      // The invoice stays in DRAFT: after the wave-6 reachability fix, blocker
      // (4) is scoped to draft invoices, so this is the shape that still blocks.
      return row!.id;
    });

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'ORPHANED_CONTRACT_SOURCE', status: 409, details: { lineIds: [orphanLineId] },
    });
  });

  it('(4) the SAME legacy orphan on an ISSUED invoice does NOT block — the escape hatch stays reachable', async () => {
    // ESCAPE-HATCH REACHABILITY (wave-6 review). Migration 2026-09-02-a RAISEs a
    // warning for exactly these rows: contract-source lines whose contract_lines
    // row was deleted before the durable column existed. They live on invoices
    // that were issued years ago and can never be edited or deleted. When
    // blocker (4) ignored invoice status, ONE such line 409'd EVERY active
    // contract in the org forever — so the pre-wave-2 legacy orgs the hatch was
    // built for were precisely the ones that could never reach it.
    //
    // Lines on a non-draft invoice are already BILLED: no money can be restranded
    // by restamping the contract, because the invoice carries its own currency
    // snapshot and is immutable. The safety property blocker (4) exists to
    // protect — never restamp while unbilled money is attributable-in-doubt —
    // is fully preserved by scoping it to draft.
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');
    // Make the contract itself eligible; the orphan is the only thing under test.
    await withSystemDbAccessContext(() => removeContractLine(contractId, lineId, f.actor));

    // A real, ISSUED invoice — issued FIRST, then the legacy orphan is grafted
    // on by raw SQL, which is exactly how these rows came to exist (the
    // contract_lines row was deleted long after the invoice was issued).
    const draftId = await withSystemDbAccessContext(async () => {
      const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: 'USD' }, invActor(f));
      await addManualLine(inv.id, { description: 'Onboarding', quantity: 1, unitPrice: 100, taxable: false } as never, invActor(f));
      return inv.id;
    });
    const issuedId = (await withSystemDbAccessContext(() => issueInvoice(draftId, invActor(f)))).id;

    const orphanLineId = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(invoiceLines).values({
        invoiceId: issuedId, orgId: f.orgId, sourceType: 'contract',
        sourceId: '00000000-0000-4000-8000-00000000dead', sourceContractId: null,
        description: 'Legacy contract line', quantity: '1', unitPrice: '10.00',
        taxable: false, customerVisible: true, lineTotal: '10.00',
      }).returning({ id: invoiceLines.id });
      return row!.id;
    });

    // Precondition: the row really is the org-wide orphan shape blocker (4)
    // matches — otherwise this test would pass vacuously.
    const [issuedStatus] = await withSystemDbAccessContext(() => db
      .select({ status: invoices.status }).from(invoices).where(eq(invoices.id, issuedId)).limit(1));
    expect(issuedStatus!.status).not.toBe('draft');
    const [orphan] = await withSystemDbAccessContext(() => db
      .select({ sourceType: invoiceLines.sourceType, sourceContractId: invoiceLines.sourceContractId })
      .from(invoiceLines).where(eq(invoiceLines.id, orphanLineId)).limit(1));
    expect(orphan!.sourceType).toBe('contract');
    expect(orphan!.sourceContractId).toBeNull();

    const updated = await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f)));

    expect(updated.currencyCode).toBe('EUR');
    expect(updated.status).toBe('active');
    // The already-billed invoice keeps its own snapshot — no restamp of history.
    const [inv] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: invoices.currencyCode }).from(invoices).where(eq(invoices.id, issuedId)).limit(1));
    expect(inv!.currencyCode).toBe('USD');
  });

  it('(4) a legacy orphan on a VOID invoice does NOT block either', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');
    await withSystemDbAccessContext(() => removeContractLine(contractId, lineId, f.actor));

    const draftId = await withSystemDbAccessContext(async () => {
      const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: 'USD' }, invActor(f));
      await addManualLine(inv.id, { description: 'Onboarding', quantity: 1, unitPrice: 100, taxable: false } as never, invActor(f));
      return inv.id;
    });
    const issuedId = (await withSystemDbAccessContext(() => issueInvoice(draftId, invActor(f)))).id;
    await withSystemDbAccessContext(() => voidInvoice(issuedId, 'wave-6 reachability test', { reissue: false }, invActor(f)));

    await withSystemDbAccessContext(() => db.insert(invoiceLines).values({
      invoiceId: issuedId, orgId: f.orgId, sourceType: 'contract',
      sourceId: '00000000-0000-4000-8000-00000000beef', sourceContractId: null,
      description: 'Legacy contract line', quantity: '1', unitPrice: '10.00',
      taxable: false, customerVisible: true, lineTotal: '10.00',
    }));

    const updated = await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f)));
    expect(updated.currencyCode).toBe('EUR');
  });

  // -------------------------------------------------------------------------
  // Blocker (5): lineage proof
  // -------------------------------------------------------------------------
  it('(5a) a period row with invoice_id IS NULL → ORPHANED_BILLING_PERIOD', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    const periodId = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(contractBillingPeriods).values({
        contractId, orgId: f.orgId, periodStart: START_DATE, periodEnd: '2026-08-01', invoiceId: null,
      }).returning({ id: contractBillingPeriods.id });
      return row!.id;
    });

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'ORPHANED_BILLING_PERIOD', status: 409, details: { billingPeriodIds: [periodId] },
    });
  });

  it('(5b) a period row pointing at ANOTHER TENANT’s invoice → BROKEN_CONTRACT_LINEAGE', async () => {
    const f = await seedGateOrg('EUR');
    const other = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    // A real, ISSUED invoice belonging to a different partner+org entirely.
    const foreignDraft = await withSystemDbAccessContext(async () => {
      const inv = await createManualInvoice({ orgId: other.orgId, currencyCode: 'EUR' }, invActor(other));
      await addManualLine(inv.id, { description: 'x', quantity: 1, unitPrice: 10, taxable: false } as never, invActor(other));
      return inv.id;
    });
    // issueInvoice opens its own top-level transaction, so it must not share a
    // context with the seed above (the draft would still be uncommitted).
    const issued = await withSystemDbAccessContext(() => issueInvoice(foreignDraft, invActor(other)));
    const foreignInvoiceId = issued.id;
    await withSystemDbAccessContext(() => db.insert(contractBillingPeriods).values({
      contractId, orgId: f.orgId, periodStart: START_DATE, periodEnd: '2026-08-01', invoiceId: foreignInvoiceId,
    }));

    // Driven under a SYSTEM context so the foreign row is visible and the
    // tenancy clause (c) is what fires. Under an org-scoped context RLS hides
    // the row and the check degrades to ORPHANED_BILLING_PERIOD — also a
    // blocker, never a pass.
    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({
      code: 'BROKEN_CONTRACT_LINEAGE', status: 409, details: { invoiceIds: [foreignInvoiceId] },
    });
  });

  // -------------------------------------------------------------------------
  // The successful paths
  // -------------------------------------------------------------------------
  it('restamps an eligible LINE-LESS active contract and leaves schedule/status untouched', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');
    const before = (await withSystemDbAccessContext(() => db
      .select().from(contracts).where(eq(contracts.id, contractId)).limit(1)))[0]!;
    await withSystemDbAccessContext(() => removeContractLine(contractId, lineId, f.actor));

    const updated = await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f)));

    expect(updated.currencyCode).toBe('EUR');
    expect(updated.status).toBe('active');
    expect(updated.nextBillingAt).toBe(before.nextBillingAt);
    expect(updated.startDate).toBe(before.startDate);
    expect(updated.intervalMonths).toBe(before.intervalMonths);
    expect(updated.autoRenew).toBe(before.autoRenew);
  });

  it('restamps + reprices a catalog-only active contract atomically (reprice: true)', async () => {
    const f = await seedGateOrg('EUR');
    // Two price-book rows: the contract restamps USD -> EUR and every catalog
    // line must re-resolve from the EUR book, never be converted.
    const item = await withSystemDbAccessContext(async () => {
      const created = await createCatalogItemWithPrice({
        partnerId: f.partnerId, name: `W6 T14 endpoint ${Math.random().toString(36).slice(2, 8)}`,
        currencyCode: 'USD', unitPrice: '500.00',
      });
      await db.insert(catalogItemPrices).values({
        itemId: created.id, partnerId: f.partnerId, currencyCode: 'EUR', unitPrice: '450.00',
      });
      return created;
    });

    const contractId = await withSystemDbAccessContext(async () => {
      const c = await createContract({
        orgId: f.orgId, name: 'Catalog MSA', billingTiming: 'advance', intervalMonths: 1,
        startDate: START_DATE, currencyCode: 'USD',
      }, f.actor);
      await addContractLineToContract(c.id, {
        lineType: 'flat', description: 'Managed endpoint', catalogItemId: item.id,
      } as never, f.actor);
      await activateContract(c.id, f.actor, ACTIVATE_AT);
      return c.id;
    });

    const updated = await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', reprice: true, confirmActiveChange: true }, manageActor(f)));
    expect(updated.currencyCode).toBe('EUR');

    const [line] = await withSystemDbAccessContext(() => db
      .select({ unitPrice: contractLines.unitPrice }).from(contractLines)
      .where(eq(contractLines.contractId, contractId)).limit(1));
    expect(line!.unitPrice).toBe('450.00');
  });

  it('manual lines still require clearLines (CURRENCY_LOCKED 409) — the wave-2 rule is unchanged', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f),
    ))).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });

    const updated = await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f)));
    expect(updated.currencyCode).toBe('EUR');
  });

  it('HISTORY IS UNTOUCHED: issued invoices, their lines and billing periods are byte-for-byte identical after a restamp', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    const issuedId = gen.invoiceId!;
    await withSystemDbAccessContext(() => issueInvoice(issuedId, invActor(f)));

    const snapshot = async () => withSystemDbAccessContext(async () => ({
      invoice: (await db.select().from(invoices).where(eq(invoices.id, issuedId)).limit(1))[0],
      lines: await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, issuedId)).orderBy(invoiceLines.id),
      periods: await db.select().from(contractBillingPeriods)
        .where(eq(contractBillingPeriods.contractId, contractId)).orderBy(contractBillingPeriods.id),
    }));
    const before = await snapshot();

    const updated = await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f)));
    expect(updated.currencyCode).toBe('EUR');

    expect(await snapshot()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // Historical reissue edge
  // -------------------------------------------------------------------------
  it('voidInvoice(reissue: true) on a pre-restamp contract-sourced invoice now returns CURRENCY_MISMATCH', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    const issuedId = gen.invoiceId!;
    await withSystemDbAccessContext(() => issueInvoice(issuedId, invActor(f)));

    await withSystemDbAccessContext(() => changeContractCurrency(
      contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f)));

    await expect(withSystemDbAccessContext(() =>
      voidInvoice(issuedId, 'correction', { reissue: true }, invActor(f)),
    )).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });

    // The invoice is untouched — the guard fires BEFORE any mutation.
    const [still] = await withSystemDbAccessContext(() => db
      .select({ status: invoices.status }).from(invoices).where(eq(invoices.id, issuedId)).limit(1));
    expect(still!.status).toBe('sent');

    // Void WITHOUT reissue remains available (the documented operator path).
    const { invoice: voided } = await withSystemDbAccessContext(() =>
      voidInvoice(issuedId, 'correction', { reissue: false }, invActor(f)));
    expect(voided.status).toBe('void');
  });
});

// ---------------------------------------------------------------------------
// PRODUCER SERIALIZATION RACES (#3778, Task 14 Step 3)
//
// Eligibility is only meaningful if every producer of contract money is
// serialized against the restamp. Wave 6 makes three of them take the contract
// row lock that changeContractCurrency already held: generateDueInvoice (which
// opened with a plain unlocked SELECT), addContractLine (which joined the
// contract unlocked), and voidInvoice (whose authoritative reads happened
// entirely BEFORE its transaction opened).
//
// HARNESS. A dedicated postgres.js client pre-holds `contracts FOR UPDATE` —
// exactly what the restamp holds — the producer is started against the app
// pool, and `pg_blocking_pids` proves the producer is genuinely BLOCKED before
// the holder mutates and commits. `waitForBlockedContract` is the load-bearing
// assertion: a producer that reads the contract unlocked never blocks, so these
// tests TIME OUT on the pre-wave-6 code. They do not silently pass.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(clients.map((c) => c.end({ timeout: 1 })));
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, 'failed to close race client(s)');
}

async function waitForBlockedContract(what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await withSystemDbAccessContext(() => db.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
    `));
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: expected a lock-blocked backend within 10s — the producer read the contract ` +
        'WITHOUT taking its row lock, so it can interleave with an ACTIVE-contract restamp (#3778)'
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Runs `work` while a dedicated client holds `contracts FOR UPDATE` on
 * `contractId`, asserts `work` BLOCKS, then runs `holderAction` and commits,
 * then settles `work`. Returns the settled promise so the caller can assert on
 * either fulfilment or rejection.
 */
async function raceUnderContractLock<T>(
  contractId: string, what: string,
  work: () => Promise<T>,
  holderAction: (tx: Sql) => Promise<void>,
): Promise<PromiseSettledResult<T>> {
  const lockHeld = deferred<void>();
  const release = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<unknown> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`SELECT id FROM public.contracts WHERE id = ${contractId} FOR UPDATE`;
      lockHeld.resolve();
      await release.promise;
      await holderAction(tx as unknown as Sql);
    });
    await lockHeld.promise;

    const running = work();
    // Swallow-nothing: attach a no-op catch so an early rejection cannot become
    // an unhandled rejection while we are still waiting on the lock probe.
    const settled = running.then(
      (value) => ({ status: 'fulfilled', value }) as PromiseSettledResult<T>,
      (reason) => ({ status: 'rejected', reason }) as PromiseSettledResult<T>,
    );
    await waitForBlockedContract(what);
    release.resolve();
    await holderWork;
    return await settled;
  } finally {
    release.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    await closeRaceClients(holder);
  }
}

describe.runIf(RUN)('ACTIVE-contract restamp — producer serialization races (#3778)', () => {
  it('(R1) generator WINS: it commits an old-currency draft and the change then rejects', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    // The holder plays the generator: it owns the contract lock and commits a
    // USD draft + its period claim while the changer is queued behind it.
    const outcome = await raceUnderContractLock(
      contractId,
      'changeContractCurrency vs a generating billing run',
      () => withSystemDbAccessContext(() => changeContractCurrency(
        contractId, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor(f))),
      async (tx) => {
        const [inv] = await tx`
          INSERT INTO public.invoices (partner_id, org_id, status, currency_code)
          VALUES (${f.partnerId}, ${f.orgId}, 'draft', 'USD') RETURNING id`;
        await tx`
          INSERT INTO public.invoice_lines
            (invoice_id, org_id, source_type, source_contract_id, description, quantity, unit_price, taxable, customer_visible, line_total)
          VALUES (${inv!.id}, ${f.orgId}, 'contract', ${contractId}, 'Managed services', '1', '500.00', false, true, '500.00')`;
        await tx`
          INSERT INTO public.contract_billing_periods (contract_id, org_id, period_start, period_end, invoice_id)
          VALUES (${contractId}, ${f.orgId}, ${START_DATE}, '2026-08-01', ${inv!.id})`;
      },
    );

    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', status: 409,
    });
    // The stamp did NOT move — the change re-read under its own lock.
    expect(await contractCurrency(contractId)).toBe('USD');
  });

  it('(R2) change WINS: the generator BLOCKS, rereads the new stamp and generates in the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');

    const outcome = await raceUnderContractLock(
      contractId,
      'generateDueInvoice vs an ACTIVE-contract restamp',
      () => generate(contractId),
      async (tx) => {
        await tx`UPDATE public.contracts SET currency_code = 'EUR' WHERE id = ${contractId}`;
      },
    );

    expect(outcome.status).toBe('fulfilled');
    const result = (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof generate>>>).value;
    expect(result.generated).toBe(true);
    const [inv] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: invoices.currencyCode }).from(invoices)
      .where(eq(invoices.id, result.invoiceId!)).limit(1));
    // FORBIDDEN outcome asserted explicitly: a USD invoice committed after the
    // restamp, invisible to the restamp's own eligibility check.
    expect(inv!.currencyCode, 'billing run stamped the OLD currency after the restamp committed').not.toBe('USD');
    expect(inv!.currencyCode).toBe('EUR');
  });

  it('(R3) add-line BLOCKS on the parent contract and then fails CURRENCY_MISMATCH against the new stamp', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');
    const draftId = await withSystemDbAccessContext(async () =>
      (await createManualInvoice({ orgId: f.orgId, currencyCode: 'USD' }, invActor(f))).id);

    const outcome = await raceUnderContractLock(
      contractId,
      'addContractLine vs an ACTIVE-contract restamp',
      () => withSystemDbAccessContext(() => addContractLine(draftId, {
        description: 'Managed services', quantity: '1', unitPrice: '500.00',
        taxable: false, catalogItemId: null, sourceId: lineId, contractId,
      }, invActor(f))),
      async (tx) => {
        await tx`UPDATE public.contracts SET currency_code = 'EUR' WHERE id = ${contractId}`;
      },
    );

    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });
    const [n] = await withSystemDbAccessContext(() => db
      .select({ n: sql<number>`count(*)::int` }).from(invoiceLines).where(eq(invoiceLines.invoiceId, draftId)));
    expect(n!.n, 'a cross-currency contract line landed on the draft').toBe(0);
  });

  it('(R4) void+reissue BLOCKS on the contract and then refuses to clone across the new stamp', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);
    const issuedId = gen.invoiceId!;
    await withSystemDbAccessContext(() => issueInvoice(issuedId, invActor(f)));

    const outcome = await raceUnderContractLock(
      contractId,
      'voidInvoice(reissue) vs an ACTIVE-contract restamp',
      () => withSystemDbAccessContext(() => voidInvoice(issuedId, 'correction', { reissue: true }, invActor(f))),
      async (tx) => {
        await tx`UPDATE public.contracts SET currency_code = 'EUR' WHERE id = ${contractId}`;
      },
    );

    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });
    // The whole void rolled back: the invoice is still issued and no draft clone exists.
    const [still] = await withSystemDbAccessContext(() => db
      .select({ status: invoices.status }).from(invoices).where(eq(invoices.id, issuedId)).limit(1));
    expect(still!.status).toBe('sent');
    const [clones] = await withSystemDbAccessContext(() => db
      .select({ n: sql<number>`count(*)::int` }).from(invoices)
      .where(and(eq(invoices.orgId, f.orgId), eq(invoices.replacesInvoiceId, issuedId))));
    expect(clones!.n).toBe(0);
  });

  it('(R5) deleting the contract line mid-flight cannot make an ineligible contract eligible', async () => {
    const f = await seedGateOrg('EUR');
    const { contractId, lineId } = await seedActiveContract(f, 'USD');
    const gen = await generate(contractId);   // an unissued draft -> ineligible
    expect(gen.generated).toBe(true);

    const outcome = await raceUnderContractLock(
      contractId,
      'changeContractCurrency vs concurrent contract-line deletion',
      () => withSystemDbAccessContext(() => changeContractCurrency(
        contractId, { currencyCode: 'EUR', confirmActiveChange: true }, manageActor(f))),
      async (tx) => {
        // Exactly what removeContractLine does on an ACTIVE contract — and what
        // used to erase the only evidence the eligibility check keyed on.
        await tx`DELETE FROM public.contract_lines WHERE id = ${lineId}`;
      },
    );

    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', status: 409,
    });
    expect(await contractCurrency(contractId)).toBe('USD');
  });
});
