import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createSupportSessionSchema, formatSupportCode } from '@breeze/shared';
import { db } from '../../db';
import { devices, remoteSessions, supportSessions } from '../../db/schema';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import {
  SUPPORT_CODE_TTL_MINUTES,
  SUPPORT_SESSION_HARD_CAP_HOURS,
  generateSupportCode,
  hashSupportCode,
} from '../../services/quickSupportCode';
import { getTrustedClientIp } from '../../services/clientIp';
import { endSupportSession } from '../../services/quickSupportEnd';
import { logSessionAudit } from './helpers';
import { createRemoteSession, RemoteSessionDeniedError } from '../../services/remoteSessionCreate';
import { trustDenyBody } from '../../services/partnerTrust';

export const supportSessionRoutes = new Hono();

/** Remote-session statuses that mean "a tech is connected right now". */
const LIVE_REMOTE_STATUSES = ['pending', 'connecting', 'active'] as const;

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

type SupportSessionRow = typeof supportSessions.$inferSelect;

/**
 * Strip the code hash and fold in the two derived fields.
 *
 * `active` is derived rather than stored so nothing has to hook the
 * remote-session create/end paths just to keep a duplicate status in sync.
 */
function toView(
  session: SupportSessionRow,
  deviceOnline: boolean,
  hasLiveRemoteSession: boolean,
) {
  const { codeHash: _codeHash, ...rest } = session;
  return {
    ...rest,
    status: session.status === 'ready' && hasLiveRemoteSession ? 'active' : session.status,
    deviceOnline,
  };
}

/** Only 'claimed'/'ready' sessions can have a live device worth probing. */
function isProbeable(session: SupportSessionRow): boolean {
  return !!session.deviceId && (session.status === 'ready' || session.status === 'claimed');
}

supportSessionRoutes.post(
  '/support-sessions',
  zValidator('json', createSupportSessionSchema),
  async (c) => {
    const auth = c.get('auth');

    // The hidden Quick Support org hangs off the PARTNER. An org-scope token
    // carries a partnerId but never passes breeze_has_partner_access, so it
    // must not be able to mint sessions it could not then read back.
    if (auth.scope !== 'partner' && auth.scope !== 'system') {
      return c.json({ error: 'Quick Support requires partner scope' }, 403);
    }
    if (!auth.partnerId) {
      // System tokens may carry no partner context — there is no org to
      // provision into, and provisioning would otherwise throw.
      return c.json({ error: 'Quick Support requires a partner context' }, 403);
    }

    const data = c.req.valid('json');

    // Attribution is reporting-only, but it still names a real customer org,
    // so it must be one the caller can actually see.
    if (
      data.attributedOrgId
      && auth.accessibleOrgIds !== null
      && !auth.accessibleOrgIds.includes(data.attributedOrgId)
    ) {
      return c.json({ error: 'Attributed organization not accessible' }, 403);
    }

    const { orgId } = await getOrCreateQuickSupportOrg(auth.partnerId);
    const code = generateSupportCode();
    const now = Date.now();

    let created: SupportSessionRow;
    try {
      created = await createRemoteSession('support', {
        partnerId: auth.partnerId,
        orgId,
        createdByUserId: auth.user.id,
        codeHash: hashSupportCode(code),
        codeExpiresAt: new Date(now + SUPPORT_CODE_TTL_MINUTES * 60_000),
        hardExpiresAt: new Date(now + SUPPORT_SESSION_HARD_CAP_HOURS * 3_600_000),
        attributedOrgId: data.attributedOrgId ?? null,
        attributionLabel: data.attributionLabel ?? null,
      });
    } catch (e) {
      if (e instanceof RemoteSessionDeniedError) {
        return c.json(trustDenyBody({
          allow: false,
          code: e.code,
          capability: 'remote_control',
          reason: e.reason,
        }, false), 403);
      }
      throw e;
    }

    // RETURNING on a single-row INSERT always yields a row; narrow it so a
    // future refactor that makes the insert conditional fails loudly here
    // rather than emitting `undefined` into the response body.
    if (!created) return c.json({ error: 'Failed to create support session' }, 500);
    const session = created;

    await logSessionAudit(
      'support_session_created',
      auth.user.id,
      orgId,
      {
        sessionId: session.id,
        attributedOrgId: data.attributedOrgId ?? null,
        attributionLabel: data.attributionLabel ?? null,
      },
      getTrustedClientIp(c, 'unknown'),
    );

    const webBase = process.env.PUBLIC_WEB_URL ?? '';

    return c.json({
      id: session.id,
      // The one and only time the plaintext code leaves the server.
      code: formatSupportCode(code),
      codeExpiresAt: session.codeExpiresAt,
      hardExpiresAt: session.hardExpiresAt,
      landingUrl: `${webBase}/quick?code=${code}`,
    }, 201);
  },
);

