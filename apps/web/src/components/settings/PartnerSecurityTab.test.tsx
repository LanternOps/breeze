import { describe, it, expect } from 'vitest';
import { parseAllowlistInput, currentIpCovered } from './PartnerSecurityTab';

describe('parseAllowlistInput', () => {
  it('splits lines, trims, and drops blanks', () => {
    expect(parseAllowlistInput('203.0.113.0/24\n  \n10.0.0.1')).toEqual(['203.0.113.0/24', '10.0.0.1']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseAllowlistInput('')).toEqual([]);
    expect(parseAllowlistInput('\n  \n')).toEqual([]);
  });
});

describe('currentIpCovered', () => {
  it('is true when the current IP is inside a listed range', () => {
    expect(currentIpCovered('203.0.113.10', ['203.0.113.0/24'])).toBe(true);
  });

  it('is true on an exact match', () => {
    expect(currentIpCovered('10.0.0.1', ['10.0.0.1'])).toBe(true);
  });

  it('is false when not covered', () => {
    expect(currentIpCovered('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
  });

  it('is true (no false lockout warning) when current IP is unknown', () => {
    expect(currentIpCovered(null, ['203.0.113.0/24'])).toBe(true);
  });
});
