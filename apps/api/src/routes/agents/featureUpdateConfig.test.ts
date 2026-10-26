/**
 * buildFeatureUpdateConfigUpdate — the heartbeat block that tells the agent
 * what its update ring decided about Windows feature releases. Everything
 * that is not a valid, linked ring resolves to block (fail closed): the agent
 * then filters feature releases out and reverts any pin Breeze wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolvePatchConfigPolicyForDeviceMock, loadPolicyLocalPatchConfigMock } = vi.hoisted(() => ({
  resolvePatchConfigPolicyForDeviceMock: vi.fn(),
  loadPolicyLocalPatchConfigMock: vi.fn(),
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolvePatchConfigPolicyForDevice: resolvePatchConfigPolicyForDeviceMock,
}));
vi.mock('../../services/configPolicyPatching', () => ({
  loadPolicyLocalPatchConfig: loadPolicyLocalPatchConfigMock,
}));

import { buildFeatureUpdateConfigUpdate, toFeatureUpdateSettingsWire } from './featureUpdateConfig';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const PIN = { mode: 'pin', product: 'windows-11', targetVersion: '25H2' } as const;

function policyLocal(ring: Record<string, unknown>) {
  return { configPolicyId: 'cp-1', ring: { classification: 'valid_ring', valid: true, ringId: 'ring-1', featureUpdates: PIN, ...ring } };
}

describe('buildFeatureUpdateConfigUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue({ configPolicyId: 'cp-1' });
  });

  it('returns block when the device has no patch policy', async () => {
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue(null);
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID)).toEqual({ mode: 'block' });
    expect(loadPolicyLocalPatchConfigMock).not.toHaveBeenCalled();
  });

  it('returns block when the policy links no ring', async () => {
    loadPolicyLocalPatchConfigMock.mockResolvedValue(policyLocal({ classification: 'null', ringId: null, featureUpdates: { mode: 'block' } }));
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID)).toEqual({ mode: 'block' });
  });

  it('returns block when the ring reference is invalid, even if a policy value leaked through', async () => {
    loadPolicyLocalPatchConfigMock.mockResolvedValue(policyLocal({ classification: 'disabled_ring', valid: false, ringId: null, featureUpdates: { mode: 'allow' } }));
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID)).toEqual({ mode: 'block' });
  });

  it('returns block when the policy-local config cannot be loaded', async () => {
    loadPolicyLocalPatchConfigMock.mockResolvedValue(null);
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID)).toEqual({ mode: 'block' });
  });

  it('returns the linked ring policy verbatim and forwards the hierarchy opts to the resolver', async () => {
    loadPolicyLocalPatchConfigMock.mockResolvedValue(policyLocal({}));
    const opts = { hierarchy: { deviceId: DEVICE_ID } } as never;
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, opts)).toEqual(PIN);
    expect(resolvePatchConfigPolicyForDeviceMock).toHaveBeenCalledWith(DEVICE_ID, opts);
    expect(loadPolicyLocalPatchConfigMock).toHaveBeenCalledWith('cp-1');
  });
});

describe('toFeatureUpdateSettingsWire', () => {
  it('writes snake_case inside the block and drops pin fields for block/allow', () => {
    expect(toFeatureUpdateSettingsWire({ mode: 'block' })).toEqual({ mode: 'block' });
    expect(toFeatureUpdateSettingsWire({ mode: 'allow' })).toEqual({ mode: 'allow' });
    expect(toFeatureUpdateSettingsWire(PIN)).toEqual({ mode: 'pin', product: 'windows-11', target_version: '25H2' });
  });
});
