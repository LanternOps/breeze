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
  getPagination,
  teardownDisconnectedSessions,
  checkSessionRateLimit,
  checkUserSessionRateLimit,
  evaluateCapability,
  partnerIdForDevice,
  partnerTrustMode,
  createDesktopConnectCode,
  createWsTicket,
  dispatchCommandToAgent,
  captureMessage,
  captureException,
} = vi.hoisted(() => ({
  getDeviceWithOrgCheck: vi.fn(),
  getSessionWithOrgCheck: vi.fn(),
  revokeViewerSession: vi.fn(() => Promise.resolve()),
  checkRemoteAccess: vi.fn(() => Promise.resolve({ allowed: true })),
  sendCommandToAgent: vi.fn(() => true),
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  teardownDisconnectedSessions: vi.fn(() => Promise.resolve(undefined)),
  checkSessionRateLimit: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 0 })),
  checkUserSessionRateLimit: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 0 })),
  evaluateCapability: vi.fn(async (): Promise<any> => ({ allow: true })),
  partnerIdForDevice: vi.fn(() => Promise.resolve('partner-1')),
  partnerTrustMode: vi.fn(() => 'off'),
  createDesktopConnectCode: vi.fn(),
  createWsTicket: vi.fn(),
  dispatchCommandToAgent: vi.fn(
    async (): Promise<{ status: string; via?: string; message?: string }> => ({ status: 'sent', via: 'local' })
  ),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// `runOutsideDbContext` is synchronous (wraps AsyncLocalStorage.exit); the real
// impl just calls its argument outside the current context. `withSystemDbAccessContext`
// similarly just runs its callback. Both pass through so the org->partner lookup
// (which must escape the request's org-scoped RLS context to read `partners`) works
// under this file's plain db mock. See helpers.test.ts for the same convention.
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    status: 'remoteSessions.status',
    deviceId: 'remoteSessions.deviceId',
    orgId: 'remoteSessions.orgId',
    userId: 'remoteSessions.userId',
    type: 'remoteSessions.type',
    webrtcOffer: 'remoteSessions.webrtcOffer',
    webrtcAnswer: 'remoteSessions.webrtcAnswer',
    startedAt: 'remoteSessions.startedAt',
    endedAt: 'remoteSessions.endedAt',
    durationSeconds: 'remoteSessions.durationSeconds',
    bytesTransferred: 'remoteSessions.bytesTransferred',
    recordingUrl: 'remoteSessions.recordingUrl',
    createdAt: 'remoteSessions.createdAt',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    agentId: 'devices.agentId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
  },
  deviceHardware: { deviceId: 'deviceHardware.deviceId', gpuModel: 'deviceHardware.gpuModel' },
  users: { id: 'users.id', name: 'users.name', email: 'users.email' },
  organizations: { id: 'organizations.id', name: 'organizations.name', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', name: 'partners.name' },
}));

// requireScope seeds auth; requirePermission seeds permissions (mirrors prod — only
// requirePermission populates c.get('permissions'), which the site-scope gate reads).
// x-restrict-site opts into a single-site allowlist.
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    const restrict = c.req.header('x-restrict-site');
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      canAccessOrg: (id: string) => id === 'org-111',
    });
    // The production parent router runs requirePermission(REMOTE_ACCESS)
    // before these child routes. Seed its resulting live permission context
    // here because this focused suite mounts sessionRoutes directly.
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
  requirePermission: vi.fn(() => async (c: any, next: any) => {
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
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    REMOTE_ACCESS: { resource: 'remote', action: 'access' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('./helpers', () => ({
  getPagination,
  getIceServers: vi.fn(() => []),
  getDeviceWithOrgCheck,
  getSessionWithOrgCheck,
  hasSessionOwnership: vi.fn(() => true),
  checkSessionRateLimit,
  checkUserSessionRateLimit,
  logSessionAudit: vi.fn(),
  // Default to "no prompt" (mode 'off' equivalent) so the offer handler ships
  // no prompt block — keeps these site-scope tests focused. The prompt
  // construction itself (partner-name redaction etc.) is covered by the
  // buildRemoteSessionPromptPayload suite in helpers.test.ts.
  buildRemoteSessionPromptPayload: vi.fn(async () => undefined),
  createDesktopStartCommandId: vi.fn((sessionId: string) =>
    `desk-start-${sessionId}-22222222-2222-4222-8222-222222222222`
  ),
  MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG: 10,
  MAX_ACTIVE_REMOTE_SESSIONS_PER_USER: 5,
}));

vi.mock('../../services/viewerTokenRevocation', () => ({ revokeViewerSession }));

// The stale-sweep (DELETE /sessions/stale) and the in-create sweep (POST
// /sessions) both push `teardownDisconnectedSessions(rows)` to stop the live
// agent stream after marking rows disconnected. Mock the service so we can
// assert the wiring (and so the real one doesn't fire its own extra db.select
// against this file's mock db).
vi.mock('../../services/remoteSessionTeardown', () => ({
  teardownDisconnectedSessions: teardownDisconnectedSessions,
  // Re-export the real value: both End guards are driven off it, so a mock
  // that dropped it would make the route compare against `undefined`.
  ACTIVE_REMOTE_SESSION_STATUSES: ['pending', 'connecting', 'active'] as const,
}));

vi.mock('../../services/sentry', () => ({ captureMessage, captureException }));

vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess,
  resolveDesktopSessionPolicy: vi.fn(() =>
    Promise.resolve({ clipboard: 'both', idleTimeoutMinutes: 0, maxSessionDurationHours: 0 })
  ),
}));

