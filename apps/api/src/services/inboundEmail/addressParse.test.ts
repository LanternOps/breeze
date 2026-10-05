import { describe, expect, it } from 'vitest';
import { parseMailboxes, parseSingleMailbox } from './addressParse';

describe('parseMailboxes / parseSingleMailbox', () => {
  it.each([
    ['a quoted display name containing an address', '"Staff <staff@msp.example>" <attacker@evil.example>', 'attacker@evil.example', 'Staff <staff@msp.example>'],
    ['a comment containing an address', 'attacker@evil.example (Staff <staff@msp.example>)', 'attacker@evil.example', 'Staff <staff@msp.example>'],
    ['a quoted display name before a bare address', '"Staff <staff@msp.example>" attacker@evil.example', 'attacker@evil.example', 'Staff <staff@msp.example>'],
    ['a normal display name', 'Jane Doe <Jane@X.com>', 'jane@x.com', 'Jane Doe'],
    ['a bare address', 'jane@x.com', 'jane@x.com', undefined],
    ['escaped quotes and a comma in the name', '"Doe, \\"John\\"" <john@x.com>', 'john@x.com', 'Doe, "John"'],
  ])('takes the mailbox for %s', (_label, raw, address, name) => {
    expect(parseSingleMailbox(raw)).toEqual({ address, name });
  });

  it('returns nothing for empty, whitespace, or a null address', () => {
    expect(parseMailboxes(undefined)).toEqual([]);
    expect(parseMailboxes('   ')).toEqual([]);
    expect(parseMailboxes('<>')).toEqual([]);
    expect(parseSingleMailbox('<>')).toBeNull();
  });

  it('treats more than one mailbox as ambiguous for the single form', () => {
    expect(parseMailboxes('staff@msp.example, attacker@evil.example').map((m) => m.address))
      .toEqual(['staff@msp.example', 'attacker@evil.example']);
    expect(parseSingleMailbox('staff@msp.example, attacker@evil.example')).toBeNull();
    expect(parseSingleMailbox('Team: staff@msp.example, attacker@evil.example;')).toBeNull();
  });
});
