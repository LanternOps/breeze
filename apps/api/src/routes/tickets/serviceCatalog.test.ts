import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, svc, writeRouteAuditMock, mfaGate, scopeArgs, permArgs } = vi.hoisted(() => ({
  authRef: {
    current: null as null | Record<string, unknown>,
  },
  svc: {
    getCatalog: vi.fn(),
    getOrCreateCatalog: vi.fn(),
    updateCatalog: vi.fn(),
    listItems: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    archiveItem: vi.fn(),
  },
  writeRouteAuditMock: vi.fn(),
  mfaGate: vi.fn(),
  scopeArgs: [] as string[][],
  permArgs: [] as string[][],
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/serviceCatalogService', async () => {
  const actual = await vi.importActual<typeof import('../../services/serviceCatalogService')>('../../services/serviceCatalogService');
  return { ...actual, ...svc };
});
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    c.set('permissions', (authRef.current as any).__perms);
    await next();
  }),
  requireScope: (...s: string[]) => {
    scopeArgs.push(s);
    return async (c: any, next: any) => {
      if (!s.includes((c.get('auth') as any).scope)) return c.json({ error: 'scope' }, 403);
      await next();
    };
  },
  requirePermission: (r: string, a: string) => {
    permArgs.push([r, a]);
    return async (_c: any, next: any) => next();
  },
  requireMfa: () => async (_c: any, next: any) => {
    mfaGate();
    await next();
  },
}));

import { serviceCatalogRoutes } from './serviceCatalog';
import { ServiceCatalogError } from '../../services/serviceCatalogService';

const ID = '3f2f1d8e-1111-4222-8333-444455556666';
const WRITE_PERMS = { permissions: [{ resource: 'tickets', action: 'write' }], partnerId: 'p-1', orgId: null, roleId: 'r', scope: 'partner' };
const READ_PERMS = { permissions: [{ resource: 'tickets', action: 'read' }], partnerId: 'p-1', orgId: null, roleId: 'r', scope: 'partner' };

function app() {
  const a = new Hono();
  a.route('/', serviceCatalogRoutes);
  return a;
}
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const item = (over: Record<string, unknown> = {}) => ({ id: ID, catalogId: 'c-1', partnerId: 'p-1', orgId: null, name: 'Patching', isActive: true, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { scope: 'partner', partnerId: 'p-1', partnerOrgAccess: 'all', orgId: null, user: { id: 'u-1' }, __perms: WRITE_PERMS };
});

describe('auth and gates', () => {
  it('401s when unauthenticated', async () => {
    authRef.current = null;
    expect((await app().request('/service-catalog')).status).toBe(401);
  });
  it('registers partner/system scope only, with TICKETS_READ/WRITE', () => {
    expect(scopeArgs.every((s) => s.join() === 'partner,system')).toBe(true);
    expect(permArgs.some((p) => p.join() === 'tickets,read')).toBe(true);
    expect(permArgs.some((p) => p.join() === 'tickets,write')).toBe(true);
  });
  it('blocks organization-scope tokens', async () => {
    authRef.current = { ...authRef.current!, scope: 'organization' };
    expect((await app().request('/service-catalog/items')).status).toBe(403);
    expect(svc.listItems).not.toHaveBeenCalled();
  });
  it('403s all four write routes without full partner org access, and never writes', async () => {
    authRef.current = { ...authRef.current!, partnerOrgAccess: 'selected' };
    const calls: [string, string, unknown?][] = [
      ['PUT', '/service-catalog', { name: 'n' }],
      ['POST', '/service-catalog/items', { name: 'n' }],
      ['PATCH', `/service-catalog/items/${ID}`, { name: 'n' }],
      ['DELETE', `/service-catalog/items/${ID}`],
    ];
    for (const [m, p, b] of calls) {
      expect((await app().request(p, json(m, b))).status).toBe(403);
    }
    expect(svc.updateCatalog).not.toHaveBeenCalled();
    expect(svc.createItem).not.toHaveBeenCalled();
    expect(svc.updateItem).not.toHaveBeenCalled();
    expect(svc.archiveItem).not.toHaveBeenCalled();
  });
  it('403s a system token without a partner', async () => {
    authRef.current = { ...authRef.current!, scope: 'system', partnerId: null };
    expect((await app().request('/service-catalog/items', json('POST', { name: 'n' }))).status).toBe(403);
    expect((await app().request('/service-catalog/items')).status).toBe(403);
  });
  it('runs the MFA gate on writes', async () => {
    svc.createItem.mockResolvedValue(item());
    await app().request('/service-catalog/items', json('POST', { name: 'n' }));
    expect(mfaGate).toHaveBeenCalled();
  });
});

