import { describe, expect, it } from 'vitest';
import { quoteProcessingFee, SURCHARGE_STATE_RULES, type FeeQuoteInput } from './processingFee';
const base: FeeQuoteInput = {
  methodType: 'card', cardFunding: 'credit', principal: '100.00', currency: 'USD',
  stripeAccountCountry: 'US', orgBillingCountry: 'US', orgBillingRegion: 'NY',
  cardFeeBps: 300, achFeeAmount: '0.00', feeAttested: true,
};
describe('fee rule Cartesian product', () => {
  for (const funding of ['credit', 'debit', 'prepaid', 'unknown', null] as const)
  for (const account of ['US', 'CA', 'AU', null])
  for (const country of ['US', 'CA', null])
  for (const state of ['NY', 'CA', 'CT', 'ME', 'MA', 'CO', null])
  for (const attested of [false, true])
  for (const bps of [0, 100, 200, 300, 500]) {
    it(`${funding}/${account}/${country}/${state}/${attested}/${bps}`, () => {
      const quote = quoteProcessingFee({ ...base, cardFunding: funding, stripeAccountCountry: account,
        orgBillingCountry: country, orgBillingRegion: state, feeAttested: attested, cardFeeBps: bps });
      const allowed = bps > 0 && attested && funding === 'credit' && account === 'US'
        && country === 'US' && state !== null && !['CA', 'CT', 'ME', 'MA'].includes(state);
      const expectedBps = allowed ? Math.min(bps, 300, state === 'CO' ? 200 : 300) : 0;
      expect(quote.feeAmount).toBe(`${Math.floor(expectedBps / 100)}.${String(expectedBps % 100).padStart(2, '0')}`);
      expect(quote.appliedBps).toBe(allowed ? expectedBps : null);
      expect(quote.kind).toBe(allowed ? 'card_percent' : 'none');
    });
  }
  it.each([
    ['0.50', 100, '0.01'], ['0.49', 100, '0.00'], ['1.50', 100, '0.02'],
    ['9999999999.99', 300, '300000000.00'],
  ] as const)('rounds %s at %s bps half-up to %s', (principal, cardFeeBps, expected) => {
    expect(quoteProcessingFee({ ...base, principal, cardFeeBps }).feeAmount).toBe(expected);
  });
  it.each([['0.00', '0.00'], ['0.01', '0.01'], ['24.99', '24.99'], ['25.00', '25.00'], ['99.00', '25.00']])(
    'caps ACH flat %s at %s independently of card attestation', (achFeeAmount, expected) => {
      expect(quoteProcessingFee({ ...base, methodType: 'us_bank_account', cardFunding: null,
        feeAttested: false, orgBillingRegion: 'CA', achFeeAmount }).feeAmount).toBe(expected);
    });
  it.each(['JPY', 'EUR', 'AUD'])('does not quote unsupported currency %s', currency => {
    expect(quoteProcessingFee({ ...base, currency }).feeAmount).toBe('0.00');
    expect(quoteProcessingFee({ ...base, currency, methodType: 'us_bank_account', achFeeAmount: '25.00' }).feeAmount).toBe('0.00');
  });
  it.each(['-1.00', 'NaN', '1.005', '10000000000.00', '1e2'])('rejects malformed/out-of-domain principal %s', principal => {
    expect(() => quoteProcessingFee({ ...base, principal })).toThrow('money');
  });
  it('pins reasons, normalization, and the approved state table', () => {
    expect(SURCHARGE_STATE_RULES).toEqual({ CA: { banned: true }, CT: { banned: true }, ME: { banned: true }, MA: { banned: true }, CO: { maxBps: 200 } });
    expect(quoteProcessingFee({ ...base, cardFeeBps: 0 }).reason).toBe('disabled');
    expect(quoteProcessingFee({ ...base, feeAttested: false }).reason).toBe('not_attested');
    expect(quoteProcessingFee({ ...base, cardFunding: 'debit' }).reason).toBe('debit_or_prepaid');
    expect(quoteProcessingFee({ ...base, cardFunding: null }).reason).toBe('unknown_funding');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: 'ZZ' }).reason).toBe('non_us');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: 'MA' }).reason).toBe('state_banned');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: 'CO' }).reason).toBe('state_capped');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: ' ny ', currency: 'usd', stripeAccountCountry: 'us' }).reason).toBe('applied');
  });
});

// G4: settings comparisons (lower authorized terms) use allowedCardFeeBps; it must agree with
// what the engine charges a US-account credit card for every client address.
import { allowedCardFeeBps, quoteProcessingFee as quote } from './processingFee';
describe('allowedCardFeeBps agrees with the fee engine', () => {
  const addresses: [string | null, string | null][] = [['US', 'NY'], ['US', 'CO'], ['US', 'CA'], ['US', 'CT'], ['US', 'TX'],
    ['US', null], ['US', 'ZZ'], ['CA', 'ON'], ['GB', null], [null, null], ['us', 'ny ']];
  it.each(addresses.flatMap(([country, region]) => [300, 250, 100, 0].map(bps => [country, region, bps] as const)))(
    '%s/%s at %i bps', (country, region, bps) => {
      const engine = quote({ methodType: 'card', cardFunding: 'credit', principal: '100.00', currency: 'USD', stripeAccountCountry: 'US',
        orgBillingCountry: country, orgBillingRegion: region, cardFeeBps: bps, achFeeAmount: '0.00', feeAttested: true });
      expect(allowedCardFeeBps(bps, country, region)).toBe(engine.appliedBps ?? 0);
    });
});
