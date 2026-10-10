import { describe, expect, it } from 'vitest';
import { TIME_SYNC_DEFAULTS, timeSyncInlineSettingsSchema } from './timeSync';
import {
  CONFIG_FEATURE_TYPES,
  CONFIG_POLICY_FEATURE_TRUST_TIER,
} from '../constants/configFeatureTypes';

describe('time sync inline settings', () => {
  it('defaults to observation without enforcement', () => {
    expect(timeSyncInlineSettingsSchema.parse({})).toEqual(TIME_SYNC_DEFAULTS);
    expect(CONFIG_FEATURE_TYPES).toContain('time_sync');
    expect(CONFIG_POLICY_FEATURE_TRUST_TIER.time_sync).toBe('protective');
  });
  it.each([15, 60, 1440])('accepts interval %s', (pollIntervalMinutes) => {
    expect(
      timeSyncInlineSettingsSchema.parse({ pollIntervalMinutes })
        .pollIntervalMinutes,
    ).toBe(pollIntervalMinutes);
  });
  it.each([14, 1441, 15.5, '60', null])(
    'rejects interval %s',
    (pollIntervalMinutes) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({ pollIntervalMinutes }).success,
      ).toBe(false);
    },
  );
  it('requires peers only for NTP enforcement', () => {
    expect(
      timeSyncInlineSettingsSchema.safeParse({ enforceNtp: true }).success,
    ).toBe(false);
    expect(
      timeSyncInlineSettingsSchema.safeParse({
        enforceNtp: true,
        ntpServers: ['pool.ntp.org'],
      }).success,
    ).toBe(true);
    expect(
      timeSyncInlineSettingsSchema.safeParse({
        ntpServers: Array(6).fill('pool.ntp.org'),
      }).success,
    ).toBe(false);
  });
  it.each(['a,0x9', 'a b', 'a;b', '-flag', 'a:123', '"a"', 'a/b', '', 'a..b'])(
    'rejects unsafe peer %s',
    (host) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({ ntpServers: [host] }).success,
      ).toBe(false);
    },
  );
  it.each(['UTC', 'America/New_York'])(
    'accepts mapped pin %s',
    (pinnedTimezone) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({
          timezone: { expected: 'pinned', pinnedTimezone },
        }).success,
      ).toBe(true);
    },
  );
  it.each([null, '', 'Unknown/Zone', 'Antarctica/Troll'])(
    'rejects unmapped pin %s',
    (pinnedTimezone) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({
          timezone: { expected: 'pinned', pinnedTimezone },
        }).success,
      ).toBe(false);
    },
  );
  it('rejects unknown keys and never shares mutable default arrays', () => {
    expect(
      timeSyncInlineSettingsSchema.safeParse({ extra: true }).success,
    ).toBe(false);
    expect(
      timeSyncInlineSettingsSchema.safeParse({ timezone: { extra: true } })
        .success,
    ).toBe(false);
    const first = timeSyncInlineSettingsSchema.parse({});
    first.ntpServers.push('pool.ntp.org');
    expect(timeSyncInlineSettingsSchema.parse({}).ntpServers).toEqual([]);
  });
});
