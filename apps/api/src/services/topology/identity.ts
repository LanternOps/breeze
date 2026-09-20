import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { topologyScopeSchema, nodeKindSchema, relationshipKindSchema, type TopologyScope, type NodeKind, type RelationshipKind } from '@breeze/shared';

export function normalizedTopologyScope(scope: TopologyScope): TopologyScope {
  const parsed = topologyScopeSchema.parse(scope);
  return { orgId: parsed.orgId.toLowerCase(), siteId: parsed.siteId.toLowerCase() };
}

/** Source material is server-owned and immutable. Names, addresses and display
 * labels belong in attributes. Namespaced keys carry collector/routing/owner
 * context; an inventory UUID is already a stable source identity. */
export function canonicalIdentityKey(scope: TopologyScope, kind: NodeKind | RelationshipKind, sourceKey: string): string {
  const normalized = normalizedTopologyScope(scope);
  z.union([nodeKindSchema, relationshipKindSchema]).parse(kind);
  z.string().min(1).max(8192).parse(sourceKey);
  if (sourceKey !== sourceKey.trim() || /\s|\p{Cc}/u.test(sourceKey) || isIP(sourceKey)
    || /^(?:name|label|ip|address|hostname):/i.test(sourceKey)
    || (!z.string().uuid().safeParse(sourceKey).success && !/^[a-z][a-z0-9_-]*:.+/.test(sourceKey))) {
    throw new Error('Topology identity requires immutable, context-qualified source material');
  }
  const material = { version: 1, kind, sourceKey };
  if (Buffer.byteLength(JSON.stringify(material)) > 16384) throw new Error('Topology identity material exceeds bound');
  return `v1:${createHash('sha256').update(JSON.stringify([normalized.orgId, normalized.siteId, material])).digest('hex')}`;
}

export type MergeNode = TopologyScope & { id: string; createdAt: Date; labelOverride?: string | null; attributes?: { notes?: string } };
export type MergePosition = { nodeId: string; layoutId: string; x: number; y: number; pinned: boolean };
type VersionedPosition = MergePosition & { revision: bigint; legacySourceRevision: bigint | null; deletedAt: Date | null };

/** Identity collapse preserves live pins rather than replaying either source's
 * deletion over the other identity. Both source high-waters survive, including
 * tombstones, so an older event cannot later undo the chosen position. */
export function planAliasPosition<T extends VersionedPosition>(canonicalId: string, alias: T, canonical?: T) {
  const liveCanonical = canonical && !canonical.deletedAt ? canonical : undefined;
  const liveAlias = !alias.deletedAt ? alias : undefined;
  const chosen = liveCanonical?.pinned ? liveCanonical
    : liveAlias?.pinned ? liveAlias : liveCanonical ?? liveAlias ?? canonical ?? alias;
  const fences = [canonical?.legacySourceRevision, alias.legacySourceRevision].filter((v): v is bigint => v != null);
  const legacySourceRevision = fences.length ? fences.reduce((a, b) => a > b ? a : b) : null;
  const canonicalRevision = canonical?.revision ?? 0n;
  const revision = (alias.revision > canonicalRevision ? alias.revision : canonicalRevision) + 1n;
  return { ...chosen, nodeId: canonicalId, revision, legacySourceRevision };
}

/** Pure decision only: the caller must verify the accepted inventory relation
 * and apply references, positions, manual facts and audit atomically. */
