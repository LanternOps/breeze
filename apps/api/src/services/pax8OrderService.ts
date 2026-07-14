import { randomUUID } from 'node:crypto';
import { PAX8_BILLING_TERMS, type Pax8BillingTerm, type Pax8OrderAction } from '@breeze/shared';
import { and, asc, desc, eq, inArray, max, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  type DbAccessContext,
} from '../db';
import {
  pax8CompanyMappings,
  pax8Integrations,
  pax8OrderLines,
  pax8Orders,
  pax8ProductMappings,
  pax8ContractLineLinks,
  pax8SubscriptionSnapshots,
  catalogItems,
  contractLines,
} from '../db/schema';
import { createPax8ClientForIntegration } from './pax8SyncService';
import { pax8CompanyOrderReadiness } from './pax8CompanyReadiness';
import type { Pax8Commitment } from './pax8Client';

export class Pax8OrderError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = 'Pax8OrderError';
  }
}

export class Pax8OrderRestageRequiredError extends Pax8OrderError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'Pax8OrderRestageRequiredError';
  }
}

export type Pax8OrderRow = typeof pax8Orders.$inferSelect;
export type Pax8OrderLineRow = typeof pax8OrderLines.$inferSelect;

export interface AddOrderLineInput {
  partnerId: string;
  orderId: string;
  action: Pax8OrderAction;
  pax8ProductId?: string;
  catalogItemId?: string;
  billingTerm?: Pax8BillingTerm;
  commitmentTermId?: string;
  quantity?: string;
  provisioningDetails?: Array<{ key: string; values: string[] }>;
  targetSubscriptionId?: string;
  cancelDate?: string;
  contractLineId?: string;
  sourceQuoteLineId?: string;
}

/** Stable per-order. The unique index on (partner_id, dedupe_key) is what makes
 * a concurrent submit lose the race — see pax8OrderSubmit.claimLine. */
export function buildDedupeKey(orderId: string): string {
  return `order:${orderId}`;
}

const MUTABLE_STATUSES = new Set(['draft', 'awaiting_details']);
const BILLING_TERMS = new Set<string>(PAX8_BILLING_TERMS);
const MUTABLE_DIRECT_ORDER_UNIQUE_INDEX = 'pax8_orders_one_mutable_direct_per_org_uq';

function partnerDbContext(partnerId: string, orgId?: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: orgId ?? null,
    accessibleOrgIds: orgId ? [orgId] : null,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * Pax8 line authoring is a self-managed route with no ambient request
 * transaction. Exit defensively before opening each short partner context so
 * an accidental ambient caller still cannot make these phases reuse its tx.
 */
function withPartnerDbContext<T>(partnerId: string, fn: () => Promise<T>, orgId?: string): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(partnerDbContext(partnerId, orgId), fn));
}

function requireMutableOrder(order: Pax8OrderRow): void {
  if (!MUTABLE_STATUSES.has(order.status)) {
    throw new Pax8OrderError('Only draft or awaiting-details Pax8 orders can be modified.', 409);
  }
}

function requirePubliclyMutableOrder(order: Pax8OrderRow): void {
  requireMutableOrder(order);
  if (order.source === 'quote') {
    throw new Pax8OrderError(
      'quote-staged Pax8 order lines are immutable; only provisioning details may be updated.',
      409,
    );
  }
}

