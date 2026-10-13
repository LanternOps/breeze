import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * dispatchEdrAction (W03 A6). Drizzle is faked with a recording chain; the DB
 * context helpers track whether a context is held so the fake adapter can
 * prove the vendor call happens OUTSIDE any context and AFTER the insert.
 */
const h = vi.hoisted(() => {
  const state = {
    held: null as null | 'caller' | 'system',
    log: [] as string[],
    selects: [] as unknown[][], // queued results for db.select() chains, FIFO
    inserted: [] as Record<string, unknown>[],
    insertError: null as unknown,
    updateError: null as unknown,
    updates: [] as { table: string; set: Record<string, unknown>; where: unknown; ctx: string | null }[],
    callerCtxs: [] as unknown[],
  };
  const tableName = (t: unknown) => (t as { _name?: string })?._name ?? 'unknown';
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy', 'leftJoin', 'innerJoin']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return c;
  };
  const db = {
    select: vi.fn(() => {
      state.log.push(`select:${state.held}`);
      return chain(state.selects.shift() ?? []);
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((v: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          state.log.push(`insert:${tableName(table)}:${state.held}`);
          if (state.insertError) throw state.insertError;
          state.inserted.push(v);
          return [{ id: 'act-1' }];
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn(async (where: unknown) => {
          state.log.push(`update:${tableName(table)}:${state.held}`);
          if (state.updateError) throw state.updateError;
          state.updates.push({ table: tableName(table), set, where, ctx: state.held });
          return [];
        }),
      })),
    })),
  };
  const enter = async <T>(kind: 'caller' | 'system', fn: () => Promise<T>): Promise<T> => {
    const prev = state.held;
    state.held = kind;
    try {
      return await fn();
    } finally {
      state.held = prev;
    }
  };
  return {
    state,
    db,
    withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
      state.callerCtxs.push(ctx);
      return enter('caller', fn);
    }),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => enter('system', fn)),
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => {
      const prev = state.held;
      state.held = null;
      const out = fn();
      if (out instanceof Promise) return out.finally(() => { state.held = prev; }) as T;
      state.held = prev;
      return out;
    }),
    hasDbAccessContext: vi.fn(() => state.held !== null),
    resolveEdrActionTarget: vi.fn(),
    createAuditLog: vi.fn(async () => undefined),
    createAuditLogAsync: vi.fn(async () => undefined),
    checkEdrActionRateLimit: vi.fn(async () => ({ ok: true })),
    edrActionsEnabled: vi.fn(() => true),
    decryptEdrSecret: vi.fn(() => ({ apiKey: 'k'.repeat(20) })),
    buildEdrAdapterContext: vi.fn<(...a: unknown[]) => unknown>(() => ({ ctx: true })),
    performAction: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
    supportsAction: vi.fn<(...a: unknown[]) => { ok: boolean; reason?: string }>(() => ({ ok: true })),
    adapterActions: ['isolate', 'unisolate', 'scan'] as string[],
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  withDbAccessContext: h.withDbAccessContext,
  withSystemDbAccessContext: h.withSystemDbAccessContext,
  runOutsideDbContext: h.runOutsideDbContext,
  hasDbAccessContext: h.hasDbAccessContext,
}));
vi.mock('../../db/schema', () => {
  const t = (name: string, cols: string[]) => Object.fromEntries([['_name', name], ...cols.map((c) => [c, `${name}.${c}`])]);
  return {
    edrActions: t('edr_actions', ['id', 'status', 'action', 'endpointId', 'detectionId', 'requestedAt']),
    edrConnections: t('edr_connections', ['id', 'partnerId', 'status']),
    edrDetections: t('edr_detections', ['breezeDeviceId', 'deviceDetachedAt', 'lastSiteId', 'status']),
    edrTenants: t('edr_tenants', ['id', 'orgId', 'connectionId', 'vendorTenantId', 'apiHost', 'unsupportedActions', 'unsupportedActionsAt', 'vendorMissingSince']),
  };
});
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a.filter(Boolean) }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ sql: s.join('?'), v }), { raw: (s: string) => s }),
}));
vi.mock('./actionTargets', () => ({ resolveEdrActionTarget: h.resolveEdrActionTarget, EDR_ACTION_COOLDOWN_MS: 60_000 }));
vi.mock('../auditService', () => ({ createAuditLog: h.createAuditLog, createAuditLogAsync: h.createAuditLogAsync }));
vi.mock('../redis', () => ({ getRedis: () => ({ redis: true }) }));
vi.mock('../../config/env', () => ({ edrActionsEnabled: h.edrActionsEnabled }));
vi.mock('./actionGates', () => ({
  checkEdrActionRateLimit: h.checkEdrActionRateLimit,
  edrActorKey: (o: { userId: string | null }) => `u:${o.userId}`,
}));
vi.mock('./credentials', () => ({ decryptEdrSecret: h.decryptEdrSecret }));
vi.mock('./context', () => ({ buildEdrAdapterContext: h.buildEdrAdapterContext }));
vi.mock('./registry', () => ({
  getEdrProvider: (key: string) => {
    if (key !== 'bitdefender') throw new Error('unknown');
    return {
      key: 'bitdefender',
      label: 'Bitdefender GravityZone',
      capabilities: { actions: h.adapterActions },
      performAction: h.performAction,
      supportsAction: h.supportsAction,
    };
  },
}));
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: (a: { scope: string }) => ({ fromAuth: a.scope }) }));

