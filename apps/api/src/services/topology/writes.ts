import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { TopologyScope } from '@breeze/shared';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { z } from 'zod';
import { db, assertInTransaction, withDbTransaction } from '../../db';
import { tightenLockTimeout, lockTimeoutWasChanged } from '../../db/lockTimeout';
import { auditLogs, topologyLayouts, topologySiteState, topologyManualNodes, topologyLayout, networkTopology } from '../../db/schema';
import { requireTopologySiteAccess, type TopologyRequestContext } from './access';
import { drainTopologyOutbox } from './legacyImport';
import { readLegacyImportCheckpoint } from './legacyImportState';
import { loadTopologyFlags } from './flags';

export class TopologyWriteError extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 404 | 409 | 413 | 503, message: string,
    public readonly details?: { currentRevision?: string; affectedIds?: string[] }) { super(message); this.name = 'TopologyWriteError'; }
}
export const expectedRevisionSchema = z.string().regex(/^(0|[1-9]\d*)$/).max(19).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 19 && BigInt(v) <= 9223372036854775807n);
export const scopedWrite = (scope: TopologyScope, table: { orgId: AnyPgColumn; siteId: AnyPgColumn }) => and(eq(table.orgId, scope.orgId), eq(table.siteId, scope.siteId));
export function parseWrite<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TopologyWriteError('invalid_topology_mutation', 400, 'Invalid topology mutation');
  return parsed.data;
}
export function checkRevision(actual: bigint, expected: string, ids: string[]) {
  if (actual !== BigInt(expected)) throw new TopologyWriteError('topology_revision_conflict', 409, 'Topology changed; refresh before saving', { currentRevision: actual.toString(), affectedIds: ids });
}
export const missingTopologyEntity = () => new TopologyWriteError('topology_entity_not_found', 404, 'Topology entity not found');
export async function readWriteState(scope: TopologyScope) {
  const [state] = await db.select().from(topologySiteState).where(scopedWrite(scope, topologySiteState));
  if (!state) throw new TopologyWriteError('topology_preparing', 409, 'Topology has not been prepared');
  return state;
}
export async function drainWriteBarrier(scope: TopologyScope) {
  const barrier = (await readWriteState(scope)).dirtyRevision.toString();
  // A busy site's worker must catch up; never keep a request transaction open
  // indefinitely or skip an older edit to make a new one appear successful.
  for (let batch = 0; batch < 10; batch++) {
    const result = await drainTopologyOutbox(scope, { throughRevision: barrier, batchSize: 1000 });
    if (result.complete) return;
  }
  throw new TopologyWriteError('topology_backlog_busy', 503, 'Topology is catching up; retry shortly');
}
/** Every statement, including replay, uses the same authorized ambient
 * connection and driver-owned savepoint. Callers may catch a conflict safely. */
export const TOPOLOGY_SOURCE_LOCK_TIMEOUT_MS = 250;
export async function withTopologyWrite<T>(ctx: TopologyRequestContext, requireReady: boolean, work: (ready: boolean) => Promise<T>): Promise<T> {
  assertInTransaction('topology mutation');
  const current = await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'write');
  if (current.scope.orgId !== ctx.scope.orgId) throw missingTopologyEntity();
  // Resolve flags BEFORE the site-state row lock: the partner-axis read inside
  // escapes to a second pooled connection, and heartbeats lock the same row in
  // negotiateTopologyContext. Holding the lock while waiting on the pool is the
  // 2026-09-22 US deadlock shape.
  const flags = await loadTopologyFlags(ctx);
  if (requireReady && !flags.materialization) throw new TopologyWriteError('topology_materialization_disabled', 409, 'Topology materialization is disabled');
  try { return await withDbTransaction(async () => {
    if (!requireReady) await db.insert(topologySiteState).values(ctx.scope).onConflictDoNothing();
    const [state] = await db.select().from(topologySiteState).where(scopedWrite(ctx.scope, topologySiteState)).for('update');
    // Old/direct writers may already hold a source tuple before their AFTER
    // capture trigger waits on this site. Visible tuples use NOWAIT below;
    // unique-index conflicts on invisible inserts need a bounded wait too.
    // This is a per-lock backstop, not a guarantee about deadlock victim choice.
    const priorLockMs = await tightenLockTimeout(db, TOPOLOGY_SOURCE_LOCK_TIMEOUT_MS);
    if (priorLockMs === null) throw new Error('Could not read prior topology lock timeout');
    const checkpoint = state && readLegacyImportCheckpoint(state.effectiveSettings);
    const ready = flags.materialization && checkpoint?.status === 'complete';
    if (requireReady && !ready) throw new TopologyWriteError('topology_preparing', 409, 'Topology has not been prepared');
    if (ready) await drainWriteBarrier(ctx.scope);
    await db.select({ id: topologyLayouts.id }).from(topologyLayouts).where(scopedWrite(ctx.scope, topologyLayouts)).orderBy(topologyLayouts.id).for('update');
    const result = await work(ready);
    if (ready) await drainWriteBarrier(ctx.scope);
    // Never execute restoration in an aborted savepoint: its rollback restores
    // SET LOCAL automatically and preserves the original retryable SQL error.
    if (lockTimeoutWasChanged(priorLockMs, TOPOLOGY_SOURCE_LOCK_TIMEOUT_MS)) {
      await db.execute(sql`SELECT set_config('lock_timeout', ${`${priorLockMs}ms`}, true)`);
    }
    return result;
  }); } catch (error) {
    // The driver savepoint has rolled back before returning a retryable
    // conflict. Never report a partial graph/layout save as successful.
    if (['55P03', '40P01', '40001'].includes(pgErrorCode(error) ?? '')) {
      const conflict = new TopologyWriteError('topology_inventory_busy', 409, 'Inventory changed while saving; refresh and retry');
      conflict.cause = error; // Retain diagnostics internally; route envelopes expose only the stable code.
      throw conflict;
    }
    throw error;
  }
}
const legacyMutationTables = { topology_manual_nodes: topologyManualNodes, topology_layout: topologyLayout, network_topology: networkTopology } as const;
/** Caller holds the site state lock. Acquire only the source tuples the
 * mutation will touch; never wait behind an old source→capture writer. */
export async function lockLegacyTopologySourceRows(scope: TopologyScope, source: keyof typeof legacyMutationTables, predicate: SQL): Promise<void> {
  assertInTransaction('topology legacy source mutation');
  const table = legacyMutationTables[source];
  await db.select({ id: table.id }).from(table).where(and(scopedWrite(scope, table), predicate)).orderBy(table.id).for('update', { noWait: true });
}

export async function bumpStructuralRevision(scope: TopologyScope): Promise<bigint> {
  const [state] = await db.update(topologySiteState).set({ graphRevision: sql`${topologySiteState.graphRevision}+1`, updatedAt: new Date() }).where(scopedWrite(scope, topologySiteState)).returning({ revision: topologySiteState.graphRevision });
  if (!state) throw missingTopologyEntity();
  return state.revision;
}
export async function auditTopologyWrite(ctx: TopologyRequestContext, action: string, resourceId: string, details: Record<string, unknown> = {}) {
  await db.insert(auditLogs).values({ orgId: ctx.scope.orgId, actorType: 'user', actorId: ctx.auth.user.id, actorEmail: ctx.auth.user.email,
    action: `topology.${action}`, resourceType: action.startsWith('layout') ? 'topology_layout' : action.startsWith('relationship') ? 'topology_relationship' : 'topology_node',
    resourceId, result: 'success', initiatedBy: 'manual', details: { siteId: ctx.scope.siteId, ...details } });
}
