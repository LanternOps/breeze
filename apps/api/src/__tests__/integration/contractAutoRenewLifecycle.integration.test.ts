/**
 * #9243, real DB: an auto-renew contract must renew across its final period.
 *
 * The bug: generateDueInvoice's step 4 expired the contract on its final billing
 * run (the NEXT period starts on/after end_date), while the renewal sweep only
 * extended once the DUE period started on/after end_date, which billing never
 * let happen. These tests drive the REAL daily job (runBillingSweepJob: renewal
 * sweep, then billing) day by day across the final period, from the state
 * billing itself leaves behind, instead of seeding a hand-made boundary state.
 *
 * The design (see contractMath.renewalExtension): the term renews ON end_date
 * (when the advance notice said it would), never a billing interval early, and
 * billing never expires an auto-renewing contract.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/notificationSenders/inAppSender', () => ({ sendInAppNotification: vi.fn().mockResolvedValue(undefined) }));

import { and, asc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contractRenewalNotices, contracts, invoices, organizations, partners,
} from '../../db/schema';
import { generateDueInvoice, summarizeActiveContractMrrByOrg } from '../../services/contractService';
import { addDaysISO } from '../../services/contractMath';
import { runBillingSweepJob } from '../../jobs/contractWorker';
import { seedBlockFixture } from './hourBlockFixtures';

const at = (d: string) => new Date(`${d}T05:00:00Z`);

interface Seed {
  billingTiming: 'advance' | 'arrears';
  intervalMonths?: number;
  startDate?: string;
  endDate: string;
  nextBillingAt: string;
  autoRenew: boolean;
  renewalTermMonths: number | null;
}

async function seedContract(s: Seed) {
  const sfx = Math.random().toString(36).slice(2, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `AR ${sfx}`, slug: `ar-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'AROrg', slug: `aro-${sfx}` }).returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Auto renew', status: 'active', billingTiming: s.billingTiming,
      intervalMonths: s.intervalMonths ?? 1, startDate: s.startDate ?? '2026-01-01', endDate: s.endDate,
      nextBillingAt: s.nextBillingAt, currencyCode: 'USD',
      autoRenew: s.autoRenew, renewalTermMonths: s.renewalTermMonths, renewalNoticeDays: 30,
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({ contractId: c!.id, orgId: o!.id, lineType: 'flat', description: 'svc', unitPrice: '500.00' });
    return { partnerId: p!.id, orgId: o!.id, contractId: c!.id };
  });
}

/** Run the daily job once per calendar day in [from, to] (inclusive). */
async function runDaily(from: string, to: string, onDay?: (day: string) => Promise<void>) {
  for (let d = from; d <= to; d = addDaysISO(d, 1)) {
    await runBillingSweepJob(at(d));
    if (onDay) await onDay(d);
  }
}

const contractRow = async (id: string) => {
  const [c] = await withSystemDbAccessContext(() => db.select({
    status: contracts.status, endDate: contracts.endDate, nextBillingAt: contracts.nextBillingAt,
  }).from(contracts).where(eq(contracts.id, id)));
  return { ...c!, status: c!.status as string };
};

const billedPeriods = (id: string) => withSystemDbAccessContext(() => db.select({
  periodStart: contractBillingPeriods.periodStart, invoiceId: contractBillingPeriods.invoiceId,
}).from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, id)).orderBy(asc(contractBillingPeriods.periodStart)));

const invoiceCount = async (orgId: string) =>
  (await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, orgId)))).length;

const notices = (id: string, kind: 'advance' | 'renewed') => withSystemDbAccessContext(() => db.select({
  endDate: contractRenewalNotices.endDate,
}).from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, id), eq(contractRenewalNotices.kind, kind))));

/** Per-day check: still active and the term not yet extended. */
const notRenewedYet = (contractId: string, endDate: string) => async (day: string) => {
  const c = await contractRow(contractId);
  expect({ day, status: c.status, endDate: c.endDate }).toEqual({ day, status: 'active', endDate });
};

/** Exactly one invoice per billed period, every period claimed once, no stray drafts. */
async function expectOneInvoicePerPeriod(f: { orgId: string; contractId: string }, starts: string[]) {
  const periods = await billedPeriods(f.contractId);
  expect(periods.map((p) => p.periodStart)).toEqual(starts);
  expect(new Set(periods.map((p) => p.invoiceId)).size).toBe(starts.length);
  expect(await invoiceCount(f.orgId)).toBe(starts.length);
}

