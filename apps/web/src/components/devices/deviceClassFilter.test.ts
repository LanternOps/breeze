import { describe, it, expect, beforeEach } from 'vitest';
import {
  filterDevicesByClass,
  countDevicesByClass,
  readDeviceClassFromHash,
  writeDeviceClassToHash,
  type DeviceClassFilter,
} from './deviceClassFilter';

type Row = { id: string; deviceClass?: 'agent' | 'network' };

const rows: Row[] = [
  { id: 'a1', deviceClass: 'agent' },
  { id: 'a2' }, // missing deviceClass → treated as agent
  { id: 'n1', deviceClass: 'network' },
  { id: 'n2', deviceClass: 'network' },
];

describe('filterDevicesByClass', () => {
  it('returns every row for "all"', () => {
    expect(filterDevicesByClass(rows, 'all')).toEqual(rows);
  });

  it('returns only agent rows for "agent", treating missing deviceClass as agent', () => {
    expect(filterDevicesByClass(rows, 'agent').map(r => r.id)).toEqual(['a1', 'a2']);
  });

  it('returns only network rows for "network"', () => {
    expect(filterDevicesByClass(rows, 'network').map(r => r.id)).toEqual(['n1', 'n2']);
  });
});

describe('countDevicesByClass', () => {
  it('counts each class with missing deviceClass folded into agent', () => {
    expect(countDevicesByClass(rows)).toEqual({ all: 4, agent: 2, network: 2 });
  });

  it('returns zeroes for an empty list', () => {
    expect(countDevicesByClass([])).toEqual({ all: 0, agent: 0, network: 0 });
  });
});

describe('readDeviceClassFromHash', () => {
  it('parses a deviceClass fragment', () => {
    expect(readDeviceClassFromHash('#deviceClass=network')).toBe('network');
    expect(readDeviceClassFromHash('#deviceClass=agent')).toBe('agent');
    expect(readDeviceClassFromHash('#deviceClass=all')).toBe('all');
  });

  it('defaults to "all" when absent or invalid', () => {
    expect(readDeviceClassFromHash('')).toBe('all');
    expect(readDeviceClassFromHash('#filtersV2=abc')).toBe('all');
    expect(readDeviceClassFromHash('#deviceClass=bogus')).toBe('all');
  });

  it('reads the fragment when other keys are present', () => {
    expect(readDeviceClassFromHash('#filtersV2=abc&deviceClass=network')).toBe('network');
  });
});

describe('writeDeviceClassToHash', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/devices');
  });

  it('round-trips through the hash', () => {
    writeDeviceClassToHash('network');
    expect(readDeviceClassFromHash(window.location.hash)).toBe('network');
  });

  it('removes the fragment for "all" to keep the URL clean', () => {
    writeDeviceClassToHash('network');
    writeDeviceClassToHash('all');
    expect(window.location.hash).not.toContain('deviceClass');
  });

  it('preserves unrelated hash fragments', () => {
    history.replaceState(null, '', '/devices#filtersV2=abc&add-device');
    writeDeviceClassToHash('network');
    expect(window.location.hash).toContain('filtersV2=abc');
    expect(window.location.hash).toContain('add-device');
    expect(window.location.hash).toContain('deviceClass=network');
  });

  it('does not duplicate the key when changing value', () => {
    writeDeviceClassToHash('network');
    writeDeviceClassToHash('agent');
    const matches = window.location.hash.match(/deviceClass=/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(readDeviceClassFromHash(window.location.hash)).toBe('agent');
  });
});

// Type-only sanity: the filter union is exactly these three.
const _exhaustive: DeviceClassFilter[] = ['all', 'agent', 'network'];
void _exhaustive;
