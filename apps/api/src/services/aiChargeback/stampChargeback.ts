/**
 * Stamp the AI chargeback snapshot on ledger rows (#7608, spec §5.5).
 *
 * THE SNAPSHOT MOMENT IS THE LEDGER WRITE: called inside W03's settlement
 * transaction (aiBudgetReservations: settleAiBudgetReservation /
 * recordInvocationsWithRollups), before recordInvocation inserts. A deferred
 * settlement replayed later is therefore stamped at replay with the card then
 * in force, and bills in the replay month (decided 2026-10-02, #7598).
 *
 * SYSTEM CONTEXT ONLY. The card tables are partner-axis; inside the settlement's
 * system transaction they are visible on the SAME connection. Called anywhere
 * else this would need readWithPartnerAxisVisibility's escape (a second pooled
 * connection while the caller holds one — the 2026-09-22 wedge), so it refuses.
 */
import { eq, sql } from 'drizzle-orm';
import type { AiCoverage } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import { loadCardHeadsForOrg } from '../billingProfileService';
import { selectCard } from '../billingRuleResolver';
import type { NewInvocation } from '../aiModels/invocationLedgerWrite';
import { computeInvocationCharge, type AiChargeCard, type AiRatePrices } from './chargeTerms';

type CardTermsRow = {
  currency_code: string;
  ai_coverage: AiCoverage;
  ai_markup_percent: string | null;
  rates: Array<AiRatePrices & { modelId: string }>;
};

function assertSystemScope(operation: string): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error(`${operation} must run inside a system DB context (the settlement transaction)`);
  }
}

/** The chosen card's terms and price list, read in ONE statement (one
 *  snapshot), so a concurrent card save can never yield old markup + new
 *  rates. Nothing when the card was archived since it was selected. */
async function readCardTerms(cardId: string): Promise<CardTermsRow | undefined> {
  const result = await db.execute(sql`
    SELECT p.currency_code, p.ai_coverage, p.ai_markup_percent::text AS ai_markup_percent,
           COALESCE(json_agg(json_build_object(
             'modelId', r.model_id,
             'inputPricePerM', r.input_price_per_m::text,
             'outputPricePerM', r.output_price_per_m::text,
             'cacheReadPricePerM', r.cache_read_price_per_m::text,
             'cacheWritePricePerM', r.cache_write_price_per_m::text)) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS rates
    FROM billing_profiles p
    LEFT JOIN billing_profile_ai_rates r ON r.billing_profile_id = p.id AND r.partner_id = p.partner_id
    WHERE p.id = ${cardId}::uuid AND p.is_active
    GROUP BY p.id`);
  return ((result as unknown as { rows?: CardTermsRow[] }).rows ?? (result as unknown as CardTermsRow[]))[0];
}

/** The org's AI price card (one resolver: selectCard), or null. Selection
 *  reads profile rows only (loadCardHeadsForOrg); the terms + price list come
 *  from one further statement. A card archived (or moved to another currency)
 *  between the two statements re-runs selection ONCE, so the row stamps the
 *  card now in force rather than "no card"; a second miss warns and stamps no
 *  card instead of looping inside the settlement transaction. */
export async function loadAiChargeCard(orgId: string): Promise<AiChargeCard | null> {
  assertSystemScope('loadAiChargeCard');
  const [org] = await db.select({ partnerId: organizations.partnerId, currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  let missedCardId: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { assignedCard, partnerDefaultCard } = await loadCardHeadsForOrg(orgId, org.partnerId, org.currencyCode);
    const card = selectCard({ orgCurrency: org.currencyCode, assignedCard, partnerDefaultCard });
    if (!card) return null;
    const terms = await readCardTerms(card.id);
    if (terms && terms.currency_code === org.currencyCode) {
      return {
        id: card.id,
        currencyCode: terms.currency_code,
        aiCoverage: terms.ai_coverage,
        aiMarkupPercent: terms.ai_markup_percent,
        aiRates: new Map(terms.rates.map((r) => [r.modelId, r])),
      };
    }
    missedCardId = card.id;
  }
  console.warn(`[AiChargeback] org ${orgId}: billing card ${missedCardId} was archived or changed currency between selection and its terms read, twice; stamping no card`);
  return null;
}

export async function stampChargeback(orgId: string, rows: readonly NewInvocation[]): Promise<NewInvocation[]> {
  if (!rows.some((r) => r.ledgerMode === 'authoritative')) return [...rows];
  assertSystemScope('stampChargeback');
  if (rows.some((r) => r.orgId !== orgId)) {
    throw new Error('stampChargeback: every row must belong to the settling org');
  }
  const card = await loadAiChargeCard(orgId);
  return rows.map((r) => r.ledgerMode !== 'authoritative' ? r : {
    ...r,
    charge: computeInvocationCharge({
      card, surface: r.surface, servedModel: r.servedModel, tokens: r.tokens, costCents: r.costCents,
    }),
  });
}
