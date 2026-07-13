import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseNvd } from './nvdClient';
import sample from './__fixtures__/nvd-sample.json';

describe('parseNvd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts CVE, CVSS, and CPE version ranges', () => {
    const { records: recs } = parseNvd(sample);
    const chrome = recs.find((record) => record.cveId === 'CVE-2024-0519');

    expect(chrome).toBeDefined();
    if (!chrome) throw new Error('Expected Chrome CVE fixture record');
    const chromeMatch = chrome.cpeMatches[0];
    expect(chromeMatch).toBeDefined();
    if (!chromeMatch) throw new Error('Expected Chrome CPE match fixture record');

    expect(chrome.cvssVersion).toBe('3.1');
    expect(chrome.cvssScore).toBe(8.8);
    expect(chrome.cvssVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H');
    expect(chrome.severity).toBe('HIGH');
    expect(chrome.cpeMatches.length).toBeGreaterThan(0);
    expect(chromeMatch.cpePrefix).toMatch(/^cpe:2\.3:[aoh]:/);
    expect(chromeMatch.range).toEqual({
      startIncluding: null,
      startExcluding: null,
      endIncluding: null,
      endExcluding: '120.0.6099.224',
    });
  });

  it('reduces a CPE criteria to its vendor:product prefix', () => {
    const chrome = parseNvd(sample).records.find((record) => record.cveId === 'CVE-2024-0519');
    expect(chrome).toBeDefined();
    if (!chrome) throw new Error('Expected Chrome CVE fixture record');
    const cpePrefix = chrome.cpeMatches[0]?.cpePrefix;

    expect(cpePrefix).toBe('cpe:2.3:a:google:chrome');
    expect(cpePrefix?.split(':')).toHaveLength(5);
  });

  it('skips cpeMatch entries with vulnerable=false', () => {
    const { records: recs } = parseNvd(sample);
    const prefixes = recs.flatMap((record) => record.cpeMatches.map((match) => match.cpePrefix));

    expect(prefixes).toContain('cpe:2.3:a:google:chrome');
    expect(prefixes).toContain('cpe:2.3:a:obscurevendor:obscureproduct');
    expect(prefixes).not.toContain('cpe:2.3:o:fedoraproject:fedora');
  });

  it('drops records with malformed CVE ids and keeps valid siblings (#2261)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformedCveId = 'CVE-2023-38039 mariner - do not use this one';
    const doc = {
      vulnerabilities: [
        { cve: { id: malformedCveId } },
        { cve: { id: 'CVE-2024-11111' } },
      ],
    };

    const { records, skippedCveIds, skippedCount, entryCount } = parseNvd(doc);

    expect(records).toHaveLength(1);
    expect(records[0]?.cveId).toBe('CVE-2024-11111');
    expect(skippedCveIds).toEqual(new Set([malformedCveId]));
    expect(skippedCount).toBe(1);
    expect(entryCount).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(malformedCveId);
  });

  // #2427 regression guard. Upstream garbage is usually ONE bogus literal id
  // repeated across many entries. A distinct-id count reports that mass drop as
  // 1, the skip ratio computes as ~0, and the escalation never fires — the exact
  // blind spot this instrumentation exists to close.
  it('counts a REPEATED malformed id once per dropped entry, not once per distinct id', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformedCveId = 'CVE-2023-38039 mariner - do not use this one';
    const doc = {
      vulnerabilities: [
        ...Array.from({ length: 20 }, () => ({ cve: { id: malformedCveId } })),
        { cve: { id: 'CVE-2024-11111' } },
      ],
    };

    const { records, skippedCveIds, skippedCount, entryCount } = parseNvd(doc);

    expect(records).toHaveLength(1);
    expect(skippedCveIds.size).toBe(1); // one distinct id — fine for a log sample
    expect(skippedCount).toBe(20); // ...but TWENTY entries were actually dropped
    expect(entryCount).toBe(21);
  });

  it('counts entries dropped for a MISSING cve id (never reach the malformed set)', () => {
    const doc = {
      vulnerabilities: [
        { cve: {} }, // no id
        {}, // no cve object
        { cve: { id: 'CVE-2024-11111' } },
      ],
    };

    const { records, skippedCveIds, skippedCount, entryCount } = parseNvd(doc);

    expect(records).toHaveLength(1);
    expect(skippedCveIds.size).toBe(0);
    expect(skippedCount).toBe(2);
    expect(entryCount).toBe(3);
  });

  it('throws when EVERY CVE id is malformed (probable feed format change)', () => {
    const doc = {
      vulnerabilities: [{ cve: { id: 'CVE-2023-38039 mariner - do not use this one' } }],
    };

    expect(() => parseNvd(doc)).toThrow(/probable upstream feed format change/);
  });
});
