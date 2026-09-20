import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { nodeKindSchema, relationshipKindSchema, type TopologyScope } from '@breeze/shared';
import { assertInTransaction, db, getCurrentDbAccessContext } from '../../db';
import { canonicalIdentityKey, normalizedTopologyScope } from './identity';
import type { TopologyTransaction } from './legacyCapture';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const materialSchema = z.object({
  version: z.literal(1), kind: z.union([nodeKindSchema, relationshipKindSchema]),
  sourceKey: z.string().min(1).max(8192),
}).strict();

/** Use before app-side denormalization. The SQL BEFORE trigger calls this same
 * function for old writers/direct SQL; a second call finds no binding to detach. */
export async function detachTopologyInventoryBinding(tx: TopologyTransaction, input: {
  kind: 'device' | 'asset' | 'manual'; id: string; oldScope: TopologyScope; newScope: TopologyScope | null;
}): Promise<number> {
  assertInTransaction('detachTopologyInventoryBinding');
  const kind = z.enum(['device', 'asset', 'manual']).parse(input.kind);
  const id = uuid.parse(input.id);
  const old = normalizedTopologyScope(input.oldScope);
  const next = input.newScope && normalizedTopologyScope(input.newScope);
  const rows = await tx.execute(sql`SELECT breeze_detach_topology_inventory_binding(
    ${kind}, ${id}::uuid, ${old.orgId}::uuid, ${old.siteId}::uuid,
    ${next?.orgId ?? null}::uuid, ${next?.siteId ?? null}::uuid) AS detached`);
  return z.number().int().min(0).parse(rows[0]?.detached);
}

function mergeScope(loserOrgId: string, survivorOrgId: string) {
  assertInTransaction('topology organization merge');
  if (getCurrentDbAccessContext()?.scope !== 'system') throw new Error('Topology organization merge requires system context');
  const loser = uuid.parse(loserOrgId);
  const survivor = uuid.parse(survivorOrgId);
  if (loser === survivor) throw new Error('Topology organization merge requires distinct organizations');
  return { loser, survivor };
}

/** Called after the merge engine acquires both organizations' export locks and
 * defers constraints, before either registry pass. The ambient Phase-B
 * transaction owns every write; there is no nested or post-commit transaction. */
