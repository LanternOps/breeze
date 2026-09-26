import './setup';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { alerts, topologyChangeOutbox, topologyMonitoringPolicies } from '../../db/schema';
import { getAlertWithOrgCheck } from '../../routes/alerts/helpers';
import { drainTopologyAlertTransitions } from '../../services/topology/monitoringAlerts';
import { drainTopologyMonitoringAssessments } from '../../services/topology/monitoringAssessment';
import { dispatchDueTopologyPolicies } from '../../services/topology/monitoringScheduler';
import { pgFailure, seedScheduledMonitoringFixture, system } from '../helpers/topologyMonitoring';
import { createTopologyTenant } from './topology-fixtures';

/**
 * M3 Task 8 against real Postgres: scheduled results and gaps advance the
 * per-context streak in slot order; the configured thresholds open exactly one
 * SITE-owned alert and recover it; notification fan-out is a typed,
 * idempotent consumer; ownership is immutable and follows the topology site,
 * never the origin device's current site or org.
 */
afterAll(() => closeDb());

const INTERVAL_MS = 300_000;

async function monitored() {
  const f = await seedScheduledMonitoringFixture();
  const base = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS + 60_000;
  let tick = 0;
  /** Schedule the next slot and settle its run with `assessment`. */
  const occur = async (assessment: 'healthy' | 'failed_check') => {
    const now = new Date(base + tick++ * INTERVAL_MS);
    await system(() => db.update(topologyMonitoringPolicies).set({ nextScheduledAt: new Date(0) }).where(eq(topologyMonitoringPolicies.id, f.policyId)));
    const scheduled = await dispatchDueTopologyPolicies({ now, repository: f.repository });
    expect(scheduled.scheduled).toBe(1);
    await system(() => db.execute(sql`UPDATE topology_diagnostic_runs SET state='completed', assessment=${assessment}, coverage='complete',
      started_at=queued_at, finished_at=queued_at + interval '5 seconds' WHERE policy_id=${f.policyId}::uuid AND state='queued'`));
    return drainTopologyMonitoringAssessments({ now });
  };
  const alertRows = () => system(() => db.select().from(alerts).where(eq(alerts.orgId, f.orgId)));
  const transitions = () => system(() => db.select().from(topologyChangeOutbox)
    .where(and(eq(topologyChangeOutbox.orgId, f.orgId), eq(topologyChangeOutbox.eventKind, 'monitoring.alert_transition'))));
  return { ...f, occur, alertRows, transitions };
}

