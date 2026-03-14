import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tagRoutes } from './tags';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    orgId: 'orgId',
    hostname: 'hostname',
    displayName: 'displayName',
    status: 'status',
    osType: 'osType',
    tags: 'tags'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('tag routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    app = new Hono();
    app.route('/tags', tagRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List tags
  // ----------------------------------------------------------------
  describe('GET /tags', () => {
    it('should list unique tags with device counts', async () => {
      const deviceRows = [
        { tags: ['prod', 'web'] },
        { tags: ['prod', 'db'] },
        { tags: ['web'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      // 'prod' has 2 devices, 'web' has 2, 'db' has 1
      const prodTag = body.data.find((t: any) => t.tag === 'prod');
      expect(prodTag.deviceCount).toBe(2);
      const webTag = body.data.find((t: any) => t.tag === 'web');
      expect(webTag.deviceCount).toBe(2);
      const dbTag = body.data.find((t: any) => t.tag === 'db');
      expect(dbTag.deviceCount).toBe(1);
    });

    it('should filter tags by search term', async () => {
      const deviceRows = [
        { tags: ['production', 'staging'] },
        { tags: ['production'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags?search=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('production');
    });

    it('should handle devices with no tags', async () => {
      const deviceRows = [
        { tags: null },
        { tags: [] },
        { tags: ['active'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('active');
    });

    it('should return empty for org scope with no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should sort tags by device count descending, then alphabetically', async () => {
      const deviceRows = [
        { tags: ['alpha', 'beta'] },
        { tags: ['beta', 'gamma'] },
        { tags: ['beta'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].tag).toBe('beta');
      expect(body.data[0].deviceCount).toBe(3);
    });

    it('should ignore empty string tags', async () => {
      const deviceRows = [
        { tags: ['', '  ', 'valid'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('valid');
    });
  });

  // ----------------------------------------------------------------
  // GET /devices - Get devices by tag
  // ----------------------------------------------------------------
  describe('GET /tags/devices', () => {
    it('should return devices matching a tag', async () => {
      const deviceList = [
        { id: 'dev-1', hostname: 'host-1', displayName: 'Host 1', status: 'online', osType: 'linux', tags: ['prod'] },
        { id: 'dev-2', hostname: 'host-2', displayName: 'Host 2', status: 'offline', osType: 'windows', tags: ['prod', 'web'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceList)
        })
      } as any);

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.data[0].id).toBe('dev-1');
    });

    it('should validate that tag query parameter is required', async () => {
      const res = await app.request('/tags/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });

    it('should return empty for org with no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should handle devices with null tags', async () => {
      const deviceList = [
        { id: 'dev-1', hostname: 'host-1', displayName: null, status: 'online', osType: 'linux', tags: null }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceList)
        })
      } as any);

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].tags).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // Partner scope multi-tenant tests
  // ----------------------------------------------------------------
  describe('partner scope', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => [ORG_ID, ORG_ID_2].includes(orgId)
        });
        return next();
      });
    });

    it('should list tags across multiple orgs', async () => {
      const deviceRows = [
        { tags: ['shared-tag'] },
        { tags: ['shared-tag', 'org2-only'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
    });

    it('should return empty when partner has no accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // System scope tests
  // ----------------------------------------------------------------
  describe('system scope', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });
    });

    it('should list all tags across all orgs', async () => {
      const deviceRows = [
        { tags: ['global-tag'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
    });
  });
});
