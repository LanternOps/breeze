import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { ERROR_CODES } from '@breeze/shared';
import { jsonError } from '../../lib/jsonError';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, ne, not, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  remoteSessions,
  users,
  tunnelSessions,
  remoteSessionIsLive,
  tunnelSessionIsLiveVnc
} from '../../db/schema';
import type { remoteSessionTypeEnum, REMOTE_SESSION_LIVE_STATUSES } from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { getDeviceLivenessWithOrgCheck } from './helpers';
import { canAccessSite, hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  remoteSessionStaleCondition,
  REMOTE_SESSION_ACTIVE_MAX_AGE_MS,
  REMOTE_SESSION_CONNECTING_STALE_MS,
  REMOTE_SESSION_PENDING_STALE_MS,
} from '../../services/remoteSessionStaleness';
import { resolveLivenessStatus } from '../../services/deviceLiveness';

// GET /remote/devices/:deviceId/active-sessions - Who is connected to a device right now.
//
// Informational only: lets a technician see that a colleague already has a live
// session before opening their own. Unlike GET /sessions (caller-owned rows for
// non-system scopes), this lists every user's in-flight session on ONE device
// the caller can already reach — same org + site gate as starting a session and
// the parent router's remote:access. It returns no session or user ids, so
// nothing here can be used to act on a colleague's session, and colleagues'
// emails only to callers holding users:read. User rows the caller's RLS context
// cannot read (e.g. partner staff, seen from an org-scoped token) come back with
// a null name.
//
// Scope: remote_sessions desktop and terminal rows plus live VNC tunnels
// (tunnel_sessions type 'vnc'). file_transfer rows can never go live (ws-ticket
// only accepts terminal and desktop), so they could only ever show as a phantom
// "connecting". Proxy tunnels are HTTP(S) web-UI forwards, not someone at the
// screen, so they are not listed either.
export const deviceActiveSessionRoutes = new Hono();

const activeSessionsParamSchema = z.object({ deviceId: z.string().guid() });

type ActiveSessionType = (typeof remoteSessionTypeEnum.enumValues)[number] | 'vnc';
type ActiveSessionStatus = (typeof REMOTE_SESSION_LIVE_STATUSES)[number];

// Raw rows (not users) — generous so one colleague with several sessions can't
// crowd another out of the banner.
const ACTIVE_SESSIONS_LIMIT = 50;

// Can this device have a live session right now? A stored `offline`,
// `decommissioned` or `quarantined` device cannot; any other status must have a fresh
// heartbeat (services/deviceLiveness.ts). A never-seen device (null lastSeenAt)
// is left alone — there is no evidence either way. This is only a warning, so it
// can afford to be stricter than anything that ends sessions.
function deviceCannotHostLiveSession(device: { status: string; lastSeenAt: Date | null }, now: Date): boolean {
  if (device.status === 'offline' || device.status === 'decommissioned' || device.status === 'quarantined') return true;
  if (!device.lastSeenAt) return false;
  return resolveLivenessStatus(device.lastSeenAt, now) === 'offline';
}

