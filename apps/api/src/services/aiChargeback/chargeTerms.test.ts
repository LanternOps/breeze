import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AI_CHARGE_BASES, AI_CHARGE_COVERAGES } from '../../db/schema/aiInvocations';
import {
  computeInvocationCharge, NO_CARD_CHARGE, type AiChargeCard, type ChargeBasis, type ChargeCoverage, type InvocationCharge,
} from './chargeTerms';

const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
const listed = { inputPricePerM: '3.60', outputPricePerM: '18', cacheReadPricePerM: '0.36', cacheWritePricePerM: '4.5' };
const card = (over: Partial<AiChargeCard> = {}): AiChargeCard => ({
  id: 'card-1', currencyCode: 'USD', aiCoverage: 'billable', aiMarkupPercent: '25.00',
  aiRates: new Map([['w10-test-listed', listed]]), ...over,
});
const charge = (c: AiChargeCard | null, over: { surface?: string; servedModel?: string; costCents?: number | null } = {}) =>
  computeInvocationCharge({ card: c, surface: (over.surface ?? 'chat') as never, servedModel: over.servedModel ?? 'w10-test-other',
    tokens, costCents: over.costCents === undefined ? 400 : over.costCents });

describe('computeInvocationCharge (#7608)', () => {
  it('no card → not chargeable, nothing stamped', () => {
    expect(charge(null)).toEqual(NO_CARD_CHARGE);
  });
  it.each(['catalog_enrichment', 'extension_content', 'patch_test'])('%s is never chargeable', (surface) => {
    expect(charge(card(), { surface })).toEqual({ chargeable: false, billingProfileId: 'card-1',
      coverage: 'not_eligible', basis: null, currency: null, amount: null });
  });
  it.each(['included', 'non_billable'] as const)('%s coverage → not chargeable, coverage stamped', (aiCoverage) => {
    expect(charge(card({ aiCoverage, aiMarkupPercent: null }))).toEqual({ chargeable: false, billingProfileId: 'card-1',
      coverage: aiCoverage, basis: null, currency: null, amount: null });
  });
  it('a price-list row for the served model wins over the markup', () => {
    expect(charge(card(), { servedModel: 'w10-test-listed' })).toEqual({ chargeable: true, billingProfileId: 'card-1',
      coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '3.600000' });
  });
  it('a model without a price-list row uses the markup on a USD card', () => {
    // 400 c × 1.25 = 500 c = 5.000000 USD
    expect(charge(card())).toMatchObject({ chargeable: true, basis: 'markup', currency: 'USD', amount: '5.000000' });
  });
  it('EUR card, markup only → unpriced (never converted)', () => {
    expect(charge(card({ currencyCode: 'EUR', aiRates: new Map() }))).toEqual({ chargeable: true, billingProfileId: 'card-1',
      coverage: 'billable', basis: 'unpriced', currency: 'EUR', amount: null });
  });
  it('EUR card with a price-list row prices in EUR', () => {
    expect(charge(card({ currencyCode: 'EUR' }), { servedModel: 'w10-test-listed' }))
      .toMatchObject({ basis: 'price_list', currency: 'EUR', amount: '3.600000' });
  });
  it('billable with neither markup nor a matching row → unpriced', () => {
    expect(charge(card({ aiMarkupPercent: null }))).toMatchObject({ chargeable: true, basis: 'unpriced', amount: null });
  });
  it('an unpriced Breeze cost cannot be marked up → unpriced', () => {
    expect(charge(card(), { costCents: null })).toMatchObject({ chargeable: true, basis: 'unpriced', amount: null });
  });
  it('the price list keys on the SERVED model (a refusal fallback bills what served)', () => {
    expect(charge(card(), { servedModel: 'w10-test-listed' }).basis).toBe('price_list');
    expect(charge(card(), { servedModel: 'w10-test-requested-but-refused' }).basis).toBe('markup');
  });
});

// Type-level contract (checked by tsc --build tsconfig.tests.json, which
// covers test files; vitest itself does not typecheck).
describe('InvocationCharge type (#7608)', () => {
  it('coverage and basis come from the schema\'s const tuples (one source)', () => {
    expectTypeOf<ChargeCoverage>().toEqualTypeOf<(typeof AI_CHARGE_COVERAGES)[number]>();
    expectTypeOf<ChargeBasis>().toEqualTypeOf<(typeof AI_CHARGE_BASES)[number]>();
  });
  it('only the three real shapes are representable', () => {
    const shapes: InvocationCharge[] = [
      NO_CARD_CHARGE,
      { chargeable: false, billingProfileId: 'c', coverage: 'not_eligible', basis: null, currency: null, amount: null },
      { chargeable: true, billingProfileId: 'c', coverage: 'billable', basis: 'markup', currency: 'USD', amount: '1.000000' },
      { chargeable: true, billingProfileId: 'c', coverage: 'billable', basis: 'unpriced', currency: 'EUR', amount: null },
      // @ts-expect-error a chargeable row always has a basis
      { chargeable: true, billingProfileId: 'c', coverage: 'billable', basis: null, currency: 'USD', amount: null },
      // @ts-expect-error a priced basis always has an amount
      { chargeable: true, billingProfileId: 'c', coverage: 'billable', basis: 'price_list', currency: 'USD', amount: null },
      // @ts-expect-error an unpriced charge never has an amount
      { chargeable: true, billingProfileId: 'c', coverage: 'billable', basis: 'unpriced', currency: 'USD', amount: '1.000000' },
      // @ts-expect-error a not-charged row never has an amount
      { chargeable: false, billingProfileId: 'c', coverage: 'included', basis: null, currency: null, amount: '1.000000' },
      // @ts-expect-error billable coverage is always chargeable
      { chargeable: false, billingProfileId: 'c', coverage: 'billable', basis: null, currency: null, amount: null },
    ];
    expect(shapes).toHaveLength(9);
  });
});
