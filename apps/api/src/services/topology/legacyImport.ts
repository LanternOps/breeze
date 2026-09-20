import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { topologyChangeOutbox, topologySiteState } from '../../db/schema';
import { parseSnapshotEnvelope, legacyRevisionSchema, type SnapshotEnvelope } from './legacyProjection';
import { emptyLegacyCounts, readLegacyImportCheckpoint, readLegacySnapshot, requireTopologyCapture, requireLegacyScope, scopedTopology, withLegacyImportSavepoint, type LegacyImportCheckpoint } from './legacyImportState';
import { replayLegacyBatch } from './legacyReplay';
export { getTopologyCaptureStatus } from './legacyImportState';
export { compareLegacyTopology, type LegacyParityReport } from './legacyParity';

const MAX_BATCH_SIZE = 1000;
const batchSchema = z.number().int().min(1).max(MAX_BATCH_SIZE);
export type LegacyImportResult = { runId: string; capturedThrough: string; barrierRevision: string; deliveredThrough: string; complete: boolean; pendingThroughBarrier: number; resumeToken: string | null; counts: LegacyImportCheckpoint['counts']; mismatches: LegacyImportCheckpoint['mismatches'] };

/** Operator-only staging. This is never called by GET or worker startup.
 * Copy the whole selected site's snapshot in one transaction, then commit
 * bounded replay batches across calls. Durable envelopes replace a long-lived
 * MVCC snapshot that could not survive an operator/process restart. */
export async function importLegacyTopologySite(scope: TopologyScope, options: { batchSize?: number; resumeToken?: string } = {}): Promise<LegacyImportResult> {
  const batchSize = batchSchema.parse(options.batchSize ?? 200);
  if (options.resumeToken !== undefined) z.string().uuid().parse(options.resumeToken);
  await requireTopologyCapture(scope);
  return withLegacyImportSavepoint(async () => {
    await db.insert(topologySiteState).values(scope).onConflictDoNothing();
    const [state] = await db.select().from(topologySiteState).where(scopedTopology(scope)).for('update');
    if (!state) throw new Error('Topology site state is missing or inaccessible');
    let checkpoint = readLegacyImportCheckpoint(state.effectiveSettings);
    if (options.resumeToken && checkpoint?.runId !== options.resumeToken) throw new Error('Legacy import resume token does not match this site');
    if (!checkpoint) {
      const runId = randomUUID();
      const capturedThrough = state.dirtyRevision;
      const snapshot = await readLegacySnapshot(scope);
      let deliveryRevision = capturedThrough;
      // Validate the entire snapshot before staging. Malformed unbounded old
      // records fail closed instead of truncating a manual note or coordinate.
      const envelopes = snapshot.map(item => parseSnapshotEnvelope({ version: 1, kind: 'legacy.snapshot', runId, sourceRevision: capturedThrough.toString(), item } satisfies SnapshotEnvelope));
      for (let start = 0; start < envelopes.length; start += batchSize) {
        await db.insert(topologyChangeOutbox).values(envelopes.slice(start, start + batchSize).map(envelope => ({ ...scope,
          eventKind: 'legacy.snapshot', aggregateId: envelope.item.sourceId, sourceRevision: ++deliveryRevision,
          idempotencyKey: `snapshot:${runId}:${envelope.item.sourceTable}:${envelope.item.sourceId}`,
          payload: envelope,
        })));
      }
      // Even an empty site has an explicit accepted checkpoint/readiness event.
      await db.insert(topologyChangeOutbox).values({ ...scope, eventKind: 'legacy.checkpoint', aggregateId: runId, sourceRevision: ++deliveryRevision,
        idempotencyKey: `snapshot:${runId}:complete`, payload: { version: 1, kind: 'legacy.checkpoint', runId, sourceRevision: capturedThrough.toString() } });
      checkpoint = { version: 1, runId, capturedThrough: capturedThrough.toString(), snapshotThrough: deliveryRevision.toString(), deliveredThrough: state.materializedInputRevision.toString(),
        status: 'staged', snapshotRows: snapshot.length, counts: emptyLegacyCounts(), mismatches: [] };
      await db.update(topologySiteState).set({ dirtyRevision: deliveryRevision, lastBuildStatus: 'pending', effectiveSettings: { ...state.effectiveSettings, legacyImport: checkpoint }, updatedAt: new Date() }).where(scopedTopology(scope));
    }
    return drainTopologyOutbox(scope, { throughRevision: checkpoint.snapshotThrough, batchSize });
  });
}

