import { describe, it, expect } from 'vitest';
import { buildVulnQuery, bulkSummary, remediateSummary } from './vulnerabilities';

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

  it('appends skip count and the reason label for a single distinct reason', () => {
    // reason is a VulnSkipReason CODE; the summary renders it via VULN_SKIP_REASON_LABELS.
    expect(
      bulkSummary('scheduled', 12, [
        { id: 'a', reason: 'no_available_patch' },
        { id: 'b', reason: 'no_available_patch' },
      ]),
    ).toBe('12 scheduled, 2 skipped — 2 no available patch');
  });

  it('summarizes DISTINCT reason codes with per-reason counts', () => {
    const summary = bulkSummary('accepted', 20, [
      { id: 'a', reason: 'not_found' },
      { id: 'b', reason: 'not_found' },
      { id: 'c', reason: 'site_access_denied' },
    ]);
    expect(summary).toContain('2 finding not found');
    expect(summary).toContain('1 site access denied');
    // Full form: succeeded verb, total skipped, then the distinct-reason breakdown.
    expect(summary).toBe('20 accepted, 3 skipped — 2 finding not found, 1 site access denied');
  });
});

describe('remediateSummary (#9533)', () => {
  it('counts installs, not findings — several CVEs on a device share one install', () => {
    expect(
      remediateSummary({ scheduled: 3, installs: 1, alreadyQueued: [], skipped: [{ id: 'd', reason: 'no_available_patch' }] }),
    ).toBe('Scheduled 1 install covering 3 findings; 1 skipped — 1 no available patch');
  });

  it('pluralizes and names findings that rode an install already queued', () => {
    expect(remediateSummary({ scheduled: 4, installs: 2, alreadyQueued: ['a', 'b'], skipped: [] })).toBe(
      'Scheduled 2 installs covering 4 findings (2 already queued)',
    );
  });

  it('says nothing was scheduled instead of "0 installs covering 0 findings"', () => {
    expect(
      remediateSummary({ scheduled: 0, installs: 0, alreadyQueued: [], skipped: [{ id: 'a', reason: 'no_available_patch' }] }),
    ).toBe('Nothing scheduled; 1 skipped — 1 no available patch');
  });
});
