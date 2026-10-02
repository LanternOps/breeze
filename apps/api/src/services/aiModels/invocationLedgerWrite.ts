/**
 * The ai_invocations insert (#7600 W02, spec §5.5), split out of
 * invocationLedger.ts so the reservation settlement can import it without the
 * shadow listener's dependencies (#7601 W03). One append-only row, written
 * through the AMBIENT db: inside a settlement it joins that transaction.
 */
import type { AiSurface, OfferingOptions } from '@breeze/shared';
import { db } from '../../db';
import { aiInvocations } from '../../db/schema';
import { NO_CARD_CHARGE, type InvocationCharge } from '../aiChargeback/chargeTerms';
import type { RateSnapshot, TokenComponents } from './pricing';

export interface NewInvocation {
  orgId: string;
  surface: AiSurface;
  role?: string;
  userId?: string | null;
  sessionId?: string | null;
  agentRunId?: string | null;
  sourceRef?: string | null;
  offeringId?: string | null;
  connectionId?: string | null;
  fundingSource: 'platform' | 'partner_key';
  requestedModel: string;
  servedModel: string;
  optionsSent?: OfferingOptions;
  thinkingModeSent?: 'adaptive' | 'budget' | 'none' | 'unknown' | null;
  inferenceGeoSent?: string | null;
  stopReason?: string | null;
  refusalCategory?: string | null;
  fallbackUsed?: boolean;
  catalogRevisionId?: string | null;
  connectionConfigVersion?: number | null;
  tokens: TokenComponents;
  rateSnapshot: RateSnapshot | null;
  costCents: number | null;
  /** W10 (#7608): the chargeback snapshot from stampChargeback. REQUIRED on an
   *  authoritative row (recordInvocation refuses one without it); ignored on shadow rows. */
  charge?: InvocationCharge;
  sdkReportedCostUsd?: number | null;
  ledgerMode: 'shadow' | 'authoritative';
  legacyCostCents?: number | null;
}

export async function recordInvocation(row: NewInvocation): Promise<string> {
  if (row.ledgerMode === 'authoritative' && row.charge === undefined) {
    throw new Error('recordInvocation: an authoritative ledger row must be stamped by stampChargeback (#7608)');
  }
  // A shadow row is never billed (the charge CHECK refuses a chargeable one),
  // whatever it carries.
  const charge: InvocationCharge = row.ledgerMode === 'authoritative' ? row.charge! : NO_CARD_CHARGE;
  const [inserted] = await db.insert(aiInvocations).values({
    orgId: row.orgId,
    surface: row.surface,
    role: row.role ?? 'default',
    userId: row.userId ?? null,
    sessionId: row.sessionId ?? null,
    agentRunId: row.agentRunId ?? null,
    sourceRef: row.sourceRef ?? null,
    offeringId: row.offeringId ?? null,
    connectionId: row.connectionId ?? null,
    fundingSource: row.fundingSource,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    optionsSent: (row.optionsSent ?? {}) as Record<string, unknown>,
    thinkingModeSent: row.thinkingModeSent ?? null,
    inferenceGeoSent: row.inferenceGeoSent ?? null,
    stopReason: row.stopReason ?? null,
    refusalCategory: row.refusalCategory ?? null,
    fallbackUsed: row.fallbackUsed ?? false,
    catalogRevisionId: row.catalogRevisionId ?? null,
    connectionConfigVersion: row.connectionConfigVersion ?? null,
    inputTokens: row.tokens.input,
    outputTokens: row.tokens.output,
    cacheReadTokens: row.tokens.cacheRead,
    cacheWriteTokens: row.tokens.cacheWrite,
    rateSnapshot: row.rateSnapshot as unknown as Record<string, unknown> | null,
    costCents: row.costCents,
    chargeable: charge.chargeable,
    chargeBillingProfileId: charge.billingProfileId,
    chargeCoverage: charge.coverage,
    chargeBasis: charge.basis,
    chargeCurrency: charge.currency,
    chargeAmount: charge.amount,
    sdkReportedCostUsd: row.sdkReportedCostUsd ?? null,
    ledgerMode: row.ledgerMode,
    legacyCostCents: row.ledgerMode === 'shadow' ? row.legacyCostCents ?? null : null,
  }).returning({ id: aiInvocations.id });
  return inserted!.id;
}
