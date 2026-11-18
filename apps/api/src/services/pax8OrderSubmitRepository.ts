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
  pax8Integrations,
  pax8Orders,
} from '../db/schema';
import {
  Pax8OrderError,
  Pax8ClaimDriftError,
  Pax8OrderRestageRequiredError,
  requireImmediateCancelDate,
  validateDirectOrderLinesForSubmit,
  type Pax8OrderLineRow,
  type Pax8OrderRow,
} from './pax8OrderService';
import type {
  Pax8OrderSubmitRepository,
  LoadedBundle,
  ClaimedBundle,
  BillingConflict,
  SubmitLineOutcome,
  SubmitResult,
} from './pax8OrderSubmit';
import { createPax8ClientForIntegration, integrationGenerationPredicate, Pax8IntegrationGenerationChangedError } from './pax8SyncService';
import { pax8CompanyOrderReadiness } from './pax8CompanyReadiness';
import { SUBMITTABLE_STATUSES, isSubmittableStatus } from './pax8OrderTypes';
import { pax8CredentialGeneration } from './actionIntents/pax8OrderDigest';
import { errorIds, logError } from './pax8OrderObservability';
import { captureException } from './sentry';


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

function withOrderDbContext<T>(bundle: LoadedBundle, fn: () => Promise<T>): Promise<T> {
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

function assertSubmittable(order: Pax8OrderRow): asserts order is Pax8OrderRow & { status: typeof SUBMITTABLE_STATUSES[number] } {
  if (!isSubmittableStatus(order.status)) {
    throw new Pax8OrderError('This Pax8 order cannot be submitted in its current state.', 409, { phase: 'claim', code: 'NOT_PENDING' });
  }
}

function deriveOrderStatus(states: Pax8SubmitState[]): Pax8OrderStatus {
  if (states.length > 0 && states.every((state) => state === 'succeeded')) return 'completed';
  if (states.length > 0 && states.every((state) => state === 'failed')) return 'failed';
  return 'partially_failed';
}

function resultFromRows(orderId: string, status: Pax8OrderStatus, lines: Pax8OrderLineRow[], billingConflicts: BillingConflict[] = []): Extract<SubmitResult, { kind: 'executed' }> {
  return {
    kind: 'executed',
    orderId,
    status,
    billingConflicts,
    lines: lines.map((line) => ({
      lineId: line.id,
      submitState: line.submitState as Pax8SubmitState,
      error: line.error,
    })),
  };
}

async function lockExecutingOrder(bundle: LoadedBundle, phase: 'claim' | 'persist' = 'persist'): Promise<Pax8OrderRow> {
  if (!bundle.order.pax8CompanyId || !bundle.order.submittedAt) {
    throw new Pax8OrderError('The Pax8 order is missing its immutable submission snapshot.', 409, { phase, ...(phase === 'claim' ? { code: 'CLAIM_LOST' } : {}) });
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
  if (!order) throw new Pax8OrderError('The Pax8 order execution state changed.', 409, { phase, ...(phase === 'claim' ? { code: 'CLAIM_LOST' } : {}) });
  return order;
}

/** A CAS miss never overwrites a billing edit, even when the vendor succeeded. */
type BillingUpdateReason = 'ok' | 'baseline_changed' | 'line_missing' | 'not_manual' | 'no_quantity' | 'baseline_missing';
async function updateManualContractQuantity(line: Pax8OrderLineRow): Promise<BillingUpdateReason> {
  if (!line.contractLineId) return 'ok';
  const quantity = line.action === 'cancel' ? '0' : line.quantity;
  if (quantity === null) return 'no_quantity';
  const updated = await db.update(contractLines).set({ manualQuantity: quantity }).where(and(
    eq(contractLines.id, line.contractLineId), eq(contractLines.orgId, line.orgId),
    eq(contractLines.lineType, 'manual' as never),
    line.authorizedBaselineQuantity === null ? isNull(contractLines.manualQuantity)
      : eq(contractLines.manualQuantity, line.authorizedBaselineQuantity),
  )).returning({ id: contractLines.id });
  if (updated.length === 1) return 'ok';
  const [linked] = await db.select({ id: contractLines.id, lineType: contractLines.lineType, manualQuantity: contractLines.manualQuantity })
    .from(contractLines).where(and(eq(contractLines.id, line.contractLineId), eq(contractLines.orgId, line.orgId))).limit(1);
  if (!linked) return 'line_missing';
  if (linked.lineType !== 'manual') return 'not_manual';
  // NULL can mean a captured SQL NULL or an older in-flight line that never
  // captured a baseline. The migration filename cannot establish deployment
  // time. A failed NULL CAS therefore cannot authorize any overwrite.
  return line.authorizedBaselineQuantity === null && line.action !== 'change_quantity'
    ? 'baseline_missing' : 'baseline_changed';
}

const BILLING_CONFLICT_MESSAGES = {
  baseline_changed: 'The linked billing quantity changed after approval.',
  line_missing: 'The linked contract line no longer exists or is unavailable.',
  not_manual: 'The linked contract line is no longer a manual billing line.',
  no_quantity: 'The successful Pax8 line has no quantity to apply to billing.',
  baseline_missing: 'A trustworthy billing baseline is unavailable for this older or NULL-baseline line; compare billing with Pax8 manually.',
} as const;

async function persistLineOutcomes(
  bundle: LoadedBundle,
  outcomes: SubmitLineOutcome[],
  expectedState: 'in_flight' | readonly ['in_flight', 'needs_reconcile'],
): Promise<BillingConflict[]> {
  const billingConflicts: BillingConflict[] = [];
  const lineById = new Map(bundle.lines.map((line) => [line.id, line]));
  if (new Set(outcomes.map((outcome) => outcome.lineId)).size !== outcomes.length) {
    throw new Pax8OrderError('Duplicate Pax8 line outcomes were produced.', 409, { phase: 'persist' });
  }
  for (const outcome of outcomes) {
    const line = lineById.get(outcome.lineId);
    if (!line) throw new Pax8OrderError('A Pax8 line result does not belong to this order.', 409, { phase: 'persist' });
    const stateCondition = typeof expectedState === 'string'
      ? eq(pax8OrderLines.submitState, expectedState)
      : inArray(pax8OrderLines.submitState, [...expectedState]);
    if (outcome.submitState === 'succeeded') {
      const reason = await updateManualContractQuantity(line);
      if (reason !== 'ok') {
        outcome.error = `billing_conflict:${reason}: ${BILLING_CONFLICT_MESSAGES[reason]} The Pax8 write succeeded; review billing without resending it.`;
        billingConflicts.push({ lineId: line.id, reason });
        const context = { partnerId: bundle.order.partnerId, orderId: bundle.order.id, lineId: line.id, contractLineId: line.contractLineId, reason };
        logError(errorIds.PAX8_BILLING_CONFLICT, outcome.error, context);
        if (reason === 'line_missing' || reason === 'not_manual') captureException(new Error(outcome.error), undefined, { errorId: errorIds.PAX8_BILLING_INTEGRITY_DRIFT });
      }
    }
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
      throw new Pax8OrderError('A Pax8 line execution state changed before its result could be recorded.', 409, { phase: 'persist' });
    }
  }
  return billingConflicts;
}

async function reloadLines(bundle: LoadedBundle): Promise<Pax8OrderLineRow[]> {
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
    const outcome = await withOrderScopeDbContext(input.partnerId, discovered.orgId, async () => {
      const existing = await findOrder(input.partnerId, input.orderId);
      if (existing.orgId !== discovered.orgId) {
        throw new Pax8OrderError('The Pax8 order organization changed while claiming it.', 409);
      }
      assertSubmittable(existing);
      const companyId = await resolveCompany(existing);
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
        throw new Pax8OrderError('Another submit won the order claim, or an earlier write requires reconciliation.', 409, { phase: 'claim', code: 'CLAIM_LOST' });
      }
      // The parent transition owns the row lock that every authoring mutation
      // must acquire. Read only after that lock: if PATCH committed first we
      // see its values; if this claim won, PATCH wakes to a non-mutable parent.
      let lines = await findOrderLines(claimed);
      if (lines.length === 0) throw new Pax8OrderError('Add at least one line before submitting the Pax8 order.', 422);
      if (lines.some((line) => line.submitState !== 'pending')) {
        throw new Pax8OrderError('An earlier Pax8 line write requires reconciliation.', 409);
      }
      for (const line of lines) {
        if (line.action === 'cancel') requireImmediateCancelDate(line.cancelDate);
      }
      try {
        lines = await validateDirectOrderLinesForSubmit(claimed, lines);
      } catch (error) {
        if (!(error instanceof Pax8OrderRestageRequiredError) || claimed.source !== 'direct') throw error;
        const reset = await db
          .update(pax8Orders)
          .set({
            status: 'draft',
            submittedBy: null,
            submittedAt: null,
            error: error.message,
            updatedAt: new Date(),
          })
          .where(and(
            eq(pax8Orders.id, claimed.id),
            eq(pax8Orders.partnerId, claimed.partnerId),
            eq(pax8Orders.orgId, claimed.orgId),
            eq(pax8Orders.integrationId, claimed.integrationId),
            eq(pax8Orders.source, 'direct'),
            eq(pax8Orders.status, 'submitting'),
            eq(pax8Orders.submittedAt, claimed.submittedAt!),
            sql`NOT EXISTS (
              SELECT 1 FROM pax8_order_lines pol
              WHERE pol.order_id = ${pax8Orders.id}
                AND pol.partner_id = ${pax8Orders.partnerId}
                AND pol.org_id = ${pax8Orders.orgId}
                AND pol.submit_state <> 'pending'
            )`,
          ))
          .returning({ id: pax8Orders.id });
        if (reset.length !== 1) {
          throw new Pax8OrderError(
            'The Pax8 order could not be safely reopened for restaging; reconcile it before retrying.',
            409,
          );
        }
        return { restageError: error } as const;
      }
      const targets = lines
        .filter((line) => line.action !== 'new_subscription')
        .map((line) => line.targetSubscriptionId);
      if (targets.some((target, index) => target !== null && targets.indexOf(target) !== index)) {
        throw new Pax8OrderError('Only one change or cancellation may target a Pax8 subscription per order.', 422);
      }
      const [integrationGeneration] = await db.select().from(pax8Integrations)
        .where(and(eq(pax8Integrations.id, claimed.integrationId), eq(pax8Integrations.partnerId, claimed.partnerId)))
        .limit(1);
      if (!integrationGeneration || !integrationGeneration.isActive) {
        throw new Pax8OrderError('The Pax8 integration is unavailable.', 409, { phase: 'claim', code: 'INTEGRATION_UNAVAILABLE' });
      }
      // Keep the approved billing baseline durable across a timeout/crash for
      // every action, including cancels and quote-created subscriptions.
      for (const line of lines) {
        let baseline: string | null = null;
        if (line.contractLineId) {
          const [linked] = await db.select({ manualQuantity: contractLines.manualQuantity })
            .from(contractLines)
            .where(and(eq(contractLines.id, line.contractLineId), eq(contractLines.orgId, claimed.orgId)))
            .for('share').limit(1);
          if (!linked) throw new Pax8OrderError('The linked contract line is unavailable.', 409, { phase: 'claim', code: 'CONTRACT_LINE_MISSING' });
          baseline = linked.manualQuantity;
        }
        const captured = await db.update(pax8OrderLines)
          .set({ authorizedBaselineQuantity: baseline, updatedAt: new Date() })
          .where(and(eq(pax8OrderLines.id, line.id), eq(pax8OrderLines.orderId, claimed.id),
            eq(pax8OrderLines.partnerId, claimed.partnerId), eq(pax8OrderLines.orgId, claimed.orgId),
            eq(pax8OrderLines.submitState, 'pending')))
          .returning({ id: pax8OrderLines.id });
        if (captured.length !== 1) throw new Pax8OrderError('The Pax8 billing baseline could not be captured.', 409, { phase: 'claim', code: 'BASELINE_NOT_CAPTURED' });
        line.authorizedBaselineQuantity = baseline;
      }
      const bundle: ClaimedBundle = {
        order: claimed, lines,
        integrationGeneration: {
          id: integrationGeneration.id, partnerId: integrationGeneration.partnerId,
          apiBaseUrl: integrationGeneration.apiBaseUrl, tokenUrl: integrationGeneration.tokenUrl,
          isActive: integrationGeneration.isActive, credentialGeneration: pax8CredentialGeneration(integrationGeneration),
        },
        preClaimStatus: existing.status,
      };
      if (input.mode.kind === 'ai') {
        const verified = await input.mode.verifyClaim(bundle, { select: db.select.bind(db) });
        if (!verified.ok) throw new Pax8ClaimDriftError(verified.message);
      }
      return { bundle } as const;
    });
    if ('restageError' in outcome) throw outcome.restageError;
    return outcome.bundle;
  },

  createClient(bundle) {
    return withPartnerDbContext(bundle.order.partnerId, async () => {
      const expected = 'integrationGeneration' in bundle ? bundle.integrationGeneration : null;
      if (expected) {
        const [current] = await db.select().from(pax8Integrations)
          .where(and(eq(pax8Integrations.id, expected.id), eq(pax8Integrations.partnerId, expected.partnerId)))
          .for('share').limit(1);
        if (!current || current.apiBaseUrl !== expected.apiBaseUrl || current.tokenUrl !== expected.tokenUrl
          || current.isActive !== expected.isActive || pax8CredentialGeneration(current) !== expected.credentialGeneration) {
          throw new Pax8IntegrationGenerationChangedError('before order submission; nothing was sent');
        }
        // Preserve exact generation predicates while the current row is locked;
        // ciphertext is used only inside this context and never carried in a bundle.
        const [matched] = await db.select({ id: pax8Integrations.id }).from(pax8Integrations)
          .where(integrationGenerationPredicate(current)).for('share').limit(1);
        if (!matched) throw new Pax8IntegrationGenerationChangedError('before order submission; nothing was sent');
      }
      const created = await createPax8ClientForIntegration(bundle.order.integrationId);
      if (created.integration.partnerId !== bundle.order.partnerId) {
        throw new Pax8OrderError('The Pax8 integration belongs to a different partner.', 403);
      }
      if (expected && (created.integration.id !== expected.id || created.integration.partnerId !== expected.partnerId
        || created.integration.apiBaseUrl !== expected.apiBaseUrl || created.integration.tokenUrl !== expected.tokenUrl
        || created.integration.isActive !== expected.isActive || pax8CredentialGeneration(created.integration) !== expected.credentialGeneration)) {
        throw new Pax8IntegrationGenerationChangedError('before order submission; nothing was sent');
      }
      return created.client;
    });
  },

  claimLines(bundle) {
    return withPartnerDbContext(bundle.order.partnerId, async () => {
      await lockExecutingOrder(bundle, 'claim');
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
        throw new Pax8OrderError('The Pax8 order line claim was incomplete; no external write was attempted.', 409, { phase: 'claim', code: 'CLAIM_LOST' });
      }
    });
  },

  async reopenUnsentOrder(bundle, error, refusalCode) {
    try {
      return await withOrderDbContext(bundle, async () => {
        await lockExecutingOrder(bundle, 'claim');
        const lines = await reloadLines(bundle);
        if (lines.length === 0 || lines.length !== bundle.lines.length
          || lines.some((line) => line.submitState !== 'pending')) {
          throw new Pax8OrderError('The Pax8 order no longer matches this unsent claim.', 409);
        }
        const updated = await db.update(pax8Orders).set({
          status: bundle.preClaimStatus, submittedBy: null, submittedAt: null,
          error: error.slice(0, 2048), updatedAt: new Date(),
        }).where(and(
          eq(pax8Orders.id, bundle.order.id), eq(pax8Orders.partnerId, bundle.order.partnerId),
          eq(pax8Orders.orgId, bundle.order.orgId), eq(pax8Orders.integrationId, bundle.order.integrationId),
          eq(pax8Orders.status, 'submitting'), eq(pax8Orders.submittedAt, bundle.order.submittedAt!),
          sql`NOT EXISTS (SELECT 1 FROM pax8_order_lines pol
            WHERE pol.order_id = ${pax8Orders.id} AND pol.partner_id = ${pax8Orders.partnerId}
              AND pol.org_id = ${pax8Orders.orgId} AND pol.submit_state <> 'pending')`,
        )).returning({ id: pax8Orders.id });
        if (updated.length !== 1) throw new Pax8OrderError('The unsent Pax8 order could not be reopened.', 409);
        return { ...resultFromRows(bundle.order.id, bundle.preClaimStatus, lines), kind: 'refused' as const, refusalCode, error };
      });
    } catch (reopenError) {
      const cause = new Pax8OrderError(error, 409, { phase: 'claim', code: refusalCode });
      const wrapped = new Pax8OrderError(reopenError instanceof Error ? reopenError.message : String(reopenError), 409,
        { phase: 'claim', code: 'CLAIM_LOST', cause });
      logError(errorIds.PAX8_REOPEN_FAILED, 'Could not reopen a provably unsent Pax8 order', {
        partnerId: bundle.order.partnerId, orderId: bundle.order.id, lineIds: bundle.lines.map(line => line.id), refusalCode, originalError: error, reopenError,
      });
      throw wrapped;
    }
  },

  persistPreflightFailure(bundle, errorBody) {
    return withOrderDbContext(bundle, async () => {
      await lockExecutingOrder(bundle, 'claim');
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
        throw new Pax8OrderError('Pax8 did not produce one result for every claimed order line.', 409, { phase: 'persist' });
      }
      const billingConflicts = await persistLineOutcomes(bundle, outcomes, 'in_flight');
      const status = billingConflicts.length > 0 ? 'partially_failed' : deriveOrderStatus(outcomes.map((outcome) => outcome.submitState));
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
      if (updated.length !== 1) throw new Pax8OrderError('The Pax8 order result could not be recorded.', 409, { phase: 'persist' });
      return resultFromRows(bundle.order.id, status, await reloadLines(bundle), billingConflicts);
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
        throw new Pax8OrderError('The Pax8 order is no longer provably unsent; reconcile its unknown writes.', 409, { phase: 'persist' });
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
      if (updated.length !== 1) throw new Pax8OrderError('The unsent Pax8 order could not be recovered.', 409, { phase: 'persist' });
      return { ...resultFromRows(bundle.order.id, 'ready', currentLines), resolved: 0, stillUnknown: 0 };
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
      if (!locked) throw new Pax8OrderError('Pax8 order not found.', 404, { phase: 'persist' });
      if (pax8OrderId && locked.pax8OrderId && locked.pax8OrderId !== pax8OrderId) {
        throw new Pax8OrderError('The reconciled Pax8 parent conflicts with the captured order id.', 409, { phase: 'persist' });
      }
      const freshConflicts = await persistLineOutcomes(bundle, outcomes, ['in_flight', 'needs_reconcile']);
      const lines = await reloadLines(bundle);
      const conflictsByLine = new Map(freshConflicts.map(conflict => [conflict.lineId, conflict]));
      for (const line of lines) {
        const reason = /^billing_conflict:([^:]+):/.exec(line.error ?? '')?.[1];
        if (reason) conflictsByLine.set(line.id, { lineId: line.id, reason });
      }
      const billingConflicts = [...conflictsByLine.values()];
      const status = billingConflicts.length > 0 ? 'partially_failed' : deriveOrderStatus(lines.map((line) => line.submitState as Pax8SubmitState));
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
        throw new Pax8OrderError('The reconciled Pax8 parent conflicts with the captured order id.', 409, { phase: 'persist' });
      }
      return {
        ...resultFromRows(bundle.order.id, status, lines, billingConflicts),
        resolved: outcomes.filter((outcome) => outcome.submitState !== 'needs_reconcile').length,
        stillUnknown: outcomes.filter((outcome) => outcome.submitState === 'needs_reconcile').length,
      };
    });
  },
};
