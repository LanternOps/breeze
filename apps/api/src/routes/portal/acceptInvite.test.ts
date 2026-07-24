import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { userRow, updateSpy } = vi.hoisted(() => ({
  userRow: { current: null as any },
  updateSpy: vi.fn()
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(userRow.current ? [userRow.current] : []) }) }) }),
    update: () => ({ set: (v: any) => ({ where: () => { updateSpy(v); return Promise.resolve(); } }) })
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
vi.mock('../../db/schema', () => ({ discoveredAssetTypeEnum: { enumValues: [] }, portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', receiveNotifications: 'receiveNotifications', status: 'status' } }));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

import { authRoutes } from './auth';
import { storePortalInviteToken } from './helpers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const makeApp = () => { const app = new Hono(); app.route('/', authRoutes); return app; };
const post = (body: unknown) => makeApp().request('/auth/accept-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); userRow.current = null; });

describe('POST /auth/accept-invite', () => {
  it('activates an invited user and issues a session', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, receiveNotifications: true, status: 'invited' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!', name: 'Cust Omer' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(USER_ID);
    expect(body.accessToken).toBeTruthy();
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', name: 'Cust Omer' }));
  });

  it('rejects an invalid/expired token', async () => {
    const res = await post({ token: 'nope', password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
  });

  it('rejects a disabled account, even with a valid consumed invite token', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, receiveNotifications: true, status: 'disabled' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects when the account is already active with a password', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: 'X', passwordHash: 'existing-hash', receiveNotifications: true, status: 'active' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a weak password', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'c@a.example', name: null, passwordHash: null, receiveNotifications: true, status: 'invited' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'short' });
    expect(res.status).toBe(400);
  });
});
