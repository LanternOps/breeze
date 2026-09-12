/**
 * Fail-closed revocation lease for remote desktop sessions.
 *
 * A live WebRTC desktop session is peer-to-peer: once the answer is exchanged,
 * media, input and clipboard flow straight between viewer and agent with the
 * API server out of the loop. Nothing re-checked authorization for the life of
 * that session, so removing a technician's membership, changing their role,
 * narrowing their site scope or flipping their role's force_mfa left the live
 * screen/keyboard session running until the operator closed it.
 *
 * This module is the fix: the agent holds a short lease (60 s) that it renews
 * every 25 s over its command WebSocket, and every renew performs a LIVE
 * authorization recheck against Postgres. A definitive negative revokes the
 * session — the row goes `disconnected` with `errorMessage='revoked:<reason>'`
 * and the agent is told to stop the stream through the DURABLE relay. An
 * infrastructure failure (DB or Redis) is NOT a negative: it returns
 * `unavailable`, the caller answers 503 `lease_unavailable`, and the agent
 * rides its 90 s grace window before self-stopping.
 *
 * Naming: "revocation lease" throughout (`revocationLease*` / `RevocationLease`).
 * The agent already has an unrelated "desktop lease" (its helper-process
 * keepalive, `handlers_desktop_lease.go`), and the API already has a
 * "remote WS shared lease" (`remoteWsSharedLease.ts`, split-brain ownership for
 * the desktop AND terminal sockets). This module deliberately owns its OWN
 * constants and Redis keyspace so neither of those can be retuned by accident.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  devices,
  organizations,
  organizationUsers,
  partnerUsers,
  remoteSessions,
  roles,
  userPasskeys,
  users,
} from '../db/schema';
import { getRedis } from './redis';
import { teardownDisconnectedSessions } from './remoteSessionTeardown';
import { resolveDesktopSessionPolicy } from './remoteAccessPolicy';

// ---------------------------------------------------------------------------
// Constants — owned here, never borrowed from remoteWsSharedLease.ts
// ---------------------------------------------------------------------------

/** How long a lease survives without a successful renew. */
export const REVOCATION_LEASE_TTL_MS = 60_000;
/** How often the agent / viewer is told to renew. */
export const REVOCATION_LEASE_RENEW_EVERY_MS = 25_000;
/**
 * Extra time past `expiresAt` the agent tolerates before self-stopping. This is
 * the outage budget: an API or Redis blip must not kill in-flight sessions, but
 * an agent that cannot reach the control plane at all must not hold control
 * indefinitely either.
 */
export const REVOCATION_LEASE_GRACE_MS = 90_000;
/**
 * Absolute ceiling on a desktop session, which policy can shorten but never
 * extend. `maxSessionDurationHours = 0` used to mean "unlimited"; it now
 * resolves to this cap, as does any stored value above it.
 */
export const REVOCATION_LEASE_HARD_CAP_MS = 12 * 60 * 60 * 1000;
/** The one agent protocol version this server implements. */
export const REVOCATION_LEASE_PROTOCOL_VERSION = 1;

export function revocationLeaseRedisKey(sessionId: string): string {
  return `remote:revocation-lease:${sessionId}`;
}

