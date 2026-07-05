import { describe, it, expect } from 'vitest';
import { buildVulnQuery, bulkSummary } from './vulnerabilities';

describe('buildVulnQuery', () => {
  it('serializes set params, drops empty/false/undefined, and URL-encodes', () => {
    expect(
      buildVulnQuery({ status: 'open', severity: '', search: 'google chrome', kevOnly: true, patchAvailable: false }),
    ).toBe('?status=open&search=google+chrome&kevOnly=true');
  });

  it('returns empty string when nothing is set', () => {
    expect(buildVulnQuery({ severity: undefined, kevOnly: false })).toBe('');
  });

  it('serializes numeric params (expiringWithinDays)', () => {
    expect(buildVulnQuery({ status: 'accepted', expiringWithinDays: 14 })).toBe('?status=accepted&expiringWithinDays=14');
    expect(buildVulnQuery({ expiringWithinDays: undefined })).toBe('');
  });
});

describe('bulkSummary', () => {
  it('reports plain success', () => {
    expect(bulkSummary('accepted', 12, [])).toBe('12 accepted');
  });

  it('appends skip count and first skip reason (partial success)', () => {
    expect(
      bulkSummary('scheduled', 12, [
        { id: 'a', reason: 'no approved patch' },
        { id: 'b', reason: 'no approved patch' },
      ]),
    ).toBe('12 scheduled, 2 skipped — no approved patch');
  });
});
