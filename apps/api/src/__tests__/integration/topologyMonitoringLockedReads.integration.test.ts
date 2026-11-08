import './setup';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T4 (#6671 shape) against real Postgres/Redis: the policy scheduler claims a
 * slot inside a transaction holding the policy row lock (and, while creating
 * the run, the per-org diagnostic advisory lock). Nothing inside that window
 * may reach for a SECOND pooled connection (`runOutsideDbContext` escapes —
 * the partner-axis flag read, partner-trust reads) or wait on Redis (the
 * permission authority version) — postgres-js has no acquire timeout, so a
 * pool full of same-org work queued on the lock wedges the holder.
 */
const trace = vi.hoisted(() => ({ depth: 0, systemDepth: 0, watchContext: false, watchCommandLocks: false, versionReads: 0, violations: [] as string[] }));

vi.mock('../../db', async () => {
  const actual = await vi.importActual<typeof import('../../db')>('../../db');
  return {
    ...actual,
    withDbTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      trace.depth++;
      try { return await actual.withDbTransaction(fn); } finally { trace.depth--; }
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>, label?: string): Promise<T> => {
      trace.systemDepth++;
      try { return await actual.withSystemDbAccessContext(fn, label); } finally { trace.systemDepth--; }
    },
    runOutsideDbContext: <T>(fn: () => T): T => {
      if (trace.depth > 0 || trace.systemDepth > 0) trace.violations.push(`runOutsideDbContext: ${new Error().stack?.split('\n').slice(2, 5).join(' | ')}`);
      return actual.runOutsideDbContext(fn);
    },
  };
});
vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissions')>('../../services/permissions');
  return {
    ...actual,
    getPermissionAuthorityVersion: async (userId: string) => {
      if (trace.depth > 0) trace.violations.push('getPermissionAuthorityVersion (Redis) under the claim transaction');
      const { db: liveDb, getCurrentDbAccessContext } = await vi.importActual<typeof import('../../db')>('../../db');
      if (trace.watchContext && getCurrentDbAccessContext()) trace.violations.push('getPermissionAuthorityVersion (Redis) inside the sink transaction');
      if (trace.watchCommandLocks && getCurrentDbAccessContext()) {
        // #7268: ask Postgres, on the claim's own connection, whether this
        // transaction already holds a row-level lock mode on device_commands
        // (FOR UPDATE → RowShareLock, UPDATE → RowExclusiveLock).
        trace.versionReads++;
        const { sql: rawSql } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
        const [held] = await liveDb.execute<{ n: number }>(rawSql`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid() AND c.relname = 'device_commands' AND l.mode IN ('RowShareLock', 'RowExclusiveLock')`);
        if (held!.n > 0) trace.violations.push('getPermissionAuthorityVersion (Redis) while holding device_commands row locks');
      }
      return actual.getPermissionAuthorityVersion(userId);
    },
  };
});

