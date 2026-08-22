import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test (same rationale as invoiceCurrencyStamping).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, tickets, timeEntries, ticketParts, invoices } from '../../db/schema';
import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

interface Fixture { partnerId: string; orgId: string; userId: string; ticketId: string; entryId: string }

/**
 * Multi-currency wave 4 (#3776), spec §7/§14: a USD partner with an org that
 * was EUR when its one billable hour (1h @ 100.00, snapshotted EUR) was
 * logged, and whose currency is then flipped to GBP directly (the wave-6
 * change flow is not exposed; mirrors invoiceCurrencyStamping's reissue case).
 * The EUR snapshot must never convert, never silently drop, and must stay
 * invoiceable through the explicit old-currency draft path.
 */
async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Blk ${suffix}`, slug: `blk-${suffix}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `blk-org-${suffix}`, currencyCode: 'EUR'
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    const userId = u!.id;
    const [t] = await db.insert(tickets).values({
      orgId, partnerId, ticketNumber: `BLK-${suffix}`, subject: `Blocked ${suffix}`, source: 'manual'
    }).returning({ id: tickets.id });
    const ticketId = t!.id;
    const now = new Date();
    const [te] = await db.insert(timeEntries).values({
      partnerId, orgId, userId, ticketId, startedAt: now, endedAt: now,
      durationMinutes: 60, description: 'Work', isBillable: true,
      hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: true, currencyCode: 'EUR'
    }).returning({ id: timeEntries.id });
    // Org currency change AFTER the snapshot: existing rows keep EUR.
    await db.update(organizations).set({ currencyCode: 'GBP' }).where(eq(organizations.id, orgId));
    return { partnerId, orgId, userId, ticketId, entryId: te!.id };
  });
}

async function addGbpPart(f: Fixture): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [part] = await db.insert(ticketParts).values({
      ticketId: f.ticketId, orgId: f.orgId, description: 'SSD', quantity: '1.00', unitPrice: '80.00',
      currencyCode: 'GBP', isBillable: true, billingStatus: 'not_billed', addedBy: f.userId
    }).returning({ id: ticketParts.id });
    return part!.id;
  });
}

/** A billable hour in the org's CURRENT currency with NO rate — what
 *  match-or-skip stores when no rate exists in that currency (review #1). */
async function addNullRateEntry(f: Fixture, currencyCode = 'GBP'): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const now = new Date();
    const [te] = await db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId, ticketId: f.ticketId, startedAt: now, endedAt: now,
      durationMinutes: 30, description: 'Unrated', isBillable: true,
      hourlyRate: null, billingStatus: 'not_billed', isApproved: true, currencyCode
    }).returning({ id: timeEntries.id });
    return te!.id;
  });
}
async function entryStatusById(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ billingStatus: timeEntries.billingStatus, hourlyRate: timeEntries.hourlyRate })
      .from(timeEntries).where(eq(timeEntries.id, id));
    return row!;
  });
}

function actor(f: Fixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}
const dayBefore = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const dayAfter = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const range = (f: Fixture) => ({ orgId: f.orgId, from: dayBefore(), to: dayAfter() });

async function orgInvoices(f: Fixture) {
  return withSystemDbAccessContext(() =>
    db.select({ id: invoices.id, currencyCode: invoices.currencyCode }).from(invoices).where(eq(invoices.orgId, f.orgId)));
}
async function entryStatus(f: Fixture) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ billingStatus: timeEntries.billingStatus, currencyCode: timeEntries.currencyCode })
      .from(timeEntries).where(eq(timeEntries.id, f.entryId));
    return row!;
  });
}

