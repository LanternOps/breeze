import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { createSupportSessionSchema, formatSupportCode, ERROR_CODES } from '@breeze/shared';
import { jsonError } from '../../lib/jsonError';
import { db } from '../../db';
import { devices, organizations, remoteSessions, supportSessions } from '../../db/schema';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import {
  SUPPORT_CODE_TTL_MINUTES,
  SUPPORT_SESSION_HARD_CAP_HOURS,
  generateSupportCode,
  hashSupportCode,
  openSupportCode,
  sealSupportCode,
} from '../../services/quickSupportCode';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getTrustedClientIp } from '../../services/clientIp';
import { endSupportSession } from '../../services/quickSupportEnd';
import { logSessionAudit } from './helpers';
import { withAuthDbAccessContext } from '../../middleware/auth';
import { assertSupportCodeMintAllowed, createRemoteSession, RemoteSessionDeniedError } from '../../services/remoteSessionCreate';
import { trustDenyBody } from '../../services/partnerTrust';

export const supportSessionRoutes = new Hono();

/** Remote-session statuses that mean "a tech is connected right now". */
const LIVE_REMOTE_STATUSES = ['pending', 'connecting', 'active'] as const;

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

type SupportSessionRow = typeof supportSessions.$inferSelect;

/**
 * Who may mint a Quick Support code — and therefore who may read one back or
 * replace it (#11836). One rule for all three so they cannot drift apart:
 *
 *  - partner (or system) scope WITH a partner context: the hidden Quick
 *    Support org hangs off the partner. An org-scope token carries a partnerId
 *    but never passes breeze_has_partner_access, and a system token with no
 *    partner has no org to provision into.
 *  - the `remote:access` permission (PERMISSIONS.REMOTE_ACCESS). The router in
 *    routes/remote/index.ts already requires it (with MFA) for every route
 *    here; it is re-checked off the grants that gate resolved, so a code is
 *    never revealed or minted if these routes are ever mounted without it.
 *
 * Returns the denial message, or null when the caller may mint.
 */
function mintDenial(c: Context): string | null {
  const auth = c.get('auth');
  if (auth.scope !== 'partner' && auth.scope !== 'system') return 'Quick Support requires partner scope';
  if (!auth.partnerId) return 'Quick Support requires a partner context';
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(perms, PERMISSIONS.REMOTE_ACCESS.resource, PERMISSIONS.REMOTE_ACCESS.action)) {
    return 'Quick Support requires the remote:access permission';
  }
  return null;
}

/**
 * The landing link the customer opens. It is pasted into email/chat, so it
 * must be absolute (#10508). Stock compose sets only PUBLIC_APP_URL;
 * PUBLIC_WEB_URL stays an explicit override. No localhost default: with
 * nothing configured the relative path is returned and the web client resolves
 * it against its own origin.
 */
function landingUrlFor(code: string): string {
  const webBase = (
    process.env.PUBLIC_WEB_URL?.trim()
    || process.env.DASHBOARD_URL?.trim()
    || process.env.PUBLIC_APP_URL?.trim()
    || ''
  ).replace(/\/+$/, '');
  return `${webBase}/quick?code=${code}`;
}

/** The code still opens the session: pending, inside its TTL and the hard cap. */
function isCodeLive(session: SupportSessionRow, now: Date): boolean {
  return session.status === 'pending'
    && session.codeExpiresAt > now
    && session.hardExpiresAt > now;
}

/**
 * A session that can still take a fresh code: nobody claimed it, no device
 * joined, it is inside the hard cap, and it is either pending (code live, or
 * lapsed but not reaped yet) or was expired by the reaper only because its code
 * lapsed. That last case is `ended_reason = 'expired'` with no claim: a
 * hard-cap kill always follows a claim, and a tech end is status 'ended'.
 */
function isReissuable(session: SupportSessionRow, now: Date): boolean {
  return session.claimedAt === null
    && session.deviceId === null
    && session.hardExpiresAt > now
    && (session.status === 'pending'
      || (session.status === 'expired' && session.endedReason === 'expired'));
}

/**
 * Of the given orgs, the caller's OWN partner's hidden Quick Support org. RLS
 * already hides other partners' sessions from a partner-scope caller; this is
 * what keeps a system-scope caller (whom RLS lets see every row) to the codes
 * of the partner it is acting for.
 */