import { sql } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { claimPendingCommandForDelivery, claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { deviceAgentId } from './db-utils';
import { dispatchTopologyDiagnosticRun } from '../../services/topology/diagnosticDispatch';
import { dispatchDueTopologyPolicies } from '../../services/topology/monitoringScheduler';
import { ingestTopologyInterfacePollResult } from '../../services/topology/snmpInterfaceMetrics';
import { armTopologyTelemetry, dispatchDueTopologyTelemetryArms, ensureTopologyTelemetryArmAuthority } from '../../services/topology/telemetryArms';
import metricFixture from '../../../../../packages/shared/src/testing/topology-interface-metrics-v1.json';
import { seedScheduledMonitoringFixture, seedTopologyMonitoringFixture, system } from '../helpers/topologyMonitoring';

afterAll(() => closeDb());
beforeEach(() => {
  trace.violations.length = 0; trace.depth = 0; trace.systemDepth = 0; trace.watchContext = false; trace.watchCommandLocks = false; trace.versionReads = 0;
});

describe('policy scheduler claim window (T4)', () => {
  it('schedules a run without a nested pooled connection or a Redis read under the policy lock', async () => {
    const f = await seedScheduledMonitoringFixture();
    await f.makeDue();
    trace.violations.length = 0;
    expect(await dispatchDueTopologyPolicies({ repository: f.repository })).toMatchObject({ scheduled: 1, disarmed: 0 });
    const [run] = await f.runs();
    expect(run!.requesterAuthority).toMatchObject({ userId: f.env.user.id });
    expect(trace.violations).toEqual([]);
  });

  it('enqueues a scheduled run under enforced partner trust without a nested pooled connection (trust read on the held reader)', async () => {
    const f = await seedScheduledMonitoringFixture();
    await f.makeDue();
    expect(await dispatchDueTopologyPolicies({ repository: f.repository })).toMatchObject({ scheduled: 1 });
    const [run] = await f.runs();
    const saved = { hosted: process.env.IS_HOSTED, mode: process.env.PARTNER_TRUST_MODE };
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    try {
      trace.violations.length = 0;
      await dispatchTopologyDiagnosticRun(f.ctx.scope, run!.id, { deliver: async () => true });
      expect(trace.violations).toEqual([]);
      expect((await f.runs())[0]!.commandId).not.toBeNull();

      // A restricted partner is still fenced — through the same held reader.
      const f2 = await seedScheduledMonitoringFixture();
      await f2.makeDue();
      delete process.env.IS_HOSTED;
      expect(await dispatchDueTopologyPolicies({ repository: f2.repository })).toMatchObject({ scheduled: 1 });
      process.env.IS_HOSTED = 'true';
      const [run2] = await f2.runs();
      await system(() => db.execute(sql`UPDATE partners SET trust_state = 'restricted' WHERE id = (SELECT partner_id FROM organizations WHERE id = ${f2.orgId}::uuid)`));
      trace.violations.length = 0;
      await dispatchTopologyDiagnosticRun(f2.ctx.scope, run2!.id, { deliver: async () => true });
      expect(trace.violations).toEqual([]);
      expect((await f2.runs())[0]).toMatchObject({ state: 'cancelled', failureReason: 'authority_trust_denied', commandId: null });
    } finally {
      if (saved.hosted === undefined) delete process.env.IS_HOSTED; else process.env.IS_HOSTED = saved.hosted;
      if (saved.mode === undefined) delete process.env.PARTNER_TRUST_MODE; else process.env.PARTNER_TRUST_MODE = saved.mode;
    }
  });

  it('accepts a real arm poll result, checking live permissions without a Redis read inside the sink transaction (C4)', async () => {
    ensureTopologyTelemetryArmAuthority();
    const f = await seedTopologyMonitoringFixture();
    await f.inOrg(() => armTopologyTelemetry(f.ctx, {
      targetNodeId: f.switchNodeId, collectorDeviceId: f.deviceId, credentialProfileId: f.profileId, interfaceIds: [f.ifaceA], intervalSeconds: 60, ttlDays: 30,
    }));
    expect(await dispatchDueTopologyTelemetryArms({ now: new Date(Date.now() + 1000) })).toMatchObject({ dispatched: 1 });
    // An enrolled collector (the sink refuses a device without agent credentials).
    await system(() => db.execute(sql`UPDATE devices SET agent_token_hash = ${'f'.repeat(64)} WHERE id = ${f.deviceId}::uuid`));
    const [command] = await system(() => db.execute<{ id: string; payload: { sequence: string; producerEpoch: string; configurationRevision: string } }>(
      sql`UPDATE device_commands SET status = 'sent' WHERE device_id = ${f.deviceId}::uuid AND type = 'topology_interface_poll' RETURNING id, payload`));
    const at = Date.now() - 5_000;
    const reply = {
      schemaVersion: 1, family: 'if_metrics', producerEpoch: command!.payload.producerEpoch, sequence: command!.payload.sequence, commandId: command!.id,
      configurationRevision: command!.payload.configurationRevision, startedAt: new Date(at - 1000).toISOString(), finishedAt: new Date(at + 1000).toISOString(),
      captureAgeAtSendMs: null, expectedIntervalSeconds: 60, outcome: 'complete', reasonCode: null,
      samples: [{ ...structuredClone(metricFixture.valid.samples[0]!), interfaceId: f.ifaceA, interfaceEpoch: 'gen:1', sampledAt: new Date(at).toISOString() }],
    };
    trace.violations.length = 0;
    trace.watchContext = true;
    const receipt = await ingestTopologyInterfacePollResult({ commandType: 'topology_interface_poll', commandId: command!.id, deviceId: f.deviceId, status: 'completed', stdout: JSON.stringify(reply) });
    trace.watchContext = false;
    expect(receipt).toMatchObject({ accepted: true, inserted: 1 });
    expect(trace.violations).toEqual([]);
  });
});

/**
 * #7268: the poll's delivery revalidation needs the arm actor's CURRENT
 * permission version (Redis). Both claim legs must read it before they lock
 * `device_commands` rows, and still deliver an intact poll with it.
 */
describe('command claim window (#7268)', () => {
  for (const transport of ['http', 'websocket'] as const) {
    it(`delivers an arm poll over ${transport} without a Redis read while holding device_commands row locks`, async () => {
      const f = await seedTopologyMonitoringFixture();
      await f.inOrg(() => armTopologyTelemetry(f.ctx, {
        targetNodeId: f.switchNodeId, collectorDeviceId: f.deviceId, credentialProfileId: f.profileId, interfaceIds: [f.ifaceA], intervalSeconds: 60, ttlDays: 30,
      }));
      expect(await dispatchDueTopologyTelemetryArms({ now: new Date(Date.now() + 1000) })).toMatchObject({ dispatched: 1 });
      const [command] = await system(() => db.execute<{ id: string }>(
        sql`SELECT id FROM device_commands WHERE device_id = ${f.deviceId}::uuid AND type = 'topology_interface_poll' AND status = 'pending'`));
      expect(command).toBeTruthy();
      const agentId = await deviceAgentId(f.deviceId);

      trace.violations.length = 0;
      trace.watchCommandLocks = true;
      const delivered = transport === 'http'
        ? (await system(() => claimPendingCommandsForDevice({ deviceId: f.deviceId, agentId, installIncarnation: 1 }, 10, 'agent'))).map((row) => row.id)
        : await claimPendingCommandForDelivery(command!.id).then((outcome) => (outcome.status === 'claimed' ? [outcome.id] : []));
      trace.watchCommandLocks = false;

      expect(delivered).toContain(command!.id);
      // The probe ran: the version WAS read inside the claim's DB context, just not under the row locks.
      expect(trace.versionReads).toBeGreaterThan(0);
      expect(trace.violations).toEqual([]);
    });
  }
});
