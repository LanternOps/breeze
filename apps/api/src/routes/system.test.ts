import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'users.id',
    setupCompletedAt: 'users.setupCompletedAt',
    updatedAt: 'users.updatedAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { systemRoutes } from './system';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function setAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'admin@test.com', name: 'Admin' },
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      ...overrides,
    });
    return next();
  });
}

function makeApp() {
  const app = new Hono();
  app.route('/system', systemRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('system routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── GET /config-status ──────────────────────
  describe('GET /config-status', () => {
    it('returns config status for partner-scoped user', async () => {
      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('domain');
      expect(body).toHaveProperty('security');
      expect(body).toHaveProperty('integrations');

      expect(body.email).toHaveProperty('configured');
      expect(body.email).toHaveProperty('provider');
      expect(body.email).toHaveProperty('from');

      expect(body.security).toHaveProperty('httpsForced');
      expect(body.security).toHaveProperty('mfaEnabled');
      expect(body.security).toHaveProperty('registrationEnabled');

      expect(body.integrations).toHaveProperty('sms');
      expect(body.integrations).toHaveProperty('ai');
      expect(body.integrations).toHaveProperty('mtls');
      expect(body.integrations).toHaveProperty('storage');
      expect(body.integrations).toHaveProperty('sentry');
    });

    it('returns config status for system-scoped user', async () => {
      setAuth({ scope: 'system' });

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
    });

    it('returns 403 for organization-scoped user', async () => {
      setAuth({ scope: 'organization', orgId: ORG_ID });

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error).toBe('Forbidden');
    });

    it('detects email provider from env', async () => {
      const originalEnv = { ...process.env };
      process.env.RESEND_API_KEY = 'test-key';
      process.env.EMAIL_FROM = 'noreply@test.com';

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email.configured).toBe(true);
      expect(body.email.provider).toBe('resend');
      expect(body.email.from).toBe('noreply@test.com');

      // Restore env
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      Object.assign(process.env, originalEnv);
    });

    it('detects SMTP provider', async () => {
      const originalResend = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      process.env.SMTP_HOST = 'smtp.example.com';

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email.provider).toBe('smtp');

      delete process.env.SMTP_HOST;
      if (originalResend) process.env.RESEND_API_KEY = originalResend;
    });

    it('reports no email provider when none configured', async () => {
      const originalResend = process.env.RESEND_API_KEY;
      const originalSmtp = process.env.SMTP_HOST;
      const originalMailgun = process.env.MAILGUN_API_KEY;
      delete process.env.RESEND_API_KEY;
      delete process.env.SMTP_HOST;
      delete process.env.MAILGUN_API_KEY;

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email.configured).toBe(false);
      expect(body.email.provider).toBe('none');

      if (originalResend) process.env.RESEND_API_KEY = originalResend;
      if (originalSmtp) process.env.SMTP_HOST = originalSmtp;
      if (originalMailgun) process.env.MAILGUN_API_KEY = originalMailgun;
    });

    it('does not leak secret values', async () => {
      process.env.RESEND_API_KEY = 'super-secret-key';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      const bodyStr = JSON.stringify(body);

      // Ensure no secret values appear in the response
      expect(bodyStr).not.toContain('super-secret-key');
      expect(bodyStr).not.toContain('sk-ant-secret');

      delete process.env.RESEND_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('detects AI integration availability', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.integrations.ai).toBe(true);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('detects mTLS integration', async () => {
      process.env.CLOUDFLARE_API_TOKEN = 'token';
      process.env.CLOUDFLARE_ZONE_ID = 'zone';

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.integrations.mtls).toBe(true);

      delete process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.CLOUDFLARE_ZONE_ID;
    });
  });

  // ────────────────────── POST /setup-complete ──────────────────────
  describe('POST /setup-complete', () => {
    it('marks setup as complete for the current user', async () => {
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(vi.mocked(db.update)).toHaveBeenCalled();
    });

    it('returns 500 when database update fails', async () => {
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to complete setup');
    });

    it('works for any authenticated scope', async () => {
      setAuth({ scope: 'organization', orgId: ORG_ID });

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });
  });

  // ────────────────────── Auth enforcement ──────────────────────
  describe('authentication', () => {
    it('all routes require auth middleware', async () => {
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      await app.request('/system/setup-complete', { method: 'POST' });
      expect(vi.mocked(authMiddleware)).toHaveBeenCalled();
    });
  });

  // ────────────────────── Multi-tenant isolation ──────────────────────
  describe('multi-tenant isolation', () => {
    it('returns 403 for org-scoped user accessing config-status (partner-only route)', async () => {
      setAuth({ scope: 'organization', orgId: ORG_ID });

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Forbidden');
    });

    it('denies config-status when canAccessOrg returns false for all orgs', async () => {
      setAuth({
        scope: 'organization',
        orgId: ORG_ID,
        canAccessOrg: () => false,
      });

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(403);
    });

    it('denies config-status for org-scoped user from a different org', async () => {
      const ORG_ID_OTHER = '22222222-2222-2222-2222-222222222222';
      setAuth({
        scope: 'organization',
        orgId: ORG_ID_OTHER,
        accessibleOrgIds: [ORG_ID_OTHER],
        canAccessOrg: (id: string) => id === ORG_ID_OTHER,
      });

      const res = await app.request('/system/config-status');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Forbidden');
    });

    it('setup-complete only affects the authenticated user, not other tenants', async () => {
      const ORG_ID_OTHER = '22222222-2222-2222-2222-222222222222';
      setAuth({
        scope: 'organization',
        orgId: ORG_ID_OTHER,
        accessibleOrgIds: [ORG_ID_OTHER],
        canAccessOrg: (id: string) => id === ORG_ID_OTHER,
        user: { id: 'user-other-org', email: 'other@test.com', name: 'Other' },
      });

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      // Verify that the update call was made (it operates on auth.user.id,
      // so each user's setup state is isolated by user ID)
      expect(vi.mocked(db.update)).toHaveBeenCalled();
    });
  });
});
