import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  filterDevicesByClass,
  countDevicesByClass,
  readDeviceClassFromHash,
  writeDeviceClassToHash,
  readDeviceClassPreference,
  saveDeviceClassPreference,
  resolveDeviceClass,
  DEFAULT_DEVICE_CLASS,
  DEVICE_CLASS_PREFERENCE_KEY,
  type DeviceClassFilter,
} from './deviceClassFilter';

type Row = { id: string; deviceClass?: 'agent' | 'network' | 'manual' };

const rows: Row[] = [
  { id: 'a1', deviceClass: 'agent' },
  { id: 'a2' }, // missing deviceClass → treated as agent
  { id: 'n1', deviceClass: 'network' },
  { id: 'n2', deviceClass: 'network' },
  { id: 'm1', deviceClass: 'manual' },
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

  it('returns only manual rows for "manual"', () => {
    expect(filterDevicesByClass(rows, 'manual').map(r => r.id)).toEqual(['m1']);
  });
});

describe('countDevicesByClass', () => {
  it('counts each class with missing deviceClass folded into agent', () => {
    expect(countDevicesByClass(rows)).toEqual({ all: 5, agent: 2, network: 2, manual: 1 });
  });

  it('returns zeroes for an empty list', () => {
    expect(countDevicesByClass([])).toEqual({ all: 0, agent: 0, network: 0, manual: 0 });
  });
});

describe('readDeviceClassFromHash', () => {
  it('parses a deviceClass fragment', () => {
    expect(readDeviceClassFromHash('#deviceClass=network')).toBe('network');
    expect(readDeviceClassFromHash('#deviceClass=agent')).toBe('agent');
    expect(readDeviceClassFromHash('#deviceClass=all')).toBe('all');
    expect(readDeviceClassFromHash('#deviceClass=manual')).toBe('manual');
  });

  it('returns undefined when absent or invalid (caller picks the default)', () => {
    expect(readDeviceClassFromHash('')).toBeUndefined();
    expect(readDeviceClassFromHash('#filtersV2=abc')).toBeUndefined();
    expect(readDeviceClassFromHash('#deviceClass=bogus')).toBeUndefined();
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

  it('writes "all" explicitly — it is no longer the default, so a shared link must say so (#5874)', () => {
    writeDeviceClassToHash('network');
    writeDeviceClassToHash('all');
    expect(window.location.hash).toBe('#deviceClass=all');
    expect(readDeviceClassFromHash(window.location.hash)).toBe('all');
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

// #5874: techs arrive for reactive support on managed endpoints, so the page
// opens on Agent — then on whatever segment the user last picked.
describe('device class default + remembered preference (#5874)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to "agent"', () => {
    expect(DEFAULT_DEVICE_CLASS).toBe('agent');
    expect(readDeviceClassPreference()).toBe('agent');
    expect(resolveDeviceClass('')).toBe('agent');
  });

  it('remembers the last chosen segment', () => {
    saveDeviceClassPreference('all');
    expect(window.localStorage.getItem(DEVICE_CLASS_PREFERENCE_KEY)).toBe('all');
    expect(readDeviceClassPreference()).toBe('all');
    expect(resolveDeviceClass('#filtersV2=abc')).toBe('all');
  });

  it('a hash deep link wins over the remembered preference', () => {
    saveDeviceClassPreference('agent');
    expect(resolveDeviceClass('#deviceClass=network')).toBe('network');
    expect(resolveDeviceClass('#deviceClass=all')).toBe('all');
  });

  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem(DEVICE_CLASS_PREFERENCE_KEY, 'bogus');
    expect(readDeviceClassPreference()).toBe('agent');
  });

  it('falls back to the default when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(readDeviceClassPreference()).toBe('agent');
      expect(() => saveDeviceClassPreference('all')).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

// Type-only sanity: the filter union is exactly these four.
const _exhaustive: DeviceClassFilter[] = ['all', 'agent', 'network', 'manual'];
void _exhaustive;
