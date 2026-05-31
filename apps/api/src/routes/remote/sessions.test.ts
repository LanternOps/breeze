import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Site-scope enforcement on remote-session mutation routes.
 *
 * Site-scope (`permissions.allowedSiteIds`) is an app-layer-only authz axis —
 * Postgres RLS does NOT defend it, and `allowedSiteIds` is only ever set for
 * org-scope users. Two mutations leaked across it:
 *
 *   1. DELETE /sessions/stale — when `deviceId` is OMITTED it fell through to
 *      org-only scoping and disconnected ALL stale sessions in the org,
 *      ignoring the caller's site allowlist.
 *   2. POST /sessions/:id/offer — `getSessionWithOrgCheck` only org-gates
 *      (unlike `getDeviceWithOrgCheck`), so a site-restricted caller could
 *      (re)start a live stream on a session whose device sits in another site.
 *
 * The mocked `requireScope` middleware seeds both `auth` and `permissions`;
 * an `x-restrict-site` header opts a request into a single-site allowlist.
 */

const {
  getDeviceWithOrgCheck,
  getSessionWithOrgCheck,
  revokeViewerSession,
  checkRemoteAccess,
  sendCommandToAgent,
} = vi.hoisted(() => ({
  getDeviceWithOrgCheck: vi.fn(),
  getSessionWithOrgCheck: vi.fn(),
  revokeViewerSession: vi.fn(() => Promise.resolve()),
  checkRemoteAccess: vi.fn(() => Promise.resolve({ allowed: true })),
  sendCommandToAgent: vi.fn(() => true),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    status: 'remoteSessions.status',
    deviceId: 'remoteSessions.deviceId',
    userId: 'remoteSessions.userId',
    webrtcOffer: 'remoteSessions.webrtcOffer',
    webrtcAnswer: 'remoteSessions.webrtcAnswer',
    endedAt: 'remoteSessions.endedAt',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    agentId: 'devices.agentId',
  },
  deviceHardware: { deviceId: 'deviceHardware.deviceId', gpuModel: 'deviceHardware.gpuModel' },
  users: {},
}));

// requireScope seeds auth + permissions; x-restrict-site opts into a single-site allowlist.
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      canAccessOrg: (id: string) => id === 'org-111',
    });
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', {
      permissions: [],
      partnerId: null,
      orgId: 'org-111',
      roleId: 'role-1',
      scope: 'organization',
      ...(restrict ? { allowedSiteIds: [restrict] } : {}),
    });
    return next();
  }),
}));

// Faithful canAccessSite so the route's site gate behaves like production.
vi.mock('../../services/permissions', () => ({
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(),
  getIceServers: vi.fn(() => []),
  getDeviceWithOrgCheck,
  getSessionWithOrgCheck,
  hasSessionOrTransferOwnership: vi.fn(() => true),
  checkSessionRateLimit: vi.fn(),
  checkUserSessionRateLimit: vi.fn(),
  logSessionAudit: vi.fn(),
  MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG: 10,
  MAX_ACTIVE_REMOTE_SESSIONS_PER_USER: 5,
}));

vi.mock('../../services/viewerTokenRevocation', () => ({ revokeViewerSession }));

vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess,
  resolveDesktopSessionPolicy: vi.fn(() =>
    Promise.resolve({ clipboard: 'both', idleTimeoutMinutes: 0, maxSessionDurationHours: 0 })
  ),
}));

vi.mock('../agentWs', () => ({ sendCommandToAgent }));

vi.mock('../../services/remoteSessionAuth', () => ({
  createDesktopConnectCode: vi.fn(),
  createWsTicket: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '10.0.0.1'),
  getTrustedClientIpOrUndefined: vi.fn(() => '10.0.0.1'),
}));

vi.mock('./recordingUrl', () => ({ normalizeRecordingUrl: vi.fn((u: unknown) => u) }));

import { sessionRoutes } from './sessions';
import { db } from '../../db';

const ORG_ID = 'org-111';
const ALLOWED_SITE = 'site-a';
const FORBIDDEN_SITE = 'site-b';
const DEVICE_IN_ALLOWED = '11111111-1111-4111-8111-111111111111';
const DEVICE_IN_FORBIDDEN = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

// DELETE /sessions/stale, no deviceId: first select resolves org devices (id+siteId),
// then select of stale session ids, then update().returning().
function rigStaleNarrowing(orgDevices: Array<{ id: string; siteId: string | null }>, staleIds: string[]) {
  // org-device resolution: db.select(...).from(devices).where(...) -> Promise<rows>
  const deviceWhere = vi.fn().mockResolvedValue(orgDevices);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: deviceWhere }),
  } as never);
  // stale session select: db.select(...).from().innerJoin().where() -> Promise<rows>
  const staleWhere = vi.fn().mockResolvedValue(staleIds.map((id) => ({ id })));
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: staleWhere }) }),
  } as never);
  // update().set().where().returning()
  const returning = vi.fn().mockResolvedValue(staleIds.map((id) => ({ id })));
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
  } as never);
  return { deviceWhere, staleWhere };
}

