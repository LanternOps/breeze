import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { quotes, quoteLines, quoteOrders, quoteOrderLines } from '../db/schema/quotes';
// QuoteServiceError/QuoteActor/assertQuoteAccess all live in quoteTypes (the
// actual source — every quote-domain service module imports them from there).
// assertQuoteAccess in particular MUST come from quoteTypes, not quoteService:
// quoteService.getQuote calls listQuoteOrders (below) to build its response, so
// importing assertQuoteAccess from quoteService here would create a module
// cycle (quoteOrderService -> quoteService -> quoteOrderService).
import { QuoteServiceError, assertQuoteAccess, type QuoteActor } from './quoteTypes';
import { toCents, type CreateQuoteOrderInput, type UpdateQuoteOrderInput, type UpdateQuoteOrderLineInput } from '@breeze/shared';

export type QuoteOrder = typeof quoteOrders.$inferSelect;
export type QuoteOrderLine = typeof quoteOrderLines.$inferSelect;
export type QuoteOrderWithLines = QuoteOrder & { lines: QuoteOrderLine[] };

// A quote can only be fulfilled once it's a firm commitment from the customer —
// mirrors the pax8 auto-order gate (quoteAcceptService), which only fires on
// the same two statuses.
const FULFILLABLE_STATUSES = ['accepted', 'converted'] as const;

/**
 * Record a procurement order (PO) against an accepted/converted quote: one
 * header row plus one allocation row per submitted quote line.
 *
 * Idempotent on `clientRequestId` — a double-click or retried submit hits the
 * partial unique index `quote_orders_client_request_uq` (quote_id,
 * client_request_id). This uses `.onConflictDoNothing()` targeted at exactly
 * that index rather than a try/catch around a plain insert: a 23505 CAUGHT
 * inside the SAME transaction that raised it is a documented trap in this repo
 * (see partnerStripe.ts's connectStripeAccount comment) — postgres.js latches
 * the failed statement and aborts the (sub)transaction, so the very next
 * statement (including a "safe" re-read) fails with 25P02, and the caller
 * always sees a raw 500, never the existing order. `DO NOTHING` never raises,
 * so there's nothing to abort and no inner-savepoint dance required. (Drizzle
 * 0.45's `onConflictDoNothing` config key for a partial-index predicate is
 * `where`, not `targetWhere` — `targetWhere` only exists on
 * `onConflictDoUpdate`'s config; confirmed against the installed
 * drizzle-orm .d.ts and the existing `where: sql\`...\`` precedent in
 * manifestSigning.ts.)
 */
export async function createQuoteOrder(
  quoteId: string,
  input: CreateQuoteOrderInput,
  actor: QuoteActor,
): Promise<QuoteOrderWithLines & { created: boolean }> {
  return db.transaction(async (tx) => {
    const [q] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
    assertQuoteAccess(actor, q);
    if (!FULFILLABLE_STATUSES.includes(q.status as (typeof FULFILLABLE_STATUSES)[number])) {
      throw new QuoteServiceError('Only accepted or converted quotes can be fulfilled', 409, 'QUOTE_NOT_FULFILLABLE');
    }

    const lineIds = input.lines.map((l) => l.quoteLineId);
    const owned = await tx.select({ id: quoteLines.id }).from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), inArray(quoteLines.id, lineIds)));
    if (owned.length !== new Set(lineIds).size) {
      throw new QuoteServiceError('Line does not belong to this quote', 400, 'QUOTE_LINE_MISMATCH');
    }

    const inserted = await tx.insert(quoteOrders).values({
      quoteId,
      orgId: q.orgId,
      procurementSource: input.procurementSource ?? null,
      vendorName: input.vendorName ?? null,
      orderRef: input.orderRef ?? null,
      orderedBy: actor.userId,
      notes: input.notes ?? null,
      clientRequestId: input.clientRequestId,
    })
      .onConflictDoNothing({
        target: [quoteOrders.quoteId, quoteOrders.clientRequestId],
        where: sql`${quoteOrders.clientRequestId} is not null`,
      })
      .returning();

    if (inserted.length === 0) {
      // Lost the race (or this is a retried submit): another committer already
      // holds this (quoteId, clientRequestId) pair. Re-read the existing order
      // + its allocations and return it WITHOUT inserting new allocations —
      // this insert never ran, so there is nothing to roll back and no
      // duplicated allocation rows.
      const [existing] = await tx.select().from(quoteOrders).where(and(
        eq(quoteOrders.quoteId, quoteId), eq(quoteOrders.clientRequestId, input.clientRequestId),
      )).limit(1);
      if (!existing) {
        // Defensive — a DO NOTHING conflict on this exact target implies a row
        // already exists under this key; a miss here means the partial index
        // and this query disagree, which is a bug, not a user-facing error.
        throw new QuoteServiceError('Failed to resolve the existing order for this request', 500, 'QUOTE_ORDER_NOT_FOUND');
      }
      const lines = await tx.select().from(quoteOrderLines).where(eq(quoteOrderLines.orderId, existing.id));
      return { ...existing, lines, created: false };
    }

    const order = inserted[0]!;
    const lines = await tx.insert(quoteOrderLines).values(input.lines.map((l) => ({
      orderId: order.id,
      quoteId,
      orgId: q.orgId,
      quoteLineId: l.quoteLineId,
      orderedQty: String(l.orderedQty),
      trackingNumber: input.trackingNumber ?? null,
      eta: input.eta ?? null,
    }))).returning();
    return { ...order, lines, created: true };
  });
}

