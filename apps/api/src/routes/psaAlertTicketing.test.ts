import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => {
  function chain(rows: unknown[]) {
    const c: Record<string, any> = {};
    for (const m of ['from', 'where', 'limit', 'returning', 'set', 'orderBy', 'innerJoin', 'leftJoin', 'for']) {
      c[m] = vi.fn(() => Object.assign(Promise.resolve(rows), c));
    }
    return Object.assign(Promise.resolve(rows), c);
  }
  return {
    chain,
    gates: { permissionDeny: false, mfaDeny: false },
    authState: { current: null as Record<string, unknown> | null },
    selectMock: vi.fn(() => chain([])),
    updateMock: vi.fn(() => chain([])),
    createPSAProviderMock: vi.fn(),
    decryptCredentialsMock: vi.fn(),
    writeRouteAuditMock: vi.fn(),
    wakeMock: vi.fn(async () => {}),
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: (...args: unknown[]) => h.selectMock(...(args as [])),
    update: (...args: unknown[]) => h.updateMock(...(args as [])),
  },
}));

vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: vi.fn((_auth: unknown, fn: () => Promise<unknown>) => fn()),
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', h.authState.current);
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (h.gates.permissionDeny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (h.gates.mfaDeny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAuditMock }));

vi.mock('../services/psa/credentials', async () => ({
  ...(await vi.importActual<typeof import('../services/psa/credentials')>('../services/psa/credentials')),
  decryptCredentials: h.decryptCredentialsMock,
}));

vi.mock('../services/psa', async () => {
  const types = await vi.importActual<typeof import('../services/psa/types')>('../services/psa/types');
  return { ...types, createPSAProvider: h.createPSAProviderMock };
});

vi.mock('../services/secretCrypto', () => ({
  hmacFingerprint: vi.fn((value: string) => `fp1:test:${Buffer.from(value).toString('hex')}`),
}));

