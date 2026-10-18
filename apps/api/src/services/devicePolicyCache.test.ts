import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  store: new Map<string, string>(),
  redis: null as null | { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> },
}));

vi.mock('../db', () => ({ db: {} }));
vi.mock('./redis', () => ({ getRedis: () => m.redis }));

import {
  allDevicePolicyCacheKeys,
  DEVICE_POLICY_CACHE_FEATURES,
  DevicePolicyCacheOrgMismatchError,
  devicePolicyCacheKey,
  devicePolicyCacheOrg,
  invalidateDevicePolicyCaches,
  readDevicePolicyCache,
  writeDevicePolicyCache,
} from './devicePolicyCache';
import type { DeviceHierarchy } from './deviceHierarchy';

const DEVICE = 'dev-1';

function hierarchy(orgId: string): DeviceHierarchy {
  return { deviceId: DEVICE, orgId, siteId: 's', deviceRole: 'workstation', osType: 'windows', org: null, site: null, groupIds: [] };
}

beforeEach(() => {
  m.store.clear();
  m.redis = {
    get: vi.fn(async (k: string) => m.store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { m.store.set(k, v); return 'OK'; }),
    del: vi.fn(async (...keys: string[]) => keys.filter((k) => m.store.delete(k)).length),
  };
});

describe('devicePolicyCacheOrg', () => {
  it('prefers the hierarchy org, falls back to the caller org, and is null when neither is known', () => {
    expect(devicePolicyCacheOrg(DEVICE, { hierarchy: hierarchy('org-h') })).toBe('org-h');
    expect(devicePolicyCacheOrg(DEVICE, { hierarchy: hierarchy('org-h'), orgId: 'org-h' })).toBe('org-h');
    expect(devicePolicyCacheOrg(DEVICE, { orgId: 'org-c' })).toBe('org-c');
    expect(devicePolicyCacheOrg(DEVICE, undefined)).toBeNull();
  });

  it('throws when the caller org contradicts the hierarchy org', () => {
    expect(() => devicePolicyCacheOrg(DEVICE, { hierarchy: hierarchy('org-a'), orgId: 'org-b' }))
      .toThrow(DevicePolicyCacheOrgMismatchError);
  });
});

describe('read/write', () => {
  it('serves an entry only to the org it was written for', async () => {
    await writeDevicePolicyCache('pam', DEVICE, 'org-a', { uacInterceptionEnabled: true }, 120);
    expect(m.redis!.set).toHaveBeenCalledWith('pam:settings:v2:device:dev-1', JSON.stringify({ orgId: 'org-a', settings: { uacInterceptionEnabled: true } }), 'EX', 120);
    expect(await readDevicePolicyCache('pam', DEVICE, 'org-a')).toEqual({ uacInterceptionEnabled: true });
    expect(await readDevicePolicyCache('pam', DEVICE, 'org-b')).toBeNull();
  });

  it('never reads the pre-#8257 unbound key, and treats a bare value under the new key as a miss', async () => {
    m.store.set('pam:settings:device:dev-1', JSON.stringify({ uacInterceptionEnabled: true }));
    expect(await readDevicePolicyCache('pam', DEVICE, 'org-a')).toBeNull();
    m.store.set('pam:settings:v2:device:dev-1', JSON.stringify({ uacInterceptionEnabled: true }));
    expect(await readDevicePolicyCache('pam', DEVICE, 'org-a')).toBeNull();
  });

  it('writes a key an API replica on the previous release never reads (rolling deploy)', async () => {
    await writeDevicePolicyCache('helper', DEVICE, 'org-a', { enabled: true }, 120);
    expect(m.store.has('helper:settings:device:dev-1')).toBe(false);
    expect(m.store.has('helper:settings:v2:device:dev-1')).toBe(true);
  });

  it('neither reads nor writes without an org', async () => {
    await writeDevicePolicyCache('pam', DEVICE, null, { uacInterceptionEnabled: true }, 120);
    expect(m.redis!.set).not.toHaveBeenCalled();
    expect(await readDevicePolicyCache('pam', DEVICE, null)).toBeNull();
    expect(m.redis!.get).not.toHaveBeenCalled();
  });

  it('a Redis error or a failed parse is a miss, never a throw', async () => {
    m.redis!.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await readDevicePolicyCache('pam', DEVICE, 'org-a')).toBeNull();
    m.redis!.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(writeDevicePolicyCache('pam', DEVICE, 'org-a', {}, 120)).resolves.toBeUndefined();

    await writeDevicePolicyCache('hwmon', DEVICE, 'org-a', { bogus: true }, 120);
    const parse = () => { throw new Error('invalid'); };
    expect(await readDevicePolicyCache('hwmon', DEVICE, 'org-a', parse)).toBeNull();
  });

  it('no Redis configured: a miss', async () => {
    m.redis = null;
    expect(await readDevicePolicyCache('pam', DEVICE, 'org-a')).toBeNull();
  });
});

describe('invalidateDevicePolicyCaches', () => {
  it('deletes every device-keyed policy cache entry for the device, and only that device', async () => {
    for (const key of [...allDevicePolicyCacheKeys(DEVICE), ...allDevicePolicyCacheKeys('dev-2')]) m.store.set(key, '{}');
    await invalidateDevicePolicyCaches(DEVICE);
    expect([...m.store.keys()].sort()).toEqual(allDevicePolicyCacheKeys('dev-2').sort());
    // Org-bound, legacy unbound (an older replica), and self-bound keys.
    expect(allDevicePolicyCacheKeys('x').sort()).toEqual([
      'helper:settings:v2:device:x', 'eventlog:settings:v2:device:x', 'hwmon:settings:v2:device:x',
      'monitoring:settings:v2:device:x', 'pam:settings:v2:device:x',
      'helper:settings:device:x', 'eventlog:settings:device:x', 'hwmon:settings:device:x',
      'monitoring:settings:device:x', 'pam:settings:device:x',
      'timesync:settings:device:x', 'workloads:settings:device:x',
    ].sort());
    expect(DEVICE_POLICY_CACHE_FEATURES.map((f) => devicePolicyCacheKey(f, 'x'))).toContain('pam:settings:v2:device:x');
  });

  it('swallows a Redis error (best-effort; the org binding still holds)', async () => {
    m.redis!.del.mockRejectedValueOnce(new Error('redis down'));
    await expect(invalidateDevicePolicyCaches(DEVICE)).resolves.toBeUndefined();
  });
});
