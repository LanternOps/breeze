import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  gates: { permission: false, mfa: false, permissionArgs: [] as unknown[][] },
  authState: { scope: 'partner' as 'organization' | 'partner' | 'system', orgId: null as string | null },
  perms: { value: undefined as undefined | Record<string, unknown> },
  ctx: { depth: 0, dispatchDepths: [] as number[] },
  dispatch: vi.fn(),
  list: vi.fn(),
  resolveScope: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    h.gates.permissionArgs.push([resource, action]);
    if (h.gates.permission) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', h.perms.value);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => (h.gates.mfa ? c.json({ error: 'MFA required' }, 403) : next())),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    h.ctx.depth += 1;
    try { return await fn(); } finally { h.ctx.depth -= 1; }
  }),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
}));
vi.mock('../../services/edrProviders/actions', () => ({
  dispatchEdrAction: (...a: unknown[]) => {
    h.ctx.dispatchDepths.push(h.ctx.depth);
    return h.dispatch(...a);
  },
}));
vi.mock('../../services/edrProviders/actionsRead', () => ({ EDR_ACTIONS_MAX_LIMIT: 200, listEdrActions: h.list }));
vi.mock('../../services/edrProviders/read', async () => {
  class EdrReadError extends Error {
    constructor(public status: number, message: string) { super(message); }
  }
  return { EdrReadError, resolveEdrReadScope: h.resolveScope };
});

import { EdrActionError } from '../../services/edrProviders/actionErrors';
import { edrActionRoutes } from './actions';

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const D1 = '44444444-4444-4444-8444-444444444444';
const USER = '99999999-9999-4999-8999-999999999999';
const ok = (id = 'act-1') => ({ actionId: id, status: 'succeeded', outcomeUnknown: false, error: null, message: null, httpStatus: 200 });

let app: Hono;
const post = (body: unknown) =>
  app.request('/edr/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.gates, { permission: false, mfa: false, permissionArgs: [] });
  h.authState.scope = 'partner';
  h.authState.orgId = null;
  h.perms.value = undefined;
  h.ctx.depth = 0;
  h.ctx.dispatchDepths = [];
  h.resolveScope.mockResolvedValue({ allowedDeviceIds: null, allowedSiteIds: null });
  h.dispatch.mockResolvedValue(ok());
  h.list.mockResolvedValue({ rows: [], total: 0 });
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { scope: h.authState.scope, orgId: h.authState.orgId, user: { id: USER } } as never);
    return next();
  });
  app.route('/edr', edrActionRoutes);
});