vi.mock('../agentWs', () => ({ sendCommandToAgent }));

vi.mock('../../services/agentCommandRelay', () => ({ dispatchCommandToAgent }));

vi.mock('../../services/remoteSessionAuth', () => ({
  createDesktopConnectCode,
  createWsTicket,
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '10.0.0.1'),
  getTrustedClientIpOrUndefined: vi.fn(() => '10.0.0.1'),
}));

vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode }));
vi.mock('../../services/partnerTrust', () => ({
  evaluateCapability,
  partnerIdForDevice,
  trustDenyBody: (d: Record<string, unknown>, reviewRequested: boolean) => ({
    error: d.code,
    capability: d.capability,
    reason: d.reason,
    reviewRequested,
    meetingUrl: null,
  }),
}));

const isRevocationLeaseCapable = vi.fn<() => Promise<boolean>>(async () => true);
const LEASE_FIXTURE = {
  token: 'lease-token',
  expiresAt: 1_000_060_000,
  hardDeadline: 1_000_600_000,
  renewEverySec: 25,
  graceSec: 90,
};
const prepareRevocationLeaseForStart = vi.fn<() => Promise<
  { ok: true; lease: typeof LEASE_FIXTURE } | { ok: false; reason: string }
>>(async () => ({ ok: true, lease: LEASE_FIXTURE }));
const renewRevocationLease = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
  status: 'renewed', expiresAt: 1, hardDeadline: 2, renewEverySec: 25, graceSec: 90,
}));
vi.mock('../../services/remoteRevocationLease', () => ({
  AGENT_UPGRADE_REQUIRED_CODE: 'agent_upgrade_required',
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'agent update required',
  isRevocationLeaseCapable: (...a: unknown[]) => isRevocationLeaseCapable(...(a as [])),
  prepareRevocationLeaseForStart: (...a: unknown[]) => prepareRevocationLeaseForStart(...(a as [])),
  renewRevocationLease: (...a: unknown[]) => renewRevocationLease(...(a as [])),
}));

vi.mock('./recordingUrl', () => ({ normalizeRecordingUrl: vi.fn((u: unknown) => u) }));

import { sessionRoutes } from './sessions';
import { db } from '../../db';
import { buildRemoteSessionPromptPayload } from './helpers';

const ORG_ID = 'org-111';
const ALLOWED_SITE = 'site-a';
const FORBIDDEN_SITE = 'site-b';
const DEVICE_IN_ALLOWED = '11111111-1111-4111-8111-111111111111';
const DEVICE_IN_FORBIDDEN = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function conditionContainsSiteScope(condition: unknown, siteId = ALLOWED_SITE): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return false;
  const hasSiteColumn = chunks.some((chunk) => chunk === 'devices.siteId' || conditionContainsSiteScope(chunk, siteId));
  const hasAllowedSites = chunks.some((chunk) => Array.isArray(chunk) && chunk.includes(siteId));
  return hasSiteColumn && (hasAllowedSites || chunks.some((chunk) => conditionContainsSiteScope(chunk, siteId)));
}

function makeRemoteSessionRow(deviceId: string) {
  return {
    id: SESSION_ID,
    deviceId,
    userId: 'user-1',
    type: 'desktop',
    status: 'active',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: null,
    durationSeconds: null,
    bytesTransferred: null,
    recordingUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deviceHostname: 'host-1',
    deviceOsType: 'linux',
    userName: 'Test User',
    userEmail: 'test@example.com',
  };
}

// DELETE /sessions/stale, no deviceId: the device/site subquery is embedded in
// the one atomic update().where().returning() claim.
function rigStaleNarrowing(staleIds: string[]) {
  const deviceWhere = vi.fn().mockReturnValue({ __siteScopedDeviceSubquery: true });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: deviceWhere }),
  } as never);
  const staleWhere = vi.fn();
  const returning = vi
    .fn()
    .mockResolvedValue(staleIds.map((id) => ({ id, type: 'desktop', deviceId: DEVICE_IN_ALLOWED })));
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: staleWhere.mockReturnValue({ returning }) }),
  } as never);
  return { deviceWhere, staleWhere };
}

// DELETE /sessions/stale, unrestricted: one atomic update, no device query.
function rigStaleUnrestricted(staleIds: string[]) {
  const staleWhere = vi.fn();
  const returning = vi
    .fn()
    .mockResolvedValue(staleIds.map((id) => ({ id, type: 'desktop', deviceId: DEVICE_IN_ALLOWED })));
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: staleWhere.mockReturnValue({ returning }) }),
  } as never);
  return { staleWhere };
}

function rigLockedCleanupDevice(siteId: string | null, orgId = ORG_ID) {
  const forUpdate = vi.fn().mockResolvedValue([{
    id: DEVICE_IN_ALLOWED,
    orgId,
    siteId,
  }]);
  const limit = vi.fn().mockReturnValue({ for: forUpdate });
  const where = vi.fn().mockReturnValue({ limit });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where }),
  } as never);
  return { forUpdate, where };
}

