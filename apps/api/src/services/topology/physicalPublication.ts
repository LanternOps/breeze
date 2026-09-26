import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import type { db } from '../../db';
import { topologySiteState } from '../../db/schema';
import { physicalAuthorityOf, buildPhysicalIdentityIndex, physicalLinkKey, sortedLinkEndpoints, interfaceContinuity, isPhysicalGeneration, physicalGenerationNumber, physicalTargetSourceKey, resolvePhysicalSubjectAsset, type PhysicalChassisClaim, type PhysicalIdentityIndex } from './physicalIdentity';
import { buildPhysicalRelationship, physicalMaterialOf, planPhysicalResolution, selectFdbParents, unboundPhysicalNode, unifiEndpointNode, unifiMaterialOf, type FdbCandidate } from './physicalProjector';
import { canonicalIdentityKey } from './identity';
import type { CollectionSource, InterfacePublication, PhysicalProjectionContext, SupportPublication } from './reconciliationTypes';
import type { BindingPublication, NodePublication, RelationshipPublication } from './publish';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const PHYSICAL_PROTOCOLS = new Set(['lldp', 'cdp', 'fdb', 'snmp_interfaces', 'unifi_device_list', 'unifi_client_list', 'unifi_device_details', 'unifi_statistics']);
export const isPhysicalProtocol = (protocol: string) => PHYSICAL_PROTOCOLS.has(protocol);
const PHYSICAL_METHODS = new Set(['lldp', 'cdp', 'fdb', 'unifi']);
export const isPhysicalRelationship = (row: Pick<RelationshipPublication, 'attributes' | 'evidenceClass'>) =>
  row.evidenceClass !== 'manual' && PHYSICAL_METHODS.has(String((row.attributes as { method?: string } | undefined)?.method));

