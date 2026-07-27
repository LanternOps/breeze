import { describe, it, expect } from 'vitest';
import {
  resolveEnrollmentDefaults,
  enrollmentDefaultsSchema,
  enrollmentTtlOptionsWithinCap,
  enrollmentTtlOptionsIncluding,
  clampTtlToOfferableOption,
  ENROLLMENT_TTL_OPTIONS,
  MAX_ENROLLMENT_TTL_MINUTES,
} from './enrollmentDefaults.js';

describe('resolveEnrollmentDefaults', () => {
  it('inherits the partner value when the org has not set one', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentTtlMinutes: 10080 },
      {},
    );
    expect(r.ttlMinutes).toBe(10080);
  });

  it('lets an org OVERRIDE the partner value (inherit-with-override)', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentTtlMinutes: 10080 },
      { defaultEnrollmentTtlMinutes: 60 },
    );
    expect(r.ttlMinutes).toBe(60);
  });

  it('keys on presence, not truthiness', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentDeviceCount: 25 },
      { defaultEnrollmentDeviceCount: 0 },
    );
    // 0 is invalid and must be rejected by the schema, but the resolver
    // itself must not silently fall back to the partner value on a falsy 0
    expect(r.deviceCount).toBe(0);
  });

  it('takes the cap from the PARTNER only — an org cannot raise it', () => {
    const r = resolveEnrollmentDefaults(
      { maxEnrollmentLinkTtlMinutes: 1440 },
      { maxEnrollmentLinkTtlMinutes: 525600 },
    );
    expect(r.maxTtlMinutes).toBe(1440);
  });

  it('falls back to product defaults when neither level sets anything', () => {
    const r = resolveEnrollmentDefaults({}, {});
    expect(r.ttlMinutes).toBe(1440);
    expect(r.deviceCount).toBe(1);
    expect(r.maxTtlMinutes).toBe(525600);
  });

  // #2776 follow-up: the org's defaultEnrollmentTtlMinutes is lock-exempt and
  // validated only against the global MAX_ENROLLMENT_TTL_MINUTES, not the
  // partner cap, so a resolved default can land above maxTtlMinutes. That's
  // not a value anyone chose for a specific mint request — it's a stale
  // default — so the resolver clamps it rather than rejecting.
  it('clamps a resolved org default above the partner cap', () => {
    const r = resolveEnrollmentDefaults(
      { maxEnrollmentLinkTtlMinutes: 1440 },
      { defaultEnrollmentTtlMinutes: 43200 },
    );
    expect(r.ttlMinutes).toBe(1440);
    expect(r.maxTtlMinutes).toBe(1440);
  });

  it('clamps a resolved partner default above the partner cap after it is lowered', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentTtlMinutes: 43200, maxEnrollmentLinkTtlMinutes: 1440 },
      {},
    );
    expect(r.ttlMinutes).toBe(1440);
  });

  it('does not clamp a resolved default that is already within the cap', () => {
    const r = resolveEnrollmentDefaults(
      { maxEnrollmentLinkTtlMinutes: 1440 },
      { defaultEnrollmentTtlMinutes: 60 },
    );
    expect(r.ttlMinutes).toBe(60);
  });

  it('allows a resolved default exactly at the cap (no off-by-one)', () => {
    const r = resolveEnrollmentDefaults(
      { maxEnrollmentLinkTtlMinutes: 1440 },
      { defaultEnrollmentTtlMinutes: 1440 },
    );
    expect(r.ttlMinutes).toBe(1440);
  });
});

describe('enrollmentDefaultsSchema', () => {
  it('rejects a TTL above the product maximum', () => {
    expect(enrollmentDefaultsSchema.safeParse({
      defaultEnrollmentTtlMinutes: 525601,
    }).success).toBe(false);
  });

  it('rejects a zero device count', () => {
    expect(enrollmentDefaultsSchema.safeParse({
      defaultEnrollmentDeviceCount: 0,
    }).success).toBe(false);
  });
});

describe('enrollmentTtlOptionsWithinCap', () => {
  it('drops every option above the cap', () => {
    expect(enrollmentTtlOptionsWithinCap(43200)).toEqual([60, 1440, 10080, 43200]);
  });

  it('returns the full set for the product maximum', () => {
    expect(enrollmentTtlOptionsWithinCap(MAX_ENROLLMENT_TTL_MINUTES)).toEqual([
      ...ENROLLMENT_TTL_OPTIONS,
    ]);
  });

  it('falls back to the cap itself rather than an empty picker', () => {
    // Only reachable via a direct API PATCH — the partner UI offers canonical
    // values only. An empty <select> would be worse than one odd label.
    expect(enrollmentTtlOptionsWithinCap(30)).toEqual([30]);
  });
});

describe('clampTtlToOfferableOption', () => {
  it('leaves a value at or below the cap alone', () => {
    expect(clampTtlToOfferableOption(10080, 43200)).toBe(10080);
    expect(clampTtlToOfferableOption(43200, 43200)).toBe(43200);
  });

  it('folds an over-cap value onto the largest offerable option', () => {
    expect(clampTtlToOfferableOption(525600, 43200)).toBe(43200);
  });

  it('never returns a value the picker cannot display as selected', () => {
    // Cap 20000 is not a canonical option: clamping to it would leave the
    // select showing nothing, so the largest option BELOW it wins.
    expect(clampTtlToOfferableOption(525600, 20000)).toBe(10080);
  });

  it('leaves a non-canonical UNDER-cap value alone rather than snapping it', () => {
    // Snapping would silently change a value nobody asked to change.
    // enrollmentTtlOptionsIncluding surfaces it as its own option instead.
    expect(clampTtlToOfferableOption(20000, 43200)).toBe(20000);
  });

  it('falls back to the cap when nothing canonical fits under it', () => {
    expect(clampTtlToOfferableOption(1440, 30)).toBe(30);
  });
});

describe('enrollmentTtlOptionsIncluding', () => {
  it('is a plain pass-through when the value is already canonical', () => {
    expect(enrollmentTtlOptionsIncluding(43200, 10080)).toEqual([60, 1440, 10080, 43200]);
  });

  it('is a plain pass-through when there is no current value', () => {
    expect(enrollmentTtlOptionsIncluding(43200)).toEqual([60, 1440, 10080, 43200]);
  });

  it('surfaces a stored OVER-cap value so the select can display what is stored', () => {
    // The settings editors must never rewrite this on save — resolveEnrollmentDefaults
    // clamps it at read time, which is where clamping belongs.
    expect(enrollmentTtlOptionsIncluding(1440, 525600)).toEqual([60, 1440, 525600]);
  });

  it('surfaces a non-canonical UNDER-cap value in sort order', () => {
    // Without this the <select> would match no option, display "1 hour", and
    // still submit 20000.
    expect(enrollmentTtlOptionsIncluding(43200, 20000)).toEqual([60, 1440, 10080, 20000, 43200]);
  });

  it('composes with the sub-canonical cap fallback', () => {
    expect(enrollmentTtlOptionsIncluding(30, 30)).toEqual([30]);
    expect(enrollmentTtlOptionsIncluding(30, 525600)).toEqual([30, 525600]);
  });
});
