import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCvrf } from './msrcClient';
import sample from './__fixtures__/msrc-sample.json';

describe('parseCvrf', () => {
  it('emits one record per affected product with a FixedBuild', () => {
    const records = parseCvrf(sample);

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.cveId).toMatch(/^CVE-\d{4}-\d+$/);
      expect(record.fixedBuild).toBeTruthy();
      expect(record.productName).toBeTruthy();
      expect(
        typeof record.cvssScore === 'number' || record.cvssScore === null
      ).toBe(true);
    }
  });

  it('derives a CVSS-bucket severity when score present', () => {
    const record = parseCvrf(sample).find((item) => item.cvssScore != null);

    if (record) {
      expect(['Critical', 'High', 'Medium', 'Low']).toContain(record.severity);
    }
  });

  describe('malformed CVE ids (#2261)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const malformedCveId = 'CVE-2023-38039 mariner - do not use this one';
    const doc = {
      ProductTree: {
        FullProductName: [
          { ProductID: '1', CPE: 'cpe:2.3:o:microsoft:cbl-mariner:*:*:*:*:*:*:*:*', Value: 'CBL Mariner 2.0 x64' },
        ],
      },
      Vulnerability: [
        {
          // The literal malformed record Microsoft ships in the CBL-Mariner
          // CVRF feed — 44 chars, longer than vulnerabilities.cve_id varchar(32).
          CVE: malformedCveId,
          Remediations: [{ Type: 2, FixedBuild: '2.0.20230801', ProductID: ['1'] }],
        },
        {
          CVE: 'CVE-2023-38040',
          Remediations: [{ Type: 2, FixedBuild: '2.0.20230801', ProductID: ['1'] }],
        },
      ],
    };

    it('drops the malformed record and keeps valid siblings', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const records = parseCvrf(doc);

      expect(records).toHaveLength(1);
      expect(records[0]?.cveId).toBe('CVE-2023-38040');
    });

    it('warns once with the offending id', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      parseCvrf(doc);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(malformedCveId);
    });
  });
});
