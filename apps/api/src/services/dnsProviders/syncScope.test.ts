import { describe, expect, it } from 'vitest';
import {
  allowedTrafficCoverage,
  applyAllowedTrafficCoverage,
  isStoredDnsAction,
  storesAllowedTraffic
} from './syncScope';

// #10054 — DNS sync stores blocked + redirected events by default; allowed
// traffic is an explicit per-integration opt-in (`config.storeAllowedTraffic`).
describe('DNS sync scope (#10054)', () => {
  describe('storesAllowedTraffic', () => {
    it.each([
      [undefined, false],
      [null, false],
      [{}, false],
      [{ storeAllowedTraffic: false }, false],
      // Only an explicit boolean true opts in; a truthy non-boolean never does.
      [{ storeAllowedTraffic: 'true' as unknown as boolean }, false],
      [{ storeAllowedTraffic: true }, true]
    ])('config %j → %s', (config, expected) => {
      expect(storesAllowedTraffic(config)).toBe(expected);
    });
  });

  describe('isStoredDnsAction', () => {
    it('stores blocked and redirected by default and drops allowed', () => {
      expect(isStoredDnsAction('blocked', {})).toBe(true);
      expect(isStoredDnsAction('redirected', {})).toBe(true);
      expect(isStoredDnsAction('allowed', {})).toBe(false);
    });

    it('stores allowed when the integration opted in', () => {
      expect(isStoredDnsAction('allowed', { storeAllowedTraffic: true })).toBe(true);
    });
  });

  describe('allowedTrafficCoverage', () => {
    it('is none with no integrations, or when no integration stores allowed', () => {
      expect(allowedTrafficCoverage([])).toBe('none');
      expect(allowedTrafficCoverage([{}, { storeAllowedTraffic: false }])).toBe('none');
    });

    it('is all when every integration stores allowed', () => {
      expect(allowedTrafficCoverage([{ storeAllowedTraffic: true }, { storeAllowedTraffic: true }])).toBe('all');
    });

    it('is some when only part of the integrations store allowed', () => {
      expect(allowedTrafficCoverage([{ storeAllowedTraffic: true }, {}])).toBe('some');
    });
  });

  describe('applyAllowedTrafficCoverage', () => {
    const summary = { totalQueries: 120, blockedQueries: 100, allowedQueries: 0, redirectedQueries: 20, blockedRate: 83.33 };

    it('replaces the allowed count and the blocked rate with null when no integration stores allowed', () => {
      expect(applyAllowedTrafficCoverage(summary, 'none', undefined)).toEqual({
        ...summary,
        allowedQueries: null,
        blockedRate: null
      });
    });

    it('also nulls the total of an allowed-only view when allowed traffic is not stored', () => {
      expect(applyAllowedTrafficCoverage(
        { totalQueries: 0, blockedQueries: 0, allowedQueries: 0, redirectedQueries: 0, blockedRate: 0 },
        'none',
        'allowed'
      )).toEqual({ totalQueries: null, blockedQueries: 0, allowedQueries: null, redirectedQueries: 0, blockedRate: null });
    });

    it('leaves a blocked-only or redirected-only view alone (allowed is excluded by the filter anyway)', () => {
      expect(applyAllowedTrafficCoverage(summary, 'none', 'blocked')).toEqual(summary);
      expect(applyAllowedTrafficCoverage(summary, 'none', 'redirected')).toEqual(summary);
    });

    it('keeps the numbers when some or all integrations store allowed', () => {
      expect(applyAllowedTrafficCoverage(summary, 'some', undefined)).toEqual(summary);
      expect(applyAllowedTrafficCoverage(summary, 'all', undefined)).toEqual(summary);
    });
  });
});
