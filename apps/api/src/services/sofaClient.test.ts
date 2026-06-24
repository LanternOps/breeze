import { describe, expect, it } from 'vitest';
import { parseSofa } from './sofaClient';
import sample from './__fixtures__/sofa-sample.json';

describe('parseSofa', () => {
  it('maps macOS lines and fixed versions to CVEs', () => {
    const records = parseSofa(sample);

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
});
