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
    const hash = deviceEventLogHash({ sources: ['Service Control Manager'], from, to });
    expect(hash.startsWith('eventlog/Service%20Control%20Manager&')).toBe(true);
    expect(hash).toContain('from=2026-09-24T00%3A00%3A00.000Z');
    expect(hash).toContain('to=2026-10-24T12%3A30%3A00.000Z');
  });

  it('encodes a window-only link without a selection segment', () => {
    expect(deviceEventLogHash({ from, to }).startsWith('eventlog&from=')).toBe(true);
  });

  it('round-trips with and without a source', () => {
    expect(eventLogFilterFromHash(deviceEventLogHash({ sources: ['WHEA-Logger'], from, to }))).toEqual({
      sources: ['WHEA-Logger'],
      from,
      to,
    });
    expect(eventLogFilterFromHash(deviceEventLogHash({ from, to }))).toEqual({ from, to });
  });

  it('round-trips a source containing / & , = and #', () => {
    const source = 'a/b&c,d=e#f';
    expect(eventLogFilterFromHash(deviceEventLogHash({ sources: [source], from, to }))?.sources).toEqual([source]);
  });

  it('accepts a leading # and ignores unknown keys', () => {
    const hash = `#${deviceEventLogHash({ sources: ['disk'], from, to })}&x=1`;
    expect(eventLogFilterFromHash(hash)).toEqual({ sources: ['disk'], from, to });
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
    expect(eventLogFilterFromHash(`eventlog/%E0%A4%A&${q}`)).toEqual({ sources: ['%E0%A4%A'], from, to });
  });

  // #10053: a reliability factor links every source its scored events came from.
  it('encodes several sources as one comma-joined source key, keeping the single-source shape', () => {
    const hash = deviceEventLogHash({ sources: ['EventLog', 'Microsoft-Windows-Kernel-Power'], from, to });
    expect(hash.startsWith('eventlog&')).toBe(true);
    expect(hash).toContain('source=EventLog,Microsoft-Windows-Kernel-Power');
    expect(deviceEventLogHash({ sources: ['disk'], from, to }).startsWith('eventlog/disk&')).toBe(true);
    expect(deviceEventLogHash({ sources: [], from, to })).toBe(deviceEventLogHash({ from, to }));
  });

  it('round-trips several sources, including ones containing , & / =', () => {
    const sources = ['EventLog', 'a,b', 'c&d/e=f'];
    expect(eventLogFilterFromHash(deviceEventLogHash({ sources, from, to }))).toEqual({ sources, from, to });
  });

  it('merges a selection with a source key and drops duplicates', () => {
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    expect(eventLogFilterFromHash(`eventlog/disk&source=disk,Ntfs&${q}`)).toEqual({ sources: ['disk', 'Ntfs'], from, to });
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
