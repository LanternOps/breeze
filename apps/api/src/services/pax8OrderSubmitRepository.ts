import type { Pax8OrderStatus, Pax8SubmitState } from '@breeze/shared';
import { and, asc, eq, getTableColumns, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  type DbAccessContext,
} from '../db';
import {
  contractLines,
  pax8CompanyMappings,
  pax8OrderLines,
  pax8Orders,
} from '../db/schema';
import {
  Pax8OrderError,
  requireImmediateCancelDate,
  validateDirectOrderLinesForSubmit,
  type Pax8OrderLineRow,
  type Pax8OrderRow,
} from './pax8OrderService';
import type {
  Pax8OrderSubmitRepository,
  SubmitBundle,
  SubmitLineOutcome,
  SubmitResult,
} from './pax8OrderSubmit';
import { createPax8ClientForIntegration } from './pax8SyncService';
import { pax8CompanyOrderReadiness } from './pax8CompanyReadiness';

const SUBMITTABLE_STATUSES = ['draft', 'awaiting_details', 'ready'] as const;

function partnerDbContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function orderDbContext(partnerId: string, orgId: string): DbAccessContext {
  return {
    ...partnerDbContext(partnerId),
    orgId,
    accessibleOrgIds: [orgId],
  };
}

function withPartnerDbContext<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(partnerDbContext(partnerId), fn));
}

function withOrderDbContext<T>(bundle: SubmitBundle, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(
    orderDbContext(bundle.order.partnerId, bundle.order.orgId),
    fn,
  ));
}

function withOrderScopeDbContext<T>(
  partnerId: string,
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(orderDbContext(partnerId, orgId), fn));
}

type VersionedOrder = Pax8OrderRow & { rowVersion: string };

async function findOrder(partnerId: string, orderId: string): Promise<VersionedOrder> {
  const [order] = await db
    .select({ ...getTableColumns(pax8Orders), rowVersion: sql<string>`xmin::text` })
    .from(pax8Orders)
    .where(and(eq(pax8Orders.partnerId, partnerId), eq(pax8Orders.id, orderId)))
    .limit(1);
  if (!order) throw new Pax8OrderError('Pax8 order not found.', 404);
  return order;
}

async function findOrderLines(order: Pax8OrderRow): Promise<Pax8OrderLineRow[]> {
  return db
    .select()
    .from(pax8OrderLines)
    .where(and(
      eq(pax8OrderLines.partnerId, order.partnerId),
      eq(pax8OrderLines.orgId, order.orgId),
      eq(pax8OrderLines.orderId, order.id),
    ))
    .orderBy(asc(pax8OrderLines.sortOrder), asc(pax8OrderLines.id));
}

async function resolveCompany(order: Pax8OrderRow): Promise<string> {
  const mappings = await db
    .select({
      pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
      status: pax8CompanyMappings.status,
      metadata: pax8CompanyMappings.metadata,
    })
    .from(pax8CompanyMappings)
    .where(and(
      eq(pax8CompanyMappings.integrationId, order.integrationId),
      eq(pax8CompanyMappings.partnerId, order.partnerId),
      eq(pax8CompanyMappings.orgId, order.orgId),
      eq(pax8CompanyMappings.ignored, false),
    ))
    .for('share');
  if (mappings.length === 0) {
    throw new Pax8OrderError('Map this organization to a Pax8 company before ordering.', 422);
  }
  if (mappings.length !== 1) {
    throw new Pax8OrderError('Multiple Pax8 companies are mapped to this organization; resolve the mapping before ordering.', 422);
  }
  if (!pax8CompanyOrderReadiness(mappings[0]!.status, mappings[0]!.metadata).orderReady) {
    throw new Pax8OrderError(
      'The mapped Pax8 company is not ready for ordering. It must be Active with primary Admin, Billing, and Technical contacts.',
      422,
    );
  }
  return mappings[0]!.pax8CompanyId;
}

