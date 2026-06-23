import { describe, it, expect } from 'vitest';
import {
  normalizeAgentUpdatePolicy,
  normalizeAgentUpdateSettings,
  parseMaintenanceWindow,
  isWithinMaintenanceWindow,
  shouldSendAgentUpgrade,
} from './agentUpdatePolicy';

// All Dates below are UTC. 2026-06-14 is a Sunday.
const SUN_0300 = new Date('2026-06-14T03:00:00Z'); // Sunday 03:00 UTC
const SUN_0500 = new Date('2026-06-14T05:00:00Z'); // Sunday 05:00 UTC
const MON_0300 = new Date('2026-06-15T03:00:00Z'); // Monday 03:00 UTC

describe('normalizeAgentUpdatePolicy', () => {
  it('passes through known policies', () => {
    expect(normalizeAgentUpdatePolicy('auto')).toBe('auto');
    expect(normalizeAgentUpdatePolicy('staged')).toBe('staged');
    expect(normalizeAgentUpdatePolicy('manual')).toBe('manual');
  });

  it('defaults unknown/absent values to staged (permissive when no window set)', () => {
    expect(normalizeAgentUpdatePolicy(undefined)).toBe('staged');
    expect(normalizeAgentUpdatePolicy(null)).toBe('staged');
    expect(normalizeAgentUpdatePolicy('')).toBe('staged');
    expect(normalizeAgentUpdatePolicy('bogus')).toBe('staged');
    expect(normalizeAgentUpdatePolicy(42)).toBe('staged');
  });
});

describe('normalizeAgentUpdateSettings', () => {
  it('maps legacy manual to structured manual', () => {
    expect(normalizeAgentUpdateSettings({ agentUpdatePolicy: 'manual' })).toMatchObject({
      mode: 'manual',
      timing: 'asap',
      schedule: null,
    });
  });

  it('maps legacy automatic with a parseable day window to weekly', () => {
    expect(normalizeAgentUpdateSettings({
      agentUpdatePolicy: 'auto',
      maintenanceWindow: 'Sun 02:00-04:00',
    })).toMatchObject({
      mode: 'automatic',
      timing: 'weekly',
      schedule: { windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }] },
    });
  });

  it('maps legacy automatic without a window to the default weekly schedule', () => {
    expect(normalizeAgentUpdateSettings({
      agentUpdatePolicy: 'auto',
    })).toMatchObject({
      mode: 'automatic',
      timing: 'weekly',
      schedule: { windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }] },
    });
  });

  it('maps malformed legacy windows to automatic asap with a warning flag', () => {
    expect(normalizeAgentUpdateSettings({
      agentUpdatePolicy: 'staged',
      maintenanceWindow: 'sometime soon',
    })).toMatchObject({
      mode: 'automatic',
      timing: 'asap',
      schedule: null,
      legacyWindowInvalid: true,
    });
  });

  it('maps malformed legacy automatic windows to the default weekly schedule with a warning flag', () => {
    expect(normalizeAgentUpdateSettings({
      agentUpdatePolicy: 'auto',
      maintenanceWindow: 'sometime soon',
    })).toMatchObject({
      mode: 'automatic',
      timing: 'weekly',
      schedule: { windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }] },
      legacyWindowInvalid: true,
    });
  });

  it('accepts structured schedules with multiple windows', () => {
    expect(normalizeAgentUpdateSettings({
      agentUpdateMode: 'automatic',
      agentUpdateTiming: 'weekly',
      agentUpdateSchedule: {
        windows: [
          { dayOfWeek: 'mon', start: '01:00', end: '03:00' },
          { dayOfWeek: 'wed', start: '22:30', end: '01:30' },
        ],
      },
    })).toMatchObject({
      mode: 'automatic',
      timing: 'weekly',
      schedule: {
        windows: [
          { dayOfWeek: 'mon', start: '01:00', end: '03:00' },
          { dayOfWeek: 'wed', start: '22:30', end: '01:30' },
        ],
      },
    });
  });
});

