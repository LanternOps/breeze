import { describe, it, expect } from 'vitest';
import { applyHelperDeviceScope, HELPER_TOOL_SCOPING, verifyDeviceAccess } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const HELPER_DEVICE = '11111111-1111-1111-1111-111111111111';
const OTHER_DEVICE = '22222222-2222-2222-2222-222222222222';

describe('applyHelperDeviceScope', () => {
  it('forces deviceId to the helper device, overriding a forged value', () => {
    const r = applyHelperDeviceScope('get_device_details', { deviceId: OTHER_DEVICE }, HELPER_DEVICE);
    expect('input' in r && r.input).toEqual({ deviceId: HELPER_DEVICE });
  });

  it('injects deviceId when the caller omitted it', () => {
    const r = applyHelperDeviceScope('analyze_metrics', {}, HELPER_DEVICE);
    expect('input' in r && r.input).toEqual({ deviceId: HELPER_DEVICE });
  });

  it('forces deviceIds to [helperDevice] for array-shaped tools', () => {
    const r = applyHelperDeviceScope('search_logs', { deviceIds: [OTHER_DEVICE], level: ['error'] }, HELPER_DEVICE);
    expect('input' in r && r.input).toEqual({ deviceIds: [HELPER_DEVICE], level: ['error'] });
  });

  it('denies an org-wide tool not in the scoping map', () => {
    const r = applyHelperDeviceScope('query_devices', {}, HELPER_DEVICE);
    expect('error' in r).toBe(true);
  });

  it('every scoped tool maps to a known device field name', () => {
    for (const field of Object.values(HELPER_TOOL_SCOPING)) {
      expect(['deviceId', 'deviceIds']).toContain(field);
    }
  });
});

function helperAuth(deviceId: string): AuthContext {
  return {
    user: { id: deviceId, email: 'h', name: 'h', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    helperDeviceId: deviceId,
  };
}

describe('verifyDeviceAccess helper lock', () => {
  it('denies a device other than helperDeviceId without touching the DB', async () => {
    const res = await verifyDeviceAccess(OTHER_DEVICE, helperAuth(HELPER_DEVICE));
    expect('error' in res).toBe(true);
  });
});
