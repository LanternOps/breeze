import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  contractLines,
  pax8ContractLineLinks,
  pax8Integrations,
  pax8SubscriptionSnapshots,
} from '../db/schema';

export interface Pax8DriftRow {
  contractLineId: string;
  orgId: string;
  pax8SubscriptionId: string;
  productName: string | null;
  breezeQuantity: string | null;
  pax8Quantity: string;
}

export interface DetectPax8DriftInput {
  partnerId: string;
  integrationId: string;
}

const MAX_DRIFT_ROWS = 1000;

/**
 * Reads known Pax8 quantity observations that disagree with Breeze's billing
 * ledger. This deliberately performs no Pax8 HTTP calls and no writes.
 */
export async function detectPax8Drift(input: DetectPax8DriftInput): Promise<Pax8DriftRow[]> {
  return db
    .select({
      contractLineId: contractLines.id,
      orgId: pax8ContractLineLinks.orgId,
      pax8SubscriptionId: pax8SubscriptionSnapshots.pax8SubscriptionId,
      productName: pax8SubscriptionSnapshots.productName,
      breezeQuantity: contractLines.manualQuantity,
      pax8Quantity: pax8SubscriptionSnapshots.quantity,
    })
    .from(pax8ContractLineLinks)
    .innerJoin(pax8Integrations, and(
      eq(pax8Integrations.id, pax8ContractLineLinks.integrationId),
      eq(pax8Integrations.partnerId, pax8ContractLineLinks.partnerId),
    ))
    .innerJoin(pax8SubscriptionSnapshots, and(
      eq(pax8SubscriptionSnapshots.id, pax8ContractLineLinks.subscriptionSnapshotId),
      eq(pax8SubscriptionSnapshots.integrationId, pax8ContractLineLinks.integrationId),
      eq(pax8SubscriptionSnapshots.partnerId, pax8ContractLineLinks.partnerId),
      eq(pax8SubscriptionSnapshots.orgId, pax8ContractLineLinks.orgId),
    ))
    .innerJoin(contractLines, and(
      eq(contractLines.id, pax8ContractLineLinks.contractLineId),
      eq(contractLines.orgId, pax8ContractLineLinks.orgId),
    ))
    .where(and(
      eq(pax8Integrations.id, input.integrationId),
      eq(pax8Integrations.partnerId, input.partnerId),
      eq(pax8ContractLineLinks.integrationId, input.integrationId),
      eq(pax8ContractLineLinks.partnerId, input.partnerId),
      eq(pax8ContractLineLinks.syncEnabled, true),
      eq(pax8SubscriptionSnapshots.quantityKnown, true),
      isNotNull(pax8SubscriptionSnapshots.orgId),
      eq(contractLines.lineType, 'manual'),
      sql`${contractLines.manualQuantity} IS DISTINCT FROM ${pax8SubscriptionSnapshots.quantity}`,
    ))
    .orderBy(asc(contractLines.id), asc(pax8SubscriptionSnapshots.pax8SubscriptionId))
    .limit(MAX_DRIFT_ROWS);
}
