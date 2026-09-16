import { describe, expect, it } from 'vitest';
import {
  GENERIC_AGENT_ENTERPRISE_NUMBERS,
  IANA_ENTERPRISE_VENDORS,
  enterpriseNumberFromSysObjectId,
  vendorFromSysObjectId,
} from './ianaEnterprise';

describe('enterpriseNumberFromSysObjectId', () => {
  it('parses the Xerox C325 sysObjectID, leading dot and all (spec F5)', () => {
    expect(enterpriseNumberFromSysObjectId('.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1')).toBe(253);
  });

  it('parses without a leading dot and tolerates surrounding whitespace', () => {
    expect(enterpriseNumberFromSysObjectId('  1.3.6.1.4.1.641.2.1  ')).toBe(641);
  });

  it('accepts the bare enterprise arc itself', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.2435')).toBe(2435);
  });

  it('tolerates a trailing dot', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.9.1.516.')).toBe(9);
  });

  it('strips leading zeros rather than mismatching on them', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.0253.1')).toBe(253);
  });

  it.each([
    ['the enterprise arc with no PEN', '1.3.6.1.4.1'],
    ['a MIB-2 scalar', '1.3.6.1.2.1.1.1.0'],
    ['a non-numeric component', '1.3.6.1.4.1.abc.1'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a PEN beyond the safe integer range', '1.3.6.1.4.1.99999999999999999999.1'],
  ])('returns null for %s', (_label, oid) => {
    expect(enterpriseNumberFromSysObjectId(oid)).toBeNull();
  });

  it.each([null, undefined, 42 as unknown as string])('returns null for non-string input %s', (value) => {
    expect(enterpriseNumberFromSysObjectId(value as string | null | undefined)).toBeNull();
  });
});

describe('vendorFromSysObjectId', () => {
  it.each([
    ['.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', 'Xerox'],
    ['1.3.6.1.4.1.641.2.1.2.1.5.1', 'Lexmark'],
    ['1.3.6.1.4.1.2435.2.3.9.1', 'Brother'],
    ['1.3.6.1.4.1.11.2.3.9.1', 'HP'],
    ['1.3.6.1.4.1.9.1.516', 'Cisco'],
    ['1.3.6.1.4.1.318.1.3.27', 'APC'],
  ])('%s resolves to %s', (oid, vendor) => {
    expect(vendorFromSysObjectId(oid)).toBe(vendor);
  });

  it('is null for a PEN that is real but not in the table', () => {
    // 20682 = "Campusmart Ltd." — a genuine registration we deliberately do not carry.
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.20682.1')).toBe(20682);
    expect(vendorFromSysObjectId('1.3.6.1.4.1.20682.1')).toBeNull();
  });

  it('does not confuse the boundary neighbours 25 and 253', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.25.1')).toBe(25);
    expect(vendorFromSysObjectId('1.3.6.1.4.1.25.1')).toBeNull();
  });
});

describe('IANA_ENTERPRISE_VENDORS table integrity', () => {
  it('has only positive safe-integer keys and trimmed non-empty values', () => {
    for (const [key, value] of Object.entries(IANA_ENTERPRISE_VENDORS)) {
      const pen = Number(key);
      expect(Number.isSafeInteger(pen)).toBe(true);
      expect(pen).toBeGreaterThan(0);
      expect(value).toBe(value.trim());
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('carries every vendor the built-in template prefixes are seeded with', () => {
    // Mirrors the seed list in 2026-10-17-110300-…; a PEN dropped from one side
    // must be dropped from the other.
    for (const pen of [
      9, 11, 232, 253, 318, 367, 534, 641, 674, 1248, 1347, 1602, 2385, 2435, 2636,
      3808, 4526, 6574, 6876, 8072, 8741, 10642, 10876, 11863, 12356, 14823, 14988,
      15446, 18334, 19046, 24681, 25053, 29671, 41112, 47196, 50919, 53869, 55062,
    ]) {
      expect(IANA_ENTERPRISE_VENDORS[pen], `PEN ${pen}`).toBeTruthy();
    }
  });

  it('marks net-snmp as a generic agent PEN, not a hardware vendor', () => {
    expect(GENERIC_AGENT_ENTERPRISE_NUMBERS.has(8072)).toBe(true);
    expect(GENERIC_AGENT_ENTERPRISE_NUMBERS.has(253)).toBe(false);
  });
});