/** Drain one bounded transaction. The caller may repeat the returned token;
 * state and delivery ACKs, not process memory or outbox UUID order, own progress. */
export async function drainTopologyOutbox(scope: TopologyScope, options: { throughRevision?: string; batchSize?: number } = {}): Promise<LegacyImportResult> {
  const batchSize = batchSchema.parse(options.batchSize ?? 200);
  if (options.throughRevision !== undefined) legacyRevisionSchema.parse(options.throughRevision);
  await requireTopologyCapture(scope);
  return withLegacyImportSavepoint(async () => {
    const [state] = await db.select().from(topologySiteState).where(scopedTopology(scope)).for('update');
    if (!state) throw new Error('Topology legacy import has not been staged');
    const checkpoint = readLegacyImportCheckpoint(state.effectiveSettings);
    if (!checkpoint) throw new Error('Topology legacy import has not been staged');
    const through = BigInt(options.throughRevision ?? state.dirtyRevision.toString());
    if (through > state.dirtyRevision) throw new Error('Requested topology barrier has not been captured');
    // Already-materialized ACKs are safe only if they committed with the graph.
    // Any pending row below that checkpoint signals corruption, not permission
    // to discard a possibly lost manual edit.
    const rows = await db.select().from(topologyChangeOutbox).where(and(eq(topologyChangeOutbox.orgId, scope.orgId), eq(topologyChangeOutbox.siteId, scope.siteId),
      isNull(topologyChangeOutbox.deliveredAt), lte(topologyChangeOutbox.sourceRevision, through)))
      .orderBy(asc(topologyChangeOutbox.sourceRevision)).limit(batchSize);
    if (rows.some(row => row.sourceRevision <= state.materializedInputRevision)) throw new Error('Pending topology event is behind the committed checkpoint');
    if (rows.length > 0) {
      const delta = await replayLegacyBatch(scope, rows, state.buildFence, checkpoint);
      for (const name of Object.keys(checkpoint.counts) as (keyof typeof checkpoint.counts)[]) checkpoint.counts[name] += delta.counts[name];
      checkpoint.mismatches = [...checkpoint.mismatches, ...delta.mismatches].slice(0, 100);
      checkpoint.deliveredThrough = rows.at(-1)!.sourceRevision.toString();
      checkpoint.status = BigInt(checkpoint.deliveredThrough) >= BigInt(checkpoint.snapshotThrough) ? 'complete' : 'staged';
      await db.update(topologySiteState).set({ effectiveSettings: { ...state.effectiveSettings, legacyImport: checkpoint }, updatedAt: new Date() }).where(scopedTopology(scope));
    }
    const pending = await db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM topology_change_outbox
      WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND delivered_at IS NULL AND source_revision<=${through}::bigint`);
    const pendingThroughBarrier = Number(pending[0]!.count);
    const complete = pendingThroughBarrier === 0 && BigInt(checkpoint.deliveredThrough) >= through;
    return { runId: checkpoint.runId, capturedThrough: checkpoint.capturedThrough, barrierRevision: through.toString(), deliveredThrough: checkpoint.deliveredThrough,
      complete, pendingThroughBarrier, resumeToken: complete ? null : checkpoint.runId, counts: checkpoint.counts, mismatches: checkpoint.mismatches };
  });
}

export async function getLegacyTopologyStatus(scope: TopologyScope) {
  await requireLegacyScope(scope);
  const [state] = await db.select().from(topologySiteState).where(scopedTopology(scope));
  return { initialized: !!state && !!readLegacyImportCheckpoint(state.effectiveSettings), dirtyRevision: state?.dirtyRevision.toString() ?? '0',
    materializedInputRevision: state?.materializedInputRevision.toString() ?? '0', graphRevision: state?.graphRevision.toString() ?? '0',
    import: state ? readLegacyImportCheckpoint(state.effectiveSettings) : null };
}