import { describeEndpointActions, dispatchEdrAction, EDR_TENANT_DENIAL_TTL_MS, type EdrActionActor } from './actions';
import { EdrActionError } from './actionErrors';
import { EdrProviderRequestError } from './types';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-000000000001';

function auth(over: Record<string, unknown> = {}) {
  return {
    scope: 'partner',
    principal: { kind: 'user_session' },
    user: { id: USER },
    canAccessOrg: vi.fn(() => true),
    ...over,
  } as unknown as EdrActionActor['auth'];
}
function actor(over: Partial<EdrActionActor> = {}): EdrActionActor {
  return {
    auth: auth(),
    restriction: { allowedDeviceIds: null, allowedSiteIds: null },
    requestedVia: 'ui',
    requestedBy: USER,
    aiSessionId: null,
    approvalId: null,
    reason: null,
    ...over,
  };
}
const resolvedEndpoint = (over: Record<string, unknown> = {}) => ({
  orgId: ORG_A,
  partnerId: 'p1',
  connectionId: 'c1',
  tenantId: 't1',
  breezeDeviceId: 'dev-1',
  endpoint: { id: 'ep-1', vendorEndpointId: 'vend-ep-1', osPlatform: 'windows', isolationState: 'not_isolated', online: true },
  detection: null,
  detached: false,
  recentlyRequested: false,
  ...over,
});
const connectionRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', partnerId: 'p1', provider: 'bitdefender', isActive: true, status: 'connected', actionsEnabled: true,
  capabilitiesSnapshot: [], credentialsEncrypted: 'enc', baseUrl: null, region: null, ...over,
});
const tenantRow = (over: Record<string, unknown> = {}) => ({
  id: 't1', orgId: ORG_A, vendorTenantId: 'company-1', apiHost: null, unsupportedActions: [], unsupportedActionsAt: null,
  vendorMissingSince: null, ...over,
});
const ISOLATE = { kind: 'endpoint' as const, endpointId: 'ep-1', action: 'isolate' as const };

