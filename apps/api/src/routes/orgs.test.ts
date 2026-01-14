import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { orgRoutes } from './orgs';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
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
  }
}));

vi.mock('../db/schema', () => ({
  partners: {},
  organizations: {},
  sites: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      token: {},
      partnerId: 'partner-123',
      orgId: 'org-123',
      scope: 'system'
    });
    return next();
  }),
  requireScope: vi.fn(() => (c, next) => next()),
  requirePartner: vi.fn((c, next) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('org routes', () => {
  let app: Hono;

  const setAuthContext = (overrides: Partial<{
    user: { id: string; email: string; name: string };
    token: Record<string, unknown>;
    partnerId: string | null;
    orgId: string | null;
    scope: 'system' | 'partner' | 'organization';
  }> = {}) => {
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User', ...overrides.user },
        token: overrides.token ?? {},
        partnerId: overrides.partnerId ?? 'partner-123',
        orgId: overrides.orgId ?? 'org-123',
        scope: overrides.scope ?? 'system'
      });
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setAuthContext();
    app = new Hono();
    app.route('/orgs', orgRoutes);
  });

  describe('GET /orgs/partners', () => {
    it('should return partners with pagination', async () => {
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
                  orderBy: vi.fn().mockResolvedValue([{ id: 'partner-1' }, { id: 'partner-2' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/partners?page=1&limit=2');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });
  });

  describe('POST /orgs/partners', () => {
    it('should create a partner', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'Partner' }])
        })
      } as any);

      const res = await app.request('/orgs/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Partner',
          slug: 'partner'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('partner-1');
    });
  });

  describe('GET /orgs/partners/:id', () => {
    it('should return a partner', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'Partner' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('partner-1');
    });

    it('should return 404 when partner not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/missing');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /orgs/partners/:id', () => {
    it('should reject empty updates', async () => {
      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should update a partner', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'Updated' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it('should return 404 when partner not found', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /orgs/partners/:id', () => {
    it('should delete a partner', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 when partner not found', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/missing', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /orgs/organizations', () => {
    it('should return organizations with pagination', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
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
                  orderBy: vi.fn().mockResolvedValue([{ id: 'org-1' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations?page=1&limit=1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });
  });

  describe('POST /orgs/organizations', () => {
    it('should create an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org' }])
        })
      } as any);

      const res = await app.request('/orgs/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Org',
          slug: 'org',
          contractStart: '2024-01-01',
          contractEnd: '2024-12-31'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('org-1');
    });
  });

  describe('GET /orgs/organizations/:id', () => {
    it('should return an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('org-1');
    });

    it('should return 404 when organization not found', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/missing');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /orgs/organizations/:id', () => {
    it('should reject empty updates', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should update an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Updated' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it('should return 404 when organization not found', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /orgs/organizations/:id', () => {
    it('should delete an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 when organization not found', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/missing', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /orgs/sites', () => {
    it('should return sites with pagination', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
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
                  orderBy: vi.fn().mockResolvedValue([{ id: 'site-1' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should allow partner scope access for matching org', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'org-1' }])
            })
          })
        } as any)
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
                  orderBy: vi.fn().mockResolvedValue([{ id: 'site-1' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should deny access when org scope does not match', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /orgs/sites', () => {
    it('should create a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'site-1', name: 'HQ' }])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'HQ',
          timezone: 'UTC'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('site-1');
    });

    it('should deny access when org scope does not match', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'HQ'
        })
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /orgs/sites/:id', () => {
    it('should return a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              name: 'HQ',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('site-1');
    });

    it('should return 404 when site not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/missing');

      expect(res.status).toBe(404);
    });

    it('should return 403 when access is denied', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1');

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /orgs/sites/:id', () => {
    it('should reject empty updates', async () => {
      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when site not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 when access is denied', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(403);
    });

    it('should update a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'site-1', name: 'Updated' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });
  });

  describe('DELETE /orgs/sites/:id', () => {
    it('should return 404 when site not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/missing', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 when access is denied', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(403);
    });

    it('should delete a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
