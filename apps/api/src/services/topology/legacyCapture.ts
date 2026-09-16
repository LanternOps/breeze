import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TopologyScope } from '@breeze/shared';
import type { db } from '../../db';

export type TopologyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const uuid = z.string().uuid();
const text = (max: number) => z.string().max(max).nullable();
const identity = z.object({ orgId: uuid, siteId: uuid, sourceId: uuid }).strict();
const base = {
  version: z.literal(1),
  sourceTable: z.enum(['topology_manual_nodes', 'network_topology', 'topology_layout', 'devices', 'discovered_assets', 'v2_intents']),
  sourceId: uuid,
  oldIdentity: identity.nullable(),
  newIdentity: identity.nullable(),
  idempotencyKey: z.string().min(1).max(256),
};
const nodeData = z.object({ label: z.string().max(255), role: z.string().max(64), notes: text(8192), createdBy: uuid.nullable() }).strict();
const relationshipData = z.object({
  sourceType: z.string().max(50), sourceId: uuid, targetType: z.string().max(50), targetId: uuid,
  connectionType: z.string().max(50), interfaceName: text(255), vlan: z.number().int().nullable(),
  bandwidth: z.number().int().nullable(), method: z.literal('manual'), createdBy: uuid.nullable(),
}).strict();
const layoutData = z.object({ nodeType: z.string().max(32), nodeId: uuid,
  x: z.number().finite().min(-1_000_000).max(1_000_000), y: z.number().finite().min(-1_000_000).max(1_000_000),
  pinned: z.boolean(), updatedBy: uuid.nullable(),
}).strict();
const inventoryData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), hostname: z.string().max(255), displayName: text(255),
    deviceRole: z.string().max(30), osType: z.string().max(16), linkGroupId: uuid.nullable(), linkGroupRole: text(16),
  }).strict(),
  z.object({ kind: z.literal('asset'), hostname: text(255), label: text(255), ipAddress: text(64), macAddress: text(64),
    assetType: z.string().max(32), source: z.string().max(16), approvalStatus: z.string().max(16),
    linkedDeviceId: uuid.nullable(), linkSource: text(16), autoLinkSuppressed: z.boolean(),
    typeSource: z.string().max(16), detectedAssetType: text(32),
  }).strict(),
]);

const inputSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('node.upsert'), data: nodeData }).strict(),
  z.object({ ...base, type: z.literal('node.delete'), data: z.null() }).strict(),
  z.object({ ...base, type: z.literal('relationship.upsert'), data: relationshipData }).strict(),
  z.object({ ...base, type: z.literal('relationship.delete'), data: z.null() }).strict(),
  z.object({ ...base, type: z.literal('layout.upsert'), data: layoutData }).strict(),
  // Keep node identity in a layout tombstone: legacy position IDs have no canonical meaning.
  z.object({ ...base, type: z.literal('layout.delete'), data: layoutData.pick({ nodeType: true, nodeId: true }) }).strict(),
  z.object({ ...base, type: z.literal('binding.changed'), data: inventoryData.nullable() }).strict(),
]);
const sourceKinds: Record<string, string> = {
  topology_manual_nodes: 'node.', network_topology: 'relationship.', topology_layout: 'layout.',
  devices: 'binding.changed', discovered_assets: 'binding.changed',
};

function validateIdentity(event: z.infer<typeof inputSchema>) {
  if (!event.oldIdentity && !event.newIdentity) throw new Error('Capture needs a scoped source identity');
  for (const id of [event.oldIdentity, event.newIdentity]) {
    if (id && id.sourceId !== event.sourceId) throw new Error('Capture source identity mismatch');
  }
  if (event.sourceTable !== 'v2_intents' && !event.type.startsWith(sourceKinds[event.sourceTable]!)) throw new Error('Capture source/type mismatch');
  if (event.type.endsWith('.upsert') && !event.newIdentity) throw new Error('Upsert needs new scoped identity');
  if (event.type.endsWith('.delete') && !event.oldIdentity) throw new Error('Delete needs old scoped identity');
  if (event.type === 'binding.changed' && event.data) {
    if (event.sourceTable === 'devices' && event.data.kind !== 'device') throw new Error('Device source/data mismatch');
    if (event.sourceTable === 'discovered_assets' && event.data.kind !== 'asset') throw new Error('Asset source/data mismatch');
  }
  return event;
}

export type TopologyChangeInput = z.infer<typeof inputSchema>;
export type LegacyTopologyEvent = TopologyChangeInput & { sourceRevision: string };

/** Strictly allowlisted payload, shared by replay/import callers. Raw inventory
 * JSON, credentials, discovery payloads and heartbeat fields never enter it. */
export function parseLegacyTopologyEvent(value: unknown): LegacyTopologyEvent {
  const envelope = z.object({ sourceRevision: z.string().max(19).regex(/^[1-9]\d*$/).refine(v => BigInt(v) <= 9223372036854775807n) }).passthrough().parse(value);
  const { sourceRevision, ...input } = envelope;
  const event = validateIdentity(inputSchema.parse(input));
  return { ...event, sourceRevision };
}

/** Only v2-only intents belong here. Mutating a trigger-covered row, including
 * a compatibility mirror, captures once in SQL; never enqueue it again here.
 * Reusing the same key+payload returns the original revision. Reusing a key
 * for a different payload fails the entire transaction. */
export async function enqueueTopologyChange(tx: TopologyTransaction, scope: TopologyScope, input: TopologyChangeInput): Promise<string> {
  const event = validateIdentity(inputSchema.parse(input));
  if (event.sourceTable !== 'v2_intents') throw new Error('Legacy and inventory mutations are captured by SQL triggers');
  const target = event.type.endsWith('.delete') || (event.type === 'binding.changed' && !event.data) ? event.oldIdentity : event.newIdentity;
  if (target?.orgId !== scope.orgId || target.siteId !== scope.siteId) throw new Error('Capture scope mismatch');
  const result = await tx.execute(sql`SELECT topology_enqueue_change(${scope.orgId}::uuid, ${scope.siteId}::uuid, ${JSON.stringify(event)}::jsonb)::text AS revision`);
  const revision = result[0]?.revision;
  if (typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision)) throw new Error('Capture did not return a revision');
  return revision;
}