async function ownQuickSupportOrgIds(partnerId: string, orgIds: string[]): Promise<Set<string>> {
  if (orgIds.length === 0) return new Set();
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      inArray(organizations.id, orgIds),
      eq(organizations.partnerId, partnerId),
      eq(organizations.type, 'quick_support'),
    )) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Which sessions' codes this caller may read and replace, as of `now`. */
interface CodeAccess {
  ownOrgIds: Set<string>;
  now: Date;
}

async function codeAccessFor(c: Context, sessions: SupportSessionRow[]): Promise<CodeAccess> {
  const now = new Date();
  if (mintDenial(c)) return { ownOrgIds: new Set(), now };
  const relevant = sessions.filter((s) => isCodeLive(s, now) || isReissuable(s, now));
  const orgIds = [...new Set(relevant.map((s) => s.orgId))];
  return { ownOrgIds: await ownQuickSupportOrgIds(c.get('auth').partnerId!, orgIds), now };
}

/**
 * Strip the code hash and the sealed code, and fold in the derived fields.
 *
 * `active` is derived rather than stored so nothing has to hook the
 * remote-session create/end paths just to keep a duplicate status in sync.
 *
 * `code` and `landingUrl` are present ONLY for a pending session whose code is
 * still inside its TTL and the hard cap (whether or not the reaper has run),
 * and only for a caller who could have minted it (`codeAccessFor`). Everyone else, and every
 * other session, gets no code field at all. `canIssueNewCode` follows the same
 * caller rule.
 */
