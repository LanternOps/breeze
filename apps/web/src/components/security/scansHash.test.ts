import { describe, expect, it } from 'vitest';
import { encodeScansHash, parseScansHash } from './scansHash';

const GROUP = '3f2b8c1e-5a47-4d0e-9c1a-0b7e6d5f4a32';

describe('parseScansHash', () => {
  it('defaults to the scans tab with no group', () => {
    expect(parseScansHash('')).toEqual({ tab: 'scans', group: null });
    expect(parseScansHash('#')).toEqual({ tab: 'scans', group: null });
    expect(parseScansHash('nonsense')).toEqual({ tab: 'scans', group: null });
  });

  it('reads the three tabs, with or without the leading #', () => {
    expect(parseScansHash('threats').tab).toBe('threats');
    expect(parseScansHash('#sweeps').tab).toBe('sweeps');
    expect(parseScansHash('#scans').tab).toBe('scans');
  });

  it('reads the group on the sweeps tab', () => {
    expect(parseScansHash(`#sweeps&group=${GROUP}`)).toEqual({ tab: 'sweeps', group: GROUP });
    expect(parseScansHash(`sweeps&group=${GROUP}`)).toEqual({ tab: 'sweeps', group: GROUP });
  });

  it('ignores a malformed group and unknown keys', () => {
    expect(parseScansHash('#sweeps&group=not-a-guid')).toEqual({ tab: 'sweeps', group: null });
    expect(parseScansHash(`#sweeps&other=1&group=${GROUP}`).group).toBe(GROUP);
  });

  it('keeps a group only on the sweeps tab', () => {
    expect(parseScansHash(`#threats&group=${GROUP}`)).toEqual({ tab: 'threats', group: null });
  });
});

describe('encodeScansHash', () => {
  it('writes exactly the bare tab when no group is set', () => {
    expect(encodeScansHash({ tab: 'threats', group: null })).toBe('#threats');
    expect(encodeScansHash({ tab: 'scans', group: null })).toBe('#scans');
    expect(encodeScansHash({ tab: 'sweeps', group: null })).toBe('#sweeps');
  });

  it('writes the group after the sweeps tab and round-trips', () => {
    const hash = encodeScansHash({ tab: 'sweeps', group: GROUP });
    expect(hash).toBe(`#sweeps&group=${GROUP}`);
    expect(parseScansHash(hash)).toEqual({ tab: 'sweeps', group: GROUP });
  });

  it('drops the group for any other tab', () => {
    expect(encodeScansHash({ tab: 'threats', group: GROUP })).toBe('#threats');
  });
});
