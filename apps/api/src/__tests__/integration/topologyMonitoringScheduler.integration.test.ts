import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { topologyChangeOutbox, topologyDiagnosticRuns, topologyMonitoringPolicies, users } from '../../db/schema';
import type { DiagnosticPlanningRepository, DiagnosticPlanningSnapshot } from '../../services/topology/diagnosticTypes';
import { dispatchTopologyDiagnosticRun, validateTopologyCommandAuthority } from '../../services/topology/diagnosticDispatch';
import { armTopologyMonitoringPolicy } from '../../services/topology/monitoringArming';
import { dispatchDueTopologyPolicies } from '../../services/topology/monitoringScheduler';
import { disarmTopologyMonitoringPolicy } from '../../services/topology/monitoringArming';
import { seedTopologyMonitoringFixture, system } from '../helpers/topologyMonitoring';

/**
 * M3 Task 7 scheduler against real Postgres/Redis: one claimed slot per armed
 * context/family, committed with its run (or a bounded gap) and the streak CAS;
 * no catch-up after downtime; budgets produce gaps, not failures; revoked
 * authority disarms; scheduled runs carry the frozen requester authority and
 * are fenced at delivery once their policy is disarmed.
 */
afterAll(() => closeDb());

const web = { kind: 'tcp', label: 'web', enabled: true, families: ['ipv4'], provider: null, independenceLabel: null, host: '198.51.100.7', port: 443 } as const;

async function scheduled() {
  const f = await seedTopologyMonitoringFixture();
  const unpinned = crypto.randomUUID();
  const [binding] = await system(() => db.execute<{ id: string }>(sql`SELECT id FROM topology_node_bindings WHERE node_id = ${f.nodeId}::uuid`));
  const origin = { deviceId: f.deviceId, agentId: f.deviceId, nodeId: f.nodeId, bindingId: binding!.id, siteId: f.siteId, contextKey: 'default',
    interfaceId: null, interfaceEpoch: null, interfaceKey: null, sourceId: f.sourceId, producerEpoch: 'epoch-1', sequence: '1' };
  const repository: DiagnosticPlanningRepository = {
    load: async () => ({
      graphRevision: '0',
      settings: { binding: { orgId: f.orgId, siteId: f.siteId }, layers: { partner: null, organization: null, defaultsVersion: 1, resolverVersion: 1 },
        resolved: { settings: { outboundEnabled: true } }, settingsRevision: '0', templateRevisions: {} },
      targets: [
        { id: unpinned, revision: '1', definition: { ...web, host: '203.0.113.9' } },
        { id: f.targetId, revision: '1', definition: web },
      ],
      candidates: [{ eligibility: { origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 }, routes: [], resolvers: [], gatewayEvidence: [], resolverEvidence: {},
        capabilities: new Set(['network_diagnostic', 'route_lookup']) }],
    }) as unknown as DiagnosticPlanningSnapshot,
  };
  const before = await f.policy();
  await f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: before.revision.toString(), extendedContexts: false }, { repository: f.repository }));
  const makeDue = (lastClaimed: string | null = null) => system(async () => {
    const row = (await db.select().from(topologyMonitoringPolicies).where(eq(topologyMonitoringPolicies.id, f.policyId)))[0]!;
    const entries = row.alertState.entries.map((entry) => ({ ...entry, lastClaimedScheduledFor: lastClaimed }));
    await db.update(topologyMonitoringPolicies).set({ nextScheduledAt: new Date(0), alertState: { schemaVersion: 1, entries } }).where(eq(topologyMonitoringPolicies.id, f.policyId));
  });
  const runs = () => system(() => db.select().from(topologyDiagnosticRuns).where(and(eq(topologyDiagnosticRuns.orgId, f.orgId), eq(topologyDiagnosticRuns.policyId, f.policyId))));
  const gaps = () => system(() => db.select().from(topologyChangeOutbox).where(and(eq(topologyChangeOutbox.orgId, f.orgId), eq(topologyChangeOutbox.eventKind, 'monitoring.gap'))));
  return { ...f, repository, unpinned, makeDue, runs, gaps };
}

