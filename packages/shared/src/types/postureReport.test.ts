import { describe, expect, it } from 'vitest';
import { POSTURE_DEVICE_ROW_CSV_LABELS } from './postureReport';

// #9964: the portal posture CSV header row is customer-facing.
describe('POSTURE_DEVICE_ROW_CSV_LABELS', () => {
  it('labels every column with readable text, never the raw camelCase key', () => {
    for (const [key, label] of Object.entries(POSTURE_DEVICE_ROW_CSV_LABELS)) {
      expect(label).not.toBe(key);
      expect(label).not.toMatch(/[a-z][A-Z]/);
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('uses distinct labels so patch and vulnerability counts cannot be confused', () => {
    const labels = Object.values(POSTURE_DEVICE_ROW_CSV_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(POSTURE_DEVICE_ROW_CSV_LABELS.criticalPatches).toBe('Critical patches');
    expect(POSTURE_DEVICE_ROW_CSV_LABELS.openVulnCritical).toBe('Critical vulnerabilities');
  });
});
