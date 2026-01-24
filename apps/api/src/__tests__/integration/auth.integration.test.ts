/**
 * Authentication Integration Tests
 *
 * These tests run against real PostgreSQL and Redis instances in Docker.
 * They test the full authentication flow including:
 * - User registration
 * - Login with password verification
 * - JWT token generation and validation
 * - Session management
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../../routes/auth';
import { authMiddleware } from '../../middleware/auth';
import {
  createUser,
  setupTestEnvironment,
  createIntegrationTestClient
} from './db-utils';
import { getTestDb } from './setup';
import { users } from '../../db/schema';
import { eq } from 'drizzle-orm';

// Import setup to initialize database connection
import './setup';

describe('Auth Integration Tests', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/auth', authRoutes);
  });

  describe('POST /auth/register', () => {
    it('should register a new user and return tokens', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'newuser@example.com',
          password: 'SecurePass123!',
          name: 'New User'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('newuser@example.com');

      // Verify user was created in database
      const db = getTestDb();
      const [dbUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, 'newuser@example.com'))
        .limit(1);

      expect(dbUser).toBeDefined();
      expect(dbUser.name).toBe('New User');
      expect(dbUser.status).toBe('active');
    });

    it('should return generic success for duplicate email (prevents enumeration)', async () => {
      // Create existing user
      await createUser({ email: 'existing@example.com' });

      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          password: 'SecurePass123!',
          name: 'Duplicate User'
        })
      });

      // Security: API returns 200 with generic message to prevent email enumeration
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      // Should NOT return tokens for duplicate registration
      expect(body.tokens).toBeUndefined();
    });

    it('should reject weak passwords', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'weakpass@example.com',
          password: 'weak',
          name: 'Weak Pass User'
        })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('should login with valid credentials', async () => {
      // Create user with known password
      await createUser({
        email: 'login@example.com',
        password: 'MyPassword123!'
      });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'login@example.com',
          password: 'MyPassword123!'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toBeDefined();
      expect(body.user).toBeDefined();
      expect(body.mfaRequired).toBe(false);
    });

    it('should reject invalid password', async () => {
      await createUser({
        email: 'wrongpass@example.com',
        password: 'CorrectPass123!'
      });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'wrongpass@example.com',
          password: 'WrongPassword123!'
        })
      });

      expect(res.status).toBe(401);
    });

    it('should reject disabled user login', async () => {
      await createUser({
        email: 'disabled@example.com',
        password: 'MyPassword123!',
        status: 'disabled'
      });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'disabled@example.com',
          password: 'MyPassword123!'
        })
      });

      expect(res.status).toBe(403);
    });

    it('should update lastLoginAt on successful login', async () => {
      const user = await createUser({
        email: 'lastlogin@example.com',
        password: 'MyPassword123!'
      });

      expect(user.lastLoginAt).toBeNull();

      await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'lastlogin@example.com',
          password: 'MyPassword123!'
        })
      });

      // Check that lastLoginAt was updated
      const db = getTestDb();
      const [updatedUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);

      expect(updatedUser.lastLoginAt).not.toBeNull();
    });
  });

  describe('GET /auth/me', () => {
    it('should return current user with valid token', async () => {
      const env = await setupTestEnvironment();

      app.use('/auth/*', authMiddleware);

      const res = await app.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(env.user.id);
      expect(body.user.email).toBe(env.user.email);
    });

    it('should reject request without token', async () => {
      app.use('/auth/*', authMiddleware);

      const res = await app.request('/auth/me', {
        method: 'GET'
      });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh tokens with valid refresh token', async () => {
      // First register to get tokens
      const registerRes = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'refresh@example.com',
          password: 'SecurePass123!',
          name: 'Refresh User'
        })
      });

      const { tokens } = await registerRes.json();

      // Now refresh
      const refreshRes = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: tokens.refreshToken
        })
      });

      expect(refreshRes.status).toBe(200);
      const body = await refreshRes.json();
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
      // Note: tokens may be identical if generated within same second due to JWT iat
    });

    it('should reject invalid refresh token', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: 'invalid-refresh-token'
        })
      });

      expect(res.status).toBe(401);
    });
  });
});

describe('Multi-Tenant Integration Tests', () => {
  it('should isolate data between organizations', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.get('/test/org', (c) => {
      const auth = c.get('auth');
      return c.json({ orgId: auth.orgId });
    });

    // Create two separate test environments (different orgs)
    const client1 = await createIntegrationTestClient(app);
    const client2 = await createIntegrationTestClient(app);

    // Verify they have different org IDs
    expect(client1.env.organization.id).not.toBe(client2.env.organization.id);

    // Each client should see their own org
    const res1 = await client1.get('/test/org');
    const res2 = await client2.get('/test/org');

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(body1.orgId).toBe(client1.env.organization.id);
    expect(body2.orgId).toBe(client2.env.organization.id);
  });

  it('should support partner-scoped access', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.get('/test/scope', (c) => {
      const auth = c.get('auth');
      return c.json({
        scope: auth.scope,
        partnerId: auth.partnerId,
        orgId: auth.orgId
      });
    });

    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const res = await client.get('/test/scope');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('partner');
    expect(body.partnerId).toBe(client.env.partner.id);
    expect(body.orgId).toBeNull();
  });
});
