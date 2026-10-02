import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUTOPAY_CONSENT_TEXT, CURRENT_AUTOPAY_CONSENT_VERSION,
  buildAutopayDisclosure, requireAcceptedAutopayDisclosure, withAcceptedAutopayDisclosure } from './consentText';
import type { Tx } from './types';
describe('accepted authorization', () => {
  it('accepts the shared database-or-transaction executor', () => {
    expectTypeOf<Parameters<typeof buildAutopayDisclosure>[0]>().toEqualTypeOf<Tx>();
  });
  it('requires a named MSP and schedule in both immutable versions', () => {
    for (const text of Object.values(AUTOPAY_CONSENT_TEXT[CURRENT_AUTOPAY_CONSENT_VERSION]!)) {
      expect(text).toContain('{{msp}}');
      expect(text).toContain('{{schedule}}');
      expect(text).toContain('stop');
    }
  });
  it('refuses a missing or changed browser disclosure', async () => {
    expect(() => requireAcceptedAutopayDisclosure('a'.repeat(64))).toThrow();
    await expect(withAcceptedAutopayDisclosure('a'.repeat(64), async () =>
      requireAcceptedAutopayDisclosure('b'.repeat(64)))).rejects.toMatchObject({status:409});
  });
  it('isolates two simultaneous browsers', async () => {
    await Promise.all(['a','b'].map(letter => withAcceptedAutopayDisclosure(letter.repeat(64), async () => {
      await Promise.resolve();
      expect(() => requireAcceptedAutopayDisclosure(letter.repeat(64))).not.toThrow();
    })));
  });
});