function arrange(o: { resolved?: unknown; connection?: unknown; tenant?: unknown } = {}) {
  h.resolveEdrActionTarget.mockResolvedValue(o.resolved === undefined ? resolvedEndpoint() : o.resolved);
  h.state.selects = [
    o.connection === undefined ? [connectionRow()] : (o.connection ? [o.connection] : []),
    o.tenant === undefined ? [tenantRow()] : (o.tenant ? [o.tenant] : []),
  ];
}
async function refusal(p: Promise<unknown>): Promise<EdrActionError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(EdrActionError);
  return err as EdrActionError;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.state, { held: null, log: [], selects: [], inserted: [], insertError: null, updateError: null, updates: [], callerCtxs: [] });
  h.edrActionsEnabled.mockReturnValue(true);
  h.supportsAction.mockReturnValue({ ok: true });
  h.checkEdrActionRateLimit.mockResolvedValue({ ok: true });
  h.createAuditLog.mockResolvedValue(undefined);
  h.decryptEdrSecret.mockReturnValue({ apiKey: 'k'.repeat(20) });
  h.performAction.mockImplementation(async () => {
    // The row is committed and no DB context is held during vendor HTTP.
    expect(h.state.inserted).toHaveLength(1);
    expect(h.hasDbAccessContext()).toBe(false);
    return { status: 'succeeded' };
  });
});