supportSessionRoutes.get('/support-sessions', async (c) => {
  const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT;

  // Normal (non-system) context: the hidden org's partner_id puts it inside
  // the tech's accessible_org_ids, so RLS grants exactly their own sessions.
  const sessions = await db
    .select()
    .from(supportSessions)
    .orderBy(desc(supportSessions.createdAt))
    .limit(limit) as SupportSessionRow[];

  // Batch the two derived lookups across the whole page — per-row queries here
  // would be ~100 round trips at the default limit.
  const deviceIds = [...new Set(sessions.filter(isProbeable).map((s) => s.deviceId!))];

  const onlineDeviceIds = new Set<string>();
  const liveSessionDeviceIds = new Set<string>();

  if (deviceIds.length > 0) {
    const deviceRows = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(inArray(devices.id, deviceIds)) as Array<{ id: string; status: string }>;
    for (const row of deviceRows) {
      if (row.status === 'online') onlineDeviceIds.add(row.id);
    }

    const liveRows = await db
      .select({ deviceId: remoteSessions.deviceId })
      .from(remoteSessions)
      .where(and(
        inArray(remoteSessions.deviceId, deviceIds),
        inArray(remoteSessions.status, [...LIVE_REMOTE_STATUSES]),
      )) as Array<{ deviceId: string }>;
    for (const row of liveRows) liveSessionDeviceIds.add(row.deviceId);
  }

  return c.json({
    sessions: sessions.map((s) => toView(
      s,
      !!s.deviceId && onlineDeviceIds.has(s.deviceId),
      !!s.deviceId && liveSessionDeviceIds.has(s.deviceId),
    )),
  });
});

/**
 * End a session: self-destruct the client, revoke its credentials, drop its
 * socket. The session is loaded under the normal RLS context first, so a
 * caller who cannot see the session cannot end it either.
 *
 * No extra guard is needed to stop a lingering client being reconnected to:
 * endSupportSession decommissions the device, and POST /remote/sessions
 * already rejects any device whose status is not 'online'.
 */
supportSessionRoutes.post('/support-sessions/:id/end', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const [session] = await db
    .select()
    .from(supportSessions)
    .where(eq(supportSessions.id, id))
    .limit(1) as SupportSessionRow[];

  if (!session) return c.json({ error: 'Support session not found' }, 404);
  if (session.status === 'ended' || session.status === 'expired') {
    return c.json({ error: 'Support session already ended' }, 409);
  }

  const result = await endSupportSession(id, 'tech');

  await logSessionAudit(
    'support_session_ended',
    auth.user.id,
    session.orgId,
    {
      sessionId: id,
      reason: 'tech',
      // Recorded rather than collapsed into success: a 'close-failed' socket
      // plausibly stayed live after revocation, and a lost command means the
      // client only converges via its dead-man switch.
      agentDisconnect: result.disconnect,
      commandDelivered: result.commandDelivered,
    },
    getTrustedClientIp(c, 'unknown'),
  );

  return c.json({ success: true });
});

supportSessionRoutes.get('/support-sessions/:id', async (c) => {
  const [session] = await db
    .select()
    .from(supportSessions)
    .where(eq(supportSessions.id, c.req.param('id')))
    .limit(1) as SupportSessionRow[];

  if (!session) return c.json({ error: 'Support session not found' }, 404);

  if (!isProbeable(session)) return c.json(toView(session, false, false));

  const [device] = await db
    .select({ status: devices.status })
    .from(devices)
    .where(eq(devices.id, session.deviceId!))
    .limit(1) as Array<{ status: string }>;

  const live = await db
    .select({ id: remoteSessions.id })
    .from(remoteSessions)
    .where(and(
      eq(remoteSessions.deviceId, session.deviceId!),
      inArray(remoteSessions.status, [...LIVE_REMOTE_STATUSES]),
    ))
    .limit(1) as Array<{ id: string }>;

  return c.json(toView(session, device?.status === 'online', live.length > 0));
});
