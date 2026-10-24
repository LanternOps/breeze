import { describe, expect, it } from 'vitest';
import {
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

  it('does not throw on a malformed escape', () => {
    expect(() => eventLogFilterFromHash('eventlog/%E0%A4%A&from=x&to=y')).not.toThrow();
  });

  it('builds a full href', () => {
    expect(deviceEventLogHref('dev 1', { from, to })).toBe(
      `/devices/dev%201#${deviceEventLogHash({ from, to })}`,
    );
  });
});