async function persistResolvedCompany(order: VersionedOrder, pax8CompanyId: string): Promise<Pax8OrderRow> {
  const [updated] = await db
    .update(pax8Orders)
    .set({ pax8CompanyId, updatedAt: new Date() })
    .where(and(
      eq(pax8Orders.id, order.id),
      eq(pax8Orders.partnerId, order.partnerId),
      eq(pax8Orders.orgId, order.orgId),
      eq(pax8Orders.integrationId, order.integrationId),
      eq(pax8Orders.status, order.status),
      sql`${pax8Orders}.xmin::text = ${order.rowVersion}`,
    ))
    .returning();
  if (!updated) throw new Pax8OrderError('The Pax8 company mapping changed while loading the order.', 409);
  return updated;
}

function assertSubmittable(order: Pax8OrderRow): void {
  if (!(SUBMITTABLE_STATUSES as readonly string[]).includes(order.status)) {
    throw new Pax8OrderError('This Pax8 order cannot be submitted in its current state. Reconcile any unknown write first.', 409);
  }
}

function deriveOrderStatus(states: Pax8SubmitState[]): Pax8OrderStatus {
  if (states.length > 0 && states.every((state) => state === 'succeeded')) return 'completed';
  if (states.length > 0 && states.every((state) => state === 'failed')) return 'failed';
  return 'partially_failed';
}

function resultFromRows(orderId: string, status: Pax8OrderStatus, lines: Pax8OrderLineRow[]): SubmitResult {
  return {
    orderId,
    status,
    lines: lines.map((line) => ({
      lineId: line.id,
      submitState: line.submitState as Pax8SubmitState,
      error: line.error,
    })),
  };
}

async function lockExecutingOrder(bundle: SubmitBundle): Promise<Pax8OrderRow> {
  if (!bundle.order.pax8CompanyId || !bundle.order.submittedAt) {
    throw new Pax8OrderError('The Pax8 order is missing its immutable submission snapshot.', 409);
  }
  const [order] = await db
    .select()
    .from(pax8Orders)
    .where(and(
      eq(pax8Orders.id, bundle.order.id),
      eq(pax8Orders.partnerId, bundle.order.partnerId),
      eq(pax8Orders.orgId, bundle.order.orgId),
      eq(pax8Orders.integrationId, bundle.order.integrationId),
      eq(pax8Orders.status, 'submitting'),
      eq(pax8Orders.pax8CompanyId, bundle.order.pax8CompanyId),
      eq(pax8Orders.submittedAt, bundle.order.submittedAt),
    ))
    .for('update')
    .limit(1);
  if (!order) throw new Pax8OrderError('The Pax8 order execution state changed.', 409);
  return order;
}

async function updateManualContractQuantity(
  line: Pax8OrderLineRow,
): Promise<void> {
  if (!line.contractLineId) return;
  const [contractLine] = await db
    .select({ id: contractLines.id, lineType: contractLines.lineType })
    .from(contractLines)
    .where(and(
      eq(contractLines.id, line.contractLineId),
      eq(contractLines.orgId, line.orgId),
    ))
    .limit(1);
  if (!contractLine) {
    throw new Pax8OrderError('The linked contract line is unavailable; the Pax8 result requires reconciliation.', 409);
  }
  if (contractLine.lineType !== 'manual') return;
  const quantity = line.action === 'cancel' ? '0' : line.quantity;
  if (quantity === null) return;
  const updated = await db
    .update(contractLines)
    .set({ manualQuantity: quantity })
    .where(and(
      eq(contractLines.id, line.contractLineId),
      eq(contractLines.orgId, line.orgId),
      eq(contractLines.lineType, 'manual' as never),
    ))
    .returning({ id: contractLines.id });
  if (updated.length !== 1) {
    throw new Pax8OrderError('The linked manual contract line changed before billing quantity was recorded.', 409);
  }
}

