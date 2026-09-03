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

  it("renders the API's literal 'unknown' with Unknown casing", () => {
    // inferPatchOs returns the literal string 'unknown' when it can't resolve
    // an OS — it must not leak through lowercase.
    expect(normalizePatch({ id: 'p1', title: 'KB1', os: 'unknown' }, 0).os).toBe('Unknown');
  });
});

// #3758: normalizeSeverity must not silently coerce a missing/unrecognized
// severity to 'low' — that actively mislabels unrated patches instead of
// just failing to label them.
describe('normalizePatch severity (#3758)', () => {
  it('maps a null severity to "unrated", not "low"', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB123', severity: null }, 0);
    expect(patch.severity).toBe('unrated');
  });

  it('maps a missing severity field to "unrated"', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB123' }, 0);
    expect(patch.severity).toBe('unrated');
  });

  it('maps the literal "unknown" severity to "unrated"', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB123', severity: 'unknown' }, 0);
    expect(patch.severity).toBe('unrated');
  });

  it('still maps recognized severities correctly', () => {
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'critical' }, 0).severity).toBe('critical');
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'high' }, 0).severity).toBe('important');
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'medium' }, 0).severity).toBe('moderate');
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'low' }, 0).severity).toBe('low');
  });
});

// #1317: normalizeRing must coerce the ring's stored autoApprove JSONB into the
// typed editor shape, tolerant of legacy values the API may still return.
describe('normalizeRing — autoApprove normalization (#1317)', () => {
  it('defaults a missing autoApprove to disabled', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Default' });
    expect(ring.autoApprove).toEqual({
      enabled: false,
      severities: [],
      deferralDays: 0,
      thirdPartyApps: false,
      thirdPartyDeferralDays: null,
    });
  });

  it('coerces a legacy {} autoApprove to disabled', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Default', autoApprove: {} });
    expect(ring.autoApprove).toEqual({
      enabled: false,
      severities: [],
      deferralDays: 0,
      thirdPartyApps: false,
      thirdPartyDeferralDays: null,
    });
  });

  it('coerces a legacy boolean true to enabled with no severity filter', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Default', autoApprove: true });
    expect(ring.autoApprove).toEqual({
      enabled: true,
      severities: [],
      deferralDays: 0,
      thirdPartyApps: false,
      thirdPartyDeferralDays: null,
    });
  });

  it('passes through a typed autoApprove gate and drops unknown severities', () => {
    const ring = normalizeRing({
      id: 'r1',
      name: 'Broad',
      autoApprove: {
        enabled: true,
        severities: ['critical', 'bogus', 'low'],
        deferralDays: 5,
        thirdPartyApps: false,
        thirdPartyDeferralDays: null,
      },
    });
    expect(ring.autoApprove).toEqual({
      enabled: true,
      severities: ['critical', 'low'],
      deferralDays: 5,
      thirdPartyApps: false,
      thirdPartyDeferralDays: null,
    });
  });

  it('treats a present-but-invalid deferralDays as disabled (mirrors the API fail-closed parse)', () => {
    // The evaluator disables such a row entirely; showing it as an enabled
    // 0-day hold would let a save silently resurrect config the API refused.
    expect(
      normalizeRing({ id: 'r1', name: 'x', autoApprove: { enabled: true, severities: ['low'], deferralDays: -3, thirdPartyApps: false } })
        .autoApprove
    ).toEqual({ enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null });
    expect(
      normalizeRing({ id: 'r1', name: 'x', autoApprove: { enabled: true, severities: ['low'], deferralDays: 1.5, thirdPartyApps: false } })
        .autoApprove
    ).toEqual({ enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null });
    // Absent stays fine (0 = no hold).
    expect(
      normalizeRing({ id: 'r1', name: 'x', autoApprove: { enabled: true, severities: ['low'], thirdPartyApps: false } })
        .autoApprove
    ).toMatchObject({ enabled: true, severities: ['low'], deferralDays: 0 });
  });

  it('preserves parked severities on a well-formed DISABLED row (editor divergence from the evaluator)', () => {
    expect(
      normalizeRing({ id: 'r1', name: 'x', autoApprove: { enabled: false, severities: ['critical'], deferralDays: 3 } })
        .autoApprove
    ).toMatchObject({ enabled: false, severities: ['critical'], deferralDays: 3 });
  });

  // The editor round-trips this object straight back into the ring PATCH body,
  // so a dropped field is a silently reverted policy (#spec 2026-08-04).
  it('round-trips an explicit third-party gate in both states', () => {
    expect(
      normalizeRing({
        id: 'r1',
        name: 'Apps',
        autoApprove: {
          enabled: true,
          severities: [],
          deferralDays: 0,
          thirdPartyApps: true,
          thirdPartyDeferralDays: 3,
        },
      }).autoApprove
    ).toEqual({
      enabled: true,
      severities: [],
      deferralDays: 0,
      thirdPartyApps: true,
      thirdPartyDeferralDays: 3,
    });

    expect(
      normalizeRing({
        id: 'r1',
        name: 'OS only',
        autoApprove: {
          enabled: true,
          severities: ['critical'],
          deferralDays: 2,
          thirdPartyApps: false,
          thirdPartyDeferralDays: 0,
        },
      }).autoApprove
    ).toEqual({
      enabled: true,
      severities: ['critical'],
      deferralDays: 2,
      thirdPartyApps: false,
      thirdPartyDeferralDays: 0,
    });
  });

  // Mirrors parseRingAutoApprove: a pre-gate ring auto-approved third-party
  // updates whenever it auto-approved anything, so an absent key derives from
  // the (filtered) severity list rather than defaulting to off.
  it('derives thirdPartyApps from severities when the key is absent (legacy rows)', () => {
    expect(
      normalizeRing({
        id: 'r1',
        name: 'Legacy on',
        autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      }).autoApprove
    ).toMatchObject({ thirdPartyApps: true, thirdPartyDeferralDays: null });

    expect(
      normalizeRing({
        id: 'r1',
        name: 'Legacy off',
        autoApprove: { enabled: true, severities: [], deferralDays: 0 },
      }).autoApprove
    ).toMatchObject({ thirdPartyApps: false });

    // Only recognized severities count — an all-bogus list derives off.
    expect(
      normalizeRing({
        id: 'r1',
        name: 'Legacy bogus',
        autoApprove: { enabled: true, severities: ['bogus'], deferralDays: 0 },
      }).autoApprove
    ).toMatchObject({ thirdPartyApps: false });
  });

  it('coerces a non-boolean thirdPartyApps to false, but a present-but-invalid hold disables the row', () => {
    // A non-boolean thirdPartyApps is present-but-invalid → false (never derived).
    expect(
      normalizeRing({
        id: 'r1',
        name: 'x',
        autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: 'yes' },
      }).autoApprove
    ).toMatchObject({ thirdPartyApps: false });

    // Present-but-invalid holds disable the row (mirrors the API fail-closed
    // parse — coercing to "inherit" would show a valid-looking editor state
    // for config the evaluator refuses). Explicit null stays inherit.
    for (const bad of [-1, 366, 1.5, '3']) {
      expect(
        normalizeRing({
          id: 'r1',
          name: 'x',
          autoApprove: {
            enabled: true,
            severities: [],
            deferralDays: 0,
            thirdPartyApps: true,
            thirdPartyDeferralDays: bad,
          },
        }).autoApprove
      ).toEqual({ enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null });
    }
    expect(
      normalizeRing({
        id: 'r1',
        name: 'x',
        autoApprove: { enabled: true, severities: [], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: null },
      }).autoApprove
    ).toEqual({ enabled: true, severities: [], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: null });
  });
});