describe('dispatchEdrAction — the single action door', () => {
  it('happy path: one row, audit, one vendor call outside any context, CAS outcome write', async () => {
    arrange();
    const out = await dispatchEdrAction(actor({ reason: 'contain' }), ISOLATE);
    expect(out).toEqual({ actionId: 'act-1', status: 'succeeded', outcomeUnknown: false, error: null, message: null, httpStatus: 200 });
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls[0]!.slice(1)).toEqual([
      { vendorTenantId: 'company-1', apiHost: null },
      { action: 'isolate', target: { kind: 'endpoint', vendorEndpointId: 'vend-ep-1' } },
      'act-1',
    ]);
    expect(h.buildEdrAdapterContext.mock.calls[0]![1]).toMatchObject({ maxWaitMs: 5_000 });
    expect(h.state.inserted[0]).toMatchObject({
      connectionId: 'c1', partnerId: 'p1', orgId: ORG_A, tenantId: 't1', endpointId: 'ep-1', detectionId: null,
      breezeDeviceId: 'dev-1', provider: 'bitdefender', action: 'isolate', requestedBy: USER, requestedVia: 'ui',
      status: 'queued', payload: { reason: 'contain', target: { kind: 'endpoint', vendorEndpointId: 'vend-ep-1' } },
    });
    const order = h.state.log.filter((l) => l.startsWith('insert') || l.startsWith('update'));
    expect(order).toEqual(['insert:edr_actions:caller', 'update:edr_actions:system']);
    expect(h.state.updates[0]!.set).toMatchObject({ status: 'succeeded' });
    expect(JSON.stringify(h.state.updates[0]!.where)).toContain('"queued"'); // CAS on status
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'edr.action.requested', actorType: 'user', actorId: USER, resourceId: 'act-1', orgId: ORG_A,
    }));
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'edr.action.succeeded' }));
  });

  it('called while a DB context is held → throws before any read or vendor call', async () => {
    arrange();
    h.state.held = 'caller';
    await expect(dispatchEdrAction(actor(), ISOLATE)).rejects.toThrow(/outside a DB access context/);
    expect(h.resolveEdrActionTarget).not.toHaveBeenCalled();
    expect(h.performAction).not.toHaveBeenCalled();
  });

  it('1. kill switch → actions_disabled 503, nothing read', async () => {
    arrange();
    h.edrActionsEnabled.mockReturnValue(false);
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code: 'actions_disabled', httpStatus: 503 });
    expect(h.resolveEdrActionTarget).not.toHaveBeenCalled();
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('an AI operator agent principal never dispatches directly (approval_required)', async () => {
    arrange();
    const e = await refusal(dispatchEdrAction(actor({ auth: auth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } }) }), ISOLATE));
    expect(e.code).toBe('approval_required');
    expect(h.state.inserted).toHaveLength(0);
  });

  it('2. target resolved under the CALLER context; none visible → target_not_found 404', async () => {
    arrange({ resolved: null });
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code: 'target_not_found', httpStatus: 404 });
    expect(h.withDbAccessContext).toHaveBeenCalledWith({ fromAuth: 'partner' }, expect.any(Function));
    expect(h.state.inserted).toHaveLength(0);
  });

  it('2. selected-org double check: a row an over-permissive RLS returned still 404s', async () => {
    arrange();
    const e = await refusal(dispatchEdrAction(actor({ auth: auth({ canAccessOrg: vi.fn(() => false) }) }), ISOLATE));
    expect(e.code).toBe('target_not_found');
    expect(h.performAction).not.toHaveBeenCalled();
  });

  it('2. tombstoned detection → target_detached 409, no row', async () => {
    arrange({ resolved: resolvedEndpoint({ detached: true, endpoint: null, detection: { id: 'd1', vendorDetectionId: 'v', vendorKind: 'incident' } }) });
    const e = await refusal(dispatchEdrAction(actor(), { kind: 'detection', detectionId: 'd1', action: 'rollback' }));
    expect(e).toMatchObject({ code: 'target_detached', httpStatus: 409 });
    expect(h.state.inserted).toHaveLength(0);
  });

  it('3. site-restricted caller, endpoint never linked → site_denied 403, no insert', async () => {
    arrange({ resolved: resolvedEndpoint({ breezeDeviceId: null }) });
    const e = await refusal(dispatchEdrAction(actor({ restriction: { allowedDeviceIds: ['dev-1'], allowedSiteIds: ['s1'] } }), ISOLATE));
    expect(e).toMatchObject({ code: 'site_denied', httpStatus: 403 });
    expect(h.state.inserted).toHaveLength(0);
  });

  it('3. site-restricted caller, endpoint linked to a device outside the allowlist → site_denied', async () => {
    arrange();
    const e = await refusal(dispatchEdrAction(actor({ restriction: { allowedDeviceIds: ['dev-9'], allowedSiteIds: ['s1'] } }), ISOLATE));
    expect(e.code).toBe('site_denied');
  });

  it('3. site-restricted caller, endpoint linked to an allowed device → dispatched', async () => {
    arrange();
    await dispatchEdrAction(actor({ restriction: { allowedDeviceIds: ['dev-1'], allowedSiteIds: ['s1'] } }), ISOLATE);
    expect(h.performAction).toHaveBeenCalledTimes(1);
  });

  it('4. connection/tenant are loaded under SYSTEM context keyed by the authorized row ids only', async () => {
    arrange();
    await dispatchEdrAction(actor(), { kind: 'device', deviceId: 'attacker-chosen', connectionId: 'attacker-conn', action: 'isolate' });
    const systemSelects = h.state.log.filter((l) => l === 'select:system');
    expect(systemSelects).toHaveLength(2);
    const whereArgs = (h.db.select.mock.results as { value: { where: { mock: { calls: unknown[][] } } } }[])
      .map((r) => JSON.stringify(r.value.where.mock.calls));
    expect(whereArgs.join()).not.toContain('attacker');
    expect(whereArgs[0]).toContain('"c1"');
    expect(whereArgs[0]).toContain('"p1"');
    expect(whereArgs[1]).toContain('"t1"');
    expect(whereArgs[1]).toContain(ORG_A);
  });

  it('4. tenant remapped away from the row org (system load finds nothing) → 404', async () => {
    arrange({ tenant: null });
    expect((await refusal(dispatchEdrAction(actor(), ISOLATE))).code).toBe('target_not_found');
  });

  it.each([
    [{ isActive: false }, 'connection_unavailable', 409],
    [{ status: 'reauth_required' }, 'connection_unavailable', 409],
    [{ actionsEnabled: false }, 'connection_actions_disabled', 409],
  ])('4. connection gate %j → %s', async (over, code, status) => {
    arrange({ connection: connectionRow(over) });
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code, httpStatus: status });
    expect(h.state.inserted).toHaveLength(0);
  });

  it('5. capability: adapter refusal → unsupported 422 with the reason, no row', async () => {
    arrange();
    h.supportsAction.mockReturnValue({ ok: false, reason: 'Already isolated' });
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code: 'unsupported', httpStatus: 422, message: 'Already isolated' });
    expect(h.state.inserted).toHaveLength(0);
  });

  it('5. an action the adapter does not declare → unsupported, supportsAction not consulted', async () => {
    arrange();
    const e = await refusal(dispatchEdrAction(actor(), { kind: 'endpoint', endpointId: 'ep-1', action: 'update_agent' }));
    expect(e.code).toBe('unsupported');
    expect(h.supportsAction).not.toHaveBeenCalled();
  });

  it('5. tenant denial younger than 24 h reaches supportsAction; older is ignored', async () => {
    arrange({ tenant: tenantRow({ unsupportedActions: ['isolate'], unsupportedActionsAt: new Date(Date.now() - 3600_000) }) });
    await dispatchEdrAction(actor(), ISOLATE);
    expect(h.supportsAction.mock.calls[0]![0]).toMatchObject({ tenantUnsupportedActions: ['isolate'] });

    vi.clearAllMocks();
    Object.assign(h.state, { inserted: [], log: [] });
    arrange({ tenant: tenantRow({ unsupportedActions: ['isolate'], unsupportedActionsAt: new Date(Date.now() - EDR_TENANT_DENIAL_TTL_MS - 1) }) });
    h.supportsAction.mockReturnValue({ ok: true });
    h.checkEdrActionRateLimit.mockResolvedValue({ ok: true });
    h.performAction.mockResolvedValue({ status: 'succeeded' });
    await dispatchEdrAction(actor(), ISOLATE);
    expect(h.supportsAction.mock.calls[0]![0]).toMatchObject({ tenantUnsupportedActions: [] });
    expect(h.performAction).toHaveBeenCalledTimes(1);
  });

  it('6. cooldown: a recent same-action success → action_recently_requested 409, no row', async () => {
    arrange({ resolved: resolvedEndpoint({ recentlyRequested: true }) });
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code: 'action_recently_requested', httpStatus: 409 });
    expect(h.checkEdrActionRateLimit).not.toHaveBeenCalled();
    expect(h.state.inserted).toHaveLength(0);
  });

  it('6. Breeze-side rate limit → rate_limited 429 with retry-after, no row; checked outside any context', async () => {
    arrange();
    h.checkEdrActionRateLimit.mockImplementation(async () => {
      expect(h.hasDbAccessContext()).toBe(false);
      return { ok: false, retryAfterSeconds: 42 };
    });
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code: 'rate_limited', httpStatus: 429, retryAfterSeconds: 42 });
    expect(h.state.inserted).toHaveLength(0);
  });

  it('7. 23505 on the in-flight index → action_in_progress 409 and no vendor call', async () => {
    arrange();
    h.state.insertError = Object.assign(new Error('dup'), { code: '23505' });
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e).toMatchObject({ code: 'action_in_progress', httpStatus: 409 });
    expect(h.performAction).not.toHaveBeenCalled();
  });

  it('7. 23503 on the tenant/org composite FK (remap race) → target_not_found', async () => {
    arrange();
    h.state.insertError = Object.assign(new Error('fk'), { cause: { code: '23503' } });
    expect((await refusal(dispatchEdrAction(actor(), ISOLATE))).code).toBe('target_not_found');
    expect(h.performAction).not.toHaveBeenCalled();
  });

  it('7. audit failure → no vendor call; row failed/audit_unavailable', async () => {
    arrange();
    h.createAuditLog.mockRejectedValue(new Error('audit db down'));
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e.code).toBe('audit_unavailable');
    expect(h.performAction).not.toHaveBeenCalled();
    expect(h.state.updates[0]).toMatchObject({ table: 'edr_actions', set: { status: 'failed', error: 'audit_unavailable' } });
  });

  it('7. audit failure AND a failing cleanup write still surface audit_unavailable (never a raw error), and are logged', async () => {
    arrange();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.createAuditLog.mockRejectedValue(new Error('audit db down'));
    h.state.updateError = new Error('pool exhausted');
    const e = await refusal(dispatchEdrAction(actor(), ISOLATE));
    expect(e.code).toBe('audit_unavailable');
    expect(h.performAction).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('9. an outcome write that throws after the vendor accepted still returns the vendor outcome (logged; the reconciler settles the row)', async () => {
    arrange();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.performAction.mockImplementation(async () => {
      h.state.updateError = new Error('deadlock');
      return { status: 'succeeded' };
    });
    const out = await dispatchEdrAction(actor(), ISOLATE);
    expect(out).toMatchObject({ actionId: 'act-1', status: 'succeeded', httpStatus: 200 });
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('act-1'), expect.anything());
    err.mockRestore();
  });

  it('7. requestedBy is stored exactly as passed (null stays null); AI provenance recorded', async () => {
    arrange();
    await dispatchEdrAction(actor({
      requestedBy: null, requestedVia: 'ai', aiSessionId: 'sess-1', approvalId: 'intent-1',
      auth: auth({ aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' } }),
    }), ISOLATE);
    expect(h.state.inserted[0]).toMatchObject({
      requestedBy: null, requestedVia: 'ai', aiSessionId: 'sess-1', approvalId: 'intent-1',
      payload: expect.objectContaining({ aiAgentRunId: 'run-1' }),
    });
  });

  it('8. submitted → vendor action id stored, status submitted', async () => {
    arrange();
    h.performAction.mockResolvedValue({ status: 'submitted', vendorActionId: 'task-9' });
    const out = await dispatchEdrAction(actor(), { kind: 'endpoint', endpointId: 'ep-1', action: 'scan' });
    expect(out).toMatchObject({ status: 'submitted', httpStatus: 200 });
    expect(h.state.updates[0]!.set).toMatchObject({ status: 'submitted', vendorActionId: 'task-9' });
  });

  it('8. outcome unknown → row stays queued with dispatch_outcome_unknown, 202, performAction called exactly once', async () => {
    arrange();
    h.performAction.mockRejectedValue(new EdrProviderRequestError('timeout', { code: 'outcome_unknown', reauth: false, scope: 'operation' }));
    const out = await dispatchEdrAction(actor(), ISOLATE);
    expect(out).toMatchObject({ status: 'queued', outcomeUnknown: true, error: 'dispatch_outcome_unknown', httpStatus: 202 });
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.state.updates[0]!.set).not.toHaveProperty('status');
    expect(h.state.updates[0]!.set).toMatchObject({ error: 'dispatch_outcome_unknown' });
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'edr.action.outcome_unknown' }));
  });

  it('9. licence error → row failed, tenant denial recorded on the row tenant, 422', async () => {
    arrange();
    h.performAction.mockRejectedValue(new EdrProviderRequestError('no licence', { code: 'licence', reauth: false, scope: 'operation' }));
    const out = await dispatchEdrAction(actor(), ISOLATE);
    expect(out).toMatchObject({ status: 'failed', error: 'licence', httpStatus: 422 });
    const tenantUpdate = h.state.updates.find((u) => u.table === 'edr_tenants');
    expect(tenantUpdate).toBeDefined();
    expect(tenantUpdate!.ctx).toBe('system');
    expect(JSON.stringify(tenantUpdate!.where)).toContain('"t1"');
    expect(tenantUpdate!.set).toHaveProperty('unsupportedActionsAt');
  });

  it('9. connection-scoped reauth → connection marked reauth_required', async () => {
    arrange();
    h.performAction.mockRejectedValue(new EdrProviderRequestError('401', { code: 'auth', reauth: true, scope: 'connection' }));
    const out = await dispatchEdrAction(actor(), ISOLATE);
    expect(out).toMatchObject({ status: 'failed', error: 'vendor_auth', httpStatus: 502 });
    expect(h.state.updates.find((u) => u.table === 'edr_connections')?.set).toMatchObject({ status: 'reauth_required' });
  });

  it('9. vendor rejection text never carries the credential', async () => {
    arrange();
    h.performAction.mockRejectedValue(new EdrProviderRequestError(`bad ${'k'.repeat(20)}`, { code: 'vendor_error', reauth: false, scope: 'operation' }));
    const out = await dispatchEdrAction(actor(), ISOLATE);
    expect(out.message).not.toContain('k'.repeat(20));
  });

  it('credential decrypt failure → connection_unavailable before any row', async () => {
    arrange();
    h.decryptEdrSecret.mockImplementation(() => { throw new Error('bad aad'); });
    expect((await refusal(dispatchEdrAction(actor(), ISOLATE))).code).toBe('connection_unavailable');
    expect(h.state.inserted).toHaveLength(0);
  });

  it('detection actions never stamp endpoint_id (the in-flight index is per endpoint)', async () => {
    arrange({ resolved: resolvedEndpoint({ detection: { id: 'd1', vendorDetectionId: 'q1', vendorKind: 'quarantine_item' } }) });
    h.adapterActions.push('quarantine_restore');
    try {
      await dispatchEdrAction(actor(), { kind: 'detection', detectionId: 'd1', action: 'quarantine_restore' });
    } finally {
      h.adapterActions.pop();
    }
    expect(h.state.inserted[0]).toMatchObject({ endpointId: null, detectionId: 'd1', breezeDeviceId: 'dev-1' });
    expect(h.performAction.mock.calls[0]![2]).toEqual({ action: 'quarantine_restore', target: { kind: 'quarantine_item', vendorItemId: 'q1' } });
  });
});