describe('GET /service-catalog (D1)', () => {
  it('get-or-creates for a writer and audits only on creation', async () => {
    svc.getOrCreateCatalog.mockResolvedValue({ catalog: { id: 'c-1', name: 'Service Catalog' }, created: true });
    const res = await app().request('/service-catalog');
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog.create', orgId: null }));
    writeRouteAuditMock.mockClear();
    svc.getOrCreateCatalog.mockResolvedValue({ catalog: { id: 'c-1' }, created: false });
    await app().request('/service-catalog');
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
  it('never creates for a reader without write permission', async () => {
    authRef.current = { ...authRef.current!, __perms: READ_PERMS };
    svc.getCatalog.mockResolvedValue(null);
    const res = await app().request('/service-catalog');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toBeNull();
    expect(svc.getOrCreateCatalog).not.toHaveBeenCalled();
  });
  it('never creates for a writer without the partner-wide gate', async () => {
    authRef.current = { ...authRef.current!, partnerOrgAccess: 'selected' };
    svc.getCatalog.mockResolvedValue(null);
    await app().request('/service-catalog');
    expect(svc.getOrCreateCatalog).not.toHaveBeenCalled();
  });
});

describe('PUT /service-catalog', () => {
  it('updates and audits with orgId null', async () => {
    svc.updateCatalog.mockResolvedValue({ id: 'c-1', name: 'New' });
    const res = await app().request('/service-catalog', json('PUT', { name: 'New' }));
    expect(res.status).toBe(200);
    expect(svc.updateCatalog).toHaveBeenCalledWith('p-1', { name: 'New' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog.update', orgId: null }));
  });
  it('400s ownership fields', async () => {
    const res = await app().request('/service-catalog', json('PUT', { partnerId: 'x' }));
    expect(res.status).toBe(400);
    expect(svc.updateCatalog).not.toHaveBeenCalled();
  });
});

describe('POST /service-catalog/items', () => {
  it('derives the partner from auth and returns 201', async () => {
    svc.createItem.mockResolvedValue(item());
    const res = await app().request('/service-catalog/items', json('POST', { name: ' Patching ', pillar: 'Infra' }));
    expect(res.status).toBe(201);
    expect(svc.createItem).toHaveBeenCalledWith('p-1', expect.objectContaining({ name: 'Patching', pillar: 'Infra', isActive: true }));
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog_item.create', orgId: null }));
  });
  it.each(['partnerId', 'orgId', 'catalogId', 'ownerScope'])('400s body key %s', async (k) => {
    const res = await app().request('/service-catalog/items', json('POST', { name: 'n', [k]: ID }));
    expect(res.status).toBe(400);
    expect(svc.createItem).not.toHaveBeenCalled();
  });
  it('400s blank name and serviceLine without pillar', async () => {
    expect((await app().request('/service-catalog/items', json('POST', { name: '  ' }))).status).toBe(400);
    expect((await app().request('/service-catalog/items', json('POST', { name: 'n', serviceLine: 'L' }))).status).toBe(400);
    expect(svc.createItem).not.toHaveBeenCalled();
  });
  it('maps unexpected 23514 to 400', async () => {
    svc.createItem.mockRejectedValue(Object.assign(new Error('check'), { code: '23514' }));
    const res = await app().request('/service-catalog/items', json('POST', { name: 'n' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });
  it('rethrows unknown errors as 500', async () => {
    svc.createItem.mockRejectedValue(new Error('boom'));
    const res = await app().request('/service-catalog/items', json('POST', { name: 'n' }));
    expect(res.status).toBe(500);
  });
});

describe('GET items', () => {
  it('lists with parsed filters', async () => {
    svc.listItems.mockResolvedValue([item()]);
    const res = await app().request('/service-catalog/items?includeArchived=true&pillar=Infra');
    expect(res.status).toBe(200);
    expect(svc.listItems).toHaveBeenCalledWith('p-1', { includeArchived: true, pillar: 'Infra' });
  });
  it('404s an item outside the partner', async () => {
    svc.getItem.mockResolvedValue(null);
    const res = await app().request(`/service-catalog/items/${ID}`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(svc.getItem).toHaveBeenCalledWith('p-1', ID);
  });
  it('400s a non-guid id', async () => {
    expect((await app().request('/service-catalog/items/nope')).status).toBe(400);
  });
});

describe('PATCH item', () => {
  it('audits update when isActive is unchanged', async () => {
    svc.updateItem.mockResolvedValue({ before: item(), after: item({ name: 'B' }) });
    const res = await app().request(`/service-catalog/items/${ID}`, json('PATCH', { name: 'B' }));
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog_item.update' }));
  });
  it('audits archive / restore on isActive transitions', async () => {
    svc.updateItem.mockResolvedValue({ before: item(), after: item({ isActive: false }) });
    await app().request(`/service-catalog/items/${ID}`, json('PATCH', { isActive: false }));
    expect(writeRouteAuditMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog_item.archive' }));
    svc.updateItem.mockResolvedValue({ before: item({ isActive: false }), after: item() });
    await app().request(`/service-catalog/items/${ID}`, json('PATCH', { isActive: true }));
    expect(writeRouteAuditMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog_item.restore' }));
  });
  it('404s unknown item and 400s ownership keys', async () => {
    svc.updateItem.mockResolvedValue(null);
    expect((await app().request(`/service-catalog/items/${ID}`, json('PATCH', { name: 'B' }))).status).toBe(404);
    expect((await app().request(`/service-catalog/items/${ID}`, json('PATCH', { partnerId: ID }))).status).toBe(400);
  });
  it('400s when the resulting state breaks grouping', async () => {
    svc.updateItem.mockRejectedValue(new ServiceCatalogError('serviceLine requires a pillar', 'serviceLine'));
    const res = await app().request(`/service-catalog/items/${ID}`, json('PATCH', { pillar: null }));
    expect(res.status).toBe(400);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
});

describe('DELETE item (archive)', () => {
  it('archives and audits once; repeat is 200 without audit', async () => {
    svc.archiveItem.mockResolvedValue({ item: item({ isActive: false }), changed: true });
    let res = await app().request(`/service-catalog/items/${ID}`, json('DELETE'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.isActive).toBe(false);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'service_catalog_item.archive', orgId: null }));
    writeRouteAuditMock.mockClear();
    svc.archiveItem.mockResolvedValue({ item: item({ isActive: false }), changed: false });
    res = await app().request(`/service-catalog/items/${ID}`, json('DELETE'));
    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
  it('404s unknown item', async () => {
    svc.archiveItem.mockResolvedValue(null);
    expect((await app().request(`/service-catalog/items/${ID}`, json('DELETE'))).status).toBe(404);
  });
});