describe('parseMaintenanceWindow', () => {
  it('parses a day-prefixed window', () => {
    expect(parseMaintenanceWindow('Sun 02:00-04:00')).toEqual({ day: 0, startMin: 120, endMin: 240 });
  });

  it('parses a daily (no day) window', () => {
    expect(parseMaintenanceWindow('02:00-04:00')).toEqual({ day: null, startMin: 120, endMin: 240 });
  });

  it('is case-insensitive and tolerates spacing', () => {
    expect(parseMaintenanceWindow('  mON  22:30 - 23:45 ')).toEqual({ day: 1, startMin: 1350, endMin: 1425 });
  });

  it('accepts single-digit hours (regex allows \\d{1,2}, UI may not zero-pad)', () => {
    expect(parseMaintenanceWindow('2:00-4:00')).toEqual({ day: null, startMin: 120, endMin: 240 });
    expect(parseMaintenanceWindow('Sun 2:00-4:00')).toEqual({ day: 0, startMin: 120, endMin: 240 });
  });

  it('returns null for empty / non-string / malformed input', () => {
    expect(parseMaintenanceWindow('')).toBeNull();
    expect(parseMaintenanceWindow('   ')).toBeNull();
    expect(parseMaintenanceWindow(null)).toBeNull();
    expect(parseMaintenanceWindow(undefined)).toBeNull();
    expect(parseMaintenanceWindow('sometime soon')).toBeNull();
    expect(parseMaintenanceWindow('Xyz 02:00-04:00')).toBeNull(); // bad day
    expect(parseMaintenanceWindow('25:00-26:00')).toBeNull(); // bad hour
    expect(parseMaintenanceWindow('02:00-02:00')).toBeNull(); // zero-length
  });
});

describe('isWithinMaintenanceWindow', () => {
  it('returns true (no restriction) when window is absent or malformed', () => {
    expect(isWithinMaintenanceWindow(null, SUN_0300)).toBe(true);
    expect(isWithinMaintenanceWindow('', SUN_0300)).toBe(true);
    expect(isWithinMaintenanceWindow('garbage', SUN_0300)).toBe(true);
  });

  it('respects same-day day-prefixed windows', () => {
    expect(isWithinMaintenanceWindow('Sun 02:00-04:00', SUN_0300)).toBe(true);
    expect(isWithinMaintenanceWindow('Sun 02:00-04:00', SUN_0500)).toBe(false); // after window
    expect(isWithinMaintenanceWindow('Sun 02:00-04:00', MON_0300)).toBe(false); // wrong day
  });

  it('treats day-less windows as daily', () => {
    expect(isWithinMaintenanceWindow('02:00-04:00', SUN_0300)).toBe(true);
    expect(isWithinMaintenanceWindow('02:00-04:00', MON_0300)).toBe(true);
    expect(isWithinMaintenanceWindow('02:00-04:00', SUN_0500)).toBe(false);
  });

  it('handles windows that wrap past midnight (daily)', () => {
    // 22:00-02:00 daily: 23:00 in, 01:00 in, 03:00 out
    expect(isWithinMaintenanceWindow('22:00-02:00', new Date('2026-06-14T23:00:00Z'))).toBe(true);
    expect(isWithinMaintenanceWindow('22:00-02:00', new Date('2026-06-15T01:00:00Z'))).toBe(true);
    expect(isWithinMaintenanceWindow('22:00-02:00', new Date('2026-06-15T03:00:00Z'))).toBe(false);
  });

  it('handles day-prefixed windows that wrap past midnight', () => {
    // Sat 22:00-02:00: covers Sat 22:00+ and Sun 00:00-02:00
    expect(isWithinMaintenanceWindow('Sat 22:00-02:00', new Date('2026-06-13T23:00:00Z'))).toBe(true); // Sat
    expect(isWithinMaintenanceWindow('Sat 22:00-02:00', new Date('2026-06-14T01:00:00Z'))).toBe(true); // Sun
    expect(isWithinMaintenanceWindow('Sat 22:00-02:00', new Date('2026-06-14T03:00:00Z'))).toBe(false); // Sun, too late
    expect(isWithinMaintenanceWindow('Sat 22:00-02:00', new Date('2026-06-13T20:00:00Z'))).toBe(false); // Sat, too early
  });
});

