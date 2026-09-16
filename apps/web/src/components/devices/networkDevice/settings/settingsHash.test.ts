import { describe, expect, it } from 'vitest';

import { buildDetailHash, parseDetailHash, SETTINGS_SECTIONS } from './settingsHash';

describe('parseDetailHash', () => {
  it.each([
    ['', { tab: 'overview', settings: null }],
    ['#', { tab: 'overview', settings: null }],
    ['overview', { tab: 'overview', settings: null }],
    ['#monitoring', { tab: 'monitoring', settings: null }],
    ['#overview/settings/identity', { tab: 'overview', settings: 'identity' }],
    ['#overview/settings/monitoring', { tab: 'overview', settings: 'monitoring' }],
    ['#monitoring/settings/link', { tab: 'monitoring', settings: 'link' }],
    ['#overview/settings/danger', { tab: 'overview', settings: 'danger' }],
    // Truncated or stale deep links still open the modal, on Identity.
    ['#overview/settings', { tab: 'overview', settings: 'identity' }],
    ['#overview/settings/bogus', { tab: 'overview', settings: 'identity' }],
    // Unknown tab falls back to overview, exactly as the pre-W04 parser did.
    ['#bogus', { tab: 'overview', settings: null }],
    ['#bogus/settings/link', { tab: 'overview', settings: 'link' }],
    // A non-"settings" second segment is not a settings hash.
    ['#monitoring/proxy', { tab: 'monitoring', settings: null }],
  ])('parses %s', (hash, expected) => {
    expect(parseDetailHash(hash)).toEqual(expected);
  });
});

describe('buildDetailHash', () => {
  it('emits the bare tab when no section is given', () => {
    expect(buildDetailHash('overview')).toBe('overview');
    expect(buildDetailHash('monitoring', null)).toBe('monitoring');
  });

  it('emits <tab>/settings/<section> with no leading #', () => {
    expect(buildDetailHash('overview', 'monitoring')).toBe('overview/settings/monitoring');
    expect(buildDetailHash('monitoring', 'danger')).toBe('monitoring/settings/danger');
  });

  it('round-trips every section', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseDetailHash(`#${buildDetailHash('overview', section)}`)).toEqual({
        tab: 'overview',
        settings: section,
      });
    }
  });
});
