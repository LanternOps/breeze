import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { orgRoutes } from './orgs';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]))
          }))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  partners: {},
  organizations: {},
  sites: {}
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      accessibleOrgIds: ['org-1', 'org-2'],
      user: { id: 'user-123', email: 'test@example.com' },
      canAccessOrg: () => true
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePartner: vi.fn((c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) {
      return c.json({ error: 'Partner access required' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('organization routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        accessibleOrgIds: ['org-1', 'org-2'],
        user: { id: 'user-123', email: 'test@example.com' },
        canAccessOrg: () => true
      });
      return next();
    });
    app = new Hono();
    app.route('/orgs', orgRoutes);
  });

  describe('partner tenants', () => {
    it('should list partners for system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      const partners = [
        { id: 'partner-1', name: 'Acme', slug: 'acme' },
        { id: 'partner-2', name: 'Globex', slug: 'globex' }
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue(partners)
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/partners?page=1&limit=2', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it('should create a partner tenant', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'partner-1', name: 'Acme', slug: 'acme' }
          ])
        })
      } as any);

      const res = await app.request('/orgs/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme',
          slug: 'acme'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('partner-1');
    });

    it('should update a partner tenant', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'partner-1', name: 'Acme Updated', slug: 'acme' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Acme Updated');
    });

    it('should delete a partner tenant', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('organizations', () => {
    it('should list partner organizations', async () => {
      const organizations = [
        { id: 'org-1', name: 'Org One', slug: 'org-one', partnerId: 'partner-123' }
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue(organizations)
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations?page=1&limit=50', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should create an organization', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'org-1', name: 'Org One', slug: 'org-one' }
          ])
        })
      } as any);

      const res = await app.request('/orgs/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Org One',
          slug: 'org-one'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('org-1');
    });

    it('should fetch an organization by id', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'org-1', name: 'Org One', slug: 'org-one' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slug).toBe('org-one');
    });

    it('should update an organization', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'org-1', name: 'Org One Updated', slug: 'org-one' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Org One Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Org One Updated');
    });

    it('should delete an organization', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('sites', () => {
    it('should list sites for an accessible organization', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      const sites = [{ id: 'site-1', orgId, name: 'HQ' }];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue(sites)
                })
              })
            })
          })
        } as any);

      const res = await app.request(`/orgs/sites?orgId=${orgId}&page=1&limit=50`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should create a site for an accessible organization', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'site-1', orgId, name: 'HQ' }
          ])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, name: 'HQ' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('site-1');
    });

    it('should fetch a site by id', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('HQ');
    });

    it('should update a site', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ' }
            ])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ Updated' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'HQ Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('HQ Updated');
    });

    it('should delete a site', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ' }
            ])
          })
        })
      } as any);

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('access control', () => {
    it('should forbid partner routes for non-system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/orgs/partners', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });

    it('should return empty data for partner without accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: null,
          orgId: null,
          accessibleOrgIds: [],
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/orgs/organizations', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('should forbid site access to other organizations', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      const otherOrgId = '22222222-2222-2222-2222-222222222222';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      const res = await app.request(`/orgs/sites?orgId=${otherOrgId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });
});
