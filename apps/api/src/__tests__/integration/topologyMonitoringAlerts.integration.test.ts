import './setup';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { alerts, topologyChangeOutbox, topologyDiagnosticRuns, topologyMonitoringPolicies } from '../../db/schema';
import type { DiagnosticPlanningRepository, DiagnosticPlanningSnapshot } from '../../services/topology/diagnosticTypes';
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
  const occur = async (assessment: 'healthy' | 'failed_check', repository: DiagnosticPlanningRepository = f.repository) => {
    const now = new Date(base + tick++ * INTERVAL_MS);
    await system(() => db.update(topologyMonitoringPolicies).set({ nextScheduledAt: new Date(0) }).where(eq(topologyMonitoringPolicies.id, f.policyId)));
    const scheduled = await dispatchDueTopologyPolicies({ now, repository });
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
    expect(publish).toHaveBeenCalledWith('alert.triggered', f.orgId, expect.objectContaining({ alertId: alert!.id, topologySiteId: f.siteId }), 'topology-monitoring', expect.objectContaining({ siteId: f.siteId, eventId: expect.any(String) }));
    expect(await drainTopologyAlertTransitions({ publish })).toBe(0);

    await f.occur('healthy');
    expect((await f.occur('healthy')).recovered).toBe(1);
    expect((await f.alertRows())[0]).toMatchObject({ status: 'resolved' });
    expect((await f.policy()).alertState.entries[0]!.activeAlertId).toBeNull();
    await drainTopologyAlertTransitions({ publish });
    expect(publish).toHaveBeenLastCalledWith('alert.resolved', f.orgId, expect.objectContaining({ alertId: alert!.id }), 'topology-monitoring', expect.objectContaining({ siteId: f.siteId, eventId: expect.any(String) }));
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

  // PR #7117 review C1: the assessment used to load the OLDEST 512 runs of the
  // revision every time, so once 512 applied occurrences existed the newer
  // ones were never loaded and alerts stalled forever.
  it('keeps assessing new occurrences after more than 512 applied ones under one revision', async () => {
    const f = await monitored();
    await f.occur('healthy');
    const [template] = await system(() => db.select().from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.policyId, f.policyId)));
    const history = Array.from({ length: 520 }, (_, i) => {
      const at = new Date(template!.scheduledFor!.getTime() - (i + 1) * INTERVAL_MS);
      return {
        ...template!, id: crypto.randomUUID(), attemptId: crypto.randomUUID(), commandId: null, idempotencyKey: `c1-history-${i}`,
        occurrenceKey: (i + 1).toString(16).padStart(64, '0'), scheduledFor: at, queuedAt: at, startedAt: at, finishedAt: new Date(at.getTime() + 5_000),
        queueDeadline: new Date(at.getTime() + 30_000), deadline: new Date(at.getTime() + 120_000),
      };
    });
    await system(() => db.insert(topologyDiagnosticRuns).values(history));
    await f.occur('failed_check');
    await f.occur('failed_check');
    expect((await f.occur('failed_check')).opened).toBe(1);
    expect((await f.policy()).alertState.entries[0]).toMatchObject({ consecutiveFailures: 3 });
  });

  // PR #7117 review C6: an eligible_collector policy may run from a different
  // collector on a later occurrence. Streak continuity must follow the ACTUAL
  // origin of each run, so failures from two collectors never add up.
  it('starts a fresh streak when an eligible-collector occurrence runs from another collector', async () => {
    const f = await monitored();
    await f.occur('failed_check');
    await f.occur('failed_check');
    const otherDevice = crypto.randomUUID();
    await f.inOrg(() => db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
      VALUES (${otherDevice}::uuid,${f.orgId}::uuid,${f.siteId}::uuid,${otherDevice},'collector-2','linux','1','amd64','1')`));
    const switched: DiagnosticPlanningRepository = {
      load: async (ctx, request) => {
        const snapshot = await f.repository.load(ctx, request) as DiagnosticPlanningSnapshot;
        return { ...snapshot, candidates: snapshot.candidates.map((candidate) => ({
          ...candidate, eligibility: { ...candidate.eligibility, origin: { ...candidate.eligibility.origin, deviceId: otherDevice, agentId: otherDevice } },
        })) } as DiagnosticPlanningSnapshot;
      },
    };
    expect((await f.occur('failed_check', switched)).opened).toBe(0);
    expect(await f.alertRows()).toHaveLength(0);
    expect((await f.policy()).alertState.entries[0]).toMatchObject({ consecutiveFailures: 1, originDeviceId: otherDevice });
    const runs = await system(() => db.select().from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.policyId, f.policyId)).orderBy(topologyDiagnosticRuns.scheduledFor));
    expect(new Set(runs.map((run) => run.continuityKey)).size).toBe(2);
  });

  // PR #7117 review C7: a suppressed alert is still open (it blocks a new one
  // through the open-alert unique index), so recovery must resolve it too.
  it('recovers a suppressed alert', async () => {
    const f = await monitored();
    for (let i = 0; i < 3; i++) await f.occur('failed_check');
    const [alert] = await f.alertRows();
    await system(() => db.update(alerts).set({ status: 'suppressed' }).where(eq(alerts.id, alert!.id)));
    await f.occur('healthy');
    expect((await f.occur('healthy')).recovered).toBe(1);
    expect((await f.alertRows())[0]).toMatchObject({ id: alert!.id, status: 'resolved' });
    expect((await f.policy()).alertState.entries[0]!.activeAlertId).toBeNull();
  });

  // PR #7117 review C8: a retried transition republishes under the SAME
  // event id (the outbox row's id), and two concurrent drainers never both
  // publish one transition.
  it('publishes a transition once across concurrent drainers and with a stable event id across retries', async () => {
    const f = await monitored();
    for (let i = 0; i < 3; i++) await f.occur('failed_check');
    const [transition] = await f.transitions();
    const ids: string[] = [];
    const failing = vi.fn(async (_type: string, _org: string, _payload: unknown, _source: string, options?: { eventId?: string }) => {
      ids.push(options?.eventId ?? 'none');
      throw new Error('transport down');
    });
    expect(await drainTopologyAlertTransitions({ publish: failing as never })).toBe(0);
    await system(() => db.update(topologyChangeOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(topologyChangeOutbox.id, transition!.id)));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.fn(async (_type: string, _org: string, _payload: unknown, _source: string, options?: { eventId?: string }) => {
      ids.push(options?.eventId ?? 'none');
      await gate;
      return options?.eventId ?? 'event';
    });
    const first = drainTopologyAlertTransitions({ publish: slow as never });
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    // A second drainer while the first is mid-publish must not claim the row.
    const concurrent = vi.fn(async () => 'event');
    const second = await drainTopologyAlertTransitions({ publish: concurrent as never });
    release();
    expect(await first + second).toBe(1);
    expect(concurrent).not.toHaveBeenCalled();
    expect(ids).toEqual([transition!.id, transition!.id]);
    expect(((await f.transitions())[0]!.payload as { state: string }).state).toBe('applied');
  });
});
