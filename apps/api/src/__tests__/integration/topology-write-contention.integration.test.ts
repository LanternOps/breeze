import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { closeDb, db, withDbAccessContext } from '../../db';
import { organizations, topologyManualNodes, topologySiteState, topologyNodePositions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import { createTopologyManualNode, updateTopologyManualNode } from '../../services/topology/manual';
import { saveTopologyLayout } from '../../services/topology/layouts';
import { importLegacyTopologySite, drainTopologyOutbox } from '../../services/topology/legacyImport';
import { withTopologyWrite } from '../../services/topology/writes';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

const grants = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }, { resource: 'topology', action: 'write' }];
async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: grants });
  const scope = { orgId: env.organization.id, siteId: env.site.id };
  await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, scope.orgId));
  const ctx: TopologyRequestContext = { scope,
    auth: { user: env.user, scope: 'organization', orgId: scope.orgId, partnerId: env.partner.id, accessibleOrgIds: [scope.orgId], canAccessOrg: (orgId: string) => orgId === scope.orgId } as AuthContext,
    permissions: { permissions: grants, scope: 'organization', partnerId: env.partner.id, orgId: scope.orgId, roleId: env.role.id } as UserPermissions,
  };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const node = await scoped(async () => {
    await importLegacyTopologySite(scope);
    return createTopologyManualNode(ctx, { label: 'Original', role: 'router' });
  });
  return { ctx, scoped, node };
}
function postgresLockMessage(error: unknown): string {
  let cursor = error;
  let message: string | undefined;
  for (let depth = 0; depth < 8 && cursor && typeof cursor === 'object'; depth++) {
    const item = cursor as { message?: unknown; cause?: unknown };
    if (pgErrorCode(item) === '55P03' && typeof item.message === 'string') message = item.message;
    cursor = item.cause;
  }
  if (message) return message;
  throw new Error('Expected a PostgreSQL lock-not-available cause');
}
async function timeoutMs() {
  return Number((await db.execute(sql`SELECT setting::int AS ms FROM pg_settings WHERE name='lock_timeout'`))[0]!.ms);
}
async function snapshot(ctx: TopologyRequestContext) {
  const result: Record<string, string[]> = {};
  // Read through the ambient mutation connection so partial uncommitted rows
  // cannot be hidden by another session's MVCC snapshot.
  for (const table of ['topology_site_state', 'topology_nodes', 'topology_node_bindings', 'topology_relationships', 'topology_layouts', 'topology_node_positions', 'topology_change_outbox']) {
    const rows = await db.execute<{ value: string }>(sql`SELECT to_jsonb(t)::text AS value FROM ${sql.identifier(table)} t WHERE org_id=${ctx.scope.orgId}::uuid AND site_id=${ctx.scope.siteId}::uuid ORDER BY value`);
    result[table] = rows.map(r => r.value);
  }
  const audit = await db.execute<{ value: string }>(sql`SELECT to_jsonb(t)::text AS value FROM audit_logs t WHERE org_id=${ctx.scope.orgId}::uuid AND action LIKE 'topology.%' ORDER BY value`);
  result.audit = audit.map(r => r.value);
  return result;
}
async function waitForBlocking(waiter: number, holder: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await getTestDb().execute(sql`SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`);
    if (rows[0]?.blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Direct legacy writer never reached the held capture lock');
}

describe('topology mutation source contention and bounded lock timeout', () => {
  it.each([0, 75, 1500])('bounds waits without widening and restores a prior %s ms timeout', async prior => {
    const { ctx, scoped } = await fixture();
    await scoped(async () => {
      await db.execute(sql`SELECT set_config('lock_timeout', ${`${prior}ms`}, true)`);
      await withTopologyWrite(ctx, true, async () => {
        expect(await timeoutMs()).toBe(prior === 0 ? 250 : Math.min(prior, 250));
      });
      expect(await timeoutMs()).toBe(prior);
    });
  });

  it.each(['manual_update', 'layout_update', 'layout_insert'] as const)('rolls back new %s work and preserves an already-running direct writer', async operation => {
    const { ctx, scoped, node } = await fixture();
    if (operation === 'layout_update') await scoped(() => saveTopologyLayout(ctx, 'overview', { expectedRevision: '0', positions: [{ nodeId: node.id, x: 1, y: 2, pinned: true }] }));
    // Force the rejected request to replay/ACK an earlier committed event
    // before it reaches the blocked source, proving those effects roll back.
    await scoped(() => db.update(topologyManualNodes).set({ notes: 'Queued earlier source edit' }).where(eq(topologyManualNodes.id, node.legacyId!)));
    const before = await scoped(() => snapshot(ctx));
    const [stateBefore] = await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, ctx.scope.siteId));
    let held!: (pid: number) => void;
    const heldState = new Promise<number>(resolve => { held = resolve; });
    let allowMutation!: () => void;
    const mutationMayRun = new Promise<void>(resolve => { allowMutation = resolve; });
    const mutation = scoped(async () => {
      await db.execute(sql`SET LOCAL statement_timeout='8s'`);
      await db.execute(sql`SET LOCAL lock_timeout='700ms'`);
      // This outer lock is the deterministic scheduling barrier. The actual
      // writer still takes its own state/layout locks and nested savepoint.
      await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, ctx.scope.siteId)).for('update');
      held(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
      await mutationMayRun;
      const work = operation === 'manual_update'
        ? updateTopologyManualNode(ctx, node.id, { expectedRevision: (BigInt(node.revision) + 1n).toString(), label: 'Rejected v2 edit' })
        : saveTopologyLayout(ctx, 'overview', { expectedRevision: operation === 'layout_update' ? '1' : '0', positions: [{ nodeId: node.id, x: 90, y: 100, pinned: false }] });
      const rejected = await work.then(() => { throw new Error('Contended mutation unexpectedly succeeded'); }, error => error);
      expect(rejected).toMatchObject({ code: 'topology_inventory_busy', status: 409 });
      expect(postgresLockMessage(rejected)).toMatch(operation === 'layout_insert' ? /lock timeout/ : /could not obtain lock on row/);
      expect(await timeoutMs()).toBe(700);
      expect(await snapshot(ctx)).toEqual(before);
      // The rejected save must not poison the caller's authorized transaction.
      await db.update(topologySiteState).set({ settingsRevision: 31n }).where(eq(topologySiteState.siteId, ctx.scope.siteId));
    });
    const mutationSettled = mutation.then(() => ({ completed: true }), error => ({ error }));
    let writerSettled: Promise<unknown> | undefined;
    try {
      const holder = await Promise.race([heldState, mutation.then(() => { throw new Error('Mutation exited before barrier'); })]);
      let started!: (pid: number) => void;
      const startedWriter = new Promise<number>(resolve => { started = resolve; });
      const writer = scoped(async () => {
        await db.execute(sql`SET LOCAL statement_timeout='8s'`);
        started(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
        if (operation === 'manual_update') await db.update(topologyManualNodes).set({ label: 'Committed old edit' }).where(eq(topologyManualNodes.id, node.legacyId!));
        else if (operation === 'layout_update') await db.execute(sql`UPDATE topology_layout SET x=41,y=42 WHERE node_id=${node.legacyId}::uuid`);
        else await db.execute(sql`INSERT INTO topology_layout(org_id,site_id,node_type,node_id,x,y,pinned) VALUES (${ctx.scope.orgId}::uuid,${ctx.scope.siteId}::uuid,'manual_node',${node.legacyId}::uuid,41,42,true)`);
      });
      writerSettled = writer.then(() => ({ completed: true }), error => ({ error }));
      const waiter = await Promise.race([startedWriter, writer.then(() => { throw new Error('Direct writer exited before barrier'); })]);
      await waitForBlocking(waiter, holder);
      if (operation !== 'layout_insert') {
        // Exercise NOWAIT even with an already-aged old capture waiter. The
        // invisible insert instead exercises the bounded unique-lock fallback.
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
      allowMutation();
      expect(await mutationSettled).toEqual({ completed: true });
      expect(await writerSettled).toEqual({ completed: true });
      const [after] = await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, ctx.scope.siteId));
      expect(after).toMatchObject({ settingsRevision: 31n, graphRevision: stateBefore!.graphRevision, materializedInputRevision: stateBefore!.materializedInputRevision, dirtyRevision: stateBefore!.dirtyRevision + 1n });
      // Retry the queued old source after releasing the state barrier; no
      // canonical/ACK/audit effect from the rejected v2 mutation survived.
      await scoped(async () => { expect((await drainTopologyOutbox(ctx.scope)).complete).toBe(true); });
      if (operation === 'manual_update') {
        const [legacy] = await getTestDb().select().from(topologyManualNodes).where(eq(topologyManualNodes.id, node.legacyId!));
        expect(legacy!.label).toBe('Committed old edit');
      } else {
        const [position] = await getTestDb().select().from(topologyNodePositions).where(eq(topologyNodePositions.nodeId, node.id));
        expect(position).toMatchObject({ x: 41, y: 42, pinned: true });
      }
    } finally {
      allowMutation();
      await Promise.allSettled([mutationSettled, ...(writerSettled ? [writerSettled] : [])]);
    }
  });
});
