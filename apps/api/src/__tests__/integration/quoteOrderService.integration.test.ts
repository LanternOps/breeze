/**
 * Real-Postgres coverage for quoteOrderService (Task 11 fix round 1).
 *
 * The unit suite (quoteOrderService — exercised via the mocked route tests in
 * routes/quotes/quoteOrders.test.ts) cannot prove the idempotent-create design
 * actually survives a real Postgres conflict: a mocked db.transaction never
 * raises a real 23505, so it can't catch the documented trap where a caught
 * unique-violation INSIDE the same transaction that raised it leaves postgres.js
 * with a latched, aborted (sub)transaction — every following statement 25P02s,
 * and the caller sees a raw 500 instead of the existing order (see
 * partnerStripe.ts's connectStripeAccount comment for the same trap). This
 * drives createQuoteOrder's real `.onConflictDoNothing()` insert against a real
 * partial unique index (quote_orders_client_request_uq) under genuine
 * concurrency, plus the 409/400/cancel/receipt-guard paths a mocked db can only
 * assert the shape of, never the actual constraint.
 *
 * Mirrors the harness of quoteDeposit.integration.test.ts (org-scope ctx/actor
 * helpers, `runDb` gate, withSystemDbAccessContext for tenant seeding).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quoteOrders, quoteOrderLines } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { createQuoteOrder, updateQuoteOrder, updateQuoteOrderLine, listQuoteOrders } from '../../services/quoteOrderService';
import type { QuoteActor } from '../../services/quoteTypes';
import { randomUUID } from 'node:crypto';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function qActor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}

/** Draft → sent → accepted (status='converted'), one manual $100 one-time line,
 *  ready for fulfillment. Mirrors quoteDeposit.integration.test.ts's flow. */
async function seedConvertedQuote(ctx: DbAccessContext, actor: QuoteActor, orgId: string) {
  const created = await withDbAccessContext(ctx, () => createQuote({ orgId, currencyCode: 'USD' }, actor));
  const line = await withDbAccessContext(ctx, () =>
    addManualLine(created.id, {
      sourceType: 'manual', description: 'Managed switch', quantity: 1, unitPrice: 100,
      taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
    }, actor)
  );
  await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
  await withDbAccessContext(ctx, () =>
    acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer', signerEmail: 'jane@org.example' })
  );
  return { quoteId: created.id, lineId: line.id };
}

