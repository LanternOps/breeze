import { describe, it, expect, vi } from 'vitest';

// Lifecycle events are fire-and-forget BullMQ side effects, not the correctness
// under test here. Mock the emitter so these DB-correctness tests don't depend
// on (and block on) a reachable Redis — the default test harness only stubs the
// `redis` connection helper, but a real BullMQ Queue.add() would still open a
// socket and hang issue/payment/void on the unauthenticated test Redis.
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

// issueInvoice enqueues an async PDF render. Same rationale as the events mock:
// stub it so the issue path doesn't open a BullMQ socket to the test Redis (which
// can hang under NOAUTH). The render itself is covered by invoicePdf.integration.test.ts.
vi.mock('../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../db';
import { partners, organizations, users, timeEntries, invoices, invoiceLines } from '../db/schema';
import { eq } from 'drizzle-orm';
import * as svc from './invoiceService';
import type { InvoiceActor } from './invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  timeEntryIds: string[];
}

/**
 * Seed a fully disjoint tenant per test: its own partner + org + user, plus a
 * configurable set of billable time entries. Returning distinct ids per call
 * keeps each test's source rows independent (no cross-test billing bleed).
 */
async function seedFixture(opts?: {
  entries?: Array<{ durationMinutes: number; hourlyRate: string; isApproved?: boolean; billed?: boolean }>;
}): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const entries = opts?.entries ?? [
    { durationMinutes: 60, hourlyRate: '100.00', isApproved: true },
    { durationMinutes: 30, hourlyRate: '100.00', isApproved: false }
  ];
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Inv ${suffix}`, slug: `inv-${suffix}`, type: 'msp', plan: 'pro', status: 'active'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `inv-org-${suffix}`
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    const userId = u!.id;
    const now = new Date();
    const timeEntryIds: string[] = [];
    for (const e of entries) {
      const [te] = await db.insert(timeEntries).values({
        partnerId, orgId, userId, startedAt: now, endedAt: now,
        durationMinutes: e.durationMinutes, description: 'Work', isBillable: true,
        hourlyRate: e.hourlyRate, billingStatus: e.billed ? 'billed' : 'not_billed',
        isApproved: e.isApproved ?? true
      }).returning({ id: timeEntries.id });
      timeEntryIds.push(te!.id);
    }
    return { partnerId, orgId, userId, timeEntryIds };
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

describe.runIf(RUN)('issueInvoice', () => {
  it('assembles, numbers, freezes, flips source rows to billed', async () => {
    const f = await seedFixture();
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    // assembled draft has both entries (1.0h + 0.5h @ 100), total 150.00 pre-tax
    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));

    expect(issued.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
    expect(issued.status).toBe('sent');
    expect(issued.subtotal).toBe('150.00');
    expect(issued.total).toBe('150.00'); // labor is non-taxable
    expect(issued.balance).toBe('150.00');
    expect(issued.issueDate).not.toBeNull();
    expect(issued.dueDate).not.toBeNull();
    // due date is issue + 30d (default terms)
    const issueMs = new Date(issued.issueDate + 'T00:00:00Z').getTime();
    const dueMs = new Date(issued.dueDate + 'T00:00:00Z').getTime();
    expect(Math.round((dueMs - issueMs) / 86400000)).toBe(30);

    // both source time entries flip to billed
    const te = await withSystemDbAccessContext(() =>
      db.select({ s: timeEntries.billingStatus }).from(timeEntries).where(eq(timeEntries.orgId, f.orgId)));
    expect(te.length).toBe(2);
    expect(te.every((r) => r.s === 'billed')).toBe(true);

    // lines are frozen: editing a non-draft invoice is rejected
    await expect(
      withDbAccessContext(ctx(f), () => svc.addManualLine(invoice.id, { description: 'x', quantity: 1, unitPrice: 1, taxable: false }, actor(f)))
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
  });

  it('double-bill guard: re-issuing source rows already billed throws SOURCE_ALREADY_BILLED', async () => {
    const f = await seedFixture();
    // Assemble + issue once (flips rows to billed).
    const { invoice: inv1 } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    await withDbAccessContext(ctx(f), () => svc.issueInvoice(inv1.id, actor(f)));

    // Forge a second draft that references the SAME (now-billed) source rows by
    // cloning inv1's lines into a fresh draft, then attempt to issue it.
    const forgedId = await withSystemDbAccessContext(async () => {
      const [draft] = await db.insert(invoices).values({ partnerId: f.partnerId, orgId: f.orgId, status: 'draft' }).returning({ id: invoices.id });
      const srcLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv1.id));
      await db.insert(invoiceLines).values(srcLines.map((l) => ({
        invoiceId: draft!.id, orgId: l.orgId, sourceType: l.sourceType, sourceId: l.sourceId, catalogItemId: l.catalogItemId,
        parentLineId: null, ticketId: l.ticketId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        costBasis: l.costBasis, revenueAllocation: l.revenueAllocation, taxable: l.taxable, customerVisible: l.customerVisible,
        lineTotal: l.lineTotal, isUnapprovedTime: l.isUnapprovedTime, sortOrder: l.sortOrder
      })));
      return draft!.id;
    });

    await expect(
      withDbAccessContext(ctx(f), () => svc.issueInvoice(forgedId, actor(f)))
    ).rejects.toMatchObject({ code: 'SOURCE_ALREADY_BILLED' });
  });
});

describe.runIf(RUN)('recordPayment', () => {
  it('partial then full payment transitions status and balance; overpayment rejected', async () => {
    const f = await seedFixture();
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));
    expect(issued.total).toBe('150.00');

    await withDbAccessContext(ctx(f), () => svc.recordPayment(issued.id, { amount: 50, method: 'check', receivedAt: '2026-06-14' }, actor(f)));
    let cur = await withDbAccessContext(ctx(f), () => svc.getInvoice(issued.id, actor(f)));
    expect(cur.invoice.status).toBe('partially_paid');
    expect(cur.invoice.balance).toBe('100.00');
    expect(cur.invoice.amountPaid).toBe('50.00');

    await withDbAccessContext(ctx(f), () => svc.recordPayment(issued.id, { amount: 100, method: 'check', receivedAt: '2026-06-14' }, actor(f)));
    cur = await withDbAccessContext(ctx(f), () => svc.getInvoice(issued.id, actor(f)));
    expect(cur.invoice.status).toBe('paid');
    expect(cur.invoice.balance).toBe('0.00');
    expect(cur.invoice.paidAt).not.toBeNull();

    await expect(
      withDbAccessContext(ctx(f), () => svc.recordPayment(issued.id, { amount: 1, method: 'check', receivedAt: '2026-06-14' }, actor(f)))
    ).rejects.toMatchObject({ code: 'OVERPAYMENT' });
  });
});

describe.runIf(RUN)('voidInvoice + runOverdueSweep', () => {
  it('void with reissue marks void, releases source rows, links a fresh draft', async () => {
    const f = await seedFixture();
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));

    const result = await withDbAccessContext(ctx(f), () => svc.voidInvoice(issued.id, 'wrong amounts', { reissue: true }, actor(f)));
    // returned object is the fresh draft (getInvoice shape)
    expect(result.invoice.status).toBe('draft');
    expect(result.invoice.replacesInvoiceId).toBe(issued.id);
    expect(result.lines.length).toBe(2);

    // original is void, linked to the draft
    const original = await withDbAccessContext(ctx(f), () => svc.getInvoice(issued.id, actor(f)));
    expect(original.invoice.status).toBe('void');
    expect(original.invoice.voidedAt).not.toBeNull();
    expect(original.invoice.replacedByInvoiceId).toBe(result.invoice.id);

    // source time entries released back to not_billed
    const te = await withSystemDbAccessContext(() =>
      db.select({ s: timeEntries.billingStatus }).from(timeEntries).where(eq(timeEntries.orgId, f.orgId)));
    expect(te.length).toBe(2);
    expect(te.every((r) => r.s === 'not_billed')).toBe(true);
  });

  it('void+reissue preserves bundle hierarchy: cloned child lines point at the cloned parent', async () => {
    const f = await seedFixture();
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));

    // Inject a bundle parent + a child line under it into the issued invoice
    // (system context bypasses the draft guard). This mirrors what addBundleLine
    // produces: a parent (parent_line_id NULL) and child rows with parent_line_id set.
    const { parentId, childId } = await withSystemDbAccessContext(async () => {
      const [parent] = await db.insert(invoiceLines).values({
        invoiceId: issued.id, orgId: f.orgId, sourceType: 'bundle', sourceId: null, catalogItemId: null,
        parentLineId: null, ticketId: null, description: 'Bundle A', quantity: '1', unitPrice: '500.00',
        costBasis: null, taxable: true, customerVisible: true, lineTotal: '500.00', isUnapprovedTime: false, sortOrder: 10
      }).returning({ id: invoiceLines.id });
      const [child] = await db.insert(invoiceLines).values({
        invoiceId: issued.id, orgId: f.orgId, sourceType: 'bundle', sourceId: null, catalogItemId: null,
        parentLineId: parent!.id, ticketId: null, description: 'Bundle component', quantity: '1', unitPrice: '0.00',
        costBasis: null, taxable: false, customerVisible: true, lineTotal: '0.00', isUnapprovedTime: false, sortOrder: 10
      }).returning({ id: invoiceLines.id });
      return { parentId: parent!.id, childId: child!.id };
    });
    expect(parentId).toBeTruthy();
    expect(childId).toBeTruthy();

    const result = await withDbAccessContext(ctx(f), () => svc.voidInvoice(issued.id, 'rebuild', { reissue: true }, actor(f)));
    expect(result.invoice.status).toBe('draft');

    // The cloned draft must contain a bundle parent (parentLineId NULL) and a
    // child whose parentLineId points at the cloned parent's id (not the old one).
    const cloned = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, result.invoice.id)));
    const clonedParent = cloned.find((l) => l.sourceType === 'bundle' && l.parentLineId === null && l.description === 'Bundle A');
    const clonedChild = cloned.find((l) => l.description === 'Bundle component');
    expect(clonedParent).toBeTruthy();
    expect(clonedChild).toBeTruthy();
    expect(clonedChild!.parentLineId).not.toBeNull();
    expect(clonedChild!.parentLineId).toBe(clonedParent!.id);
    // Remap is to the NEW parent, never the original.
    expect(clonedChild!.parentLineId).not.toBe(parentId);
  });

  it('runOverdueSweep flips a past-due sent invoice to overdue', async () => {
    const f = await seedFixture();
    const { invoice } = await withDbAccessContext(ctx(f), () =>
      svc.assembleDraftFromOrg({ orgId: f.orgId, from: dayBefore(), to: dayAfter() }, actor(f)));
    const issued = await withDbAccessContext(ctx(f), () => svc.issueInvoice(invoice.id, actor(f)));
    expect(issued.status).toBe('sent');

    // Sweep with asOf far in the future (well past the 30d due date).
    const future = new Date(Date.now() + 60 * 86400000);
    const flipped = await svc.runOverdueSweep(future);
    expect(flipped).toBeGreaterThanOrEqual(1);

    const cur = await withDbAccessContext(ctx(f), () => svc.getInvoice(issued.id, actor(f)));
    expect(cur.invoice.status).toBe('overdue');
    expect(cur.invoice.markedOverdueAt).not.toBeNull();
  });
});
