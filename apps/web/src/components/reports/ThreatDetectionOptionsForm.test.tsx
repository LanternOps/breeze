import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THREAT_DETECTION_OPTIONS,
  threatDetectionOptionsFromConfig,
} from './ThreatDetectionOptionsForm';

// `threatDetectionOptionsFromConfig` reads a persisted report `config` back
// into option state for the edit page. It must never seed the number input
// with a value the server's threatDetectionConfigSchema would reject (min 1,
// max 1000, integer), and must treat the toggle as "on unless explicitly
// false" so a legacy non-boolean value does not silently revert the setting.
describe('threatDetectionOptionsFromConfig', () => {
  it('clamps a stored 0 up to the minimum of 1', () => {
    expect(threatDetectionOptionsFromConfig({ topIncidents: 0 }).topIncidents).toBe(1);
  });

  it('clamps a stored 1001 down to the maximum of 1000', () => {
    expect(threatDetectionOptionsFromConfig({ topIncidents: 1001 }).topIncidents).toBe(1000);
  });

  it('rounds a fractional value rather than handing the input a non-integer', () => {
    expect(threatDetectionOptionsFromConfig({ topIncidents: 42.6 }).topIncidents).toBe(43);
  });

  it('falls back to the default for a non-number value like the string "50"', () => {
    expect(threatDetectionOptionsFromConfig({ topIncidents: '50' }).topIncidents)
      .toBe(DEFAULT_THREAT_DETECTION_OPTIONS.topIncidents);
  });

  it('falls back to the default for NaN', () => {
    expect(threatDetectionOptionsFromConfig({ topIncidents: NaN }).topIncidents)
      .toBe(DEFAULT_THREAT_DETECTION_OPTIONS.topIncidents);
  });

  it('falls back to the defaults when the keys are absent entirely', () => {
    expect(threatDetectionOptionsFromConfig({})).toEqual(DEFAULT_THREAT_DETECTION_OPTIONS);
  });

  it('treats includeCarriedIn as on unless === false', () => {
    expect(threatDetectionOptionsFromConfig({ includeCarriedIn: false }).includeCarriedIn).toBe(false);
    expect(threatDetectionOptionsFromConfig({ includeCarriedIn: true }).includeCarriedIn).toBe(true);
    expect(threatDetectionOptionsFromConfig({}).includeCarriedIn).toBe(true);
    // A non-boolean legacy value is not `=== false`, so it reads as on.
    expect(threatDetectionOptionsFromConfig({ includeCarriedIn: 0 }).includeCarriedIn).toBe(true);
  });

  it('round-trips a saved config unchanged', () => {
    const saved = { includeCarriedIn: false, topIncidents: 25 };
    expect(threatDetectionOptionsFromConfig(saved)).toEqual(saved);
  });
});
