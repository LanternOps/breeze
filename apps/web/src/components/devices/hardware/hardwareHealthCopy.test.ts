import { describe, expect, it } from 'vitest';
import i18n from 'i18next';
import { component, view } from './hardwareHealth.fixtures';

describe('hardware view contract', () => {
  it('has all persisted fields and server freshness in the local fixture', () => {
    expect(component()).toMatchObject({
      componentType: 'controller', componentKey: 'storcli:c0', fresh: true,
      stale: false, predictiveFailure: false, alertExempt: false,
      unhealthyStreak: 0, criticalStreak: 0, healthyStreak: 2,
      belowCriticalStreak: 2, predictiveStreak: 0,
    });
    expect(view().lastCollectedAt).toBe('2026-09-23T12:00:00.000Z');
    expect(view().lastReceivedAt).toBe('2026-09-23T12:00:01.000Z');
  });
  it('resolves actual English copy, with no raw key fallback', () => {
    expect(i18n.t('hardwareHealth.title', { ns: 'devices', lng: 'en' })).toBe('Storage & RAID');
    expect(i18n.t('hardwareHealth.disabled', {
      ns: 'devices', lng: 'en', policy: 'Servers',
    })).toBe('Hardware monitoring is disabled by policy Servers');
  });
});
