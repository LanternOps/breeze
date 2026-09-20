import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { closeDb, db, withDbAccessContext } from '../../db';
import { topologyNodes, topologyNodeBindings, topologySiteState } from '../../db/schema';
import { publishTopologyBuild, type PublicationInput } from '../../services/topology/publish';
import { legacyNodeIdentity } from '../../services/topology/legacyProjection';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { createSite } from './db-utils';
import { getTestDb } from './setup';

afterAll(() => closeDb());
const sources = [
  ['devices', 'deviceId'], ['discovered_assets', 'discoveredAssetId'], ['topology_manual_nodes', 'manualNodeId'],
] as const;

async function waitForBlocking(waiter: number, holder: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await getTestDb().execute(sql`SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`);
    if (rows[0]?.blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Inventory writer did not reach the held topology state');
}

describe('inventory FK and topology publication concurrency', () => {
  it.each(sources)('retries publication without deadlocking a %s deletion', async (table, field) => {
    await overlap(table, field, 'delete');
  });
  it('retries publication without deadlocking a device site move', async () => {
    await overlap('devices', 'deviceId', 'move');
  });
});

async function overlap(table: typeof sources[number][0], field: typeof sources[number][1], operation: 'delete' | 'move') {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const destination = await createSite({ orgId: scope.orgId });
  const sourceId = randomUUID();
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  await scoped(async () => {
    if (table === 'devices') await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
      VALUES (${sourceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${sourceId},'fixture','linux','1','amd64','1')`);
    else if (table === 'discovered_assets') await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address)
      VALUES (${sourceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'192.0.2.4')`);
    else await db.execute(sql`INSERT INTO topology_manual_nodes (id,org_id,site_id,label,role)
      VALUES (${sourceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'fixture','switch')`);
  });
  const [before] = await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId));
  const node = { ...scope, ...legacyNodeIdentity(scope, table, sourceId), attributes: {} };
  const input: PublicationInput = { buildFence: before!.buildFence.toString(), inputRevision: before!.dirtyRevision.toString(), nodes: [node], relationships: [],
    bindings: [{ ...scope, id: randomUUID(), nodeId: node.id, [field]: sourceId }] };
  let signalState!: (pid: number) => void;
  const heldState = new Promise<number>(resolve => { signalState = resolve; });
  let allowPublish!: () => void;
  const mayPublish = new Promise<void>(resolve => { allowPublish = resolve; });
  const publisher = scoped(async () => {
    await db.execute(sql`SET LOCAL statement_timeout='8s'`);
    await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)).for('update');
    signalState(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
    await mayPublish;
    return publishTopologyBuild(scope, input);
  });
  const publisherSettled = publisher.then(value => ({ value }), error => ({ code: pgErrorCode(error) }));
  let writerSettled: Promise<unknown> | undefined;
  try {
    const holder = await Promise.race([heldState, publisher.then(() => { throw new Error('Publisher exited before holding state'); })]);
    let signalWriter!: (pid: number) => void;
    const writerStarted = new Promise<number>(resolve => { signalWriter = resolve; });
    const writer = scoped(async () => {
      await db.execute(sql`SET LOCAL statement_timeout='8s'`);
      signalWriter(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
      if (operation === 'delete') await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE id=${sourceId}::uuid`);
      else await db.execute(sql`UPDATE devices SET site_id=${destination.id}::uuid WHERE id=${sourceId}::uuid`);
    });
    writerSettled = writer.then(() => ({ completed: true }), error => ({ code: pgErrorCode(error) }));
    const waiter = await Promise.race([writerStarted, writer.then(() => { throw new Error('Writer exited before signaling backend'); })]);
    await waitForBlocking(waiter, holder);
    allowPublish();
    // A non-blocking FK preflight must yield the rebuild, leaving the user's
    // deletion/move free to commit and fence the now-obsolete snapshot.
    expect({ publisher: await publisherSettled, writer: await writerSettled }).toEqual({ publisher: { code: '55P03' }, writer: { completed: true } });
    expect(await getTestDb().select().from(topologyNodes)).toHaveLength(0);
    expect(await getTestDb().select().from(topologyNodeBindings)).toHaveLength(0);
    const [after] = await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId));
    expect(after!.materializedInputRevision).toBe(before!.materializedInputRevision);
    expect(after!.dirtyRevision).toBe(before!.dirtyRevision + 1n);
    // No binding existed before this first publication, so there was nothing
    // for the lifecycle hook to detach/fence. Even that stale retry cannot
    // bind the now-missing or moved inventory source under the old scope.
    await expect(scoped(() => publishTopologyBuild(scope, input))).rejects.toSatisfy(error => pgErrorCode(error) === '23503');
    expect(await getTestDb().select().from(topologyNodes)).toHaveLength(0);
  } finally {
    allowPublish();
    await Promise.allSettled([publisherSettled, ...(writerSettled ? [writerSettled] : [])]);
  }
}
