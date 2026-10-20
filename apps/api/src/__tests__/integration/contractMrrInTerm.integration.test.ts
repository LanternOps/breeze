/**
 * #9220 (spec #9218 trap T8), real DB: generateDueInvoice flips an ADVANCE
 * contract to 'expired' the moment it bills the final period. The partner
 * dashboard MRR rollup must keep counting that paid, still-served final term
 * until end_date — at the amount billed — and drop it on end_date.
 *
 * Read under a PARTNER db context, as routes/partner.ts runs it, so the RLS
 * reads of contract_billing_periods / invoices / invoice_lines /
 * contract_hour_periods are exercised too.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contractLines, contracts, invoiceLines } from '../../db/schema';
import { generateDueInvoice, summarizeActiveContractMrrByOrg } from '../../services/contractService';
import { seedBlockFixture, seedEntry } from './hourBlockFixtures';

const at = (d: string) => new Date(`${d}T06:00:00Z`);
const run = (contractId: string, d: string) => withSystemDbAccessContext(() => generateDueInvoice(contractId, at(d)));
const partnerCtx = (partnerId: string, orgIds: string[]) =>
  ({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null }) as never;
const mrrAt = (f: { partnerId: string; orgId: string }, d: string) =>
  withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => summarizeActiveContractMrrByOrg([f.orgId], at(d)));
const statusOf = async (contractId: string) => {
  const [c] = await withSystemDbAccessContext(() => db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)));
  return c!.status as string;
};

describe('summarizeActiveContractMrrByOrg — billed final term (real DB) #9220', () => {
  it('an annual contract billed in advance counts after its only invoice flips it to expired, until end_date', async () => {
    // A block fixture re-shaped into a plain annual flat contract.
    const f = await seedBlockFixture({ timing: 'advance', startDate: '2026-01-01', nextBillingAt: '2026-01-01', endDate: '2027-01-01' });
    await withSystemDbAccessContext(async () => {
      await db.update(contracts).set({ intervalMonths: 12 }).where(eq(contracts.id, f.contractId));
      await db.update(contractLines).set({
        lineType: 'flat', unitPrice: '1200.00', includedQuantity: null, overageMode: null, overageUnitPrice: null,
        rolloverPolicy: null, hourBlockFirstPeriodStart: null,
      } as never).where(eq(contractLines.id, f.blockLineId));
    });

    expect(await mrrAt(f, '2026-01-01')).toEqual(new Map([[f.orgId, [{ currencyCode: 'USD', amount: '100.00' }]]]));

    const r = await run(f.contractId, '2026-01-01');
    expect(r.generated).toBe(true);
    // The premise: billing the only period expires the contract immediately.
    expect(await statusOf(f.contractId)).toBe('expired');

    expect((await mrrAt(f, '2026-01-01')).get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '100.00' }]);
    expect((await mrrAt(f, '2026-06-15')).get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '100.00' }]);
    expect((await mrrAt(f, '2026-12-31')).get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '100.00' }]);
    // end_date is exclusive: the term is over.
    expect((await mrrAt(f, '2027-01-01')).has(f.orgId)).toBe(false);
  });

  it('a block-of-hours final term counts its billed fee — not 0 from the retired block, not the earlier period\'s hours overage', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-09-01' });
    await run(f.contractId, '2026-07-01');                                       // July fee
    await seedEntry(f, { minutes: 660, endedAt: '2026-07-20T12:00:00Z' });      // 11 h, 1 over
    const r = await run(f.contractId, '2026-08-01');                             // August fee + July overage, expires
    expect(r.generated).toBe(true);
    expect(await statusOf(f.contractId)).toBe('expired');
    const lines = await withSystemDbAccessContext(() =>
      db.select({ lineTotal: invoiceLines.lineTotal }).from(invoiceLines).where(eq(invoiceLines.invoiceId, r.invoiceId!)));
    expect(lines.map((l) => l.lineTotal).sort()).toEqual(['1000.00', '150.00']);
    const [block] = await withSystemDbAccessContext(() =>
      db.select({ retiredAt: contractLines.hourBlockRetiredAt }).from(contractLines).where(eq(contractLines.id, f.blockLineId)));
    expect(block!.retiredAt).not.toBeNull();

    expect((await mrrAt(f, '2026-08-15')).get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '1000.00' }]);
    expect((await mrrAt(f, '2026-09-01')).has(f.orgId)).toBe(false);
  });
});
