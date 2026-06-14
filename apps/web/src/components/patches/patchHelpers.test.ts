import { describe, expect, it } from 'vitest';

import { normalizeRing } from './patchHelpers';

// #1317: normalizeRing must coerce the ring's stored autoApprove JSONB into the
// typed editor shape, tolerant of legacy values the API may still return.
describe('normalizeRing — autoApprove normalization (#1317)', () => {
  it('defaults a missing autoApprove to disabled', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Default' });
    expect(ring.autoApprove).toEqual({ enabled: false, severities: [], deferralDays: 0 });
  });

  it('coerces a legacy {} autoApprove to disabled', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Default', autoApprove: {} });
    expect(ring.autoApprove).toEqual({ enabled: false, severities: [], deferralDays: 0 });
  });

  it('coerces a legacy boolean true to enabled with no severity filter', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Default', autoApprove: true });
    expect(ring.autoApprove).toEqual({ enabled: true, severities: [], deferralDays: 0 });
  });

  it('passes through a typed autoApprove gate and drops unknown severities', () => {
    const ring = normalizeRing({
      id: 'r1',
      name: 'Broad',
      autoApprove: { enabled: true, severities: ['critical', 'bogus', 'low'], deferralDays: 5 },
    });
    expect(ring.autoApprove).toEqual({ enabled: true, severities: ['critical', 'low'], deferralDays: 5 });
  });

  it('clamps a non-positive or non-integer deferralDays to 0', () => {
    expect(
      normalizeRing({ id: 'r1', name: 'x', autoApprove: { enabled: true, severities: ['low'], deferralDays: -3 } })
        .autoApprove
    ).toEqual({ enabled: true, severities: ['low'], deferralDays: 0 });
    expect(
      normalizeRing({ id: 'r1', name: 'x', autoApprove: { enabled: true, severities: ['low'], deferralDays: 1.5 } })
        .autoApprove
    ).toEqual({ enabled: true, severities: ['low'], deferralDays: 0 });
  });
});
