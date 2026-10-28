import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasChain, render, tableOf, whereParams, whereText, type RecordedOp } from '../testUtils/recordingDb';

/**
 * pumpSweeps (#6263 W05-2): expire, finalize, complete, admit — in one
 * single-flight system transaction, with audits and dispatch jobs after it.
 */

const h = vi.hoisted(() => ({
  inContext: false,
  events: [] as string[],
  respond: (_op: unknown): unknown => [],
  cancel: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  orphans: vi.fn(),
  recording: null as null | ReturnType<typeof import('../testUtils/recordingDb').createRecordingDb>,
}));

vi.mock('../db', async () => {
  const { createRecordingDb } = await import('../testUtils/recordingDb');
  h.recording = createRecordingDb((op) => h.respond(op));
  return {
    db: h.recording.db,
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      h.inContext = true;
      h.events.push('context:open');
      try {
        return await fn();
      } finally {
        h.inContext = false;
        h.events.push('context:close');
      }
    },
  };
});
vi.mock('../services/commandCancelPropagation', () => ({ cancelDeviceCommands: (...a: unknown[]) => h.cancel(...a) }));
// #10057: the non-sweep finalize has its own suite (securityScanOrphanFinalize.test.ts).
vi.mock('./securityScanOrphanFinalize', () => ({
  finalizeOrphanedDeviceScans: (...a: unknown[]) => {
    h.events.push(h.inContext ? 'orphans:in-context' : 'orphans');
    return h.orphans(...a);
  },
}));
vi.mock('../services/auditService', () => ({
  createAuditLogAsync: (...a: unknown[]) => {
    h.events.push(h.inContext ? 'audit:in-context' : 'audit');
    return h.audit(...a);
  },
}));

import { pumpSweeps } from './securityScanSweepPump';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const SWEEP_A = '5a000000-0000-4000-8000-00000000000a';
const SWEEP_B = '5b000000-0000-4000-8000-00000000000b';
const ORG_A = 'a0000000-0000-4000-8000-000000000001';
const ORG_B = 'b0000000-0000-4000-8000-000000000001';
const PARTNER = 'p0000000-0000-4000-8000-000000000001';
const GROUP = '6a000000-0000-4000-8000-0000000000aa';

type World = {
  locked?: boolean;
  expired?: Array<Record<string, unknown>>;
  expiredQueued?: Array<{ id: string }>;
  pending?: Array<{ scanId: string; commandId: string }>;
  undeliveredFinal?: Array<{ id: string }>;
  ceilingFinal?: Array<{ id: string }>;
  completed?: Array<Record<string, unknown>>;
  progress?: Array<Record<string, unknown>>;
  active?: Array<Record<string, unknown>>;
  orgRunning?: Array<{ orgId: string; count: number }>;
  partnerRunning?: Array<{ partnerId: string; count: number }>;
  candidates?: Array<Array<{ id: string; deviceId: string }>>;
};

function respondWith(w: World) {
  const candidates = [...(w.candidates ?? [])];
  h.respond = (op) => {
    const o = op as RecordedOp;
    const table = tableOf(o);
    if (o.kind === 'execute') {
      const text = whereText(o);
      if (text.includes('pg_try_advisory_xact_lock')) return [{ locked: w.locked ?? true }];
      if (text.includes('executed_at is null')) return w.undeliveredFinal ?? [];
      if (text.includes('started_at <')) return w.ceilingFinal ?? [];
      return [];
    }
    if (o.kind === 'update' && table === 'security_scan_sweeps') {
      const set = o.chain.find(([m]) => m === 'set')![1][0] as Record<string, unknown>;
      return set.state === 'expired' ? (w.expired ?? []) : (w.completed ?? []);
    }
    if (o.kind === 'update' && table === 'security_scans' && hasChain(o, 'returning')) return w.expiredQueued ?? [];
    if (o.kind === 'select' && table === 'security_scans' && Object.keys((o.args[0] ?? {}) as object).includes('commandId')) {
      return w.pending ?? [];
    }
    if (o.kind === 'select' && table === 'security_scans' && hasChain(o, 'groupBy') && Object.keys((o.args[0] ?? {}) as object).includes('sweepId')) {
      return w.progress ?? [];
    }
    if (o.kind === 'select' && table === 'security_scan_sweeps' && hasChain(o, 'for')) {
      return (w.expired ?? []).map((r) => ({ id: r.id }));
    }
    if (o.kind === 'select' && table === 'security_scan_sweeps') return w.active ?? [];
    if (o.kind === 'select' && table === 'security_scans' && hasChain(o, 'groupBy') && Object.keys((o.args[0] ?? {}) as object).includes('orgId')) {
      return w.orgRunning ?? [];
    }
    if (o.kind === 'select' && table === 'security_scans' && hasChain(o, 'groupBy') && Object.keys((o.args[0] ?? {}) as object).includes('partnerId')) {
      return w.partnerRunning ?? [];
    }
    if (o.kind === 'select' && table === 'security_scans' && hasChain(o, 'limit')) return candidates.shift() ?? [];
    return [];
  };
}