describe('remote sessions — site-scope enforcement', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    getDeviceWithOrgCheck.mockReset();
    getSessionWithOrgCheck.mockReset();
    getPagination.mockReturnValue({ page: 1, limit: 50, offset: 0 });
    checkRemoteAccess.mockReturnValue(Promise.resolve({ allowed: true }));
    sendCommandToAgent.mockReturnValue(true);
    teardownDisconnectedSessions.mockReset();
    teardownDisconnectedSessions.mockResolvedValue(undefined);
    checkSessionRateLimit.mockResolvedValue({ allowed: true, currentCount: 0 });
    checkUserSessionRateLimit.mockResolvedValue({ allowed: true, currentCount: 0 });
    app = new Hono();
    app.route('/remote', sessionRoutes);
  });

  describe('GET /sessions', () => {
    function rigListSessions(
      orgDevices: Array<{ id: string; siteId: string | null }> | null,
      rows: Array<ReturnType<typeof makeRemoteSessionRow>>,
    ) {
      if (orgDevices) {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(orgDevices) }),
        } as never);
      }

      const countWhere = vi.fn((condition: unknown) => {
        expect(conditionContainsSiteScope(condition)).toBe(true);
        return Promise.resolve([{ count: rows.length }]);
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: countWhere }),
        }),
      } as never);

      const listWhere = vi.fn((condition: unknown) => {
        expect(conditionContainsSiteScope(condition)).toBe(true);
        return {
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
          }),
        };
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({ where: listWhere }),
          }),
        }),
      } as never);
      return { countWhere, listWhere };
    }

    function rigListSessionsUnrestricted(rows: Array<ReturnType<typeof makeRemoteSessionRow>>) {
      const countWhere = vi.fn().mockResolvedValue([{ count: rows.length }]);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: countWhere }),
        }),
      } as never);

      const listWhere = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
        }),
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({ where: listWhere }),
          }),
        }),
      } as never);
      return { countWhere, listWhere };
    }

    it('returns 403 when a site-restricted caller filters by an out-of-scope deviceId', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
            { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
          ]),
        }),
      } as never);

      const res = await app.request(`/remote/sessions?deviceId=${DEVICE_IN_FORBIDDEN}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
    });

    it('narrows the active session list to the caller allowed sites', async () => {
      const { countWhere, listWhere } = rigListSessions(
        [
          { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
          { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
        ],
        [makeRemoteSessionRow(DEVICE_IN_ALLOWED)]
      );

      const res = await app.request('/remote/sessions', {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(DEVICE_IN_ALLOWED);
      expect(body.pagination.total).toBe(1);
      expect(countWhere).toHaveBeenCalledTimes(1);
      expect(listWhere).toHaveBeenCalledTimes(1);
    });

    it('does not narrow the active session list for unrestricted callers', async () => {
      const { countWhere, listWhere } = rigListSessionsUnrestricted([
        makeRemoteSessionRow(DEVICE_IN_ALLOWED),
        makeRemoteSessionRow(DEVICE_IN_FORBIDDEN),
      ]);

      const res = await app.request('/remote/sessions', {
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(countWhere).toHaveBeenCalledTimes(1);
      expect(listWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /sessions/history', () => {
    function rigSessionHistory(
      orgDevices: Array<{ id: string; siteId: string | null }> | null,
      rows: Array<ReturnType<typeof makeRemoteSessionRow>>,
    ) {
      if (orgDevices) {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(orgDevices) }),
        } as never);
      }

      const statsWhere = vi.fn((condition: unknown) => {
        expect(conditionContainsSiteScope(condition)).toBe(true);
        return Promise.resolve([{ count: rows.length, totalDuration: 90, avgDuration: 45 }]);
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: statsWhere }),
        }),
      } as never);

      const listWhere = vi.fn((condition: unknown) => {
        expect(conditionContainsSiteScope(condition)).toBe(true);
        return {
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
          }),
        };
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({ where: listWhere }),
          }),
        }),
      } as never);
      return { statsWhere, listWhere };
    }

    function rigSessionHistoryUnrestricted(rows: Array<ReturnType<typeof makeRemoteSessionRow>>) {
      const statsWhere = vi.fn().mockResolvedValue([{ count: rows.length, totalDuration: 90, avgDuration: 45 }]);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: statsWhere }),
        }),
      } as never);

      const listWhere = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
        }),
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({ where: listWhere }),
          }),
        }),
      } as never);
      return { statsWhere, listWhere };
    }

    it('returns 403 when a site-restricted caller filters history by an out-of-scope deviceId', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
            { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
          ]),
        }),
      } as never);

      const res = await app.request(`/remote/sessions/history?deviceId=${DEVICE_IN_FORBIDDEN}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
    });

    it('narrows session history and stats to the caller allowed sites', async () => {
      const row = { ...makeRemoteSessionRow(DEVICE_IN_ALLOWED), status: 'disconnected' };
      const { statsWhere, listWhere } = rigSessionHistory(
        [
          { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
          { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
        ],
        [row]
      );

      const res = await app.request('/remote/sessions/history', {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(DEVICE_IN_ALLOWED);
      expect(body.stats.totalSessions).toBe(1);
      expect(statsWhere).toHaveBeenCalledTimes(1);
      expect(listWhere).toHaveBeenCalledTimes(1);
    });

    it('does not narrow session history for unrestricted callers', async () => {
      const { statsWhere, listWhere } = rigSessionHistoryUnrestricted([
        { ...makeRemoteSessionRow(DEVICE_IN_ALLOWED), status: 'disconnected' },
        { ...makeRemoteSessionRow(DEVICE_IN_FORBIDDEN), status: 'failed' },
      ]);

      const res = await app.request('/remote/sessions/history', {
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.stats.totalSessions).toBe(2);
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(statsWhere).toHaveBeenCalledTimes(1);
      expect(listWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe('DELETE /sessions/stale', () => {
    it('narrows to allowed-site devices when caller is site-restricted and no deviceId is given', async () => {
      const { deviceWhere, staleWhere } = rigStaleNarrowing(['sess-allowed']);

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cleaned).toBe(1);
      expect(deviceWhere).toHaveBeenCalledTimes(1);
      // Freshness, ownership, tenant and current-site scope are claimed in
      // one UPDATE predicate rather than a stale SELECT-id snapshot.
      expect(staleWhere).toHaveBeenCalledTimes(1);
      // Wiring: the disconnected rows must be handed to the agent-stop teardown,
      // shaped {id,type,deviceId}. Dropping this call silently reintroduces the
      // "live stream survives a /stale sweep" vulnerability (PR #1283).
      expect(teardownDisconnectedSessions).toHaveBeenCalledTimes(1);
      expect(teardownDisconnectedSessions).toHaveBeenCalledWith([
        { id: 'sess-allowed', type: 'desktop', deviceId: DEVICE_IN_ALLOWED },
      ]);
    });

    it('returns {cleaned:0} without touching sessions when caller has no in-scope devices', async () => {
      rigStaleNarrowing([]);

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleaned: 0, ids: [] });
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('returns 403 when a site-restricted caller targets an out-of-scope deviceId (guard)', async () => {
      const { forUpdate } = rigLockedCleanupDevice(FORBIDDEN_SITE);

      const res = await app.request(`/remote/sessions/stale?deviceId=${DEVICE_IN_FORBIDDEN}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      expect(forUpdate).toHaveBeenCalledWith('update');
      expect(db.update).not.toHaveBeenCalled();
      expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
    });

    it('fails closed before effects when an exact cleanup device has no site', async () => {
      rigLockedCleanupDevice(null);

      const res = await app.request(`/remote/sessions/stale?deviceId=${DEVICE_IN_ALLOWED}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
      expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
    });

    it('locks an allowed exact device before atomically claiming only its stale sessions', async () => {
      const { forUpdate } = rigLockedCleanupDevice(ALLOWED_SITE);
      const returning = vi.fn().mockResolvedValue([
        { id: 'sess-allowed', type: 'desktop', deviceId: DEVICE_IN_ALLOWED },
      ]);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning }),
        }),
      } as never);

      const res = await app.request(`/remote/sessions/stale?deviceId=${DEVICE_IN_ALLOWED}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleaned: 1, ids: ['sess-allowed'] });
      expect(forUpdate).toHaveBeenCalledWith('update');
      expect(teardownDisconnectedSessions).toHaveBeenCalledWith([
        { id: 'sess-allowed', type: 'desktop', deviceId: DEVICE_IN_ALLOWED },
      ]);
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
      expect(db.select).not.toHaveBeenCalled();
      expect(staleWhere).toHaveBeenCalledTimes(1);
      // Wiring: even on the unrestricted path the disconnected rows are torn down.
      expect(teardownDisconnectedSessions).toHaveBeenCalledTimes(1);
      expect(teardownDisconnectedSessions).toHaveBeenCalledWith([
        { id: 'sess-1', type: 'desktop', deviceId: DEVICE_IN_ALLOWED },
        { id: 'sess-2', type: 'desktop', deviceId: DEVICE_IN_ALLOWED },
      ]);
    });

    it('does not call the agent-stop teardown when no in-scope devices exist', async () => {
      rigStaleNarrowing([]);

      const res = await app.request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleaned: 0, ids: [] });
      expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
    });
  });

  describe('POST /sessions — in-create stale sweep', () => {
    // POST /sessions terminates lingering sessions for the device+type before
    // creating the new one. That sweep marks rows disconnected then must push
    // teardownDisconnectedSessions(rows) so a still-live desktop/terminal for a
    // stale row gets the agent stop — not just a DB flip. Wiring guard (PR #1283).
    function rigCreateSession(staleRows: Array<{ id: string; type: string; deviceId: string }>) {
      // 1. stale-terminate UPDATE: chain exposes a `.returning()` fn that the
      //    route detects (typeof === 'function') and awaits.
      const staleReturning = vi.fn().mockResolvedValue(staleRows);
      const staleWhere = vi.fn().mockReturnValue({ returning: staleReturning });
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: staleWhere }),
      } as never);

      // 2. INSERT ... returning() → the created session row.
      const insertReturning = vi.fn().mockResolvedValue([
        {
          id: SESSION_ID,
          deviceId: DEVICE_IN_ALLOWED,
          userId: 'user-1',
          type: 'desktop',
          status: 'pending',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      (db as any).insert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      // 3. createRemoteSession reads users.permissions_epoch as the revocation-
      //    lease baseline; without it a desktop create 503s (an unrenewable
      //    session is refused rather than minted).
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ permissionsEpoch: 1 }]),
          }),
        }),
      } as never);
      return { staleReturning };
    }

    it('tears down the swept stale sessions before creating the new one', async () => {
      getDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_IN_ALLOWED,
        orgId: ORG_ID,
        siteId: ALLOWED_SITE,
        agentId: 'agent-1',
        hostname: 'host-1',
        osType: 'linux',
        status: 'online',
      });
      const staleRows = [{ id: 'stale-1', type: 'desktop', deviceId: DEVICE_IN_ALLOWED }];
      rigCreateSession(staleRows);

      const res = await app.request('/remote/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_IN_ALLOWED, type: 'desktop' }),
      });

      expect(res.status).toBe(201);
      // Wiring: the swept {id,type,deviceId} rows must be handed to the
      // agent-stop teardown. Dropping this reintroduces the "stale row left a
      // live stream running" hole.
      expect(teardownDisconnectedSessions).toHaveBeenCalledTimes(1);
      expect(teardownDisconnectedSessions).toHaveBeenCalledWith(staleRows);
    });

    it('maps partner-trust denial to a 403 without inserting', async () => {
      getDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_IN_ALLOWED,
        orgId: ORG_ID,
        siteId: ALLOWED_SITE,
        agentId: 'agent-1',
        hostname: 'host-1',
        osType: 'linux',
        status: 'online',
      });
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      } as never);
      partnerTrustMode.mockReturnValueOnce('enforce');
      evaluateCapability.mockResolvedValueOnce({
        allow: false,
        code: 'TRUST_PROBATION',
        capability: 'remote_control',
        reason: 'probation_default_deny',
      });

      const res = await app.request('/remote/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_IN_ALLOWED, type: 'desktop' }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(expect.objectContaining({
        error: 'TRUST_PROBATION',
        capability: 'remote_control',
      }));
      expect((db as any).insert).not.toHaveBeenCalled();
    });
  });

  describe('GET /sessions/:id', () => {
    it('returns 403 when caller is site-restricted away from the session device site', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'active', deviceId: DEVICE_IN_FORBIDDEN },
        device: { id: DEVICE_IN_FORBIDDEN, orgId: ORG_ID, siteId: FORBIDDEN_SITE, agentId: 'agent-1', hostname: 'h', osType: 'linux', status: 'online' },
      });

      const res = await app.request(`/remote/sessions/${SESSION_ID}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      // Must not leak webrtc/ice payload.
      expect(body).not.toHaveProperty('webrtcOffer');
    });

    it('returns 403 when the session device has a null siteId and caller is site-restricted', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'active', deviceId: DEVICE_IN_ALLOWED },
        device: { id: DEVICE_IN_ALLOWED, orgId: ORG_ID, siteId: null, agentId: 'agent-1', hostname: 'h', osType: 'linux', status: 'online' },
      });

      const res = await app.request(`/remote/sessions/${SESSION_ID}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
    });

    it('returns the session detail when caller is restricted to the session device site', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'active', deviceId: DEVICE_IN_ALLOWED, webrtcOffer: 'v=0', webrtcAnswer: null, iceCandidates: [], startedAt: null, endedAt: null, durationSeconds: null, bytesTransferred: null, recordingUrl: null, errorMessage: null, createdAt: new Date('2026-01-01T00:00:00Z') },
        device: { id: DEVICE_IN_ALLOWED, orgId: ORG_ID, siteId: ALLOWED_SITE, agentId: 'agent-1', hostname: 'h', osType: 'linux', status: 'online' },
      });
      // user info lookup: select().from().where().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ name: 'Test User', email: 'test@example.com' }]) }),
        }),
      } as never);

      const res = await app.request(`/remote/sessions/${SESSION_ID}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(SESSION_ID);
    });

    it('returns the session detail for an unrestricted caller regardless of device site', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'active', deviceId: DEVICE_IN_FORBIDDEN, webrtcOffer: 'v=0', webrtcAnswer: null, iceCandidates: [], startedAt: null, endedAt: null, durationSeconds: null, bytesTransferred: null, recordingUrl: null, errorMessage: null, createdAt: new Date('2026-01-01T00:00:00Z') },
        device: { id: DEVICE_IN_FORBIDDEN, orgId: ORG_ID, siteId: FORBIDDEN_SITE, agentId: 'agent-1', hostname: 'h', osType: 'linux', status: 'online' },
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ name: 'Test User', email: 'test@example.com' }]) }),
        }),
      } as never);

      const res = await app.request(`/remote/sessions/${SESSION_ID}`, {
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(SESSION_ID);
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

    it('ships the prompt block from buildRemoteSessionPromptPayload in the start_desktop payload', async () => {
      getSessionWithOrgCheck.mockResolvedValue({
        session: { id: SESSION_ID, userId: 'user-1', type: 'desktop', status: 'pending', deviceId: DEVICE_IN_ALLOWED },
        device: { id: DEVICE_IN_ALLOWED, orgId: ORG_ID, siteId: ALLOWED_SITE, agentId: 'agent-1' },
      });
      rigOfferUpdate();

      const prompt = {
        mode: 'notify',
        technicianName: 'Billy Tech',
        technicianEmail: 'billy@example.com',
        orgName: 'Olive Technology',
        consentUnavailableBehavior: 'proceed',
        consentTimeoutMs: 30000,
        notifyOnEnd: true,
        showIndicator: true,
      };
      vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce(prompt);

      const res = await app.request(`/remote/sessions/${SESSION_ID}/offer`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', 'x-restrict-site': ALLOWED_SITE },
        body: offerBody,
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(buildRemoteSessionPromptPayload)).toHaveBeenCalledWith(
        expect.objectContaining({ id: DEVICE_IN_ALLOWED, orgId: ORG_ID }),
        'user-1',
      );
      const call = vi.mocked(sendCommandToAgent).mock.calls.at(-1) as unknown as [string, { payload: Record<string, unknown> }];
      expect(call[1].payload.prompt).toEqual(prompt);
    });
  });

  describe('existing-session capability reauthorization', () => {
    const forbidden = {
      session: {
        id: SESSION_ID,
        userId: 'user-1',
        type: 'desktop',
        status: 'connecting',
        deviceId: DEVICE_IN_FORBIDDEN,
        iceCandidates: [],
      },
      device: {
        id: DEVICE_IN_FORBIDDEN,
        orgId: ORG_ID,
        siteId: FORBIDDEN_SITE,
        agentId: 'agent-1',
      },
    };

    it.each([
      {
        label: 'WebSocket ticket',
        path: `/remote/sessions/${SESSION_ID}/ws-ticket`,
        method: 'POST',
        body: undefined,
      },
      {
        label: 'desktop connect code',
        path: `/remote/sessions/${SESSION_ID}/desktop-connect-code`,
        method: 'POST',
        body: undefined,
      },
      {
        label: 'ICE server credentials',
        path: `/remote/ice-servers?sessionId=${SESSION_ID}`,
        method: 'GET',
        body: undefined,
      },
      {
        label: 'WebRTC answer',
        path: `/remote/sessions/${SESSION_ID}/answer`,
        method: 'POST',
        body: JSON.stringify({ answer: 'v=0' }),
      },
      {
        label: 'ICE candidate',
        path: `/remote/sessions/${SESSION_ID}/ice`,
        method: 'POST',
        body: JSON.stringify({ candidate: { candidate: 'candidate:1' } }),
      },
    ])('denies $label after site access is revoked, before any side effect', async ({ path, method, body }) => {
      getSessionWithOrgCheck.mockResolvedValue(forbidden);

      const res = await app.request(path, {
        method,
        headers: {
          Authorization: 'Bearer t',
          'x-restrict-site': ALLOWED_SITE,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
      });

      if (path.endsWith('/answer')) {
        // The coordinated consent repair retires this user-authenticated sink.
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('404 Not Found');
      } else {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Access to this site denied' });
      }
      expect(db.update).not.toHaveBeenCalled();
      expect(createWsTicket).not.toHaveBeenCalled();
      expect(createDesktopConnectCode).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'WebSocket ticket', path: `/remote/sessions/${SESSION_ID}/ws-ticket`, method: 'POST', body: undefined },
      { label: 'desktop connect code', path: `/remote/sessions/${SESSION_ID}/desktop-connect-code`, method: 'POST', body: undefined },
      { label: 'ICE server credentials', path: `/remote/ice-servers?sessionId=${SESSION_ID}`, method: 'GET', body: undefined },
      { label: 'ICE candidate', path: `/remote/sessions/${SESSION_ID}/ice`, method: 'POST', body: JSON.stringify({ candidate: { candidate: 'candidate:1' } }) },
    ])(
      'denies $label after the remote-access policy is disabled mid-session, before any side effect',
      async ({ path, method, body }) => {
        // Same device/site the caller IS allowed to reach: the only thing that
        // changed is the live policy, so this cannot pass on the site branch.
        getSessionWithOrgCheck.mockResolvedValue({
          ...forbidden,
          session: { ...forbidden.session, deviceId: DEVICE_IN_ALLOWED },
          device: { ...forbidden.device, id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
        });
        // ...Once: the default `{allowed:true}` set in beforeEach must survive
        // for the suites that follow (vi.clearAllMocks does not restore
        // implementations, only call records).
        checkRemoteAccess.mockReturnValueOnce(
          Promise.resolve({ allowed: false, reason: 'Remote desktop is disabled by policy' })
        );

        const res = await app.request(path, {
          method,
          headers: {
            Authorization: 'Bearer t',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body,
        });

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Remote desktop is disabled by policy' });
        expect(db.update).not.toHaveBeenCalled();
        expect(createWsTicket).not.toHaveBeenCalled();
        expect(createDesktopConnectCode).not.toHaveBeenCalled();
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Revocation-lease capability gate (fail-closed desktop sessions)
// ---------------------------------------------------------------------------

describe('remote sessions — revocation-lease capability gate', () => {
  const SESSION_ID2 = '11111111-1111-4111-8111-111111111111';
  const DEVICE_ID2 = '22222222-2222-4222-8222-222222222222';
  const ORG_ID2 = '33333333-3333-4333-8333-333333333333';
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    isRevocationLeaseCapable.mockResolvedValue(true);
    prepareRevocationLeaseForStart.mockResolvedValue({
      ok: true,
      lease: LEASE_FIXTURE,
    });
    partnerTrustMode.mockReturnValue('off');
    app = new Hono();
    app.route('/remote', sessionRoutes);
  });

  function rigDeviceOnline() {
    getDeviceWithOrgCheck.mockResolvedValue({
      id: DEVICE_ID2,
      orgId: ORG_ID2,
      siteId: null,
      agentId: 'agent-1',
      hostname: 'host-1',
      osType: 'linux',
      status: 'online',
    });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as never);
    (db as any).insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: SESSION_ID2, deviceId: DEVICE_ID2, userId: 'user-1', type: 'desktop', status: 'pending', createdAt: new Date() },
        ]),
      }),
    });
  }

  it('refuses to CREATE a desktop session against an agent with no lease support (503 agent_upgrade_required)', async () => {
    rigDeviceOnline();
    isRevocationLeaseCapable.mockResolvedValue(false);

    const res = await app.request('/remote/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID2, type: 'desktop' }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('agent_upgrade_required');
    expect((db as any).insert).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the capability probe itself throws', async () => {
    rigDeviceOnline();
    isRevocationLeaseCapable.mockRejectedValue(new Error('db down'));

    const res = await app.request('/remote/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID2, type: 'desktop' }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('agent_upgrade_required');
  });

  // The 503 must carry a machine-readable `code`, like every sibling lease 503
  // on this route and in desktopWs.ts. Two renderers have to agree on that:
  // Hono's DEFAULT handler (which this bare test app uses) calls
  // `getResponse()`, while the real app installs its own `onError`. A body of
  // `{error, message}` alone leaves the client unable to tell this apart from
  // any other 503 and is what shipped first.
  it('refuses to CREATE a desktop session with 503 lease_unavailable when the epoch baseline cannot be read', async () => {
    rigDeviceOnline();
    // db.select is unrigged here, so readPermissionsEpoch throws and resolves
    // to a null baseline — the "DB blip at create time" case.
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('db down');
    });

    const res = await app.request('/remote/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID2, type: 'desktop' }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('lease_unavailable');
    expect(body.error).toMatch(/temporarily unavailable/i);
    // Fail CLOSED: no unrenewable session row is minted.
    expect((db as any).insert).not.toHaveBeenCalled();
  });

  it('does NOT gate terminal sessions on the desktop lease capability', async () => {
    rigDeviceOnline();
    isRevocationLeaseCapable.mockResolvedValue(false);

    const res = await app.request('/remote/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID2, type: 'terminal' }),
    });

    expect(res.status).toBe(201);
    expect(isRevocationLeaseCapable).not.toHaveBeenCalled();
  });

  function rigOffer() {
    getSessionWithOrgCheck.mockResolvedValue({
      session: { id: SESSION_ID2, userId: 'user-1', type: 'desktop', status: 'pending', deviceId: DEVICE_ID2 },
      device: { id: DEVICE_ID2, orgId: ORG_ID2, siteId: null, agentId: 'agent-1' },
    });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SESSION_ID2, status: 'connecting', webrtcOffer: 'sdp' }]),
        }),
      }),
    } as never);
    (db as any).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });
  }

  const offerBody = JSON.stringify({ offer: 'v=0\r\n' });

  it('refuses the OFFER with 503 agent_upgrade_required and sends NO start_desktop', async () => {
    rigOffer();
    prepareRevocationLeaseForStart.mockResolvedValue({ ok: false, reason: 'agent_upgrade_required' });

    const res = await app.request(`/remote/sessions/${SESSION_ID2}/offer`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: offerBody,
    });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('agent_upgrade_required');
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('refuses the OFFER with 503 lease_unavailable when the lease cannot be minted', async () => {
    rigOffer();
    prepareRevocationLeaseForStart.mockResolvedValue({ ok: false, reason: 'session_unavailable' });

    const res = await app.request(`/remote/sessions/${SESSION_ID2}/offer`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: offerBody,
    });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('lease_unavailable');
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('carries the revocationLease block in the start_desktop payload', async () => {
    rigOffer();

    const res = await app.request(`/remote/sessions/${SESSION_ID2}/offer`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: offerBody,
    });

    expect(res.status).toBe(200);
    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'start_desktop',
      payload: expect.objectContaining({
        revocationLease: expect.objectContaining({ renewEverySec: 25, graceSec: 90 }),
      }),
    }));
  });
});

