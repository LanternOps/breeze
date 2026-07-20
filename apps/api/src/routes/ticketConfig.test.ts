import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks, authRef, permsRef, writeRouteAuditMock } = vi.hoisted(() => ({
  serviceMocks: {
    getTicketConfig: vi.fn(),
    createTicketStatus: vi.fn(),
    updateTicketStatus: vi.fn(),
    reorderTicketStatuses: vi.fn(),
    upsertPrioritySettings: vi.fn(),
    listEmailInboundQueue: vi.fn(),
    convertEmailInbound: vi.fn(),
    dismissEmailInbound: vi.fn(),
    listCustomerEmailDomains: vi.fn(),
    createCustomerEmailDomain: vi.fn(),
    updateCustomerEmailDomain: vi.fn(),
    deleteCustomerEmailDomain: vi.fn(),
  },
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  permsRef: { current: { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'tickets', action: 'read' }] } },
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../services/ticketConfigService', async () => {
  const actual = await vi.importActual<typeof import('../services/ticketConfigService')>('../services/ticketConfigService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    c.set('permissions', permsRef.current);
    await next();
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

import { ticketConfigRoutes } from './ticketConfig';
import { TicketConfigServiceError } from '../services/ticketConfigService';

const ADMIN_PERMS = { permissions: [{ resource: '*', action: '*' }] };
const STATUS_ID = '3f2f1d8e-1111-4222-8333-444455556666';

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  writeRouteAuditMock.mockReset();
  authRef.current.scope = 'partner';
  authRef.current.partnerId = 'p-1';
  authRef.current.partnerOrgAccess = 'all';
  authRef.current.user.isPlatformAdmin = false;
  permsRef.current = { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'tickets', action: 'read' }] };
});

const GLOBAL_ROUTE_CASES: Array<[string, string, unknown?]> = [
  ['GET', '/'],
  ['GET', '/email-inbound'],
  ['POST', '/email-inbound/00000000-0000-0000-0000-000000000001/convert', { orgId: '00000000-0000-0000-0000-0000000000aa' }],
  ['PATCH', '/email-inbound/00000000-0000-0000-0000-000000000001/dismiss'],
  ['GET', '/inbound-domains'],
  ['POST', '/inbound-domains', { domain: 'acme.com', orgId: 'aaaaaaaa-1111-4222-8333-444455556666' }],
  ['PATCH', '/inbound-domains/bbbbbbbb-1111-4222-8333-444455556666', { isActive: false }],
  ['DELETE', '/inbound-domains/bbbbbbbb-1111-4222-8333-444455556666'],
  ['POST', '/statuses', { name: 'Triage', coreStatus: 'open' }],
  ['PATCH', `/statuses/${STATUS_ID}`, { name: 'Updated' }],
  ['POST', '/statuses/reorder', { ids: [STATUS_ID] }],
  ['PUT', '/priorities', { priorities: { high: { label: 'High' } } }],
];

