/**
 * B2 regression: contract-generated invoices inherit the CONTRACT's stamped
 * currency, never the org's current setting (spec §5 snapshots rule), and
 * `addContractLine` rejects a contract-line landing on an invoice in a
 * different currency (first source-vs-header validation; time entries/parts
 * plug into the same check in wave 4).
 *
 * Runs under vitest.integration.config.ts against a real Postgres.
 * No fixture memoization: integration/setup.ts TRUNCATEs partners/organizations
 * before every test, so each test re-seeds fresh.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test (same rationale as invoiceCurrencyStamping).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, contracts, contractLines, invoices } from '../../db/schema';
import {
  createContract, addContractLineToContract, activateContract, generateDueInvoice,
  type ContractActorT
} from '../../services/contractService';
import { addContractLine, issueInvoice } from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

/** USD partner + EUR org: every assertion below is that the CONTRACT's stamp wins. */
async function seedOrg(): Promise<{ actor: ContractActorT; orgId: string; partnerId: string }> {
  const sfx = Math.random().toString(36).slice(2, 8);
  let orgId = ''; let partnerId = '';
  await withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `CC ${sfx}`, slug: `cc-${sfx}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: 'CCOrg', slug: `cco-${sfx}`, currencyCode: 'EUR'
    }).returning({ id: organizations.id });
    orgId = o!.id;
  });
  // userId null: createdBy is nullable on contracts and invoices alike.
  return { actor: { userId: null as unknown as string, partnerId, accessibleOrgIds: [orgId] }, orgId, partnerId };
}

describe.runIf(RUN)('contract→invoice currency propagation (B2)', () => {
  it('generateDueInvoice stamps the CONTRACT currency, surviving an org currency change; issue keeps it', async () => {
    const { actor, orgId } = await seedOrg();

    // Contract stamps the org currency at creation (Task 4).
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Euro Managed', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    expect(c.currencyCode).toBe('EUR');
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed services', unitPrice: '100.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T00:00:00Z')));

    // Flip the ORG's currency after the contract was stamped: generation must
    // copy the CONTRACT's snapshot (EUR), never re-read the org's setting.
    await withSystemDbAccessContext(() =>
      db.update(organizations).set({ currencyCode: 'GBP' }).where(eq(organizations.id, orgId)));

    // Mirror contractWorker.ts: generation runs in a fresh system context.
    const res = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T06:00:00Z'))));
    expect(res.generated).toBe(true);

    const [draft] = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.id, res.invoiceId!)).limit(1));
    expect(draft!.status).toBe('draft');
    expect(draft!.currencyCode).toBe('EUR');
    // EUR-rounded (2-decimal) totals agree with the header currency.
    expect(draft!.subtotal).toBe('100.00');
    expect(draft!.total).toBe('100.00');

    // Full B1+B2 regression: issuing must keep the stamped EUR header.
    const issued = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, res.actor!)));
    expect(issued.status).toBe('sent');
    expect(issued.currencyCode).toBe('EUR');
    expect(issued.total).toBe('100.00');
  });

  it('addContractLine rejects a contract line landing on an invoice in a different currency', async () => {
    const { actor, orgId, partnerId } = await seedOrg();

    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Euro Contract', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    expect(c.currencyCode).toBe('EUR');
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed services', unitPrice: '100.00', taxable: false
    }, actor));
    const [line] = await withSystemDbAccessContext(() =>
      db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, c.id)).limit(1));

    // Hand-forge a GBP draft on the same org.
    const gbpDraftId = await withSystemDbAccessContext(async () => {
      const [inv] = await db.insert(invoices).values({
        partnerId, orgId, status: 'draft', currencyCode: 'GBP'
      }).returning({ id: invoices.id });
      return inv!.id;
    });

    await expect(
      withSystemDbAccessContext(() => addContractLine(gbpDraftId, {
        description: 'Managed services', quantity: '1', unitPrice: '100.00', taxable: false,
        sourceId: line!.id
      }, actor))
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });

    // Sanity: the guard is comparing currencies, not blocking contract lines wholesale.
    await expect(
      withSystemDbAccessContext(() => addContractLine(gbpDraftId, {
        description: 'Managed services', quantity: '1', unitPrice: '100.00', taxable: false,
        sourceId: line!.id
      }, actor))
    ).rejects.toBeInstanceOf(InvoiceServiceError);
  });
});