export function planCanonicalMerge(scope: TopologyScope, first: MergeNode, second: MergeNode, positions: MergePosition[], evidence: 'accepted_link') {
  const normalized = normalizedTopologyScope(scope);
  if (evidence !== 'accepted_link') throw new Error('Weak identity cannot merge canonical nodes');
  for (const node of [first, second]) {
    if (node.orgId !== normalized.orgId || node.siteId !== normalized.siteId) throw new Error('Canonical alias scope conflict');
    z.string().uuid().parse(node.id);
    if (!Number.isFinite(node.createdAt.getTime())) throw new Error('Invalid canonical creation time');
  }
  if (first.id === second.id) throw new Error('Canonical alias cannot reference itself');
  const [canonical, alias] = [first, second].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)) as [MergeNode, MergeNode];
  if (canonical.labelOverride && alias.labelOverride && canonical.labelOverride !== alias.labelOverride) throw new Error('Conflicting manual labels stop canonical merge');
  if (canonical.attributes?.notes && alias.attributes?.notes && canonical.attributes.notes !== alias.attributes.notes) throw new Error('Conflicting manual notes stop canonical merge');
  const pins = new Map<string, MergePosition>();
  for (const position of positions.filter(p => p.pinned && [first.id, second.id].includes(p.nodeId))) {
    const previous = pins.get(position.layoutId);
    if (previous && (previous.x !== position.x || previous.y !== position.y)) throw new Error('Conflicting pins stop canonical merge');
    pins.set(position.layoutId, position);
  }
  // Across distinct identities, an empty value contributes no manual fact;
  // it cannot erase another member's nonempty label/note. Explicit clears of
  // one source identity are handled separately by revision-fenced replay.
  return { canonicalId: canonical.id, aliasId: alias.id, labelOverride: canonical.labelOverride || alias.labelOverride || null,
    notes: canonical.attributes?.notes || alias.attributes?.notes || undefined };
}

/** Validate every manual fact/pin before folding a component into its globally
 * oldest representative. An intermediate pair must not hide later conflicts. */
export function planCanonicalCluster(scope: TopologyScope, nodes: MergeNode[], positions: MergePosition[]) {
  if (nodes.length < 2 || new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('Canonical alias cannot reference itself');
  const ordered = [...nodes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  let canonical = ordered[0]!;
  const aliasIds: string[] = [];
  for (const alias of ordered.slice(1)) {
    const plan = planCanonicalMerge(scope, canonical, alias, [], 'accepted_link');
    aliasIds.push(plan.aliasId);
    canonical = { ...canonical, labelOverride: plan.labelOverride, attributes: { ...canonical.attributes, ...(plan.notes !== undefined ? { notes: plan.notes } : {}) } };
  }
  const ids = new Set(nodes.map(n => n.id));
  const pins = new Map<string, MergePosition>();
  for (const position of positions.filter(p => p.pinned && ids.has(p.nodeId))) {
    const previous = pins.get(position.layoutId);
    if (previous && (previous.x !== position.x || previous.y !== position.y)) throw new Error('Conflicting pins stop canonical merge');
    pins.set(position.layoutId, position);
  }
  return { canonicalId: canonical.id, aliasIds: aliasIds.sort(), labelOverride: canonical.labelOverride ?? null, notes: canonical.attributes?.notes };
}

/** Fold original slots once per layout. Pairwise writes against the original
 * snapshot can overwrite an earlier alias pin or discard its source fence. */
export function planAliasClusterPosition<T extends VersionedPosition>(canonicalId: string, positions: T[]) {
  if (!positions.length || positions.some(p => p.layoutId !== positions[0]!.layoutId)) throw new Error('Invalid alias layout component');
  const canonical = positions.find(p => p.nodeId === canonicalId);
  const ordered = [...positions].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const live = ordered.filter(p => !p.deletedAt);
  const liveCanonical = canonical && !canonical.deletedAt ? canonical : undefined;
  const chosen = (liveCanonical?.pinned ? liveCanonical : live.find(p => p.pinned)) ?? liveCanonical ?? live[0] ?? canonical ?? ordered[0]!;
  const fences = positions.map(p => p.legacySourceRevision).filter((v): v is bigint => v != null);
  const legacySourceRevision = fences.length ? fences.reduce((a, b) => a > b ? a : b) : null;
  const revision = positions.reduce((max, p) => p.revision > max ? p.revision : max, 0n) + 1n;
  return { ...chosen, nodeId: canonicalId, revision, legacySourceRevision };
}
