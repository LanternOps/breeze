/**
 * Block hours W02 (#8181) — shared real-DB fixtures. No API can create an
 * hour_block line yet (CONTRACT_LINE_TYPES excludes it until W03), so every
 * suite seeds the block line directly, the way contractLineAllowance does.
 * setup.ts TRUNCATEs before every test: seed per test.
 */
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contracts, organizations, partners, timeEntries, users,
} from '../../db/schema';
import type { ContractActorT } from '../../services/contractService';
import type { TimeEntryActor } from '../../services/timeEntryService';

export interface BlockFixture {
  partnerId: string; orgId: string; userId: string; contractId: string; blockLineId: string;
  currency: string; actor: ContractActorT;
}

/** One org, one monthly contract starting 2026-07-01 (default), one live block
 *  line (10 h, 1000.00 fee, 150.00/h overage, no rollover) whose first period
 *  is the contract's first. */
export async function seedBlockFixture(o: {
  timing?: 'advance' | 'arrears'; rollover?: 'none' | 'carry_forward'; cap?: string | null;
  included?: string; firstPeriodStart?: string; startDate?: string; nextBillingAt?: string | null;
  currency?: string; status?: 'active' | 'paused' | 'cancelled' | 'expired'; endDate?: string | null;
} = {}): Promise<BlockFixture> {
  const currency = o.currency ?? 'USD';
  const startDate = o.startDate ?? '2026-07-01';
  const timing = o.timing ?? 'arrears';
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `HB ${sfx}`, slug: `hb-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org] = await db.insert(organizations)
      .values({ currencyCode: currency, partnerId: p!.id, name: 'HBOrg', slug: `hb-${sfx}`, taxRate: '0.10000' })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: null, email: `hb-${sfx}@example.test`, name: 'Tech', status: 'active' })
      .returning({ id: users.id });
    const nextBillingAt = o.nextBillingAt !== undefined
      ? o.nextBillingAt
      : (timing === 'advance' ? startDate : '2026-08-01');
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: org!.id, name: 'Support block', status: o.status ?? 'active', intervalMonths: 1,
      startDate, endDate: o.endDate ?? null, currencyCode: currency, billingTiming: timing,
      nextBillingAt, createdBy: u!.id,
    }).returning({ id: contracts.id });
    const [l] = await db.insert(contractLines).values({
      contractId: c!.id, orgId: org!.id, lineType: 'hour_block', description: 'Support hours',
      unitPrice: '1000.00', taxable: true,
      includedQuantity: o.included ?? '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
      rolloverPolicy: o.rollover ?? 'none', rolloverCapHours: o.cap ?? null,
      hourBlockFirstPeriodStart: o.firstPeriodStart ?? startDate,
    }).returning({ id: contractLines.id });
    return {
      partnerId: p!.id, orgId: org!.id, userId: u!.id, contractId: c!.id, blockLineId: l!.id, currency,
      actor: { userId: u!.id, partnerId: p!.id, accessibleOrgIds: [org!.id] } as ContractActorT,
    };
  });
}

/** A finished time entry in the fixture org. `billableMinutes` different from
 *  `minutes` also stamps `minimumMinutes` so time_entries_billable_minutes_chk holds. */
export async function seedEntry(f: BlockFixture, e: {
  minutes: number; endedAt: string; billableMinutes?: number | null; isBillable?: boolean;
  billingStatus?: 'not_billed' | 'no_charge' | 'billed' | 'contract'; isApproved?: boolean;
  hourlyRate?: string | null; currencyCode?: string; ticketId?: string | null;
}): Promise<string> {
  const ended = new Date(e.endedAt);
  const billable = e.billableMinutes ?? null;
  const [row] = await withSystemDbAccessContext(() => db.insert(timeEntries).values({
    partnerId: f.partnerId, orgId: f.orgId, userId: f.userId, ticketId: e.ticketId ?? null,
    startedAt: new Date(ended.getTime() - e.minutes * 60_000), endedAt: ended,
    durationMinutes: e.minutes, billableMinutes: billable,
    minimumMinutes: billable != null && billable !== e.minutes ? billable : null,
    description: 'Work', isBillable: e.isBillable ?? true,
    hourlyRate: e.hourlyRate === undefined ? '120.00' : e.hourlyRate,
    coverage: e.billingStatus === 'contract' ? 'included' : 'billable',
    billingStatus: e.billingStatus ?? 'not_billed', isApproved: e.isApproved ?? true,
    currencyCode: e.currencyCode ?? f.currency,
  }).returning({ id: timeEntries.id }));
  return row!.id;
}

export async function claimPeriod(f: BlockFixture, periodStart: string, periodEnd: string, invoiceId: string | null = null) {
  await withSystemDbAccessContext(() => db.insert(contractBillingPeriods)
    .values({ contractId: f.contractId, orgId: f.orgId, periodStart, periodEnd, invoiceId }));
}

/** A manager-grade actor for the time-entry service (system DB context). */
export function systemActor(f: BlockFixture): TimeEntryActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId], manageAll: true, manageBilling: true };
}

export async function entryState(id: string) {
  const [r] = await withSystemDbAccessContext(() => db.select({
    billingStatus: timeEntries.billingStatus, contractLineId: timeEntries.contractLineId,
  }).from(timeEntries).where(eq(timeEntries.id, id)));
  return r!;
}