describe('auto-renew across the final period — real renewal → billing sequence (#9243)', () => {
  it('monthly ADVANCE: renews on end_date (not a period early), keeps billing, one invoice per period', async () => {
    // Nov is the second-to-last period; the job bills Nov, then Dec (the final one).
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-01', nextBillingAt: '2026-11-01', autoRenew: true, renewalTermMonths: 12 });

    await runDaily('2026-11-01', '2026-12-31', async (day) => {
      // Never renewed early: the term still ends 2027-01-01 every day before it.
      const c = await contractRow(f.contractId);
      expect({ day, status: c.status, endDate: c.endDate }).toEqual({ day, status: 'active', endDate: '2027-01-01' });
    });
    // After the final (Dec) invoice the contract is still active, pointer at end_date.
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2027-01-01', nextBillingAt: '2027-01-01' });
    // The advance notice went out inside its window, keyed on the real end date.
    expect(await notices(f.contractId, 'advance')).toEqual([{ endDate: '2027-01-01' }]);
    expect(await notices(f.contractId, 'renewed')).toEqual([]);

    // The final period is paid and served: it still counts in MRR (#9220).
    const mrr = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], currentPartnerId: f.partnerId, userId: null } as never,
      () => summarizeActiveContractMrrByOrg([f.orgId], at('2026-12-15')),
    );
    expect(mrr.get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '500.00' }]);

    await runDaily('2027-01-01', '2027-02-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2027-03-01' });
    expect(await notices(f.contractId, 'renewed')).toEqual([{ endDate: '2028-01-01' }]);
    await expectOneInvoicePerPeriod(f, ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  }, 120_000);

  it('monthly ARREARS: renews on end_date, bills the final period and the first renewed one', async () => {
    const f = await seedContract({ billingTiming: 'arrears', endDate: '2027-01-01', nextBillingAt: '2026-12-01', autoRenew: true, renewalTermMonths: 12 });

    await runDaily('2026-12-01', '2026-12-31', notRenewedYet(f.contractId, '2027-01-01'));
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2027-01-01', nextBillingAt: '2027-01-01' });

    await runDaily('2027-01-01', '2027-02-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2027-03-01' });
    // Nov billed 12-01, Dec (the old final period) billed 01-01, Jan (renewed) billed 02-01.
    await expectOneInvoicePerPeriod(f, ['2026-11-01', '2026-12-01', '2027-01-01']);
    expect(await notices(f.contractId, 'renewed')).toEqual([{ endDate: '2028-01-01' }]);
  }, 120_000);

  it('ANNUAL advance whose interval equals the term: does NOT renew at its first invoice, renews on end_date', async () => {
    const f = await seedContract({
      billingTiming: 'advance', intervalMonths: 12, endDate: '2027-01-01', nextBillingAt: '2026-01-01',
      autoRenew: true, renewalTermMonths: 12,
    });
    for (const d of ['2026-01-01', '2026-06-15', '2026-12-02', '2026-12-31']) await runBillingSweepJob(at(d));
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2027-01-01', nextBillingAt: '2027-01-01' });
    expect(await notices(f.contractId, 'advance')).toEqual([{ endDate: '2027-01-01' }]);

    await runBillingSweepJob(at('2027-01-01'));
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2028-01-01' });
    await expectOneInvoicePerPeriod(f, ['2026-01-01', '2027-01-01']);
  }, 60_000);

  it('QUARTERLY arrears: renews on end_date, bills each quarter once across the boundary', async () => {
    const f = await seedContract({
      billingTiming: 'arrears', intervalMonths: 3, endDate: '2027-01-01', nextBillingAt: '2026-10-01',
      autoRenew: true, renewalTermMonths: 12,
    });
    await runDaily('2026-10-01', '2026-12-31', notRenewedYet(f.contractId, '2027-01-01'));
    await runDaily('2027-01-01', '2027-04-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2027-07-01' });
    await expectOneInvoicePerPeriod(f, ['2026-07-01', '2026-10-01', '2027-01-01']);
  }, 180_000);

  it('end_date INSIDE a period (monthly advance, ends 2027-01-15): renews on 01-15, the straddling period bills once', async () => {
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-15', nextBillingAt: '2026-12-01', autoRenew: true, renewalTermMonths: 12 });
    await runDaily('2026-12-01', '2027-01-14', notRenewedYet(f.contractId, '2027-01-15'));
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2027-01-15', nextBillingAt: '2027-02-01' });
    await runDaily('2027-01-15', '2027-02-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-15', nextBillingAt: '2027-03-01' });
    await expectOneInvoicePerPeriod(f, ['2026-12-01', '2027-01-01', '2027-02-01']);
  }, 120_000);

  it('a block-of-hours line on an auto-renewing contract stays live across the renewal; the non-renewing control retires it', async () => {
    const seedBlock = async (autoRenew: boolean) => {
      const f = await seedBlockFixture({ timing: 'advance', startDate: '2026-01-01', firstPeriodStart: '2026-01-01', nextBillingAt: '2026-12-01', endDate: '2027-01-01' });
      await withSystemDbAccessContext(() => db.update(contracts).set({ autoRenew, renewalTermMonths: 12 }).where(eq(contracts.id, f.contractId)));
      return f;
    };
    const renewing = await seedBlock(true);
    const control = await seedBlock(false);
    const retiredAt = async (lineId: string) => {
      const [l] = await withSystemDbAccessContext(() => db.select({ r: contractLines.hourBlockRetiredAt }).from(contractLines).where(eq(contractLines.id, lineId)));
      return l!.r;
    };

    await runDaily('2026-12-01', '2027-02-01');

    expect(await contractRow(renewing.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2027-03-01' });
    expect(await retiredAt(renewing.blockLineId)).toBeNull();
    expect((await billedPeriods(renewing.contractId)).map((p) => p.periodStart)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']);

    expect((await contractRow(control.contractId)).status).toBe('expired');
    expect(await retiredAt(control.blockLineId)).not.toBeNull();
    expect((await billedPeriods(control.contractId)).map((p) => p.periodStart)).toEqual(['2026-12-01']);
  }, 180_000);

  it('auto_renew = false (control): expires after billing its final period, exactly as before', async () => {
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-01', nextBillingAt: '2026-11-01', autoRenew: false, renewalTermMonths: 12 });
    await runDaily('2026-11-01', '2027-02-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'expired', endDate: '2027-01-01', nextBillingAt: null });
    await expectOneInvoicePerPeriod(f, ['2026-11-01', '2026-12-01']);
    expect(await notices(f.contractId, 'renewed')).toEqual([]);
  }, 120_000);

  it('auto_renew = true with no renewal term (renewal_term_months NULL; the DB CHECK forbids 0): expires like a non-renewing contract', async () => {
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-01', nextBillingAt: '2026-11-01', autoRenew: true, renewalTermMonths: null });
    await runDaily('2026-11-01', '2027-02-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'expired', endDate: '2027-01-01', nextBillingAt: null });
    await expectOneInvoicePerPeriod(f, ['2026-11-01', '2026-12-01']);
  }, 120_000);

  it('opting out of auto-renew after the final invoice: billing expires it on end_date without billing past the term', async () => {
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-01', nextBillingAt: '2026-12-01', autoRenew: true, renewalTermMonths: 12 });
    await runBillingSweepJob(at('2026-12-01'));
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2027-01-01', nextBillingAt: '2027-01-01' });
    // The MSP turns auto-renew off after the advance notice.
    await withSystemDbAccessContext(() => db.update(contracts).set({ autoRenew: false }).where(eq(contracts.id, f.contractId)));

    await runDaily('2026-12-02', '2027-02-01');
    expect(await contractRow(f.contractId)).toEqual({ status: 'expired', endDate: '2027-01-01', nextBillingAt: null });
    await expectOneInvoicePerPeriod(f, ['2026-12-01']);
  }, 120_000);

  it('manual generate on the renewal day BEFORE the daily sweep defers (no expiry, no bill); the job then renews and bills once', async () => {
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-01', nextBillingAt: '2026-12-01', autoRenew: true, renewalTermMonths: 12 });
    await runBillingSweepJob(at('2026-12-01'));

    const manual = await runOutsideDbContext(() => withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2027-01-01'))));
    expect(manual).toMatchObject({ generated: false, skipped: 'renewal_pending' });
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2027-01-01', nextBillingAt: '2027-01-01' });

    await runBillingSweepJob(at('2027-01-01'));
    await runBillingSweepJob(at('2027-01-01')); // a re-run the same day is a no-op
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2027-02-01' });
    await expectOneInvoicePerPeriod(f, ['2026-12-01', '2027-01-01']);
  }, 60_000);

  it('outage catch-up: a job that first runs weeks after end_date renews once and bills each missed period once', async () => {
    const f = await seedContract({ billingTiming: 'advance', endDate: '2027-01-01', nextBillingAt: '2026-12-01', autoRenew: true, renewalTermMonths: 12 });
    await runBillingSweepJob(at('2026-12-01'));
    // Nothing runs again until 2027-03-15; billing then catches up one period per run.
    for (let i = 0; i < 4; i++) await runBillingSweepJob(at('2027-03-15'));
    expect(await contractRow(f.contractId)).toEqual({ status: 'active', endDate: '2028-01-01', nextBillingAt: '2027-04-01' });
    await expectOneInvoicePerPeriod(f, ['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']);
    expect(await notices(f.contractId, 'renewed')).toEqual([{ endDate: '2028-01-01' }]);
  }, 60_000);
});
