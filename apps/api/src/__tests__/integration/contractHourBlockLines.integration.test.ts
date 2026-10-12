import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contractBillingPeriods, contractHourPeriods, contractLines, contracts, organizations, partners, timeEntries, users } from '../../db/schema';
import {
  activateContract, addContractLineToContract, computeContractEstimate, removeContractLine, summarizeActiveContractMrrByOrg,
  updateContractLine, type ContractActorT,
} from '../../services/contractService';
import { computeOpenHourBlockPeriod } from '../../services/contractHourBlockEstimate';
import { closeHourBlockPeriods } from '../../services/contractHourBlockClose';
import { listContractHourPeriods } from '../../services/contractHourPeriodsRead';
import { computePeriod, periodIndexFor, todayISO } from '../../services/contractMath';

const partnerCtx = (partnerId: string, orgIds: string[]) =>
  ({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null }) as never;
const orgCtx = (orgId: string) =>
  ({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null }) as never;

interface Fixture { partnerId: string; orgId: string; userId: string; actor: ContractActorT }

async function seedOrg(partnerId?: string): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = randomUUID().slice(0, 8);
    let pid = partnerId;
    if (!pid) {
      const [p] = await db.insert(partners).values({ name: `HBL ${sfx}`, slug: `hbl-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      pid = p!.id;
    }
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: pid, name: `HBLOrg ${sfx}`, slug: `hbl-${sfx}`, taxRate: '0.00000' }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: pid, orgId: o!.id, email: `hbl-${sfx}@x.io`, name: 'HBL', status: 'active' }).returning({ id: users.id });
    return { partnerId: pid, orgId: o!.id, userId: u!.id, actor: { userId: u!.id, partnerId: pid, accessibleOrgIds: [o!.id] } };
  });
}

const seedContract = (f: Fixture, over: Record<string, unknown> = {}) => withSystemDbAccessContext(async () => {
  const [c] = await db.insert(contracts).values({
    partnerId: f.partnerId, orgId: f.orgId, name: 'Block contract', status: 'draft', intervalMonths: 1,
    startDate: '2020-01-01', currencyCode: 'USD', billingTiming: 'advance', createdBy: f.userId, ...over,
  } as never).returning();
  return c!;
});

const BLOCK = {
  lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
  includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
} as never;

const ledger = (f: Fixture, contractId: string, lineId: string) => withSystemDbAccessContext(() => db.insert(contractHourPeriods).values({
  contractLineId: lineId, contractId, orgId: f.orgId, periodStart: '2020-02-01', periodEnd: '2020-03-01',
  includedHours: '10.00', carriedInHours: '0.00', consumedHours: '4.00', overageHours: '0.00', carriedOutHours: '0.00',
  entryCount: 2, overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run',
}).returning({ id: contractHourPeriods.id }));

describe('block-hours lines against real Postgres (#4547 W03)', () => {
  describe('entitlement starts where the fee starts (index C9)', () => {
    const today = todayISO();
    const startDate = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}-01`;       // day 1: no month-end clamping
    const cur = computePeriod(startDate, 1, periodIndexFor(startDate, 1, today));      // the period in progress
    const stampOf = (lineId: string) => withSystemDbAccessContext(async () =>
      (await db.select({ s: contractLines.hourBlockFirstPeriodStart }).from(contractLines).where(eq(contractLines.id, lineId)))[0]!.s);

    it('active ADVANCE contract: the next period; the stamp and the other block columns persist', async () => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'active', startDate, billingTiming: 'advance', nextBillingAt: cur.periodEnd });
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row).toMatchObject({
        lineType: 'hour_block', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
        hourBlockRetiredAt: null, siteId: null, deviceRoles: null,
      });
      expect(row.hourBlockFirstPeriodStart).toBe(cur.periodEnd);
    });

    it('active ARREARS contract: the period in progress', async () => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'active', startDate, billingTiming: 'arrears', nextBillingAt: cur.periodEnd });
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row.hourBlockFirstPeriodStart).toBe(cur.periodStart);
    });

    it('PAUSE -> RESUME on an advance contract: the pointer sits on a period claimed before the pause, so the block starts at the first UNCLAIMED one', async () => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'active', startDate, billingTiming: 'advance', nextBillingAt: cur.periodStart });
      await withSystemDbAccessContext(() => db.insert(contractBillingPeriods).values({
        contractId: c.id, orgId: f.orgId, periodStart: cur.periodStart, periodEnd: cur.periodEnd,
      }));
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row.hourBlockFirstPeriodStart).toBe(cur.periodEnd);
    });

    it.each(['advance', 'arrears'] as const)('%s DRAFT with a past start date: provisional first period, re-stamped to the period activation claims', async (billingTiming) => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'draft', startDate, billingTiming });
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row.hourBlockFirstPeriodStart).toBe(startDate);                            // provisional: the contract's first period
      await withSystemDbAccessContext(() => activateContract(c.id, f.actor, new Date()));
      expect(await stampOf(row.id)).toBe(cur.periodStart);                              // the period containing the activation day
    });
  });

  it('add -> retire -> add again: the live-block index rejects a second block, frees on delete, frees on retire', async () => {
    const f = await seedOrg();
    const c1 = await seedContract(f, { name: 'C1' });
    const c2 = await seedContract(f, { name: 'C2' });

    const first = await withSystemDbAccessContext(() => addContractLineToContract(c1.id, BLOCK, f.actor));
    // Same contract and a sibling contract of the same org both hit the REAL index.
    for (const contractId of [c1.id, c2.id]) {
      await expect(withSystemDbAccessContext(() => addContractLineToContract(contractId, BLOCK, f.actor)))
        .rejects.toMatchObject({ code: 'HOUR_BLOCK_EXISTS', status: 409 });
    }

    // No history -> DELETE; the index frees.
    const removed = await withSystemDbAccessContext(() => removeContractLine(c1.id, first.id, f.actor));
    expect(removed.retired).toBe(false);
    expect(await withSystemDbAccessContext(() => db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.id, first.id)))).toHaveLength(0);
    const second = await withSystemDbAccessContext(() => addContractLineToContract(c2.id, BLOCK, f.actor));

    // History -> RETIRE (row kept, ledger FK intact); the index frees again.
    await ledger(f, c2.id, second.id);
    const retired = await withSystemDbAccessContext(() => removeContractLine(c2.id, second.id, f.actor));
    expect(retired.retired).toBe(true);
    const [kept] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, second.id)));
    expect(kept!.hourBlockRetiredAt).toBeInstanceOf(Date);          // stamped with the database's now() (transaction time)
    // Idempotent: a second remove neither deletes nor moves retired_at.
    const again = await withSystemDbAccessContext(() => removeContractLine(c2.id, second.id, f.actor));
    expect(again.retired).toBe(true);
    const [still] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, second.id)));
    expect(still!.hourBlockRetiredAt!.getTime()).toBe(kept!.hourBlockRetiredAt!.getTime());

    const third = await withSystemDbAccessContext(() => addContractLineToContract(c1.id, BLOCK, f.actor));
    expect(third.id).not.toBe(second.id);

    // A retired block refuses every edit.
    await expect(withSystemDbAccessContext(() => updateContractLine(c2.id, second.id, { description: 'x' } as never, f.actor)))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED' });
  });

  it('a claimed period at or after the first period retires instead of deleting, even with no ledger row yet', async () => {
    const f = await seedOrg();
    const c = await seedContract(f, { status: 'active', nextBillingAt: '2099-01-01' });
    const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
    // contract_billing_periods claim for the line's first period (advance contracts claim at the period start).
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO contract_billing_periods (contract_id, org_id, period_start, period_end)
      VALUES (${c.id}::uuid, ${f.orgId}::uuid, ${row.hourBlockFirstPeriodStart}::date, (${row.hourBlockFirstPeriodStart}::date + interval '1 month')::date)`));
    const out = await withSystemDbAccessContext(() => removeContractLine(c.id, row.id, f.actor));
    expect(out.retired).toBe(true);
    expect(await withSystemDbAccessContext(() => db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.id, row.id)))).toHaveLength(1);
  });

  it('MRR counts the block fee once and never hours; a retired block counts nothing', async () => {
    const f = await seedOrg();
    const c = await seedContract(f, { status: 'active', nextBillingAt: '2099-01-01' });
    const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
    // 100 hours of entries must not move MRR.
    await withSystemDbAccessContext(() => db.insert(timeEntries).values(Array.from({ length: 10 }, (_, i) => ({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
      startedAt: new Date(Date.now() - (i + 1) * 3_600_000 * 10), endedAt: new Date(Date.now() - (i + 1) * 3_600_000 * 10 + 36_000_00),
      durationMinutes: 600, isBillable: true, hourlyRate: '100.00', currencyCode: 'USD', billingStatus: 'not_billed' as const,
    }))));
    const mrr = await withSystemDbAccessContext(() => summarizeActiveContractMrrByOrg([f.orgId]));
    expect(mrr.get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '1000.00' }]);

    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date() }).where(eq(contractLines.id, row.id)));
    const after = await withSystemDbAccessContext(() => summarizeActiveContractMrrByOrg([f.orgId]));
    expect(Number(after.get(f.orgId)?.find((r) => r.currencyCode === 'USD')?.amount ?? '0')).toBe(0);
  });

  it('the live figure counts exactly the entries the W02 close later bills: UTC bounds, carry-in from the latest EARLIER row, foreign currency, late entries', async () => {
    const f = await seedOrg();
    // Monthly advance contract; the open period under test is [2025-03-01, 2025-04-01).
    const c = await seedContract(f, { status: 'active', startDate: '2025-01-01', billingTiming: 'advance', nextBillingAt: '2025-04-01' });
    const [line] = await withSystemDbAccessContext(() => db.insert(contractLines).values({
      contractId: c.id, orgId: f.orgId, lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
      includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'carry_forward',
      hourBlockFirstPeriodStart: '2025-01-01',
    }).returning());
    const row = (periodStart: string, periodEnd: string, carriedOut: string) => ({
      contractLineId: line!.id, contractId: c.id, orgId: f.orgId, periodStart, periodEnd,
      includedHours: '10.00', carriedInHours: '0.00', consumedHours: '0.00', overageHours: '0.00', carriedOutHours: carriedOut,
      entryCount: 0, overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run' as const,
    });
    await withSystemDbAccessContext(async () => {
      // February closed with 3 h carried out. A LATER closed row must not feed the open period's carry-in.
      await db.insert(contractHourPeriods).values([row('2025-02-01', '2025-03-01', '3.00'), row('2025-05-01', '2025-06-01', '9.00')]);
      await db.insert(contractBillingPeriods).values({ contractId: c.id, orgId: f.orgId, periodStart: '2025-03-01', periodEnd: '2025-04-01' });
    });
    const e = (endedAt: string, minutes: number, over: Record<string, unknown> = {}) => ({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
      startedAt: new Date(new Date(endedAt).getTime() - minutes * 60_000), endedAt: new Date(endedAt),
      durationMinutes: minutes, isBillable: true, hourlyRate: '100.00', currencyCode: 'USD',
      billingStatus: 'not_billed' as const, isApproved: true, ...over,
    });
    await withSystemDbAccessContext(() => db.insert(timeEntries).values([
      e('2025-03-01T00:00:00Z', 60),                          // exactly the period start: counted
      e('2025-03-31T23:59:59Z', 30, { currencyCode: 'EUR' }), // last second, other currency: counted and flagged
      e('2025-04-01T00:00:00Z', 600),                         // exactly the period end: NOT counted
      e('2025-02-28T23:59:59Z', 45),                          // inside the closed February: a late entry
    ]));

    const live = await withSystemDbAccessContext(() => computeOpenHourBlockPeriod(c, line!, new Date('2025-03-15T12:00:00Z')));
    expect(live).toMatchObject({
      periodStart: '2025-03-01', periodEnd: '2025-04-01', carriedInHours: 3, consumedHours: 1.5,
      foreignCurrencyHours: 0.5, remainingHours: 11.5, overageHours: 0, lateEntryHours: 0.75,
    });

    // Parity: the real close of the same period bills exactly what the live figure showed.
    const { closes } = await withSystemDbAccessContext(() => closeHourBlockPeriods({
      contract: c, line: line!, closeSource: 'billing_run', asOf: new Date('2025-04-02T00:00:00Z'),
      overageInvoice: () => { throw new Error('no overage expected'); },
    }));
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      periodStart: live.periodStart, consumedHours: live.consumedHours, carriedInHours: live.carriedInHours,
      foreignCurrencyHours: live.foreignCurrencyHours, overageHours: live.overageHours, entryCount: 2,
    });
  });

  describe('the open-period read and the partner-axis trap', () => {
    async function seedOpenPeriod() {
      const f = await seedOrg();
      const t = todayISO();
      const startDate = `${Number(t.slice(0, 4)) - 1}-${t.slice(5, 7)}-01`;
      const per = computePeriod(startDate, 1, periodIndexFor(startDate, 1, t));
      const c = await seedContract(f, { status: 'active', startDate, nextBillingAt: per.periodEnd });
      // Inserted directly so the block already counts the CURRENT period (service stamping would start it next period).
      const [line] = await withSystemDbAccessContext(() => db.insert(contractLines).values({
        contractId: c.id, orgId: f.orgId, lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
        includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
        hourBlockFirstPeriodStart: per.periodStart,
      }).returning());
      const other = await seedOrg(f.partnerId);                       // a second org of the same partner
      const at = new Date(`${per.periodStart}T02:00:00Z`);
      const e = (orgId: string, minutes: number, over: Record<string, unknown> = {}) => ({
        partnerId: f.partnerId, orgId, userId: f.userId, startedAt: new Date(at.getTime() - minutes * 60_000), endedAt: at,
        durationMinutes: minutes, isBillable: true, hourlyRate: '100.00', currencyCode: 'USD',
        billingStatus: 'not_billed' as const, isApproved: true, ...over,
      });
      await withSystemDbAccessContext(() => db.insert(timeEntries).values([
        e(f.orgId, 390),                                              // 6.5 h, approved
        e(f.orgId, 60, { isApproved: false }),                        // 1 h, unapproved
        e(f.orgId, 600, { isBillable: false }),                       // ignored
        e(f.orgId, 600, { billingStatus: 'no_charge' }),              // ignored
        e(other.orgId, 600),                                          // another org: ignored
      ]));
      return { f, c, line: line!, per };
    }

    it('reads the same figures under system scope and under the owning partner', async () => {
      const { f, c, line } = await seedOpenPeriod();
      const viaSystem = await withSystemDbAccessContext(() => computeOpenHourBlockPeriod(c, line));
      const viaPartner = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeOpenHourBlockPeriod(c, line));
      for (const out of [viaSystem, viaPartner]) {
        expect(out).toMatchObject({ consumedHours: 7.5, unapprovedHours: 1, remainingHours: 2.5, overageHours: 0, includedHours: 10 });
      }
    });

    it('THE TRAP: an organization-scoped read of time_entries sees ZERO rows, and the estimate refuses to run there', async () => {
      const { f, c, line } = await seedOpenPeriod();
      const seen = await withDbAccessContext(orgCtx(f.orgId), () => db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.orgId, f.orgId)));
      expect(seen).toHaveLength(0);                                   // partner-axis RLS: the org token cannot see its own entries
      await expect(withDbAccessContext(orgCtx(f.orgId), () => computeOpenHourBlockPeriod(c, line)))
        .rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });   // fail closed, never "0 hours used"
    });

    it('computeContractEstimate carries the live block under the partner context the route uses', async () => {
      const { f, c } = await seedOpenPeriod();
      const est = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeContractEstimate(c.id, f.actor));
      expect(est.hourBlock).toMatchObject({ consumedHours: 7.5, remainingHours: 2.5 });
      expect(est.periodTotal).toBe('1000.00');                        // the fee once; hours never in the money total
      const optedOut = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeContractEstimate(c.id, f.actor, undefined, { includeHourBlock: false }));
      expect(optedOut.hourBlock).toBeNull();
    });

    it('contract_hour_periods (Shape 1) is readable in the ordinary request context, and only for its own org', async () => {
      const { f, c, line } = await seedOpenPeriod();
      await ledger(f, c.id, line.id);
      const page = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => listContractHourPeriods(c.id, { limit: 10 }, f.actor));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ consumedHours: '4.00', closeSource: 'billing_run' });
      const ownOrg = await withDbAccessContext(orgCtx(f.orgId), () => db.select({ id: contractHourPeriods.id }).from(contractHourPeriods));
      expect(ownOrg).toHaveLength(1);
      const stranger = await seedOrg();
      const foreign = await withDbAccessContext(orgCtx(stranger.orgId), () => db.select({ id: contractHourPeriods.id }).from(contractHourPeriods));
      expect(foreign).toHaveLength(0);
      await expect(withDbAccessContext(partnerCtx(f.partnerId, [stranger.orgId]), () => listContractHourPeriods(c.id, { limit: 10 }, { ...f.actor, accessibleOrgIds: [stranger.orgId] })))
        .rejects.toMatchObject({ status: 404 });   // RLS hides a contract outside the caller's orgs: the shared 404, never its periods
    });
  });
});
