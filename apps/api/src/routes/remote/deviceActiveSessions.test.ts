import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@breeze/shared';
import { Hono } from 'hono';

const { getDeviceLivenessWithOrgCheck } = vi.hoisted(() => ({
  getDeviceLivenessWithOrgCheck: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', async () => {
  // The real inline-literal predicate helpers, so a regression to bound
  // parameters (which can't use the partial indexes) is caught.
  const { remoteSessionIsLive } = await vi.importActual<typeof import('../../db/schema/remote')>('../../db/schema/remote');
  const { tunnelSessionIsLiveVnc } = await vi.importActual<typeof import('../../db/schema/tunnels')>('../../db/schema/tunnels');
  return {
    remoteSessionIsLive,
    tunnelSessionIsLiveVnc,
    remoteSessions: {
      userId: 'remoteSessions.userId',
      deviceId: 'remoteSessions.deviceId',
      type: 'remoteSessions.type',
      status: 'remoteSessions.status',
      startedAt: 'remoteSessions.startedAt',
      createdAt: 'remoteSessions.createdAt',
    },
    tunnelSessions: {
      userId: 'tunnelSessions.userId',
      deviceId: 'tunnelSessions.deviceId',
      type: 'tunnelSessions.type',
      status: 'tunnelSessions.status',
      createdAt: 'tunnelSessions.createdAt',
    },
    users: { id: 'users.id', name: 'users.name', email: 'users.email' },
  };
});

// requireScope seeds auth; requirePermission seeds permissions (mirrors prod — only
// requirePermission populates c.get('permissions'), which the site gate reads).
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      // x-scope overrides the token scope (e.g. an org-axis system token).
      scope: c.req.header('x-scope') ?? 'organization',
      partnerId: null,
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', {
      // x-grant-users-read opts a request into users:read.
      permissions: c.req.header('x-grant-users-read') ? [{ resource: 'users', action: 'read' }] : [],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: restrict ? [restrict] : undefined,
    });
    return next();
  }),
}));

vi.mock('../../services/permissions', async () => {
  const { permissionGrantMatches } = await vi.importActual<typeof import('../../services/permissionMatching')>('../../services/permissionMatching');
  return {
    PERMISSIONS: {
      DEVICES_READ: { resource: 'devices', action: 'read' },
      USERS_READ: { resource: 'users', action: 'read' },
    },
    canAccessSite: (perms: any, siteId: string) =>
      !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
    // Production matching (wildcards included), not a re-implementation (#2874).
    hasPermission: (perms: any, resource: string, action: string) =>
      (perms?.permissions ?? []).some((p: any) => permissionGrantMatches(p, resource, action)),
  };
});

vi.mock('./helpers', () => ({ getDeviceLivenessWithOrgCheck }));

import { deviceActiveSessionRoutes } from './deviceActiveSessions';
import { db } from '../../db';

const ORG_ID = 'org-111';
const ALLOWED_SITE = 'site-a';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE = { id: DEVICE_ID, orgId: ORG_ID, siteId: ALLOWED_SITE, status: 'online', lastSeenAt: new Date() };
const URL_ = `/remote/devices/${DEVICE_ID}/active-sessions`;

// Recursively walks a drizzle `and(...)`/`eq(...)` condition tree looking for
// an `eq(<columnLabel>, <value>)` leaf. Column mocks in this file are plain
// strings, so the built SQL's queryChunks contain that label and the bound
// value as adjacent chunk entries.
function conditionContainsEquality(condition: unknown, columnLabel: string, value: string): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return false;
  const labelIndex = chunks.indexOf(columnLabel);
  if (labelIndex !== -1 && chunks[labelIndex + 2] === value) return true;
  return chunks.some((chunk) => conditionContainsEquality(chunk, columnLabel, value));
}

// The route issues two selects (remote_sessions, then VNC tunnel_sessions).
function rigActiveSessions(rows: Array<Record<string, unknown>>, vncRows: Array<Record<string, unknown>> = []) {
  const rig = (result: Array<Record<string, unknown>>) => {
    const where = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(result) }),
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ leftJoin: vi.fn().mockReturnValue({ where }) }),
    } as never);
    return where;
  };
  const where = rig(rows);
  const tunnelWhere = rig(vncRows);
  return { where, tunnelWhere };
}

function row(userId: string, overrides: Record<string, unknown> = {}) {
  const at = new Date('2026-09-29T10:00:00Z');
  return { userId, type: 'desktop', status: 'active', createdAt: at, userName: 'Colleague', userEmail: 'colleague@example.com', ...overrides };
}

