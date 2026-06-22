/**
 * Worker-level integration test: renewal pre-pass before billing sweep.
 *
 * Verifies that when the worker orchestration runs (renewal then billing),
 * an auto-renew contract whose next bill lands at the term boundary:
 *   1. has its end_date extended (not expired) by the renewal pre-pass, and
 *   2. has a billing period claimed (billed, not expired) by the billing sweep.
 *
 * contractEvents is a fire-and-forget BullMQ side effect — mock it so the
 * test doesn't require a live BullMQ connection (mirrors contractRenewal.integration.test.ts).
 */
import { vi } from 'vitest';
vi.mock('../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));

import { it, expect } from 'vitest';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { partners, organizations, contracts, contractLines, contractBillingPeriods } from '../db/schema';
import { eq } from 'drizzle-orm';
import { runContractRenewalSweep } from '../services/contractRenewal';
import { runContractBillingSweep } from './contractWorker';

it.runIf(!!process.env.DATABASE_URL)(
  'renewal before billing keeps an at-boundary auto-renew contract billing instead of expiring',
  async () => {
    const sfx = Math.random().toString(36).slice(2, 8);

    const { contractId } = await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({
        name: `W ${sfx}`, slug: `w-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });

      const [o] = await db.insert(organizations).values({
        partnerId: p!.id, name: 'WOrg', slug: `wo-${sfx}`
      }).returning({ id: organizations.id });

      // Contract whose next bill lands exactly at end_date — the renewal sweep
      // must extend end_date BEFORE billing so it bills rather than expires.
      const [c] = await db.insert(contracts).values({
        partnerId: p!.id,
        orgId: o!.id,
        name: 'Boundary',
        status: 'active',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-07-01',
        endDate: '2027-07-01',
        nextBillingAt: '2027-07-01',
        autoRenew: true,
        renewalTermMonths: 12,
        renewalNoticeDays: 30,
      }).returning({ id: contracts.id });

      await db.insert(contractLines).values({
        contractId: c!.id, orgId: o!.id, lineType: 'flat', description: 'svc', unitPrice: '100.00'
      });

      return { contractId: c!.id };
    });

    const asOf = new Date('2027-07-01T05:00:00Z');

    // Run the same orchestration the BullMQ job runs.
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(asOf)));
    await runContractBillingSweep(asOf);

    // Contract must still be active with end_date extended by the renewal term.
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ status: contracts.status, endDate: contracts.endDate })
        .from(contracts)
        .where(eq(contracts.id, contractId))
    );
    expect(after!.status).toBe('active');
    expect(after!.endDate).toBe('2028-07-01');

    // A billing period must have been claimed (i.e. the sweep billed it, not expired it).
    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId))
    );
    expect(periods.length).toBe(1);
  },
  30000
);
