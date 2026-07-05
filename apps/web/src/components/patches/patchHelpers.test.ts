import { describe, expect, it } from 'vitest';

import { normalizePatch, normalizeRing } from './patchHelpers';

// #2215: rows from endpoints that omit the derived scalar `os` (historically
// the ring-scoped patches endpoint) must fall back to the raw osTypes[] array
// instead of rendering every row as "Unknown".
describe('normalizePatch — os resolution (#2215)', () => {
  it('prefers the scalar os field when present', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB1', os: 'windows', osTypes: ['linux'] }, 0);
    expect(patch.os).toBe('Windows');
  });

  it('falls back to osTypes[0] when no scalar os field is present', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB1', osTypes: ['macos'] }, 0);
    expect(patch.os).toBe('macOS');
  });

  it('falls back to snake_case os_types[0] as well', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB1', os_types: ['linux'] }, 0);
    expect(patch.os).toBe('Linux');
  });

  it('renders Unknown when osTypes is empty and no scalar os exists', () => {
    expect(normalizePatch({ id: 'p1', title: 'KB1', osTypes: [] }, 0).os).toBe('Unknown');
    expect(normalizePatch({ id: 'p1', title: 'KB1' }, 0).os).toBe('Unknown');
  });
});

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