async function persistLineOutcomes(
  bundle: SubmitBundle,
  outcomes: SubmitLineOutcome[],
  expectedState: 'in_flight' | readonly ['in_flight', 'needs_reconcile'],
): Promise<void> {
  const lineById = new Map(bundle.lines.map((line) => [line.id, line]));
  if (new Set(outcomes.map((outcome) => outcome.lineId)).size !== outcomes.length) {
    throw new Pax8OrderError('Duplicate Pax8 line outcomes were produced.', 409);
  }
  for (const outcome of outcomes) {
    const line = lineById.get(outcome.lineId);
    if (!line) throw new Pax8OrderError('A Pax8 line result does not belong to this order.', 409);
    const stateCondition = typeof expectedState === 'string'
      ? eq(pax8OrderLines.submitState, expectedState)
      : inArray(pax8OrderLines.submitState, [...expectedState]);
    const updated = await db
      .update(pax8OrderLines)
      .set({
        submitState: outcome.submitState,
        resultSubscriptionId: outcome.resultSubscriptionId,
        error: outcome.error,
        updatedAt: new Date(),
      })
      .where(and(
        eq(pax8OrderLines.id, line.id),
        eq(pax8OrderLines.orderId, bundle.order.id),
        eq(pax8OrderLines.partnerId, bundle.order.partnerId),
        eq(pax8OrderLines.orgId, bundle.order.orgId),
        stateCondition,
      ))
      .returning({ id: pax8OrderLines.id });
    if (updated.length !== 1) {
      throw new Pax8OrderError('A Pax8 line execution state changed before its result could be recorded.', 409);
    }
    if (outcome.submitState === 'succeeded') await updateManualContractQuantity(line);
  }
}

async function reloadLines(bundle: SubmitBundle): Promise<Pax8OrderLineRow[]> {
  return db
    .select()
    .from(pax8OrderLines)
    .where(and(
      eq(pax8OrderLines.orderId, bundle.order.id),
      eq(pax8OrderLines.partnerId, bundle.order.partnerId),
      eq(pax8OrderLines.orgId, bundle.order.orgId),
    ));
}

