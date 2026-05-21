import { describe, it, expect } from 'vitest';
import { deriveSeverityFromScript, type ScriptExitCodeSeverityMapping } from './scriptSeverity';

describe('deriveSeverityFromScript', () => {
  describe('legacy behavior (null mapping)', () => {
    it('returns null for exit 0 with no mapping', () => {
      expect(deriveSeverityFromScript(0, null)).toBeNull();
      expect(deriveSeverityFromScript(0, undefined)).toBeNull();
    });

    it('returns medium for non-zero exit with no mapping', () => {
      expect(deriveSeverityFromScript(1, null)).toBe('medium');
      expect(deriveSeverityFromScript(2, null)).toBe('medium');
      expect(deriveSeverityFromScript(127, null)).toBe('medium');
      expect(deriveSeverityFromScript(255, undefined)).toBe('medium');
    });

    it('treats null/undefined exit code as 0', () => {
      expect(deriveSeverityFromScript(null, null)).toBeNull();
      expect(deriveSeverityFromScript(undefined, null)).toBeNull();
    });
  });

  describe('opt-in mapping', () => {
    const standardMapping: ScriptExitCodeSeverityMapping = {
      '0': null,
      '1': 'low',
      '2': 'medium',
      '3': 'high',
      '4': 'critical',
    };

    it('uses null severity for defined exit 0', () => {
      expect(deriveSeverityFromScript(0, standardMapping)).toBeNull();
    });

    it('maps each defined exit code to its severity', () => {
      expect(deriveSeverityFromScript(1, standardMapping)).toBe('low');
      expect(deriveSeverityFromScript(2, standardMapping)).toBe('medium');
      expect(deriveSeverityFromScript(3, standardMapping)).toBe('high');
      expect(deriveSeverityFromScript(4, standardMapping)).toBe('critical');
    });

    it('falls back to the highest-defined-lower severity for unmapped non-zero codes', () => {
      // exit 5 falls back to "4" -> 'critical'
      expect(deriveSeverityFromScript(5, standardMapping)).toBe('critical');
      // exit 99 also falls back to "4" -> 'critical'
      expect(deriveSeverityFromScript(99, standardMapping)).toBe('critical');
    });

    it('skips entries that map to null when falling back', () => {
      // Sparse mapping: only "0" -> null and "10" -> 'high'
      const sparseMapping: ScriptExitCodeSeverityMapping = {
        '0': null,
        '10': 'high',
      };
      // exit 5: no exact match. Lower defined codes: ["10","0"] filtered by < 5 -> ["0"]
      // mapping["0"] is null -> skip, fallback to 'critical'.
      expect(deriveSeverityFromScript(5, sparseMapping)).toBe('critical');
      // exit 15: lower defined codes < 15: ["10","0"]. mapping["10"]='high' -> 'high'.
      expect(deriveSeverityFromScript(15, sparseMapping)).toBe('high');
    });

    it('returns null for exit 0 when mapping is set but lacks key "0"', () => {
      const mapping: ScriptExitCodeSeverityMapping = {
        '1': 'low',
        '2': 'medium',
      };
      expect(deriveSeverityFromScript(0, mapping)).toBeNull();
    });

    it('returns critical fallback when no lower codes are defined', () => {
      const mapping: ScriptExitCodeSeverityMapping = {
        '10': 'high',
      };
      // exit 5: no defined codes below 5 -> fallback to 'critical'
      expect(deriveSeverityFromScript(5, mapping)).toBe('critical');
    });

    it('handles an empty mapping object as legacy-not-set (silent on 0, critical otherwise)', () => {
      const mapping: ScriptExitCodeSeverityMapping = {};
      expect(deriveSeverityFromScript(0, mapping)).toBeNull();
      // exit non-zero with empty mapping: no defined codes -> fallback 'critical'
      expect(deriveSeverityFromScript(1, mapping)).toBe('critical');
    });

    it('supports per-script overrides that silence certain exit codes', () => {
      // Tech wants exit 1 to be silent (e.g. "no work needed") but exit 2 to alert.
      const mapping: ScriptExitCodeSeverityMapping = {
        '0': null,
        '1': null,
        '2': 'high',
      };
      expect(deriveSeverityFromScript(1, mapping)).toBeNull();
      expect(deriveSeverityFromScript(2, mapping)).toBe('high');
    });
  });

  describe('edge cases', () => {
    it('handles NaN exit code as 0', () => {
      expect(deriveSeverityFromScript(NaN, null)).toBeNull();
    });

    it('handles Infinity exit code as 0', () => {
      expect(deriveSeverityFromScript(Infinity, null)).toBeNull();
    });
  });
});
