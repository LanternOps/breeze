import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = { held: null as null | 'request' | 'system', results: [] as unknown[][], selectCtx: [] as unknown[] };
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    (c as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return c;
  };
  return {
    state,
    db: {
      select: vi.fn((cols: Record<string, unknown>) => {
        state.selectCtx.push(state.held);
        expect(Object.keys(cols)).not.toContain('credentialsEncrypted');
        return chain(state.results.shift() ?? []);
      }),
    },
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const prev = state.held;
      state.held = null;
      try { return await fn(); } finally { state.held = prev; }
    }),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const prev = state.held;
      state.held = 'system';
      try { return await fn(); } finally { state.held = prev; }
    }),
    resolveEdrReadScope: vi.fn(async () => ({ allowedDeviceIds: null as string[] | null, allowedSiteIds: null as string[] | null })),
    describeEndpointActions: vi.fn(() => [{ action: 'isolate', available: true, reason: null }]),
  };
});
vi.mock('../../db', () => ({ db: h.db, runOutsideDbContext: h.runOutsideDbContext, withSystemDbAccessContext: h.withSystemDbAccessContext }));
vi.mock('./read', () => ({ resolveEdrReadScope: h.resolveEdrReadScope }));
vi.mock('./actions', () => ({ describeEndpointActions: h.describeEndpointActions }));
const mfa = vi.hoisted(() => ({ satisfied: true }));
vi.mock('../../middleware/auth', () => ({ hasSatisfiedMfa: vi.fn(() => mfa.satisfied) }));
vi.mock('../permissions', () => ({
  PERMISSIONS: { DEVICES_EXECUTE: { resource: 'devices', action: 'execute' } },
  hasPermission: (p: { permissions: Array<{ resource: string; action: string }> }, r: string, a: string) =>
    p.permissions.some((x) => x.resource === r && x.action === a),
}));
const EXEC = { permissions: [{ resource: 'devices', action: 'read' }, { resource: 'devices', action: 'execute' }] } as never;
const READ_ONLY = { permissions: [{ resource: 'devices', action: 'read' }] } as never;

import { describeEndpointActionsForRows, type EdrEndpointRowForActions } from './actionAvailability';

const row = (over: Partial<EdrEndpointRowForActions> = {}): EdrEndpointRowForActions => ({
  id: 'e1', orgId: 'org-a', connectionId: 'c1', tenantId: 't1', vendorEndpointId: 'v1',
  osPlatform: 'windows', isolationState: 'not_isolated', online: true, breezeDeviceId: 'd1', ...over,
});
const connection = { id: 'c1', provider: 'bitdefender', isActive: true, status: 'connected', actionsEnabled: true, capabilitiesSnapshot: [] };
const tenant = { id: 't1', orgId: 'org-a', unsupportedActions: [], unsupportedActionsAt: null, vendorMissingSince: null };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.state, { held: 'request', results: [], selectCtx: [] });
});

describe('describeEndpointActionsForRows', () => {
  it('loads partner-axis facts under a SYSTEM context outside the request tx and describes each row', async () => {
    h.state.results = [[connection], [tenant]];
    h.resolveEdrReadScope.mockResolvedValue({ allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] });
    const out = await describeEndpointActionsForRows({} as never, undefined, [row()]);
    // Partner-axis facts under SYSTEM; the ledger read stays in the caller's own context (#12789).
    expect(h.state.selectCtx).toEqual(['system', 'system', 'request']);
    expect(h.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(out.get('e1')).toEqual([{ action: 'isolate', available: true, reason: null }]);
    expect(h.describeEndpointActions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }), tenant, connection,
      expect.objectContaining({ restriction: { allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] } }),
    );
  });

  it('PR-B carry-forward: the caller facts (devices.execute, MFA) are derived from the request and passed down', async () => {
    h.state.results = [[connection], [tenant]];
    mfa.satisfied = true;
    await describeEndpointActionsForRows({} as never, EXEC, [row()]);
    expect(h.describeEndpointActions).toHaveBeenLastCalledWith(
      expect.anything(), tenant, connection, expect.objectContaining({ caller: { canExecute: true, mfaSatisfied: true } }),
    );
    h.state.results = [[connection], [tenant]];
    mfa.satisfied = false;
    await describeEndpointActionsForRows({} as never, READ_ONLY, [row()]);
    expect(h.describeEndpointActions).toHaveBeenLastCalledWith(
      expect.anything(), tenant, connection, expect.objectContaining({ caller: { canExecute: false, mfaSatisfied: false } }),
    );
    // No resolved permissions -> fail closed.
    h.state.results = [[connection], [tenant]];
    mfa.satisfied = true;
    await describeEndpointActionsForRows({} as never, undefined, [row()]);
    expect(h.describeEndpointActions).toHaveBeenLastCalledWith(
      expect.anything(), tenant, connection, expect.objectContaining({ caller: { canExecute: false, mfaSatisfied: true } }),
    );
  });

  it('a tenant whose org no longer matches the row (remapped) yields no actions', async () => {
    h.state.results = [[connection], [{ ...tenant, orgId: 'org-b' }]];
    const out = await describeEndpointActionsForRows({} as never, undefined, [row()]);
    expect(out.get('e1')).toEqual([]);
    expect(h.describeEndpointActions).not.toHaveBeenCalled();
  });

  it('#12789 item 4: open and just-succeeded ledger rows are read in the CALLER context and passed per endpoint', async () => {
    const requestedAt = new Date();
    h.state.results = [[connection], [tenant], [
      { endpointId: 'e1', action: 'isolate', status: 'queued', error: 'dispatch_outcome_unknown', requestedAt },
      { endpointId: 'e2', action: 'scan', status: 'submitted', error: null, requestedAt },
    ]];
    await describeEndpointActionsForRows({} as never, EXEC, [row(), row({ id: 'e2', vendorEndpointId: 'v2', breezeDeviceId: 'd2' })]);
    expect(h.state.selectCtx[2]).toBe('request');
    expect(h.describeEndpointActions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }), tenant, connection,
      expect.objectContaining({ ledger: [{ action: 'isolate', status: 'queued', error: 'dispatch_outcome_unknown', requestedAt }] }),
    );
    expect(h.describeEndpointActions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2' }), tenant, connection,
      expect.objectContaining({ ledger: [{ action: 'scan', status: 'submitted', error: null, requestedAt }] }),
    );
  });

  it('#12789 item 6: the tenant facts include vendorMissingSince', async () => {
    const missing = { ...tenant, vendorMissingSince: new Date('2026-11-01T00:00:00Z') };
    h.state.results = [[connection], [missing]];
    await describeEndpointActionsForRows({} as never, EXEC, [row()]);
    expect(h.describeEndpointActions).toHaveBeenLastCalledWith(expect.anything(), missing, connection, expect.anything());
  });

  it('no rows → no queries', async () => {
    expect((await describeEndpointActionsForRows({} as never, undefined, [])).size).toBe(0);
    expect(h.db.select).not.toHaveBeenCalled();
  });
});