// Same acquire / renew / release shape as remoteWsSharedLease.ts, but over this
// module's own key. `renew` returns the stored value so the caller can read the
// hard deadline back without a second round trip.
export const REVOCATION_LEASE_SCRIPTS = {
  acquire: `
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    return ARGV[1]
  `,
  renew: `
    local value = redis.call('GET', KEYS[1])
    if not value then return nil end
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    return value
  `,
  release: `
    return redis.call('DEL', KEYS[1])
  `,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RevocationReason =
  | 'session_ended'
  | 'user_inactive'
  | 'epoch_baseline_missing'
  | 'permissions_changed'
  | 'membership_removed'
  | 'site_scope_lost'
  | 'mfa_required'
  | 'hard_deadline';

/** The lease block shipped to the agent inside the `start_desktop` payload. */
export interface RevocationLeaseGrant {
  token: string;
  expiresAt: number;
  hardDeadline: number;
  renewEverySec: number;
  graceSec: number;
}

export type RenewRevocationLeaseResult =
  | {
      status: 'renewed';
      expiresAt: number;
      hardDeadline: number;
      renewEverySec: number;
      graceSec: number;
    }
  | { status: 'revoked'; reason: RevocationReason }
  | { status: 'forbidden' }
  | { status: 'unavailable' };

/** Everything the recheck needs, read in ONE query. */
export interface RevocationRecheckRow {
  session: {
    id: string;
    type: string;
    status: string;
    userId: string;
    deviceId: string;
    orgId: string;
    startedAt: Date | null;
    createdAt: Date;
    permissionsEpochSnapshot: number | null;
  };
  device: {
    id: string;
    orgId: string;
    siteId: string | null;
    agentId: string | null;
    /** Agent-declared revocation-lease protocol version; 0 = not capable. */
    revocationLeaseProtocolVersion: number;
  };
  user: {
    status: string;
    permissionsEpoch: number;
    orgId: string | null;
    partnerId: string;
    mfaProtected: boolean;
  };
  orgMembership: { roleId: string; siteIds: string[] | null; forceMfa: boolean } | null;
  partnerMembership: {
    roleId: string;
    orgAccess: string;
    orgIds: string[] | null;
    forceMfa: boolean;
  } | null;
  /**
   * Whether the session's org is still a live org under the caller's partner.
   * Mirrors the partner-axis check in `resolveLiveEventAuthorization`: an
   * archived / soft-deleted / cross-partner org is not reachable any more.
   */
  sessionOrgUsable: boolean;
}

/** Live statuses a lease may be renewed for. */
const RENEWABLE_STATUSES = new Set(['pending', 'connecting', 'active']);

// ---------------------------------------------------------------------------
// Hard deadline
// ---------------------------------------------------------------------------

/**
 * `startedAt + min(policy.maxSessionDurationHours || 12h, 12h)`.
 *
 * A policy value of 0 no longer means unlimited — it clamps UP to the cap, not
 * out of it. Anything above 12 h clamps DOWN. A non-finite or negative value is
 * treated as unset and gets the cap.
 */
export function clampHardDeadline(startMs: number, maxSessionDurationHours: number): number {
  const hours = Number.isFinite(maxSessionDurationHours)
    ? Math.trunc(maxSessionDurationHours)
    : 0;
  const requested = hours > 0 ? hours * 60 * 60 * 1000 : REVOCATION_LEASE_HARD_CAP_MS;
  return startMs + Math.min(requested, REVOCATION_LEASE_HARD_CAP_MS);
}

/** When a session's clock starts: the answer time if it has one, else creation. */
export function sessionStartMs(session: { startedAt: Date | null; createdAt: Date }): number {
  return (session.startedAt ?? session.createdAt).getTime();
}

// ---------------------------------------------------------------------------
// The recheck decision (pure — every branch is unit-tested)
// ---------------------------------------------------------------------------

export type RecheckVerdict = { ok: true } | { ok: false; reason: RevocationReason };

/**
 * Decide whether a live session may keep running.
 *
 * Ordering is deliberate: cheapest / most conclusive first, and the site-scope
 * check comes AFTER membership so a removed member is reported as
 * `membership_removed` rather than as a site problem.
 */
export function evaluateRevocationRecheck(
  row: RevocationRecheckRow | null,
  nowMs: number,
  hardDeadlineMs: number,
): RecheckVerdict {
  if (!row) return { ok: false, reason: 'session_ended' };

  const { session, device, user, orgMembership, partnerMembership } = row;

  if (!RENEWABLE_STATUSES.has(session.status)) {
    return { ok: false, reason: 'session_ended' };
  }
  if (user.status !== 'active') {
    return { ok: false, reason: 'user_inactive' };
  }
  // A lease-bearing session ALWAYS captured a baseline at creation. A missing
  // one means we cannot prove the caller's authority is unchanged, which is a
  // definitive negative, not an infrastructure blip.
  if (session.permissionsEpochSnapshot === null) {
    return { ok: false, reason: 'epoch_baseline_missing' };
  }
  if (user.permissionsEpoch !== session.permissionsEpochSnapshot) {
    return { ok: false, reason: 'permissions_changed' };
  }
  // The device must still belong to the org the session was authorized against
  // (a device moved between orgs takes a fresh authorization, not this one).
  if (device.orgId !== session.orgId) {
    return { ok: false, reason: 'membership_removed' };
  }

  let forceMfa: boolean;
  if (user.orgId !== null) {
    // Org-scoped user: the session's org must be their own org, and the
    // membership row (which carries role + site ceiling) must still exist.
    if (user.orgId !== session.orgId || !orgMembership?.roleId) {
      return { ok: false, reason: 'membership_removed' };
    }
    if (orgMembership.siteIds !== null) {
      if (typeof device.siteId !== 'string' || !orgMembership.siteIds.includes(device.siteId)) {
        return { ok: false, reason: 'site_scope_lost' };
      }
    }
    forceMfa = orgMembership.forceMfa;
  } else {
    // Partner-scoped user: partner membership must exist, still grant org
    // access, and still cover this org — and the org itself must be live.
    if (!partnerMembership?.roleId || partnerMembership.orgAccess === 'none') {
      return { ok: false, reason: 'membership_removed' };
    }
    if (
      partnerMembership.orgAccess === 'selected' &&
      !(partnerMembership.orgIds ?? []).includes(session.orgId)
    ) {
      return { ok: false, reason: 'membership_removed' };
    }
    if (!row.sessionOrgUsable) {
      return { ok: false, reason: 'membership_removed' };
    }
    forceMfa = partnerMembership.forceMfa;
  }

  // MFA per CURRENT policy. The force_mfa flip itself already advances
  // permissions_epoch (2026-08-06-b-live-authorization.sql), so this catches the
  // other direction: a role that forces MFA whose holder no longer has any
  // factor (e.g. every passkey deleted) must not keep a live desktop.
  if (forceMfa && !user.mfaProtected) {
    return { ok: false, reason: 'mfa_required' };
  }

  if (nowMs >= hardDeadlineMs) {
    return { ok: false, reason: 'hard_deadline' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The recheck query — ONE round trip
// ---------------------------------------------------------------------------

export async function loadRevocationRecheckRow(
  sessionId: string,
): Promise<RevocationRecheckRow | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgRole = sql<boolean | null>`org_role.force_mfa`;
      const partnerRole = sql<boolean | null>`partner_role.force_mfa`;
      const [found] = await db
        .select({
          sessionId: remoteSessions.id,
          sessionType: remoteSessions.type,
          sessionStatus: remoteSessions.status,
          sessionUserId: remoteSessions.userId,
          sessionDeviceId: remoteSessions.deviceId,
          sessionOrgId: remoteSessions.orgId,
          sessionStartedAt: remoteSessions.startedAt,
          sessionCreatedAt: remoteSessions.createdAt,
          permissionsEpochSnapshot: remoteSessions.permissionsEpochSnapshot,
          deviceId: devices.id,
          deviceOrgId: devices.orgId,
          deviceSiteId: devices.siteId,
          deviceAgentId: devices.agentId,
          deviceLeaseVersion: devices.revocationLeaseProtocolVersion,
          userStatus: users.status,
          userPermissionsEpoch: users.permissionsEpoch,
          userOrgId: users.orgId,
          userPartnerId: users.partnerId,
          userMfaEnabled: users.mfaEnabled,
          userHasPasskey: sql<boolean>`EXISTS (
            SELECT 1 FROM ${userPasskeys} WHERE ${userPasskeys.userId} = ${users.id}
          )`,
          orgRoleId: organizationUsers.roleId,
          orgSiteIds: organizationUsers.siteIds,
          orgForceMfa: orgRole,
          partnerRoleId: partnerUsers.roleId,
          partnerOrgAccess: partnerUsers.orgAccess,
          partnerOrgIds: partnerUsers.orgIds,
          partnerForceMfa: partnerRole,
          sessionOrgUsable: sql<boolean>`EXISTS (
            SELECT 1 FROM ${organizations}
            WHERE ${organizations.id} = ${remoteSessions.orgId}
              AND ${organizations.partnerId} = ${users.partnerId}
              AND ${organizations.status} IN ('active', 'trial')
              AND ${organizations.deletedAt} IS NULL
          )`,
        })
        .from(remoteSessions)
        .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
        .innerJoin(users, eq(remoteSessions.userId, users.id))
        .leftJoin(
          organizationUsers,
          and(
            eq(organizationUsers.userId, remoteSessions.userId),
            eq(organizationUsers.orgId, remoteSessions.orgId),
          ),
        )
        .leftJoin(
          sql`${roles} AS org_role`,
          sql`org_role.id = ${organizationUsers.roleId}`,
        )
        .leftJoin(
          partnerUsers,
          and(
            eq(partnerUsers.userId, remoteSessions.userId),
            eq(partnerUsers.partnerId, users.partnerId),
          ),
        )
        .leftJoin(
          sql`${roles} AS partner_role`,
          sql`partner_role.id = ${partnerUsers.roleId}`,
        )
        .where(eq(remoteSessions.id, sessionId))
        .limit(1);

      if (!found) return null;

      return {
        session: {
          id: found.sessionId,
          type: found.sessionType,
          status: found.sessionStatus,
          userId: found.sessionUserId,
          deviceId: found.sessionDeviceId,
          orgId: found.sessionOrgId,
          startedAt: found.sessionStartedAt ?? null,
          createdAt: found.sessionCreatedAt,
          permissionsEpochSnapshot:
            found.permissionsEpochSnapshot === null ||
            found.permissionsEpochSnapshot === undefined
              ? null
              : Number(found.permissionsEpochSnapshot),
        },
        device: {
          id: found.deviceId,
          orgId: found.deviceOrgId,
          siteId: found.deviceSiteId ?? null,
          agentId: found.deviceAgentId ?? null,
          revocationLeaseProtocolVersion: Number(found.deviceLeaseVersion ?? 0),
        },
        user: {
          status: found.userStatus,
          permissionsEpoch: Number(found.userPermissionsEpoch),
          orgId: found.userOrgId ?? null,
          partnerId: found.userPartnerId,
          mfaProtected: found.userMfaEnabled === true || found.userHasPasskey === true,
        },
        orgMembership: found.orgRoleId
          ? {
              roleId: found.orgRoleId,
              siteIds: found.orgSiteIds ?? null,
              forceMfa: found.orgForceMfa === true,
            }
          : null,
        partnerMembership: found.partnerRoleId
          ? {
              roleId: found.partnerRoleId,
              // A left-joined enum is nullable in the row type; a NULL org_access
              // is treated as 'none' (fail closed), never as blanket access.
              orgAccess: found.partnerOrgAccess ?? 'none',
              orgIds: found.partnerOrgIds ?? null,
              forceMfa: found.partnerForceMfa === true,
            }
          : null,
        sessionOrgUsable: found.sessionOrgUsable === true,
      } satisfies RevocationRecheckRow;
    }),
  );
}

