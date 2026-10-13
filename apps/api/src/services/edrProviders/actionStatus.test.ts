import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    held: null as null | 'system',
    selects: [] as unknown[][],
    updates: [] as { set: Record<string, unknown>; where: unknown }[],
    casMiss: new Set<string>(),
  };
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return c;
  };
  return {
    state,
    db: {
      select: vi.fn(() => chain(state.selects.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn((set: Record<string, unknown>) => ({
          where: vi.fn((where: unknown) => ({
            returning: vi.fn(async () => {
              state.updates.push({ set, where });
              const id = JSON.stringify(where).match(/"act-[\w-]+"/)?.[0]?.replace(/"/g, '');
              return id && state.casMiss.has(id) ? [] : [{ id }];
            }),
          })),
        })),
      })),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      state.held = 'system';
      try { return await fn(); } finally { state.held = null; }
    }),
    runOutsideDbContext: vi.fn(<T>(fn: () => T) => fn()),
    getActionStatus: vi.fn(),
    reconcileAction: vi.fn(),
    performAction: vi.fn(),
    createAuditLogAsync: vi.fn(async () => undefined),
  };
});

vi.mock('../../db', () => ({ db: h.db, withSystemDbAccessContext: h.withSystemDbAccessContext, runOutsideDbContext: h.runOutsideDbContext }));
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  inArray: (c: unknown, v: unknown) => ({ in: [c, v] }),
  isNull: (c: unknown) => ({ isNull: c }),
  asc: (c: unknown) => c,
}));
vi.mock('../../db/schema', () => ({
  edrActions: { id: 'id', status: 'status', connectionId: 'connection_id', detachedAt: 'detached_at', requestedAt: 'requested_at' },
  edrConnections: { id: 'id' },
  edrTenants: { id: 'id' },
}));
vi.mock('../auditService', () => ({ createAuditLogAsync: h.createAuditLogAsync }));
vi.mock('./credentials', () => ({ decryptEdrSecret: () => ({ apiKey: 'k' }) }));
vi.mock('./context', () => ({ buildEdrAdapterContext: () => ({ ctx: true }) }));
vi.mock('./registry', () => ({
  getEdrProvider: () => ({
    key: 'bitdefender',
    capabilities: { actions: ['isolate', 'unisolate', 'scan'] },
    getActionStatus: h.getActionStatus,
    reconcileAction: h.reconcileAction,
    performAction: h.performAction,
  }),
}));

import {
  EDR_ACTION_SUBMITTED_TIMEOUT_MS,
  EDR_ACTION_UNKNOWN_GIVEUP_MS,
  EDR_ACTION_UNKNOWN_GRACE_MS,
  pollEdrActionStatus,
  requestFromRow,
} from './actionStatus';

const NOW = new Date('2026-10-13T12:00:00Z');
const ago = (msAgo: number) => new Date(NOW.getTime() - msAgo);
const connection = { id: 'c1', provider: 'bitdefender', isActive: true, credentialsEncrypted: 'enc', baseUrl: null, region: null };
const tenant = { id: 't1', vendorTenantId: 'company-1', apiHost: null };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', orgId: 'org-1', tenantId: 't1', action: 'isolate', status: 'queued', vendorActionId: null,
  payload: { target: { kind: 'endpoint', vendorEndpointId: 'ep-v' } }, requestedAt: ago(EDR_ACTION_UNKNOWN_GRACE_MS + 1000),
  submittedAt: null, requestedBy: 'u1', ...over,
});
function arrange(rows: unknown[]) {
  h.state.selects = [[connection], rows, rows.length ? [tenant] : []];
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.state, { held: null, selects: [], updates: [], casMiss: new Set() });
});
// The reconciler NEVER re-sends: checked after every single case.
afterEach(() => {
  expect(h.performAction).not.toHaveBeenCalled();
});

