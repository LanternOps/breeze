import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { topologyMonitoringPolicies } from '../../db/schema';
import { disarmTopologyMonitoringPolicy } from '../../services/topology/monitoringArming';
import { dispatchDueTopologyPolicies } from '../../services/topology/monitoringScheduler';
import { policyHealthContributor } from '../../services/topology/policyHealth';
import { aggregateTopologySubjectHealth, readTopologySubjectHealth } from '../../services/topology/subjectHealth';
import { seedScheduledMonitoringFixture, system } from '../helpers/topologyMonitoring';
import { createTopologyTenant } from './topology-fixtures';

/**
 * M3-D10 policy branch against real Postgres, read as breeze_app under the
 * org's RLS context: a settled scheduled run is current health for the node it
 * measured from; a disarm makes that subject unmonitored immediately (the old
 * result is fenced by revision, not by the sweeper); another tenant sees nothing.
 */
afterAll(() => closeDb());

describe('recurring policy health contributor (M3-D10)', () => {
  it('projects the settled scheduled run, then fences it on disarm', async () => {
    const f = await seedScheduledMonitoringFixture();
    await f.makeDue();
    expect(await dispatchDueTopologyPolicies({ now: new Date(), repository: f.repository })).toMatchObject({ scheduled: 1 });
    const [run] = await f.runs();
    expect(run!.subjectNodeId).toBe(f.nodeId);
    const read = (ctx = f.ctx, inScope = f.inOrg) => inScope(() => readTopologySubjectHealth(
      { executor: db, ctx, subjects: [{ kind: 'node', id: f.nodeId }], now: new Date(), exposure: { interfaceHealth: false } },
      [policyHealthContributor]));

    // Queued only: nothing settled yet, so the policy says nothing about the node.
    expect((await read()).get(`node:${f.nodeId}`)).toBeUndefined();

    await system(() => db.execute(sql`UPDATE topology_diagnostic_runs SET state='completed', assessment='failed_check', coverage='complete',
      reasons='["tcp_check_failed"]'::jsonb, started_at=now(), finished_at=now() WHERE id=${run!.id}::uuid`));
    const settled = (await read()).get(`node:${f.nodeId}`)!;
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ source: 'policy', status: 'failed_check', freshness: 'fresh', coverage: 'monitored', resultId: run!.id, reasons: ['tcp_check_failed'] });
    // 300 s cadence → fresh for 900 s.
    expect(Date.parse(settled[0]!.freshUntil!) - Date.parse(run!.queuedAt.toISOString())).toBeGreaterThan(800_000);
    expect(aggregateTopologySubjectHealth('node', settled, new Date()).health).toMatchObject({ status: 'failed_check', resultId: run!.id });

    // Another tenant's scope reads nothing, even for the same subject id.
    const other = await createTopologyTenant();
    const otherCtx = { ...f.ctx, scope: { orgId: other.orgId, siteId: other.siteId } };
    expect((await read(otherCtx, (fn) => system(fn))).size).toBe(0);

    const policy = (await system(() => db.select().from(topologyMonitoringPolicies).where(eq(topologyMonitoringPolicies.id, f.policyId))))[0]!;
    await f.inOrg(() => disarmTopologyMonitoringPolicy(f.ctx, f.policyId, policy.revision.toString()));
    const disarmed = (await read()).get(`node:${f.nodeId}`)!;
    expect(disarmed).toEqual([expect.objectContaining({ source: 'policy', status: 'unknown', coverage: 'unmonitored', resultId: null, freshUntil: null })]);
  });
});