/**
 * Mark a revoked session terminal. Teardown-sweep convention: `disconnected` +
 * `errorMessage='revoked:<reason>'` + `endedAt=now()`. Only a still-live row is
 * touched, so a racing teardown never has its history overwritten.
 */
export async function markSessionRevoked(
  sessionId: string,
  reason: RevocationReason,
): Promise<{ id: string; type: string; deviceId: string } | null> {
  const [updated] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .update(remoteSessions)
        .set({
          status: 'disconnected',
          endedAt: new Date(),
          errorMessage: `revoked:${reason}`,
        })
        .where(
          and(
            eq(remoteSessions.id, sessionId),
            sql`${remoteSessions.status} IN ('pending', 'connecting', 'active')`,
          ),
        )
        .returning({
          id: remoteSessions.id,
          type: remoteSessions.type,
          deviceId: remoteSessions.deviceId,
        }),
    ),
  );
  return updated ?? null;
}

// ---------------------------------------------------------------------------
// Issue / renew / release
// ---------------------------------------------------------------------------

interface StoredLease {
  userId: string;
  deviceId: string;
  permissionsEpoch: number;
  issuedAt: number;
  hardDeadline: number;
}

function parseStoredLease(raw: unknown): StoredLease | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLease>;
    if (typeof parsed?.hardDeadline !== 'number') return null;
    return parsed as StoredLease;
  } catch {
    return null;
  }
}

