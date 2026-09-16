import type { TopologyScope } from '@breeze/shared';
import { planCanonicalCluster, type MergeNode, type MergePosition } from './identity';

type AliasNode = MergeNode & { kind: string };
type AliasBinding = { nodeId: string; deviceId?: string | null; discoveredAssetId?: string | null; manualNodeId?: string | null };
type AcceptedAsset = { id: string; linkedDeviceId: string | null; autoLinkSuppressedAt: Date | null };
type AliasRequest = { sourceId: string; targetId: string };

/** Requests refer to current roots (existing aliases are already resolved).
 * Establish the complete accepted component before selecting its winner or
 * transferring references. No partially merged intermediate state is exposed. */
export function planAcceptedAliasClusters(scope: TopologyScope, input: {
  nodes: AliasNode[]; requests: AliasRequest[]; bindings: AliasBinding[]; assets: AcceptedAsset[]; positions: MergePosition[];
}) {
  const byId = new Map(input.nodes.map(n => [n.id, n]));
  const targets = new Map<string, string>();
  const neighbors = new Map<string, Set<string>>();
  for (const request of input.requests) {
    if (request.sourceId === request.targetId) throw new Error('Canonical alias cannot reference itself');
    if (targets.has(request.sourceId)) throw new Error('Duplicate canonical alias request');
    targets.set(request.sourceId, request.targetId);
    for (const [id, other] of [[request.sourceId, request.targetId], [request.targetId, request.sourceId]] as const) {
      if (byId.get(id)?.kind !== 'endpoint') throw new Error('Invalid canonical alias target');
      if (!neighbors.has(id)) neighbors.set(id, new Set());
      neighbors.get(id)!.add(other);
    }
  }
  // Reject cycles in the requested direction even though component discovery
  // below is undirected. Long chains use iteration rather than recursion.
  const checked = new Set<string>();
  for (const start of targets.keys()) {
    const path = new Set<string>();
    let id: string | undefined = start;
    while (id !== undefined && !checked.has(id)) {
      if (path.has(id)) throw new Error('Canonical alias cycle');
      path.add(id); id = targets.get(id);
    }
    for (const member of path) checked.add(member);
  }
  const byNode = new Map<string, AliasBinding[]>();
  for (const binding of input.bindings) {
    if (!byNode.has(binding.nodeId)) byNode.set(binding.nodeId, []);
    byNode.get(binding.nodeId)!.push(binding);
  }
  const assets = new Map(input.assets.map(a => [a.id, a]));
  const positionsByNode = new Map<string, MergePosition[]>();
  for (const position of input.positions) {
    if (!positionsByNode.has(position.nodeId)) positionsByNode.set(position.nodeId, []);
    positionsByNode.get(position.nodeId)!.push(position);
  }
  const visited = new Set<string>();
  const clusters: ReturnType<typeof planCanonicalCluster>[] = [];
  for (const start of [...neighbors.keys()].sort()) {
    if (visited.has(start)) continue;
    const ids: string[] = [];
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id); ids.push(id);
      for (const neighbor of neighbors.get(id)!) if (!visited.has(neighbor)) pending.push(neighbor);
    }
    const bindings = ids.flatMap(id => byNode.get(id) ?? []);
    const managed = bindings.filter(b => b.deviceId);
    // One valid pair cannot authorize unrelated/unbound nodes to piggyback on
    // its identity. Every root contributes a current accepted inventory ref.
    if (managed.length !== 1 || ids.some(id => !byNode.get(id)?.length) || bindings.some(b => b.manualNodeId)
      || bindings.filter(b => b.discoveredAssetId).some(b => {
        const asset = assets.get(b.discoveredAssetId!);
        return !asset || asset.autoLinkSuppressedAt || asset.linkedDeviceId !== managed[0]!.deviceId;
      })) throw new Error('Canonical alias requires an accepted inventory link');
    clusters.push(planCanonicalCluster(scope, ids.map(id => byId.get(id)!), ids.flatMap(id => positionsByNode.get(id) ?? [])));
  }
  return clusters;
}
