import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reviewUpdate: null as null | { id: string; name: string },
  partner: null as null | {
    trustState: 'probation' | 'trusted' | 'restricted';
    trustReviewRequestedAt: Date | null;
    createdAt: Date;
    emailVerifiedAt: Date | null;
    signupIpClass: 'residential' | 'business' | 'hosting' | 'vpn' | 'tor' | 'unknown';
  },
}));

const dbSpies = vi.hoisted(() => ({ update: vi.fn(), select: vi.fn() }));

vi.mock('../db', () => ({
  db: {
    update: dbSpies.update,
    select: dbSpies.select,
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

vi.mock('../services/opsAlerts', () => ({
  sendOpsAlert: vi.fn(async () => true),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: () => Promise<void>) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    await next();
  }),
}));

import { Hono } from 'hono';
import { partnerTrustRoutes } from './partnerTrust';
import { createAuditLog } from '../services/auditService';
import { sendOpsAlert } from '../services/opsAlerts';

const auth = {
  scope: 'partner',
  partnerId: '22222222-2222-4222-8222-222222222222',
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'owner@breeze.test',
  },
};

function buildApp(authToInject: typeof auth = auth) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authToInject as never);
    await next();
  });
  app.route('/partner/trust', partnerTrustRoutes);
  return app;
}

// requireScope('partner') gate: the mocked '../middleware/auth' above rejects
// with 403 when auth.scope isn't in the allowed list, mirroring the real
// middleware. Org-scoped and system-scoped tokens must both be rejected —
// this route is partner-owner-only.
const orgScopeAuth = { ...auth, scope: 'organization' };
const systemScopeAuth = { ...auth, scope: 'system' };

describe('partner trust routes — auth scope gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects POST /request-review for an organization-scoped token (403)', async () => {
    const response = await buildApp(orgScopeAuth).request('/partner/trust/request-review', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });

  it('rejects POST /request-review for a system-scoped token (403)', async () => {
    const response = await buildApp(systemScopeAuth).request('/partner/trust/request-review', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });

  it('rejects GET / for an organization-scoped token (403)', async () => {
    const response = await buildApp(orgScopeAuth).request('/partner/trust');

    expect(response.status).toBe(403);
  });

  it('rejects GET / for a system-scoped token (403)', async () => {
    const response = await buildApp(systemScopeAuth).request('/partner/trust');

    expect(response.status).toBe(403);
  });
});

describe('partner trust routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.reviewUpdate = { id: auth.partnerId, name: 'Northwind IT' };
    state.partner = {
      trustState: 'probation',
      trustReviewRequestedAt: null,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      emailVerifiedAt: new Date(),
      signupIpClass: 'business',
    };

    dbSpies.update.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(state.reviewUpdate ? [state.reviewUpdate] : []),
        }),
      }),
    }));
    dbSpies.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.partner ? [state.partner] : []),
        }),
      }),
    }));
  });

  it('requests review, audits it, and alerts ops with the partner name', async () => {
    const response = await buildApp().request('/partner/trust/request-review', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requested: true });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.review_requested',
      actorId: auth.user.id,
      resourceId: auth.partnerId,
    }));
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Northwind IT'),
    }));
  });

  it('returns 429 when a review was requested within 24 hours', async () => {
    state.reviewUpdate = null;
    const response = await buildApp().request('/partner/trust/request-review', { method: 'POST' });

    expect(response.status).toBe(429);
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });

  it('returns the trust checklist and meeting URL', async () => {
    const previous = process.env.PARTNER_MEETING_URL;
    process.env.PARTNER_MEETING_URL = 'https://meet.example.test/trust';
    try {
      const response = await buildApp().request('/partner/trust');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        trustState: 'probation',
        checklist: {
          ageOk: true,
          emailVerified: true,
          cardSettled: null,
          signupIpOk: true,
        },
        reviewRequestedAt: null,
        meetingUrl: 'https://meet.example.test/trust',
      });
    } finally {
      if (previous === undefined) delete process.env.PARTNER_MEETING_URL;
      else process.env.PARTNER_MEETING_URL = previous;
    }
  });

  it('fails checklist items for a young, unverified partner on a risky IP', async () => {
    state.partner = {
      trustState: 'restricted',
      trustReviewRequestedAt: new Date('2026-09-02T00:00:00.000Z'),
      createdAt: new Date(),
      emailVerifiedAt: null,
      signupIpClass: 'vpn',
    };

    const response = await buildApp().request('/partner/trust');
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.checklist).toEqual({
      ageOk: false,
      emailVerified: false,
      cardSettled: null,
      signupIpOk: false,
    });
  });
});