describe('GET /remote/devices/:deviceId/active-sessions', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    getDeviceLivenessWithOrgCheck.mockReset();
    app = new Hono();
    app.route('/remote', deviceActiveSessionRoutes);
  });

  // A1 — the core contract.
  it("lists every user's live session on the device, flagging the caller's own", async () => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue(DEVICE);
    const { where } = rigActiveSessions([
      row('user-2'),
      row('user-1', { type: 'terminal', status: 'connecting', userName: 'Test User', userEmail: 'test@example.com' }),
    ]);

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t', 'x-grant-users-read': '1' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { type: 'desktop', status: 'active', elapsedSeconds: expect.any(Number), isCurrentUser: false, userKey: 0, user: { name: 'Colleague', email: 'colleague@example.com' } },
      { type: 'terminal', status: 'connecting', elapsedSeconds: expect.any(Number), isCurrentUser: true, userKey: 1, user: { name: 'Test User', email: 'test@example.com' } },
    ]);
    // Informational only: never hand out a colleague's session id.
    for (const r of body.data) expect(r).not.toHaveProperty('id');
    // Scoped to this device; NOT narrowed to the caller like GET /sessions.
    const condition = where.mock.calls[0]![0];
    expect(conditionContainsEquality(condition, 'remoteSessions.deviceId', DEVICE_ID)).toBe(true);
    expect(conditionContainsEquality(condition, 'remoteSessions.userId', 'user-1')).toBe(false);
    // Live rows only (the inline literal the partial index matches), minus
    // setups that never started, and never file transfers.
    const sqlText = JSON.stringify(condition);
    expect(sqlText).toContain("'pending', 'connecting', 'active'");
    expect(sqlText).toContain('remoteSessions.createdAt');
    expect(sqlText).toContain('remoteSessions.startedAt');
    expect(conditionContainsEquality(condition, 'remoteSessions.type', 'file_transfer')).toBe(true);
  });

  // A2 — email privacy, including a system token carrying an org axis (#5071).
  it.each([
    ['an org token', {}],
    ['a system token carrying an org axis', { 'x-scope': 'system' }],
  ])("withholds colleagues' emails without users:read (%s) but keeps the caller's own", async (_label, headers) => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue(DEVICE);
    rigActiveSessions([row('user-2'), row('user-1', { userName: 'Test User', userEmail: 'test@example.com' })]);

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t', ...headers } });

    const body = await res.json();
    expect(body.data[0].user).toEqual({ name: 'Colleague', email: null });
    expect(body.data[1].user).toEqual({ name: 'Test User', email: 'test@example.com' });
  });

  // A4 — one opaque key per person, so same-named colleagues stay distinct.
  it('gives each distinct user one opaque key, stable across their sessions and never their id', async () => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue(DEVICE);
    rigActiveSessions([
      row('user-2', { userName: 'Sam' }),
      row('user-3', { userName: 'Sam' }),
      row('user-2', { type: 'terminal', userName: 'Sam' }),
      row('user-4', { userName: null, userEmail: null }),
    ]);

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t' } });

    const body = await res.json();
    expect(body.data.map((r: { userKey: number }) => r.userKey)).toEqual([0, 1, 0, 2]);
    expect(JSON.stringify(body)).not.toMatch(/user-[234]/);
  });

  // A5 — no ghost sessions on a device that cannot host one.
  it.each([
    ['stored offline', { status: 'offline' }],
    ['heartbeat past the offline threshold', { status: 'maintenance', lastSeenAt: new Date(Date.now() - 10 * 60_000) }],
  ])('returns no sessions for a device that cannot host one (%s)', async (_label, overrides) => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue({ ...DEVICE, ...overrides });

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  // A6 — but a live device mid-update keeps its warning.
  it('still lists sessions while an agent is updating with a fresh heartbeat', async () => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue({ ...DEVICE, status: 'updating' });
    rigActiveSessions([row('user-2')]);

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t' } });

    expect((await res.json()).data).toHaveLength(1);
  });

  // A8 — VNC tunnels: vnc only, active (24h-bounded) or still setting up (stale-bounded).
  it('includes live VNC tunnels, merged newest first', async () => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue(DEVICE);
    const older = new Date('2026-09-29T09:00:00Z');
    const newer = new Date('2026-09-29T10:00:00Z');
    const { tunnelWhere } = rigActiveSessions(
      [row('user-2', { createdAt: older })],
      [{ userId: 'user-3', status: 'connecting', createdAt: newer, userName: 'Viewer', userEmail: 'v@example.com' }],
    );

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t' } });

    const body = await res.json();
    expect(body.data.map((r: { type: string; status: string }) => [r.type, r.status])).toEqual([
      ['vnc', 'connecting'],
      ['desktop', 'active'],
    ]);
    const condition = tunnelWhere.mock.calls[0]![0];
    expect(conditionContainsEquality(condition, 'tunnelSessions.deviceId', DEVICE_ID)).toBe(true);
    expect(JSON.stringify(condition)).toContain("= 'vnc' AND");
    expect(conditionContainsEquality(condition, 'tunnelSessions.status', 'active')).toBe(true);
    expect(JSON.stringify(condition)).toContain('tunnelSessions.createdAt');
  });

  // A9 / A10 / A11 — the same org + site ceiling as starting a session, and input validation.
  it('returns 403 when the caller is site-restricted away from the device', async () => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue('SITE_ACCESS_DENIED');

    const res = await app.request(`/remote/devices/${OTHER_SITE_DEVICE_ID}/active-sessions`, {
      headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(ERROR_CODES.ACCESS_DENIED);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 404 for a device outside the caller org', async () => {
    getDeviceLivenessWithOrgCheck.mockResolvedValue(null);

    const res = await app.request(URL_, { headers: { Authorization: 'Bearer t' } });

    expect(res.status).toBe(404);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID device id without querying', async () => {
    const res = await app.request('/remote/devices/not-a-uuid/active-sessions', { headers: { Authorization: 'Bearer t' } });

    expect(res.status).toBe(400);
    expect(getDeviceLivenessWithOrgCheck).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
