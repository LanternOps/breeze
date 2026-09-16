import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TopologyScope } from '@breeze/shared';
import { canonicalIdentityKey } from './identity';
import { parseLegacyTopologyEvent } from './legacyCapture';
import type { NodePublication, RelationshipPublication } from './publish';

export const legacyRevisionSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(v => v.length <= 19 && BigInt(v) <= 9223372036854775807n);
export const legacySourceTableSchema = z.enum(['devices', 'discovered_assets', 'topology_manual_nodes', 'network_topology', 'topology_layout']);
export type LegacySourceTable = z.infer<typeof legacySourceTableSchema>;
export type LegacyNodeTable = Extract<LegacySourceTable, 'devices' | 'discovered_assets' | 'topology_manual_nodes'>;
export type LegacySource = { sourceTable: LegacySourceTable; sourceId: string; sourceRevision: string; data: Record<string, unknown> | null };
export type SnapshotEnvelope = { version: 1; kind: 'legacy.snapshot'; runId: string; sourceRevision: string; item: Omit<LegacySource, 'sourceRevision'> };
const uuid = z.string().uuid();
const snapshotSchema = z.object({ version: z.literal(1), kind: z.literal('legacy.snapshot'), runId: uuid, sourceRevision: legacyRevisionSchema,
  item: z.object({ sourceTable: legacySourceTableSchema, sourceId: uuid, data: z.record(z.string(), z.unknown()) }).strict(),
}).strict();
const eventTypes = { devices: 'binding.changed', discovered_assets: 'binding.changed', topology_manual_nodes: 'node.upsert', network_topology: 'relationship.upsert', topology_layout: 'layout.upsert' } as const;

/** Snapshot source revision may be zero. Trigger events remain positive-only.
 * The enclosing outbox source_revision is delivery ordering, not this fence. */
export function parseSnapshotEnvelope(value: unknown): SnapshotEnvelope {
  const envelope = snapshotSchema.parse(value);
  const { sourceTable, sourceId, data } = envelope.item;
  const method = sourceTable === 'network_topology' ? z.string().max(64).nullable().parse(data.method) : undefined;
  const supportTimes = sourceTable === 'network_topology' ? z.object({ firstSeenAt: z.string().datetime({ offset: true }).nullable().optional(), lastVerifiedAt: z.string().datetime({ offset: true }).nullable().optional() })
    .parse({ firstSeenAt: data.firstSeenAt, lastVerifiedAt: data.lastVerifiedAt }) : {};
  const { firstSeenAt: _first, lastVerifiedAt: _last, ...relationshipData } = data;
  const parsed = parseLegacyTopologyEvent({ version: 1, type: eventTypes[sourceTable], sourceTable, sourceId,
    sourceRevision: '1', oldIdentity: null, newIdentity: { orgId: sourceId, siteId: sourceId, sourceId }, idempotencyKey: 'snapshot-validation',
    data: sourceTable === 'network_topology' ? { ...relationshipData, method: 'manual' } : data,
  });
  return { ...envelope, item: { sourceTable, sourceId, data: { ...parsed.data, ...(sourceTable === 'network_topology' ? { method, ...supportTimes } : {}) } } };
}

export function shouldApplyLegacyRevision(stored: string, incoming: string): boolean {
  return BigInt(legacyRevisionSchema.parse(incoming)) > BigInt(legacyRevisionSchema.parse(stored));
}

/** Candidate UUIDs are deterministic across a crashed batch. Existing canonical
 * identity lookups always win, including UUIDs preserved by an org merge. */
export function legacyNodeIdentity(scope: TopologyScope, table: LegacyNodeTable, sourceId: string) {
  uuid.parse(sourceId);
  const kind = table === 'topology_manual_nodes' ? 'manual' as const : 'endpoint' as const;
  const sourceKey = `legacy:${table}:${sourceId}`;
  const identityKey = canonicalIdentityKey(scope, kind, sourceKey);
  return { id: stableLegacyId(identityKey), kind, identityKey, identityMaterial: { version: 1 as const, kind, sourceKey } };
}

export function stableLegacyId(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function opaqueLegacyMismatchId(scope: TopologyScope, table: string, sourceId: string): string {
  return createHash('sha256').update(JSON.stringify([scope.orgId, scope.siteId, table, sourceId])).digest('hex').slice(0, 24);
}

export function projectLegacyNode(scope: TopologyScope, source: LegacySource): NodePublication {
  if (!['devices', 'discovered_assets', 'topology_manual_nodes'].includes(source.sourceTable)) throw new Error('Not a legacy node source');
  const identity = legacyNodeIdentity(scope, source.sourceTable as LegacyNodeTable, source.sourceId);
  const data = source.data;
  const label = data?.label ?? data?.displayName ?? data?.hostname;
  const manual = identity.kind === 'manual';
  return { ...scope, ...identity, attributes: { ...(typeof label === 'string' ? { label } : {}), ...(manual ? { notes: typeof data?.notes === 'string' ? data.notes : '' } : {}) },
    ...(manual ? { labelOverride: typeof label === 'string' ? label : null } : {}),
    role: typeof (data?.role ?? data?.deviceRole ?? data?.assetType) === 'string' ? String(data?.role ?? data?.deviceRole ?? data?.assetType) : null,
    lifecycle: data ? 'active' : 'withdrawn', deletedAt: data ? null : new Date(0),
    legacySourceType: source.sourceTable, legacySourceId: source.sourceId, legacySourceRevision: BigInt(legacyRevisionSchema.parse(source.sourceRevision)),
  };
}

/** Legacy port names are insufficient to assert an actual cable. Keep every
 * representable relation an attachment until v2 collection supplies proof. */
export function projectLegacyRelationship(scope: TopologyScope, source: LegacySource, sourceNodeId: string, targetNodeId: string): RelationshipPublication {
  const data = source.data;
  const manual = data?.method === 'manual';
  const sourceKey = `legacy:network_topology:${source.sourceId}`;
  const canonicalKey = canonicalIdentityKey(scope, 'attachment', sourceKey);
  return { ...scope, id: stableLegacyId(canonicalKey), kind: 'attachment', canonicalKey,
    identityMaterial: { version: 1, kind: 'attachment', sourceKey }, sourceNodeId, targetNodeId,
    directness: 'unknown', evidenceClass: manual ? 'manual' : 'inferred', confidence: manual ? 'asserted' : 'low',
    logicalContext: { contextKey: `legacy-method:${String(data?.method ?? 'unknown')}` },
    ...(typeof data?.firstSeenAt === 'string' ? { firstSupportedAt: new Date(data.firstSeenAt) } : {}),
    ...(typeof data?.lastVerifiedAt === 'string' ? { lastSupportedAt: new Date(data.lastVerifiedAt) } : {}),
    attributes: { method: manual ? 'manual' : 'legacy', ...(typeof data?.createdBy === 'string' ? { createdBy: data.createdBy } : {}) },
    lifecycle: data ? 'active' : 'withdrawn', deletedAt: data ? null : new Date(0),
    legacySourceType: 'network_topology', legacySourceId: source.sourceId, legacySourceRevision: BigInt(legacyRevisionSchema.parse(source.sourceRevision)),
  };
}

export function legacyEndpointTable(type: unknown): LegacyNodeTable | undefined {
  return ({ device: 'devices', managed_device: 'devices', discovered_asset: 'discovered_assets', manual_node: 'topology_manual_nodes' } as const)[String(type) as 'device'];
}
