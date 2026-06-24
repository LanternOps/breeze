import { describe, expect, it } from 'vitest';
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
});
