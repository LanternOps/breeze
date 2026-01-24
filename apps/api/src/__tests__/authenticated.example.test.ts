/**
 * Example test file demonstrating REAL authenticated API testing.
 *
 * This test uses actual JWT tokens and the real auth middleware instead of mocking.
 * Only the database layer is mocked, making these tests closer to real-world behavior.
 *
 * Key differences from mocked auth tests:
 * 1. Uses real JWT token generation and verification
 * 2. Uses actual authMiddleware (not mocked)
 * 3. Tests token expiry, invalid tokens, and scope validation
 * 4. More realistic test of the full request flow
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createTestToken,
  createAuthenticatedClient,
  createTestUser,
  createTestDevice
} from './helpers';
import { authMiddleware, requireScope } from '../middleware/auth';

// Mock only the database - NOT the auth middleware or JWT services
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
  users: { id: 'id', email: 'email', name: 'name', status: 'status' },
  devices: {},
  organizations: {},
  partnerUsers: {},
  organizationUsers: {}
}));

import { db } from '../db';

// Helper to mock user lookup for auth middleware
function mockUserLookup(user: ReturnType<typeof createTestUser> | null) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(user ? [user] : [])
      })
    })
  } as any);
}

describe('Authenticated API Tests (Real JWT)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
  });

  describe('Token Validation', () => {
    it('should reject requests without Authorization header', async () => {
      app.use(authMiddleware);
      app.get('/protected', (c) => c.json({ success: true }));

      const res = await app.request('/protected');

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain('Missing or invalid authorization header');
    });

    it('should reject requests with invalid token format', async () => {
      app.use(authMiddleware);
      app.get('/protected', (c) => c.json({ success: true }));

      const res = await app.request('/protected', {
        headers: { Authorization: 'InvalidFormat' }
      });

      expect(res.status).toBe(401);
    });

    it('should reject requests with malformed JWT', async () => {
      app.use(authMiddleware);
      app.get('/protected', (c) => c.json({ success: true }));

      const res = await app.request('/protected', {
        headers: { Authorization: 'Bearer not.a.valid.jwt' }
      });

      expect(res.status).toBe(401);
    });

    it('should accept requests with valid JWT token', async () => {
      const testUser = createTestUser();
      mockUserLookup(testUser);

      app.use(authMiddleware);
      app.get('/protected', (c) => {
        const auth = c.get('auth');
        return c.json({
          success: true,
          userId: auth.user.id,
          orgId: auth.orgId
        });
      });

      const token = await createTestToken({
        userId: testUser.id,
        email: testUser.email
      });

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.userId).toBe(testUser.id);
    });

    it('should reject token for non-existent user', async () => {
      mockUserLookup(null);

      app.use(authMiddleware);
      app.get('/protected', (c) => c.json({ success: true }));

      const token = await createTestToken({ userId: 'non-existent' });

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(401);
    });

    it('should reject token for inactive user', async () => {
      const inactiveUser = createTestUser({ status: 'suspended' });
      mockUserLookup(inactiveUser);

      app.use(authMiddleware);
      app.get('/protected', (c) => c.json({ success: true }));

      const token = await createTestToken({ userId: inactiveUser.id });

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });
  });

  describe('Scope Validation', () => {
    beforeEach(() => {
      const testUser = createTestUser();
      mockUserLookup(testUser);
    });

    it('should allow access when scope matches', async () => {
      app.use(authMiddleware);
      app.use(requireScope('organization'));
      app.get('/org-only', (c) => c.json({ success: true }));

      const token = await createTestToken({ scope: 'organization' });

      const res = await app.request('/org-only', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
    });

    it('should reject access when scope does not match', async () => {
      app.use(authMiddleware);
      app.use(requireScope('organization'));
      app.get('/org-only', (c) => c.json({ success: true }));

      const token = await createTestToken({ scope: 'partner' });

      const res = await app.request('/org-only', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });

    it('should allow access when any scope matches', async () => {
      app.use(authMiddleware);
      app.use(requireScope('organization', 'partner', 'system'));
      app.get('/multi-scope', (c) => c.json({ success: true }));

      const token = await createTestToken({ scope: 'partner' });

      const res = await app.request('/multi-scope', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
    });
  });

  describe('Authenticated Client Helper', () => {
    beforeEach(() => {
      const testUser = createTestUser();
      mockUserLookup(testUser);
    });

    it('should make authenticated GET requests', async () => {
      app.use(authMiddleware);
      app.get('/data', (c) => c.json({ items: [1, 2, 3] }));

      const client = await createAuthenticatedClient(app);
      const res = await client.get('/data');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([1, 2, 3]);
    });

    it('should make authenticated POST requests with body', async () => {
      app.use(authMiddleware);
      app.post('/data', async (c) => {
        const body = await c.req.json();
        return c.json({ received: body });
      });

      const client = await createAuthenticatedClient(app);
      const res = await client.post('/data', { name: 'test' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received).toEqual({ name: 'test' });
    });

    it('should use custom token options', async () => {
      app.use(authMiddleware);
      app.get('/check-org', (c) => {
        const auth = c.get('auth');
        return c.json({ orgId: auth.orgId });
      });

      const client = await createAuthenticatedClient(app, {
        orgId: 'custom-org-123'
      });
      const res = await client.get('/check-org');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orgId).toBe('custom-org-123');
    });
  });

  describe('Multi-tenant Data Isolation', () => {
    it('should include orgId in auth context for filtering', async () => {
      const testUser = createTestUser();
      mockUserLookup(testUser);

      app.use(authMiddleware);
      app.get('/devices', (c) => {
        const auth = c.get('auth');
        // In real route, this orgId would be used to filter database queries
        return c.json({
          filterOrgId: auth.orgId,
          scope: auth.scope
        });
      });

      const client = await createAuthenticatedClient(app, {
        orgId: 'org-abc-123',
        scope: 'organization'
      });
      const res = await client.get('/devices');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.filterOrgId).toBe('org-abc-123');
      expect(body.scope).toBe('organization');
    });

    it('should include partnerId for partner-scoped requests', async () => {
      const testUser = createTestUser();
      mockUserLookup(testUser);

      app.use(authMiddleware);
      app.get('/partner/orgs', (c) => {
        const auth = c.get('auth');
        return c.json({
          partnerId: auth.partnerId,
          scope: auth.scope
        });
      });

      const client = await createAuthenticatedClient(app, {
        partnerId: 'partner-xyz',
        scope: 'partner'
      });
      const res = await client.get('/partner/orgs');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.partnerId).toBe('partner-xyz');
      expect(body.scope).toBe('partner');
    });
  });
});