describe('shouldSendAgentUpgrade', () => {
  it('manual never allows auto-upgrade, even inside a window', () => {
    expect(shouldSendAgentUpgrade({ policy: 'manual', maintenanceWindow: null }, SUN_0300))
      .toEqual({ allow: false, reason: 'manual-approval' });
    expect(shouldSendAgentUpgrade({ policy: 'manual', maintenanceWindow: 'Sun 02:00-04:00' }, SUN_0300))
      .toEqual({ allow: false, reason: 'manual-approval' });
  });

  it('auto upgrades anytime when no window is set', () => {
    expect(shouldSendAgentUpgrade({ policy: 'auto', maintenanceWindow: null }, SUN_0500))
      .toEqual({ allow: true, reason: 'allowed' });
  });

  it('auto and staged respect a configured window', () => {
    expect(shouldSendAgentUpgrade({ policy: 'auto', maintenanceWindow: 'Sun 02:00-04:00' }, SUN_0300))
      .toEqual({ allow: true, reason: 'allowed' });
    expect(shouldSendAgentUpgrade({ policy: 'auto', maintenanceWindow: 'Sun 02:00-04:00' }, SUN_0500))
      .toEqual({ allow: false, reason: 'outside-schedule' });
    expect(shouldSendAgentUpgrade({ policy: 'staged', maintenanceWindow: 'Sun 02:00-04:00' }, SUN_0300))
      .toEqual({ allow: true, reason: 'allowed' });
    expect(shouldSendAgentUpgrade({ policy: 'staged', maintenanceWindow: 'Sun 02:00-04:00' }, SUN_0500))
      .toEqual({ allow: false, reason: 'outside-schedule' });
  });

  it('staged with no window behaves like auto-anytime (non-breaking default)', () => {
    expect(shouldSendAgentUpgrade({ policy: 'staged', maintenanceWindow: null }, SUN_0500))
      .toEqual({ allow: true, reason: 'allowed' });
  });

  it('structured weekly allows any selected time window', () => {
    expect(shouldSendAgentUpgrade({
      mode: 'automatic',
      timing: 'weekly',
      schedule: {
        windows: [
          { dayOfWeek: 'mon', start: '01:00', end: '03:00' },
          { dayOfWeek: 'sun', start: '02:00', end: '04:00' },
        ],
      },
      pins: {},
      legacyPolicy: null,
      legacyMaintenanceWindow: null,
      legacyWindowInvalid: false,
    }, SUN_0300)).toEqual({ allow: true, reason: 'allowed' });
    expect(shouldSendAgentUpgrade({
      mode: 'automatic',
      timing: 'weekly',
      schedule: { windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }] },
      pins: {},
      legacyPolicy: null,
      legacyMaintenanceWindow: null,
      legacyWindowInvalid: false,
    }, SUN_0500)).toEqual({ allow: false, reason: 'outside-schedule' });
  });

  it('structured weekly supports windows that wrap past midnight', () => {
    const settings = {
      mode: 'automatic' as const,
      timing: 'weekly' as const,
      schedule: { windows: [{ dayOfWeek: 'sat' as const, start: '22:00', end: '02:00' }] },
      pins: {},
      legacyPolicy: null,
      legacyMaintenanceWindow: null,
      legacyWindowInvalid: false,
    };

    expect(shouldSendAgentUpgrade(settings, new Date('2026-06-13T23:00:00Z')))
      .toEqual({ allow: true, reason: 'allowed' });
    expect(shouldSendAgentUpgrade(settings, new Date('2026-06-14T01:00:00Z')))
      .toEqual({ allow: true, reason: 'allowed' });
    expect(shouldSendAgentUpgrade(settings, new Date('2026-06-14T03:00:00Z')))
      .toEqual({ allow: false, reason: 'outside-schedule' });
  });
});
