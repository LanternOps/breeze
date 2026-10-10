import { describe, expect, it } from 'vitest';
import {
  BASELINE_FUTURE_SKEW_MS, isNoteRequired, readBaselineDetails, reliabilityBeforeSnapshotSchema, resolveBaselineAt,
} from './reliabilityBaselinePolicy';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const DAY = 86_400_000;

describe('resolveBaselineAt', () => {
  it('defaults to now', () => {
    expect(resolveBaselineAt(undefined, NOW)).toEqual({ ok: true, baselineAt: NOW });
  });
  it('accepts exactly 30 days back and rejects one ms more', () => {
    expect(resolveBaselineAt(new Date(NOW.getTime() - 30 * DAY), NOW)).toEqual({ ok: true, baselineAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(resolveBaselineAt(new Date(NOW.getTime() - 30 * DAY - 1), NOW)).toEqual({ ok: false, error: 'baseline_too_old' });
  });
  it('clamps small future skew to now and rejects beyond it', () => {
    expect(resolveBaselineAt(new Date(NOW.getTime() + BASELINE_FUTURE_SKEW_MS), NOW)).toEqual({ ok: true, baselineAt: NOW });
    expect(resolveBaselineAt(new Date(NOW.getTime() + BASELINE_FUTURE_SKEW_MS + 1), NOW)).toEqual({ ok: false, error: 'baseline_in_future' });
  });
});

describe('isNoteRequired', () => {
  it('only for manual remediated markers', () => {
    expect(isNoteRequired('remediated', 'manual')).toBe(true);
    expect(isNoteRequired('remediated', 'bare_metal_recovery')).toBe(false);
    expect(isNoteRequired('reimaged', 'manual')).toBe(false);
    expect(isNoteRequired('hardware_replaced', 'manual')).toBe(false);
  });
});

describe('readBaselineDetails', () => {
  it('parses a well-formed details.baseline block', () => {
    const parsed = readBaselineDetails({ baseline: {
      id: '7f4b1c9e-0000-4000-8000-000000000001', baselineAt: '2026-10-01T00:00:00.000Z', reason: 'remediated',
      source: 'manual', reportedDaysSinceBaseline: 4, provisional: true,
    } });
    expect(parsed).toEqual({
      id: '7f4b1c9e-0000-4000-8000-000000000001', baselineAt: '2026-10-01T00:00:00.000Z', reason: 'remediated',
      source: 'manual', reportedDaysSinceBaseline: 4, provisional: true,
    });
  });
  it('returns null for missing or malformed blocks', () => {
    expect(readBaselineDetails({})).toBeNull();
    expect(readBaselineDetails(null)).toBeNull();
    expect(readBaselineDetails({ baseline: { id: 'x', reason: 'bogus' } })).toBeNull();
  });
});

describe('reliabilityBeforeSnapshotSchema', () => {
  it('accepts the v1 shape', () => {
    expect(reliabilityBeforeSnapshotSchema.safeParse({
      version: 1, scorerVersion: '2026-10-09.1', asOf: '2026-10-01T00:00:00.000Z', coverageDays: 42,
      reliabilityScore: 41, weightProfile: 'workstation',
      factors: { uptime: { score: 100 }, crashes: { score: 20 }, hangs: { score: 90 }, serviceFailures: { score: 60 }, hardwareErrors: { score: 100 } },
      counts30d: { crashes: 6, hangs: 1, serviceFailures: 4, hardwareErrors: 0 },
    }).success).toBe(true);
  });
});