/** Identity inputs the physical projector may trust, loaded once per publication. */
export type PhysicalPublicationContext = {
  identityRevision: bigint; resolvedIdentityRevision: bigint;
  assets: { id: string; ipAddress: string | null }[];
  deviceMacs: { deviceId: string; mac: string }[];
};
export async function loadPhysicalPublicationContext(tx: Tx, scope: TopologyScope): Promise<PhysicalPublicationContext> {
  const [state] = await tx.select({ identityRevision: topologySiteState.identityRevision, resolvedIdentityRevision: topologySiteState.resolvedIdentityRevision })
    .from(topologySiteState).where(sql`org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
  const assets = await tx.execute<{ id: string; ip_address: string | null }>(sql`SELECT id::text AS id, host(ip_address) AS ip_address FROM discovered_assets
    WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND ip_address IS NOT NULL`);
  // D16: only agent-reported NIC MACs of devices bound in this site; never a
  // discovered-asset MAC (UniFi telemetry may have written it).
  const macs = await tx.execute<{ device_id: string; mac_address: string }>(sql`SELECT n.device_id::text AS device_id, n.mac_address FROM device_network n
    JOIN topology_node_bindings b ON b.device_id=n.device_id AND b.org_id=${scope.orgId}::uuid AND b.site_id=${scope.siteId}::uuid
    WHERE n.org_id=${scope.orgId}::uuid AND n.mac_address IS NOT NULL`);
  return { identityRevision: state?.identityRevision ?? 0n, resolvedIdentityRevision: state?.resolvedIdentityRevision ?? 0n,
    assets: assets.map(a => ({ id: a.id, ipAddress: a.ip_address })), deviceMacs: macs.map(m => ({ deviceId: m.device_id, mac: m.mac_address })) };
}

export type PhysicalResolver = {
  resolveNode: (id: string) => string;
  projectionContext: (source: Pick<CollectionSource, 'contextKey'>) => PhysicalProjectionContext;
  subjectFor: (authorityKey: string) => string | null;
  index: (interfaces: Iterable<InterfacePublication>) => PhysicalIdentityIndex;
  /** Breeze device id -> current (alias-resolved) inventory node. */
  deviceNodes: Record<string, string>;
  /** Current UniFi endpoint bindings; refreshed by the publisher as UniFi baselines change. */
  unifiEndpointDevices: Record<string, string>;
  /** Targets' own LLDP chassis claims; refreshed by the publisher as interface baselines change. */
  chassisIds: PhysicalChassisClaim[];
};
export function physicalResolver(context: PhysicalPublicationContext, nodes: Map<string, NodePublication>, bindings: BindingPublication[]): PhysicalResolver {
  const resolveNode = (id: string) => { const seen = new Set<string>(); while (nodes.get(id)?.aliasTargetId && !seen.has(id)) { seen.add(id); id = nodes.get(id)!.aliasTargetId!; } return id; };
  const assetNode = new Map<string, string>(); const deviceNode = new Map<string, string>();
  for (const b of bindings) { if (b.discoveredAssetId) assetNode.set(b.discoveredAssetId, b.nodeId); if (b.deviceId) deviceNode.set(b.deviceId, b.nodeId); }
  const subjectFor = (authorityKey: string) => { const asset = resolvePhysicalSubjectAsset(authorityKey, context.assets); const node = asset ? assetNode.get(asset) : undefined; return node ? resolveNode(node) : null; };
  const deviceMacs = context.deviceMacs.flatMap(m => deviceNode.has(m.deviceId) ? [{ nodeId: resolveNode(deviceNode.get(m.deviceId)!), mac: m.mac }] : []);
  const deviceNodes = Object.fromEntries([...deviceNode].map(([deviceId, nodeId]) => [deviceId, resolveNode(nodeId)]));
  const resolver: PhysicalResolver = { resolveNode, subjectFor, deviceNodes, unifiEndpointDevices: {}, chassisIds: [],
    index: interfaces => buildPhysicalIdentityIndex({ interfaces, deviceMacs, chassisIds: resolver.chassisIds, resolveNode }),
    projectionContext: source => { const authorityKey = physicalAuthorityOf(source.contextKey);
      return { authorityKey, subjectNodeId: subjectFor(authorityKey), deviceMacs, deviceNodes, unifiEndpointDevices: resolver.unifiEndpointDevices, chassisIds: resolver.chassisIds }; } };
  return resolver;
}

/**
 * Physical rows re-observed with a different projection replace, rather than
 * accumulate, their row mapping. With resolution and interface generations a
 * present row can legitimately point at another relationship (a new generation
 * is never inherited); the old one keeps no support from this row. Absent rows
 * are untouched: withdrawal of missing rows stays M1's second-miss path.
 */
export function replacePresentRows(rowRelationships: Record<string, string[]>, present: string[], projected: Map<string, string[]>): { next: Record<string, string[]>; released: string[] } {
  const next = { ...rowRelationships };
  const before = present.flatMap(key => rowRelationships[key] ?? []);
  for (const key of present) { const ids = projected.get(key); if (ids?.length) next[key] = [...new Set(ids)]; else delete next[key]; }
  const mapped = new Set(Object.values(next).flat());
  return { next, released: [...new Set(before)].filter(id => !mapped.has(id)) };
}

/**
 * Bounded row mappings (M2 Task 6b item 8). A mapping is only needed while its
 * row can still withdraw or revive support: the key is present, still known to
 * ingest (`_knownKeys`, so a later miss can name it), inside a pending miss
 * streak/transition (second-miss semantics), or mapped to this source's support
 * that is active or archived-but-revivable (same epoch and digest as the source,
 * i.e. a confirm of the retained snapshot can revive it). Anything else — a key
 * ingest pruned whose support is withdrawn, archived under another snapshot, or
 * gone — can never be touched again and is dropped, so partial-only physical
 * sources do not grow `_rowRelationships` toward the capacity check forever.
 */
export function pruneRowRelationships(input: { rows: Record<string, string[]>; source: { id: string; producerEpoch: string; contentDigest: string | null };
  knownKeys: string[]; present: string[]; pendingKeys: string[]; support: (relationshipId: string) => SupportPublication | undefined }): Record<string, string[]> {
  const keep = new Set([...input.knownKeys, ...input.present, ...input.pendingKeys]);
  const live = (id: string) => {
    const row = input.support(id);
    if (!row) return false;
    return row.lifecycle === 'active' || (row.lifecycle === 'archived' && row.producerEpoch === input.source.producerEpoch && row.contentDigest === input.source.contentDigest);
  };
  const drop = Object.entries(input.rows).filter(([key, ids]) => !keep.has(key) && !ids.some(live)).map(([key]) => key);
  if (!drop.length) return input.rows;
  const next = { ...input.rows };
  for (const key of drop) delete next[key];
  return next;
}

const RANK = { active: 2, archived: 1, withdrawn: 0 } as const;
/** Destination collision: one source supports both. Keep the more alive, newer row;
 * never renew freshness or revive — timestamps are the sources' own. */
export function mergeSupportRows(a: SupportPublication, b: SupportPublication): SupportPublication {
  const rank = (s: SupportPublication) => RANK[(s.lifecycle ?? 'active') as keyof typeof RANK] ?? 0;
  const newer = (x: SupportPublication, y: SupportPublication) => BigInt(x.sequence) !== BigInt(y.sequence) ? BigInt(x.sequence) > BigInt(y.sequence) : x.lastPositiveAt.getTime() >= y.lastPositiveAt.getTime();
  const base = rank(a) !== rank(b) ? (rank(a) > rank(b) ? a : b) : (newer(a, b) ? a : b);
  const first = a.firstPositiveAt.getTime() <= b.firstPositiveAt.getTime() ? a.firstPositiveAt : b.firstPositiveAt;
  return { ...base, firstPositiveAt: first };
}

export type PhysicalPassState = {
  scope: TopologyScope; at: Date;
  sources: Map<string, CollectionSource>;
  support: Map<string, SupportPublication>; changedSupport: Set<string>;
  relationships: Map<string, RelationshipPublication>; nodes: Map<string, NodePublication>; interfaces: Map<string, InterfacePublication>;
  baselines: Map<string, Record<string, unknown>>;
  /** Outputs */
  newNodes: NodePublication[]; touchedRelationships: Set<string>; archived: Set<string>; rekeyed: Set<string>;
  supportDeletes: { sourceId: string; relationshipId: string }[]; lifecycleRemaps: { sourceId: string; from: string; to: string }[];
  observationRemaps: { sourceId: string; from: string; to: string }[]; remappedBaselines: Set<string>;
};

function moveSupport(state: PhysicalPassState, fromId: string, toId: string): boolean {
  let moved = false;
  for (const [key, row] of [...state.support]) {
    if (row.relationshipId !== fromId || row.lifecycle === 'withdrawn') continue;
    const source = state.sources.get(row.sourceId);
    if (!source || source.revokedAt) continue;
    const dest = `${row.sourceId}:${toId}`;
    const existing = state.support.get(dest);
    const next = { ...row, relationshipId: toId };
    state.support.set(dest, existing ? mergeSupportRows(existing, next) : next);
    state.changedSupport.add(dest);
    state.support.delete(key); state.changedSupport.delete(key);
    state.supportDeletes.push({ sourceId: row.sourceId, relationshipId: fromId });
    state.lifecycleRemaps.push({ sourceId: row.sourceId, from: fromId, to: toId });
    state.observationRemaps.push({ sourceId: row.sourceId, from: fromId, to: toId });
    const baseline = state.baselines.get(row.sourceId);
    const rows = baseline?._rowRelationships as Record<string, string[]> | undefined;
    if (baseline && rows) {
      baseline._rowRelationships = Object.fromEntries(Object.entries(rows).map(([k, ids]) => [k, [...new Set(ids.map(id => id === fromId ? toId : id))]]));
      state.remappedBaselines.add(row.sourceId);
    }
    moved = true;
  }
  if (moved) { state.touchedRelationships.add(fromId); state.touchedRelationships.add(toId); state.archived.add(fromId); }
  return moved;
}

/**
 * D15.2 + D15.5: recompute every supported physical row relationship from its
 * durable material (candidates) or current endpoints (measured links). A
 * resolution that changes identity MOVES active and archived support with
 * lifecycle, freshness, miss counts, epoch and digest unchanged, remaps row
 * mappings and pending lifecycle ids, merges destination collisions, deletes the
 * old support keys and archives the source relationship. A measured link whose
 * endpoint ids changed after a merge is rekeyed in place (same id), or merged
 * into an existing link with the new key.
 */
export function reresolvePhysicalRelationships(state: PhysicalPassState, resolver: PhysicalResolver) {
  const index = resolver.index(state.interfaces.values());
  const byKey = new Map([...state.relationships.values()].map(r => [r.canonicalKey, r]));
  const supported = new Set([...state.support.values()].filter(s => s.lifecycle !== 'withdrawn').map(s => s.relationshipId));
  const upsert = (row: RelationshipPublication) => { state.relationships.set(row.id, row); byKey.set(row.canonicalKey, row); state.touchedRelationships.add(row.id); };
  for (const row of [...state.relationships.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!supported.has(row.id) || !isPhysicalRelationship(row) || state.archived.has(row.id)) continue;
    if (row.kind === 'physical_link') {
      if (!row.sourceInterfaceId || !row.targetInterfaceId || !row.identityMaterial.sourceKey.startsWith('physical-link-v1:')) continue;
      const source = { nodeId: resolver.resolveNode(row.sourceNodeId), interfaceId: row.sourceInterfaceId };
      const target = { nodeId: resolver.resolveNode(row.targetNodeId), interfaceId: row.targetInterfaceId };
      const sourceKey = physicalLinkKey(source, target);
      if (sourceKey === row.identityMaterial.sourceKey) continue;
      const canonicalKey = canonicalIdentityKey(state.scope, 'physical_link', sourceKey);
      const existing = byKey.get(canonicalKey);
      if (existing && existing.id !== row.id) { moveSupport(state, row.id, existing.id); continue; }
      const [first, second] = sortedLinkEndpoints(source, target);
      upsert({ ...row, canonicalKey, identityMaterial: { version: 1, kind: 'physical_link', sourceKey },
        sourceNodeId: first.nodeId, sourceInterfaceId: first.interfaceId, targetNodeId: second.nodeId, targetInterfaceId: second.interfaceId });
      state.rekeyed.add(row.id);
      continue;
    }
    const unifi = unifiMaterialOf(row);
    if (unifi) {
      // Identity is the association; a binding change only retargets it in place.
      const endpoint = (endpointKey: string) => {
        const resolved = unifiEndpointNode({ scope: state.scope, endpointKey, inventoryDeviceId: null, context: resolver, nodes: state.nodes, at: state.at });
        if (resolved.created && !state.nodes.has(resolved.id)) { state.nodes.set(resolved.id, resolved.created); state.newNodes.push(resolved.created); }
        return resolved.id;
      };
      const sourceNodeId = endpoint(unifi.uplinkEndpointKey), targetNodeId = endpoint(unifi.endpointKey);
      if (sourceNodeId !== targetNodeId && (sourceNodeId !== resolver.resolveNode(row.sourceNodeId) || targetNodeId !== resolver.resolveNode(row.targetNodeId))) upsert({ ...row, sourceNodeId, targetNodeId });
      continue;
    }
    const material = physicalMaterialOf(row);
    if (!material) continue;
    const subject = resolver.subjectFor(material.subjectAuthority);
    const subjectNode = subject ?? unboundPhysicalNode(state.scope, physicalTargetSourceKey(material.subjectAuthority), material.subjectAuthority, state.nodes, state.at);
    const subjectId = typeof subjectNode === 'string' ? subjectNode : subjectNode.id;
    const plan = planPhysicalResolution(material, subjectId, index);
    if (plan.kind === 'skip') continue;
    let target = plan.kind === 'link' ? plan.b.nodeId : plan.targetNodeId;
    if (!target && plan.kind === 'candidate') {
      const node = unboundPhysicalNode(state.scope, plan.unboundSourceKey, undefined, state.nodes, state.at);
      if (!state.nodes.has(node.id)) { state.nodes.set(node.id, node); state.newNodes.push(node); }
      target = node.id;
    }
    if (typeof subjectNode !== 'string' && !state.nodes.has(subjectNode.id)) { state.nodes.set(subjectNode.id, subjectNode); state.newNodes.push(subjectNode); }
    const draft = buildPhysicalRelationship(state.scope, material, plan, target!, undefined, row.lastSupportedAt ?? state.at);
    if (draft.canonicalKey === row.canonicalKey) {
      // Same identity: at most the remote endpoint became known (retarget in place).
      if (draft.targetNodeId !== row.targetNodeId || draft.sourceInterfaceId !== row.sourceInterfaceId || draft.attributes?.physical?.resolution !== row.attributes?.physical?.resolution) {
        upsert({ ...row, targetNodeId: draft.targetNodeId, sourceNodeId: draft.sourceNodeId, sourceInterfaceId: draft.sourceInterfaceId,
          attributes: { ...row.attributes, physical: { ...row.attributes?.physical, resolution: draft.attributes?.physical?.resolution } } });
      }
      continue;
    }
    const existing = byKey.get(draft.canonicalKey);
    const destination = existing ? { ...existing } : { ...draft, firstSupportedAt: row.firstSupportedAt ?? draft.firstSupportedAt, lastSupportedAt: row.lastSupportedAt ?? draft.lastSupportedAt };
    upsert(destination);
    moveSupport(state, row.id, destination.id);
  }
}

/** Candidates of FDB parent selection for the given clients. */
export function applyFdbSelection(input: {
  clients: Set<string>; relationships: Map<string, RelationshipPublication>; current: (id: string) => RelationshipPublication;
}): RelationshipPublication[] {
  if (!input.clients.size) return [];
  const all = [...input.relationships.keys()].map(input.current);
  const infrastructure = new Set(all.filter(r => r.kind === 'physical_link' && r.lifecycle === 'active' && !r.deletedAt).flatMap(r => [r.sourceInterfaceId, r.targetInterfaceId]).filter((v): v is string => !!v));
  const fdb = all.filter(r => r.attributes?.method === 'fdb' && r.kind === 'attachment' && input.clients.has(r.targetNodeId));
  const byClient = new Map<string, RelationshipPublication[]>();
  for (const row of fdb) byClient.set(row.targetNodeId, [...(byClient.get(row.targetNodeId) ?? []), row]);
  const changed: RelationshipPublication[] = [];
  for (const rows of byClient.values()) {
    const candidates: FdbCandidate[] = rows.map(r => {
      const physical = r.attributes?.physical;
      const port = r.sourceInterfaceId ?? `${physical?.localPort?.namespace}:${physical?.bridgeContext ?? '-'}:${physical?.localPort?.value}`;
      return { relationshipId: r.id, clientNodeId: r.targetNodeId, upstreamNodeId: r.sourceNodeId, portKey: `${r.sourceNodeId}:${port}`,
        vlanIds: physical?.vlanIds ?? null, active: r.lifecycle === 'active' && !r.deletedAt, infrastructure: !!r.sourceInterfaceId && infrastructure.has(r.sourceInterfaceId) };
    });
    const decisions = selectFdbParents(candidates);
    for (const row of rows) {
      const d = decisions.get(row.id)!;
      const physical = row.attributes?.physical ?? {};
      const alternatives = d.alternatives.length ? d.alternatives : undefined;
      if (physical.fdbSelection === d.selection && row.confidence === d.confidence && JSON.stringify(physical.alternativeRelationshipIds ?? null) === JSON.stringify(alternatives ?? null)) continue;
      const { alternativeRelationshipIds: _old, ...rest } = physical;
      changed.push({ ...row, confidence: d.confidence, attributes: { ...row.attributes, physical: { ...rest, fdbSelection: d.selection, ...(alternatives ? { alternativeRelationshipIds: alternatives } : {}) } } });
    }
  }
  return changed;
}

/**
 * UniFi endpointKey -> Breeze device id, from retained `unifi_device_list` /
 * `unifi_client_list` rows (the adapter's same-site NIC-MAC bindings, D16).
 * An endpoint claimed by two different devices binds nothing.
 */
export function unifiEndpointDevicesOf(baselines: Iterable<Record<string, unknown>>): Record<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const baseline of baselines) {
    const section = baseline.section as { kind?: string; rows?: unknown } | undefined;
    if (!section || (section.kind !== 'unifi_device_list' && section.kind !== 'unifi_client_list') || !Array.isArray(section.rows)) continue;
    for (const row of section.rows as { endpointKey?: unknown; inventoryDeviceId?: unknown }[]) {
      if (typeof row.endpointKey === 'string' && typeof row.inventoryDeviceId === 'string') claims.set(row.endpointKey, (claims.get(row.endpointKey) ?? new Set()).add(row.inventoryDeviceId));
    }
  }
  return Object.fromEntries([...claims].filter(([, ids]) => ids.size === 1).map(([key, ids]) => [key, [...ids][0]!]));
}

/**
 * Targets' own LLDP chassis ids (M2 Task 6b): from each live snmp_interfaces
 * baseline with a positive outcome, attributed to the node its authority
 * resolves to (`subjectFor`: the bound asset node, else the scoped unbound
 * target node). Trusted because it is the authorized target's report about itself.
 */
export function physicalChassisClaimsOf(entries: Iterable<{ source: Pick<CollectionSource, 'protocol' | 'contextKey' | 'revokedAt'>; baseline: Record<string, unknown> | undefined }>,
  subjectFor: (authorityKey: string) => string | null): PhysicalChassisClaim[] {
  const claims: PhysicalChassisClaim[] = [];
  for (const { source, baseline } of entries) {
    if (source.revokedAt || source.protocol !== 'snmp_interfaces') continue;
    const section = baseline?.section as { outcome?: string; localChassis?: { subtype?: unknown; value?: unknown } } | undefined;
    const id = section?.localChassis;
    if (!section || (section.outcome !== 'complete' && section.outcome !== 'partial') || typeof id?.subtype !== 'string' || typeof id.value !== 'string') continue;
    const nodeId = subjectFor(physicalAuthorityOf(source.contextKey));
    if (nodeId) claims.push({ nodeId, id: { subtype: id.subtype, value: id.value } });
  }
  return claims;
}

/** Explicit identity dirty mark (D15.2) for writers outside the publisher (leaf module). */
export { markTopologyIdentityDirty } from './identityDirty';

export type MergedInterfacePlan = {
  /** Loser interfaces re-owned by the survivor (owner, epoch and retirement decided). */
  reowned: InterfacePublication[];
  /** Loser interface id -> survivor interface id, only with corroborated continuity. */
  coalesced: Map<string, string>;
};
/**
 * D15.5: node merge re-owns the loser's interfaces. Equal owner-local key+epoch
 * never proves two interfaces are one; they coalesce only when ifName and
 * ifPhysAddress are both present and equal (corroborated continuity). Otherwise
 * the loser keeps a distinct generation (next `gen:<n>` on an epoch collision)
 * and is retired if the survivor already has a current generation for the key.
 */
export function planMergedInterfaces(clusters: { canonicalId: string; aliasIds: string[] }[], interfaces: InterfacePublication[], at: Date): MergedInterfacePlan {
  const reowned: InterfacePublication[] = [];
  const coalesced = new Map<string, string>();
  for (const cluster of clusters) {
    const aliases = new Set(cluster.aliasIds);
    const survivor = interfaces.filter(i => i.ownerNodeId === cluster.canonicalId);
    for (const loser of interfaces.filter(i => aliases.has(i.ownerNodeId)).sort((a, b) => a.id.localeCompare(b.id))) {
      const sameKey = survivor.filter(i => i.interfaceKey === loser.interfaceKey);
      const evidence = (i: InterfacePublication) => ({ name: i.name ?? null, physAddress: i.physAddress ?? null, osIndex: i.osIndex ?? null });
      const continuous = sameKey.filter(i => interfaceContinuity(evidence(i), evidence(loser)) === 'continuous')
        .sort((a, b) => Number(b.epoch === loser.epoch) - Number(a.epoch === loser.epoch) || Number(!a.retiredAt) - Number(!b.retiredAt) || a.id.localeCompare(b.id));
      if (continuous.length) { coalesced.set(loser.id, continuous[0]!.id); continue; }
      let epoch = loser.epoch;
      if (sameKey.some(i => i.epoch === epoch)) {
        epoch = isPhysicalGeneration(loser.epoch)
          ? `gen:${[...sameKey, loser].reduce((max, i) => Math.max(max, physicalGenerationNumber(i.epoch)), 0) + 1}`
          : `merged:${loser.id}:${loser.epoch}`.slice(0, 255);
      }
      const survivorCurrent = isPhysicalGeneration(epoch) && sameKey.some(i => isPhysicalGeneration(i.epoch) && !i.retiredAt);
      const next = { ...loser, ownerNodeId: cluster.canonicalId, epoch, retiredAt: loser.retiredAt ?? (survivorCurrent ? at : null) };
      reowned.push(next); survivor.push(next);
    }
  }
  const remap = (id: string | null | undefined) => (id && coalesced.get(id)) || id || null;
  return { reowned: reowned.map(i => ({ ...i, parentInterfaceId: remap(i.parentInterfaceId) })), coalesced };
}

/** Apply a merge interface plan. The interface FKs are DEFERRABLE, so ownership,
 * relationship and observation references converge before commit. */
export async function applyMergedInterfaces(tx: Tx, scope: TopologyScope, plan: MergedInterfacePlan, ownerOf: Map<string, string>) {
  if (!plan.reowned.length && !plan.coalesced.size) return;
  await tx.execute(sql`SET CONSTRAINTS topology_interfaces_parent_fk, topology_observations_interface_fk, topology_relationships_source_interface_fk, topology_relationships_target_interface_fk DEFERRED`);
  const scoped = sql`org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`;
  for (const row of plan.reowned) {
    await tx.execute(sql`UPDATE topology_interfaces SET owner_node_id=${row.ownerNodeId}::uuid, epoch=${row.epoch}, retired_at=${row.retiredAt ? row.retiredAt.toISOString() : null}::timestamptz,
      parent_interface_id=${row.parentInterfaceId ?? null}::uuid, updated_at=now() WHERE ${scoped} AND id=${row.id}::uuid`);
    await tx.execute(sql`UPDATE topology_observations SET subject_node_id=${row.ownerNodeId}::uuid, updated_at=now() WHERE ${scoped} AND subject_interface_id=${row.id}::uuid`);
  }
  for (const [from, to] of plan.coalesced) {
    const owner = ownerOf.get(to);
    if (!owner) throw new Error('Merged interface destination has no owner');
    await tx.execute(sql`UPDATE topology_observations SET subject_interface_id=${to}::uuid, subject_node_id=${owner}::uuid, updated_at=now() WHERE ${scoped} AND subject_interface_id=${from}::uuid`);
    await tx.execute(sql`UPDATE topology_interfaces SET parent_interface_id=${to}::uuid, updated_at=now() WHERE ${scoped} AND parent_interface_id=${from}::uuid`);
    await tx.execute(sql`UPDATE topology_relationships SET source_interface_id=${to}::uuid, source_node_id=${owner}::uuid WHERE ${scoped} AND source_interface_id=${from}::uuid`);
    await tx.execute(sql`UPDATE topology_relationships SET target_interface_id=${to}::uuid, target_node_id=${owner}::uuid WHERE ${scoped} AND target_interface_id=${from}::uuid`);
    await tx.execute(sql`DELETE FROM topology_interfaces WHERE ${scoped} AND id=${from}::uuid`);
  }
}
