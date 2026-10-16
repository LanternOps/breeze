/**
 * Customer work approval W02 Task 6 (#4617 spec §5.7): every money reader
 * treats held time as unbilled-but-not-invoiceable, against real Postgres.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketEvents')>()),
  emitTicketEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { invoiceLines, invoices } from '../../db/schema';
import * as timeSvc from '../../services/timeEntryService';
import { decideApprovalRequest } from '../../services/ticketApproval/decisions';
import { gatherOrgTimeEntries, gatherTicketBillables } from '../../services/invoiceAssembly';
import { getOrgCurrencyImpact } from '../../services/orgCurrencyService';
import { issueInvoice } from '../../services/invoiceService';
import { actor, ctx, insertSettledEntry, seedApprovalFixture, type ApprovalFixture } from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;
const asTech = <T>(f: ApprovalFixture, fn: () => Promise<T>) => withDbAccessContext(ctx(f), fn);
const invoiceActor = (f: ApprovalFixture) => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId, f.otherOrgId] });

/** A held entry (30 min over a 60-min budget that is already used up). */
async function heldEntry(f: ApprovalFixture) {
  await insertSettledEntry(f, 60);
  return asTech(f, () => timeSvc.createTimeEntry({
    ticketId: f.ticketId, startedAt: new Date(Date.now() - 30 * 60_000), endedAt: new Date(), isBillable: true,
    hourlyRate: 100, // monetary: the fixture org has no billing card to stamp a rate
  }, actor(f)));
}

async function deny(f: ApprovalFixture, requestId: string) {
  await asTech(f, () => decideApprovalRequest(db, {
    requestId, decision: 'denied', revision: 1,
    actor: { kind: 'on_behalf', userId: f.userId, method: 'verbal', reference: 'Call', signerName: 'Pat' },
  }));
}

describe.runIf(RUN)('held time in the money readers (spec §5.7)', () => {
  it('ticketMoveCurrencyGuard: a held USD entry blocks a move to a EUR org, like not_billed time', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    const held = await heldEntry(f);
    await deny(f, held.approvalHold!.requestId); // no pending request: only the currency guard can refuse
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE organizations SET currency_code = 'EUR' WHERE id = ${f.otherOrgId}::uuid`));
    // Only the held entry is unbilled money on the ticket.
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE time_entries SET billing_status = 'billed' WHERE ticket_id = ${f.ticketId}::uuid AND id <> ${held.id}::uuid`));
    const { moveTicketOrg } = await import('../../services/ticketService');
    const err = await asTech(f, () => moveTicketOrg(f.ticketId, f.otherOrgId, { kind: 'user' as const, userId: f.userId })).catch((e) => e);
    expect(err).toMatchObject({ code: 'TICKET_MOVE_CURRENCY_BLOCKED', details: expect.objectContaining({ unbilledTimeEntries: 1 }) });
  });

  it('orgCurrencyService: the currency-change impact counts held time as a stranded monetary snapshot', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    const held = await heldEntry(f);
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE time_entries SET billing_status = 'billed' WHERE ticket_id = ${f.ticketId}::uuid AND id <> ${held.id}::uuid`));
    const impact = await asTech(f, () => getOrgCurrencyImpact(f.orgId, 'EUR', invoiceActor(f)));
    const usd = impact.impactsByCurrency.find((g) => g.currencyCode === 'USD');
    expect(usd?.billables.monetaryTimeSnapshots).toBe(1);
  });

  it('invoice gatherers never pick up held time (org range and per-ticket)', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    const held = await heldEntry(f);
    const from = new Date(Date.now() - 7 * 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    const org = await asTech(f, () => gatherOrgTimeEntries(f.orgId, from, to, 'USD'));
    const ticket = await asTech(f, () => gatherTicketBillables(f.ticketId, 'USD'));
    const ids = [...org.included, ...ticket.included].map((l) => l.sourceId);
    expect(ids).not.toContain(held.id);
    expect(ids.length).toBeGreaterThan(0); // the settled entry IS gathered
  });

  it('issuing a draft whose source became held after drafting is 409 SOURCE_AWAITING_APPROVAL', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 600 });
    const entry = await insertSettledEntry(f, 30);
    const draftId = await withSystemDbAccessContext(async () => {
      const [draft] = await db.insert(invoices).values({ partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode: 'USD' })
        .returning({ id: invoices.id });
      await db.insert(invoiceLines).values({
        invoiceId: draft!.id, orgId: f.orgId, sourceType: 'time_entry', sourceId: entry, catalogItemId: null, parentLineId: null,
        ticketId: f.ticketId, description: 'Work', quantity: '0.50', unitPrice: '100.00', costBasis: null, taxable: false,
        customerVisible: true, lineTotal: '50.00', isUnapprovedTime: false, sortOrder: 0,
      });
      return draft!.id;
    });
    // The entry is held after the draft was assembled (e.g. a budget was lowered and it was edited).
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE time_entries SET billing_status = 'awaiting_approval' WHERE id = ${entry}::uuid`));
    const err = await asTech(f, () => issueInvoice(draftId, invoiceActor(f))).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'SOURCE_AWAITING_APPROVAL' });
  });
});
