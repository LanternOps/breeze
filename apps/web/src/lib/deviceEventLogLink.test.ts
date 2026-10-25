import { describe, expect, it } from 'vitest';
import {
  reliabilityScoringWindow,
  deviceEventLogHash,
  deviceEventLogHref,
  eventLogFilterFromHash,
} from './deviceEventLogLink';

const from = '2026-09-24T00:00:00.000Z';
const to = '2026-10-24T12:30:00.000Z';

describe('deviceEventLogLink', () => {
  it('encodes a source selection and the window', () => {
    const hash = deviceEventLogHash({ source: 'Service Control Manager', from, to });
    expect(hash.startsWith('eventlog/Service%20Control%20Manager&')).toBe(true);
    expect(hash).toContain('from=2026-09-24T00%3A00%3A00.000Z');
    expect(hash).toContain('to=2026-10-24T12%3A30%3A00.000Z');
  });

  it('encodes a window-only link without a selection segment', () => {
    expect(deviceEventLogHash({ from, to }).startsWith('eventlog&from=')).toBe(true);
  });

  it('round-trips with and without a source', () => {
    expect(eventLogFilterFromHash(deviceEventLogHash({ source: 'WHEA-Logger', from, to }))).toEqual({
      source: 'WHEA-Logger',
      from,
      to,
    });
    expect(eventLogFilterFromHash(deviceEventLogHash({ from, to }))).toEqual({ from, to });
  });

  it('round-trips a source containing / & , = and #', () => {
    const source = 'a/b&c,d=e#f';
    expect(eventLogFilterFromHash(deviceEventLogHash({ source, from, to }))?.source).toBe(source);
  });

  it('accepts a leading # and ignores unknown keys', () => {
    const hash = `#${deviceEventLogHash({ source: 'disk', from, to })}&x=1`;
    expect(eventLogFilterFromHash(hash)).toEqual({ source: 'disk', from, to });
  });

  it('returns undefined for from > to, garbage, missing keys and the bare tab', () => {
    expect(eventLogFilterFromHash(deviceEventLogHash({ from: to, to: from }))).toBeUndefined();
    expect(eventLogFilterFromHash('eventlog&from=nope&to=nope')).toBeUndefined();
    expect(eventLogFilterFromHash('eventlog&from=' + encodeURIComponent(from))).toBeUndefined();
    expect(eventLogFilterFromHash('eventlog')).toBeUndefined();
    expect(eventLogFilterFromHash('scripts/abc')).toBeUndefined();
    expect(eventLogFilterFromHash('')).toBeUndefined();
  });

  it('does not throw on a malformed escape and keeps the raw selection', () => {
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    expect(eventLogFilterFromHash(`eventlog/%E0%A4%A&${q}`)).toEqual({ source: '%E0%A4%A', from, to });
  });

  it('accepts from === to', () => {
    expect(eventLogFilterFromHash(deviceEventLogHash({ from, to: from }))).toEqual({ from, to: from });
  });

  it('builds a full href', () => {
    expect(deviceEventLogHref('dev 1', { from, to })).toBe(
      `/devices/dev%201#${deviceEventLogHash({ from, to })}`,
    );
  });
});

describe('reliabilityScoringWindow', () => {
  const computedAt = '2026-10-24T12:30:45.000Z';
  const dayStart = '2026-09-24T00:00:00.000Z';

  it('starts at UTC midnight 30 days before computedAt and ends at computedAt', () => {
    expect(reliabilityScoringWindow({ computedAt })).toEqual({ from: dayStart, to: computedAt });
  });

  it('computedAt exactly at midnight starts exactly 30 days earlier', () => {
    expect(reliabilityScoringWindow({ computedAt: '2026-10-24T00:00:00.000Z' })?.from).toBe(dayStart);
  });

  it('clamps to the later of baselineAt and enrolledAt', () => {
    const baselineAt = '2026-10-01T00:00:00.000Z';
    const enrolledAt = '2026-10-10T00:00:00.000Z';
    expect(reliabilityScoringWindow({ computedAt, baselineAt, enrolledAt })?.from).toBe(enrolledAt);
    expect(
      reliabilityScoringWindow({ computedAt, baselineAt: enrolledAt, enrolledAt: baselineAt })?.from,
    ).toBe(enrolledAt);
  });

  it('ignores floors earlier than the window start, and null/unparseable floors', () => {
    expect(
      reliabilityScoringWindow({ computedAt, baselineAt: '2026-01-01T00:00:00.000Z', enrolledAt: '2025-01-01T00:00:00.000Z' })?.from,
    ).toBe(dayStart);
    expect(reliabilityScoringWindow({ computedAt, baselineAt: 'junk', enrolledAt: null })?.from).toBe(dayStart);
  });

  it('returns null for an unparseable computedAt or a floor after computedAt', () => {
    expect(reliabilityScoringWindow({ computedAt: 'nope' })).toBeNull();
    expect(reliabilityScoringWindow({ computedAt, enrolledAt: '2026-10-25T00:00:00.000Z' })).toBeNull();
  });
});
