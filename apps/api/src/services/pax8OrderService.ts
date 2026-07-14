import { randomUUID } from 'node:crypto';
import { PAX8_BILLING_TERMS, type Pax8BillingTerm, type Pax8OrderAction } from '@breeze/shared';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  type DbAccessContext,
} from '../db';
import {
  pax8CompanyMappings,
  pax8OrderLines,
  pax8Orders,
  pax8SubscriptionSnapshots,
} from '../db/schema';
import { createPax8ClientForIntegration } from './pax8SyncService';
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
  sortOrder?: number;
}

/** Stable per-order. The unique index on (partner_id, dedupe_key) is what makes
 * a concurrent submit lose the race — see pax8OrderSubmit.claimLine. */
export function buildDedupeKey(orderId: string): string {
  return `order:${orderId}`;
}

const MUTABLE_STATUSES = new Set(['draft', 'awaiting_details']);
const BILLING_TERMS = new Set<string>(PAX8_BILLING_TERMS);
const MUTABLE_DIRECT_ORDER_UNIQUE_INDEX = 'pax8_orders_one_mutable_direct_per_org_uq';

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

/**
 * Pax8 line authoring is a self-managed route with no ambient request
 * transaction. Exit defensively before opening each short partner context so
 * an accidental ambient caller still cannot make these phases reuse its tx.
 */
function withPartnerDbContext<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(partnerDbContext(partnerId), fn));
}

function requireMutableOrder(order: Pax8OrderRow): void {
  if (!MUTABLE_STATUSES.has(order.status)) {
    throw new Pax8OrderError('Only draft or awaiting-details Pax8 orders can be modified.', 409);
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

function activeCommitment(raw: unknown, commitments: Pax8Commitment[]): Pax8Commitment {
  const activeIds = activeCommitmentIds(raw);
  if (activeIds.length > 1) {
    throw new Pax8OrderError(
      'The Pax8 subscription snapshot contains ambiguous active commitment identifiers.',
      422,
    );
  }
  const [activeId] = activeIds;
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
      return;
    default:
      throw new Pax8OrderError('Unsupported Pax8 order action.', 422);
  }
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

  const existing = await findMutableDirectOrder(input.partnerId, input.orgId);
  if (existing) return existing;

  const id = randomUUID();
  try {
    // A nested transaction gives an ambient request transaction a SAVEPOINT.
    // Without it, a handled 23505 would leave the request transaction aborted
    // and the winner re-read below would fail with 25P02.
    const [created] = await db.transaction((tx) => tx.insert(pax8Orders).values({
      id,
      integrationId: mapping.integrationId,
      partnerId: input.partnerId,
      orgId: input.orgId,
      pax8CompanyId: mapping.pax8CompanyId,
      status: 'draft',
      source: 'direct',
      dedupeKey: buildDedupeKey(id),
      createdBy: input.actorUserId,
    }).returning());
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
  requireMutableOrder(order);
  validateActionPayload(input);

  if (input.action === 'change_quantity' || input.action === 'cancel') {
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

    const { client } = await withPartnerDbContext(input.partnerId, () =>
      createPax8ClientForIntegration(order.integrationId));
    const dependencies = await runOutsideDbContext(() =>
      client.getProductDependencies(snapshot.productId!),
    );

    if (input.action === 'change_quantity') {
      const currentQuantity = Number(snapshot.quantity);
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
    requireMutableOrder(lockedOrder);

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
        provisioningDetails: input.provisioningDetails ?? [],
        targetSubscriptionId: input.targetSubscriptionId,
        cancelDate: input.cancelDate,
        contractLineId: input.contractLineId,
        sourceQuoteLineId: input.sourceQuoteLineId,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
  });
  if (!created) throw new Pax8OrderError('The Pax8 order line could not be created.', 409);
  return created;
}

export async function removeOrderLine(input: {
  partnerId: string;
  orderId: string;
  lineId: string;
}): Promise<{ removed: boolean }> {
  const order = await loadOrder(input.partnerId, input.orderId);
  requireMutableOrder(order);

  const removed = await db
    .delete(pax8OrderLines)
    .where(and(
      eq(pax8OrderLines.partnerId, input.partnerId),
      eq(pax8OrderLines.orderId, input.orderId),
      eq(pax8OrderLines.id, input.lineId),
    ))
    .returning({ id: pax8OrderLines.id });
  return { removed: removed.length > 0 };
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
    ));
  return { order, lines };
}
