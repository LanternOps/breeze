import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { TopologyConfigurationPayload } from '@breeze/shared';
import { closeDb, db } from '../../db';
import { topologyDiagnosticRuns, topologySiteState } from '../../db/schema';
import { armTopologyMonitoringPolicy } from '../../services/topology/monitoringArming';
import { updateTopologySiteConfiguration } from '../../services/topology/siteConfiguration';
import { seedTopologyMonitoringFixture, system } from '../helpers/topologyMonitoring';

/**
 * M3-D7 diff-aware compile against real Postgres: a settings write preserves
 * every policy whose EXECUTABLE effect is unchanged (its arm, authority and
 * revision), disarms only policies whose definition or pinned targets moved,
 * and cancels only the queued runs whose plan depends on what changed.
 */
afterAll(() => closeDb());

const web = { kind: 'tcp', label: 'web', enabled: true, families: ['ipv4'], provider: null, independenceLabel: null, host: '198.51.100.7', port: 443 } as const;
const policy = {
  kind: 'policy', enabled: true, recipeId: 'target_connectivity', recipeVersion: 1, subject: 'configured_target', targetKeys: ['web'],
  families: ['ipv4'], origin: 'eligible_collector', intervalSeconds: 300, jitterPercent: 10, alertsEnabled: true, failureThreshold: 3, recoveryThreshold: 2,
} as const;
const overrides = (patch: Partial<TopologyConfigurationPayload> = {}): TopologyConfigurationPayload => ({
  targets: { web }, policies: { 'web-check': policy }, outboundEnabled: true, ...patch,
} as TopologyConfigurationPayload);

async function armed() {
  const f = await seedTopologyMonitoringFixture();
  const write = async (payload: TopologyConfigurationPayload) => {
    const [state] = await system(() => db.select({ revision: topologySiteState.settingsRevision }).from(topologySiteState).where(eq(topologySiteState.siteId, f.siteId)));
    return f.inOrg(() => updateTopologySiteConfiguration(f.ctx, payload, state!.revision.toString()));
  };
  await write(overrides());
  const before = await f.policy();
  await f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: before.revision.toString(), extendedContexts: false }, { repository: f.repository }));
  const queuedRun = async (plan: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    await system(() => db.execute(sql`INSERT INTO topology_diagnostic_runs
      (id,org_id,site_id,recipe_id,recipe_version,requester_id,subject_node_id,origin_node_id,origin_snapshot,plan,plan_digest,idempotency_key,body_hash,attempt_id,queue_deadline,deadline)
      VALUES (${id}::uuid,${f.orgId}::uuid,${f.siteId}::uuid,'target_connectivity',1,${f.env.user.id}::uuid,${f.nodeId}::uuid,${f.nodeId}::uuid,'{}'::jsonb,
        ${JSON.stringify(plan)}::jsonb,${'c'.repeat(64)},${id},${'d'.repeat(64)},gen_random_uuid(),now()+interval '30 seconds',now()+interval '120 seconds')`));
    return async () => (await system(() => db.select().from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.id, id))))[0]!;
  };
  return { ...f, write, queuedRun, armedRow: await f.policy() };
}

describe('diff-aware policy compile (M3-D7)', () => {
  it('keeps an armed policy and unrelated queued runs across an unrelated settings write', async () => {
    const f = await armed();
    expect(f.armedRow.enabled).toBe(true);
    const targetRun = await f.queuedRun({ destinations: [{ id: 'd', target: { kind: 'configured_target', targetId: f.targetId } }] });
    await f.write(overrides({ passive: { intervalSeconds: 600 } }));
    const after = await f.policy();
    expect(after.enabled).toBe(true);
    expect(after.authorityDigest).toBe(f.armedRow.authorityDigest);
    expect(after.revision).toBe(f.armedRow.revision);
    expect((await targetRun()).state).toBe('queued');
  });

  it('disarms only a policy whose executable definition changed', async () => {
    const f = await armed();
    await f.write(overrides({ policies: { 'web-check': { ...policy, intervalSeconds: 600 } } as never }));
    const after = await f.policy();
    expect(after.enabled).toBe(false);
    expect(after.blockedReason).toBe('rearm_required');
    expect(after.authorityActor).toBeNull();
    expect(after.activationIntent).toBe(true);
  });

  it('disarms the dependent policy and cancels only the runs that pin a changed target', async () => {
    const f = await armed();
    const targetRun = await f.queuedRun({ destinations: [{ id: 'd', target: { kind: 'configured_target', targetId: f.targetId } }] });
    const gatewayRun = await f.queuedRun({ destinations: [{ id: 'g', target: { kind: 'observed_gateway', address: '192.0.2.1' } }] });
    await f.write(overrides({ targets: { web: { ...web, port: 8443 } } as never }));
    expect((await f.policy()).enabled).toBe(false);
    expect((await f.policy()).blockedReason).toBe('rearm_required');
    expect(await targetRun()).toMatchObject({ state: 'cancelled', failureReason: 'configuration_changed' });
    expect((await gatewayRun()).state).toBe('queued');
  });

  it('withdrawing the activation intent disarms without touching an unrelated arm', async () => {
    const f = await armed();
    await f.write(overrides({ policies: { 'web-check': { ...policy, enabled: false } } as never }));
    const after = await f.policy();
    expect(after.enabled).toBe(false);
    expect(after.activationIntent).toBe(false);
    expect(after.blockedReason).toBe('activation_withdrawn');
  });

  // PR #7117 C3: the compiler read a DISABLED policy, a concurrent arm then
  // committed against the old definition, and the compiler rewrote the
  // definition/revision without clearing the arm — the scheduler would run a
  // changed policy no human armed. Interleave the two deterministically: the
  // arm holds its (uncommitted) write open at the step-up hook while the
  // compile starts; the arm commits only once the compile is waiting on it.
  it('never leaves a concurrently armed policy enabled over a definition the arm did not approve (C3)', async () => {
    const f = await seedTopologyMonitoringFixture();
    const revision = async () => (await system(() => db.select({ revision: topologySiteState.settingsRevision }).from(topologySiteState).where(eq(topologySiteState.siteId, f.siteId))))[0]!.revision.toString();
    await f.inOrg(async () => updateTopologySiteConfiguration(f.ctx, overrides(), await revision()));
    const before = await f.policy();
    expect(before.enabled).toBe(false);

    let release!: () => void;
    let reachedGate!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });
    const arming = f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: before.revision.toString(), extendedContexts: false }, {
      repository: f.repository,
      consumeStepUp: async () => { reachedGate(); await gate; },
    }));
    await atGate;
    const settingsRevision = await revision();
    const compiling = f.inOrg(() => updateTopologySiteConfiguration(f.ctx, overrides({ policies: { 'web-check': { ...policy, intervalSeconds: 600 } } as never }), settingsRevision));
    for (let i = 0; i < 100; i++) {
      const [waiting] = await system(() => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%topology_monitoring_policies%'`));
      if (waiting!.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await arming;
    await compiling;

    const after = await f.policy();
    expect((after.definition as { intervalSeconds: number }).intervalSeconds).toBe(600);
    expect(after.enabled).toBe(false);
    expect(after.authorityDigest).toBeNull();
    expect(after.authorityActor).toBeNull();
    expect(after.blockedReason).toBe('rearm_required');
  });
});
