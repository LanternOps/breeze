import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TopologyScope } from '@breeze/shared';
import { db, assertInTransaction, withDbTransaction } from '../../db';
import { sites, topologySiteState } from '../../db/schema';
import { legacyRevisionSchema, type LegacySourceTable, type SnapshotEnvelope } from './legacyProjection';

export const LEGACY_CAPTURE_TABLES = ['devices', 'discovered_assets', 'topology_manual_nodes', 'network_topology', 'topology_layout'] as const;
export const scopedTopology = (scope: TopologyScope) => and(eq(topologySiteState.orgId, scope.orgId), eq(topologySiteState.siteId, scope.siteId));
const countsSchema = z.object({ imported: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), conflicted: z.number().int().nonnegative(), manual: z.number().int().nonnegative(), pin: z.number().int().nonnegative(), tombstone: z.number().int().nonnegative() }).strict();
export type LegacyImportCounts = z.infer<typeof countsSchema>;
export const emptyLegacyCounts = (): LegacyImportCounts => ({ imported: 0, skipped: 0, conflicted: 0, manual: 0, pin: 0, tombstone: 0 });
export const importCheckpointSchema = z.object({ version: z.literal(1), runId: z.string().uuid(), capturedThrough: legacyRevisionSchema,
  snapshotThrough: legacyRevisionSchema, deliveredThrough: legacyRevisionSchema, status: z.enum(['staged', 'complete']),
  snapshotRows: z.number().int().nonnegative(), counts: countsSchema,
  mismatches: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{24}$/), reason: z.string().max(80), category: z.enum(['manual', 'pin', 'other']) }).strict()).max(100),
}).strict();
export type LegacyImportCheckpoint = z.infer<typeof importCheckpointSchema>;

/** Rebind composed db.* helpers into a driver-owned savepoint. */
export async function withLegacyImportSavepoint<T>(run: () => Promise<T>): Promise<T> {
  return withDbTransaction(run);
}

export function readLegacyImportCheckpoint(settings: Record<string, unknown>): LegacyImportCheckpoint | null {
  if (settings.legacyImport === undefined) return null;
  // Corrupt metadata is not permission to silently restart and overwrite pins.
  return importCheckpointSchema.parse(settings.legacyImport);
}

export async function requireLegacyScope(scope: TopologyScope): Promise<void> {
  assertInTransaction('legacy topology migration');
  z.object({ orgId: z.string().uuid(), siteId: z.string().uuid() }).strict().parse(scope);
  const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, scope.siteId), eq(sites.orgId, scope.orgId))).limit(1);
  if (!site) throw new Error('Topology site is missing or inaccessible');
}

export async function getTopologyCaptureStatus(scope: TopologyScope) {
  await requireLegacyScope(scope);
  const triggers = await db.execute<{ table_name: string; enabled: string }>(sql`
    SELECT c.relname AS table_name, t.tgenabled AS enabled
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND pn.nspname='public' AND NOT t.tgisinternal
        AND t.tgname='topology_capture_legacy_change' AND p.proname='topology_capture_legacy_change'
        AND NOT p.prosecdef AND (t.tgtype & 29)=29
  `);
  const functions = await db.execute(sql`SELECT
    to_regprocedure('public.topology_enqueue_change(uuid,uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('public.topology_capture_projection(text,jsonb)') IS NOT NULL
    AND to_regprocedure('public.topology_validate_capture_event(jsonb)') IS NOT NULL AS installed`);
  const missing = LEGACY_CAPTURE_TABLES.filter(table => !triggers.some(row => row.table_name === table && ['O', 'A'].includes(row.enabled)));
  return { complete: missing.length === 0 && functions[0]?.installed === true, missing };
}

export async function requireTopologyCapture(scope: TopologyScope): Promise<void> {
  const status = await getTopologyCaptureStatus(scope);
  if (!status.complete) throw new Error('Topology legacy capture is incomplete or disabled');
}

/** One statement provides one MVCC snapshot across all five sources. The caller
 * already holds the capture lock, so a changed-but-not-yet-captured writer is
 * excluded from this snapshot and commits a later revision after staging. */
export async function readLegacySnapshot(scope: TopologyScope): Promise<SnapshotEnvelope['item'][]> {
  const projection = (table: LegacySourceTable, phase: number) => sql`
    SELECT ${table}::text AS source_table, id::text AS source_id, ${phase}::integer AS phase,
      topology_capture_projection(${table}, to_jsonb(s)) AS data
      FROM ${sql.identifier(table)} s WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`;
  const result = await db.execute<{ source_table: LegacySourceTable; source_id: string; data: Record<string, unknown> }>(sql`
    SELECT source_table, source_id, data FROM (
      ${projection('devices', 0)} UNION ALL ${projection('discovered_assets', 1)}
      UNION ALL ${projection('topology_manual_nodes', 2)}
      UNION ALL SELECT 'network_topology'::text, id::text, 3, jsonb_build_object(
        'sourceType',source_type,'sourceId',source_id,'targetType',target_type,'targetId',target_id,
        'connectionType',connection_type,'interfaceName',interface_name,'vlan',vlan,'bandwidth',bandwidth,
        'method',method,'createdBy',created_by,'firstSeenAt',first_seen_at,'lastVerifiedAt',last_verified_at AT TIME ZONE 'UTC')
        FROM network_topology WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
      UNION ALL ${projection('topology_layout', 4)}
    ) snapshot ORDER BY phase, source_id
  `);
  return result.map(row => ({ sourceTable: row.source_table, sourceId: row.source_id, data: row.data }));
}