function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function requireImmediateCancelDate(cancelDate: string | null | undefined, now = new Date()): void {
  if (!cancelDate) return;
  const parsed = new Date(`${cancelDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cancelDate)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== cancelDate) {
    throw new Pax8OrderError('Cancellation date must be a valid UTC calendar date.', 422);
  }
  if (cancelDate > utcDateString(now)) {
    throw new Pax8OrderError('future-dated Pax8 cancellations are not supported.', 422);
  }
}

async function loadOrder(partnerId: string, orderId: string): Promise<Pax8OrderRow> {
  const [order] = await db
    .select()
    .from(pax8Orders)
    .where(and(eq(pax8Orders.partnerId, partnerId), eq(pax8Orders.id, orderId)))
    .limit(1);
  if (!order) throw new Pax8OrderError('Pax8 order not found.', 404);
  return order;
}

async function findMutableDirectOrder(partnerId: string, orgId: string): Promise<Pax8OrderRow | undefined> {
  const [order] = await db
    .select()
    .from(pax8Orders)
    .where(and(
      eq(pax8Orders.partnerId, partnerId),
      eq(pax8Orders.orgId, orgId),
      eq(pax8Orders.source, 'direct'),
      inArray(pax8Orders.status, [...MUTABLE_STATUSES]),
    ))
    .limit(1);
  return order;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let candidate: unknown = error;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (typeof candidate !== 'object') break;
    const details = candidate as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (details.code === '23505'
      && (details.constraint_name === constraint || typeof details.constraint_name !== 'string')) {
      return true;
    }
    if (typeof details.message === 'string' && details.message.includes(constraint)) return true;
    candidate = details.cause;
  }
  return false;
}

function numericQuantity(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNumericQuantity(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

type JsonRecord = Record<string, unknown>;

const COMMITMENT_ID_KEYS = [
  'commitmentTermId',
  'commitmentTermID',
  'commitment_term_id',
  'commitmentId',
  'commitmentID',
  'commitment_id',
] as const;

const COMMITMENT_CONTAINERS = [
  'commitment',
  'commitmentTerm',
  'commitment_term',
  'commitmentDetails',
  'commitmentDependency',
] as const;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function collectCommitmentIds(
  record: JsonRecord,
  ids: Set<string>,
  options: { allowGenericId: boolean; allowEnvelopes: boolean },
  seen = new Set<JsonRecord>(),
): void {
  if (seen.has(record)) return;
  seen.add(record);

  for (const key of COMMITMENT_ID_KEYS) {
    const id = nonEmptyString(record[key]);
    if (id) ids.add(id);
  }
  if (options.allowGenericId) {
    const id = nonEmptyString(record.id);
    if (id) ids.add(id);
  }

  for (const key of COMMITMENT_CONTAINERS) {
    const nested = asRecord(record[key]);
    if (!nested) continue;
    collectCommitmentIds(nested, ids, { allowGenericId: true, allowEnvelopes: false }, seen);
  }

  // Some Pax8 payloads wrap the subscription details one level below the
  // response item. Restrict recursion to named envelopes so product/company
  // IDs can never be mistaken for a commitment ID.
  if (options.allowEnvelopes) {
    for (const key of ['subscription', 'details'] as const) {
      const nested = asRecord(record[key]);
      if (!nested) continue;
      collectCommitmentIds(nested, ids, { allowGenericId: false, allowEnvelopes: false }, seen);
    }
  }
}

function activeCommitmentIds(raw: unknown): string[] {
  const record = asRecord(raw);
  if (!record) return [];
  const ids = new Set<string>();
  collectCommitmentIds(record, ids, { allowGenericId: false, allowEnvelopes: true });
  return [...ids];
}

export function snapshotActiveCommitmentEvidence(raw: unknown): {
  activeCommitmentId: string | null;
  activeCommitmentAmbiguous: boolean;
} {
  const ids = activeCommitmentIds(raw);
  return {
    activeCommitmentId: ids.length === 1 ? ids[0]! : null,
    activeCommitmentAmbiguous: ids.length > 1,
  };
}

function activeCommitment(raw: unknown, commitments: Pax8Commitment[]): Pax8Commitment {
  const evidence = snapshotActiveCommitmentEvidence(raw);
  if (evidence.activeCommitmentAmbiguous) {
    throw new Pax8OrderError(
      'The Pax8 subscription snapshot contains ambiguous active commitment identifiers.',
      422,
    );
  }
  const activeId = evidence.activeCommitmentId;
  if (activeId) {
    const matches = commitments.filter((commitment) => commitment.id === activeId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Pax8OrderError(
        `Pax8 returned ambiguous dependency entries for the active commitment (${activeId}).`,
        422,
      );
    }
    throw new Pax8OrderError(
      `The active Pax8 commitment (${activeId}) was not present in the product dependencies. Refresh Pax8 data before ordering.`,
      422,
    );
  }
  if (commitments.length === 1) return commitments[0]!;
  if (commitments.length === 0) {
    throw new Pax8OrderError('Pax8 returned no commitment details for the target subscription.', 422);
  }
  throw new Pax8OrderError(
    'Unable to determine the active commitment from the Pax8 subscription snapshot.',
    422,
  );
}

function validateActionPayload(input: AddOrderLineInput): void {
  if (input.billingTerm !== undefined && !BILLING_TERMS.has(input.billingTerm)) {
    throw new Pax8OrderError(
      `Invalid Pax8 billing term. Expected one of: ${PAX8_BILLING_TERMS.join(', ')}.`,
      422,
    );
  }

  switch (input.action) {
    case 'new_subscription': {
      if (!input.pax8ProductId) {
        throw new Pax8OrderError('A Pax8 product is required for a new subscription.', 422);
      }
      if (!input.billingTerm) {
        throw new Pax8OrderError('A valid Pax8 billing term is required for a new subscription.', 422);
      }
      const quantity = numericQuantity(input.quantity);
      if (quantity === null || quantity <= 0) {
        throw new Pax8OrderError('New subscription quantity must be greater than zero.', 422);
      }
      if (input.targetSubscriptionId) {
        throw new Pax8OrderError('A new subscription must not target an existing subscription.', 422);
      }
      if (input.contractLineId) {
        throw new Pax8OrderError('A direct new subscription cannot supply a contract line.', 422);
      }
      return;
    }
    case 'change_quantity': {
      if (!input.targetSubscriptionId) {
        throw new Pax8OrderError('A target subscription is required to change quantity.', 422);
      }
      const quantity = numericQuantity(input.quantity);
      if (quantity === null || quantity < 0) {
        throw new Pax8OrderError('Changed subscription quantity must be zero or greater.', 422);
      }
      return;
    }
    case 'cancel':
      if (!input.targetSubscriptionId) {
        throw new Pax8OrderError('A target subscription is required to cancel.', 422);
      }
      if (input.quantity !== undefined) {
        throw new Pax8OrderError('A cancellation must not include a quantity.', 422);
      }
      requireImmediateCancelDate(input.cancelDate);
      return;
    default:
      throw new Pax8OrderError('Unsupported Pax8 order action.', 422);
  }
}

type IntegrityReader = Pick<typeof db, 'select'>;

interface DirectProductMapping {
  pax8ProductId: string;
  catalogItemId: string;
}

async function currentDirectProductMapping(
  reader: IntegrityReader,
  order: Pax8OrderRow,
  input: { pax8ProductId: string; catalogItemId: string },
  lock: boolean,
): Promise<DirectProductMapping> {
  const query = reader
    .select({
      pax8ProductId: pax8ProductMappings.pax8ProductId,
      catalogItemId: pax8ProductMappings.catalogItemId,
    })
    .from(pax8ProductMappings)
    .innerJoin(pax8Integrations, and(
      eq(pax8ProductMappings.integrationId, pax8Integrations.id),
      eq(pax8ProductMappings.partnerId, pax8Integrations.partnerId),
    ))
    .innerJoin(catalogItems, and(
      eq(pax8ProductMappings.catalogItemId, catalogItems.id),
      eq(pax8ProductMappings.partnerId, catalogItems.partnerId),
    ))
    .where(and(
      eq(pax8ProductMappings.integrationId, order.integrationId),
      eq(pax8ProductMappings.partnerId, order.partnerId),
      eq(pax8ProductMappings.pax8ProductId, input.pax8ProductId),
      eq(pax8ProductMappings.catalogItemId, input.catalogItemId),
      eq(pax8Integrations.isActive, true),
      eq(catalogItems.isActive, true),
    ));
  const rows = lock ? await query.for('share') : await query;
  if (rows.length !== 1 || !rows[0]!.catalogItemId) {
    throw new Pax8OrderError(
      'Select an active Pax8 product that is mapped to the supplied active catalog item.',
      422,
    );
  }
  return rows[0] as DirectProductMapping;
}

interface LinkedManualContractLine {
  contractLineId: string;
  manualQuantity: string;
}

async function currentLinkedManualContractLine(
  reader: IntegrityReader,
  order: Pax8OrderRow,
  targetSubscriptionId: string,
  lock: boolean,
): Promise<LinkedManualContractLine> {
  const query = reader
    .select({
      contractLineId: pax8ContractLineLinks.contractLineId,
      manualQuantity: contractLines.manualQuantity,
    })
    .from(pax8ContractLineLinks)
    .innerJoin(pax8SubscriptionSnapshots, and(
      eq(pax8ContractLineLinks.subscriptionSnapshotId, pax8SubscriptionSnapshots.id),
      eq(pax8ContractLineLinks.integrationId, pax8SubscriptionSnapshots.integrationId),
      eq(pax8ContractLineLinks.partnerId, pax8SubscriptionSnapshots.partnerId),
      eq(pax8ContractLineLinks.orgId, pax8SubscriptionSnapshots.orgId),
    ))
    .innerJoin(contractLines, and(
      eq(pax8ContractLineLinks.contractLineId, contractLines.id),
      eq(pax8ContractLineLinks.orgId, contractLines.orgId),
    ))
    .where(and(
      eq(pax8ContractLineLinks.integrationId, order.integrationId),
      eq(pax8ContractLineLinks.partnerId, order.partnerId),
      eq(pax8ContractLineLinks.orgId, order.orgId),
      eq(pax8SubscriptionSnapshots.pax8SubscriptionId, targetSubscriptionId),
      eq(contractLines.lineType, 'manual' as never),
    ));
  const rows = lock ? await query.for('share') : await query;
  if (rows.length !== 1 || rows[0]!.manualQuantity === null) {
    throw new Pax8OrderError(
      'The target Pax8 subscription must have exactly one linked Breeze manual contract quantity.',
      422,
    );
  }
  return rows[0] as LinkedManualContractLine;
}

export async function validateDirectOrderLinesForSubmit(
  order: Pax8OrderRow,
  lines: Pax8OrderLineRow[],
): Promise<Pax8OrderLineRow[]> {
  const validated: Pax8OrderLineRow[] = [];
  for (const line of lines) {
    if (line.action === 'new_subscription') {
      if (order.source === 'quote') {
        validated.push(line);
        continue;
      }
      if (!line.pax8ProductId || !line.catalogItemId) {
        throw new Pax8OrderError('A direct subscription requires a mapped catalog item.', 422);
      }
      await currentDirectProductMapping(db, order, {
        pax8ProductId: line.pax8ProductId,
        catalogItemId: line.catalogItemId,
      }, true);
      if (line.contractLineId) {
        throw new Pax8OrderError('A direct new subscription cannot carry a contract line.', 422);
      }
      validated.push(line);
      continue;
    }
    if (!line.targetSubscriptionId) {
      throw new Pax8OrderError('A subscription action has no target subscription.', 422);
    }
    requireImmediateCancelDate(line.action === 'cancel' ? line.cancelDate : null);
    const linked = await currentLinkedManualContractLine(db, order, line.targetSubscriptionId, true);
    if (line.contractLineId !== linked.contractLineId) {
      throw new Pax8OrderError('The staged contract line no longer matches the target Pax8 subscription.', 409);
    }
    if (line.action === 'change_quantity') {
      if (line.authorizedBaselineQuantity === null) {
        throw new Pax8OrderRestageRequiredError(
          'This legacy quantity change has no authorization baseline; remove and stage it again.',
        );
      }
      if (!sameNumericQuantity(line.authorizedBaselineQuantity, linked.manualQuantity)) {
        throw new Pax8OrderRestageRequiredError(
          'The linked Breeze contract quantity changed since this Pax8 action was authorized; remove and stage it again.',
        );
      }
    }
    validated.push({ ...line, contractLineId: linked.contractLineId });
  }
  return validated;
}

function requireCompanyOrderReady(mapping: {
  status?: string | null;
  metadata?: unknown;
}): void {
  if (!pax8CompanyOrderReadiness(mapping.status, mapping.metadata).orderReady) {
    throw new Pax8OrderError(
      'The mapped Pax8 company is not ready for ordering. It must be Active with primary Admin, Billing, and Technical contacts.',
      422,
    );
  }
}

type CompanyMappingReader = Pick<typeof db, 'select'>;

async function currentCompanyMappings(
  reader: CompanyMappingReader,
  scope: { integrationId: string; partnerId: string; orgId: string },
  lock: boolean,
) {
  const query = reader
    .select({
      integrationId: pax8CompanyMappings.integrationId,
      pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
      status: pax8CompanyMappings.status,
      metadata: pax8CompanyMappings.metadata,
    })
    .from(pax8CompanyMappings)
    .where(and(
      eq(pax8CompanyMappings.integrationId, scope.integrationId),
      eq(pax8CompanyMappings.partnerId, scope.partnerId),
      eq(pax8CompanyMappings.orgId, scope.orgId),
      eq(pax8CompanyMappings.ignored, false),
    ));
  return lock ? query.for('share') : query;
}

async function requireCurrentCompanyOrderReady(
  order: Pax8OrderRow,
  options: { reader?: CompanyMappingReader; lock?: boolean } = {},
): Promise<void> {
  const mappings = await currentCompanyMappings(options.reader ?? db, order, options.lock ?? false);
  if (mappings.length !== 1) {
    throw new Pax8OrderError('Resolve the Pax8 company mapping before staging this order.', 422);
  }
  requireCompanyOrderReady(mappings[0]!);
}

export async function getOrCreateDraftOrder(input: {
  partnerId: string;
  orgId: string;
  actorUserId: string;
}): Promise<Pax8OrderRow> {
  const [mapping] = await db
    .select()
    .from(pax8CompanyMappings)
    .where(and(
      eq(pax8CompanyMappings.partnerId, input.partnerId),
      eq(pax8CompanyMappings.orgId, input.orgId),
      eq(pax8CompanyMappings.ignored, false),
    ))
    .limit(1);

  if (!mapping?.orgId) {
    throw new Pax8OrderError(
      'This organization is not mapped to a Pax8 company. Map it before ordering.',
      409,
    );
  }
  requireCompanyOrderReady(mapping);

  const existing = await findMutableDirectOrder(input.partnerId, input.orgId);
  if (existing) return existing;

  const id = randomUUID();
  try {
    // A nested transaction gives an ambient request transaction a SAVEPOINT.
    // Without it, a handled 23505 would leave the request transaction aborted
    // and the winner re-read below would fail with 25P02.
    const [created] = await db.transaction(async (tx) => {
      const finalMappings = await currentCompanyMappings(tx, {
        integrationId: mapping.integrationId,
        partnerId: input.partnerId,
        orgId: input.orgId,
      }, true);
      if (finalMappings.length !== 1) {
        throw new Pax8OrderError('Resolve the Pax8 company mapping before creating this order.', 422);
      }
      const finalMapping = finalMappings[0]!;
      requireCompanyOrderReady(finalMapping);
      return tx.insert(pax8Orders).values({
        id,
        integrationId: finalMapping.integrationId,
        partnerId: input.partnerId,
        orgId: input.orgId,
        pax8CompanyId: finalMapping.pax8CompanyId,
        status: 'draft',
        source: 'direct',
        dedupeKey: buildDedupeKey(id),
        createdBy: input.actorUserId,
      }).returning();
    });
    if (!created) throw new Pax8OrderError('The Pax8 draft order could not be created.', 409);
    return created;
  } catch (error) {
    if (!isUniqueViolation(error, MUTABLE_DIRECT_ORDER_UNIQUE_INDEX)) throw error;
    const winner = await findMutableDirectOrder(input.partnerId, input.orgId);
    if (winner) return winner;
    throw error;
  }
}

export async function addOrderLine(input: AddOrderLineInput): Promise<Pax8OrderLineRow> {
  const order = await withPartnerDbContext(input.partnerId, () =>
    loadOrder(input.partnerId, input.orderId));
  requirePubliclyMutableOrder(order);
  if (order.source === 'direct') {
    await withPartnerDbContext(input.partnerId, () => requireCurrentCompanyOrderReady(order));
  }
  validateActionPayload(input);

  let derivedContractLine: LinkedManualContractLine | null = null;
  let authoringBaseline: string | null = null;
  if (input.action === 'new_subscription') {
    if (!input.catalogItemId) {
      throw new Pax8OrderError('A mapped catalog item is required for a direct subscription.', 422);
    }
    await withPartnerDbContext(input.partnerId, () => currentDirectProductMapping(db, order, {
      pax8ProductId: input.pax8ProductId!,
      catalogItemId: input.catalogItemId!,
    }, false));
  } else {
    const [snapshot] = await withPartnerDbContext(input.partnerId, () => db
        .select()
        .from(pax8SubscriptionSnapshots)
        .where(and(
          eq(pax8SubscriptionSnapshots.integrationId, order.integrationId),
          eq(pax8SubscriptionSnapshots.partnerId, input.partnerId),
          eq(pax8SubscriptionSnapshots.pax8SubscriptionId, input.targetSubscriptionId!),
        ))
        .limit(1));
    if (!snapshot) throw new Pax8OrderError('Pax8 subscription not found.', 404);
    if (snapshot.orgId !== order.orgId) {
      throw new Pax8OrderError('The target subscription belongs to a different organization.', 403);
    }
    if (!snapshot.productId) {
      throw new Pax8OrderError('The target subscription has no Pax8 product identifier.', 422);
    }
    derivedContractLine = await withPartnerDbContext(input.partnerId, () =>
      currentLinkedManualContractLine(db, order, input.targetSubscriptionId!, false), order.orgId);
    authoringBaseline = derivedContractLine.manualQuantity;
    if (input.contractLineId && input.contractLineId !== derivedContractLine.contractLineId) {
      throw new Pax8OrderError('The supplied contract line does not match the target Pax8 subscription.', 422);
    }

    const { client } = await withPartnerDbContext(input.partnerId, () =>
      createPax8ClientForIntegration(order.integrationId));
    const dependencies = await runOutsideDbContext(() =>
      client.getProductDependencies(snapshot.productId!),
    );

    if (input.action === 'change_quantity') {
      const currentQuantity = Number(authoringBaseline);
      const requestedQuantity = Number(input.quantity);
      if (requestedQuantity < currentQuantity) {
        if (!activeCommitment(snapshot.raw, dependencies.commitments).allowForQuantityDecrease) {
          throw new Pax8OrderError('This product commitment does not allow a quantity decrease.', 422);
        }
      }
      if (requestedQuantity > currentQuantity) {
        if (!activeCommitment(snapshot.raw, dependencies.commitments).allowForQuantityIncrease) {
          throw new Pax8OrderError('This product commitment does not allow a quantity increase.', 422);
        }
      }
    } else if (!activeCommitment(snapshot.raw, dependencies.commitments).allowForEarlyCancellation) {
        throw new Pax8OrderError('This product commitment does not allow early cancellation.', 422);
    }
  }

  const [created] = await withPartnerDbContext(input.partnerId, async () => {
    // The context is a transaction. Lock and re-check immediately before the
    // insert so a submit transition cannot race the earlier validation/HTTP.
    const [lockedOrder] = await db
      .select()
      .from(pax8Orders)
      .where(and(eq(pax8Orders.partnerId, input.partnerId), eq(pax8Orders.id, input.orderId)))
      .for('update')
      .limit(1);
    if (!lockedOrder) throw new Pax8OrderError('Pax8 order not found.', 404);
    requirePubliclyMutableOrder(lockedOrder);
    if (lockedOrder.source === 'direct') {
      await requireCurrentCompanyOrderReady(lockedOrder, { lock: true });
    }

    let finalContractLineId: string | undefined;
    if (input.action === 'new_subscription') {
      await currentDirectProductMapping(db, lockedOrder, {
        pax8ProductId: input.pax8ProductId!,
        catalogItemId: input.catalogItemId!,
      }, true);
    } else {
      const linked = await currentLinkedManualContractLine(
        db,
        lockedOrder,
        input.targetSubscriptionId!,
        true,
      );
      if (linked.contractLineId !== derivedContractLine?.contractLineId) {
        throw new Pax8OrderError(
          'The Pax8 subscription contract linkage changed while validating this action; stage it again.',
          409,
        );
      }
      finalContractLineId = linked.contractLineId;
      if (input.action === 'change_quantity') {
        const initialBaseline = Number(authoringBaseline);
        const finalBaseline = Number(linked.manualQuantity);
        if (!Number.isFinite(initialBaseline) || !Number.isFinite(finalBaseline)) {
          throw new Pax8OrderError('The linked Breeze manual contract quantity is invalid.', 422);
        }
        // The vendor dependency decision was made against this exact Breeze
        // baseline. Any concurrent billing edit invalidates that authorization,
        // even if it happens to preserve direction today.
        if (initialBaseline !== finalBaseline) {
          throw new Pax8OrderError(
            'The Breeze contract quantity changed while validating this action; stage it again.',
            409,
          );
        }
      }
    }

    const [position] = await db
      .select({ maxSortOrder: max(pax8OrderLines.sortOrder) })
      .from(pax8OrderLines)
      .where(and(
        eq(pax8OrderLines.partnerId, lockedOrder.partnerId),
        eq(pax8OrderLines.orgId, lockedOrder.orgId),
        eq(pax8OrderLines.orderId, lockedOrder.id),
      ));
    const sortOrder = Number(position?.maxSortOrder ?? -1) + 1;
    if (!Number.isSafeInteger(sortOrder) || sortOrder > 100_000) {
      throw new Pax8OrderError('The Pax8 order has too many lines.', 422);
    }

    return db
      .insert(pax8OrderLines)
      .values({
        orderId: lockedOrder.id,
        partnerId: lockedOrder.partnerId,
        orgId: lockedOrder.orgId,
        action: input.action,
        submitState: 'pending',
        pax8ProductId: input.pax8ProductId,
        catalogItemId: input.catalogItemId,
        billingTerm: input.billingTerm,
        commitmentTermId: input.commitmentTermId,
        quantity: input.quantity,
        authorizedBaselineQuantity: input.action === 'change_quantity' ? authoringBaseline : undefined,
        provisioningDetails: input.provisioningDetails ?? [],
        targetSubscriptionId: input.targetSubscriptionId,
        cancelDate: input.cancelDate,
        contractLineId: finalContractLineId,
        sourceQuoteLineId: input.sourceQuoteLineId,
        sortOrder,
      })
      .returning();
  }, order.orgId);
  if (!created) throw new Pax8OrderError('The Pax8 order line could not be created.', 409);
  return created;
}

export async function removeOrderLine(input: {
  partnerId: string;
  orderId: string;
  lineId: string;
}): Promise<{ removed: boolean }> {
  return withPartnerDbContext(input.partnerId, async () => {
    const [order] = await db
      .select()
      .from(pax8Orders)
      .where(and(eq(pax8Orders.partnerId, input.partnerId), eq(pax8Orders.id, input.orderId)))
      .for('update')
      .limit(1);
    if (!order) throw new Pax8OrderError('Pax8 order not found.', 404);
    requirePubliclyMutableOrder(order);

    const removed = await db
      .delete(pax8OrderLines)
      .where(and(
        eq(pax8OrderLines.partnerId, input.partnerId),
        eq(pax8OrderLines.orderId, input.orderId),
        eq(pax8OrderLines.id, input.lineId),
      ))
      .returning({ id: pax8OrderLines.id });
    return { removed: removed.length > 0 };
  });
}

export interface UpdateOrderLineInput {
  partnerId: string;
  orderId: string;
  lineId: string;
  commitmentTermId?: string | null;
  provisioningDetails?: Array<{ key: string; values: string[] }>;
}

/**
 * Completes quote-staged provisioning details without replacing the immutable
 * source/contract linkage. Parent and child are locked in one short partner
 * transaction so submit cannot transition the order between validation and
 * persistence.
 */
export async function updateOrderLine(input: UpdateOrderLineInput): Promise<Pax8OrderLineRow> {
  if (input.commitmentTermId === undefined && input.provisioningDetails === undefined) {
    throw new Pax8OrderError('No editable Pax8 order line fields were provided.', 422);
  }

  return withPartnerDbContext(input.partnerId, async () => {
    const [order] = await db
      .select()
      .from(pax8Orders)
      .where(and(eq(pax8Orders.partnerId, input.partnerId), eq(pax8Orders.id, input.orderId)))
      .for('update')
      .limit(1);
    if (!order) throw new Pax8OrderError('Pax8 order not found.', 404);
    requireMutableOrder(order);

    const [line] = await db
      .select()
      .from(pax8OrderLines)
      .where(and(
        eq(pax8OrderLines.partnerId, input.partnerId),
        eq(pax8OrderLines.orgId, order.orgId),
        eq(pax8OrderLines.orderId, order.id),
        eq(pax8OrderLines.id, input.lineId),
      ))
      .for('update')
      .limit(1);
    if (!line) throw new Pax8OrderError('Pax8 order line not found.', 404);
    if (line.action !== 'new_subscription') {
      throw new Pax8OrderError('Only new-subscription provisioning details can be edited.', 422);
    }

    const changes: Pick<UpdateOrderLineInput, 'commitmentTermId' | 'provisioningDetails'> = {};
    if (input.commitmentTermId !== undefined) changes.commitmentTermId = input.commitmentTermId;
    if (input.provisioningDetails !== undefined) changes.provisioningDetails = input.provisioningDetails;

    const [updated] = await db
      .update(pax8OrderLines)
      .set(changes)
      .where(and(
        eq(pax8OrderLines.partnerId, input.partnerId),
        eq(pax8OrderLines.orderId, order.id),
        eq(pax8OrderLines.id, line.id),
      ))
      .returning();
    if (!updated) throw new Pax8OrderError('The Pax8 order line could not be updated.', 409);
    return updated;
  });
}

export async function getOrderWithLines(input: {
  partnerId: string;
  orderId: string;
}): Promise<{ order: Pax8OrderRow; lines: Pax8OrderLineRow[] }> {
  const order = await loadOrder(input.partnerId, input.orderId);
  const lines = await db
    .select()
    .from(pax8OrderLines)
    .where(and(
      eq(pax8OrderLines.partnerId, input.partnerId),
      eq(pax8OrderLines.orderId, input.orderId),
    ))
    .orderBy(asc(pax8OrderLines.sortOrder), asc(pax8OrderLines.id));
  return { order, lines };
}

/**
 * Partner-scoped order history for the ordering UI. An org filter returns that
 * org's complete history; the partner-wide queue intentionally excludes only
 * terminal completed/cancelled rows so failed and partially-failed work stays
 * visible for technician action. Both views are bounded and deterministic.
 */
export async function listPax8Orders(input: {
  partnerId: string;
  orgId?: string;
  accessibleOrgIds?: string[] | null;
}): Promise<Pax8OrderRow[]> {
  const conditions: SQL[] = [eq(pax8Orders.partnerId, input.partnerId)];
  if (input.orgId) {
    conditions.push(eq(pax8Orders.orgId, input.orgId));
  } else {
    conditions.push(notInArray(pax8Orders.status, ['completed', 'cancelled']));
    if (input.accessibleOrgIds !== undefined && input.accessibleOrgIds !== null) {
      conditions.push(input.accessibleOrgIds.length > 0
        ? inArray(pax8Orders.orgId, input.accessibleOrgIds)
        : sql`false`);
    }
  }
  return db
    .select()
    .from(pax8Orders)
    .where(and(...conditions))
    .orderBy(desc(pax8Orders.updatedAt), desc(pax8Orders.id))
    .limit(100);
}

export interface Pax8ProductOption {
  pax8ProductId: string;
  catalogItemId: string;
  catalogName: string;
  catalogSku: string | null;
  catalogDescription: string | null;
  productName: string | null;
  vendorSkuId: string | null;
  billingFrequency: string | null;
  commitmentTermMonths: number | null;
}

/** Product choices are entirely local metadata: no Pax8 HTTP and no secrets. */
export async function listPax8Products(input: { partnerId: string }): Promise<Pax8ProductOption[]> {
  return db
    .select({
      pax8ProductId: pax8ProductMappings.pax8ProductId,
      catalogItemId: catalogItems.id,
      catalogName: catalogItems.name,
      catalogSku: catalogItems.sku,
      catalogDescription: catalogItems.description,
      productName: pax8ProductMappings.productName,
      vendorSkuId: pax8ProductMappings.vendorSkuId,
      billingFrequency: catalogItems.billingFrequency,
      commitmentTermMonths: catalogItems.commitmentTermMonths,
    })
    .from(pax8ProductMappings)
    .innerJoin(pax8Integrations, and(
      eq(pax8ProductMappings.integrationId, pax8Integrations.id),
      eq(pax8ProductMappings.partnerId, pax8Integrations.partnerId),
    ))
    .innerJoin(catalogItems, and(
      eq(pax8ProductMappings.catalogItemId, catalogItems.id),
      eq(pax8ProductMappings.partnerId, catalogItems.partnerId),
    ))
    .where(and(
      eq(pax8ProductMappings.partnerId, input.partnerId),
      eq(pax8Integrations.isActive, true),
      eq(catalogItems.isActive, true),
    ))
    .orderBy(
      asc(catalogItems.name),
      asc(pax8ProductMappings.pax8ProductId),
      asc(catalogItems.id),
    )
    .limit(200);
}
