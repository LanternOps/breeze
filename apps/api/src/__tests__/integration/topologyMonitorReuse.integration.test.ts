import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { networkMonitors, topologyDiagnosticRuns, topologyMonitorBindings, topologyMonitoringPolicies } from '../../db/schema';
import { bindTopologyMonitor, unbindTopologyMonitor } from '../../services/topology/monitorBindings';
import { dispatchDueTopologyPolicies } from '../../services/topology/monitoringScheduler';
import { seedScheduledMonitoringFixture, system } from '../helpers/topologyMonitoring';

/**
 * M3-D5 monitor reuse against real Postgres: one validator binds only an
 * equivalent same-site monitor; a bound context is served by the monitor
 * (no probe run); monitor drift drops the binding and probing resumes; the
 * external monitor is never deleted.
 */
afterAll(() => closeDb());

async function withMonitor(overrides: { siteId?: string | null; port?: number } = {}) {
  const f = await seedScheduledMonitoringFixture();
  const monitorId = crypto.randomUUID();
  await system(() => db.insert(networkMonitors).values({
    id: monitorId, orgId: f.orgId, siteId: overrides.siteId === undefined ? f.siteId : overrides.siteId, name: 'web tcp', monitorType: 'tcp_port',
    target: '198.51.100.7', config: { port: overrides.port ?? 443 },
  }));
  const runs = () => system(() => db.select().from(topologyDiagnosticRuns).where(and(eq(topologyDiagnosticRuns.orgId, f.orgId), eq(topologyDiagnosticRuns.policyId, f.policyId))));
  const due = () => system(() => db.update(topologyMonitoringPolicies).set({ nextScheduledAt: new Date(0) }).where(eq(topologyMonitoringPolicies.id, f.policyId)));
  return { ...f, monitorId, runs, due };
}

describe('topology monitor reuse (M3-D5)', () => {
  it('serves a bound context from the equivalent monitor and resumes probing on drift', async () => {
    const f = await withMonitor();
    const bound = await f.inOrg(() => bindTopologyMonitor(f.ctx, f.policyId, { monitorId: f.monitorId, contextKey: 'default', family: 'ipv4' }));
    expect(bound.metricRole).toBe('port_reachability');
    await f.due();
    const base = Math.floor(Date.now() / 300_000) * 300_000 + 60_000;
    expect(await dispatchDueTopologyPolicies({ now: new Date(base), repository: f.repository })).toMatchObject({ scheduled: 0, gaps: 0 });
    expect(await f.runs()).toHaveLength(0);
    expect((await f.policy()).alertState.entries[0]!.lastClaimedScheduledFor).not.toBeNull();

    // Monitor drift: the binding is dropped and the policy probes for itself again.
    await system(() => db.update(networkMonitors).set({ config: { port: 8443 } }).where(eq(networkMonitors.id, f.monitorId)));
    await f.due();
    expect(await dispatchDueTopologyPolicies({ now: new Date(base + 300_000), repository: f.repository })).toMatchObject({ scheduled: 1 });
    expect(await system(() => db.select().from(topologyMonitorBindings).where(eq(topologyMonitorBindings.policyId, f.policyId)))).toHaveLength(0);
    expect(await system(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, f.monitorId)))).toHaveLength(1);
  });

  it('refuses a non-equivalent monitor and never deletes the monitor on unbind', async () => {
    const mismatch = await withMonitor({ port: 22 });
    await expect(mismatch.inOrg(() => bindTopologyMonitor(mismatch.ctx, mismatch.policyId, { monitorId: mismatch.monitorId, contextKey: 'default', family: 'ipv4' })))
      .rejects.toMatchObject({ code: 'destination_mismatch' });
    await expect(mismatch.inOrg(() => bindTopologyMonitor(mismatch.ctx, mismatch.policyId, { monitorId: mismatch.monitorId, contextKey: 'vpn', family: 'ipv4' })))
      .rejects.toMatchObject({ code: 'context_not_armed' });

    const f = await withMonitor();
    const { bindingId } = await f.inOrg(() => bindTopologyMonitor(f.ctx, f.policyId, { monitorId: f.monitorId, contextKey: 'default', family: 'ipv4' }));
    expect(await f.inOrg(() => unbindTopologyMonitor(f.ctx, bindingId))).toEqual({ removed: true });
    expect(await system(() => db.select().from(networkMonitors).where(eq(networkMonitors.id, f.monitorId)))).toHaveLength(1);
  });
});
