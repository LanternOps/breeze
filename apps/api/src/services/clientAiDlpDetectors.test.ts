import { describe, it, expect } from 'vitest';
import {
  detectCreditCard,
  detectSsn,
  luhnCheck,
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
