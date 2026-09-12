import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { userRow, updateSpy, sendPasswordResetSpy, updateRows } = vi.hoisted(() => ({
  userRow: { current: null as any },
  updateSpy: vi.fn(),
  sendPasswordResetSpy: vi.fn(),
  updateRows: { current: null as Array<{ authEpoch: number; id?: string }> | null },
}));
const { auditSpy } = vi.hoisted(() => ({ auditSpy: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: auditSpy,
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(userRow.current ? [userRow.current] : []) }) }) }),
    update: () => ({ set: (v: any) => ({ where: () => {
      updateSpy(v);
      return { returning: () => Promise.resolve(updateRows.current ?? [{ id: '11111111-2222-4333-8444-555566667777', authEpoch: (userRow.current?.authEpoch ?? 1) + 1 }]) };
    } }) })
  },
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  // helpers.ts now imports auth/helpers, which transitively pulls in the
  // services barrel; something there reads runOutsideDbContext at module load,
  // so the full-module mock must provide it (synchronous passthrough, matching
  // the real signature <T>(fn: () => T): T).
  runOutsideDbContext: <T>(fn: () => T) => fn()
}));
// discoveredAssetTypeEnum: networkBaseline.ts (transitive import of the portal
// route graph) reads its .enumValues at module load, so the full-module mock
// must provide it or the suite fails to load.
vi.mock('../../db/schema', () => ({ discoveredAssetTypeEnum: { enumValues: [] }, portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', authMethod: 'authMethod', authEpoch: 'authEpoch', receiveNotifications: 'receiveNotifications', status: 'status' }, portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' } }));
vi.mock('../../services/email', () => ({ getEmailService: () => ({ sendPasswordReset: sendPasswordResetSpy }) }));

import { authRoutes } from './auth';
import { storePortalInviteToken } from './helpers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const makeApp = () => { const app = new Hono(); app.route('/', authRoutes); return app; };
const post = (body: unknown) => makeApp().request('/auth/accept-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const forgot = (body: unknown) => makeApp().request('/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); auditSpy.mockResolvedValue(undefined); updateRows.current = null; userRow.current = null; });

describe('portal authentication lifecycle audit', () => {
  it.each([
    ['/auth/login', 'portal.auth.login'],
    ['/auth/forgot-password', 'portal.auth.password_reset.request'],
    ['/auth/reset-password', 'portal.auth.password_reset.complete'],
    ['/auth/accept-invite', 'portal.auth.invite.accept'],
    ['/auth/logout', 'portal.auth.logout'],
  ])('audits denied POST %s without copying credential input', async (path, action) => {
    const secret = `must-not-persist-${path}`;
    const res = await makeApp().request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: secret, token: secret }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]![1];
    expect(event).toMatchObject({ action, resourceType: 'portal_auth', result: 'denied' });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it('attributes a recovery request only after a current portal user resolves', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', authMethod: 'password', authEpoch: 1 };
    const res = await makeApp().request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cust@acme.example', orgId: ORG_ID }),
    });
    expect(res.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      actorId: USER_ID,
      action: 'portal.auth.password_reset.request',
      result: 'success',
    }));
  });

  it('records an attributable handler exception as failure and rethrows it', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', authEpoch: 1, receiveNotifications: true, status: 'invited' };
    const token = await storePortalInviteToken(USER_ID);
    updateSpy.mockImplementationOnce(() => { throw new Error('synthetic update failure'); });
    expect((await post({ token, password: 'Str0ngPass!' })).status).toBe(500);
    expect(auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      actorId: USER_ID,
      action: 'portal.auth.invite.accept',
      result: 'failure',
      details: { httpStatus: 500 },
    }));
  });
});

describe('POST /auth/accept-invite', () => {
  it('activates an invited user and issues a session', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', receiveNotifications: true, status: 'invited', authEpoch: 4 };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!', name: 'Cust Omer' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(USER_ID);
    expect(body.accessToken).toBeTruthy();
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', name: 'Cust Omer' }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ authEpoch: expect.anything() }));
    expect(auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      actorId: USER_ID,
      actorEmail: 'cust@acme.example',
      action: 'portal.auth.invite.accept',
      result: 'success',
    }));
  });

  it('rejects an invalid/expired token', async () => {
    const res = await post({ token: 'nope', password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
  });

  it('fails closed when a concurrent status transition advances the checked generation', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', receiveNotifications: true, status: 'invited', authEpoch: 4 };
    updateRows.current = [];
    const token = await storePortalInviteToken(USER_ID);

    const res = await post({ token, password: 'Str0ngPass!', name: 'Cust Omer' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired invite' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a disabled account, even with a valid consumed invite token', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', receiveNotifications: true, status: 'disabled' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an Entra identity even when staff minted it an invite token', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'entra@acme.example', name: null, passwordHash: null, authMethod: 'entra', receiveNotifications: true, status: 'active' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects when the account is already active with a password', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: 'X', passwordHash: 'existing-hash', authMethod: 'password', receiveNotifications: true, status: 'active' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a weak password', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'c@a.example', name: null, passwordHash: null, authMethod: 'password', receiveNotifications: true, status: 'invited' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/forgot-password', () => {
  it('does not mint or email a reset for an Entra identity', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'entra@acme.example', authMethod: 'entra' };
    const res = await forgot({ email: 'entra@acme.example', orgId: ORG_ID });
    expect(res.status).toBe(200);
    expect(sendPasswordResetSpy).not.toHaveBeenCalled();
  });
});