describe('recurring health streaks and site-owned alerts (M3 Task 8)', () => {
  it('opens one site-owned alert at the configured threshold and recovers it', async () => {
    const f = await monitored();
    await f.occur('failed_check');
    await f.occur('failed_check');
    expect(await f.alertRows()).toHaveLength(0);
    expect((await f.occur('failed_check')).opened).toBe(1);
    const [alert] = await f.alertRows();
    expect(alert).toMatchObject({ status: 'active', topologySiteId: f.siteId, deviceId: f.deviceId, ruleId: null });
    expect(alert!.topologySourceKey).toMatch(/^topology:[a-f0-9]{64}$/);
    const policy = await f.policy();
    expect(policy.alertState.entries[0]).toMatchObject({ consecutiveFailures: 3, activeAlertId: alert!.id });

    // A fourth failure keeps the SAME alert (no duplicate).
    await f.occur('failed_check');
    expect(await f.alertRows()).toHaveLength(1);

    const publish = vi.fn(async () => 'event-id');
    expect(await drainTopologyAlertTransitions({ publish })).toBe(1);
    expect(publish).toHaveBeenCalledWith('alert.triggered', f.orgId, expect.objectContaining({ alertId: alert!.id, topologySiteId: f.siteId }), 'topology-monitoring', { siteId: f.siteId });
    expect(await drainTopologyAlertTransitions({ publish })).toBe(0);

    await f.occur('healthy');
    expect((await f.occur('healthy')).recovered).toBe(1);
    expect((await f.alertRows())[0]).toMatchObject({ status: 'resolved' });
    expect((await f.policy()).alertState.entries[0]!.activeAlertId).toBeNull();
    await drainTopologyAlertTransitions({ publish });
    expect(publish).toHaveBeenLastCalledWith('alert.resolved', f.orgId, expect.objectContaining({ alertId: alert!.id }), 'topology-monitoring', { siteId: f.siteId });
    expect((await f.transitions()).every((row) => (row.payload as { state: string }).state === 'applied')).toBe(true);
  });

  it('breaks a failure streak on a collection gap', async () => {
    const f = await monitored();
    await f.occur('failed_check');
    await f.occur('failed_check');
    // Exhaust the shared budget so the next slot becomes a gap.
    for (let i = 0; i < 4; i++) {
      const id = crypto.randomUUID();
      await system(() => db.execute(sql`INSERT INTO topology_diagnostic_runs
        (id,org_id,site_id,recipe_id,recipe_version,requester_id,subject_node_id,origin_node_id,origin_snapshot,plan,plan_digest,idempotency_key,body_hash,attempt_id,queue_deadline,deadline)
        VALUES (${id}::uuid,${f.orgId}::uuid,${f.siteId}::uuid,'gateway_basic',1,${f.env.user.id}::uuid,${f.nodeId}::uuid,${f.nodeId}::uuid,'{}'::jsonb,'{}'::jsonb,${'c'.repeat(64)},${id},${'d'.repeat(64)},gen_random_uuid(),now()+interval '30 seconds',now()+interval '120 seconds')`));
    }
    await system(() => db.update(topologyMonitoringPolicies).set({ nextScheduledAt: new Date(0) }).where(eq(topologyMonitoringPolicies.id, f.policyId)));
    const gapAt = new Date(Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS + 60_000 + 2 * INTERVAL_MS);
    expect((await dispatchDueTopologyPolicies({ now: gapAt, repository: f.repository })).gaps).toBe(1);
    await drainTopologyMonitoringAssessments({ now: gapAt });
    expect((await f.policy()).alertState.entries[0]).toMatchObject({ consecutiveFailures: 0 });
    expect(await f.alertRows()).toHaveLength(0);
  });

  it('keeps ownership immutable and authorizes by the topology site, not the origin device', async () => {
    const f = await monitored();
    for (let i = 0; i < 3; i++) await f.occur('failed_check');
    const [alert] = await f.alertRows();
    const otherSite = await system(async () => {
      const [row] = await db.execute<{ id: string }>(sql`INSERT INTO sites (org_id,name) VALUES (${f.orgId}::uuid,'elsewhere') RETURNING id`);
      return row!.id;
    });
    // The origin device moves to another site: the alert stays with its topology site.
    await system(() => db.execute(sql`UPDATE devices SET site_id=${otherSite}::uuid WHERE id=${f.deviceId}::uuid`));
    const auth = (allowedSiteIds: string[]) => ({ canAccessOrg: (id: string) => id === f.orgId, allowedSiteIds });
    expect(await system(() => getAlertWithOrgCheck(alert!.id, auth([otherSite])))).toBeNull();
    expect(await system(() => getAlertWithOrgCheck(alert!.id, auth([f.siteId])))).toMatchObject({ id: alert!.id });

    // A device move-org re-stamp (the cascade loop) cannot carry it into another tenant.
    const other = await createTopologyTenant();
    await system(() => db.execute(sql`UPDATE alerts SET org_id=${other.orgId}::uuid WHERE device_id=${f.deviceId}::uuid`));
    expect((await f.alertRows())[0]!.orgId).toBe(f.orgId);

    expect(await pgFailure(system(() => db.execute(sql`UPDATE alerts SET topology_site_id=${otherSite}::uuid WHERE id=${alert!.id}::uuid`))))
      .toMatch(/ownership is immutable/);
    expect(await pgFailure(system(() => db.execute(sql`UPDATE alerts SET topology_source_key=NULL WHERE id=${alert!.id}::uuid`))))
      .toMatch(/ownership is immutable|alerts_topology_owner_chk/);
    const [plain] = await system(() => db.execute<{ id: string }>(sql`INSERT INTO alerts (device_id,org_id,severity,title) VALUES (${f.deviceId}::uuid,${f.orgId}::uuid,'low','plain') RETURNING id`));
    expect(await pgFailure(system(() => db.execute(sql`UPDATE alerts SET topology_site_id=${f.siteId}::uuid, topology_source_key=${'topology:' + 'a'.repeat(64)} WHERE id=${plain!.id}::uuid`))))
      .toMatch(/set only at insert/);
  });
});