vi.mock('../services/psaAlertTicketing/queue', () => ({ wakeMapping: h.wakeMock }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { psaAlertTicketingRoutes, psaTicketMappingActionRoutes } from './psaAlertTicketing';
import { PsaAdapterError } from '../services/psa/types';
import { psaInstanceKey } from '../services/psaAlertTicketing/config';

const CREDENTIALS = { baseUrl: 'https://api-na.example-psa.test/v4_6_release/apis/3.0', companyId: 'mspco', publicKey: 'p', privateKey: 's' };
const INSTANCE_KEY = psaInstanceKey('connectwise', CREDENTIALS)!;

function partnerAuth(orgAccess: 'all' | 'selected' = 'all', partnerId = PARTNER_ID) {
  return {
    scope: 'partner',
    partnerId,
    partnerOrgAccess: orgAccess,
    orgId: null,
    user: { id: 'user-1', email: 'admin@example.test' },
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
  };
}

function orgAuth() {
  return { ...partnerAuth(), scope: 'organization', orgId: ORG_ID, partnerOrgAccess: null };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    provider: 'connectwise',
    name: 'Manage',
    credentials: { encrypted: 'x' },
    alertTicketing: null,
    alertTicketingRev: 3,
    alertTicketingEnabledAt: null,
    alertTicketingPausedReason: null,
    alertTicketingPausedAt: null,
    ...overrides,
  };
}

const BOUND = { serviceManagementMode: 'external', serviceManagementPsaConnectionId: CONNECTION_ID };

/** Queue: the connection read, then the partner binding read. */
function mockLoad(connection: Record<string, unknown> | null, binding: Record<string, unknown> = BOUND) {
  h.selectMock
    .mockReturnValueOnce(h.chain(connection ? [connection] : []) as never)
    .mockReturnValueOnce(h.chain([binding]) as never);
}

const enabledConfig = { enabled: true, boardId: 12, openStatusId: 101, closedStatusId: 109 };

let app: Hono;

beforeEach(() => {
  h.selectMock.mockReset();
  h.selectMock.mockImplementation(() => h.chain([]));
  h.updateMock.mockReset();
  h.updateMock.mockImplementation(() => h.chain([]));
  h.createPSAProviderMock.mockReset();
  h.decryptCredentialsMock.mockReset();
  h.decryptCredentialsMock.mockReturnValue(CREDENTIALS);
  h.writeRouteAuditMock.mockReset();
  h.gates.permissionDeny = false;
  h.gates.mfaDeny = false;
  h.authState.current = partnerAuth();
  app = new Hono();
  app.route('/psa/connections', psaAlertTicketingRoutes);
  if (psaTicketMappingActionRoutes) app.route('/psa', psaTicketMappingActionRoutes);
  h.wakeMock.mockReset();
  h.wakeMock.mockResolvedValue(undefined);
});

const url = `/psa/connections/${CONNECTION_ID}/alert-ticketing`;

function put(body: unknown) {
  return app.request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('GET /psa/connections/:id/alert-ticketing', () => {
  it('refuses org-scope sessions', async () => {
    h.authState.current = orgAuth();
    expect((await app.request(url)).status).toBe(403);
    expect(h.selectMock).not.toHaveBeenCalled();
  });

  it('404s an unknown id, a malformed id, and another partner\'s connection', async () => {
    mockLoad(null);
    expect((await app.request(url)).status).toBe(404);
    expect((await app.request('/psa/connections/not-a-uuid/alert-ticketing')).status).toBe(404);
    mockLoad(row({ partnerId: OTHER_PARTNER_ID }));
    expect((await app.request(url)).status).toBe(404);
  });

  it('refuses an org-owned connection (only the partner PSA auto-tickets)', async () => {
    mockLoad(row({ orgId: ORG_ID, partnerId: null }));
    const res = await app.request(url);
    expect(res.status).toBe(403);
  });

  it('returns the config, resolver status and binding without the stored fingerprint', async () => {
    mockLoad(row({ alertTicketing: { ...enabledConfig, companyLinksConfirmedFor: INSTANCE_KEY }, alertTicketingRev: 5 }));
    const res = await app.request(url);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      connectionId: CONNECTION_ID,
      provider: 'connectwise',
      capable: true,
      rev: 5,
      status: { active: true },
      bound: true,
      serviceManagementMode: 'external',
      companyLinksConfirmed: true,
      canManage: true,
      config: { enabled: true, boardId: 12, minSeverity: 'low', hourlyCreateCap: 100 },
    });
    expect(data.config).not.toHaveProperty('companyLinksConfirmedFor');
    expect(JSON.stringify(data)).not.toContain(INSTANCE_KEY);
  });

  it('reports why ticketing is inactive', async () => {
    mockLoad(row({ alertTicketing: { enabled: false, boardId: 7 } }), { serviceManagementMode: 'native', serviceManagementPsaConnectionId: null });
    const { data } = await (await app.request(url)).json();
    expect(data).toMatchObject({ status: { active: false, reason: 'not_external' }, bound: false, config: { boardId: 7 } });
  });

  it('lets a restricted partner user read it, but not manage it', async () => {
    h.authState.current = partnerAuth('selected');
    mockLoad(row());
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect((await res.json()).data.canManage).toBe(false);
  });

  it('reports credentials_unusable when the stored credentials cannot authenticate', async () => {
    h.decryptCredentialsMock.mockReturnValue({ baseUrl: CREDENTIALS.baseUrl, companyId: 'mspco' });
    mockLoad(row({ alertTicketing: { ...enabledConfig, companyLinksConfirmedFor: INSTANCE_KEY } }));
    const { data } = await (await app.request(url)).json();
    expect(data.status).toEqual({ active: false, reason: 'credentials_unusable' });
  });

  it('marks a non-capable provider', async () => {
    mockLoad(row({ provider: 'autotask' }));
    const { data } = await (await app.request(url)).json();
    expect(data).toMatchObject({ capable: false, status: { active: false, reason: 'unsupported_provider' } });
  });
});

