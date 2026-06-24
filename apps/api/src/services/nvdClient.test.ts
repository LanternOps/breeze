import { describe, expect, it } from 'vitest';
import { parseNvd } from './nvdClient';
import sample from './__fixtures__/nvd-sample.json';

describe('parseNvd', () => {
  it('extracts CVE, CVSS, and CPE version ranges', () => {
    const recs = parseNvd(sample);
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
    const chrome = parseNvd(sample).find((record) => record.cveId === 'CVE-2024-0519');
    expect(chrome).toBeDefined();
    if (!chrome) throw new Error('Expected Chrome CVE fixture record');
    const cpePrefix = chrome.cpeMatches[0]?.cpePrefix;

    expect(cpePrefix).toBe('cpe:2.3:a:google:chrome');
    expect(cpePrefix?.split(':')).toHaveLength(5);
  });

  it('skips cpeMatch entries with vulnerable=false', () => {
    const recs = parseNvd(sample);
    const prefixes = recs.flatMap((record) => record.cpeMatches.map((match) => match.cpePrefix));

    expect(prefixes).toContain('cpe:2.3:a:google:chrome');
    expect(prefixes).toContain('cpe:2.3:a:obscurevendor:obscureproduct');
    expect(prefixes).not.toContain('cpe:2.3:o:fedoraproject:fedora');
  });
});
