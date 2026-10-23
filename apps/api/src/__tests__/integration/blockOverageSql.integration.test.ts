/**
 * #9828 W1 — blockOverageLineIdsCte against REAL Postgres. The SQL must flag
 * exactly the lines loadBilledFinalTermValues (the TypeScript consume-once
 * rule) excludes as hour-block overage: the plain overage line, the overage
 * line copied onto a reissued invoice (its hour period still points at the
 * voided original), ONE of a coincidentally identical pair, and never the
 * block fee or any other contract line.
 *
 * The cross-check: for the period invoice, Σ contract lines − Σ CTE lines must
 * equal the billed value loadBilledFinalTermValues computes.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { sqlUuidArray } from '../../db/sqlValues';
import { invoiceLines, invoices } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { loadBilledFinalTermValues } from '../../services/contractBilledFinalTerm';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';
import { blockOverageLineIdsCte } from '../../services/businessReports/blockOverageSql';
import { seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
const at = (d: string) => new Date(`${d}T06:00:00Z`);
const run = (contractId: string, d: string) => withSystemDbAccessContext(() => generateDueInvoice(contractId, at(d)));
const partnerCtx = (f: BlockFixture) =>
  ({ scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], currentPartnerId: f.partnerId, userId: null }) as never;

/** The CTE's line ids for these invoices, read under the fixture partner's RLS context. */
async function cteLineIds(f: BlockFixture, invoiceIds: string[]): Promise<string[]> {
  const rows = await withDbAccessContext(partnerCtx(f), () => db.execute(sql`
    WITH RECURSIVE ${blockOverageLineIdsCte({ invoiceIds: sql`SELECT i.id FROM invoices i WHERE i.id = ANY(${sqlUuidArray(invoiceIds)})` })}
    SELECT line_id::text AS line_id FROM block_overage_lines ORDER BY line_id`));
  return (rows as unknown as { line_id: string }[]).map((r) => r.line_id);
}

async function contractLinesOf(invoiceId: string) {
  return withSystemDbAccessContext(() => db.select({
    id: invoiceLines.id, quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice, lineTotal: invoiceLines.lineTotal,
  }).from(invoiceLines).where(and(eq(invoiceLines.invoiceId, invoiceId), isNull(invoiceLines.parentLineId))));
}

const cents = (v: string) => Math.round(Number(v) * 100);

/** July fee, 11 h logged (1 over), then the August invoice: fee + July overage. */
async function seedAugustWithOverage(): Promise<{ f: BlockFixture; augustInvoiceId: string }> {
  const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-12-01' });
  await run(f.contractId, '2026-07-01');
  await seedEntry(f, { minutes: 660, endedAt: '2026-07-20T12:00:00Z' });
  const aug = await run(f.contractId, '2026-08-01');
  expect(aug.generated).toBe(true);
  return { f, augustInvoiceId: aug.invoiceId! };
}

describe('blockOverageLineIdsCte — real Postgres (#9828 W1)', () => {
  runDb('flags the overage line, keeps the fee, and consumes once: one of an identical pair stays', async () => {
    const { f, augustInvoiceId } = await seedAugustWithOverage();
    const before = await contractLinesOf(augustInvoiceId);
    const overage = before.find((l) => l.unitPrice === '150.00')!;
    const fee = before.find((l) => l.unitPrice === '1000.00')!;
    expect(overage).toBeDefined();
    expect(fee).toBeDefined();

    // A coincidentally identical second line (same contract line, hours, rate).
    const [twin] = await getTestDb().insert(invoiceLines).values({
      invoiceId: augustInvoiceId, orgId: f.orgId, sourceType: 'contract', sourceId: f.blockLineId, sourceContractId: f.contractId,
      description: 'Identical twin', quantity: overage.quantity, unitPrice: overage.unitPrice, lineTotal: overage.lineTotal,
      taxable: true, sortOrder: 99,
    } as never).returning({ id: invoiceLines.id });

    const flagged = await cteLineIds(f, [augustInvoiceId]);
    expect(flagged).toHaveLength(1);
    expect([overage.id, twin!.id]).toContain(flagged[0]);
    expect(flagged).not.toContain(fee.id);

    // Same answer as the TypeScript rule: Σ contract lines − Σ flagged = the billed value.
    const all = await contractLinesOf(augustInvoiceId);
    const sumAll = all.reduce((t, l) => t + cents(l.lineTotal), 0);
    const sumFlagged = all.filter((l) => flagged.includes(l.id)).reduce((t, l) => t + cents(l.lineTotal), 0);
    const ts = await withSystemDbAccessContext(() => loadBilledFinalTermValues([f.contractId], '2026-08-15'));
    expect(ts.get(f.contractId)).toEqual({ cents: sumAll - sumFlagged });
    expect(sumAll - sumFlagged).toBe(cents('1000.00') + cents('150.00')); // fee + the twin, never the overage
  });

  runDb('flags the overage line on a reissued invoice (the hour period points at the voided original)', async () => {
    const { f, augustInvoiceId } = await seedAugustWithOverage();
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    await withSystemDbAccessContext(() => issueInvoice(augustInvoiceId, actor));
    await withSystemDbAccessContext(() => voidInvoice(augustInvoiceId, 'correction', { reissue: true }, actor));
    const [original] = await withSystemDbAccessContext(() =>
      db.select({ replacedBy: invoices.replacedByInvoiceId }).from(invoices).where(eq(invoices.id, augustInvoiceId)));
    const reissuedId = original!.replacedBy!;
    expect(reissuedId).toBeTruthy();

    const lines = await contractLinesOf(reissuedId);
    const overage = lines.find((l) => l.unitPrice === '150.00')!;
    expect(await cteLineIds(f, [reissuedId])).toEqual([overage.id]);

    const ts = await withSystemDbAccessContext(() => loadBilledFinalTermValues([f.contractId], '2026-08-15'));
    expect(ts.get(f.contractId)).toEqual({ cents: cents('1000.00') });
  });

  runDb('flags nothing on an invoice with no closed hour period (July: fee only)', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-12-01' });
    const july = await run(f.contractId, '2026-07-01');
    expect(await cteLineIds(f, [july.invoiceId!])).toEqual([]);
  });

  runDb('another partner never sees the lines: the CTE reads nothing under a foreign RLS context', async () => {
    const { augustInvoiceId } = await seedAugustWithOverage();
    const other = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01' });
    expect(await cteLineIds(other, [augustInvoiceId])).toEqual([]);
  });
});
