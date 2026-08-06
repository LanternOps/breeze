import { describe, it, expect } from 'vitest';

import { deviceOsType, matchDeviceIds, matchesRule } from './deviceGroupMatching';

describe('deviceOsType', () => {
  it('reads osType, the field the devices API returns', () => {
    expect(deviceOsType({ id: 'd1', osType: 'windows' })).toBe('windows');
  });

  it('falls back to the historical os key and to empty', () => {
    expect(deviceOsType({ id: 'd1', os: 'linux' })).toBe('linux');
    expect(deviceOsType({ id: 'd1' })).toBe('');
    expect(deviceOsType(undefined)).toBe('');
  });
});

describe('matchesRule', () => {
  const windows = { id: 'd1', hostname: 'web-01', osType: 'windows', siteId: 'site-1' };

  it('matches an os rule against osType', () => {
    expect(matchesRule(windows, { field: 'os', operator: 'is', value: 'windows' })).toBe(true);
    expect(matchesRule(windows, { field: 'os', operator: 'is', value: 'linux' })).toBe(false);
    expect(matchesRule(windows, { field: 'os', operator: 'is_not', value: 'linux' })).toBe(true);
  });

  it('does not throw when the device lacks every field the rule names', () => {
    const bare = { id: 'd1' };
    for (const field of ['os', 'site', 'tag', 'hostname'] as const) {
      expect(() =>
        matchesRule(bare, { field, operator: 'is', value: 'anything' }),
      ).not.toThrow();
    }
    expect(matchesRule(bare, { field: 'os', operator: 'is', value: 'windows' })).toBe(false);
    expect(matchesRule(bare, { field: 'tag', operator: 'contains', value: 'prod' })).toBe(false);
  });

  it('does not throw on a rule with no value, and matches nothing', () => {
    expect(matchesRule(windows, { field: 'os', operator: 'is' })).toBe(false);
    expect(matchesRule(windows, { field: 'hostname', operator: 'contains', value: '   ' })).toBe(false);
    expect(matchesRule(windows, null)).toBe(false);
    expect(matchesRule(null, { field: 'os', operator: 'is', value: 'windows' })).toBe(false);
  });

  it('matches a site rule on either id or name', () => {
    expect(matchesRule(windows, { field: 'site', operator: 'is', value: 'site-1' })).toBe(true);
    expect(
      matchesRule({ id: 'd1', siteName: 'HQ' }, { field: 'site', operator: 'is', value: 'hq' }),
    ).toBe(true);
    // No siteId and no siteName must not accidentally equal an empty rule value.
    expect(matchesRule({ id: 'd1' }, { field: 'site', operator: 'is', value: 'hq' })).toBe(false);
  });

  it('tolerates a tags value that is not an array of strings', () => {
    expect(
      matchesRule({ id: 'd1', tags: 'prod' }, { field: 'tag', operator: 'contains', value: 'prod' }),
    ).toBe(false);
    expect(
      matchesRule({ id: 'd1', tags: [null, 'prod'] }, { field: 'tag', operator: 'contains', value: 'prod' }),
    ).toBe(true);
  });

  it('falls back to substring matching on an invalid regex', () => {
    expect(
      matchesRule(windows, { field: 'hostname', operator: 'matches', value: 'web-' }),
    ).toBe(true);
    expect(
      matchesRule(windows, { field: 'hostname', operator: 'matches', value: '([' }),
    ).toBe(false);
  });
});

describe('matchDeviceIds', () => {
  const devices = [
    { id: 'd1', hostname: 'web-01', osType: 'windows' },
    { id: 'd2', hostname: 'db-01', osType: 'linux' },
  ];

  it('ANDs the rules and returns matching ids', () => {
    expect(matchDeviceIds(devices, [{ field: 'os', operator: 'is', value: 'windows' }])).toEqual(['d1']);
    expect(
      matchDeviceIds(devices, [
        { field: 'os', operator: 'is', value: 'windows' },
        { field: 'hostname', operator: 'contains', value: 'db' },
      ]),
    ).toEqual([]);
  });

  it('returns [] for absent, empty or malformed rule lists', () => {
    expect(matchDeviceIds(devices, undefined)).toEqual([]);
    expect(matchDeviceIds(devices, [])).toEqual([]);
    expect(matchDeviceIds(devices, [null, undefined])).toEqual([]);
    expect(matchDeviceIds(undefined, [{ field: 'os', operator: 'is', value: 'windows' }])).toEqual([]);
  });
});