// DELETE /sessions/stale, unrestricted (no narrowing select): just the stale select + update.
function rigStaleUnrestricted(staleIds: string[]) {
  const staleWhere = vi.fn().mockResolvedValue(staleIds.map((id) => ({ id })));
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: staleWhere }) }),
  } as never);
  const returning = vi.fn().mockResolvedValue(staleIds.map((id) => ({ id })));
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
  } as never);
  return { staleWhere };
}

describe('remote sessions — site-scope enforcement', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceWithOrgCheck.mockReset();
    getSessionWithOrgCheck.mockReset();
    checkRemoteAccess.mockReturnValue(Promise.resolve({ allowed: true }));
    sendCommandToAgent.mockReturnValue(true);
    app = new Hono();
    app.route('/remote', sessionRoutes);
  });

  describe('DELETE /sessions/stale', () => {
    it('narrows to allowed-site devices when caller is site-restricted and no deviceId is given', async () => {
      const { staleWhere } = rigStaleNarrowing(
        [
          { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
          { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
        ],
        ['sess-allowed']
      );

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cleaned).toBe(1);
      // The stale-session select must have been constrained (the device-id
      // narrowing condition was pushed), so the where clause was invoked.
      expect(staleWhere).toHaveBeenCalledTimes(1);
    });

    it('returns {cleaned:0} without touching sessions when caller has no in-scope devices', async () => {
      // org devices are all in the forbidden site -> no allowed device ids
      const deviceWhere = vi
        .fn()
        .mockResolvedValue([{ id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE }]);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: deviceWhere }),
      } as never);

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleaned: 0, ids: [] });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 403 when a site-restricted caller targets an out-of-scope deviceId (guard)', async () => {
      getDeviceWithOrgCheck.mockResolvedValue('SITE_ACCESS_DENIED');

      const res = await app.request(`/remote/sessions/stale?deviceId=${DEVICE_IN_FORBIDDEN}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
    });

    it('does not narrow for unrestricted callers (no behavior change)', async () => {
      const { staleWhere } = rigStaleUnrestricted(['sess-1', 'sess-2']);

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cleaned).toBe(2);
      // Only the stale-session select ran — no org-device narrowing query.
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(staleWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /sessions/:id/offer', () => {
    const offerBody = JSON.stringify({ offer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n' });

    function rigOfferUpdate(updatedStatus = 'connecting') {
      const returning = vi
        .fn()
        .mockResolvedValue([{ id: SESSION_ID, status: updatedStatus, webrtcOffer: 'v=0\r\n' }]);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
      } as never);
      // device hardware lookup (gpu) — select().from().where().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as never);
    }

    it('returns 403 when caller is site-restricted away from the session device site', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'pending', deviceId: DEVICE_IN_FORBIDDEN },
        device: { id: DEVICE_IN_FORBIDDEN, orgId: ORG_ID, siteId: FORBIDDEN_SITE, agentId: 'agent-1' },
      });

      const res = await app.request(`/remote/sessions/${SESSION_ID}/offer`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', 'x-restrict-site': ALLOWED_SITE },
        body: offerBody,
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 403 when the session device has a null siteId and caller is site-restricted', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'pending', deviceId: DEVICE_IN_ALLOWED },
        device: { id: DEVICE_IN_ALLOWED, orgId: ORG_ID, siteId: null, agentId: 'agent-1' },
      });

      const res = await app.request(`/remote/sessions/${SESSION_ID}/offer`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', 'x-restrict-site': ALLOWED_SITE },
        body: offerBody,
      });

      expect(res.status).toBe(403);
    });

    it('allows the offer when caller is restricted to the session device site', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'pending', deviceId: DEVICE_IN_ALLOWED },
        device: { id: DEVICE_IN_ALLOWED, orgId: ORG_ID, siteId: ALLOWED_SITE, agentId: 'agent-1' },
      });
      rigOfferUpdate();

      const res = await app.request(`/remote/sessions/${SESSION_ID}/offer`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', 'x-restrict-site': ALLOWED_SITE },
        body: offerBody,
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('allows the offer for an unrestricted caller regardless of device site (no behavior change)', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'pending', deviceId: DEVICE_IN_FORBIDDEN },
        device: { id: DEVICE_IN_FORBIDDEN, orgId: ORG_ID, siteId: FORBIDDEN_SITE, agentId: 'agent-1' },
      });
      rigOfferUpdate();

      const res = await app.request(`/remote/sessions/${SESSION_ID}/offer`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: offerBody,
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });
});