describe('recurring policy scheduler (M3 Task 7)', () => {
  it('claims one slot per armed context with a pinned-target run carrying the frozen requester', async () => {
    const f = await scheduled();
    await f.makeDue();
    const now = new Date();
    expect(await dispatchDueTopologyPolicies({ now, repository: f.repository })).toMatchObject({ scheduled: 1, gaps: 0, disarmed: 0 });
    const [run] = await f.runs();
    expect(run).toMatchObject({ policyId: f.policyId, scheduledContextKey: 'default', scheduledFamily: 'ipv4', requesterId: f.env.user.id });
    expect(run!.requesterAuthority).toMatchObject({ userId: f.env.user.id });
    expect(run!.idempotencyKey).toBe(run!.occurrenceKey);
    const targets = run!.plan.destinations.flatMap((d) => d.target.kind === 'configured_target' ? [d.target.targetId] : []);
    expect(targets).toEqual([f.targetId]);
    const policy = await f.policy();
    expect(policy.nextScheduledAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(policy.alertState.entries[0]!.lastClaimedScheduledFor).toBe(run!.scheduledFor!.toISOString());

    // The same slot again (forced due) is a no-op, never a second run.
    await system(() => db.update(topologyMonitoringPolicies).set({ nextScheduledAt: new Date(0) }).where(eq(topologyMonitoringPolicies.id, f.policyId)));
    expect(await dispatchDueTopologyPolicies({ now, repository: f.repository })).toMatchObject({ scheduled: 0 });
    expect(await f.runs()).toHaveLength(1);
  });

  it('does not replay missed intervals after downtime: one run and one bounded gap', async () => {
    const f = await scheduled();
    const now = new Date();
    await f.makeDue(new Date(now.getTime() - 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '.000Z'));
    expect(await dispatchDueTopologyPolicies({ now, repository: f.repository })).toMatchObject({ scheduled: 1, gaps: 1 });
    expect(await f.runs()).toHaveLength(1);
    const [gap] = await f.gaps();
    expect(gap!.payload).toMatchObject({ reason: 'missed_while_unavailable', state: 'pending', policyId: f.policyId });
    expect((gap!.payload as { missedCount: number }).missedCount).toBeGreaterThan(30);
  });

  it('turns an exhausted shared budget into a gap, never a failed check', async () => {
    const f = await scheduled();
    for (let i = 0; i < 4; i++) {
      const id = crypto.randomUUID();
      await system(() => db.execute(sql`INSERT INTO topology_diagnostic_runs
        (id,org_id,site_id,recipe_id,recipe_version,requester_id,subject_node_id,origin_node_id,origin_snapshot,plan,plan_digest,idempotency_key,body_hash,attempt_id,queue_deadline,deadline)
        VALUES (${id}::uuid,${f.orgId}::uuid,${f.siteId}::uuid,'gateway_basic',1,${f.env.user.id}::uuid,${f.nodeId}::uuid,${f.nodeId}::uuid,'{}'::jsonb,'{}'::jsonb,${'c'.repeat(64)},${id},${'d'.repeat(64)},gen_random_uuid(),now()+interval '30 seconds',now()+interval '120 seconds')`));
    }
    await f.makeDue();
    expect(await dispatchDueTopologyPolicies({ repository: f.repository })).toMatchObject({ scheduled: 0, gaps: 1 });
    expect(await f.runs()).toHaveLength(0);
    expect((await f.gaps())[0]!.payload).toMatchObject({ reason: 'budget_exhausted' });
    expect((await f.policy()).alertState.entries[0]!.lastClaimedScheduledFor).not.toBeNull();
  });

  it('disarms on a revoked arming actor and schedules nothing', async () => {
    const f = await scheduled();
    await f.makeDue();
    await system(() => db.update(users).set({ authEpoch: sql`${users.authEpoch}+1` }).where(eq(users.id, f.env.user.id)));
    expect(await dispatchDueTopologyPolicies({ repository: f.repository })).toMatchObject({ scheduled: 0, disarmed: 1 });
    const policy = await f.policy();
    expect(policy.enabled).toBe(false);
    expect(policy.blockedReason).toBe('authority_permission_changed');
    expect(await f.runs()).toHaveLength(0);
  });

  it('fences a dispatched scheduled run at delivery once its policy is disarmed', async () => {
    const f = await scheduled();
    await f.makeDue();
    await dispatchDueTopologyPolicies({ repository: f.repository });
    const [run] = await f.runs();
    await dispatchTopologyDiagnosticRun(f.ctx.scope, run!.id, { deliver: async () => true });
    const bound = (await f.runs())[0]!;
    expect(bound.commandId).not.toBeNull();
    const [command] = await system(() => db.execute<{ id: string; type: string; payload: unknown }>(sql`SELECT id,type,payload FROM device_commands WHERE id = ${bound.commandId}::uuid`));
    const revalidate = () => system(() => validateTopologyCommandAuthority({ id: command!.id, type: command!.type, deviceId: f.deviceId, payload: command!.payload }, command!.payload));
    expect(await revalidate()).toMatchObject({ allow: true });
    const policy = await f.policy();
    await f.inOrg(() => disarmTopologyMonitoringPolicy(f.ctx, f.policyId, policy.revision.toString()));
    expect(await revalidate()).toEqual({ allow: false, reason: 'scope_changed' });
  });
});
