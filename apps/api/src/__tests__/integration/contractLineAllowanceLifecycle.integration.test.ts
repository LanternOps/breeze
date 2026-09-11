/**
 * #3205 W04 (#4607) lifecycle: what happens to a generated overage line after
 * generation — void/reissue, issue, and the currency restamp refusal — against
 * real Postgres as breeze_app.
 *
 * The reissue assertions are the proof of decision 8: the overage is a TOP-LEVEL
 * sibling, so the existing clone (which copies sourceType/sourceId/
 * sourceContractId/quantity/unitPrice/costBasis/taxable/customerVisible/
 * lineTotal/sortOrder verbatim for parentLineId IS NULL rows) needed no change.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractLines, contracts, devices, invoiceLines, invoices, organizations, partners, sites, users,
} from '../../db/schema';
import { changeContractCurrency, generateDueInvoice, type ContractActorT } from '../../services/contractService';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';

const SWEEP_AT = new Date('2026-07-01T06:00:00Z');

async function seedOver(): Promise<{ orgId: string; partnerId: string; contractId: string; lineId: string; actor: ContractActorT }> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `LC ${sfx}`, slug: `lc-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'LCOrg', slug: `lc-${sfx}`, taxRate: '0.10000' })
      .returning({ id: organizations.id });
    // issueInvoice stamps created_by; a real user keeps that FK resolvable.
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `lc-${sfx}@x.io`, name: 'LC', status: 'active' })
      .returning({ id: users.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `HQ-${sfx}` }).returning({ id: sites.id });
    await db.insert(devices).values(Array.from({ length: 26 }, (_, i) => ({
      orgId: o!.id, siteId: s!.id, agentId: `lc-${sfx}-${i}`, hostname: `lc-${i}`, status: 'online' as const,
      deviceRole: 'workstation', osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0',
    })));
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Over contract', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
      createdBy: u!.id,
    }).returning({ id: contracts.id });
    const [l] = await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: 'per_device', description: 'Endpoints',
      unitPrice: '10.00', taxable: true,
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
    }).returning({ id: contractLines.id });
    return {
      orgId: o!.id, partnerId: p!.id, contractId: c!.id, lineId: l!.id,
      actor: { userId: u!.id, partnerId: p!.id, accessibleOrgIds: [o!.id] },
    };
  });
}

const readLines = (invoiceId: string) => withSystemDbAccessContext(() => db.select({
  description: invoiceLines.description, quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice,
  lineTotal: invoiceLines.lineTotal, parentLineId: invoiceLines.parentLineId, sourceId: invoiceLines.sourceId,
  sourceContractId: invoiceLines.sourceContractId, sortOrder: invoiceLines.sortOrder,
  taxable: invoiceLines.taxable, costBasis: invoiceLines.costBasis, customerVisible: invoiceLines.customerVisible,
}).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));

describe('overage line lifecycle (real DB) #3205 W04', () => {
  it('issues an invoice carrying a base line and its overage sibling on one source id', async () => {
    const f = await seedOver();
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    // Two invoice lines share one contract-line source id — already a supported
    // shape (issueInvoice/voidInvoice dedupe source ids), and contract lines
    // carry no billing_status, so there is no double-claim hazard.
    const before = await readLines(res.invoiceId!);
    expect(before.map((l) => l.sourceId)).toEqual([f.lineId, f.lineId]);
    await withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, f.actor as never));
    const [inv] = await withSystemDbAccessContext(() => db
      .select({ status: invoices.status, total: invoices.total })
      .from(invoices).where(eq(invoices.id, res.invoiceId!)).limit(1));
    expect(inv).toMatchObject({ status: 'sent', total: '288.20' });
  });

  it('void-with-reissue clones BOTH lines as top-level, with lineage and order preserved', async () => {
    const f = await seedOver();
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    await withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, f.actor as never));
    const original = await readLines(res.invoiceId!);

    const reissued = await withSystemDbAccessContext(() => voidInvoice(res.invoiceId!, 'wrong count', { reissue: true }, f.actor as never));
    const draftId = reissued.invoice.id;
    const clone = await readLines(draftId);

    expect(clone).toHaveLength(2);
    expect(clone.every((l) => l.parentLineId === null)).toBe(true);   // decision 8
    expect(clone.map((l) => [l.description, l.quantity, l.unitPrice, l.lineTotal, l.taxable, l.costBasis, l.customerVisible]))
      .toEqual(original.map((l) => [l.description, l.quantity, l.unitPrice, l.lineTotal, l.taxable, l.costBasis, l.customerVisible]));
    expect(clone.map((l) => l.sourceId)).toEqual([f.lineId, f.lineId]);
    expect(clone.map((l) => l.sourceContractId)).toEqual([f.contractId, f.contractId]);
    expect(clone[1]!.sortOrder).toBe(clone[0]!.sortOrder + 1);
    const [draft] = await withSystemDbAccessContext(() => db
      .select({ total: invoices.total }).from(invoices).where(eq(invoices.id, draftId)).limit(1));
    expect(draft!.total).toBe('288.20');
  });

  it('PINS the accepted pre-existing limitation: removing the contract line wedges the reissued draft', async () => {
    // Not a W04 behaviour change — issueInvoice has always thrown 409
    // SOURCE_NOT_FOUND for a source_id whose contract line is gone
    // (invoiceService.ts:1194-1199), and removeContractLine is permitted on
    // active contracts. W04 merely doubles the lines carrying the dead id.
    const f = await seedOver();
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    await withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, f.actor as never));
    const reissued = await withSystemDbAccessContext(() => voidInvoice(res.invoiceId!, 'redo', { reissue: true }, f.actor as never));
    await withSystemDbAccessContext(() => db.delete(contractLines).where(eq(contractLines.id, f.lineId)));
    await expect(withSystemDbAccessContext(() => issueInvoice(reissued.invoice.id, f.actor as never)))
      .rejects.toMatchObject({ status: 409, code: 'SOURCE_NOT_FOUND' });
  });

  it('changeContractCurrency refuses while a bill-mode rate is stamped, and proceeds once it is cleared', async () => {
    const f = await seedOver();
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'draft' }).where(eq(contracts.id, f.contractId)));
    // The message pins Task 5's overage-rate refusal: the pre-existing non-catalog
    // refusal also returns CURRENCY_LOCKED, so the code alone would not discriminate.
    await expect(withSystemDbAccessContext(() => changeContractCurrency(f.contractId, { currencyCode: 'EUR', reprice: true }, f.actor)))
      .rejects.toMatchObject({ status: 409, code: 'CURRENCY_LOCKED', message: expect.stringContaining('overage rate') });
    await withSystemDbAccessContext(() => db.update(contractLines)
      .set({ includedQuantity: null, overageMode: null, overageUnitPrice: null })
      .where(eq(contractLines.id, f.lineId)));
    await expect(withSystemDbAccessContext(() => changeContractCurrency(f.contractId, { currencyCode: 'EUR', clearLines: true }, f.actor)))
      .resolves.toMatchObject({ currencyCode: 'EUR' });
  });
});