describe('PUT /psa/connections/:id/alert-ticketing', () => {
  it('requires full partner org access (403) and writes nothing', async () => {
    h.authState.current = partnerAuth('selected');
    mockLoad(row());
    const res = await put({ config: { enabled: false }, expectedRev: 3 });
    expect(res.status).toBe(403);
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it('requires MFA', async () => {
    h.gates.mfaDeny = true;
    expect((await put({ config: { enabled: false }, expectedRev: 3 })).status).toBe(403);
  });

  it('refuses org-scope sessions', async () => {
    h.authState.current = orgAuth();
    expect((await put({ config: { enabled: false }, expectedRev: 3 })).status).toBe(403);
  });

  it('rejects a body without expectedRev', async () => {
    expect((await put({ config: { enabled: false } })).status).toBe(400);
  });

  it('validates against the provider schema (enabled needs ids; strict keys)', async () => {
    mockLoad(row());
    expect((await put({ config: { enabled: true, boardId: 12 }, expectedRev: 3, confirmCompanyLinks: true })).status).toBe(400);
    mockLoad(row());
    expect((await put({ config: { enabled: false, apiKey: 'x' }, expectedRev: 3 })).status).toBe(400);
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it('refuses a provider that cannot auto-ticket', async () => {
    mockLoad(row({ provider: 'autotask' }));
    expect((await put({ config: { enabled: false }, expectedRev: 3 })).status).toBe(400);
  });

  it('refuses an org-owned connection', async () => {
    mockLoad(row({ orgId: ORG_ID, partnerId: null }));
    expect((await put({ config: { enabled: false }, expectedRev: 3 })).status).toBe(403);
  });

  it('enabling without confirming company links → 422', async () => {
    mockLoad(row());
    const res = await put({ config: enabledConfig, expectedRev: 3 });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('company_links_confirmation_required');
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it('enabling after the PSA instance changed needs a fresh confirmation → 422', async () => {
    mockLoad(row({ alertTicketing: { ...enabledConfig, companyLinksConfirmedFor: 'fp1:test:old-instance' } }));
    expect((await put({ config: enabledConfig, expectedRev: 3 })).status).toBe(422);
  });

  it('a stale expectedRev → 409 with the current rev, nothing written', async () => {
    mockLoad(row({ alertTicketingRev: 4 }));
    const res = await put({ config: { enabled: false }, expectedRev: 3 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'alert_ticketing_rev_conflict', currentRev: 4 });
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it('a concurrent write that wins the CAS → 409', async () => {
    mockLoad(row());
    const updateChain = h.chain([]);
    h.updateMock.mockReturnValueOnce(updateChain as never);
    h.selectMock.mockReturnValueOnce(h.chain([{ rev: 4 }]) as never);
    const res = await put({ config: { enabled: false }, expectedRev: 3 });
    expect(res.status).toBe(409);
    expect((await res.json()).currentRev).toBe(4);
    expect(h.writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('enables with confirmation: stores the fingerprint, stamps enabled_at, bumps rev, audits', async () => {
    mockLoad(row());
    const updateChain = h.chain([row({ alertTicketing: { ...enabledConfig, companyLinksConfirmedFor: INSTANCE_KEY }, alertTicketingRev: 4, alertTicketingEnabledAt: new Date() })]);
    h.updateMock.mockReturnValueOnce(updateChain as never);

    const res = await put({ config: enabledConfig, expectedRev: 3, confirmCompanyLinks: true });

    expect(res.status).toBe(200);
    const values = updateChain.set.mock.calls[0]![0];
    expect(values.alertTicketing).toMatchObject({ ...enabledConfig, companyLinksConfirmedFor: INSTANCE_KEY, minSeverity: 'low' });
    expect(values.alertTicketingEnabledAt).toBeInstanceOf(Date);
    expect(values.alertTicketingRev).toBeDefined();
    expect(h.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'psa.alert_ticketing.update',
      resourceType: 'psa_connection',
      resourceId: CONNECTION_ID,
      orgId: null,
      details: expect.objectContaining({ enabled: true, previousEnabled: false, confirmCompanyLinks: true, partnerId: PARTNER_ID }),
    }));
    const { data } = await res.json();
    expect(data).toMatchObject({ rev: 4, status: { active: true } });
  });

  it('keeps enabled_at while staying enabled, and clears it on disable, keeping the confirmation', async () => {
    const enabledAt = new Date('2026-10-01T00:00:00Z');
    const stored = { ...enabledConfig, companyLinksConfirmedFor: INSTANCE_KEY };

    mockLoad(row({ alertTicketing: stored, alertTicketingEnabledAt: enabledAt }));
    const editChain = h.chain([row({ alertTicketing: stored, alertTicketingRev: 4, alertTicketingEnabledAt: enabledAt })]);
    h.updateMock.mockReturnValueOnce(editChain as never);
    expect((await put({ config: { ...enabledConfig, hourlyCreateCap: 50 }, expectedRev: 3 })).status).toBe(200);
    expect(editChain.set.mock.calls[0]![0].alertTicketingEnabledAt).toBe(enabledAt);

    mockLoad(row({ alertTicketing: stored, alertTicketingEnabledAt: enabledAt }));
    const disableChain = h.chain([row({ alertTicketingRev: 4 })]);
    h.updateMock.mockReturnValueOnce(disableChain as never);
    expect((await put({ config: { ...enabledConfig, enabled: false }, expectedRev: 3 })).status).toBe(200);
    const values = disableChain.set.mock.calls[0]![0];
    expect(values.alertTicketingEnabledAt).toBeNull();
    expect(values.alertTicketing.companyLinksConfirmedFor).toBe(INSTANCE_KEY);
  });

  it('the CAS update is predicated on the expected rev and bumps it by one', async () => {
    mockLoad(row());
    const updateChain = h.chain([row({ alertTicketingRev: 4 })]);
    h.updateMock.mockReturnValueOnce(updateChain as never);
    expect((await put({ config: { enabled: false }, expectedRev: 3 })).status).toBe(200);
    const dialect = new PgDialect();
    const where = dialect.sqlToQuery(updateChain.where.mock.calls[0]![0]);
    expect(where.sql).toContain('"alert_ticketing_rev" = $');
    expect(where.params).toEqual(expect.arrayContaining([CONNECTION_ID, 3]));
    const bump = dialect.sqlToQuery(updateChain.set.mock.calls[0]![0].alertTicketingRev);
    expect(bump.sql).toBe('"psa_connections"."alert_ticketing_rev" + 1');
  });

  it('confirming company links while disabled stores the fingerprint', async () => {
    mockLoad(row());
    const updateChain = h.chain([row({ alertTicketingRev: 4 })]);
    h.updateMock.mockReturnValueOnce(updateChain as never);
    expect((await put({ config: { enabled: false, boardId: 12 }, expectedRev: 3, confirmCompanyLinks: true })).status).toBe(200);
    const values = updateChain.set.mock.calls[0]![0];
    expect(values.alertTicketing).toMatchObject({ enabled: false, boardId: 12, companyLinksConfirmedFor: INSTANCE_KEY });
    expect(values.alertTicketingEnabledAt).toBeNull();
  });

  it('a prior confirmation survives a stored blob that no longer parses', async () => {
    mockLoad(row({ alertTicketing: { enabled: true, boardId: 'corrupt', companyLinksConfirmedFor: INSTANCE_KEY } }));
    const updateChain = h.chain([row({ alertTicketingRev: 4 })]);
    h.updateMock.mockReturnValueOnce(updateChain as never);
    expect((await put({ config: enabledConfig, expectedRev: 3 })).status).toBe(200);
    expect(updateChain.set.mock.calls[0]![0].alertTicketing.companyLinksConfirmedFor).toBe(INSTANCE_KEY);
  });

  it('refuses to confirm company links on a connection with no usable base URL', async () => {
    h.decryptCredentialsMock.mockReturnValue({ companyId: 'mspco' });
    mockLoad(row());
    expect((await put({ config: enabledConfig, expectedRev: 3, confirmCompanyLinks: true })).status).toBe(400);
  });
});

describe('GET /psa/connections/:id/alert-ticketing/options', () => {
  const optionsUrl = `${url}/options`;

  function capableClient(overrides: Record<string, unknown> = {}) {
    return {
      alertTicketLimits: { summaryMaxCodePoints: 100, summaryMarkerSuffix: () => null },
      createAlertTicket: vi.fn(),
      closeTicket: vi.fn(),
      addNote: vi.fn(),
      findTicketsByMarker: vi.fn(),
      listBoards: vi.fn(async () => ({ options: [{ id: 12, name: 'Help Desk' }], truncated: false })),
      listPriorities: vi.fn(async () => ({ options: [{ id: 3, name: 'P3' }], truncated: false })),
      listStatuses: vi.fn(async () => ({ options: [{ id: 101, name: 'New', closed: false }], truncated: false })),
      ...overrides,
    };
  }

  it('requires full partner org access', async () => {
    h.authState.current = partnerAuth('selected');
    mockLoad(row());
    expect((await app.request(optionsUrl)).status).toBe(403);
    expect(h.createPSAProviderMock).not.toHaveBeenCalled();
  });

  it('lists boards and priorities through the adapter, statuses only for a board', async () => {
    const client = capableClient();
    h.createPSAProviderMock.mockReturnValue(client);
    mockLoad(row());
    const res = await app.request(optionsUrl);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      boards: { options: [{ id: 12, name: 'Help Desk' }], truncated: false },
      priorities: { options: [{ id: 3, name: 'P3' }], truncated: false },
      statuses: null,
    });
    expect(client.listStatuses).not.toHaveBeenCalled();

    mockLoad(row());
    const withBoard = await app.request(`${optionsUrl}?boardId=12`);
    expect((await withBoard.json()).data.statuses.options).toEqual([{ id: 101, name: 'New', closed: false }]);
    expect(client.listStatuses).toHaveBeenCalledWith(12);
  });

  it('rejects a malformed boardId', async () => {
    expect((await app.request(`${optionsUrl}?boardId=abc`)).status).toBe(400);
  });

  it('400s a provider without the capability', async () => {
    h.createPSAProviderMock.mockReturnValue({ testConnection: vi.fn() });
    mockLoad(row());
    expect((await app.request(optionsUrl)).status).toBe(400);
  });

  it('passes Retry-After through for a rate-limited PSA', async () => {
    h.createPSAProviderMock.mockReturnValue(capableClient({
      listBoards: vi.fn(async () => {
        throw new PsaAdapterError({ provider: 'connectwise', errorClass: 'rate_limited', httpStatus: 429, retryAfterMs: 30_000, message: 'ConnectWise API error (429)' });
      }),
    }));
    mockLoad(row());
    const res = await app.request(optionsUrl);
    expect(res.status).toBe(502);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect((await res.json()).errorClass).toBe('rate_limited');
  });

  it('maps an adapter error to 502 with its class and a scrubbed detail, never the raw message body', async () => {
    h.createPSAProviderMock.mockReturnValue(capableClient({
      listBoards: vi.fn(async () => {
        throw new PsaAdapterError({ provider: 'connectwise', errorClass: 'auth', httpStatus: 401, bodySnippet: 'Invalid credentials', message: 'ConnectWise API error (401)' });
      }),
    }));
    mockLoad(row());
    const res = await app.request(optionsUrl);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'ConnectWise API error (401)', errorClass: 'auth', detail: 'Invalid credentials' });
  });
});

const MAPPING_ID = '55555555-5555-4555-8555-555555555555';
function post(path: string, body: unknown = {}) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function loadMapping(createState = 'needs_attention', snapshot: unknown = {}) {
  h.selectMock.mockReturnValueOnce(h.chain([{ id: MAPPING_ID, connectionId: CONNECTION_ID, createState, createSnapshot: snapshot }]) as never);
  mockLoad(row());
}
const actionUrl = `/psa/ticket-mappings/${MAPPING_ID}`;
describe('human alert-ticket actions', () => {
  it('redrives only the named terminal states, audits and wakes each claimed row', async () => {
    mockLoad(row());
    const update = h.chain([{ id: MAPPING_ID }]); h.updateMock.mockReturnValueOnce(update);
    const res = await post(`${url}/redrive`, { states: ['failed'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { count: 1 } });
    const q = new PgDialect().sqlToQuery(update.where.mock.calls[0][0]);
    expect(q.params).toContain('failed'); expect(q.params).not.toContain('skipped_no_company');
    expect(q.params).toContain(CONNECTION_ID);
    expect(q.sql).toContain('lease_until');
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ createState: 'never_attempted', deadlineAt: expect.any(Date) }));
    expect(h.wakeMock).toHaveBeenCalledWith(MAPPING_ID, 'create');
    expect(h.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'psa.alert_ticketing.redrive' }));
  });
  it.each([{ states: [] }, { states: ['created'] }, { states: ['needs_attention'] }])('rejects invalid redrive states %j', async ({ states }) => {
    expect((await post(`${url}/redrive`, { states })).status).toBe(400);
    expect(h.updateMock).not.toHaveBeenCalled();
  });
  it('create anyway atomically consumes a durable marker and rejects a concurrent click', async () => {
    loadMapping();
    const update = h.chain([{ id: MAPPING_ID, createState: 'never_attempted' }]);
    h.updateMock.mockReturnValueOnce(update);
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(200);
    const q = new PgDialect().sqlToQuery(update.where.mock.calls[0][0]);
    expect(q.params).toContain('needs_attention');
    expect(q.sql).toContain('createAnywayUsed');
    const values = update.set.mock.calls[0][0];
    expect(values.createState).toBe('never_attempted');
    expect(new PgDialect().sqlToQuery(values.createSnapshot).sql).toContain('createAnywayUsed');
    loadMapping(); h.updateMock.mockReturnValueOnce(h.chain([]));
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(409);
    expect(h.wakeMock).toHaveBeenCalledTimes(1);
  });
  it('allows only one additional remote create across repeated unknown outcomes', async () => {
    const { harness, adapterError } = await import('../services/psaAlertTicketing/testHarness');
    const f = harness();
    f.ctx.mapping.id = MAPPING_ID; f.ctx.mapping.connectionId = CONNECTION_ID;
    f.adapter.createAlertTicket.mockRejectedValue(adapterError('unknown_outcome'));
    f.adapter.findTicketsByMarker.mockResolvedValue([]);
    await f.run(); f.advance(7200001); await f.run();
    expect(f.ctx.mapping.createState).toBe('needs_attention');
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
    h.selectMock.mockReturnValueOnce(h.chain([f.ctx.mapping]) as never); mockLoad(row());
    h.updateMock.mockImplementationOnce(() => ({ set: (values: Record<string, any>) => ({
      where: (predicate: never) => ({ returning: async () => {
        const query = new PgDialect().sqlToQuery(predicate);
        if (!query.params.includes(f.ctx.mapping.createState) || f.ctx.mapping.createSnapshot?.createAnywayUsed) return [];
        expect(query.sql).toContain('createAnywayUsed');
        expect(new PgDialect().sqlToQuery(values.createSnapshot).sql).toContain('createAnywayUsed');
        Object.assign(f.ctx.mapping, values, { nextAttemptAt: f.now(),
          createSnapshot: { ...f.ctx.snapshot, createAnywayUsed: true } });
        return [f.ctx.mapping];
      } }),
    }) }) as never);
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(200);
    // The storage regression test verifies this marker survives the fresh snapshot.
    f.ctx.snapshot.createAnywayUsed = f.ctx.mapping.createSnapshot?.createAnywayUsed;
    await f.run(); f.advance(7200001); await f.run();
    expect(f.ctx.mapping.createState).toBe('needs_attention');
    h.selectMock.mockReturnValueOnce(h.chain([f.ctx.mapping]) as never); mockLoad(row());
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(409);
    await f.run();
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(2);
  });
  it('accepts create-anyway with an empty JSON body', async () => {
    loadMapping(); h.updateMock.mockReturnValueOnce(h.chain([{ id: MAPPING_ID }]));
    expect((await app.request(`${actionUrl}/create-anyway`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status).toBe(200);
  });
  it('409s a re-drive when no rows remain in the requested states', async () => {
    mockLoad(row());
    expect((await post(`${url}/redrive`, { states: ['failed'] })).status).toBe(409);
    expect(h.writeRouteAuditMock).not.toHaveBeenCalled(); expect(h.wakeMock).not.toHaveBeenCalled();
  });
  it('refuses another create anyway after a second unknown outcome', async () => {
    loadMapping('needs_attention', { createAnywayUsed: true });
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(409);
    expect(h.updateMock).not.toHaveBeenCalled();
  });
  it.each(['failed', 'skipped_no_company', 'needs_attention'])('marks %s handled with the exact expected state', async createState => {
    loadMapping(createState);
    const update = h.chain([{ id: MAPPING_ID, createState: 'handled' }]); h.updateMock.mockReturnValueOnce(update);
    expect((await post(`${actionUrl}/mark-handled`, { expectedState: createState })).status).toBe(200);
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ createState: 'handled' }));
    expect(new PgDialect().sqlToQuery(update.where.mock.calls[0][0]).params).toContain(createState);
    expect(h.wakeMock).not.toHaveBeenCalled();
    expect(h.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'psa.alert_ticketing.mark_handled' }));
  });
  it('409s stale mark-handled clicks without auditing success', async () => {
    loadMapping('failed');
    expect((await post(`${actionUrl}/mark-handled`, { expectedState: 'failed' })).status).toBe(409);
    expect(h.writeRouteAuditMock).not.toHaveBeenCalled();
  });
  it.each(['permission', 'mfa', 'org', 'site', 'restricted'])('enforces the %s write gate on all actions', async gate => {
    if (gate === 'permission') h.gates.permissionDeny = true;
    if (gate === 'mfa') h.gates.mfaDeny = true;
    if (gate === 'org') h.authState.current = orgAuth();
    if (gate === 'site') h.authState.current = { ...partnerAuth(), allowedSiteIds: [] };
    if (gate === 'restricted') h.authState.current = { ...partnerAuth(), partnerOrgAccess: 'selected' };
    for (const [path, body] of [[`${url}/redrive`, { states: ['failed'] }], [`${actionUrl}/create-anyway`, {}], [`${actionUrl}/mark-handled`, { expectedState: 'failed' }]] as const) {
      if (gate === 'restricted') {
        if (path.includes('/ticket-mappings/')) loadMapping('failed'); else mockLoad(row());
      }
      expect((await post(path, body)).status).toBe(403);
    }
    expect(h.updateMock).not.toHaveBeenCalled();
  });
  it('hides another partner mapping and rejects malformed ids', async () => {
    h.selectMock.mockReturnValueOnce(h.chain([{ id: MAPPING_ID, connectionId: CONNECTION_ID, createState: 'needs_attention' }]) as never);
    mockLoad(row({ partnerId: OTHER_PARTNER_ID }));
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(404);
    expect((await post('/psa/ticket-mappings/not-an-id/create-anyway')).status).toBe(404);
    expect(h.updateMock).not.toHaveBeenCalled();
  });
  it('re-drive keeps the create-anyway marker while clearing the retry window', async () => {
    mockLoad(row());
    const update = h.chain([{ id: MAPPING_ID }]); h.updateMock.mockReturnValueOnce(update);
    expect((await post(`${url}/redrive`, { states: ['failed'] })).status).toBe(200);
    const snapshot = update.set.mock.calls[0][0].createSnapshot;
    expect(snapshot).not.toBeNull();
    const q = new PgDialect().sqlToQuery(snapshot).sql;
    expect(q).toContain("- 'operationAttempts'");
    expect(q).toContain("- 'unknownDeadline'");
    expect(q).not.toContain('createAnywayUsed');
  });
  it('create anyway guards on an unused marker and sets it in the same update', async () => {
    loadMapping();
    const update = h.chain([{ id: MAPPING_ID, createState: 'never_attempted' }]); h.updateMock.mockReturnValueOnce(update);
    expect((await post(`${actionUrl}/create-anyway`)).status).toBe(200);
    expect(new PgDialect().sqlToQuery(update.where.mock.calls[0][0]).sql).toMatch(/'createAnywayUsed', 'false'\) <> 'true'/);
    expect(new PgDialect().sqlToQuery(update.set.mock.calls[0][0].createSnapshot).sql).toContain(`|| '{"createAnywayUsed":true}'::jsonb`);
  });
  it('409s mark-handled when the row is not in the expected state, without updating', async () => {
    loadMapping('created');
    expect((await post(`${actionUrl}/mark-handled`, { expectedState: 'failed' })).status).toBe(409);
    expect(h.updateMock).not.toHaveBeenCalled();
  });
  it('answers a re-drive even when a wake never settles (Redis offline queue)', async () => {
    mockLoad(row()); h.updateMock.mockReturnValueOnce(h.chain([{ id: MAPPING_ID }]));
    h.wakeMock.mockReturnValueOnce(new Promise(() => {}));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post(`${url}/redrive`, { states: ['failed'] })).status).toBe(200);
    expect(warning).toHaveBeenCalled(); warning.mockRestore();
  }, 10_000);
  it('keeps a durable re-drive successful when Redis is unavailable', async () => {
    mockLoad(row()); h.updateMock.mockReturnValueOnce(h.chain([{ id: MAPPING_ID }]));
    h.wakeMock.mockRejectedValueOnce(new Error('offline'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post(`${url}/redrive`, { states: ['failed', 'skipped_no_company'] })).status).toBe(200);
    expect(warning).toHaveBeenCalled(); warning.mockRestore();
  });
});
