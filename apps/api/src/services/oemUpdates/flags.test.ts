import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLabDevice, laneDisabledByKillSwitch, oemUpdatesEnabled } from './flags';

afterEach(() => vi.unstubAllEnvs());

describe('oemUpdatesEnabled', () => {
  it('is off by default', () => {
    expect(oemUpdatesEnabled('p1')).toBe(false);
  });

  it('is on for everyone when the flag is on and no allowlist is set', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    expect(oemUpdatesEnabled('p1')).toBe(true);
  });

  it('an allowlist restricts when set', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', ' p1 , P2 ');
    expect(oemUpdatesEnabled('p1')).toBe(true);
    expect(oemUpdatesEnabled('p2')).toBe(true);
    expect(oemUpdatesEnabled('p3')).toBe(false);
  });

  it('an allowlist alone never turns it on', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', 'p1');
    expect(oemUpdatesEnabled('p1')).toBe(false);
  });
});

describe('laneDisabledByKillSwitch', () => {
  it('names only the listed lanes', () => {
    expect(laneDisabledByKillSwitch('dell')).toBe(false);
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'hp, DELL');
    expect(laneDisabledByKillSwitch('dell')).toBe(true);
    expect(laneDisabledByKillSwitch('hp')).toBe(true);
    expect(laneDisabledByKillSwitch('surface')).toBe(false);
  });
});

describe('isLabDevice', () => {
  it('matches a listed device only', () => {
    expect(isLabDevice('d1')).toBe(false);
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', 'd1,d2');
    expect(isLabDevice('d1')).toBe(true);
    expect(isLabDevice('d3')).toBe(false);
  });

  it('is never true under NODE_ENV=production, even if boot validation was skipped', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', 'd1');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isLabDevice('d1')).toBe(false);
  });
});
