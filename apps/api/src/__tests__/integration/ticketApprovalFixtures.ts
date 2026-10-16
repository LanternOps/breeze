/**
 * Customer work approval W02 (#4617) — shared real-DB fixtures.
 * setup.ts TRUNCATEs before every test: seed per test.
 *
 * The seeded technician is PARTNER scope and every service call in the suites
 * runs under `withDbAccessContext(ctx(f), …)` — the request path's RLS shape —
 * because ticket_approval_requests is org-axis RLS while time_entries is
 * partner-axis: a pending-request read that RLS hid would silently defeat the
 * queue rule, and only a non-system context can show that.
 */
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  contactRoles, contacts, organizations, partners, ticketApprovalRequests, ticketApprovalSettings, tickets, timeEntries, users,
} from '../../db/schema';
import { workTypes } from '../../db/schema/workTypes';
import type { TimeEntryActor } from '../../services/timeEntryService';

export interface ApprovalFixture {
  partnerId: string;
  orgId: string;
  otherOrgId: string;
  userId: string;
  user2Id: string;
  ticketId: string;
  ticket2Id: string;
  afterHoursWorkTypeId: string;
  plainWorkTypeId: string;
}

export async function seedApprovalFixture(o: {
  enabled?: boolean; enforcement?: 'soft' | 'hard'; budgetMinutes?: number | null; budgetAmount?: string | null;
  ttlHours?: number; currency?: string;
} = {}): Promise<ApprovalFixture> {
  const currency = o.currency ?? 'USD';
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({
      name: `TA ${sfx}`, slug: `ta-${sfx}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: currency,
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [org] = await db.insert(organizations).values({
      partnerId, name: `TA Org ${sfx}`, slug: `ta-org-${sfx}`, currencyCode: currency,
    }).returning({ id: organizations.id });
    const [other] = await db.insert(organizations).values({
      partnerId, name: `TA Other ${sfx}`, slug: `ta-oth-${sfx}`, currencyCode: currency,
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId, orgId: null, email: `ta-${sfx}@example.test`, name: 'Tech One', status: 'active',
    }).returning({ id: users.id });
    const [u2] = await db.insert(users).values({
      partnerId, orgId: null, email: `ta2-${sfx}@example.test`, name: 'Tech Two', status: 'active',
    }).returning({ id: users.id });
    const budgetAmount = o.budgetAmount ?? null;
    const [t] = await db.insert(tickets).values({
      orgId: org!.id, partnerId, ticketNumber: `TA-${sfx}`, subject: 'Approval ticket', source: 'manual',
      budgetMinutes: o.budgetMinutes === undefined ? 120 : o.budgetMinutes,
      budgetAmount, budgetCurrencyCode: budgetAmount ? currency : null,
    }).returning({ id: tickets.id });
    const [t2] = await db.insert(tickets).values({
      orgId: org!.id, partnerId, ticketNumber: `TA2-${sfx}`, subject: 'Second ticket', source: 'manual',
      budgetMinutes: o.budgetMinutes === undefined ? 120 : o.budgetMinutes,
    }).returning({ id: tickets.id });
    const [ah] = await db.insert(workTypes).values({ partnerId, name: 'After hours', isAfterHours: true }).returning({ id: workTypes.id });
    const [plain] = await db.insert(workTypes).values({ partnerId, name: 'Remote' }).returning({ id: workTypes.id });
    await db.insert(ticketApprovalSettings).values({
      partnerId, orgId: null, enabled: o.enabled ?? true, enforcement: o.enforcement ?? 'soft',
      requestTtlHours: o.ttlHours ?? 72,
    });
    return {
      partnerId, orgId: org!.id, otherOrgId: other!.id, userId: u!.id, user2Id: u2!.id,
      ticketId: t!.id, ticket2Id: t2!.id, afterHoursWorkTypeId: ah!.id, plainWorkTypeId: plain!.id,
    };
  });
}

export function ctx(f: ApprovalFixture, userId = f.userId): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId, f.otherOrgId],
    accessiblePartnerIds: [f.partnerId], userId,
  };
}

export function actor(f: ApprovalFixture, o: Partial<TimeEntryActor> = {}): TimeEntryActor {
  return {
    userId: f.userId, name: 'Tech One', partnerId: f.partnerId, manageAll: true, manageBilling: true,
    accessibleOrgIds: [f.orgId, f.otherOrgId], ...o,
  };
}

/** A settled (consumed) billable entry, written directly. */
export async function insertSettledEntry(f: ApprovalFixture, minutes: number, o: {
  ticketId?: string; billingStatus?: 'not_billed' | 'billed' | 'contract'; hourlyRate?: string | null; userId?: string;
} = {}): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const end = new Date(Date.now() - 86_400_000);
    const [row] = await db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, ticketId: o.ticketId ?? f.ticketId, userId: o.userId ?? f.userId,
      startedAt: new Date(end.getTime() - minutes * 60_000), endedAt: end, durationMinutes: minutes,
      isBillable: true, coverage: 'billable', hourlyRate: o.hourlyRate === undefined ? '100.00' : o.hourlyRate,
      currencyCode: 'USD', billingStatus: o.billingStatus ?? 'not_billed',
    }).returning({ id: timeEntries.id });
    return row!.id;
  });
}

export async function addContact(f: ApprovalFixture, email: string | null, roles: Array<{ role: string; siteScoped?: boolean }>, orgId = f.orgId): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [c] = await db.insert(contacts).values({ orgId, name: email ?? 'No email', email, roles: roles.map((r) => r.role) })
      .returning({ id: contacts.id });
    for (const r of roles) {
      if (r.siteScoped) continue; // a site pin needs a site; tests only need "not org-scoped"
      await db.insert(contactRoles).values({ contactId: c!.id, orgId, role: r.role });
    }
    return c!.id;
  });
}

export async function readEntry(id: string) {
  return withSystemDbAccessContext(async () =>
    (await db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1))[0]!);
}

export async function readRequests(ticketId: string) {
  return withSystemDbAccessContext(async () =>
    db.select().from(ticketApprovalRequests).where(eq(ticketApprovalRequests.ticketId, ticketId)));
}

export async function readRequest(id: string) {
  return withSystemDbAccessContext(async () =>
    (await db.select().from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, id)).limit(1))[0]!);
}

export async function entriesOfTicket(ticketId: string) {
  return withSystemDbAccessContext(async () =>
    db.select().from(timeEntries).where(eq(timeEntries.ticketId, ticketId)));
}