describe('POST /edr/actions', () => {
  it('requires devices.execute and MFA', async () => {
    h.gates.permission = true;
    expect((await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate' })).status).toBe(403);
    expect(h.gates.permissionArgs[0]).toEqual(['devices', 'execute']);
    h.gates.permission = false;
    h.gates.mfa = true;
    const res = await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate' });
    expect(res.status).toBe(403);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches as the human UI caller with the site restriction, outside any DB context', async () => {
    h.resolveScope.mockResolvedValue({ allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'], auth: {} });
    const res = await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate', reason: ' suspicious ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ endpointId: E1, ...ok() }] });
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedVia: 'ui', requestedBy: USER, aiSessionId: null, approvalId: null, reason: 'suspicious',
        restriction: { allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] },
      }),
      { kind: 'endpoint', endpointId: E1, action: 'isolate' },
    );
    expect(h.ctx.dispatchDepths).toEqual([0]);
  });

  it('an org-scope token may act (spec §4.10 partner OR org scope)', async () => {
    h.authState.scope = 'organization';
    h.authState.orgId = 'org-1';
    expect((await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'scan' })).status).toBe(200);
  });

  it.each([
    [new EdrActionError('actions_disabled', 503, 'off'), 503],
    [new EdrActionError('connection_actions_disabled', 409, 'off'), 409],
    [new EdrActionError('action_in_progress', 409, 'busy'), 409],
    [new EdrActionError('action_recently_requested', 409, 'cooldown'), 409],
    [new EdrActionError('unsupported', 422, 'Already isolated'), 422],
    [new EdrActionError('site_denied', 403, 'no'), 403],
    [new EdrActionError('target_not_found', 404, 'nope'), 404],
  ])('a single-target refusal %s maps to its HTTP status', async (err, status) => {
    h.dispatch.mockRejectedValue(err);
    const res = await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate' });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: err.code, error: err.message });
  });

  it('rate_limited → 429 with Retry-After', async () => {
    h.dispatch.mockRejectedValue(new EdrActionError('rate_limited', 429, 'slow', 42));
    const res = await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'scan' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });

  it('an unknown outcome is a 202 with outcomeUnknown', async () => {
    h.dispatch.mockResolvedValue({ ...ok(), status: 'queued', outcomeUnknown: true, error: 'dispatch_outcome_unknown', httpStatus: 202 });
    const res = await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate' });
    expect(res.status).toBe(202);
    expect((await res.json()).data[0]).toMatchObject({ outcomeUnknown: true });
  });

  it('a batch of 3 with one refusal returns 3 items from 3 sequential dispatches; one row per target', async () => {
    h.dispatch
      .mockResolvedValueOnce(ok('a'))
      .mockRejectedValueOnce(new EdrActionError('unsupported', 422, 'Already isolated'))
      .mockResolvedValueOnce(ok('c'));
    const res = await post({ targetKind: 'endpoint', endpointIds: [E1, E2, E3], action: 'isolate' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.data[1]).toMatchObject({ endpointId: E2, code: 'unsupported', httpStatus: 422 });
    expect(h.dispatch).toHaveBeenCalledTimes(3);
  });

  it('a non-EdrActionError is not swallowed', async () => {
    h.dispatch.mockRejectedValue(new Error('boom'));
    expect((await post({ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate' })).status).toBe(500);
  });

  it.each([
    [{ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate', extra: 1 }, 'unknown key'],
    [{ targetKind: 'endpoint', endpointIds: Array.from({ length: 11 }, () => E1), action: 'isolate' }, '> 10 targets'],
    [{ targetKind: 'endpoint', endpointIds: [], action: 'isolate' }, 'no targets'],
    [{ targetKind: 'endpoint', endpointIds: [E1], action: 'kill_process' }, 'kill_process without pid'],
    [{ targetKind: 'endpoint', endpointIds: [E1, E2], action: 'kill_process', pid: 4 }, 'kill_process on two endpoints'],
    [{ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate', pid: 4 }, 'pid on a non-kill action'],
    [{ targetKind: 'endpoint', endpointIds: [E1], action: 'rollback' }, 'detection action on an endpoint'],
    [{ targetKind: 'detection', detectionId: D1, action: 'isolate' }, 'endpoint action on a detection'],
    [{ targetKind: 'endpoint', endpointIds: ['not-a-uuid'], action: 'isolate' }, 'bad id'],
    [{ targetKind: 'endpoint', endpointIds: [E1], action: 'isolate', reason: 'x'.repeat(501) }, 'long reason'],
  ] as Array<[Record<string, unknown>, string]>)('%j → 400 (%s)', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a detection target dispatches one detection action', async () => {
    await post({ targetKind: 'detection', detectionId: D1, action: 'quarantine_restore' });
    expect(h.dispatch).toHaveBeenCalledWith(expect.anything(), { kind: 'detection', detectionId: D1, action: 'quarantine_restore' });
  });
});

describe('GET /edr/actions', () => {
  it('needs devices.read and delegates to the ledger read model with the caller scope', async () => {
    h.perms.value = { allowedSiteIds: ['s1'] };
    h.resolveScope.mockResolvedValue({ auth: {}, allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] });
    h.list.mockResolvedValue({ rows: [{ id: 'a1' }], total: 1 });
    const res = await app.request(`/edr/actions?status=open&deviceId=${D1}&limit=500`);
    expect(res.status).toBe(200);
    expect(h.gates.permissionArgs.at(-1)).toEqual(['devices', 'read']);
    expect(h.resolveScope).toHaveBeenCalledWith(expect.anything(), { allowedSiteIds: ['s1'] });
    expect(h.list).toHaveBeenCalledWith(
      { auth: {}, allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] },
      expect.objectContaining({ status: 'open', deviceId: D1, limit: 200, offset: 0 }),
    );
    expect(await res.json()).toEqual({ data: [{ id: 'a1' }], pagination: { limit: 200, offset: 0, total: 1 } });
  });

  it('a read-model refusal (foreign org) is passed through', async () => {
    const { EdrReadError } = await import('../../services/edrProviders/read');
    h.list.mockRejectedValue(new (EdrReadError as unknown as new (s: number, m: string) => Error)(403, 'Access to this organization denied'));
    expect((await app.request('/edr/actions?orgId=11111111-1111-4111-8111-111111111111')).status).toBe(403);
  });

  it('rejects a bad status filter', async () => {
    expect((await app.request('/edr/actions?status=bogus')).status).toBe(400);
  });
});