describe('POST /remote/sessions/:id/lease/renew', () => {
  const SESSION_ID3 = '44444444-4444-4444-8444-444444444444';
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/remote', sessionRoutes);
  });

  it('renews and returns the lease window', async () => {
    renewRevocationLease.mockResolvedValue({
      status: 'renewed', expiresAt: 111, hardDeadline: 222, renewEverySec: 25, graceSec: 90,
    });
    const res = await app.request(`/remote/sessions/${SESSION_ID3}/lease/renew`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'renewed', expiresAt: 111, hardDeadline: 222, renewEverySec: 25, graceSec: 90,
    });
    expect(renewRevocationLease).toHaveBeenCalledWith(SESSION_ID3, { expectUserId: 'user-1' });
  });

  it('answers 403 with the reason when the session is revoked', async () => {
    renewRevocationLease.mockResolvedValue({ status: 'revoked', reason: 'permissions_changed' });
    const res = await app.request(`/remote/sessions/${SESSION_ID3}/lease/renew`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: 'revoked', reason: 'permissions_changed' });
  });

  it('answers 503 lease_unavailable on an infrastructure failure — never a revocation', async () => {
    renewRevocationLease.mockResolvedValue({ status: 'unavailable' });
    const res = await app.request(`/remote/sessions/${SESSION_ID3}/lease/renew`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('lease_unavailable');
  });

  it('answers 403 for a caller who does not own the session', async () => {
    renewRevocationLease.mockResolvedValue({ status: 'forbidden' });
    const res = await app.request(`/remote/sessions/${SESSION_ID3}/lease/renew`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /remote/sessions/:id/end — transition reauthorization + terminal-write
// safety (SEC-2026-09-05-038 wave 0).
// ---------------------------------------------------------------------------

describe('POST /remote/sessions/:id/end', () => {
  let app: Hono;

  const liveSession = {
    session: {
      id: SESSION_ID,
      userId: 'user-1',
      type: 'desktop',
      status: 'active',
      deviceId: DEVICE_IN_FORBIDDEN,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      bytesTransferred: null,
      recordingUrl: null,
    },
    device: {
      id: DEVICE_IN_FORBIDDEN,
      orgId: ORG_ID,
      siteId: FORBIDDEN_SITE,
      agentId: 'agent-1',
      hostname: 'host-1',
    },
  };

  // db.update(...).set(...).where(...).returning()
  function rigEndUpdate(rows: unknown[]) {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) });
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({ where }),
    } as never);
    return where;
  }

  // The post-race re-read: db.select(...).from(...).where(...).limit(1)
  function rigStatusReread(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    } as never);
  }

  function endRequest(headers: Record<string, string> = {}) {
    return app.request(`/remote/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({}),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    getSessionWithOrgCheck.mockReset();
    getSessionWithOrgCheck.mockResolvedValue(liveSession);
    checkRemoteAccess.mockReturnValue(Promise.resolve({ allowed: true }));
    revokeViewerSession.mockResolvedValue(undefined);
    dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
    captureMessage.mockReset();
    captureException.mockReset();
    app = new Hono();
    app.route('/remote', sessionRoutes);
  });

  it('dispatches stop_desktop through the durable relay, never the socket-local send', async () => {
    rigEndUpdate([{ id: SESSION_ID, status: 'disconnected', endedAt: new Date(), durationSeconds: 1, bytesTransferred: null }]);

    const res = await endRequest();

    expect(res.status).toBe(200);
    // The agent's command socket routinely lives on another API replica, where
    // sendCommandToAgent silently returns false and the stream keeps running.
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(dispatchCommandToAgent).toHaveBeenCalledWith('agent-1', {
      id: `desk-stop-${SESSION_ID}`,
      type: 'stop_desktop',
      payload: { sessionId: SESSION_ID },
    });
  });

  it('does not await the relay ack — the response lands before the dispatch settles', async () => {
    rigEndUpdate([{ id: SESSION_ID, status: 'disconnected', endedAt: new Date(), durationSeconds: 1, bytesTransferred: null }]);
    // The relay branch polls Redis for up to 5s. Awaiting it inside the auth
    // middleware's ambient request transaction is the #1105 pool-poison
    // pattern, so the handler must return without it.
    let settle: (o: { status: string; via?: string }) => void = () => {};
    dispatchCommandToAgent.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));

    const res = await endRequest();

    expect(res.status).toBe(200);
    expect(dispatchCommandToAgent).toHaveBeenCalled();
    settle({ status: 'sent', via: 'relay' });
  });

  it('warns and reports to Sentry when the relay reports the stop was NOT delivered', async () => {
    rigEndUpdate([{ id: SESSION_ID, status: 'disconnected', endedAt: new Date(), durationSeconds: 1, bytesTransferred: null }]);
    // dispatchCommandToAgent RESOLVES with a status; it does not throw. A bare
    // try/catch around it would therefore be silent for every real
    // non-delivery — which is the case that leaves the peer-to-peer stream up.
    dispatchCommandToAgent.mockResolvedValueOnce({ status: 'offline' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await endRequest();
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalled());
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'remote_desktop_stop_undelivered' })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SESSION_ID));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
    warn.mockRestore();
  });

  it('distinguishes a faulted relay from an undelivered stop', async () => {
    rigEndUpdate([{ id: SESSION_ID, status: 'disconnected', endedAt: new Date(), durationSeconds: 1, bytesTransferred: null }]);
    dispatchCommandToAgent.mockResolvedValueOnce({ status: 'infrastructure_error', message: 'relay enqueue failed' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await endRequest();

    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalled());
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'remote_desktop_stop_dispatch_failed' })
    );
    warn.mockRestore();
  });

  it('still answers 200 when the relay throws (teardown is best-effort, the row is already terminal)', async () => {
    rigEndUpdate([{ id: SESSION_ID, status: 'disconnected', endedAt: new Date(), durationSeconds: 1, bytesTransferred: null }]);
    dispatchCommandToAgent.mockRejectedValueOnce(new Error('relay down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await endRequest();

    expect(res.status).toBe(200);
    expect(revokeViewerSession).toHaveBeenCalledWith(SESSION_ID);
    await vi.waitFor(() => expect(captureException).toHaveBeenCalled());
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { event_code: 'remote_desktop_stop_dispatch_failed' }
    );
    error.mockRestore();
  });

  it('refuses to overwrite a `denied` row — both End guards share one live-status list', async () => {
    getSessionWithOrgCheck.mockResolvedValue({
      ...liveSession,
      session: { ...liveSession.session, status: 'denied' },
    });

    const res = await endRequest();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Session is already ended', status: 'denied' });
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
  });

  it('guards the UPDATE on the live statuses so a concurrently-failed row is not overwritten', async () => {
    const where = rigEndUpdate([]);      // lost the race: no live row matched
    rigStatusReread([{ status: 'failed' }]);

    const res = await endRequest();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Session is already ended', status: 'failed' });
    // The predicate must actually carry the live-status allowlist, otherwise
    // the "no row matched" branch above could never be reached in production.
    const predicate = JSON.stringify(where.mock.calls[0]?.[0] ?? null);
    for (const live of ['pending', 'connecting', 'active']) {
      expect(predicate).toContain(live);
    }
    // A row that is already terminal must not be told to stop again, and above
    // all must not have its recorded failure rewritten as an operator End.
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
  });

  it('answers 404 when the session row is gone by the time the guarded UPDATE runs', async () => {
    rigEndUpdate([]);
    rigStatusReread([]);

    const res = await endRequest();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Session not found' });
  });

  it('denies a caller narrowed away from the device site, before any write or teardown', async () => {
    const res = await endRequest({ 'x-restrict-site': ALLOWED_SITE });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this site denied' });
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(revokeViewerSession).not.toHaveBeenCalled();
  });

  it('does NOT gate End on the remote-access policy — a disabled policy must never strand a live stream', async () => {
    rigEndUpdate([{ id: SESSION_ID, status: 'disconnected', endedAt: new Date(), durationSeconds: 1, bytesTransferred: null }]);

    const res = await endRequest();

    expect(res.status).toBe(200);
    expect(checkRemoteAccess).not.toHaveBeenCalled();
    expect(dispatchCommandToAgent).toHaveBeenCalled();
  });
});
