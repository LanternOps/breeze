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

vi.mock('../../services/featureConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/featureConfigResolver')>();
  return { ...actual, resolvePatchConfigPolicyForDevice: resolvePatchConfigPolicyForDeviceMock };
});
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../services/configPolicyPatching', () => ({
  loadPolicyLocalPatchConfig: loadPolicyLocalPatchConfigMock,
}));

import { buildFeatureUpdateConfigUpdate, toFeatureUpdateSettingsWire } from './featureUpdateConfig';
import { groupPolicySetRows, withPolicySet, type PolicySetRow } from '../../services/devicePolicySet';
import type { DeviceHierarchy } from '../../services/deviceHierarchy';

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

describe("buildFeatureUpdateConfigUpdate — from the heartbeat's policy set (no extra statement)", () => {
  const ORG = 'org-1';
  const PARTNER = 'partner-1';
  const hierarchy: DeviceHierarchy = {
    deviceId: DEVICE_ID, orgId: ORG, siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
    org: { partnerId: PARTNER, type: 'customer' }, site: null, groupIds: [],
  };
  const ring = (over: Record<string, unknown> = {}) => ({
    id: 'ring-1', kind: 'ring' as const, enabled: true, partnerId: PARTNER, featureUpdates: PIN, ...over,
  });
  const patchRow = (over: Partial<PolicySetRow> = {}): PolicySetRow => ({
    assignmentId: 'a-1', level: 'organization', targetId: ORG, priority: 0, roleFilter: null, osFilter: null,
    assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'), policyId: 'p-1', policyName: 'Workstations',
    policyOrgId: ORG, policyPartnerId: null, parentPolicyId: null, linkId: 'l-1', featureType: 'patch',
    featurePolicyId: 'ring-1', inlineSettings: null, eventLog: null, hardwareMonitoring: null,
    patch: { id: 'ps-1', exclusiveWindowsUpdate: false }, ring: ring(), timeSync: null, onedrive: null,
    ...over,
  });
  const optsFor = (rows: PolicySetRow[]) => withPolicySet(groupPolicySetRows(hierarchy, rows), hierarchy);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the winning patch link\'s ring policy without touching the resolver', async () => {
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([patchRow()]))).toEqual(PIN);
    expect(resolvePatchConfigPolicyForDeviceMock).not.toHaveBeenCalled();
    expect(loadPolicyLocalPatchConfigMock).not.toHaveBeenCalled();
  });

  it('returns block when no patch policy applies, or the winner links no ring', async () => {
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([]))).toEqual({ mode: 'block' });
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([patchRow({ featurePolicyId: null, ring: null })]))).toEqual({ mode: 'block' });
  });

  it('returns block for a disabled ring, a non-ring row, another partner\'s ring, or a malformed value', async () => {
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([patchRow({ ring: ring({ enabled: false }) })]))).toEqual({ mode: 'block' });
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([patchRow({ ring: ring({ kind: 'legacy' }) })]))).toEqual({ mode: 'block' });
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([patchRow({ ring: ring({ partnerId: 'someone-else' }) })]))).toEqual({ mode: 'block' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([patchRow({ ring: ring({ featureUpdates: { mode: 'latest' } }) })]))).toEqual({ mode: 'block' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed feature_updates'));
    warn.mockRestore();
  });

  it('picks the closest assignment level, like the patch resolver', async () => {
    const orgLevel = patchRow({ assignmentId: 'a-org', ring: ring({ id: 'ring-org', featureUpdates: { mode: 'allow' } }), featurePolicyId: 'ring-org' });
    const deviceLevel = patchRow({
      assignmentId: 'a-dev', level: 'device', targetId: DEVICE_ID, policyId: 'p-2', linkId: 'l-2',
      ring: ring({ id: 'ring-dev', featureUpdates: { mode: 'block' } }), featurePolicyId: 'ring-dev',
    });
    expect(await buildFeatureUpdateConfigUpdate(DEVICE_ID, optsFor([orgLevel, deviceLevel]))).toEqual({ mode: 'block' });
  });
});

describe('toFeatureUpdateSettingsWire', () => {
  it('writes snake_case inside the block and drops pin fields for block/allow', () => {
    expect(toFeatureUpdateSettingsWire({ mode: 'block' })).toEqual({ mode: 'block' });
    expect(toFeatureUpdateSettingsWire({ mode: 'allow' })).toEqual({ mode: 'allow' });
    expect(toFeatureUpdateSettingsWire(PIN)).toEqual({ mode: 'pin', product: 'windows-11', target_version: '25H2' });
  });
});
