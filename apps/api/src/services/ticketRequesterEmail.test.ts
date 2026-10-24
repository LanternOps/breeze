import { describe, expect, it } from 'vitest';
import { normalizeRequesterEmail } from './ticketRequesterEmail';

describe('normalizeRequesterEmail — the one rule the merge key and the import report share', () => {
  it('trims and lower-cases', () => {
    expect(normalizeRequesterEmail('  Maya@Customer.Example ')).toBe('maya@customer.example');
  });

  it('answers none for no email, an empty one and a blank one', () => {
    expect(normalizeRequesterEmail(null)).toBeNull();
    expect(normalizeRequesterEmail(undefined)).toBeNull();
    expect(normalizeRequesterEmail('')).toBeNull();
    expect(normalizeRequesterEmail('   ')).toBeNull();
  });
});
