import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectResult, insertReturning, sendInvite } = vi.hoisted(() => ({
  authRef: { current: { scope: 'partner' as string, user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1' as string | null, canAccessOrg: (_id: string) => true } },
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
  sendInvite: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('auth', authRef.current); await next(); }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => selectResult()), orderBy: vi.fn(() => selectResult()) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => insertReturning()) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => insertReturning()) })) })) }))
  }
}));
vi.mock('../db/schema', () => ({
  portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', receiveNotifications: 'receiveNotifications', status: 'status', invitedBy: 'invitedBy', invitedAt: 'invitedAt', lastLoginAt: 'lastLoginAt', createdAt: 'createdAt' },
  organizations: { id: 'id', name: 'name', deletedAt: 'deletedAt' }
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../routes/portal/helpers', () => ({ storePortalInviteToken: vi.fn(async () => 'raw-token'), buildPortalUrl: (p: string) => `https://x/portal${p}` }));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendPortalInvite: sendInvite }) }));

import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const makeApp = () => { const app = new Hono(); app.use('*', authMiddleware as any); registerOrgPortalUsersRoutes(app); return app; };
beforeEach(() => { vi.clearAllMocks(); authRef.current = { scope: 'partner', user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1', canAccessOrg: () => true }; });

describe('GET /organizations/:id/portal-users', () => {
  it('lists users with an effective status', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([
        { id: 'pu-1', email: 'a@acme.example', name: 'A', passwordHash: 'h', status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null },
        { id: 'pu-2', email: 'b@acme.example', name: null, passwordHash: null, status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null }
      ]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-users`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((u: any) => u.effectiveStatus)).toEqual(['active', 'pending_setup']);
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

describe('POST /organizations/:id/portal-users/invite', () => {
  const invite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('creates an invited user and emails a link', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([])               // no existing portal user
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new', email: 'new@acme.example', status: 'invited' }]);
    const res = await invite({ email: 'new@acme.example', name: 'New Cust' });
    expect(res.status).toBe(200);
    expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@acme.example', inviteUrl: expect.stringContaining('/portal/accept-invite?token=raw-token') }));
  });

  it('409s when the email is already an active account with a password', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'live@acme.example', passwordHash: 'h', status: 'active' }]);
    const res = await invite({ email: 'live@acme.example' });
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });
});