export async function prepareTopologyOrgMerge(loserOrgId: string, survivorOrgId: string): Promise<{ siteIds: string[] }> {
  const { loser } = mergeScope(loserOrgId, survivorOrgId);
  // Block owner changes/deletion without blocking the FK KEY SHARE checks
  // of a publisher that already holds site state. A stronger parent lock here
  // would invert the publisher's state -> parent-FK order and deadlock.
  const sites = await db.execute(sql`SELECT id FROM sites WHERE org_id = ${loser}::uuid ORDER BY id FOR NO KEY UPDATE`);
  const siteIds = sites.map(row => uuid.parse(row.id));
  for (const siteId of siteIds) {
    await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id)
      VALUES (${loser}::uuid, ${siteId}::uuid) ON CONFLICT DO NOTHING`);
    await db.execute(sql`SELECT site_id FROM topology_site_state
      WHERE org_id = ${loser}::uuid AND site_id = ${siteId}::uuid FOR UPDATE`);
    await db.execute(sql`UPDATE topology_site_state SET build_fence = build_fence + 1, updated_at = now()
      WHERE org_id = ${loser}::uuid AND site_id = ${siteId}::uuid`);
  }
  await db.execute(sql`UPDATE topology_config_templates a SET key=substring(a.key,1,27)||'-'||a.id::text
    WHERE a.org_id=${loser}::uuid AND EXISTS(SELECT 1 FROM topology_config_templates b WHERE b.org_id=${survivorOrgId}::uuid AND b.key=a.key)`);
  await db.execute(sql`UPDATE topology_config_templates a SET name=substring(a.name,1,218)||'-'||a.id::text
    WHERE a.org_id=${loser}::uuid AND EXISTS(SELECT 1 FROM topology_config_templates b WHERE b.org_id=${survivorOrgId}::uuid AND b.name=a.name)`);
  // Merge revokes execution authority before ownership changes; snapshots remain historical.
  await db.execute(sql`UPDATE topology_monitoring_policies SET enabled=false, authority_digest=NULL,
    authority_generation=authority_generation+1, blocked_reason='organization_merged', updated_at=now() WHERE org_id=${loser}::uuid`);
  await db.execute(sql`UPDATE topology_diagnostic_runs SET state='cancelled',cancel_requested_at=now(),finished_at=now(),
    failure_reason='organization_merged',updated_at=now() WHERE org_id=${loser}::uuid AND state='queued'`);
  await db.execute(sql`UPDATE topology_diagnostic_runs SET cancel_requested_at=now(),failure_reason='organization_merged',updated_at=now()
    WHERE org_id=${loser}::uuid AND state='running'`);
  await db.execute(sql`UPDATE device_commands SET status='cancelled',completed_at=now() WHERE status='pending'
    AND id IN (SELECT command_id FROM topology_diagnostic_runs WHERE org_id=${loser}::uuid AND state='cancelled')`);
  return { siteIds };
}

/** Called after both registry passes and their existing fixups, still inside
 * Phase B. Keys change with organization ownership; UUIDs, source revisions,
 * manual facts, layout IDs and pins stay intact. A malformed material, missing
 * owner or unique-key collision aborts the entire merge. */
export async function finalizeTopologyOrgMerge(loserOrgId: string, survivorOrgId: string, savedSiteIds: string[]): Promise<{ rekeyed: number; fenced: number }> {
  const { loser, survivor } = mergeScope(loserOrgId, survivorOrgId);
  const siteIds = [...new Set(savedSiteIds.map(id => uuid.parse(id)))].sort();
  if (!siteIds.length) return { rekeyed: 0, fenced: 0 };
  const siteList = sql`ARRAY[${sql.join(siteIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
  const sites = await db.execute(sql`SELECT id, org_id FROM sites WHERE id = ANY(${siteList}) ORDER BY id FOR UPDATE`);
  if (sites.length !== siteIds.length || sites.some(row => row.org_id !== survivor)) throw new Error('Topology merge site ownership mismatch');
  const states = await db.execute(sql`SELECT site_id FROM topology_site_state
    WHERE org_id = ${survivor}::uuid AND site_id = ANY(${siteList}) ORDER BY site_id FOR UPDATE`);
  if (states.length !== siteIds.length) throw new Error('Topology merge state ownership mismatch');
  const nodes = await db.execute(sql`SELECT id, site_id, kind, identity_material FROM topology_nodes
    WHERE org_id = ${survivor}::uuid AND site_id = ANY(${siteList}) ORDER BY site_id, id`);
  const relationships = await db.execute(sql`SELECT id, site_id, kind, identity_material FROM topology_relationships
    WHERE org_id = ${survivor}::uuid AND site_id = ANY(${siteList}) ORDER BY site_id, id`);
  // Validate all immutable inputs before performing any rekey writes.
  const keyed = (rows: typeof nodes) => rows.map(row => {
    const material = materialSchema.parse(row.identity_material);
    if (material.kind !== row.kind) throw new Error('Topology merge identity kind mismatch');
    const siteId = uuid.parse(row.site_id);
    return { id: uuid.parse(row.id), siteId, key: canonicalIdentityKey({ orgId: survivor, siteId }, material.kind, material.sourceKey) };
  });
  const nodeKeys = keyed(nodes);
  const relationshipKeys = keyed(relationships);
  for (const row of nodeKeys) await db.execute(sql`UPDATE topology_nodes SET identity_key = ${row.key}, updated_at = now()
    WHERE id = ${row.id}::uuid AND org_id = ${survivor}::uuid AND site_id = ${row.siteId}::uuid`);
  for (const row of relationshipKeys) await db.execute(sql`UPDATE topology_relationships SET canonical_key = ${row.key}, updated_at = now()
    WHERE id = ${row.id}::uuid AND org_id = ${survivor}::uuid AND site_id = ${row.siteId}::uuid`);
  await db.execute(sql`UPDATE topology_change_outbox SET payload = jsonb_set(jsonb_set(payload,
    '{oldIdentity}', CASE WHEN payload->'oldIdentity'->>'orgId' = ${loser}
      AND payload->'oldIdentity'->>'siteId' = ANY(${siteList}::text[])
      THEN jsonb_set(payload->'oldIdentity', '{orgId}', to_jsonb(${survivor}::text))
      ELSE COALESCE(payload->'oldIdentity', 'null'::jsonb) END),
    '{newIdentity}', CASE WHEN payload->'newIdentity'->>'orgId' = ${loser}
      AND payload->'newIdentity'->>'siteId' = ANY(${siteList}::text[])
      THEN jsonb_set(payload->'newIdentity', '{orgId}', to_jsonb(${survivor}::text))
      ELSE COALESCE(payload->'newIdentity', 'null'::jsonb) END), updated_at = now()
    WHERE org_id = ${survivor}::uuid AND site_id = ANY(${siteList}) AND delivered_at IS NULL
      AND payload ? 'oldIdentity' AND payload ? 'newIdentity'`);
  await db.execute(sql`UPDATE topology_collection_sources SET revoked_at = now(), pending_misses = '{}'::jsonb, updated_at = now()
    WHERE org_id = ${survivor}::uuid AND site_id = ANY(${siteList}) AND revoked_at IS NULL`);
  await db.execute(sql`UPDATE topology_site_state SET graph_revision = graph_revision + 1,
    settings_revision = settings_revision + 1, updated_at = now()
    WHERE org_id = ${survivor}::uuid AND site_id = ANY(${siteList})`);
  return { rekeyed: nodeKeys.length + relationshipKeys.length, fenced: states.length };
}