export const pax8OrderSubmitRepository: Pax8OrderSubmitRepository = {
  loadResolvedOrder(input) {
    return withPartnerDbContext(input.partnerId, async () => {
      const existing = await findOrder(input.partnerId, input.orderId);
      assertSubmittable(existing);
      const companyId = await resolveCompany(existing);
      const order = await persistResolvedCompany(existing, companyId);
      return { order, lines: await findOrderLines(order) };
    });
  },

  async claimOrder(input) {
    // The parent is partner-axis, so discover its org in one bounded read.
    // Re-open the final CAS transaction with that single org authorized so
    // forced RLS permits the exact contract-line integrity join.
    const discovered = await withPartnerDbContext(input.partnerId, () =>
      findOrder(input.partnerId, input.orderId));
    return withOrderScopeDbContext(input.partnerId, discovered.orgId, async () => {
      const existing = await findOrder(input.partnerId, input.orderId);
      if (existing.orgId !== discovered.orgId) {
        throw new Pax8OrderError('The Pax8 order organization changed while claiming it.', 409);
      }
      assertSubmittable(existing);
      const companyId = await resolveCompany(existing);
      let lines = await findOrderLines(existing);
      if (lines.length === 0) throw new Pax8OrderError('Add at least one line before submitting the Pax8 order.', 422);
      for (const line of lines) {
        if (line.action === 'cancel') requireImmediateCancelDate(line.cancelDate);
      }
      lines = await validateDirectOrderLinesForSubmit(existing, lines);
      const now = new Date();
      const [claimed] = await db
        .update(pax8Orders)
        .set({
          pax8CompanyId: companyId,
          status: 'submitting',
          submittedBy: input.actorUserId,
          submittedAt: now,
          error: null,
          updatedAt: now,
        })
        .where(and(
          eq(pax8Orders.id, input.orderId),
          eq(pax8Orders.partnerId, input.partnerId),
          eq(pax8Orders.orgId, existing.orgId),
          eq(pax8Orders.integrationId, existing.integrationId),
          eq(pax8Orders.status, existing.status),
          sql`${pax8Orders}.xmin::text = ${existing.rowVersion}`,
          sql`NOT EXISTS (
            SELECT 1 FROM pax8_order_lines pol
            WHERE pol.order_id = ${pax8Orders.id}
              AND pol.partner_id = ${pax8Orders.partnerId}
              AND pol.org_id = ${pax8Orders.orgId}
              AND pol.submit_state <> 'pending'
          )`,
        ))
        .returning();
      if (!claimed) {
        throw new Pax8OrderError('Another submit won the order claim, or an earlier write requires reconciliation.', 409);
      }
      if (lines.some((line) => line.submitState !== 'pending')) {
        throw new Pax8OrderError('An earlier Pax8 line write requires reconciliation.', 409);
      }
      const targets = lines
        .filter((line) => line.action !== 'new_subscription')
        .map((line) => line.targetSubscriptionId);
      if (targets.some((target, index) => target !== null && targets.indexOf(target) !== index)) {
        throw new Pax8OrderError('Only one change or cancellation may target a Pax8 subscription per order.', 422);
      }
      return { order: claimed, lines };
    });
  },

  createClient(bundle) {
    return withPartnerDbContext(bundle.order.partnerId, async () => {
      const created = await createPax8ClientForIntegration(bundle.order.integrationId);
      if (created.integration.partnerId !== bundle.order.partnerId) {
        throw new Pax8OrderError('The Pax8 integration belongs to a different partner.', 403);
      }
      return created.client;
    });
  },

  claimLines(bundle) {
    return withPartnerDbContext(bundle.order.partnerId, async () => {
      await lockExecutingOrder(bundle);
      const claimed = await db
        .update(pax8OrderLines)
        .set({ submitState: 'in_flight', error: null, updatedAt: new Date() })
        .where(and(
          eq(pax8OrderLines.orderId, bundle.order.id),
          eq(pax8OrderLines.partnerId, bundle.order.partnerId),
          eq(pax8OrderLines.orgId, bundle.order.orgId),
          eq(pax8OrderLines.submitState, 'pending'),
        ))
        .returning({ id: pax8OrderLines.id });
      const expectedIds = new Set(bundle.lines.map((line) => line.id));
      if (claimed.length !== expectedIds.size || claimed.some((row) => !expectedIds.has(row.id))) {
        // Throwing rolls back the whole UPDATE. No Pax8 write is attempted after
        // an incomplete committed claim.
        throw new Pax8OrderError('The Pax8 order line claim was incomplete; no external write was attempted.', 409);
      }
    });
  },

  persistPreflightFailure(bundle, errorBody) {
    return withOrderDbContext(bundle, async () => {
      await lockExecutingOrder(bundle);
      const lineIds = bundle.lines.map((line) => line.id);
      const updatedLines = await db
          .update(pax8OrderLines)
          .set({ submitState: 'failed', error: errorBody, updatedAt: new Date() })
          .where(and(
            eq(pax8OrderLines.orderId, bundle.order.id),
            eq(pax8OrderLines.partnerId, bundle.order.partnerId),
            eq(pax8OrderLines.orgId, bundle.order.orgId),
            eq(pax8OrderLines.submitState, 'pending'),
            inArray(pax8OrderLines.id, lineIds),
          ))
          .returning({ id: pax8OrderLines.id });
      if (updatedLines.length !== lineIds.length) {
        throw new Pax8OrderError('The Pax8 preflight failure could not terminally classify every line.', 409);
      }
      await db
        .update(pax8Orders)
        .set({ status: 'failed', error: errorBody, updatedAt: new Date() })
        .where(and(
          eq(pax8Orders.id, bundle.order.id),
          eq(pax8Orders.partnerId, bundle.order.partnerId),
          eq(pax8Orders.orgId, bundle.order.orgId),
          eq(pax8Orders.status, 'submitting'),
        ));
      return resultFromRows(bundle.order.id, 'failed', await reloadLines(bundle));
    });
  },

  persistSubmitResults(bundle, outcomes, pax8OrderId) {
    return withOrderDbContext(bundle, async () => {
      await lockExecutingOrder(bundle);
      if (outcomes.length !== bundle.lines.length) {
        throw new Pax8OrderError('Pax8 did not produce one result for every claimed order line.', 409);
      }
      await persistLineOutcomes(bundle, outcomes, 'in_flight');
      const status = deriveOrderStatus(outcomes.map((outcome) => outcome.submitState));
      const errors = outcomes.flatMap((outcome) => outcome.error ? [outcome.error] : []);
      const updated = await db
        .update(pax8Orders)
        .set({
          status,
          pax8OrderId,
          error: errors.length > 0 ? errors.join('\n').slice(0, 4000) : null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(pax8Orders.id, bundle.order.id),
          eq(pax8Orders.partnerId, bundle.order.partnerId),
          eq(pax8Orders.orgId, bundle.order.orgId),
          eq(pax8Orders.status, 'submitting'),
        ))
        .returning({ id: pax8Orders.id });
      if (updated.length !== 1) throw new Pax8OrderError('The Pax8 order result could not be recorded.', 409);
      return resultFromRows(bundle.order.id, status, await reloadLines(bundle));
    });
  },

  loadReconcileOrder(input) {
    return withPartnerDbContext(input.partnerId, async () => {
      const order = await findOrder(input.partnerId, input.orderId);
      return { order, lines: await findOrderLines(order) };
    });
  },

  resetUnsentOrder(bundle) {
    return withOrderDbContext(bundle, async () => {
      await lockExecutingOrder(bundle);
      const currentLines = await reloadLines(bundle);
      if (currentLines.length !== bundle.lines.length
        || currentLines.length === 0
        || currentLines.some((line) => line.submitState !== 'pending')) {
        throw new Pax8OrderError('The Pax8 order is no longer provably unsent; reconcile its unknown writes.', 409);
      }
      const updated = await db
        .update(pax8Orders)
        .set({
          status: 'ready',
          submittedBy: null,
          submittedAt: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(pax8Orders.id, bundle.order.id),
          eq(pax8Orders.partnerId, bundle.order.partnerId),
          eq(pax8Orders.orgId, bundle.order.orgId),
          eq(pax8Orders.integrationId, bundle.order.integrationId),
          eq(pax8Orders.status, 'submitting'),
        ))
        .returning({ id: pax8Orders.id });
      if (updated.length !== 1) throw new Pax8OrderError('The unsent Pax8 order could not be recovered.', 409);
      return { resolved: 0, stillUnknown: 0 };
    });
  },

  persistReconcileResults(bundle, outcomes, pax8OrderId) {
    return withOrderDbContext(bundle, async () => {
      const [locked] = await db
        .select()
        .from(pax8Orders)
        .where(and(
          eq(pax8Orders.id, bundle.order.id),
          eq(pax8Orders.partnerId, bundle.order.partnerId),
          eq(pax8Orders.orgId, bundle.order.orgId),
          eq(pax8Orders.integrationId, bundle.order.integrationId),
          eq(pax8Orders.pax8CompanyId, bundle.order.pax8CompanyId!),
          eq(pax8Orders.submittedAt, bundle.order.submittedAt!),
        ))
        .for('update')
        .limit(1);
      if (!locked) throw new Pax8OrderError('Pax8 order not found.', 404);
      if (pax8OrderId && locked.pax8OrderId && locked.pax8OrderId !== pax8OrderId) {
        throw new Pax8OrderError('The reconciled Pax8 parent conflicts with the captured order id.', 409);
      }
      await persistLineOutcomes(bundle, outcomes, ['in_flight', 'needs_reconcile']);
      const lines = await reloadLines(bundle);
      const status = deriveOrderStatus(lines.map((line) => line.submitState as Pax8SubmitState));
      const errors = lines.flatMap((line) => line.error ? [line.error] : []);
      const updated = await db
        .update(pax8Orders)
        .set({
          status,
          ...(pax8OrderId ? { pax8OrderId } : {}),
          error: errors.length > 0 ? errors.join('\n').slice(0, 4000) : null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(pax8Orders.id, bundle.order.id),
          eq(pax8Orders.partnerId, bundle.order.partnerId),
          eq(pax8Orders.orgId, bundle.order.orgId),
          eq(pax8Orders.pax8CompanyId, bundle.order.pax8CompanyId!),
          eq(pax8Orders.submittedAt, bundle.order.submittedAt!),
          pax8OrderId ? or(
            isNull(pax8Orders.pax8OrderId),
            eq(pax8Orders.pax8OrderId, pax8OrderId),
          ) : undefined,
        ))
        .returning({ id: pax8Orders.id });
      if (updated.length !== 1) {
        throw new Pax8OrderError('The reconciled Pax8 parent conflicts with the captured order id.', 409);
      }
      return {
        resolved: outcomes.filter((outcome) => outcome.submitState !== 'needs_reconcile').length,
        stillUnknown: outcomes.filter((outcome) => outcome.submitState === 'needs_reconcile').length,
      };
    });
  },
};