const ops = () => h.recording!.ops;
const candidateQueries = () => ops().filter((o) => o.kind === 'select' && tableOf(o) === 'security_scans' && hasChain(o, 'limit'));

beforeEach(() => {
  h.inContext = false;
  h.events.length = 0;
  h.recording!.ops.length = 0;
  h.cancel.mockReset().mockResolvedValue([]);
  h.audit.mockReset();
  h.orphans.mockReset().mockResolvedValue({ expired: 0, failed: 0 });
  h.enqueue.mockReset().mockImplementation(async () => {
    h.events.push(h.inContext ? 'enqueue:in-context' : 'enqueue');
  });
  respondWith({});
});

describe('pumpSweeps', () => {
  it('single-flight: second concurrent pump returns skipped', async () => {
    respondWith({ locked: false });
    expect(await pumpSweeps(NOW, { enqueue: h.enqueue })).toEqual({
      skipped: true, expired: 0, finalized: 0, completed: 0, admitted: 0, deviceScansFinalized: 0,
    });
    expect(h.orphans).not.toHaveBeenCalled();
    expect(ops()).toHaveLength(1);
    expect(whereText(ops()[0]!)).toContain(`pg_try_advisory_xact_lock(hashtext('security-sweep-pump'))`);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('expire: queued → expired, pending-command running → cancelled command + expired, one audit per sweep', async () => {
    respondWith({
      expired: [{ id: SWEEP_A, orgId: ORG_A, groupId: GROUP }],
      expiredQueued: [{ id: 'q1' }, { id: 'q2' }],
      pending: [{ scanId: 'r1', commandId: 'cmd-1' }],
    });
    h.cancel.mockResolvedValue([{ id: 'cmd-1', type: 'security_scan', payload: null }]);
    const result = await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(result.expired).toBe(1);

    // Lock the expiring rows in id order first (no deadlock with a group cancel), then flip them.
    const lock = ops().find((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps' && hasChain(o, 'for'))!;
    expect(lock.chain.find(([m]) => m === 'for')![1][0]).toBe('update');
    expect(render(lock.chain.find(([m]) => m === 'orderBy')![1][0] as never).sql).toContain('"security_scan_sweeps"."id" asc');
    expect(whereText(lock)).toContain('"security_scan_sweeps"."expires_at" <= $');
    expect(whereParams(lock)).toEqual(expect.arrayContaining(['active']));
    const expire = ops().find((o) => o.kind === 'update' && tableOf(o) === 'security_scan_sweeps')!;
    expect(expire.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ state: 'expired' });
    expect(whereParams(expire)).toEqual(expect.arrayContaining([SWEEP_A, 'active']));

    const queued = ops().find((o) => o.kind === 'update' && tableOf(o) === 'security_scans' && hasChain(o, 'returning'))!;
    expect(queued.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ status: 'expired' });
    expect(whereParams(queued)).toEqual(expect.arrayContaining([SWEEP_A, ORG_A, 'queued']));

    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel.mock.calls[0]![0].result).toMatchObject({ reason: 'security_sweep_expired' });
    expect(render(h.cancel.mock.calls[0]![0].where).params).toEqual(expect.arrayContaining(['cmd-1', 'pending']));
    const undelivered = ops().filter((o) => o.kind === 'update' && tableOf(o) === 'security_scans' && !hasChain(o, 'returning'));
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]!.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ status: 'expired' });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      orgId: ORG_A,
      action: 'security.scan_sweep.expire',
      resourceType: 'security_scan_sweep',
      resourceId: SWEEP_A,
      actorType: 'system',
      initiatedBy: 'schedule',
      details: { groupId: GROUP, expiredQueued: 2, expiredUndelivered: 1 },
    });
    expect(h.events).toContain('audit');
    expect(h.events).not.toContain('audit:in-context');
  });

  it('finalize via command_id: terminal undelivered → expired', async () => {
    respondWith({ undeliveredFinal: [{ id: 's1' }, { id: 's2' }] });
    const result = await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(result.finalized).toBe(2);
    const stmt = ops().find((o) => o.kind === 'execute' && whereText(o).includes('executed_at is null'))!;
    const text = whereText(stmt);
    expect(text).toContain('c.id = s.command_id');
    expect(text).toContain(`c.status in ('expired', 'cancelled', 'failed')`);
    expect(text).toContain('w.org_id = s.org_id');
    expect(text).toContain(`set status = 'expired'`);
  });

  it('running with no result beyond 720+65 min → failed; a 31-minute-old running scan is left alone', async () => {
    respondWith({ ceilingFinal: [{ id: 's3' }] });
    const result = await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(result.finalized).toBe(1);
    const stmt = ops().find((o) => o.kind === 'execute' && whereText(o).includes('started_at <'))!;
    expect(whereText(stmt)).toContain(`set status = 'failed'`);
    // params: [completed_at = now, started_at cutoff]
    const [completedAt, cutoff] = whereParams(stmt) as string[];
    expect(completedAt).toBe(NOW.toISOString());
    expect(new Date(cutoff!).getTime()).toBe(NOW.getTime() - (720 + 65) * 60_000);
    // The server's 30-minute command timeout is never consulted: a timed-out
    // command was delivered (executed_at set) and is not "undelivered".
    const undelivered = ops().find((o) => o.kind === 'execute' && whereText(o).includes('executed_at is null'))!;
    expect(whereText(undelivered)).not.toContain('timeout');
  });

  it('complete: no queued/running → completed + audit', async () => {
    respondWith({
      completed: [{ id: SWEEP_B, orgId: ORG_B, groupId: GROUP }],
      progress: [{ sweepId: SWEEP_B, completed: 3, failed: 1 }],
    });
    const result = await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(result.completed).toBe(1);
    const complete = ops().filter((o) => o.kind === 'update' && tableOf(o) === 'security_scan_sweeps').at(-1)!;
    expect(complete.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ state: 'completed' });
    expect(whereText(complete)).toContain('not exists');
    expect(whereText(complete)).toContain(`s.status in ('queued', 'running')`);
    expect(h.audit.mock.calls.map((c) => c[0].action)).toEqual(['security.scan_sweep.complete']);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      orgId: ORG_B, resourceId: SWEEP_B, actorType: 'system', details: { groupId: GROUP, progress: { completed: 3, failed: 1 } },
    });
  });

  it('admit: only online, unparked, no running scan, no non-sweep queued scan; oldest sweep first; jobs after commit', async () => {
    respondWith({
      active: [
        { id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER },
        { id: SWEEP_B, orgId: ORG_B, partnerId: PARTNER },
      ],
      candidates: [[{ id: 'scan-1', deviceId: 'dev-1' }], [{ id: 'scan-2', deviceId: 'dev-2' }]],
    });
    const result = await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(result.admitted).toBe(2);
    const activeQuery = ops().find((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps' && !hasChain(o, 'for'))!;
    expect(render(activeQuery.chain.find(([m]) => m === 'orderBy')![1][0] as never).sql).toContain('"security_scan_sweeps"."created_at" asc');
    const [first] = candidateQueries();
    const text = whereText(first!);
    expect(text).toContain('"devices"."status" = $');
    expect(whereParams(first!)).toEqual(expect.arrayContaining([SWEEP_A, ORG_A, 'queued', 'online']));
    expect(text).toContain(`parked_org.type = 'unassigned_pool'`);
    expect(text).toContain(`r.status = 'running'`);
    expect(text).toContain(`r.status = 'queued' and r.sweep_id is null`);
    expect(text).toContain(`c.status in ('pending', 'sent')`);
    expect(render(first!.chain.find(([m]) => m === 'orderBy')![1][0] as never).sql).toContain('"security_scans"."id"');
    expect(h.enqueue).toHaveBeenCalledWith([
      { type: 'dispatch-scan', scanId: 'scan-1', origin: 'sweep', sweepId: SWEEP_A },
      { type: 'dispatch-scan', scanId: 'scan-2', origin: 'sweep', sweepId: SWEEP_B },
    ]);
    expect(h.events.indexOf('enqueue')).toBeGreaterThan(h.events.indexOf('context:close'));
    // Exactly once, and never from inside the transaction (a job could run
    // before the rows it names are visible, and Redis would pin the connection).
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain('enqueue:in-context');
  });

  it('admit: org cap 40, partner cap 200, batch 100', async () => {
    const limitOf = (op: RecordedOp) => op.chain.find(([m]) => m === 'limit')![1][0];
    respondWith({ active: [{ id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER }] });
    await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(limitOf(candidateQueries()[0]!)).toBe(40);

    h.recording!.ops.length = 0;
    respondWith({ active: [{ id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER }], orgRunning: [{ orgId: ORG_A, count: 38 }] });
    await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(limitOf(candidateQueries()[0]!)).toBe(2);

    h.recording!.ops.length = 0;
    respondWith({ active: [{ id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER }], partnerRunning: [{ partnerId: PARTNER, count: 199 }] });
    await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(limitOf(candidateQueries()[0]!)).toBe(1);

    h.recording!.ops.length = 0;
    respondWith({ active: [{ id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER }], orgRunning: [{ orgId: ORG_A, count: 40 }] });
    await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(candidateQueries()).toHaveLength(0);

    process.env.SECURITY_SCAN_ORG_CONCURRENCY_CAP = '500';
    process.env.SECURITY_SWEEP_PARTNER_RUNNING_CAP = '500';
    try {
      h.recording!.ops.length = 0;
      respondWith({ active: [{ id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER }] });
      await pumpSweeps(NOW, { enqueue: h.enqueue });
      expect(limitOf(candidateQueries()[0]!)).toBe(100);
    } finally {
      delete process.env.SECURITY_SCAN_ORG_CONCURRENCY_CAP;
      delete process.env.SECURITY_SWEEP_PARTNER_RUNNING_CAP;
    }
  });

  it('admissions count against the org and partner budget within one tick', async () => {
    respondWith({
      active: [
        { id: SWEEP_A, orgId: ORG_A, partnerId: PARTNER },
        { id: SWEEP_B, orgId: ORG_A, partnerId: PARTNER },
      ],
      orgRunning: [{ orgId: ORG_A, count: 35 }],
      candidates: [[1, 2, 3].map((n) => ({ id: `scan-${n}`, deviceId: `dev-${n}` }))],
    });
    await pumpSweeps(NOW, { enqueue: h.enqueue });
    const limits = candidateQueries().map((op) => op.chain.find(([m]) => m === 'limit')![1][0]);
    expect(limits).toEqual([5, 2]);
    // A device admitted for one sweep is not admitted again for another in the same tick.
    expect(whereParams(candidateQueries()[1]!)).toEqual(expect.arrayContaining(['dev-1', 'dev-2', 'dev-3']));
  });

  it('#10057 finalizes orphaned scheduled/manual scans in the same system transaction and reports them apart', async () => {
    h.orphans.mockResolvedValue({ expired: 2, failed: 3 });
    const result = await pumpSweeps(NOW, { enqueue: h.enqueue });
    expect(h.orphans).toHaveBeenCalledTimes(1);
    expect(h.orphans).toHaveBeenCalledWith(NOW);
    expect(h.events).toEqual(['context:open', 'orphans:in-context', 'context:close']);
    expect(result.deviceScansFinalized).toBe(5);
    // Sweep-only counter, unchanged by non-sweep rows.
    expect(result.finalized).toBe(0);
  });
});
