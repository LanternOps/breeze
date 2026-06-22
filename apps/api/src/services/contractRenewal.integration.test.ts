import { describe, it, expect, vi } from 'vitest';

// Lifecycle events are fire-and-forget BullMQ side effects, not the correctness
// under test here. Mock the emitter so these DB-correctness tests don't depend
// on (and block on) a reachable BullMQ connection — mirrors the precedent in
// invoiceService.issue.integration.test.ts. We still assert the emitter was
// CALLED with contract.auto_renewed, which is the behaviour we care about.
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));

import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { partners, organizations, contracts, contractLines, contractRenewalNotices } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { runContractRenewalSweep } from './contractRenewal';
import { emitContractEvent } from './contractEvents';

async function seedAutoRenew(opts: { nextBillingAt: string; endDate: string; noticeDays?: number }) {
  const sfx = Math.random().toString(36).slice(2, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `R ${sfx}`, slug: `r-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'ROrg', slug: `ro-${sfx}` }).returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Renew Me', status: 'active', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: opts.endDate, nextBillingAt: opts.nextBillingAt,
      autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: opts.noticeDays ?? 30
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({ contractId: c!.id, orgId: o!.id, lineType: 'flat', description: 'svc', unitPrice: '500.00' });
    return { orgId: o!.id, contractId: c!.id };
  });
}

describe('runContractRenewalSweep', () => {
  it.runIf(!!process.env.DATABASE_URL)('extends the term when the next bill would expire, logs a renewed notice, idempotent', async () => {
    // Next bill lands exactly at endDate ⇒ would expire ⇒ must renew first.
    const { contractId } = await seedAutoRenew({ nextBillingAt: '2027-07-01', endDate: '2027-07-01' });

    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-07-01T05:00:00Z'))));

    const [after] = await withSystemDbAccessContext(() =>
      db.select({ endDate: contracts.endDate, status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)));
    expect(after!.endDate).toBe('2028-07-01');
    expect(after!.status).toBe('active');

    // The auto_renewed lifecycle event must have been emitted for this contract.
    expect(emitContractEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'contract.auto_renewed', contractId }));

    const renewed = await withSystemDbAccessContext(() =>
      db.select().from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, contractId), eq(contractRenewalNotices.kind, 'renewed'))));
    expect(renewed).toHaveLength(1);

    // Second run: no further extension, no duplicate notice.
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-07-01T05:00:00Z'))));
    const [after2] = await withSystemDbAccessContext(() =>
      db.select({ endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
    expect(after2!.endDate).toBe('2028-07-01');
    const renewed2 = await withSystemDbAccessContext(() =>
      db.select().from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, contractId), eq(contractRenewalNotices.kind, 'renewed'))));
    expect(renewed2).toHaveLength(1);
  });

  it.runIf(!!process.env.DATABASE_URL)('emits a single advance notice inside the window and does not extend', async () => {
    // 16 days before endDate; not yet at the billing boundary.
    const { contractId } = await seedAutoRenew({ nextBillingAt: '2027-08-01', endDate: '2027-07-15' });
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-06-29T05:00:00Z'))));
    const advance = await withSystemDbAccessContext(() =>
      db.select().from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, contractId), eq(contractRenewalNotices.kind, 'advance'))));
    expect(advance).toHaveLength(1);
    const [c] = await withSystemDbAccessContext(() => db.select({ endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
    expect(c!.endDate).toBe('2027-07-15'); // unchanged
  });

  it.runIf(!!process.env.DATABASE_URL)('does nothing for a contract with auto_renew = false', async () => {
    const { contractId } = await seedAutoRenew({ nextBillingAt: '2027-07-01', endDate: '2027-07-01' });
    await withSystemDbAccessContext(() => db.update(contracts).set({ autoRenew: false }).where(eq(contracts.id, contractId)));
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-07-01T05:00:00Z'))));
    const [c2] = await withSystemDbAccessContext(() => db.select({ endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
    expect(c2!.endDate).toBe('2027-07-01'); // not extended — billing sweep will expire it normally
  });
});