deviceActiveSessionRoutes.get(
  '/devices/:deviceId/active-sessions',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', activeSessionsParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    // Polled every minute per open device page: read only the columns needed.
    const device = await getDeviceLivenessWithOrgCheck(deviceId, auth, c.get('permissions'));
    if (device === 'SITE_ACCESS_DENIED') {
      return jsonError(c, 403, ERROR_CODES.ACCESS_DENIED, 'Access to this site denied');
    }
    if (!device) {
      return jsonError(c, 404, ERROR_CODES.NOT_FOUND, 'Device not found or access denied');
    }
    // Explicit, same-file site gate (the site-scope coverage contract does not
    // count the cross-file check inside the device lookup).
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(perms, device.siteId))) {
      return jsonError(c, 403, ERROR_CODES.ACCESS_DENIED, 'Access to this site denied');
    }

    // A device that is not connected cannot have a live session. An `active` row
    // survives an agent crash or device drop until the 24h zombie-session sweep
    // in jobs/staleCommandReaper.ts, so without this the banner would report a
    // machine as busy long after everyone left. Known gap: an `active` row on a
    // device that stays online (e.g. the API instance relaying a terminal
    // restarted and the viewer never called /end) still shows until that sweep.
    const now = new Date();
    if (deviceCannotHostLiveSession(device, now)) {
      return c.json({ data: [] });
    }

    const [sessionRows, vncRows] = await Promise.all([
      db
        .select({
          userId: remoteSessions.userId,
          type: remoteSessions.type,
          status: remoteSessions.status,
          createdAt: remoteSessions.createdAt,
          userName: users.name,
          userEmail: users.email
        })
        .from(remoteSessions)
        .leftJoin(users, eq(remoteSessions.userId, users.id))
        .where(
          and(
            eq(remoteSessions.deviceId, device.id),
            // Same predicate as remote_sessions_device_live_idx, so the planner
            // can use the partial index.
            remoteSessionIsLive(remoteSessions.status),
            ne(remoteSessions.type, 'file_transfer'),
            // Hide pending/connecting attempts that never came up. A row that was
            // already live (startedAt set) and is re-offering — a WebRTC
            // reconnect, Retry, a session switch — moves back to `connecting`
            // with its original createdAt; it must not vanish from the banner.
            not(and(remoteSessionStaleCondition(now)!, isNull(remoteSessions.startedAt))!)
          )
        )
        .orderBy(desc(remoteSessions.createdAt))
        .limit(ACTIVE_SESSIONS_LIMIT),
      db
        .select({
          userId: tunnelSessions.userId,
          status: tunnelSessions.status,
          createdAt: tunnelSessions.createdAt,
          userName: users.name,
          userEmail: users.email
        })
        .from(tunnelSessions)
        .leftJoin(users, eq(tunnelSessions.userId, users.id))
        .where(
          and(
            eq(tunnelSessions.deviceId, device.id),
            // Same predicate as tunnel_sessions_device_live_vnc_idx.
            tunnelSessionIsLiveVnc(tunnelSessions.type, tunnelSessions.status),
            or(
              // Nothing ends an orphaned `active` VNC row (and VNC never bumps
              // lastActivityAt), so hide it 24h after creation. Unlike the
              // reaper's remote_sessions sweep this only hides the row: a VNC
              // session genuinely open longer than 24h drops off the banner.
              and(
                eq(tunnelSessions.status, 'active'),
                gt(tunnelSessions.createdAt, new Date(now.getTime() - REMOTE_SESSION_ACTIVE_MAX_AGE_MS))
              ),
              // A colleague still opening VNC is shown as "connecting", like a
              // desktop session at the same stage — with the same stale bounds
              // as remote_sessions (services/remoteSessionStaleness.ts).
              and(
                eq(tunnelSessions.status, 'pending'),
                gt(tunnelSessions.createdAt, new Date(now.getTime() - REMOTE_SESSION_PENDING_STALE_MS))
              ),
              and(
                eq(tunnelSessions.status, 'connecting'),
                gt(tunnelSessions.createdAt, new Date(now.getTime() - REMOTE_SESSION_CONNECTING_STALE_MS))
              )
            )
          )
        )
        .orderBy(desc(tunnelSessions.createdAt))
        .limit(ACTIVE_SESSIONS_LIMIT)
    ]);

    const rows = [
      ...sessionRows.map((s) => ({ ...s, type: s.type as ActiveSessionType, status: s.status as ActiveSessionStatus })),
      ...vncRows.map((s) => ({ ...s, type: 'vnc' as const, status: s.status as ActiveSessionStatus }))
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, ACTIVE_SESSIONS_LIMIT);

    // Colleagues' email addresses are users:read data; remote:access + devices:read
    // alone only earns their display name. No scope shortcut: a system token that
    // carries an org/partner axis is governed by that membership's grants (#5071),
    // and the null-axis platform admin already resolves to the wildcard set.
    const canSeeEmails =
      perms !== undefined && hasPermission(perms, PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action);

    // Opaque per-response key per distinct user, so the client can group one row
    // per person without being handed user ids (names can collide, or be null
    // where RLS hides the user row).
    const userKeys = new Map<string, number>();
    const userKeyFor = (userId: string) => {
      let key = userKeys.get(userId);
      if (key === undefined) {
        key = userKeys.size;
        userKeys.set(userId, key);
      }
      return key;
    };

    return c.json({
      data: rows.map((s) => {
        const isCurrentUser = s.userId === auth.user.id;
        return {
          type: s.type,
          status: s.status,
          // Server-computed so the client never compares a server timestamp
          // against a skewed browser clock (same reason as tunnels' idleSeconds).
          // Based on createdAt, which a WebRTC re-offer never rewrites (startedAt
          // is re-stamped on every answer).
          elapsedSeconds: Math.max(0, Math.floor((now.getTime() - s.createdAt.getTime()) / 1000)),
          isCurrentUser,
          userKey: userKeyFor(s.userId),
          user: { name: s.userName, email: canSeeEmails || isCurrentUser ? s.userEmail : null }
        };
      })
    });
  }
);
