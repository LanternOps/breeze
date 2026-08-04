import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createSupportSessionSchema, formatSupportCode } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, remoteSessions, supportSessions } from '../../db/schema';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import {
  SUPPORT_CODE_TTL_MINUTES,
  SUPPORT_SESSION_HARD_CAP_HOURS,
  generateSupportCode,
  hashSupportCode,
} from '../../services/quickSupportCode';
import { getTrustedClientIp } from '../../services/clientIp';
import { logSessionAudit } from './helpers';

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

    // System context: when the hidden org was just created it is not in this
    // request's accessible_org_ids yet, so the RLS INSERT policy would reject.
    const [session] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.insert(supportSessions).values({
        orgId,
        createdByUserId: auth.user.id,
        codeHash: hashSupportCode(code),
        codeExpiresAt: new Date(now + SUPPORT_CODE_TTL_MINUTES * 60_000),
        hardExpiresAt: new Date(now + SUPPORT_SESSION_HARD_CAP_HOURS * 3_600_000),
        attributedOrgId: data.attributedOrgId ?? null,
        attributionLabel: data.attributionLabel ?? null,
      }).returning()
    ));

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