/**
 * Mint the lease that rides along in the `start_desktop` payload.
 *
 * Redis is a cache of the TTL, never the only baseline: the durable baseline is
 * `remote_sessions.permissions_epoch_snapshot`, so a renew after a Redis flush
 * still re-derives everything it needs from the row.
 */
export async function issueRevocationLease(input: {
  sessionId: string;
  userId: string;
  deviceId: string;
  permissionsEpoch: number;
  startMs: number;
  maxSessionDurationHours: number;
  now?: () => number;
  redis?: Redis | null;
}): Promise<RevocationLeaseGrant> {
  const now = (input.now ?? Date.now)();
  const hardDeadline = clampHardDeadline(input.startMs, input.maxSessionDurationHours);
  const token = `${input.sessionId}:${now}`;
  const stored: StoredLease = {
    userId: input.userId,
    deviceId: input.deviceId,
    permissionsEpoch: input.permissionsEpoch,
    issuedAt: now,
    hardDeadline,
  };
  const redis = input.redis === undefined ? getRedis() : input.redis;
  if (redis) {
    try {
      await redis.eval(
        REVOCATION_LEASE_SCRIPTS.acquire,
        1,
        revocationLeaseRedisKey(input.sessionId),
        JSON.stringify(stored),
        String(REVOCATION_LEASE_TTL_MS),
      );
    } catch (err) {
      // Non-fatal: the durable baseline is the session row, and the agent's
      // first renew re-derives the deadline. Never block a session start on it.
      console.warn(
        `[RevocationLease] Failed to cache lease for session ${input.sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return {
    token,
    expiresAt: now + REVOCATION_LEASE_TTL_MS,
    hardDeadline,
    renewEverySec: REVOCATION_LEASE_RENEW_EVERY_MS / 1000,
    graceSec: REVOCATION_LEASE_GRACE_MS / 1000,
  };
}

export async function releaseRevocationLease(sessionId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.eval(REVOCATION_LEASE_SCRIPTS.release, 1, revocationLeaseRedisKey(sessionId));
  } catch {
    // TTL expiry collects it anyway.
  }
}

export interface RenewRevocationLeaseOptions {
  /** Only renew when the session belongs to this user (viewer / JWT callers). */
  expectUserId?: string;
  /** Only renew when the session targets this device (agent WS callers). */
  expectDeviceId?: string;
  // Injection seams — production callers pass none of these.
  loadRow?: (sessionId: string) => Promise<RevocationRecheckRow | null>;
  markRevoked?: (
    sessionId: string,
    reason: RevocationReason,
  ) => Promise<{ id: string; type: string; deviceId: string } | null>;
  redis?: Redis | null;
  now?: () => number;
}

/**
 * The live authorization recheck plus a TTL bump. ONE query and one Redis
 * round trip — no per-session polling loop anywhere on the API.
 *
 * Failure semantics (§6E of the contract): only a DEFINITIVE negative revokes.
 * A DB or Redis error returns `unavailable` and leaves the session row alone;
 * the caller answers 503 `lease_unavailable` and the agent rides its grace
 * window. Anything else would turn a Redis blip into a fleet-wide disconnect.
 */
export async function renewRevocationLease(
  sessionId: string,
  options: RenewRevocationLeaseOptions = {},
): Promise<RenewRevocationLeaseResult> {
  const now = (options.now ?? Date.now)();
  const loadRow = options.loadRow ?? loadRevocationRecheckRow;
  const markRevoked = options.markRevoked ?? markSessionRevoked;
  const redis = options.redis === undefined ? getRedis() : options.redis;

  let row: RevocationRecheckRow | null;
  try {
    row = await loadRow(sessionId);
  } catch (err) {
    console.error(
      `[RevocationLease] Recheck query failed for session ${sessionId} (returning lease_unavailable):`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'unavailable' };
  }

  // Caller identity is an authorization question, not a revocation trigger: a
  // mismatched caller must never be able to end somebody else's session.
  if (row) {
    if (options.expectUserId && row.session.userId !== options.expectUserId) {
      return { status: 'forbidden' };
    }
    if (options.expectDeviceId && row.session.deviceId !== options.expectDeviceId) {
      return { status: 'forbidden' };
    }
  }

  // Bump the TTL and read the cached hard deadline back in one round trip.
  let cached: StoredLease | null = null;
  if (redis) {
    try {
      cached = parseStoredLease(
        await redis.eval(
          REVOCATION_LEASE_SCRIPTS.renew,
          1,
          revocationLeaseRedisKey(sessionId),
          String(REVOCATION_LEASE_TTL_MS),
        ),
      );
    } catch (err) {
      console.error(
        `[RevocationLease] Redis renew failed for session ${sessionId} (returning lease_unavailable):`,
        err instanceof Error ? err.message : err,
      );
      return { status: 'unavailable' };
    }
  }

  let hardDeadline: number;
  if (cached) {
    hardDeadline = cached.hardDeadline;
  } else if (row) {
    // Redis lost the lease (flush, failover, eviction). Re-derive from the
    // durable row + the device's current policy — never from a default that
    // could EXTEND the session past what policy allows.
    try {
      const policy = await resolveDesktopSessionPolicy(row.device.id);
      hardDeadline = clampHardDeadline(
        sessionStartMs(row.session),
        policy.maxSessionDurationHours,
      );
    } catch {
      hardDeadline = clampHardDeadline(sessionStartMs(row.session), 0);
    }
  } else {
    hardDeadline = now;
  }

  const verdict = evaluateRevocationRecheck(row, now, hardDeadline);
  if (verdict.ok) {
    return {
      status: 'renewed',
      expiresAt: now + REVOCATION_LEASE_TTL_MS,
      hardDeadline,
      renewEverySec: REVOCATION_LEASE_RENEW_EVERY_MS / 1000,
      graceSec: REVOCATION_LEASE_GRACE_MS / 1000,
    };
  }

  try {
    const disconnected = await markRevoked(sessionId, verdict.reason);
    if (disconnected) {
      // Revoke the viewer token AND push `stop_desktop` through the DURABLE
      // relay, so a session owned by another API instance still dies.
      await teardownDisconnectedSessions([disconnected]);
    }
    await releaseRevocationLease(sessionId).catch(() => {});
  } catch (err) {
    // The verdict stands even if the bookkeeping failed — the caller must still
    // be told the session is revoked, and the agent stops on that answer alone.
    console.error(
      `[RevocationLease] Failed to finalize revoked session ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { status: 'revoked', reason: verdict.reason };
}

// ---------------------------------------------------------------------------
// Desktop-start capability gate
// ---------------------------------------------------------------------------

/** Machine code every desktop-start dispatch site returns with its 503. */
export const AGENT_UPGRADE_REQUIRED_CODE = 'agent_upgrade_required';

/**
 * Operator-facing text for the 503. Deliberately explicit that this is a
 * pending agent update rather than an offline device: an online agent that has
 * not heartbeated since upgrading still reads as capability 0 for up to one
 * heartbeat interval (default 60 s).
 */
export const AGENT_UPGRADE_REQUIRED_MESSAGE =
  'Remote desktop needs an agent update on this device (session revocation lease support). '
  + 'The agent updates itself automatically — this usually clears within a minute. '
  + 'Terminal and file transfer are unaffected.';

export type PrepareRevocationLeaseResult =
  | { ok: true; lease: RevocationLeaseGrant }
  | { ok: false; reason: 'agent_upgrade_required' | 'session_unavailable' };

/**
 * Gate a desktop start on the agent's revocation-lease capability and mint the
 * lease block the `start_desktop` / `desktop_stream_start` payload carries.
 *
 * Fail-closed by construction: without a capable agent there is no mechanism to
 * end a live peer-to-peer session the server can no longer authorize, so the
 * session is refused outright rather than started unrevokable.
 */
export async function prepareRevocationLeaseForStart(
  sessionId: string,
  options: { loadRow?: (id: string) => Promise<RevocationRecheckRow | null>; now?: () => number } = {},
): Promise<PrepareRevocationLeaseResult> {
  const loadRow = options.loadRow ?? loadRevocationRecheckRow;
  let row: RevocationRecheckRow | null;
  try {
    row = await loadRow(sessionId);
  } catch (err) {
    console.error(
      `[RevocationLease] Failed to load session ${sessionId} for lease issue:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: 'session_unavailable' };
  }
  if (!row) return { ok: false, reason: 'session_unavailable' };

  if (row.device.revocationLeaseProtocolVersion !== REVOCATION_LEASE_PROTOCOL_VERSION) {
    return { ok: false, reason: 'agent_upgrade_required' };
  }
  if (row.session.permissionsEpochSnapshot === null) {
    // No durable baseline means no renew can ever prove authority — refusing
    // here is the same fail-closed answer the renew path would give anyway.
    return { ok: false, reason: 'session_unavailable' };
  }

  let maxSessionDurationHours: number;
  try {
    ({ maxSessionDurationHours } = await resolveDesktopSessionPolicy(row.device.id));
  } catch {
    maxSessionDurationHours = 0; // → the 12 h hard cap
  }

  const lease = await issueRevocationLease({
    sessionId,
    userId: row.session.userId,
    deviceId: row.session.deviceId,
    permissionsEpoch: row.session.permissionsEpochSnapshot,
    startMs: sessionStartMs(row.session),
    maxSessionDurationHours,
    now: options.now,
  });
  return { ok: true, lease };
}

/**
 * Cheap standalone capability probe for callers that only need to fail fast
 * (session creation) and have no session row yet.
 */
export async function isRevocationLeaseCapable(deviceId: string): Promise<boolean> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ version: devices.revocationLeaseProtocolVersion })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1),
    ),
  );
  return Number(row?.version ?? 0) === REVOCATION_LEASE_PROTOCOL_VERSION;
}
