/**
 * Block hours W02 (#8181) — shared real-DB fixtures. No API can create an
 * hour_block line yet (CONTRACT_LINE_TYPES excludes it until W03), so every
 * suite seeds the block line directly, the way contractLineAllowance does.
 * setup.ts TRUNCATEs before every test: seed per test.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contracts, organizations, partners, portalBranding, tickets, timeEntries, users,
} from '../../db/schema';
import { createOrganization } from './db-utils';
import { getTestDb } from './setup';
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

// ---------------------------------------------------------------------------
// Block hours W04 — multi-org seeding for the portal and alert suites. Seeds
// through the admin test connection (RLS does not interfere with seeding).
// ---------------------------------------------------------------------------

export interface FixtureEntry {
  minutes: number;
  /** YYYY-MM-DD in December 2026 unless overridden; the entry starts 09:00 UTC. */
  day?: string;
  approved?: boolean;
  billable?: boolean;
  /** 'contract' entries are inserted already drawn by the block line. */
  status?: 'not_billed' | 'contract' | 'billed';
}

export interface SeedBlockOrgArgs {
  partnerId: string;
  technicianId: string;
  contractStatus?: 'active' | 'paused' | 'draft';
  alertPct?: number | null;
  retired?: boolean;
  archived?: boolean;
  enableHourBlock?: boolean;
  includedHours?: string;      // default '10.00'
  overageRate?: string;        // default '150.00'
  createdBy?: string | null;
  rolloverPolicy?: 'none' | 'carry_forward';   // default 'none'
  entries?: FixtureEntry[];
}

export interface SeededBlockOrg {
  orgId: string;
  contractId: string;
  lineId: string;
  ticketId: string;
}

/**
 * One org with an advance-billed monthly contract starting 2026-12-01 and ONE
 * hour_block line whose first period is 2026-12-01 (so the open period for
 * asOf = 2026-12-20 is [2026-12-01, 2027-01-01)).
 */
export async function seedBlockOrg(args: SeedBlockOrgArgs): Promise<SeededBlockOrg> {
  const admin = getTestDb();
  const org = await createOrganization({ partnerId: args.partnerId });

  if (args.archived) {
    await admin
      .update(organizations)
      .set({ status: 'archived', archivedAt: new Date() })
      .where(eq(organizations.id, org.id));
  }

  const [contract] = await admin
    .insert(contracts)
    .values({
      partnerId: args.partnerId,
      orgId: org.id,
      name: `Block contract ${randomUUID().slice(0, 8)}`,
      status: args.contractStatus ?? 'active',
      billingTiming: 'advance',
      intervalMonths: 1,
      startDate: '2026-12-01',
      nextBillingAt: '2027-01-01',
      currencyCode: 'USD',
      createdBy: args.createdBy ?? null,
    })
    .returning({ id: contracts.id });
  if (!contract) throw new Error('contract insert failed');

  const [line] = await admin
    .insert(contractLines)
    .values({
      contractId: contract.id,
      orgId: org.id,
      lineType: 'hour_block',
      description: 'Support hours',
      unitPrice: '1000.00',
      includedQuantity: args.includedHours ?? '10.00',
      overageMode: 'bill',
      overageUnitPrice: args.overageRate ?? '150.00',
      rolloverPolicy: args.rolloverPolicy ?? 'none',
      hourBlockAlertPct: args.alertPct === undefined ? 80 : args.alertPct,
      hourBlockFirstPeriodStart: '2026-12-01',
      hourBlockRetiredAt: args.retired ? new Date('2026-12-05T00:00:00Z') : null,
    })
    .returning({ id: contractLines.id });
  if (!line) throw new Error('contract line insert failed');

  const [ticket] = await admin
    .insert(tickets)
    .values({
      orgId: org.id,
      partnerId: args.partnerId,
      ticketNumber: `HB-${randomUUID()}`,
      subject: 'Block fixture',
    })
    .returning({ id: tickets.id });
  if (!ticket) throw new Error('ticket insert failed');

  for (const entry of args.entries ?? []) {
    const startedAt = new Date(`${entry.day ?? '2026-12-10'}T09:00:00Z`);
    const status = entry.status ?? 'not_billed';
    await admin.insert(timeEntries).values({
      partnerId: args.partnerId,
      orgId: org.id,
      ticketId: ticket.id,
      userId: args.technicianId,
      startedAt,
      endedAt: new Date(startedAt.getTime() + entry.minutes * 60_000),
      durationMinutes: entry.minutes,
      isBillable: entry.billable ?? true,
      billingStatus: status,
      isApproved: entry.approved ?? true,
      currencyCode: 'USD',
      ...(status === 'contract' ? { contractLineId: line.id } : {}),
    });
  }

  if (args.enableHourBlock !== undefined) {
    await admin.insert(portalBranding).values({
      orgId: org.id,
      enableSupportUsage: true,
      enableHourBlock: args.enableHourBlock,
    });
  }

  return { orgId: org.id, contractId: contract.id, lineId: line.id, ticketId: ticket.id };
}
