import { randomUUID } from 'node:crypto';
import { PAX8_BILLING_TERMS, type Pax8BillingTerm, type Pax8OrderAction } from '@breeze/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../db';
import {
  pax8CompanyMappings,
  pax8OrderLines,
  pax8Orders,
  pax8SubscriptionSnapshots,
} from '../db/schema';
import { createPax8ClientForIntegration } from './pax8SyncService';

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

function numericQuantity(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

  const [existing] = await db
    .select()
    .from(pax8Orders)
    .where(and(
      eq(pax8Orders.partnerId, input.partnerId),
      eq(pax8Orders.orgId, input.orgId),
      inArray(pax8Orders.status, [...MUTABLE_STATUSES]),
    ))
    .limit(1);
  if (existing) return existing;

  const id = randomUUID();
  const [created] = await db.insert(pax8Orders).values({
    id,
    integrationId: mapping.integrationId,
    partnerId: input.partnerId,
    orgId: input.orgId,
    pax8CompanyId: mapping.pax8CompanyId,
    status: 'draft',
    source: 'direct',
    dedupeKey: buildDedupeKey(id),
    createdBy: input.actorUserId,
  }).returning();
  if (!created) throw new Pax8OrderError('The Pax8 draft order could not be created.', 409);
  return created;
}

export async function addOrderLine(input: AddOrderLineInput): Promise<Pax8OrderLineRow> {
  const order = await loadOrder(input.partnerId, input.orderId);
  requireMutableOrder(order);
  validateActionPayload(input);

  if (input.action === 'change_quantity' || input.action === 'cancel') {
    const [snapshot] = await db
      .select()
      .from(pax8SubscriptionSnapshots)
      .where(and(
        eq(pax8SubscriptionSnapshots.integrationId, order.integrationId),
        eq(pax8SubscriptionSnapshots.partnerId, input.partnerId),
        eq(pax8SubscriptionSnapshots.pax8SubscriptionId, input.targetSubscriptionId!),
      ))
      .limit(1);
    if (!snapshot) throw new Pax8OrderError('Pax8 subscription not found.', 404);
    if (snapshot.orgId !== order.orgId) {
      throw new Pax8OrderError('The target subscription belongs to a different organization.', 403);
    }
    if (!snapshot.productId) {
      throw new Pax8OrderError('The target subscription has no Pax8 product identifier.', 422);
    }

    const { client } = await createPax8ClientForIntegration(order.integrationId);
    const dependencies = await runOutsideDbContext(() =>
      client.getProductDependencies(snapshot.productId!),
    );

    if (input.action === 'change_quantity') {
      const currentQuantity = Number(snapshot.quantity);
      const requestedQuantity = Number(input.quantity);
      if (requestedQuantity < currentQuantity
        && !dependencies.commitments.some((commitment) => commitment.allowForQuantityDecrease)) {
        throw new Pax8OrderError('This product commitment does not allow a quantity decrease.', 422);
      }
      if (requestedQuantity > currentQuantity
        && !dependencies.commitments.some((commitment) => commitment.allowForQuantityIncrease)) {
        throw new Pax8OrderError('This product commitment does not allow a quantity increase.', 422);
      }
    } else if (!dependencies.commitments.some((commitment) => commitment.allowForEarlyCancellation)) {
      throw new Pax8OrderError('This product commitment does not allow early cancellation.', 422);
    }
  }

  const [created] = await db.insert(pax8OrderLines).values({
    orderId: order.id,
    partnerId: order.partnerId,
    orgId: order.orgId,
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
  }).returning();
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
