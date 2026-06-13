import { describe, it, expect } from 'vitest';
import {
  detectApiKey,
  detectCreditCard,
  detectEmail,
  detectIban,
  detectPhone,
  detectSsn,
  ibanMod97,
  luhnCheck,
  mergeMatches,
  ssnContextPresent,
} from './clientAiDlpDetectors';

describe('luhnCheck', () => {
  it.each([
    ['4111111111111111', true], // Visa 16-digit test number
    ['378282246310005', true], // Amex 15-digit test number
    ['4222222222222', true], // Visa 13-digit test number
    ['4111111111111112', false], // checksum off by one
    ['1234567890123456', false],
  ])('%s → %s', (digits, expected) => {
    expect(luhnCheck(digits)).toBe(expected);
  });

  it('rejects out-of-range lengths', () => {
    expect(luhnCheck('411111111111')).toBe(false); // 12 digits
    expect(luhnCheck('41111111111111111111')).toBe(false); // 20 digits
  });
});

describe('detectCreditCard', () => {
  it.each([
    ['plain 16-digit', 'card 4111111111111111 ok', 1],
    ['dash separators', 'card 4111-1111-1111-1111', 1],
    ['space separators', '4111 1111 1111 1111', 1],
    ['Amex 15-digit', 'amex 378282246310005', 1],
    ['Visa 13-digit', '4222222222222', 1],
    ['Luhn-invalid 16 digits NOT matched', '4111111111111112', 0],
    ['12 digits too short', '411111111111', 0],
    ['inside a 20-digit run — no sub-span matching', '41111111111111110000', 0],
    ['two cards', '4111111111111111 and 4111-1111-1111-1111', 2],
  ])('%s', (_name, text, hits) => {
    expect(detectCreditCard(text)).toHaveLength(hits);
  });

  it('returns exact spans', () => {
    expect(detectCreditCard('pay 4111111111111111 now')).toEqual([{ start: 4, end: 20 }]);
  });
});

describe('detectSsn', () => {
  it.each([
    ['dashed form, no context needed', 'id 536-22-1234', false, 1],
    ['invalid area 000', '000-12-3456', false, 0],
    ['invalid area 666', '666-12-3456', false, 0],
    ['invalid area 9xx', '912-12-3456', false, 0],
    ['invalid group 00', '536-00-1234', false, 0],
    ['invalid serial 0000', '536-22-0000', false, 0],
    ['bare 9 digits without context', 'id 536221234', false, 0],
    ['bare 9 digits with context active', 'num 536221234', true, 1],
    ['bare digits inside a longer run', 'ref 5362212345', true, 0],
    ['bare implausible area even with context', 'num 666221234', true, 0],
  ])('%s', (_name, text, contextActive, hits) => {
    expect(detectSsn(text, contextActive)).toHaveLength(hits);
  });

  it('ssnContextPresent detects keywords', () => {
    expect(ssnContextPresent('Employee SSN list')).toBe(true);
    expect(ssnContextPresent('social security numbers')).toBe(true);
    expect(ssnContextPresent('sales figures')).toBe(false);
  });
});

describe('ibanMod97', () => {
  it('validates the rearranged mod-97 == 1 rule', () => {
    expect(ibanMod97('DE89370400440532013000')).toBe(true);
    expect(ibanMod97('GB82WEST12345698765432')).toBe(true);
    expect(ibanMod97('DE89370400440532013001')).toBe(false); // single digit mutated
  });
});

describe('detectIban', () => {
  it.each([
    ['German IBAN', 'acct DE89370400440532013000', 1],
    ['UK IBAN', 'GB82WEST12345698765432', 1],
    ['mod-97 invalid NOT matched', 'DE89370400440532013001', 0],
    ['lowercase not matched (canonical uppercase shape only)', 'de89370400440532013000', 0],
    ['too short', 'DE8937040044', 0],
  ])('%s', (_name, text, hits) => {
    expect(detectIban(text)).toHaveLength(hits);
  });
});

describe('detectApiKey', () => {
  it.each([
    ['anthropic-style key', 'key sk-ant-abcdefghijklmnop1234', 1],
    ['github pat', 'ghp_abcdefghijklmnop1234', 1],
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', 1],
    ['breeze brz_ token', `brz_${'ab12'.repeat(12)}`, 1],
    [
      'jwt (merged with its base64 segments)',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N7flQ',
      1,
    ],
    ['generic 32-char hex blob', 'token 3fa85f6457174562b3fc2c963f66afa6', 1],
    ['generic mixed-class base64 blob', 'dGhpc0lzQVZlcnlMb25nU2VjcmV0VG9rZW4xMjM0', 1],
    ['all-letter run NOT matched', 'abcdefabcdefabcdefabcdefabcdefab', 0],
    ['digits-only run NOT matched', '11111111111111111111111111111111', 0],
    ['short hex NOT matched', 'deadbeef1234', 0],
  ])('%s', (_name, text, hits) => {
    expect(detectApiKey(text)).toHaveLength(hits);
  });
});

describe('detectEmail', () => {
  it('matches standard addresses', () => {
    expect(detectEmail('contact alice@example.com today')).toHaveLength(1);
  });
  it('ignores non-addresses', () => {
    expect(detectEmail('not an email @ nowhere')).toHaveLength(0);
  });
});

describe('detectPhone', () => {
  it.each([
    ['dashed NANP', 'call 555-123-4567', 1],
    ['parenthesised area code', '(555) 123-4567', 1],
    ['dotted', '555.123.4567', 1],
    ['international prefix', '+1 555 123 4567', 1],
    ['bare 10-digit run NOT matched (precision-first)', '5551234567', 0],
    ['not inside card numbers', '4111-1111-1111-1111', 0],
  ])('%s', (_name, text, hits) => {
    expect(detectPhone(text)).toHaveLength(hits);
  });
});

describe('mergeMatches', () => {
  it('merges overlapping and nested spans', () => {
    expect(
      mergeMatches([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 20, end: 25 },
        { start: 21, end: 23 },
      ]),
    ).toEqual([
      { start: 0, end: 15 },
      { start: 20, end: 25 },
    ]);
  });
});
