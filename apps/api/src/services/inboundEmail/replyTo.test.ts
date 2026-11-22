import { describe, it, expect } from 'vitest';
import { normalizeReplyTo } from './replyTo';

describe('normalizeReplyTo (syntax only: exactly one usable address, else undefined)', () => {
  it('parses a single Reply-To', () => {
    expect(normalizeReplyTo('Jane Customer <Jane@Customer.Example>')).toBe('jane@customer.example');
    expect(normalizeReplyTo('jane@customer.example')).toBe('jane@customer.example');
    expect(normalizeReplyTo(['jane@customer.example'])).toBe('jane@customer.example');
  });

  it('reads the address inside a display name that itself looks like an address', () => {
    // The addr-spec wins, never a quoted display name (addressParse.ts).
    expect(normalizeReplyTo('"staff@msp.example" <jane@customer.example>')).toBe('jane@customer.example');
  });

  it('ignores a multi-address Reply-To', () => {
    expect(normalizeReplyTo('jane@customer.example, other@customer.example')).toBeUndefined();
    expect(normalizeReplyTo('Team: jane@customer.example, other@customer.example;')).toBeUndefined();
  });

  it('ignores more than one Reply-To header', () => {
    expect(normalizeReplyTo(['jane@customer.example', 'other@customer.example'])).toBeUndefined();
    // Even when both name the same address: a duplicated header is not a clean message.
    expect(normalizeReplyTo(['jane@customer.example', 'jane@customer.example'])).toBeUndefined();
  });

  it('ignores a malformed Reply-To', () => {
    for (const bad of [
      'not an address',
      'jane@',
      '@customer.example',
      'jane@localhost',
      'jane@customer..example',
      'jane@-customer.example',
      'jane smith@customer.example',
      'jane@customer.example\u0000',
      `${'a'.repeat(250)}@customer.example`,
    ]) {
      expect(normalizeReplyTo(bad), bad).toBeUndefined();
    }
  });

  it('ignores empty, absent and non-string input', () => {
    expect(normalizeReplyTo(undefined)).toBeUndefined();
    expect(normalizeReplyTo(null)).toBeUndefined();
    expect(normalizeReplyTo('')).toBeUndefined();
    expect(normalizeReplyTo('   ')).toBeUndefined();
    expect(normalizeReplyTo([])).toBeUndefined();
    expect(normalizeReplyTo(42)).toBeUndefined();
    expect(normalizeReplyTo({ address: 'jane@customer.example' })).toBeUndefined();
  });

  it('accepts Graph recipient objects: exactly one', () => {
    expect(normalizeReplyTo([{ emailAddress: { address: 'Jane@Customer.Example', name: 'Jane' } }]))
      .toBe('jane@customer.example');
    expect(normalizeReplyTo([
      { emailAddress: { address: 'jane@customer.example' } },
      { emailAddress: { address: 'other@customer.example' } },
    ])).toBeUndefined();
    expect(normalizeReplyTo([{ emailAddress: { address: 'jane@customer.example, other@customer.example' } }]))
      .toBeUndefined();
    expect(normalizeReplyTo([{ emailAddress: {} }])).toBeUndefined();
  });
});