describe('partner-global authorization', () => {
  it.each(
    (['selected', 'none'] as const).flatMap((partnerOrgAccess) =>
      GLOBAL_ROUTE_CASES.map(([method, path, body]) => [partnerOrgAccess, method, path, body] as const)
    )
  )('rejects %s-org wildcard/platform admin before %s %s service or audit work', async (partnerOrgAccess, method, path, body) => {
    authRef.current.partnerOrgAccess = partnerOrgAccess;
    authRef.current.user.isPlatformAdmin = true;
    permsRef.current = ADMIN_PERMS;

    const res = await ticketConfigRoutes.request(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    for (const serviceMock of Object.values(serviceMocks)) {
      expect(serviceMock).not.toHaveBeenCalled();
    }
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('allows system scope with an explicit partner context', async () => {
    authRef.current.scope = 'system';
    authRef.current.partnerOrgAccess = null;
    authRef.current.user.isPlatformAdmin = true;
    permsRef.current = ADMIN_PERMS;
    serviceMocks.getTicketConfig.mockResolvedValue({ statuses: [], priorities: {} });

    const res = await ticketConfigRoutes.request('/');

    expect(res.status).toBe(200);
    expect(serviceMocks.getTicketConfig).toHaveBeenCalledWith('p-1');
  });
});

describe('auth', () => {
  it('401 when unauthenticated', async () => {
    const saved = authRef.current;
    authRef.current = null as unknown as typeof authRef.current;
    const res = await ticketConfigRoutes.request('/');
    expect(res.status).toBe(401);
    authRef.current = saved;
  });
});

describe('GET /', () => {
  it('returns the partner config', async () => {
    serviceMocks.getTicketConfig.mockResolvedValue({ statuses: [{ id: 's-1' }], priorities: {} });
    const res = await ticketConfigRoutes.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { statuses: [{ id: 's-1' }], priorities: {} } });
    expect(serviceMocks.getTicketConfig).toHaveBeenCalledWith('p-1');
  });

  it('403 when partner context is missing', async () => {
    authRef.current.partnerId = null;
    const res = await ticketConfigRoutes.request('/');
    expect(res.status).toBe(403);
  });
});

describe('POST /statuses', () => {
  const create = (body: unknown) =>
    ticketConfigRoutes.request('/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('403 for a non-admin (no wildcard permission)', async () => {
    const res = await create({ name: 'Triage', coreStatus: 'open' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Managing ticket configuration requires an admin role' });
  });

  it('201 for an admin (wildcard permission)', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.createTicketStatus.mockResolvedValue({ id: 's-9', name: 'Triage' });
    const res = await create({ name: 'Triage', coreStatus: 'open' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: 's-9', name: 'Triage' } });
    expect(serviceMocks.createTicketStatus).toHaveBeenCalledWith('p-1', expect.objectContaining({ name: 'Triage', coreStatus: 'open' }));
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null,
      action: 'ticket_status.create',
      resourceType: 'ticket_status',
      resourceId: 's-9',
      resourceName: 'Triage',
      details: expect.objectContaining({
        partnerId: 'p-1',
        changedFields: expect.arrayContaining(['name', 'coreStatus']),
      }),
    }));
  });

  it('201 for a platform admin even without wildcard permission', async () => {
    authRef.current.user.isPlatformAdmin = true;
    serviceMocks.createTicketStatus.mockResolvedValue({ id: 's-9' });
    const res = await create({ name: 'Triage', coreStatus: 'open' });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /statuses/:id', () => {
  it('audits a successful status update with changed fields', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.updateTicketStatus.mockResolvedValue({ id: STATUS_ID, name: 'Waiting' });
    const res = await ticketConfigRoutes.request(`/statuses/${STATUS_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Waiting' }),
    });
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_status.update',
      resourceId: STATUS_ID,
      resourceName: 'Waiting',
      details: { partnerId: 'p-1', changedFields: ['name'] },
    }));
  });

  it('maps a TicketConfigServiceError to its status', async () => {
    permsRef.current = ADMIN_PERMS;
    const { TicketConfigServiceError } = await vi.importActual<typeof import('../services/ticketConfigService')>('../services/ticketConfigService');
    serviceMocks.updateTicketStatus.mockRejectedValue(new TicketConfigServiceError('Status not found', 404, 'STATUS_NOT_FOUND'));
    const res = await ticketConfigRoutes.request(`/statuses/${STATUS_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Status not found', code: 'STATUS_NOT_FOUND' });
  });

  it('400 on an empty update body (validator refine)', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request(`/statuses/${STATUS_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /statuses/reorder', () => {
  it('400 on duplicate ids (validator refine)', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request('/statuses/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [STATUS_ID, STATUS_ID] }),
    });
    expect(res.status).toBe(400);
  });

  it('200 and returns the update count', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.reorderTicketStatuses.mockResolvedValue({ updated: 1 });
    const res = await ticketConfigRoutes.request('/statuses/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [STATUS_ID] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 1 } });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_status.reorder',
      resourceId: 'p-1',
      details: { partnerId: 'p-1', statusIds: [STATUS_ID], changedFields: ['sortOrder'] },
    }));
  });
});

describe('PUT /priorities', () => {
  it('200 for an admin and returns priorities', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.upsertPrioritySettings.mockResolvedValue({ high: { label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 } });
    const res = await ticketConfigRoutes.request('/priorities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priorities: { high: { label: 'High', responseSlaMinutes: 30 } } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { priorities: { high: { label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 } } } });
    expect(serviceMocks.upsertPrioritySettings).toHaveBeenCalledWith('p-1', expect.objectContaining({ priorities: expect.any(Object) }));
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_priority_settings.update',
      resourceId: 'p-1',
      details: { partnerId: 'p-1', changedFields: ['priorities'] },
    }));
  });

  it('403 for a non-admin', async () => {
    const res = await ticketConfigRoutes.request('/priorities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priorities: { high: { label: 'High' } } }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /ticket-config/email-inbound', () => {
  it('403 when not admin (default tickets-only perms)', async () => {
    const res = await ticketConfigRoutes.request('/email-inbound');
    expect(res.status).toBe(403);
  });
  it('403 when no partner context', async () => {
    permsRef.current = ADMIN_PERMS;
    authRef.current.user.isPlatformAdmin = true;
    authRef.current.partnerId = null;
    const res = await ticketConfigRoutes.request('/email-inbound');
    expect(res.status).toBe(403);
  });
  it('returns the paginated queue for an admin partner user', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.listEmailInboundQueue.mockResolvedValue({ data: [{ id: 'r-1', parseStatus: 'quarantined' }], pagination: { page: 1, limit: 50, total: 1 } });
    const res = await ticketConfigRoutes.request('/email-inbound');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].id).toBe('r-1');
    expect(serviceMocks.listEmailInboundQueue).toHaveBeenCalledWith('p-1', { page: 1, limit: 50 });
  });
});

const INBOUND_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '00000000-0000-0000-0000-0000000000aa';

describe('POST /ticket-config/email-inbound/:id/convert', () => {
  it('403 for non-admin (default perms)', async () => {
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });
  it('400 when orgId is missing/not a uuid', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
  it('converts and forwards the authenticated admin as the actor', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.convertEmailInbound.mockResolvedValue({ id: 'r-1', parseStatus: 'created', ticketId: 't-9' });
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.convertEmailInbound).toHaveBeenCalledWith('p-1', INBOUND_ID, ORG_ID, { userId: 'u-1', name: 'Tess Tech' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_email_inbound.convert',
      resourceId: INBOUND_ID,
      details: {
        partnerId: 'p-1',
        orgId: ORG_ID,
        ticketId: 't-9',
        changedFields: ['parseStatus', 'ticketId'],
      },
    }));
    expect(JSON.stringify(writeRouteAuditMock.mock.calls[0]?.[1])).not.toContain('mail body');
  });
  it('surfaces ORG_NOT_ACCESSIBLE as 400 with code', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.convertEmailInbound.mockRejectedValue(new TicketConfigServiceError('no', 400, 'ORG_NOT_ACCESSIBLE'));
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ORG_NOT_ACCESSIBLE');
  });
  it('surfaces INBOUND_ROW_NO_SENDER as 400 with code', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.convertEmailInbound.mockRejectedValue(new TicketConfigServiceError('no sender', 400, 'INBOUND_ROW_NO_SENDER'));
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INBOUND_ROW_NO_SENDER');
  });
});

describe('PATCH /ticket-config/email-inbound/:id/dismiss', () => {
  it('dismisses and returns the row', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.dismissEmailInbound.mockResolvedValue({ id: 'r-1', parseStatus: 'ignored' });
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/dismiss`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(serviceMocks.dismissEmailInbound).toHaveBeenCalledWith('p-1', INBOUND_ID);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_email_inbound.dismiss',
      resourceId: INBOUND_ID,
      details: { partnerId: 'p-1', changedFields: ['parseStatus'] },
    }));
  });
  it('surfaces INBOUND_ROW_ALREADY_RESOLVED as 409', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.dismissEmailInbound.mockRejectedValue(new TicketConfigServiceError('done', 409, 'INBOUND_ROW_ALREADY_RESOLVED'));
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/dismiss`, { method: 'PATCH' });
    expect(res.status).toBe(409);
  });
});

describe('inbound-domains routes (Phase 5)', () => {
  const ORG_ID = 'aaaaaaaa-1111-4222-8333-444455556666';
  const MAP_ID = 'bbbbbbbb-1111-4222-8333-444455556666';

  it('GET 403 for a non-admin', async () => {
    const res = await ticketConfigRoutes.request('/inbound-domains');
    expect(res.status).toBe(403);
  });

  it('GET 200 lists mappings for an admin', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.listCustomerEmailDomains.mockResolvedValue([
      { id: MAP_ID, domain: 'acme.com', orgId: ORG_ID, orgName: 'ACME', autoCreateContact: true, isActive: true },
    ]);
    const res = await ticketConfigRoutes.request('/inbound-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: MAP_ID, domain: 'acme.com', orgId: ORG_ID, orgName: 'ACME', autoCreateContact: true, isActive: true }] });
    expect(serviceMocks.listCustomerEmailDomains).toHaveBeenCalledWith('p-1');
  });

  it('POST 403 for a non-admin', async () => {
    const res = await ticketConfigRoutes.request('/inbound-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com', orgId: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('POST 200 creates a mapping for an admin', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.createCustomerEmailDomain.mockResolvedValue({ id: MAP_ID, domain: 'acme.com' });
    const res = await ticketConfigRoutes.request('/inbound-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'ACME.com', orgId: ORG_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: MAP_ID, domain: 'acme.com' } });
    // domain lowercased by the validator; actor.userId threaded from auth.
    expect(serviceMocks.createCustomerEmailDomain).toHaveBeenCalledWith(
      'p-1',
      expect.objectContaining({ domain: 'acme.com', orgId: ORG_ID }),
      { userId: 'u-1' },
    );
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_customer_email_domain.create',
      resourceId: MAP_ID,
      resourceName: 'acme.com',
      details: expect.objectContaining({
        partnerId: 'p-1',
        orgId: ORG_ID,
        changedFields: expect.arrayContaining(['domain', 'orgId']),
      }),
    }));
  });

  it('POST 400 for a freemail domain (validator rejects before the service)', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request('/inbound-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'gmail.com', orgId: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect(serviceMocks.createCustomerEmailDomain).not.toHaveBeenCalled();
  });

  it('POST maps ORG_NOT_ACCESSIBLE to 400 (cross-partner org IDOR)', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.createCustomerEmailDomain.mockRejectedValue(
      new TicketConfigServiceError('That organization is not in your partner', 400, 'ORG_NOT_ACCESSIBLE'),
    );
    const res = await ticketConfigRoutes.request('/inbound-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com', orgId: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ORG_NOT_ACCESSIBLE' });
  });

  it('PATCH maps a not-found mapping to 404', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.updateCustomerEmailDomain.mockRejectedValue(
      new TicketConfigServiceError('Domain mapping not found', 404, 'DOMAIN_MAPPING_NOT_FOUND'),
    );
    const res = await ticketConfigRoutes.request(`/inbound-domains/${MAP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH 200 audits mapping identifiers and changed fields', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.updateCustomerEmailDomain.mockResolvedValue({ id: MAP_ID, domain: 'acme.com', orgId: ORG_ID, isActive: false });
    const res = await ticketConfigRoutes.request(`/inbound-domains/${MAP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_customer_email_domain.update',
      resourceId: MAP_ID,
      resourceName: 'acme.com',
      details: { partnerId: 'p-1', changedFields: ['isActive'] },
    }));
  });

  it('DELETE 200 for an admin', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.deleteCustomerEmailDomain.mockResolvedValue(undefined);
    const res = await ticketConfigRoutes.request(`/inbound-domains/${MAP_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(serviceMocks.deleteCustomerEmailDomain).toHaveBeenCalledWith('p-1', MAP_ID);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_customer_email_domain.delete',
      resourceId: MAP_ID,
      details: { partnerId: 'p-1', changedFields: ['deleted'] },
    }));
  });

  it('DELETE maps a not-found mapping to 404', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.deleteCustomerEmailDomain.mockRejectedValue(
      new TicketConfigServiceError('Domain mapping not found', 404, 'DOMAIN_MAPPING_NOT_FOUND'),
    );
    const res = await ticketConfigRoutes.request(`/inbound-domains/${MAP_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