describe('quoteOrderService (breeze_app, real DB)', () => {
  runDb('createQuoteOrder is idempotent on clientRequestId across two SEQUENTIAL calls: same order id, allocations not duplicated', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const clientRequestId = randomUUID();
    const input = { clientRequestId, lines: [{ quoteLineId: lineId, orderedQty: 3 }] };

    const first = await withDbAccessContext(ctx, () => createQuoteOrder(quoteId, input, actor));
    const second = await withDbAccessContext(ctx, () => createQuoteOrder(quoteId, input, actor));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(1);

    const orderRows = await withSystemDbAccessContext(() =>
      db.select().from(quoteOrders).where(and(eq(quoteOrders.quoteId, quoteId), eq(quoteOrders.clientRequestId, clientRequestId)))
    );
    expect(orderRows).toHaveLength(1);
    const lineRows = await withSystemDbAccessContext(() =>
      db.select().from(quoteOrderLines).where(eq(quoteOrderLines.orderId, first.id))
    );
    expect(lineRows).toHaveLength(1); // NOT duplicated by the second call
  });

  runDb('createQuoteOrder survives two CONCURRENT calls with the same clientRequestId — no 500, exactly one order + its allocations committed', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const clientRequestId = randomUUID();
    const input = { clientRequestId, lines: [{ quoteLineId: lineId, orderedQty: 2 }] };

    // Two genuinely overlapping transactions racing the same partial unique
    // index (quote_orders_client_request_uq). This is the exact shape the
    // reviewed CRITICAL finding said a caught-in-transaction 23505 cannot
    // survive: the loser's catch block would 25P02 on its own re-read and the
    // caller would see a raw 500 instead of the winner's order. The no-abort
    // ON CONFLICT DO NOTHING design must resolve both calls successfully.
    const [a, b] = await Promise.all([
      withDbAccessContext(ctx, () => createQuoteOrder(quoteId, input, actor)),
      withDbAccessContext(ctx, () => createQuoteOrder(quoteId, input, actor)),
    ]);

    expect(a.id).toBe(b.id);
    // Exactly one of the two calls actually inserted the row.
    expect([a.created, b.created].sort()).toEqual([false, true]);

    const orderRows = await withSystemDbAccessContext(() =>
      db.select().from(quoteOrders).where(and(eq(quoteOrders.quoteId, quoteId), eq(quoteOrders.clientRequestId, clientRequestId)))
    );
    expect(orderRows).toHaveLength(1);
    const lineRows = await withSystemDbAccessContext(() =>
      db.select().from(quoteOrderLines).where(eq(quoteOrderLines.orderId, orderRows[0]!.id))
    );
    expect(lineRows).toHaveLength(1); // never duplicated by the losing call
  });

  runDb('409s (QUOTE_NOT_FULFILLABLE) when the quote is still a draft', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);

    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    const line = await withDbAccessContext(ctx, () =>
      addManualLine(created.id, {
        sourceType: 'manual', description: 'Widget', quantity: 1, unitPrice: 50,
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, actor)
    );

    await expect(withDbAccessContext(ctx, () =>
      createQuoteOrder(created.id, { clientRequestId: randomUUID(), lines: [{ quoteLineId: line.id, orderedQty: 1 }] }, actor)
    )).rejects.toMatchObject({ status: 409, code: 'QUOTE_NOT_FULFILLABLE' });
  });

  runDb('400s (QUOTE_LINE_MISMATCH) when a quoteLineId belongs to a different quote', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId } = await seedConvertedQuote(ctx, actor, org.id);

    // A second, unrelated quote with its own line — that line does not belong
    // to `quoteId` above.
    const otherQuote = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    const foreignLine = await withDbAccessContext(ctx, () =>
      addManualLine(otherQuote.id, {
        sourceType: 'manual', description: 'Foreign line', quantity: 1, unitPrice: 10,
        taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, actor)
    );

    await expect(withDbAccessContext(ctx, () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), lines: [{ quoteLineId: foreignLine.id, orderedQty: 1 }] }, actor)
    )).rejects.toMatchObject({ status: 400, code: 'QUOTE_LINE_MISMATCH' });
  });

  runDb('updateQuoteOrderLine: { cancelled: true } stamps cancelledAt; { cancelled: false } clears it', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const order = await withDbAccessContext(ctx, () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), lines: [{ quoteLineId: lineId, orderedQty: 4 }] }, actor)
    );
    const orderLineId = order.lines[0]!.id;

    const cancelled = await withDbAccessContext(ctx, () =>
      updateQuoteOrderLine(quoteId, order.id, orderLineId, { cancelled: true }, actor)
    );
    expect(cancelled.changed).toBe(true);
    expect(cancelled.cancelledAt).not.toBeNull();

    const uncancelled = await withDbAccessContext(ctx, () =>
      updateQuoteOrderLine(quoteId, order.id, orderLineId, { cancelled: false }, actor)
    );
    expect(uncancelled.cancelledAt).toBeNull();
  });

  runDb('updateQuoteOrderLine: receivedQty > orderedQty 400s (RECEIVED_QTY_EXCEEDS_ORDERED) and writes nothing', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const order = await withDbAccessContext(ctx, () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), lines: [{ quoteLineId: lineId, orderedQty: 2 }] }, actor)
    );
    const orderLineId = order.lines[0]!.id;

    await expect(withDbAccessContext(ctx, () =>
      updateQuoteOrderLine(quoteId, order.id, orderLineId, { receivedQty: 999 }, actor)
    )).rejects.toMatchObject({ status: 400, code: 'RECEIVED_QTY_EXCEEDS_ORDERED' });

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(quoteOrderLines).where(eq(quoteOrderLines.id, orderLineId))
    );
    expect(row!.receivedQty).toBe('0.00');
    expect(row!.receivedAt).toBeNull();
  });

  runDb('updateQuoteOrderLine: a receivedQty correction back to 0 clears receivedAt (not a fresh stamp)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const order = await withDbAccessContext(ctx, () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), lines: [{ quoteLineId: lineId, orderedQty: 5 }] }, actor)
    );
    const orderLineId = order.lines[0]!.id;

    const received = await withDbAccessContext(ctx, () =>
      updateQuoteOrderLine(quoteId, order.id, orderLineId, { receivedQty: 5 }, actor)
    );
    expect(received.receivedAt).not.toBeNull();

    const corrected = await withDbAccessContext(ctx, () =>
      updateQuoteOrderLine(quoteId, order.id, orderLineId, { receivedQty: 0 }, actor)
    );
    expect(corrected.receivedQty).toBe('0.00');
    expect(corrected.receivedAt).toBeNull();
  });

  runDb('updateQuoteOrderLine: rejects a receipt against a cancelled allocation (QUOTE_ORDER_LINE_CANCELLED)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const order = await withDbAccessContext(ctx, () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), lines: [{ quoteLineId: lineId, orderedQty: 3 }] }, actor)
    );
    const orderLineId = order.lines[0]!.id;

    await withDbAccessContext(ctx, () => updateQuoteOrderLine(quoteId, order.id, orderLineId, { cancelled: true }, actor));

    await expect(withDbAccessContext(ctx, () =>
      updateQuoteOrderLine(quoteId, order.id, orderLineId, { receivedQty: 1 }, actor)
    )).rejects.toMatchObject({ status: 400, code: 'QUOTE_ORDER_LINE_CANCELLED' });
  });

  runDb('updateQuoteOrder patches header fields; listQuoteOrders reflects it grouped with its allocations', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctx, actor, org.id);

    const order = await withDbAccessContext(ctx, () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), vendorName: 'Old Vendor', lines: [{ quoteLineId: lineId, orderedQty: 1 }] }, actor)
    );

    const updated = await withDbAccessContext(ctx, () =>
      updateQuoteOrder(quoteId, order.id, { vendorName: 'New Vendor' }, actor)
    );
    expect(updated.vendorName).toBe('New Vendor');

    const orders = await withDbAccessContext(ctx, () => listQuoteOrders(quoteId));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.vendorName).toBe('New Vendor');
    expect(orders[0]!.lines).toHaveLength(1);
  });

  runDb('createQuoteOrder 404s (QUOTE_NOT_FOUND) for a cross-org quote id', async () => {
    const { partner, org } = await seed();
    const other = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const ctxA = ctxFor(org.id, partner.id);
    const actorB = qActor(other.id, partner.id);
    const { quoteId, lineId } = await seedConvertedQuote(ctxA, qActor(org.id, partner.id), org.id);

    // actorB is scoped to a DIFFERENT org; RLS makes org A's quote invisible to it.
    await expect(withDbAccessContext(ctxFor(other.id, partner.id), () =>
      createQuoteOrder(quoteId, { clientRequestId: randomUUID(), lines: [{ quoteLineId: lineId, orderedQty: 1 }] }, actorB)
    )).rejects.toMatchObject({ status: 404, code: 'QUOTE_NOT_FOUND' });
  });
});