/** Load the quote and assert access; shared by every order/line mutation path
 *  below so a caller can't touch an order (or a line under it) it can't reach
 *  via the quote's own org/site access rules. */
async function loadAccessibleQuote(quoteId: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  return q;
}

/** Load an order row and verify it belongs to `quoteId` — the composite unique
 *  index (id, quote_id, org_id) backs this, so a foreign orderId 404s rather
 *  than silently resolving under the wrong quote. */
async function loadOrderOnQuote(quoteId: string, orderId: string) {
  const [order] = await db.select().from(quoteOrders)
    .where(and(eq(quoteOrders.id, orderId), eq(quoteOrders.quoteId, quoteId))).limit(1);
  if (!order) throw new QuoteServiceError('Order not found', 404, 'QUOTE_ORDER_NOT_FOUND');
  return order;
}

export async function updateQuoteOrder(
  quoteId: string,
  orderId: string,
  input: UpdateQuoteOrderInput,
  actor: QuoteActor,
): Promise<QuoteOrder> {
  await loadAccessibleQuote(quoteId, actor);
  await loadOrderOnQuote(quoteId, orderId);

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.vendorName !== undefined) set.vendorName = input.vendorName;
  if (input.orderRef !== undefined) set.orderRef = input.orderRef;
  if (input.notes !== undefined) set.notes = input.notes;

  const [updated] = await db.update(quoteOrders).set(set)
    .where(and(eq(quoteOrders.id, orderId), eq(quoteOrders.quoteId, quoteId)))
    .returning();
  return updated!;
}

export async function updateQuoteOrderLine(
  quoteId: string,
  orderId: string,
  lineId: string,
  input: UpdateQuoteOrderLineInput,
  actor: QuoteActor,
): Promise<QuoteOrderLine & { changed: boolean }> {
  await loadAccessibleQuote(quoteId, actor);
  await loadOrderOnQuote(quoteId, orderId);
  const [line] = await db.select().from(quoteOrderLines)
    .where(and(eq(quoteOrderLines.id, lineId), eq(quoteOrderLines.orderId, orderId))).limit(1);
  if (!line) throw new QuoteServiceError('Order line not found', 404, 'QUOTE_ORDER_LINE_NOT_FOUND');

  const set: Record<string, unknown> = {};
  if (input.receivedQty !== undefined) {
    // A cancelled allocation is invisible to deriveLineFulfillment (it filters
    // cancelledAt rows out entirely), so recording a receipt against one would
    // be a silent no-op that never shows up in the derived status. Reject it —
    // the caller must un-cancel first (this same request MAY do both: an
    // explicit `cancelled: false` here wins over the row's current state).
    const effectiveCancelled = input.cancelled !== undefined ? input.cancelled : !!line.cancelledAt;
    if (effectiveCancelled) {
      throw new QuoteServiceError('Cannot record a receipt against a cancelled allocation', 400, 'QUOTE_ORDER_LINE_CANCELLED');
    }
    // Validate BEFORE the DB CHECK (quote_order_lines_qty_chk) so the client
    // gets a clean 400 message instead of a raw constraint-violation 500.
    // Cents-compare (toCents), never a float comparison, to stay consistent
    // with every other money/qty comparison in the quote domain.
    if (toCents(input.receivedQty) > toCents(line.orderedQty)) {
      throw new QuoteServiceError('Received quantity cannot exceed ordered quantity', 400, 'RECEIVED_QTY_EXCEEDS_ORDERED');
    }
    set.receivedQty = String(input.receivedQty);
    // A correction back to 0 is "this was never received" — clear the receipt
    // timestamp instead of stamping a fresh one, or the row would claim a
    // receipt just happened while recording zero received.
    set.receivedAt = input.receivedQty === 0 ? null : new Date();
  }
  if (input.trackingNumber !== undefined) set.trackingNumber = input.trackingNumber;
  if (input.eta !== undefined) set.eta = input.eta;
  if (input.cancelled !== undefined) set.cancelledAt = input.cancelled ? new Date() : null;

  if (Object.keys(set).length === 0) return { ...line, changed: false };

  const [updated] = await db.update(quoteOrderLines).set(set)
    .where(and(eq(quoteOrderLines.id, lineId), eq(quoteOrderLines.orderId, orderId), eq(quoteOrderLines.quoteId, quoteId)))
    .returning();
  return { ...updated!, changed: true };
}

/**
 * All order headers + allocations for a quote, grouped in JS. Two queries
 * (not a join) so the header shape stays flat for callers that only need the
 * order list — `quote_order_lines_quote_idx` backs the second query directly
 * on quote_id, so it doesn't need the header ids from the first query first.
 */
export async function listQuoteOrders(quoteId: string): Promise<QuoteOrderWithLines[]> {
  const orders = await db.select().from(quoteOrders).where(eq(quoteOrders.quoteId, quoteId));
  const lines = await db.select().from(quoteOrderLines).where(eq(quoteOrderLines.quoteId, quoteId));
  const byOrder = new Map<string, QuoteOrderLine[]>();
  for (const line of lines) {
    const bucket = byOrder.get(line.orderId);
    if (bucket) bucket.push(line); else byOrder.set(line.orderId, [line]);
  }
  return orders.map((order) => ({ ...order, lines: byOrder.get(order.id) ?? [] }));
}
