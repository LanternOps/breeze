/**
 * Pure AI chargeback terms (#7608, spec §8). Decides, for ONE ledger row,
 * whether it is billable to the client org and at what client price, from the
 * card in force at ledger write. No DB, no I/O (billingRuleResolver pattern).
 *
 * Precedence on a billable card: a price-list row for the SERVED model, else
 * the markup (USD cards only: cost_cents is USD and nothing is ever converted),
 * else 'unpriced' (chargeable, but no amount; surfaced, never billed at zero).
 * Both a markup and a price list may sit on one card; the price list wins per
 * model (decided 2026-10-02, #7598).
 */
import { AI_CHARGEBACK_ELIGIBLE_SURFACES, type AiCoverage, type AiSurface } from '@breeze/shared';
import type { TokenComponents } from '../aiModels/pricing';
import { markupAmount, priceListAmount } from './chargeMath';

export const AI_COST_CURRENCY = 'USD';
export type ChargeCoverage = AiCoverage | 'not_eligible';
export type ChargeBasis = 'price_list' | 'markup' | 'unpriced';

export interface AiRatePrices {
  inputPricePerM: string;
  outputPricePerM: string;
  cacheReadPricePerM: string;
  cacheWritePricePerM: string;
}

export interface AiChargeCard {
  id: string;
  currencyCode: string;
  aiCoverage: AiCoverage;
  aiMarkupPercent: string | null;
  /** keyed by model id = ai_invocations.served_model */
  aiRates: ReadonlyMap<string, AiRatePrices>;
}

/** What is stamped on the ai_invocations row (the charge_* columns + chargeable). */
export interface InvocationCharge {
  chargeable: boolean;
  billingProfileId: string | null;
  coverage: ChargeCoverage | null;
  basis: ChargeBasis | null;
  currency: string | null;
  /** card-currency major units, exactly 6 dp; null unless chargeable AND priced */
  amount: string | null;
}

export const NO_CARD_CHARGE: Readonly<InvocationCharge> = Object.freeze({
  chargeable: false, billingProfileId: null, coverage: null, basis: null, currency: null, amount: null,
});

const ELIGIBLE: ReadonlySet<string> = new Set(AI_CHARGEBACK_ELIGIBLE_SURFACES);

export function computeInvocationCharge(input: {
  card: AiChargeCard | null;
  surface: AiSurface;
  servedModel: string;
  tokens: TokenComponents;
  costCents: number | null;
}): InvocationCharge {
  const { card } = input;
  if (!card) return { ...NO_CARD_CHARGE };
  const notCharged = (coverage: ChargeCoverage): InvocationCharge => ({
    chargeable: false, billingProfileId: card.id, coverage, basis: null, currency: null, amount: null,
  });
  if (!ELIGIBLE.has(input.surface)) return notCharged('not_eligible');
  if (card.aiCoverage !== 'billable') return notCharged(card.aiCoverage);
  const charged = (basis: ChargeBasis, amount: string | null): InvocationCharge => ({
    chargeable: true, billingProfileId: card.id, coverage: 'billable', basis, currency: card.currencyCode, amount,
  });
  const listed = card.aiRates.get(input.servedModel);
  if (listed) return charged('price_list', priceListAmount(input.tokens, listed));
  if (card.aiMarkupPercent !== null && card.currencyCode === AI_COST_CURRENCY && input.costCents !== null) {
    return charged('markup', markupAmount(input.costCents, card.aiMarkupPercent));
  }
  return charged('unpriced', null);
}
