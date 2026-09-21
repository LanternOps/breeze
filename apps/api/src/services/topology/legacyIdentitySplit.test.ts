import { describe, expect, it } from 'vitest';
import { planLegacyIdentitySplits } from './legacyIdentitySplit';
import { legacyNodeIdentity } from './legacyProjection';
const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const deviceId = '00000000-0000-4000-8000-000000000003';
const assetId = '00000000-0000-4000-8000-000000000004';
const secondAssetId = '00000000-0000-4000-8000-000000000005';
const sourceNode = (table: 'devices' | 'discovered_assets', sourceId: string, createdAt: number) => ({ ...scope, ...legacyNodeIdentity(scope, table, sourceId), createdAt: new Date(createdAt), legacySourceType: table, legacySourceId: sourceId, aliasTargetId: null as string | null, lifecycle: 'active' as const, deletedAt: null });
const device = sourceNode('devices', deviceId, 1);
const asset = sourceNode('discovered_assets', assetId, 2);
const binding = (id: string, nodeId: string, reference: { deviceId?: string; discoveredAssetId?: string }) => ({ ...scope, id, nodeId, deviceId: reference.deviceId ?? null, discoveredAssetId: reference.discoveredAssetId ?? null, manualNodeId: null });
const assetRef = (id = assetId, linkedDeviceId: string | null = null, suppressedAt: Date | null = null) => ({ id, linkedDeviceId, suppressedAt });

describe('explicit retained-source identity splits', () => {
  it('reactivates the asset source UUID after unlink from an older device', () => {
    const plan = planLegacyIdentitySplits(scope, { nodes: [device, { ...asset, aliasTargetId: device.id }], bindings: [binding(deviceId, device.id, { deviceId }), binding(assetId, device.id, { discoveredAssetId: assetId })], liveDeviceIds: new Set([deviceId]), liveAssets: [assetRef()] });
    expect(plan.nodeChanges).toEqual([{ id: asset.id, aliasTargetId: null }]);
    expect(plan.bindingMoves).toEqual([{ id: assetId, fromNodeId: device.id, toNodeId: asset.id, deviceId: null, discoveredAssetId: assetId }]);
  });
  it('leaves accepted links unchanged and treats suppression as explicit revocation', () => {
    const input = { nodes: [device, { ...asset, aliasTargetId: device.id }], bindings: [binding(deviceId, device.id, { deviceId }), binding(assetId, device.id, { discoveredAssetId: assetId })], liveDeviceIds: new Set([deviceId]), liveAssets: [assetRef(assetId, deviceId)] };
    expect(planLegacyIdentitySplits(scope, input).nodeChanges).toEqual([]);
    expect(planLegacyIdentitySplits(scope, { ...input, liveAssets: [assetRef(assetId, deviceId, new Date())] }).bindingMoves).toHaveLength(1);
  });
  it('splits the remaining accepted component when the oldest asset is unlinked', () => {
    const oldestAsset = { ...asset, createdAt: new Date(0) };
    const second = { ...sourceNode('discovered_assets', secondAssetId, 3), aliasTargetId: asset.id };
    const plan = planLegacyIdentitySplits(scope, { nodes: [oldestAsset, { ...device, aliasTargetId: asset.id }, second], bindings: [binding(deviceId, asset.id, { deviceId }), binding(assetId, asset.id, { discoveredAssetId: assetId }), binding(secondAssetId, asset.id, { discoveredAssetId: secondAssetId })], liveDeviceIds: new Set([deviceId]), liveAssets: [assetRef(), assetRef(secondAssetId, deviceId)] });
    expect(plan.nodeChanges).toContainEqual({ id: device.id, aliasTargetId: null });
    expect(plan.nodeChanges).toContainEqual({ id: second.id, aliasTargetId: device.id });
    expect(plan.bindingMoves.map(move => move.id).sort()).toEqual([deviceId, secondAssetId].sort());
  });
  it('detects a departed canonical source after its binding was already detached', () => {
    const plan = planLegacyIdentitySplits(scope, { nodes: [device, { ...asset, aliasTargetId: device.id }], bindings: [binding(assetId, device.id, { discoveredAssetId: assetId })], liveDeviceIds: new Set<string>(), liveAssets: [assetRef(assetId, deviceId)] });
    expect(plan.nodeChanges).toEqual([{ id: asset.id, aliasTargetId: null }]);
    expect(plan.bindingMoves[0]!.toNodeId).toBe(asset.id);
  });
  it('does not restore a source tombstone when the accepted association itself is unchanged', () => {
    const plan = planLegacyIdentitySplits(scope, { nodes: [device, { ...asset, aliasTargetId: device.id, lifecycle: 'withdrawn', deletedAt: new Date(0) }],
      bindings: [binding(deviceId, device.id, { deviceId })], liveDeviceIds: new Set([deviceId]), liveAssets: [assetRef(assetId, deviceId)] });
    // Current same-UUID inventory alone does not replace the advancing source
    // event required by replay's durable legacySourceRevision fence.
    expect(plan.nodeChanges).toEqual([]);
    expect(plan.clusters).toEqual([]);
  });
  it('does not merge separate existing roots or infer association from missing source metadata', () => {
    const plan = planLegacyIdentitySplits(scope, { nodes: [device, asset], bindings: [binding(deviceId, device.id, { deviceId }), binding(assetId, asset.id, { discoveredAssetId: assetId })], liveDeviceIds: new Set([deviceId]), liveAssets: [assetRef(assetId, deviceId)] });
    expect(plan.nodeChanges).toEqual([]); expect(plan.bindingMoves).toEqual([]);
  });
  it('rejects foreign scoped nodes and alias cycles', () => {
    const base = { bindings: [], liveDeviceIds: new Set<string>(), liveAssets: [] };
    expect(() => planLegacyIdentitySplits(scope, { ...base, nodes: [{ ...device, siteId: deviceId }] })).toThrow(/scope/);
    expect(() => planLegacyIdentitySplits(scope, { ...base, nodes: [{ ...device, aliasTargetId: asset.id }, { ...asset, aliasTargetId: device.id }] })).toThrow(/cycle/);
  });
});