describe('describeEndpointActions', () => {
  const endpoint = { vendorEndpointId: 'v', osPlatform: 'windows' as const, isolationState: 'not_isolated' as const, online: true, breezeDeviceId: 'dev-1' };
  const tenant = { unsupportedActions: [] as never[], unsupportedActionsAt: null };

  it('lists every endpoint action with availability and reasons, no I/O', () => {
    const rows = describeEndpointActions(endpoint, tenant, connectionRow() as never);
    expect(rows.map((r) => r.action)).toEqual(['isolate', 'unisolate', 'scan', 'update_agent', 'kill_process']);
    expect(rows.find((r) => r.action === 'isolate')).toEqual({ action: 'isolate', available: true, reason: null });
    expect(rows.find((r) => r.action === 'update_agent')).toMatchObject({ available: false, reason: 'Not supported by Bitdefender GravityZone' });
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('kill switch, connection switch and site restriction each show a reason', () => {
    h.edrActionsEnabled.mockReturnValue(false);
    expect(describeEndpointActions(endpoint, tenant, connectionRow() as never)[0]!.reason).toBe('Response actions are disabled on this server');
    h.edrActionsEnabled.mockReturnValue(true);
    expect(describeEndpointActions(endpoint, tenant, connectionRow({ actionsEnabled: false }) as never)[0]!.reason)
      .toMatch(/turned off for this EDR connection/);
    expect(describeEndpointActions({ ...endpoint, breezeDeviceId: null }, tenant, connectionRow() as never, {
      restriction: { allowedDeviceIds: ['dev-1'], allowedSiteIds: ['s1'] },
    })[0]).toMatchObject({ available: false, reason: expect.stringMatching(/not linked to a device in your sites/) });
  });
});
