import { describe, expect, it } from 'vitest';
import { policyAppRuleSchema } from './index';

// 128 x U+1F600 = 128 code points = 256 UTF-16 code units. The ring app-rules
// backfill SQL measures UTF-16 units, so this must be rejected on every zod.
describe('policyAppRuleSchema length semantics (UTF-16 code units)', () => {
  const base = { source: 'third_party', packageId: 'Emoji.Name', action: 'block' };

  it('rejects a 128-emoji displayName (256 code units > 255)', () => {
    expect(policyAppRuleSchema.safeParse({ ...base, displayName: '\u{1F600}'.repeat(128) }).success).toBe(false);
  });

  it('accepts 127 emoji (254 units) and 255 ASCII chars', () => {
    expect(policyAppRuleSchema.safeParse({ ...base, displayName: '\u{1F600}'.repeat(127) }).success).toBe(true);
    expect(policyAppRuleSchema.safeParse({ ...base, displayName: 'x'.repeat(255) }).success).toBe(true);
    expect(policyAppRuleSchema.safeParse({ ...base, displayName: 'x'.repeat(256) }).success).toBe(false);
  });
});
