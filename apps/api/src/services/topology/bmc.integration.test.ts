import '../../__tests__/integration/setup';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/integration/setup';
import { bmcFixture } from '../discovery/bmc.fixtures';
import { discoveredAssets, topologySiteState, topologyNodes, topologyNodeBindings } from '../../db/schema';
import { publishTopologyBuild, type NodePublication, type PublicationInput } from './publish';
import { canonicalIdentityKey } from './identity';

async function publication(source: 'agent_report' | 'manual' | 'auto', mode: 'alias' | 'shared') {
  const f = await bmcFixture();
  await getTestDb().update(discoveredAssets).set({ linkedDeviceId: f.device.id, linkSource: source }).where(eq(discoveredAssets.id, f.asset.id));
  await getTestDb().insert(topologySiteState).values({ ...f.scope, buildFence: 0n, dirtyRevision: 1n, materializedInputRevision: 0n })
    .onConflictDoUpdate({ target: [topologySiteState.orgId, topologySiteState.siteId], set: { buildFence: 0n, dirtyRevision: 1n, materializedInputRevision: 0n } });
  const node = (sourceKey: string): NodePublication => ({ id: crypto.randomUUID(), ...f.scope, kind: 'endpoint',
    identityKey: canonicalIdentityKey(f.scope, 'endpoint', sourceKey), identityMaterial: { version: 1, kind: 'endpoint', sourceKey }, attributes: {} });
  const host = node(`device:${f.device.id}`), bmc = node(`asset:${f.asset.id}`);
  const input: PublicationInput = { buildFence: '0', inputRevision: '1', relationships: [],
    nodes: mode === 'alias' ? [host, { ...bmc, aliasTargetId: host.id }] : [host],
    bindings: [{ id: crypto.randomUUID(), ...f.scope, nodeId: host.id, deviceId: f.device.id },
      { id: crypto.randomUUID(), ...f.scope, nodeId: mode === 'alias' ? bmc.id : host.id, discoveredAssetId: f.asset.id }],
  };
  return { f, input };
}
it.each(['alias', 'shared'] as const)('rejects agent_report %s authority atomically', async mode => {
  const { f, input } = await publication('agent_report', mode);
  const before = (await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, f.siteId)))[0]!;
  await expect(f.scoped(() => publishTopologyBuild(f.scope, input))).rejects.toThrow(mode === 'alias' ? 'Canonical alias requires an accepted inventory link' : 'Shared endpoint bindings require an accepted inventory link');
  expect(await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.siteId, f.siteId))).toEqual([]);
  expect(await getTestDb().select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.siteId))).toEqual([]);
  const after = (await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, f.siteId)))[0]!;
  expect(after.graphRevision).toBe(before.graphRevision);
  expect(after.materializedInputRevision).toBe(before.materializedInputRevision);
});
it.each(['manual', 'auto'] as const)('still accepts %s identity authority', async source => {
  const { f, input } = await publication(source, 'shared');
  expect(await f.scoped(() => publishTopologyBuild(f.scope, input))).toMatchObject({ published: true });
});
