import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { closeDb, withDbAccessContext } from '../../db';
import { organizations, topologyManualNodes, topologySiteState } from '../../db/schema';
import { createTopologyRoutes } from '../../routes/topology';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

const app = new Hono().route('/topology', createTopologyRoutes());
const scope = (env: TestEnvironment) => ({ orgId: env.organization.id, siteId: env.site.id });
const request = (env: TestEnvironment, resource: string, method = 'GET', body?: unknown) => app.request(
  `/topology/sites/${env.site.id}/${resource}`,
  { method, headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
);
const readState = async (env: TestEnvironment) => (await getTestDb().select().from(topologySiteState)
  .where(eq(topologySiteState.siteId, env.site.id)))[0];

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: [
    { resource: 'topology', action: 'read' }, { resource: 'topology', action: 'write' },
    { resource: 'devices', action: 'read' },
  ] });
  await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true, ui: true } } })
    .where(eq(organizations.id, env.organization.id));
  return env;
}

async function expectUi(env: TestEnvironment, available: boolean) {
  const before = await readState(env);
  const response = await request(env, 'settings');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ capabilities: {
    ui: { available, reason: available ? null : 'topology_preparing' },
  } });
  // Capability reads neither initialize a site nor advance its state.
  expect(await readState(env)).toEqual(before);
}

describe('topology settings readiness agrees with initialized mutation capability', () => {
  it('makes a completed empty import ready without manufacturing a structural revision', async () => {
    const env = await fixture();
    expect(await readState(env)).toBeUndefined();
    await expectUi(env, false);
    const result = await withDbAccessContext(orgContext(env.organization.id), () => importLegacyTopologySite(scope(env)));
    expect(result.complete).toBe(true);
    expect((await readState(env))?.graphRevision).toBe(0n);
    await expectUi(env, true);
    const write = await request(env, 'manual-nodes', 'POST', { label: 'First node', role: 'router' });
    expect(write.status).toBe(201);
  });

  it('keeps a partially materialized snapshot preparing until its checkpoint completes', async () => {
    const env = await fixture();
    await getTestDb().insert(topologyManualNodes).values([
      { ...scope(env), label: 'First', role: 'router' },
      { ...scope(env), label: 'Second', role: 'switch' },
    ]);
    const result = await withDbAccessContext(orgContext(env.organization.id), () => importLegacyTopologySite(scope(env), { batchSize: 1 }));
    expect(result.complete).toBe(false);
    expect((await readState(env))!.graphRevision).toBeGreaterThan(0n);
    await expectUi(env, false);
    const write = await request(env, 'manual-nodes', 'POST', { label: 'Too early', role: 'router' });
    expect(write.status).toBe(409);
    expect(await write.json()).toMatchObject({ code: 'topology_preparing' });
    const drained = await withDbAccessContext(orgContext(env.organization.id), () => drainTopologyOutbox(scope(env)));
    expect(drained.complete).toBe(true);
    await expectUi(env, true);
  });

  it('does not mistake a lifecycle revision without an import checkpoint for readiness', async () => {
    const env = await fixture();
    // Org-merge finalization also advances graph_revision on previously empty
    // site state. It cannot certify a completed legacy snapshot.
    await getTestDb().insert(topologySiteState).values({ ...scope(env), graphRevision: 1n });
    await expectUi(env, false);
    const write = await request(env, 'manual-nodes', 'POST', { label: 'Not imported', role: 'router' });
    expect(write.status).toBe(409);
    expect(await write.json()).toMatchObject({ code: 'topology_preparing' });
  });
});