describe('pollEdrActionStatus — settle open actions, never re-send', () => {
  it('a queued row inside the grace window is left alone (dispatch may still be in flight)', async () => {
    arrange([row({ requestedAt: ago(EDR_ACTION_UNKNOWN_GRACE_MS - 1000) })]);
    expect(await pollEdrActionStatus('c1', NOW)).toEqual({ checked: 1, settled: 0 });
    expect(h.reconcileAction).not.toHaveBeenCalled();
    expect(h.state.updates).toHaveLength(0);
  });

  it.each([
    // applied settles as soon as the grace has passed…
    ['applied', 'succeeded', 'reconciled_applied', EDR_ACTION_UNKNOWN_GRACE_MS + 1000],
    // …but not_applied only after the give-up window: a pending vendor task or an
    // offline endpoint reads "not isolated yet" (review fix).
    ['not_applied', 'failed', 'not_sent_or_rejected', EDR_ACTION_UNKNOWN_GIVEUP_MS + 1000],
  ] as const)('queued + reconcile %s → %s/%s via CAS on the observed status', async (verdict, status, error, age) => {
    arrange([row({ requestedAt: ago(age) })]);
    h.reconcileAction.mockResolvedValue(verdict);
    expect(await pollEdrActionStatus('c1', NOW)).toEqual({ checked: 1, settled: 1 });
    expect(h.reconcileAction.mock.calls[0]!.slice(1)).toEqual([
      { vendorTenantId: 'company-1', apiHost: null },
      { action: 'isolate', target: { kind: 'endpoint', vendorEndpointId: 'ep-v' } },
    ]);
    expect(h.state.updates[0]!.set).toMatchObject({ status, error });
    expect(JSON.stringify(h.state.updates[0]!.where)).toContain('"queued"');
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: `edr.action.${status}`, details: expect.objectContaining({ reconciled: true }),
    }));
  });

  it('queued + not_applied inside the give-up window → unchanged (the task may still apply)', async () => {
    arrange([row({ requestedAt: ago(EDR_ACTION_UNKNOWN_GRACE_MS + 60_000) })]);
    h.reconcileAction.mockResolvedValue('not_applied');
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('vendor read failures are logged with the action id (not silently treated as pending)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    arrange([row()]);
    h.reconcileAction.mockRejectedValue(Object.assign(new Error('boom'), { code: 'http_error' }));
    await pollEdrActionStatus('c1', NOW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('act-1'), expect.anything());
    warn.mockRestore();
  });

  it('queued + unknown verdict, young → unchanged; past the give-up window → failed for manual re-issue', async () => {
    arrange([row()]);
    h.reconcileAction.mockResolvedValue('unknown');
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(0);

    arrange([row({ requestedAt: ago(EDR_ACTION_UNKNOWN_GIVEUP_MS + 1000) })]);
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(1);
    expect(h.state.updates[0]!.set).toMatchObject({ status: 'failed', error: 'outcome_unknown_reissue_manually' });
  });

  it('queued + reconcile throws (transient) → treated as unknown: unchanged while young', async () => {
    arrange([row()]);
    h.reconcileAction.mockRejectedValue(new Error('socket'));
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(0);
  });

  it.each([
    [{ status: 'succeeded' }, 'succeeded', null],
    [{ status: 'failed', code: 'x', message: 'y' }, 'failed', 'vendor_task_failed'],
  ])('submitted + vendor %j → %s', async (result, status, error) => {
    arrange([row({ action: 'scan', status: 'submitted', vendorActionId: 'task-1', submittedAt: ago(60_000) })]);
    h.getActionStatus.mockResolvedValue(result);
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(1);
    expect(h.getActionStatus.mock.calls[0]![2]).toBe('task-1');
    expect(h.state.updates[0]!.set).toMatchObject({ status, error });
    expect(JSON.stringify(h.state.updates[0]!.where)).toContain('"submitted"');
  });

  it('submitted + still pending → unchanged; past the 24 h timeout → failed/vendor_status_timeout', async () => {
    arrange([row({ action: 'scan', status: 'submitted', vendorActionId: 'task-1', submittedAt: ago(60_000) })]);
    h.getActionStatus.mockResolvedValue({ status: 'submitted' });
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(0);

    arrange([row({ action: 'scan', status: 'submitted', vendorActionId: 'task-1', submittedAt: ago(EDR_ACTION_SUBMITTED_TIMEOUT_MS + 1) })]);
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(1);
    expect(h.state.updates[0]!.set).toMatchObject({ status: 'failed', error: 'vendor_status_timeout' });
  });

  it('submitted + transient getActionStatus failure → unchanged', async () => {
    arrange([row({ action: 'scan', status: 'submitted', vendorActionId: 'task-1', submittedAt: ago(60_000) })]);
    h.getActionStatus.mockRejectedValue(new Error('502'));
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('CAS miss (a concurrent dispatch outcome write won) → no audit for that row', async () => {
    arrange([row()]);
    h.reconcileAction.mockResolvedValue('applied');
    h.state.casMiss.add('act-1');
    expect((await pollEdrActionStatus('c1', NOW)).settled).toBe(0);
    expect(h.createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('vendor reads run with no DB context held', async () => {
    arrange([row()]);
    h.reconcileAction.mockImplementation(async () => {
      expect(h.state.held).toBeNull();
      return 'applied';
    });
    await pollEdrActionStatus('c1', NOW);
    expect(h.reconcileAction).toHaveBeenCalledTimes(1);
  });

  it('an inactive or missing connection is a no-op', async () => {
    h.state.selects = [[{ ...connection, isActive: false }]];
    expect(await pollEdrActionStatus('c1', NOW)).toEqual({ checked: 0, settled: 0 });
    h.state.selects = [[]];
    expect(await pollEdrActionStatus('c1', NOW)).toEqual({ checked: 0, settled: 0 });
  });

  it('a row without a stored target cannot be reconciled → unknown (no vendor call)', async () => {
    expect(requestFromRow({ action: 'isolate', payload: null })).toBeNull();
    arrange([row({ payload: {} })]);
    await pollEdrActionStatus('c1', NOW);
    expect(h.reconcileAction).not.toHaveBeenCalled();
  });
});
