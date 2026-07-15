import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { servicePrincipalRoutes } from './servicePrincipals';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRINCIPAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  servicePrincipals: { id: 'id', orgId: 'orgId', status: 'status', createdAt: 'createdAt' }
}));

vi.mock('../services/servicePrincipals', () => {
  class ServicePrincipalNotFoundError extends Error {}
  class ApiKeyNotFoundError extends Error {}
  return {
    createServicePrincipal: vi.fn(),
    rotateServicePrincipalKey: vi.fn(),
    disableServicePrincipal: vi.fn(),
    migrateHumanKeyToServicePrincipal: vi.fn(),
    ServicePrincipalNotFoundError,
    ApiKeyNotFoundError
  };
});

// Mutable switch for the requirePermission mock so individual tests can
// simulate a caller whose role LACKS the gated permission (the real
// middleware 403s). Hoisted because the vi.mock factory below references it.
// Reset to granted in beforeEach. This is what proves guard-bite (c): the
// migrate-key route actually runs through requirePermission, not a rubber
// stamp — flip this to false and the 403 assertion goes RED.
// `permissions` mirrors what the real requirePermission sets via
// c.set('permissions', ...). Default is an all-permissions caller (wildcard)
// with no site restriction, so the scope-delegation ceiling passes for the
// happy path; individual tests narrow it to exercise the ceiling.
const permissionMockState = vi.hoisted(() => ({
  granted: true,
  permissions: {
    permissions: [{ resource: '*', action: '*' }],
    partnerId: null,
    orgId: null,
    roleId: 'role-1',
    scope: 'organization',
    allowedSiteIds: undefined,
  } as any,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!permissionMockState.granted) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    c.set('permissions', permissionMockState.permissions);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
  createServicePrincipal,
  rotateServicePrincipalKey,
  disableServicePrincipal,
  migrateHumanKeyToServicePrincipal,
  ServicePrincipalNotFoundError,
  ApiKeyNotFoundError
} from '../services/servicePrincipals';

describe('service principal routes', () => {
  let app: Hono;

  const setAuth = (overrides: Partial<{ scope: 'system' | 'partner' | 'organization'; orgId: string | null }> = {}) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: overrides.scope ?? 'organization',
        partnerId: null,
        orgId: 'orgId' in overrides ? overrides.orgId : ORG_ID,
        user: { id: 'user-123', email: 'test@example.com' },
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    permissionMockState.granted = true;
    permissionMockState.permissions = {
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: null,
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: undefined,
    } as any;
    setAuth();
    app = new Hono();
    app.route('/service-principals', servicePrincipalRoutes);
  });

  describe('GET /service-principals', () => {
    it('lists principals scoped to the caller org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: ORG_ID, status: 'active' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/service-principals?page=1&limit=50');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });
  });

  describe('POST /service-principals', () => {
    it('creates a principal for the caller org', async () => {
      vi.mocked(createServicePrincipal).mockResolvedValue({
        id: PRINCIPAL_ID,
        orgId: ORG_ID,
        name: 'CI bot',
        status: 'active',
        scopes: ['ai:read'],
        createdBy: 'user-123',
        lastUpdatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date()
      } as any);

      const res = await app.request('/service-principals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID, name: 'CI bot', scopes: ['ai:read'] })
      });

      expect(res.status).toBe(201);
      expect(createServicePrincipal).toHaveBeenCalledWith({
        orgId: ORG_ID,
        name: 'CI bot',
        scopes: ['ai:read'],
        createdBy: 'user-123'
      });
    });

    it('rejects creating a principal for a different org (organization scope)', async () => {
      const res = await app.request('/service-principals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: OTHER_ORG_ID, name: 'CI bot', scopes: [] })
      });

      expect(res.status).toBe(403);
      expect(createServicePrincipal).not.toHaveBeenCalled();
    });

    // SR2-15 ceiling: a principal must never carry a scope its creator lacks.
    // Without this, an org admin holding only orgs:write could mint a principal
    // with devices:execute and reach /dev/push (arbitrary binary → fleet).
    it('rejects a scope the creator does not hold (delegation ceiling) and never creates', async () => {
      permissionMockState.permissions = {
        permissions: [{ resource: 'organizations', action: 'write' }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'role-1',
        scope: 'organization',
        allowedSiteIds: undefined,
      } as any;

      const res = await app.request('/service-principals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID, name: 'escalate', scopes: ['devices:execute'] })
      });

      expect(res.status).toBe(403);
      expect(createServicePrincipal).not.toHaveBeenCalled();
    });

    // A service principal is organization-wide (no site axis). A site-restricted
    // creator must not mint one, or they escape their own restriction across
    // every site in the org.
    it('rejects creation by a site-restricted caller and never creates', async () => {
      permissionMockState.permissions = {
        permissions: [{ resource: '*', action: '*' }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'role-1',
        scope: 'organization',
        allowedSiteIds: ['site-a'],
      } as any;

      const res = await app.request('/service-principals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID, name: 'CI bot', scopes: ['ai:read'] })
      });

      expect(res.status).toBe(403);
      expect(createServicePrincipal).not.toHaveBeenCalled();
    });
  });

  describe('POST /service-principals/:id/rotate', () => {
    it('404s when the principal does not exist (org-access gate query returns nothing)', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) })
      } as any);

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/rotate`, { method: 'POST' });

      expect(res.status).toBe(404);
      expect(rotateServicePrincipalKey).not.toHaveBeenCalled();
    });

    it('rotates the key and returns the raw key once', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: ORG_ID }]) })
        })
      } as any);
      vi.mocked(rotateServicePrincipalKey).mockResolvedValue({
        apiKeyId: 'key-new',
        key: 'brz_newkey',
        keyPrefix: 'brz_newkey'
      });

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/rotate`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.key).toBe('brz_newkey');
      expect(rotateServicePrincipalKey).toHaveBeenCalledWith(PRINCIPAL_ID, 'user-123');
    });

    it('denies cross-org rotate (org-access gate)', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: OTHER_ORG_ID }])
          })
        })
      } as any);

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/rotate`, { method: 'POST' });

      expect(res.status).toBe(403);
      expect(rotateServicePrincipalKey).not.toHaveBeenCalled();
    });
  });

  describe('POST /service-principals/:id/disable', () => {
    it('disables the principal (cascade revoke happens in the service layer)', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: ORG_ID }]) })
        })
      } as any);
      vi.mocked(disableServicePrincipal).mockResolvedValue({
        id: PRINCIPAL_ID,
        orgId: ORG_ID,
        name: 'CI bot',
        status: 'disabled',
        scopes: [],
        createdBy: 'user-123',
        lastUpdatedBy: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date()
      } as any);

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/disable`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(disableServicePrincipal).toHaveBeenCalledWith(PRINCIPAL_ID, 'user-123');
    });

    it('maps ServicePrincipalNotFoundError from the service layer to 404', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: ORG_ID }]) })
        })
      } as any);
      vi.mocked(disableServicePrincipal).mockRejectedValue(new ServicePrincipalNotFoundError(PRINCIPAL_ID));

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/disable`, { method: 'POST' });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /service-principals/:id/migrate-key', () => {
    // Guard-bite (c): migrateHumanKeyToServicePrincipal requires org-admin —
    // a non-admin actor gets 403. This is the only route that flips
    // api_keys.principal_type; if requirePermission were ever removed from
    // this route's middleware chain, this test goes RED.
    it('403s a non-admin caller (requirePermission gate) and never calls the service', async () => {
      permissionMockState.granted = false;

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/migrate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId: KEY_ID })
      });

      expect(res.status).toBe(403);
      expect(migrateHumanKeyToServicePrincipal).not.toHaveBeenCalled();
    });

    it('migrates the key for an authorized org-admin caller', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: ORG_ID }]) })
        })
      } as any);
      vi.mocked(migrateHumanKeyToServicePrincipal).mockResolvedValue({
        id: KEY_ID,
        orgId: ORG_ID,
        principalType: 'service',
        principalId: PRINCIPAL_ID,
        scopes: ['ai:read']
      } as any);

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/migrate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId: KEY_ID })
      });

      expect(res.status).toBe(200);
      expect(migrateHumanKeyToServicePrincipal).toHaveBeenCalledWith(KEY_ID, PRINCIPAL_ID, 'user-123');
    });

    it('maps ApiKeyNotFoundError from the service layer to 404', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: PRINCIPAL_ID, orgId: ORG_ID }]) })
        })
      } as any);
      vi.mocked(migrateHumanKeyToServicePrincipal).mockRejectedValue(new ApiKeyNotFoundError(KEY_ID));

      const res = await app.request(`/service-principals/${PRINCIPAL_ID}/migrate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId: KEY_ID })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('JWT-only surface', () => {
    it('never imports apiKeyAuthMiddleware — a service-principal key has no management surface (SR2-15)', async () => {
      // Structural guard: an API-key-authed request can never reach these
      // routes because they are mounted behind authMiddleware (JWT) only.
      // Assert the source itself never wires in the API-key auth path, so a
      // future edit that adds `apiKeyAuthMiddleware` to this file's
      // middleware chain fails loudly instead of silently opening a
      // management surface to service-account credentials.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const source = fs.readFileSync(path.join(__dirname, 'servicePrincipals.ts'), 'utf8');
      expect(source).not.toContain("from '../middleware/apiKeyAuth'");
    });
  });
});
