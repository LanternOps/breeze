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
const trace = vi.hoisted(() => ({ depth: 0, systemDepth: 0, violations: [] as string[] }));

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
      return actual.getPermissionAuthorityVersion(userId);
    },
  };
});

import { sql } from 'drizzle-orm';
import { closeDb, db } from '../../db';
import { dispatchTopologyDiagnosticRun } from '../../services/topology/diagnosticDispatch';
import { dispatchDueTopologyPolicies } from '../../services/topology/monitoringScheduler';
import { seedScheduledMonitoringFixture, system } from '../helpers/topologyMonitoring';

afterAll(() => closeDb());
beforeEach(() => { trace.violations.length = 0; trace.depth = 0; trace.systemDepth = 0; });

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
});
