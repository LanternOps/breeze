import { describe, expect, it } from 'vitest';
import { withStableViolationTimestamps } from './softwarePolicyService';
import type { SoftwarePolicyViolation } from '../db/schema';

/**
 * Contract D9 guard (feature #5505). W01 adds `catalogId` to the `rule` object
 * of an emitted `missing` violation. violationFingerprint keys on
 * type + rule.name + rule.minVersion + rule.maxVersion and NOTHING else, so
 * that addition must not change which stored violation a fresh one matches.
 *
 * Why this matters beyond tidiness: the install grace clock
 * (readEarliestViolationDetection(v, 'missing')) reads detectedAt off the
 * STABILISED violation. If catalogId ever joined the fingerprint, editing a
 * policy rule's catalogId would reset every device's install grace window and
 * restart the attempt budget — re-arming exactly the reinstall loop the
 * give-up counter exists to terminate.
 */
describe('withStableViolationTimestamps — catalogId is not part of the match key (D9)', () => {
  const STORED: SoftwarePolicyViolation[] = [{
    type: 'missing',
    rule: { name: 'Google Chrome', minVersion: '120.0' },
    severity: 'high',
    detectedAt: '2026-09-01T00:00:00.000Z',
  }];

  it('carries the stored detectedAt onto a fresh violation that now also has catalogId', () => {
    const next: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '120.0', catalogId: 'catalog-abc' },
      severity: 'high',
      detectedAt: '2026-09-10T12:00:00.000Z',
    }];

    const stabilized = withStableViolationTimestamps(next, STORED);

    expect(stabilized[0]?.detectedAt).toBe('2026-09-01T00:00:00.000Z');
    // and the field itself must survive — W03 resolves the install target from it
    expect(stabilized[0]?.rule?.catalogId).toBe('catalog-abc');
  });

  it('is symmetric: a stored violation WITH catalogId still matches a fresh one without', () => {
    const stored: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '120.0', catalogId: 'catalog-abc' },
      severity: 'high',
      detectedAt: '2026-09-01T00:00:00.000Z',
    }];
    const next: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '120.0' },
      severity: 'high',
      detectedAt: '2026-09-10T12:00:00.000Z',
    }];

    expect(withStableViolationTimestamps(next, stored)[0]?.detectedAt)
      .toBe('2026-09-01T00:00:00.000Z');
  });

  it('still separates violations that differ in a field the fingerprint DOES read', () => {
    const next: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '121.0', catalogId: 'catalog-abc' },
      severity: 'high',
      detectedAt: '2026-09-10T12:00:00.000Z',
    }];

    // minVersion changed, so this is a genuinely different requirement and must
    // start its own clock. Without this control the two cases above would pass
    // against a fingerprint that returned a constant.
    expect(withStableViolationTimestamps(next, STORED)[0]?.detectedAt)
      .toBe('2026-09-10T12:00:00.000Z');
  });
});
