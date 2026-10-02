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
import type { AI_CHARGE_BASES, AI_CHARGE_COVERAGES } from '../../db/schema/aiInvocations';
import type { TokenComponents } from '../aiModels/pricing';
import { markupAmount, priceListAmount } from './chargeMath';

export const AI_COST_CURRENCY = 'USD';
/** One source: the schema's const tuples (the charge_coverage / charge_basis columns). */
export type ChargeCoverage = (typeof AI_CHARGE_COVERAGES)[number];
export type ChargeBasis = (typeof AI_CHARGE_BASES)[number];

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

/** Not billable to the client: no card (all null), a surface that is never
 *  chargeable ('not_eligible'), or a non-billable / included card. */
export interface NotCharged {
  chargeable: false;
  billingProfileId: string | null;
  coverage: Exclude<ChargeCoverage, 'billable'> | null;
  basis: null;
  currency: null;
  amount: null;
}
/** Billable at a client price. */
export interface ChargedPriced {
  chargeable: true;
  billingProfileId: string;
  coverage: 'billable';
  basis: Exclude<ChargeBasis, 'unpriced'>;
  currency: string;
  /** card-currency major units, exactly 6 dp */
  amount: string;
}
/** Billable, but the card has no price for this model: counted, never billed at zero. */
export interface ChargedUnpriced {
  chargeable: true;
  billingProfileId: string;
  coverage: 'billable';
  basis: 'unpriced';
  currency: string;
  amount: null;
}
/** What is stamped on the ai_invocations row (the charge_* columns + chargeable).
 *  Every variant carries all six keys: recordInvocation writes each column. */
export type InvocationCharge = NotCharged | ChargedPriced | ChargedUnpriced;

export const NO_CARD_CHARGE: Readonly<NotCharged> = Object.freeze({
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
  const notCharged = (coverage: Exclude<ChargeCoverage, 'billable'>): NotCharged => ({
    chargeable: false, billingProfileId: card.id, coverage, basis: null, currency: null, amount: null,
  });
  if (!ELIGIBLE.has(input.surface)) return notCharged('not_eligible');
  if (card.aiCoverage !== 'billable') return notCharged(card.aiCoverage);
  const priced = (basis: ChargedPriced['basis'], amount: string): ChargedPriced => ({
    chargeable: true, billingProfileId: card.id, coverage: 'billable', basis, currency: card.currencyCode, amount,
  });
  const listed = card.aiRates.get(input.servedModel);
  if (listed) return priced('price_list', priceListAmount(input.tokens, listed));
  if (card.aiMarkupPercent !== null && card.currencyCode === AI_COST_CURRENCY && input.costCents !== null) {
    return priced('markup', markupAmount(input.costCents, card.aiMarkupPercent));
  }
  return { chargeable: true, billingProfileId: card.id, coverage: 'billable', basis: 'unpriced', currency: card.currencyCode, amount: null };
}
