import { describe, it, expect } from 'vitest';
import {
  MAINTENANCE_WINDOW_ALWAYS,
  MAINTENANCE_DAYS,
  isAlwaysMaintenanceWindow,
  parseMaintenanceWindow,
  isValidMaintenanceWindow,
  minutesToHHMM,
  formatMaintenanceWindow,
} from './maintenanceWindow';

describe('isAlwaysMaintenanceWindow', () => {
  it('treats empty / whitespace / null / undefined as always', () => {
    expect(isAlwaysMaintenanceWindow('')).toBe(true);
    expect(isAlwaysMaintenanceWindow('   ')).toBe(true);
    expect(isAlwaysMaintenanceWindow(null)).toBe(true);
    expect(isAlwaysMaintenanceWindow(undefined)).toBe(true);
  });

  it('recognizes the 24/7 sentinel and tolerated aliases (case-insensitive)', () => {
    expect(isAlwaysMaintenanceWindow('24/7')).toBe(true);
    expect(isAlwaysMaintenanceWindow(MAINTENANCE_WINDOW_ALWAYS)).toBe(true);
    expect(isAlwaysMaintenanceWindow('Always')).toBe(true);
    expect(isAlwaysMaintenanceWindow('NONE')).toBe(true);
    expect(isAlwaysMaintenanceWindow(' anytime ')).toBe(true);
  });

  it('is false for real windows and malformed strings', () => {
    expect(isAlwaysMaintenanceWindow('Sun 02:00-04:00')).toBe(false);
    expect(isAlwaysMaintenanceWindow('02:00-04:00')).toBe(false);
    expect(isAlwaysMaintenanceWindow('0000-2359')).toBe(false);
  });
});

describe('parseMaintenanceWindow', () => {
  it('parses day-prefixed, daily, and loosely-spaced windows', () => {
    expect(parseMaintenanceWindow('Sun 02:00-04:00')).toEqual({ day: 0, startMin: 120, endMin: 240 });
    expect(parseMaintenanceWindow('02:00-04:00')).toEqual({ day: null, startMin: 120, endMin: 240 });
    expect(parseMaintenanceWindow('  mON  22:30 - 23:45 ')).toEqual({ day: 1, startMin: 1350, endMin: 1425 });
    expect(parseMaintenanceWindow('2:00-4:00')).toEqual({ day: null, startMin: 120, endMin: 240 });
  });

  it('returns null for always sentinels, empty, and malformed input', () => {
    expect(parseMaintenanceWindow('')).toBeNull();
    expect(parseMaintenanceWindow('24/7')).toBeNull();
    expect(parseMaintenanceWindow(null)).toBeNull();
    expect(parseMaintenanceWindow('0000-2359')).toBeNull(); // no colons (issue #1963 repro)
    expect(parseMaintenanceWindow('sometime soon')).toBeNull();
    expect(parseMaintenanceWindow('Xyz 02:00-04:00')).toBeNull(); // bad day
    expect(parseMaintenanceWindow('25:00-26:00')).toBeNull(); // bad hour
    expect(parseMaintenanceWindow('02:00-02:00')).toBeNull(); // zero-length
  });
});

describe('isValidMaintenanceWindow', () => {
  it('accepts the always state and parseable windows', () => {
    expect(isValidMaintenanceWindow('')).toBe(true);
    expect(isValidMaintenanceWindow('24/7')).toBe(true);
    expect(isValidMaintenanceWindow('Sun 02:00-04:00')).toBe(true);
    expect(isValidMaintenanceWindow('22:00-02:00')).toBe(true);
  });

  it('rejects malformed values (so the API can refuse them at save time)', () => {
    expect(isValidMaintenanceWindow('0000-2359')).toBe(false);
    expect(isValidMaintenanceWindow('every other tuesday')).toBe(false);
    expect(isValidMaintenanceWindow('02:00-02:00')).toBe(false);
  });
});

describe('minutesToHHMM', () => {
  it('zero-pads hours and minutes', () => {
    expect(minutesToHHMM(0)).toBe('00:00');
    expect(minutesToHHMM(120)).toBe('02:00');
    expect(minutesToHHMM(1425)).toBe('23:45');
  });
});

describe('formatMaintenanceWindow', () => {
  it('builds a canonical window string round-trippable through the parser', () => {
    expect(formatMaintenanceWindow('Sun', '02:00', '04:00')).toBe('Sun 02:00-04:00');
    expect(formatMaintenanceWindow('', '02:00', '04:00')).toBe('02:00-04:00');
    expect(formatMaintenanceWindow(null, '22:00', '02:00')).toBe('22:00-02:00');
    expect(parseMaintenanceWindow(formatMaintenanceWindow('Mon', '22:30', '23:45')!))
      .toEqual({ day: 1, startMin: 1350, endMin: 1425 });
  });

  it('returns null when the result would be an invalid window', () => {
    expect(formatMaintenanceWindow('Sun', '02:00', '02:00')).toBeNull(); // zero-length
    expect(formatMaintenanceWindow(null, '', '04:00')).toBeNull();
  });

  it('every MAINTENANCE_DAYS label is accepted by the parser', () => {
    MAINTENANCE_DAYS.forEach((label, idx) => {
      expect(parseMaintenanceWindow(`${label} 01:00-02:00`)).toEqual({
        day: idx, startMin: 60, endMin: 120,
      });
    });
  });
});