function toView(
  session: SupportSessionRow,
  deviceOnline: boolean,
  hasLiveRemoteSession: boolean,
  access: CodeAccess,
) {
  const { codeHash: _codeHash, codeEncrypted, ...rest } = session;
  const own = access.ownOrgIds.has(session.orgId);
  const code = own && isCodeLive(session, access.now) ? openSupportCode(session.id, codeEncrypted) : null;
  return {
    ...rest,
    status: session.status === 'ready' && hasLiveRemoteSession ? 'active' : session.status,
    deviceOnline,
    canIssueNewCode: own && isReissuable(session, access.now),
    ...(code ? { code: formatSupportCode(code), landingUrl: landingUrlFor(code) } : {}),
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

    const denial = mintDenial(c);
    if (denial || !auth.partnerId) {
      return jsonError(c, 403, ERROR_CODES.ACCESS_DENIED, denial ?? 'Quick Support requires a partner context');
    }

    const data = c.req.valid('json');

    // Attribution is reporting-only, but it still names a real customer org,
    // so it must be one the caller can actually see.
    if (
      data.attributedOrgId
      && auth.accessibleOrgIds !== null
      && !auth.accessibleOrgIds.includes(data.attributedOrgId)
    ) {
      return jsonError(c, 403, ERROR_CODES.ACCESS_DENIED, 'Attributed organization not accessible');
    }

    const { orgId } = await getOrCreateQuickSupportOrg(auth.partnerId);
    const code = generateSupportCode();
    const now = Date.now();
    // Minted here rather than defaulted by the database: the sealed code is
    // bound to the row id, so the id has to exist before the insert.
    const id = randomUUID();

    let created: SupportSessionRow;
    try {
      created = await createRemoteSession('support', {
        id,
        partnerId: auth.partnerId,
        orgId,
        createdByUserId: auth.user.id,
        codeHash: hashSupportCode(code),
        codeEncrypted: sealSupportCode(id, code),
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

    return c.json({
      id: session.id,
      // Also readable from the list and detail routes while the session is
      // pending (#11836), by the same callers who could have minted it.
      code: formatSupportCode(code),
      codeExpiresAt: session.codeExpiresAt,
      hardExpiresAt: session.hardExpiresAt,
      landingUrl: landingUrlFor(code),
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

  const access = await codeAccessFor(c, sessions);

  return c.json({
    sessions: sessions.map((s) => toView(
      s,
      !!s.deviceId && onlineDeviceIds.has(s.deviceId),
      !!s.deviceId && liveSessionDeviceIds.has(s.deviceId),
      access,
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
 *
 * The route owns its DB context (SELF_MANAGED_DB_CONTEXT_ROUTES): the teardown
 * waits on the agent relay, so the session is read in a short caller-scoped
 * context and nothing is held while endSupportSession runs.
 */
supportSessionRoutes.post('/support-sessions/:id/end', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const [session] = await withAuthDbAccessContext(auth, async () => (await db
    .select()
    .from(supportSessions)
    .where(eq(supportSessions.id, id))
    .limit(1)) as SupportSessionRow[]);

  if (!session) return jsonError(c, 404, ERROR_CODES.NOT_FOUND, 'Support session not found');
  if (session.status === 'ended' || session.status === 'expired') {
    return jsonError(c, 409, ERROR_CODES.CONFLICT, 'Support session already ended');
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

  if (!session) return jsonError(c, 404, ERROR_CODES.NOT_FOUND, 'Support session not found');

  const access = await codeAccessFor(c, [session]);
  if (!isProbeable(session)) return c.json(toView(session, false, false, access));

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

  return c.json(toView(session, device?.status === 'online', live.length > 0, access));
});

/**
 * "New code" (#11836): replace a pending, or code-expired, session's code with
 * a fresh one and return it, keeping the same session.
 *
 * Same caller rule as create (`mintDenial`), audited like create. It runs in
 * the caller's request context, so RLS bounds both the read and the write; the
 * partner check also keeps a system-scope caller to its own partner.
 *
 * The UPDATE is the guarantee: hash, sealed value and expiry are swapped in
 * ONE statement whose WHERE re-checks "unclaimed, no device, inside the hard
 * cap, pending or code-expired". The old code stops working the moment this
 * commits (redeem looks the session up by hash, and its claim matches on the
 * hash too), and a redeem that commits first leaves this a 409, never a fresh
 * live code on a claimed session.
 */
supportSessionRoutes.post('/support-sessions/:id/code', async (c) => {
  const auth = c.get('auth');
  const denial = mintDenial(c);
  if (denial || !auth.partnerId) {
    return jsonError(c, 403, ERROR_CODES.ACCESS_DENIED, denial ?? 'Quick Support requires a partner context');
  }

  const id = c.req.param('id');
  const [session] = await db
    .select()
    .from(supportSessions)
    .where(eq(supportSessions.id, id))
    .limit(1) as SupportSessionRow[];
  // Another partner's session reads as missing, exactly as RLS makes it read
  // for a partner-scope caller.
  if (!session || !(await ownQuickSupportOrgIds(auth.partnerId, [session.orgId])).has(session.orgId)) {
    return jsonError(c, 404, ERROR_CODES.NOT_FOUND, 'Support session not found');
  }

  const now = new Date();
  if (!isReissuable(session, now)) {
    return jsonError(c, 409, ERROR_CODES.CONFLICT, 'Support session can no longer take a new code');
  }

  // Same partner-trust gate as create: a fresh code is a fresh credential.
  try {
    await assertSupportCodeMintAllowed(auth.partnerId, auth.user.id, { reissue: true });
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

  const code = generateSupportCode();
  // Never past the hard cap: redeem refuses a session beyond it anyway.
  const codeExpiresAt = new Date(Math.min(
    now.getTime() + SUPPORT_CODE_TTL_MINUTES * 60_000,
    session.hardExpiresAt.getTime(),
  ));

  const [updated] = await db
    .update(supportSessions)
    .set({
      codeHash: hashSupportCode(code),
      codeEncrypted: sealSupportCode(session.id, code),
      codeExpiresAt,
      status: 'pending',
      endedAt: null,
      endedReason: null,
    })
    .where(and(
      eq(supportSessions.id, session.id),
      isNull(supportSessions.claimedAt),
      isNull(supportSessions.deviceId),
      gt(supportSessions.hardExpiresAt, now),
      or(
        eq(supportSessions.status, 'pending'),
        and(eq(supportSessions.status, 'expired'), eq(supportSessions.endedReason, 'expired')),
      ),
    ))
    .returning({
      id: supportSessions.id,
      codeExpiresAt: supportSessions.codeExpiresAt,
      hardExpiresAt: supportSessions.hardExpiresAt,
    });
  if (!updated) {
    return jsonError(c, 409, ERROR_CODES.CONFLICT, 'Support session can no longer take a new code');
  }

  await logSessionAudit(
    'support_session_code_reissued',
    auth.user.id,
    session.orgId,
    {
      sessionId: session.id,
      // A reaper-expired session comes back to pending; record that it did.
      previousStatus: session.status,
    },
    getTrustedClientIp(c, 'unknown'),
  );

  return c.json({
    id: updated.id,
    code: formatSupportCode(code),
    codeExpiresAt: updated.codeExpiresAt,
    hardExpiresAt: updated.hardExpiresAt,
    landingUrl: landingUrlFor(code),
  });
});
