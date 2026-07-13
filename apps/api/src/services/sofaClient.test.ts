import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSofa } from './sofaClient';
import sample from './__fixtures__/sofa-sample.json';

describe('parseSofa', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps macOS lines and fixed versions to CVEs', () => {
    const { records } = parseSofa(sample);

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.osLine).toBeTruthy();
      expect(record.fixedVersion).toBeTruthy();
      expect(record.cveId).toMatch(/^CVE-/);
      expect(typeof record.activelyExploited).toBe('boolean');
    }

    expect(records).toContainEqual(expect.objectContaining({
      osLine: 'Tahoe 26',
      fixedVersion: '26.5',
      cveId: 'CVE-2026-1837',
      activelyExploited: true,
    }));
  });

  it('drops records with malformed CVE ids and keeps valid siblings (#2261)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformedCveId = 'CVE-2023-38039 mariner - do not use this one';
    const doc = {
      OSVersions: [
        {
          OSVersion: 'Tahoe 26',
          SecurityReleases: [
            {
              ProductVersion: '26.5',
              CVEs: {
                [malformedCveId]: true,
                'CVE-2026-1837': true,
              },
              ActivelyExploitedCVEs: ['CVE-2026-1837'],
            },
          ],
        },
      ],
    };

    const { records, skippedCveIds } = parseSofa(doc);

    expect(records).toHaveLength(1);
    expect(records[0]?.cveId).toBe('CVE-2026-1837');
    expect(skippedCveIds).toEqual(new Set([malformedCveId]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(malformedCveId);
  });

  it('throws when EVERY CVE id is malformed (probable feed format change)', () => {
    const doc = {
      OSVersions: [
        {
          OSVersion: 'Tahoe 26',
          SecurityReleases: [
            {
              ProductVersion: '26.5',
              CVEs: { 'CVE-2023-38039 mariner - do not use this one': true },
            },
          ],
        },
      ],
    };

    expect(() => parseSofa(doc)).toThrow(/probable upstream feed format change/);
  });
});
