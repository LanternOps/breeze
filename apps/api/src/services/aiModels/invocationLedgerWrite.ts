/**
 * The ai_invocations insert (#7600 W02, spec §5.5) — the invocation ledger's
 * one writer, used by the reservation settlement (settleInvocation). One
 * append-only row, written through the AMBIENT db: inside a settlement it
 * joins that transaction. (W06 deleted the W02 shadow listener; historical
 * rows keep `ledger_mode = 'shadow'`.)
 */
import type { AiSurface, OfferingOptions, PromptProfile } from '@breeze/shared';
import { db } from '../../db';
import { aiInvocations } from '../../db/schema';
import { NO_CARD_CHARGE, type InvocationCharge } from '../aiChargeback/chargeTerms';
import type { FailoverCause } from './failover';
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
  /** W09 (#7607): the offering routed to before failover (null on hop 0, or when it no longer exists). */
  failoverFromOfferingId?: string | null;
  /** W09: candidates passed over before the serving one (0 = no failover). */
  failoverHop?: number;
  /** W09: why the first candidate was passed over; null on hop 0. */
  failoverCause?: FailoverCause | null;
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
  /** W11 (#7609): the prompt profile the call was dispatched under. */
  promptProfile?: PromptProfile | null;
  /** W11: the prompt variant appended to the system prompt; null = the surface's base prompt. */
  promptVariant?: string | null;
  /** W11: when the turn was first settled. A string after the pending-settlement JSON round trip. */
  occurredAt?: Date | string | null;
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
    failoverFromOfferingId: row.failoverFromOfferingId ?? null,
    failoverHop: row.failoverHop ?? 0,
    failoverCause: row.failoverCause ?? null,
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
    promptProfile: row.promptProfile ?? null,
    promptVariant: row.promptVariant ?? null,
    occurredAt: row.occurredAt ? new Date(row.occurredAt) : null,
  }).returning({ id: aiInvocations.id });
  return inserted!.id;
}
