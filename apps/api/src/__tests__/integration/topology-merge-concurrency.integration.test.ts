import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import * as orgMerge from '../../services/orgMerge';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { publishTopologyBuild, type NodePublication, type PublicationInput } from '../../services/topology/publish';
import { createOrganization, createPartner } from './db-utils';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

const actor = '00000000-0000-0000-0000-000000000000';
const scoped = <T>(scope: TopologyScope, fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function node(scope: TopologyScope, sourceKey: string): NodePublication {
  return { ...scope, id: randomUUID(), kind: 'endpoint', identityKey: canonicalIdentityKey(scope, 'endpoint', sourceKey),
    identityMaterial: { version: 1, kind: 'endpoint', sourceKey }, attributes: { label: 'Retained endpoint' } };
}
const input = (nodes: NodePublication[], overrides: Partial<PublicationInput> = {}): PublicationInput => ({
  nodes, relationships: [], bindings: [], buildFence: '2', inputRevision: '1', ...overrides,
});

async function fixture(alias: boolean) {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const survivor = await createOrganization({ partnerId: tenant.partnerId });
  const deviceId = randomUUID(); const assetId = randomUUID();
  const canonical = node(scope, `device:${deviceId}`);
  const second = node(scope, `asset:${assetId}`);
  const layoutId = randomUUID();
  await scoped(scope, async () => {
    if (alias) {
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
        VALUES (${deviceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${deviceId},'fixture','linux','1','amd64','1')`);
      await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,linked_device_id,link_source)
        VALUES (${assetId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'192.0.2.1',${deviceId}::uuid,'manual')`);
    }
    await db.execute(sql`INSERT INTO topology_site_state (org_id,site_id,dirty_revision,build_fence)
      VALUES (${scope.orgId}::uuid,${scope.siteId}::uuid,10,2)
      ON CONFLICT (org_id,site_id) DO UPDATE SET dirty_revision=10,build_fence=2`);
    expect(await publishTopologyBuild(scope, input(alias ? [canonical, second] : [canonical], { bindings: alias ? [
      { ...scope, id: randomUUID(), nodeId: canonical.id, deviceId },
      { ...scope, id: randomUUID(), nodeId: second.id, discoveredAssetId: assetId },
    ] : [] }))).toEqual({ published: true, graphRevision: '1' });
    await db.execute(sql`UPDATE topology_nodes SET created_at='2020-01-01' WHERE id=${canonical.id}::uuid`);
    await db.execute(sql`INSERT INTO topology_layouts (id,org_id,site_id,view,revision)
      VALUES (${layoutId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'overview',7)`);
    // Keep the pin on the canonical UUID: alias publication must reach its
    // organization FK audit without a position INSERT masking that lock path.
    await db.execute(sql`INSERT INTO topology_node_positions (org_id,site_id,layout_id,node_id,x,y,pinned,position_source)
      VALUES (${scope.orgId}::uuid,${scope.siteId}::uuid,${layoutId}::uuid,${canonical.id}::uuid,11,22,true,'user')`);
  });
  return { ...tenant, scope, survivor, canonical, second, layoutId };
}

/** Prove the requested SQL is genuinely waiting for the other transaction,
 * rather than relying on scheduling sleeps to claim a concurrency test. */
async function waitForBlocking(waiter: number, holder: number, query: RegExp) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = await getTestDb().execute(sql`SELECT ${holder}::int = ANY(pg_blocking_pids(pid)) AS blocked,
      query, wait_event_type FROM pg_stat_activity WHERE pid=${waiter}::int`);
    const row = rows[0];
    if (row?.blocked === true) {
      expect(row.wait_event_type).toBe('Lock');
      expect(row.query).toMatch(query);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${waiter} never reached its expected lock barrier`);
}

async function readyBeforeCompletion<T>(ready: Promise<T>, running: Promise<unknown>) {
  return Promise.race([ready, running.then(() => { throw new Error('Transaction finished before its barrier'); })]);
}

beforeEach(() => { vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('topology publication overlapping an actual organization merge', () => {
  it.each(['new node', 'accepted alias audit'] as const)('lets an already-running %s publication commit before fencing and rekeying it', async kind => {
    const alias = kind === 'accepted alias audit';
    const f = await fixture(alias);
    const releaseWriter = deferred<void>();
    const writerReady = deferred<number>();
    const mergeReady = deferred<number>();
    const actualValidate = orgMerge.assertPairStillMergeable;
    // Observe the actual transaction, after the real pair locks and checks.
    // All fence, export locks, registry passes, fixups and commits still run.
    vi.spyOn(orgMerge, 'assertPairStillMergeable').mockImplementation(async (...args) => {
      await actualValidate(...args);
      await db.execute(sql`SET LOCAL statement_timeout='10s'`);
      const [row] = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      mergeReady.resolve(Number(row!.pid));
    });
    const writer = scoped(f.scope, async () => {
      await db.execute(sql`SET LOCAL statement_timeout='10s'`);
      await db.execute(sql`SELECT site_id FROM topology_site_state WHERE site_id=${f.siteId}::uuid FOR UPDATE`);
      const [row] = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      writerReady.resolve(Number(row!.pid));
      await releaseWriter.promise;
      return publishTopologyBuild(f.scope, input([alias ? { ...f.second, aliasTargetId: f.canonical.id } : f.second], { inputRevision: '2' }));
    });
    void writer.catch(() => {}); // Attach now; failures are asserted below after releasing all barriers.
    let merge: ReturnType<typeof orgMerge.executeOrgMerge> | undefined;
    try {
      const writerPid = await readyBeforeCompletion(writerReady.promise, writer);
      merge = orgMerge.executeOrgMerge({ loserOrgId: f.orgId, survivorOrgId: f.survivor.id, partnerId: f.partnerId, performedBy: actor });
      void merge.catch(() => {});
      const mergePid = await readyBeforeCompletion(mergeReady.promise, merge);
      await waitForBlocking(mergePid, writerPid, /topology_site_state/);
      releaseWriter.resolve();
      const [publication, result] = await Promise.all([writer, merge]);
      expect(publication).toEqual({ published: true, graphRevision: '2' });
      expect(result.topology).toEqual({ rekeyed: 2, fenced: 1 });
    } finally {
      releaseWriter.resolve();
      await Promise.allSettled(merge ? [writer, merge] : [writer]);
    }
    const survivorScope = { orgId: f.survivor.id, siteId: f.siteId };
    await scoped(survivorScope, async () => {
      const nodes = await db.execute(sql`SELECT id,identity_key,alias_target_id FROM topology_nodes
        WHERE org_id=${f.survivor.id}::uuid AND site_id=${f.siteId}::uuid ORDER BY id`);
      expect(nodes).toHaveLength(2);
      for (const expected of [f.canonical, f.second]) {
        expect(nodes.find(row => row.id === expected.id)).toEqual({ id: expected.id,
          identity_key: canonicalIdentityKey(survivorScope, 'endpoint', expected.identityMaterial.sourceKey as string),
          alias_target_id: alias && expected.id === f.second.id ? f.canonical.id : null });
      }
      expect((await db.execute(sql`SELECT layout_id,node_id,x,y,pinned FROM topology_node_positions WHERE site_id=${f.siteId}::uuid`))[0])
        .toEqual({ layout_id: f.layoutId, node_id: f.canonical.id, x: 11, y: 22, pinned: true });
      expect((await db.execute(sql`SELECT revision::text FROM topology_layouts WHERE id=${f.layoutId}::uuid`))[0]).toEqual({ revision: '7' });
      expect((await db.execute(sql`SELECT build_fence::text,materialized_input_revision::text,graph_revision::text
        FROM topology_site_state WHERE site_id=${f.siteId}::uuid`))[0])
        .toEqual({ build_fence: '3', materialized_input_revision: '2', graph_revision: '3' });
      expect(await publishTopologyBuild(survivorScope, input([], { inputRevision: '3' }))).toEqual({ published: false, graphRevision: '3' });
      if (alias) {
        expect((await db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE site_id=${f.siteId}::uuid`)).map(row => row.node_id))
          .toEqual([f.canonical.id, f.canonical.id]);
      }
    });
    if (alias) {
      // Immutable audit history intentionally stays under the original org.
      const audits = await getTestDb().execute(sql`SELECT details FROM audit_logs WHERE org_id=${f.orgId}::uuid AND action='topology.alias_merged'`);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ canonicalId: f.canonical.id, aliasId: f.second.id, inputRevision: '2', evidence: 'accepted_link' });
    }
  }, 60000);

  it.each(['status', 'owner'] as const)('still blocks a competing parent %s update until validation releases its locks', async field => {
    const f = await createTopologyTenant();
    const survivor = await createOrganization({ partnerId: f.partnerId });
    const otherPartner = await createPartner();
    await getTestDb().execute(sql`UPDATE organizations SET status='merging' WHERE id=${f.orgId}::uuid`);
    const loser = { id: f.orgId, partnerId: f.partnerId, name: 'Loser', type: 'customer', status: 'active', deletedAt: null };
    const release = deferred<void>(); const holderReady = deferred<number>(); const contenderReady = deferred<number>();
    const holder = withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL statement_timeout='10s'`);
      await orgMerge.assertPairStillMergeable(loser, survivor);
      const [row] = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      holderReady.resolve(Number(row!.pid));
      await release.promise;
    });
    void holder.catch(() => {});
    let contender: Promise<unknown> | undefined;
    try {
      const holderPid = await readyBeforeCompletion(holderReady.promise, holder);
      contender = getTestDb().transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        contenderReady.resolve(Number(row!.pid));
        await tx.execute(field === 'status'
          ? sql`UPDATE organizations SET status='suspended' WHERE id=${survivor.id}::uuid`
          : sql`UPDATE organizations SET partner_id=${otherPartner.id}::uuid WHERE id=${survivor.id}::uuid`);
      });
      void contender.catch(() => {});
      const contenderPid = await readyBeforeCompletion(contenderReady.promise, contender);
      await waitForBlocking(contenderPid, holderPid, /UPDATE organizations/);
      release.resolve();
      await Promise.all([holder, contender]);
    } finally {
      release.resolve();
      await Promise.allSettled(contender ? [holder, contender] : [holder]);
    }
    await expect(withSystemDbAccessContext(() => orgMerge.assertPairStillMergeable(loser, survivor)))
      .rejects.toThrow(field === 'status' ? /active or trial/i : /same partner/i);
  });
});
