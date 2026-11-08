import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { userRow, updateSpy, sendPasswordResetSpy, updateRows } = vi.hoisted(() => ({
  userRow: { current: null as any },
  updateSpy: vi.fn(),
  sendPasswordResetSpy: vi.fn(),
  updateRows: { current: null as Array<{ authEpoch: number; id?: string }> | null },
}));
const { auditSpy, activeOrgMock } = vi.hoisted(() => ({ auditSpy: vi.fn().mockResolvedValue(undefined), activeOrgMock: vi.fn() }));
// Accept-invite and reset re-check the org at consume (W2).
vi.mock('../../services/tenantStatus', () => ({ getActiveOrgTenant: activeOrgMock }));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: auditSpy,
}));

vi.mock('../../db', () => ({
  db: {
    // W04: forgot-password inner-joins organizations for the partner that owns
    // the portal user's org (spec §8.2), so the chain must accept innerJoin.
    select: () => { const chain: any = { innerJoin: () => chain, leftJoin: () => chain, where: () => chain, limit: () => Promise.resolve(userRow.current ? [userRow.current] : []) }; return { from: () => chain }; },
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
vi.mock('../../db/schema', () => ({ discoveredAssetTypeEnum: { enumValues: [] }, organizations: { id: 'id', partnerId: 'partnerId' }, partners: { id: 'id', name: 'name' }, portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', authMethod: 'authMethod', authEpoch: 'authEpoch', receiveNotifications: 'receiveNotifications', status: 'status', browserAccess: 'browserAccess', entraOid: 'entraOid' }, portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' } }));
vi.mock('../../services/email', () => ({ getEmailService: () => ({ sendPasswordReset: sendPasswordResetSpy }) }));

import { createHash } from 'crypto';
import { authRoutes } from './auth';
import { issuePortalCapabilityToken } from './capabilityTokens';
import { portalInviteTokens, portalRateLimitBuckets, portalResetTokens } from './helpers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const makeApp = () => { const app = new Hono(); app.route('/', authRoutes); return app; };
const post = (body: unknown) => makeApp().request('/auth/accept-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const forgot = (body: unknown) => makeApp().request('/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const reset = (body: unknown) => makeApp().request('/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A purpose-bound v2 invite for the current `userRow` (as the MSP invite route mints it). */
const mintInvite = (over: Partial<{ authEpoch: number; orgId: string; email: string }> = {}) => issuePortalCapabilityToken({
  purpose: 'invite',
  portalUserId: USER_ID,
  orgId: over.orgId ?? ORG_ID,
  email: over.email ?? userRow.current.email,
  authEpoch: over.authEpoch ?? userRow.current.authEpoch,
});
const mintReset = (over: Partial<{ authEpoch: number }> = {}) => issuePortalCapabilityToken({
  purpose: 'reset', portalUserId: USER_ID, orgId: ORG_ID, email: userRow.current.email, authEpoch: over.authEpoch ?? userRow.current.authEpoch,
});
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const invited = (over: Record<string, unknown> = {}) => ({
  id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password',
  receiveNotifications: true, status: 'invited', authEpoch: 4, browserAccess: 'granted', entraOid: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auditSpy.mockResolvedValue(undefined);
  activeOrgMock.mockResolvedValue({ orgId: ORG_ID, partnerId: 'p-1' });
  updateRows.current = null;
  userRow.current = null;
  portalInviteTokens.clear();
  portalResetTokens.clear();
  portalRateLimitBuckets.clear();
});

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
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', authEpoch: 1, receiveNotifications: true, status: 'invited', browserAccess: 'granted', entraOid: null };
    const token = await mintInvite();
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
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', receiveNotifications: true, status: 'invited', authEpoch: 4, browserAccess: 'granted', entraOid: null };
    const token = await mintInvite();
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
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password', receiveNotifications: true, status: 'invited', authEpoch: 4, browserAccess: 'granted', entraOid: null };
    updateRows.current = [];
    const token = await mintInvite();

    const res = await post({ token, password: 'Str0ngPass!', name: 'Cust Omer' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired invite' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a disabled account, even with a token bound to its current epoch (generic invite 400)', async () => {
    userRow.current = invited({ status: 'disabled' });
    const token = await mintInvite();
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired invite' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an Entra identity even when staff minted it an invite token', async () => {
    userRow.current = invited({ email: 'entra@acme.example', authMethod: 'entra', status: 'active', browserAccess: 'none', entraOid: 'oid-1' });
    const token = await mintInvite();
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects when the account is already active with a password', async () => {
    userRow.current = invited({ name: 'X', passwordHash: 'existing-hash', status: 'active' });
    const token = await mintInvite();
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a weak password', async () => {
    userRow.current = invited({ email: 'c@a.example' });
    const token = await mintInvite();
    const res = await post({ token, password: 'short' });
    expect(res.status).toBe(400);
  });

  // ---- W2: purpose-bound, atomically consumed, re-validated at consume ----

  it('accept-invite: a v2 token whose epoch moved (re-invite/disable since issue) → 400 Invalid or expired invite, no update', async () => {
    userRow.current = invited({ authEpoch: 5 });
    const token = await mintInvite({ authEpoch: 4 });
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired invite' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('accept-invite: a token bound to another org or another address → 400, no update', async () => {
    userRow.current = invited();
    const otherOrg = await mintInvite({ orgId: '7c0a1f7e-9999-4222-8333-444455556666' });
    expect((await post({ token: otherOrg, password: 'Str0ngPass!' })).status).toBe(400);
    const otherEmail = await mintInvite({ email: 'someone-else@acme.example' });
    expect((await post({ token: otherEmail, password: 'Str0ngPass!' })).status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // Review Focus 4: the invite link double-clicked / opened in two tabs.
  it('accept-invite: second use of the same token → 400 and only one session minted', async () => {
    userRow.current = invited();
    const token = await mintInvite();
    const first = await post({ token, password: 'Str0ngPass!' });
    expect(first.status).toBe(200);
    const second = await post({ token, password: 'Str0ngPass!' });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'Invalid or expired invite' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('accept-invite: org suspended between invite and accept → 403 PORTAL_ORG_UNAVAILABLE, no activation', async () => {
    userRow.current = invited();
    const token = await mintInvite();
    activeOrgMock.mockResolvedValue(null);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_ORG_UNAVAILABLE' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('accept-invite: weak password does not consume the token', async () => {
    userRow.current = invited();
    const token = await mintInvite();
    expect((await post({ token, password: 'short' })).status).toBe(400);
    expect((await post({ token, password: 'Str0ngPass!' })).status).toBe(200);
  });

  it('accept-invite: refuses a reset token presented as an invite', async () => {
    userRow.current = invited({ status: 'active', passwordHash: 'h' });
    const token = await mintReset();
    expect((await post({ token, password: 'Str0ngPass!' })).status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // Review Focus 2: invite emailed the day before deploy, clicked after.
  it('accept-invite: a legacy {portalUserId} invite still activates an invited row once', async () => {
    userRow.current = invited();
    portalInviteTokens.set(sha('legacy-invite'), { payload: JSON.stringify({ portalUserId: USER_ID }), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post({ token: 'legacy-invite', password: 'Str0ngPass!' })).status).toBe(200);
      expect((await post({ token: 'legacy-invite', password: 'Str0ngPass!' })).status).toBe(400);
    } finally {
      warn.mockRestore();
    }
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });
});

describe('POST /auth/reset-password (W2)', () => {
  it('resets the password for a token bound to the current epoch', async () => {
    userRow.current = invited({ status: 'active', passwordHash: 'old-hash' });
    const token = await mintReset();
    const res = await reset({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ passwordHash: expect.any(String) }));
  });

  it('reset-password: token issued, then password changed via profile (epoch +1) → 400, hash unchanged', async () => {
    userRow.current = invited({ status: 'active', passwordHash: 'old-hash', authEpoch: 5 });
    const token = await mintReset({ authEpoch: 4 });
    const res = await reset({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired reset token' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reset-password: legacy {userId} token → 400 Invalid or expired reset token', async () => {
    userRow.current = invited({ status: 'active', passwordHash: 'old-hash' });
    portalResetTokens.set(sha('legacy-reset'), { payload: JSON.stringify({ userId: USER_ID }), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    const res = await reset({ token: 'legacy-reset', password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired reset token' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reset-password: refuses a disabled account', async () => {
    userRow.current = invited({ status: 'disabled', passwordHash: 'old-hash' });
    const token = await mintReset();
    expect((await reset({ token, password: 'Str0ngPass!' })).status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reset-password: the token is single-use', async () => {
    userRow.current = invited({ status: 'active', passwordHash: 'old-hash' });
    const token = await mintReset();
    expect((await reset({ token, password: 'Str0ngPass!' })).status).toBe(200);
    expect((await reset({ token, password: 'Str0ngPass!' })).status).toBe(400);
    expect(updateSpy).toHaveBeenCalledTimes(1);
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
