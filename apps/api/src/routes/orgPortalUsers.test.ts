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
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => selectResult()),
          orderBy: vi.fn(() => selectResult()),
          // bulk-invite's candidates query awaits `.where()` directly with no
          // `.limit()`/`.orderBy()` leaf — make the where-result thenable so
          // `await ...where(x)` also resolves via selectResult().
          then: (resolve: any, reject: any) => selectResult().then(resolve, reject)
        }))
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => insertReturning()) })) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => insertReturning()),
          // bulk-invite's per-user update has no `.returning()` leaf —
          // make the where-result thenable so a bare `await ...where(x)`
          // also resolves via insertReturning().
          then: (resolve: any, reject: any) => insertReturning().then(resolve, reject)
        }))
      }))
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }))
  }
}));
vi.mock('../db/schema', () => ({
  portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', receiveNotifications: 'receiveNotifications', status: 'status', invitedBy: 'invitedBy', invitedAt: 'invitedAt', lastLoginAt: 'lastLoginAt', createdAt: 'createdAt' },
  organizations: { id: 'id', name: 'name', deletedAt: 'deletedAt' },
  tickets: { id: 'id', submittedBy: 'submittedBy' },
  ticketComments: { id: 'id', portalUserId: 'portalUserId' },
  assetCheckouts: { id: 'id', checkedOutTo: 'checkedOutTo' }
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

describe('PATCH /organizations/:id/portal-users/:userId', () => {
  const patch = (uid: string, body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('disables a user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])                         // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }]);          // target exists in org
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'disabled' }]); // update .returning
    const res = await patch('pu-1', { status: 'disabled' });
    expect(res.status).toBe(200);
  });
});

describe('POST /organizations/:id/portal-users/:userId/resend-invite', () => {
  const resend = (uid: string) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}/resend-invite`, { method: 'POST' });

  it('resends the invite to a pending (no-password) user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'pending@acme.example', name: null, passwordHash: null, status: 'invited' }]) // target
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    const res = await resend('pu-1');
    expect(res.status).toBe(200);
    expect(sendInvite).toHaveBeenCalledTimes(1);
    expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'pending@acme.example' }));
  });

  it('409s when the target already has an active password-set account', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'live@acme.example', name: null, passwordHash: 'h', status: 'active' }]); // target
    const res = await resend('pu-1');
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-users/bulk-invite', () => {
  const bulkInvite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/bulk-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const PU_1 = 'aaaaaaaa-1111-4222-8333-444455556666';
  const PU_2 = 'bbbbbbbb-1111-4222-8333-444455556666';
  const PU_DISABLED = 'cccccccc-1111-4222-8333-444455556666';

  it('invites all candidates returned by the pending-setup query when no userIds are given', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([
        { id: PU_1, email: 'a@acme.example' },
        { id: PU_2, email: 'b@acme.example' }
      ]) // candidates — the handler's baseWhere (org + no password + status != disabled) already filtered these
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([]); // per-user update
    const res = await bulkInvite({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.id)).toEqual([PU_1, PU_2]);
    expect(sendInvite).toHaveBeenCalledTimes(2);
  });

  it('drops a requested userId that is not in the candidate set (e.g. a disabled account)', async () => {
    // Candidates mock simulates the DB-side ne(status,'disabled') filter already having
    // excluded PU_DISABLED — the handler's userIds-intersection then can only invite PU_1.
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: PU_1, email: 'a@acme.example' }]) // candidates
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([]);
    const res = await bulkInvite({ userIds: [PU_1, PU_DISABLED] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.id)).toEqual([PU_1]);
    expect(sendInvite).toHaveBeenCalledTimes(1);
  });

  it('respects userIds — only invites the requested subset of candidates', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([
        { id: PU_1, email: 'a@acme.example' },
        { id: PU_2, email: 'b@acme.example' }
      ]) // candidates
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([]);
    const res = await bulkInvite({ userIds: [PU_1] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.id)).toEqual([PU_1]);
    expect(sendInvite).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /organizations/:id/portal-users/:userId', () => {
  const del = (uid: string) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}`, { method: 'DELETE' });
  it('409s when the user has ticket references', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])            // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }]) // target
      .mockResolvedValueOnce([{ id: 't-1' }]);            // reference exists (tickets)
    const res = await del('pu-1');
    expect(res.status).toBe(409);
  });
  it('hard-deletes an unreferenced user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }])
      .mockResolvedValueOnce([]) // tickets ref
      .mockResolvedValueOnce([]) // comments ref
      .mockResolvedValueOnce([]); // checkouts ref
    // delete().where() resolves (mock deleteChain below)
    const res = await del('pu-1');
    expect(res.status).toBe(200);
  });
});