describe.runIf(RUN)('assembly after an org currency change (spec §7/§14, #3776)', () => {
  it('(a) default assemble → ALL_BLOCKED_BY_CURRENCY with per-currency details; no draft row remains', async () => {
    const f = await seedFixture();
    const err = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg(range(f), actor(f))).catch((e) => e);
    expect(err).toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY', status: 409,
      details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] }
    });
    expect(await orgInvoices(f)).toEqual([]);
    // The EUR row is untouched: still unbilled, still EUR (no conversion, no restamp).
    expect(await entryStatus(f)).toEqual({ billingStatus: 'not_billed', currencyCode: 'EUR' });
  });

  it('(b) explicit currencyCode: EUR → an EUR draft with the one line and no blocked groups', async () => {
    const f = await seedFixture();
    const out = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ ...range(f), currencyCode: 'EUR' }, actor(f)));
    expect(out.invoice.status).toBe('draft');
    expect(out.invoice.currencyCode).toBe('EUR');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.sourceId).toBe(f.entryId);
    expect(out.lines[0]!.lineTotal).toBe('100.00');
    expect(out.invoice.total).toBe('100.00');
    expect(out.blockedByCurrency).toEqual([]);
  });

  it('(c) mixed: GBP part + EUR entry → GBP draft with only the part; EUR entry reported blocked and still not_billed', async () => {
    const f = await seedFixture();
    const partId = await addGbpPart(f);
    const out = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg(range(f), actor(f)));
    expect(out.invoice.currencyCode).toBe('GBP');
    expect(out.lines.map((l) => l.sourceId)).toEqual([partId]);
    expect(out.invoice.total).toBe('80.00');
    expect(out.blockedByCurrency).toEqual([{ currencyCode: 'EUR', count: 1, amount: '100.00' }]);
    expect(await entryStatus(f)).toEqual({ billingStatus: 'not_billed', currencyCode: 'EUR' });
    const rows = await orgInvoices(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currencyCode).toBe('GBP');
  });

  it('(d) ticket path: default → blocked; { currencyCode: EUR } → EUR draft', async () => {
    const f = await seedFixture();
    const err = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromTicket(f.ticketId, actor(f))).catch((e) => e);
    expect(err).toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY', status: 409,
      details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] }
    });
    expect(await orgInvoices(f)).toEqual([]);

    const out = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromTicket(f.ticketId, actor(f), { currencyCode: 'EUR' }));
    expect(out.invoice.currencyCode).toBe('EUR');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.ticketId).toBe(f.ticketId);
    expect(out.blockedByCurrency).toEqual([]);
  });

  it('(e) a NULL-rate billable entry is never billed at zero: alone → ALL_MISSING_RATE; alongside blocked → reported in details (review #1)', async () => {
    const f = await seedFixture();
    const unratedId = await addNullRateEntry(f);

    // EUR entry blocked + GBP entry unrated, nothing included → blocked error carries both groups.
    const err = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg(range(f), actor(f))).catch((e) => e);
    expect(err).toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY', status: 409,
      details: {
        blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }],
        missingRate: [{ timeEntryId: unratedId, ticketId: f.ticketId, description: 'Unrated', hours: '0.50' }]
      }
    });
    expect(await orgInvoices(f)).toEqual([]);

    // Only the unrated entry left → its own code, no draft, no zero line.
    await withSystemDbAccessContext(() =>
      db.update(timeEntries).set({ billingStatus: 'billed' }).where(eq(timeEntries.id, f.entryId)));
    const err2 = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg(range(f), actor(f))).catch((e) => e);
    expect(err2).toMatchObject({
      code: 'ALL_MISSING_RATE', status: 409,
      details: { missingRate: [{ timeEntryId: unratedId, ticketId: f.ticketId, description: 'Unrated', hours: '0.50' }] }
    });
    expect(await orgInvoices(f)).toEqual([]);
    expect(await entryStatusById(unratedId)).toEqual({ billingStatus: 'not_billed', hourlyRate: null });
  });

  it('(f) a NULL-rate entry next to a GBP part: the part is invoiced, the entry is reported under missingRate and stays not_billed', async () => {
    const f = await seedFixture();
    const unratedId = await addNullRateEntry(f);
    const partId = await addGbpPart(f);
    const out = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg(range(f), actor(f)));
    expect(out.invoice.currencyCode).toBe('GBP');
    expect(out.lines.map((l) => l.sourceId)).toEqual([partId]);
    expect(out.invoice.total).toBe('80.00');
    expect(out.missingRate).toEqual([{ timeEntryId: unratedId, ticketId: f.ticketId, description: 'Unrated', hours: '0.50' }]);
    expect(out.blockedByCurrency).toEqual([{ currencyCode: 'EUR', count: 1, amount: '100.00' }]);
    expect(await entryStatusById(unratedId)).toEqual({ billingStatus: 'not_billed', hourlyRate: null });

    // An explicit zero rate IS a valid (zero) line.
    await withSystemDbAccessContext(() =>
      db.update(timeEntries).set({ hourlyRate: '0.00' }).where(eq(timeEntries.id, unratedId)));
    const out2 = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromTicket(f.ticketId, actor(f)));
    expect(out2.missingRate).toEqual([]);
    const zeroLine = out2.lines.find((l) => l.sourceId === unratedId);
    expect(zeroLine).toMatchObject({ quantity: '0.50', unitPrice: '0.00', lineTotal: '0.00' });
  });
});
