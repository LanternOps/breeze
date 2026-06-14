import { describe, expect, it } from 'vitest';
import {
  canonicalizeTimezone,
  isValidIanaTimezone,
  normalizeTimezone,
  resolveEffectiveTimezone,
  UTC_TIMEZONE,
} from './timezone';

describe('isValidIanaTimezone', () => {
  it('accepts UTC, GMT, and Etc/* zones that Intl.supportedValuesOf omits', () => {
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('GMT')).toBe(true);
    expect(isValidIanaTimezone('Etc/UTC')).toBe(true);
    expect(isValidIanaTimezone('Etc/GMT+5')).toBe(true);
  });

  it('accepts canonical region zones', () => {
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('Europe/London')).toBe(true);
    expect(isValidIanaTimezone('Australia/Sydney')).toBe(true);
  });

  it('rejects unknown, empty, and non-string values', () => {
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(42)).toBe(false);
  });
});

describe('normalizeTimezone', () => {
  it('returns the value when valid', () => {
    expect(normalizeTimezone('America/Chicago')).toBe('America/Chicago');
  });

  it('falls back to UTC for invalid values', () => {
    expect(normalizeTimezone('garbage')).toBe('UTC');
    expect(normalizeTimezone('')).toBe('UTC');
    expect(normalizeTimezone(null)).toBe('UTC');
    expect(normalizeTimezone(undefined)).toBe('UTC');
  });

  it('honors a custom fallback when the primary is invalid', () => {
    expect(normalizeTimezone(null, 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('ignores an invalid custom fallback and uses UTC', () => {
    expect(normalizeTimezone(null, 'not-a-zone')).toBe('UTC');
  });
});

describe('canonicalizeTimezone', () => {
  it('folds every casing of the UTC sentinel to the canonical "UTC"', () => {
    expect(canonicalizeTimezone('utc')).toBe('UTC');
    expect(canonicalizeTimezone('Utc')).toBe('UTC');
    expect(canonicalizeTimezone('UTC')).toBe('UTC');
  });

  it('preserves canonical casing for region zones', () => {
    expect(canonicalizeTimezone('America/New_York')).toBe('America/New_York');
    expect(canonicalizeTimezone('Europe/London')).toBe('Europe/London');
  });

  it('returns null for invalid or non-string values', () => {
    expect(canonicalizeTimezone('garbage')).toBeNull();
    expect(canonicalizeTimezone('')).toBeNull();
    expect(canonicalizeTimezone(null)).toBeNull();
    expect(canonicalizeTimezone(undefined)).toBeNull();
    expect(canonicalizeTimezone(42)).toBeNull();
  });
});

describe('resolveEffectiveTimezone', () => {
  it('prefers an explicit value over every scope', () => {
    expect(
      resolveEffectiveTimezone({
        explicit: 'America/New_York',
        siteTz: 'America/Chicago',
        orgTz: 'America/Denver',
        partnerTz: 'America/Los_Angeles',
      }),
    ).toBe('America/New_York');
  });

  it('falls through explicit -> site -> org -> partner in order', () => {
    expect(
      resolveEffectiveTimezone({
        siteTz: 'America/Chicago',
        orgTz: 'America/Denver',
        partnerTz: 'America/Los_Angeles',
      }),
    ).toBe('America/Chicago');

    expect(
      resolveEffectiveTimezone({
        orgTz: 'America/Denver',
        partnerTz: 'America/Los_Angeles',
      }),
    ).toBe('America/Denver');

    expect(
      resolveEffectiveTimezone({
        partnerTz: 'America/Los_Angeles',
      }),
    ).toBe('America/Los_Angeles');
  });

  it('falls back to the partner tz when site and org are unset (issue #1318 core)', () => {
    expect(
      resolveEffectiveTimezone({
        explicit: null,
        siteTz: null,
        orgTz: null,
        partnerTz: 'Europe/London',
      }),
    ).toBe('Europe/London');
  });

  it('skips invalid candidates rather than short-circuiting to UTC', () => {
    expect(
      resolveEffectiveTimezone({
        explicit: 'garbage',
        siteTz: '',
        orgTz: 'also-bad',
        partnerTz: 'Asia/Tokyo',
      }),
    ).toBe('Asia/Tokyo');
  });

  it('returns UTC as the last resort when nothing resolves', () => {
    expect(resolveEffectiveTimezone({})).toBe(UTC_TIMEZONE);
    expect(
      resolveEffectiveTimezone({
        explicit: null,
        siteTz: undefined,
        orgTz: '',
        partnerTz: 'nope',
      }),
    ).toBe('UTC');
  });
});
