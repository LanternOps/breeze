import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { randomBytes } from 'crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, withSystemDbAccessContext } from '../db';
import { organizationUsers, organizations, partnerUsers, users } from '../db/schema';
import {
  EVENT_PERMISSION_EPOCH_MODE,
  type EventPermissionEpochMode,
} from '../config/env';
import { getRedis } from '../services/redis';
import { getEventDispatcher, type ClientEntry } from '../services/eventDispatcher';
import { authMiddleware, resolveOrgAccess } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICKET_TTL_MS = 30 * 1000; // 30 seconds
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_KEY_PREFIX = 'event:ws_ticket:';
const EVENT_TYPE_RE = /^(\*|[a-z]+\.\*|[a-z]+\.[a-z_]+)$/;

// Mid-session revalidation cadence. Every connection re-resolves user state,
// permission epoch, membership, and site scope at 30s plus bounded jitter.
// One transient database failure gets a short retry; a second failure closes.
const REVALIDATE_INTERVAL_MS = 30 * 1000; // 30 seconds
const REVALIDATE_JITTER_MAX_MS = 5 * 1000;
const REVALIDATE_DB_RETRY_MS = 5 * 1000;

// ---------------------------------------------------------------------------
// Ticket store (in-memory for dev, Redis for production)
// ---------------------------------------------------------------------------

interface EventTicketV1 {
  version?: 1;
  userId: string;
  orgIds?: string[];
  orgId?: string;
  allowedSiteIds?: string[];
  expiresAt: number;
}

export interface EventTicketV2 {
  version: 2;
  userId: string;
  orgId: string | null;
  partnerId: string;
  allowedOrgIds: string[];
  allowedSiteIds: string[] | null;
  permissionsEpoch: number;
  expiresAt: number;
}

export type EventAuthorizationCheck =
  | { ok: true; identity: EventTicketV2 }
  | {
      ok: false;
      reason:
        | 'user_inactive'
        | 'permission_epoch_mismatch'
        | 'membership_removed'
        | 'legacy_ticket_rejected'
        | 'live_state_unavailable';
    };

type StoredTicketRecord = EventTicketV1 | EventTicketV2;

const ticketStore = new Map<string, StoredTicketRecord>();

function shouldUseRedis(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}

function isExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt;
}

function purgeExpired(): void {
  for (const [key, record] of ticketStore) {
    if (isExpired(record.expiresAt)) {
      ticketStore.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

export async function createEventWsTicket(
  userId: string,
  orgIdOrIds: string | string[],
  allowedSiteIds?: string[] | null,
  authority?: { orgId?: string | null; partnerId?: string | null },
): Promise<{ ticket: string; expiresInSeconds: number }> {
  const orgIds = Array.isArray(orgIdOrIds) ? [...new Set(orgIdOrIds)] : [orgIdOrIds];
  if (orgIds.length === 0) {
    throw new Error('createEventWsTicket requires at least one orgId');
  }

  const liveUser = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        status: users.status,
        permissionsEpoch: users.permissionsEpoch,
        partnerId: users.partnerId,
        orgId: users.orgId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row;
  });
  if (!liveUser || liveUser.status !== 'active') {
    throw new Error('Event WS authorization is unavailable');
  }
  if (authority?.partnerId && authority.partnerId !== liveUser.partnerId) {
    throw new Error('Event WS authorization is unavailable');
  }
  if (authority?.orgId && authority.orgId !== liveUser.orgId) {
    throw new Error('Event WS authorization is unavailable');
  }

  // Only mutate the ticket store after the live authorization gates above
  // have succeeded. A denied mint must have no cleanup/storage side effects.
  purgeExpired();

  const normalisedSiteIds =
    allowedSiteIds == null ? null : [...new Set(allowedSiteIds)];
  const authorityOrgId =
    authority?.orgId !== undefined
      ? authority.orgId
      : liveUser.orgId && orgIds.includes(liveUser.orgId)
        ? liveUser.orgId
        : null;

  const ticket = randomBytes(32).toString('base64url');
  const record: EventTicketV2 = {
    version: 2,
    userId,
    orgId: authorityOrgId,
    partnerId: liveUser.partnerId,
    allowedOrgIds: orgIds,
    allowedSiteIds: normalisedSiteIds,
    permissionsEpoch: liveUser.permissionsEpoch,
    expiresAt: Date.now() + TICKET_TTL_MS,
  };

  const ttlSeconds = Math.floor(TICKET_TTL_MS / 1000);

  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      throw new Error('Event WS tickets are unavailable (Redis required)');
    }
    await redis.setex(`${REDIS_KEY_PREFIX}${ticket}`, ttlSeconds, JSON.stringify(record));
  } else {
    ticketStore.set(ticket, record);
  }

  return { ticket, expiresInSeconds: ttlSeconds };
}

// ---------------------------------------------------------------------------
// Ticket consumption (atomic one-time use)
// ---------------------------------------------------------------------------

function legacyOrgIds(record: EventTicketV1): string[] {
  return record.orgIds && record.orgIds.length > 0
    ? [...new Set(record.orgIds)]
    : record.orgId
      ? [record.orgId]
      : [];
}

type PeekedTicket = {
  record: StoredTicketRecord;
  redisRaw: string | null;
};

async function peekTicket(ticket: string): Promise<PeekedTicket | null> {
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      console.error('[EventWs] Redis unavailable during ticket consumption');
      return null;
    }

    const raw = await redis.get(`${REDIS_KEY_PREFIX}${ticket}`);
    if (!raw || typeof raw !== 'string') return null;

    let record: StoredTicketRecord;
    try {
      record = JSON.parse(raw) as StoredTicketRecord;
    } catch (err) {
      console.error('[EventWs] Failed to parse ticket record from Redis:', err instanceof Error ? err.message : err);
      return null;
    }

    return isExpired(record.expiresAt) ? null : { record, redisRaw: raw };
  }

  const record = ticketStore.get(ticket);
  if (!record) return null;
  return isExpired(record.expiresAt) ? null : { record, redisRaw: null };
}

// Compare-and-delete preserves one-time semantics without mutating a ticket
// that fails live authorization. The compare closes the race between the
// authorization query and consumption: exactly one concurrent upgrader wins.
const CONSUME_IF_UNCHANGED_LUA = `
  local v = redis.call('GET', KEYS[1])
  if v and v == ARGV[1] then
    redis.call('DEL', KEYS[1])
    return 1
  end
  return 0
`;

async function consumePeekedTicket(
  ticket: string,
  peeked: PeekedTicket,
): Promise<boolean> {
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis || peeked.redisRaw === null) return false;
    const consumed = await redis.eval(
      CONSUME_IF_UNCHANGED_LUA,
      1,
      `${REDIS_KEY_PREFIX}${ticket}`,
      peeked.redisRaw,
    );
    return consumed === 1;
  }

  if (ticketStore.get(ticket) !== peeked.record) return false;
  return ticketStore.delete(ticket);
}

async function resolveLegacyEventAuthorization(
  record: EventTicketV1,
): Promise<EventAuthorizationCheck> {
  const requestedOrgIds = legacyOrgIds(record);
  if (requestedOrgIds.length === 0) {
    return { ok: false, reason: 'legacy_ticket_rejected' };
  }

  try {
    return await withSystemDbAccessContext(async (): Promise<EventAuthorizationCheck> => {
      const [user] = await db
        .select({
          status: users.status,
          permissionsEpoch: users.permissionsEpoch,
          partnerId: users.partnerId,
          orgId: users.orgId,
        })
        .from(users)
        .where(eq(users.id, record.userId))
        .limit(1);
      if (!user || user.status !== 'active') {
        return { ok: false, reason: 'user_inactive' };
      }

      if (user.orgId) {
        if (requestedOrgIds.length !== 1 || requestedOrgIds[0] !== user.orgId) {
          return { ok: false, reason: 'membership_removed' };
        }
        const [membership] = await db
          .select({
            roleId: organizationUsers.roleId,
            siteIds: organizationUsers.siteIds,
          })
          .from(organizationUsers)
          .where(
            and(
              eq(organizationUsers.userId, record.userId),
              eq(organizationUsers.orgId, user.orgId),
            ),
          )
          .limit(1);
        if (!membership?.roleId) {
          return { ok: false, reason: 'membership_removed' };
        }
        const identity: EventTicketV2 = {
          version: 2,
          userId: record.userId,
          orgId: user.orgId,
          partnerId: user.partnerId,
          allowedOrgIds: [user.orgId],
          allowedSiteIds:
            membership.siteIds == null ? null : [...new Set(membership.siteIds)],
          permissionsEpoch: user.permissionsEpoch,
          expiresAt: record.expiresAt,
        };
        return { ok: true, identity };
      }

      const [membership] = await db
        .select({
          roleId: partnerUsers.roleId,
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds,
        })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.userId, record.userId),
            eq(partnerUsers.partnerId, user.partnerId),
          ),
        )
        .limit(1);
      if (!membership?.roleId || membership.orgAccess === 'none') {
        return { ok: false, reason: 'membership_removed' };
      }

      const candidateIds =
        membership.orgAccess === 'selected' ? membership.orgIds ?? [] : undefined;
      const currentOrganizations = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.partnerId, user.partnerId),
            inArray(organizations.status, ['active', 'trial']),
            isNull(organizations.deletedAt),
            ...(candidateIds ? [inArray(organizations.id, candidateIds)] : []),
          ),
        )
        .limit(10_000);
      const currentOrgIds = new Set(currentOrganizations.map((org) => org.id));
      if (requestedOrgIds.some((orgId) => !currentOrgIds.has(orgId))) {
        return { ok: false, reason: 'membership_removed' };
      }
      const identity: EventTicketV2 = {
        version: 2,
        userId: record.userId,
        orgId: null,
        partnerId: user.partnerId,
        allowedOrgIds: requestedOrgIds,
        allowedSiteIds: null,
        permissionsEpoch: user.permissionsEpoch,
        expiresAt: record.expiresAt,
      };
      return { ok: true, identity };
    });
  } catch {
    return { ok: false, reason: 'live_state_unavailable' };
  }
}

export async function consumeTicket(
  ticket: string,
  mode: EventPermissionEpochMode = EVENT_PERMISSION_EPOCH_MODE,
): Promise<EventTicketV2 | null> {
  const peeked = await peekTicket(ticket);
  if (!peeked) return null;

  let resolved: EventAuthorizationCheck;
  if (peeked.record.version === 2) {
    resolved = await resolveLiveEventAuthorization(peeked.record);
  } else if (
    peeked.record.version === undefined ||
    peeked.record.version === 1
  ) {
    if (mode === 'enforce') return null;
    resolved = await resolveLegacyEventAuthorization(peeked.record);
  } else {
    return null;
  }
  if (!resolved.ok) return null;
  return (await consumePeekedTicket(ticket, peeked)) ? resolved.identity : null;
}

// ---------------------------------------------------------------------------
// Client → Server message schema (Zod)
// ---------------------------------------------------------------------------

const eventTypePattern = z.string().regex(EVENT_TYPE_RE, 'Invalid event type pattern');

const clientMessageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('subscribe'), types: z.array(eventTypePattern).min(1).max(50) }),
  z.object({ action: z.literal('unsubscribe'), types: z.array(eventTypePattern).min(1).max(50) }),
  z.object({ action: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client message helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-client SITE-scope delivery predicate for a site-restricted
 * connection. Returns `undefined` when the user is unrestricted (full org
 * access — no filtering, no behaviour change).
 *
 * The predicate runs synchronously in the dispatcher's hot path, so it can
 * only inspect fields already on the event message — it cannot do a DB lookup
 * to resolve a device's site. The published `BreezeEvent` (`eventBus.ts`)
 * carries no `siteId` on the wire — neither top-level nor in `payload` — so
 * there is no synchronous, correct way to attribute most events to a site.
 *
 * We therefore FAIL CLOSED: a site-restricted client only receives an event we
 * can POSITIVELY attribute to one of its allowed sites — i.e. the event must
 * carry a `siteId` (top-level or in `payload`) that is in the allowlist.
 * Because no publisher currently emits `siteId`, the practical effect is that
 * site-restricted users receive no live events until publishers are updated to
 * include `siteId` — strictly safer than the prior behaviour, which leaked
 * every org event (incl. other sites' devices/alerts) to them.
 *
 * RESIDUAL LIMITATION / FOLLOW-UP: add `siteId` to the event payload at publish
 * time (eventBus publishers) so in-site events are delivered. Once present,
 * this predicate starts allowing them with no further change here. A
 * deviceId→siteId map could alternatively be threaded in, but that needs a
 * synchronous cache and is out of scope for this WS-layer fix.
 */
export function buildSiteFilter(
  allowedSiteIds: string[] | null | undefined,
): ((event: Record<string, unknown>) => boolean) | undefined {
  if (allowedSiteIds == null) return undefined;

  const allowed = new Set(allowedSiteIds);

  return (event: Record<string, unknown>): boolean => {
    const siteId = extractEventSiteId(event);
    // Fail closed: deliver only when we can positively attribute the event to
    // an allowed site. No attributable siteId ⇒ drop.
    return typeof siteId === 'string' && allowed.has(siteId);
  };
}

/**
 * Pull a `siteId` off an event message if one is present. Checks the top level
 * first, then the nested `payload` object (publishers attach domain fields
 * under `payload`). Returns `undefined` when no string siteId is found.
 */
function extractEventSiteId(event: Record<string, unknown>): string | undefined {
  const top = event.siteId;
  if (typeof top === 'string' && top.length > 0) return top;

  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>).siteId;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return undefined;
}

/**
 * Mid-session revalidation: confirm the connection's user is still active.
 *
 * Compatibility helper retained for direct status callers. Socket lifecycle
 * authorization uses `resolveLiveEventAuthorization`, which additionally
 * checks the permission epoch and current membership/site authority.
 */
export async function isEventWsUserActive(userId: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return !!user && user.status === 'active';
  });
}

function equalStringSets(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

/**
 * Resolve the complete live authority for an already-consumed v2 ticket.
 * Every database read runs in one system context because the ticket path does
 * not carry a request JWT/RLS context. The result is deliberately bounded to
 * a reason enum; callers never expose database details or tenant identifiers.
 */
export async function resolveLiveEventAuthorization(
  ticket: EventTicketV2,
): Promise<EventAuthorizationCheck> {
  try {
    return await withSystemDbAccessContext(async (): Promise<EventAuthorizationCheck> => {
      const [user] = await db
        .select({
          status: users.status,
          permissionsEpoch: users.permissionsEpoch,
          partnerId: users.partnerId,
          orgId: users.orgId,
        })
        .from(users)
        .where(eq(users.id, ticket.userId))
        .limit(1);

      if (!user || user.status !== 'active') {
        return { ok: false, reason: 'user_inactive' };
      }
      if (
        user.permissionsEpoch !== ticket.permissionsEpoch ||
        user.partnerId !== ticket.partnerId
      ) {
        return { ok: false, reason: 'permission_epoch_mismatch' };
      }

      if (ticket.orgId) {
        if (
          user.orgId !== ticket.orgId ||
          ticket.allowedOrgIds.length !== 1 ||
          ticket.allowedOrgIds[0] !== ticket.orgId
        ) {
          return { ok: false, reason: 'membership_removed' };
        }
        const [membership] = await db
          .select({
            roleId: organizationUsers.roleId,
            siteIds: organizationUsers.siteIds,
          })
          .from(organizationUsers)
          .where(
            and(
              eq(organizationUsers.userId, ticket.userId),
              eq(organizationUsers.orgId, ticket.orgId),
            ),
          )
          .limit(1);
        if (!membership?.roleId) {
          return { ok: false, reason: 'membership_removed' };
        }
        const currentSiteIds =
          membership.siteIds == null ? null : [...new Set(membership.siteIds)];
        if (!equalStringSets(ticket.allowedSiteIds, currentSiteIds)) {
          return { ok: false, reason: 'permission_epoch_mismatch' };
        }
        return { ok: true, identity: ticket };
      }

      if (user.orgId !== null || ticket.allowedSiteIds !== null) {
        return { ok: false, reason: 'membership_removed' };
      }
      const [membership] = await db
        .select({
          roleId: partnerUsers.roleId,
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds,
        })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.userId, ticket.userId),
            eq(partnerUsers.partnerId, ticket.partnerId),
          ),
        )
        .limit(1);
      if (!membership?.roleId || membership.orgAccess === 'none') {
        return { ok: false, reason: 'membership_removed' };
      }

      const candidateIds =
        membership.orgAccess === 'selected' ? membership.orgIds ?? [] : undefined;
      const currentOrganizations = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.partnerId, ticket.partnerId),
            inArray(organizations.status, ['active', 'trial']),
            isNull(organizations.deletedAt),
            ...(candidateIds ? [inArray(organizations.id, candidateIds)] : []),
          ),
        )
        .limit(10_000);
      const currentOrgIds = new Set(currentOrganizations.map((org) => org.id));
      if (ticket.allowedOrgIds.some((orgId) => !currentOrgIds.has(orgId))) {
        return { ok: false, reason: 'membership_removed' };
      }
      return { ok: true, identity: ticket };
    });
  } catch {
    return { ok: false, reason: 'live_state_unavailable' };
  }
}

function sendJson(ws: WSContext, payload: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('[EventWs] Failed to send message to client:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// POST /ws-ticket  — creates a one-time ticket (JWT-authed)
// ---------------------------------------------------------------------------

export function createEventWsTicketRoute(): Hono {
  const app = new Hono();

  app.use('*', authMiddleware);

  app.post('/ws-ticket', async (c) => {
    const auth = c.get('auth');

    if (!auth?.user?.id) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Resolve orgId for partner/system users who pass it as a query param.
    // When no specific org is requested, partner-scoped users get a ticket
    // scoped to ALL their accessible orgs so a single connection can receive
    // events for the full set without the client needing to multiplex
    // tickets. This matches the list endpoints' scoping: the web client
    // (`useEventStream`) sends no params in All-Organizations mode, and
    // `fetchWithAuth` auto-injects `orgId=` when a specific org is selected.
    // (#2256: the old behaviour narrowed no-param multi-org requests to
    // `orgIds[0]` unless a legacy `allOrgs=1` flag was passed, so the
    // All-Orgs Devices view only received live status events for the first
    // org. The `allOrgs=1` param is no longer read at all — clients that
    // still send it (e.g. the mobile app) get the same all-orgs result.)
    const requestedOrgId = c.req.query('orgId') ?? undefined;
    const orgAccess = await resolveOrgAccess(auth, requestedOrgId);

    let orgIds: string[];
    if (auth.orgId) {
      orgIds = [auth.orgId];
    } else if (orgAccess.type === 'single') {
      orgIds = [orgAccess.orgId];
    } else if (orgAccess.type === 'multiple' && orgAccess.orgIds.length > 0) {
      orgIds = orgAccess.orgIds;
    } else {
      return c.json({ error: 'Organization context required — select an org first' }, 400);
    }

    // Capture the SITE-scope restriction (app-layer-only axis) so it's bound to
    // the ticket. A site-restricted org user must not receive live events for
    // sites outside their allowlist — RLS doesn't defend this and events are
    // pub/sub, not Postgres. Null/undefined means unrestricted; [] means none.
    // Sourced from `auth.allowedSiteIds` (set by authMiddleware), NOT
    // `c.get('permissions')` — this route mints a ticket behind authMiddleware
    // only, and `permissions` is populated solely by requirePermission, which
    // does not run here.
    const allowedSiteIds = auth.allowedSiteIds;

    const result = await createEventWsTicket(auth.user.id, orgIds, allowedSiteIds, {
      orgId: auth.orgId ?? null,
      partnerId: auth.partnerId ?? null,
    });
    return c.json(result);
  });

  return app;
}

// ---------------------------------------------------------------------------
// GET /ws?ticket=<ticket>  — WebSocket upgrade (ticket-authed)
// ---------------------------------------------------------------------------

export function createEventWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  app.get(
    '/ws',
    upgradeWebSocket((c: { req: { query: (key: string) => string | undefined } }) => {
      const ticket = c.req.query('ticket');
      return createEventWsHandlers(ticket);
    }),
  );

  return app;
}

// ---------------------------------------------------------------------------
// WebSocket handler factory
// ---------------------------------------------------------------------------

// Exported for tests: drives the WS lifecycle (onOpen/onClose) so the
// mid-session revalidation interval can be exercised without a real socket.
interface EventWsHandlerOptions {
  jitterMs?: () => number;
  resolveAuthorization?: (
    identity: EventTicketV2,
  ) => Promise<EventAuthorizationCheck>;
}

export function createEventWsHandlers(
  ticket: string | undefined,
  options: EventWsHandlerOptions = {},
) {
  let client: ClientEntry | null = null;
  let registeredOrgIds: string[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveDbFailures = 0;
  const resolveAuthorization =
    options.resolveAuthorization ?? resolveLiveEventAuthorization;
  const jitterMs = options.jitterMs ?? (() => Math.random() * REVALIDATE_JITTER_MAX_MS);

  function resetIdleTimer(ws: WSContext) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sendJson(ws, { type: 'error', message: 'Idle timeout' });
      ws.close(4008, 'Idle timeout');
    }, IDLE_TIMEOUT_MS);
  }

  function cleanup(_ws: WSContext) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (revalidateTimer) {
      clearTimeout(revalidateTimer);
      revalidateTimer = null;
    }
    if (client && registeredOrgIds.length > 0) {
      const dispatcher = getEventDispatcher();
      for (const id of registeredOrgIds) {
        dispatcher.unregister(id, client);
      }
      client = null;
      registeredOrgIds = [];
    }
  }

  /**
   * Tear the connection down because the user's access was revoked
   * mid-session. Unregisters from the dispatcher FIRST (stops delivery
   * synchronously — the dispatch loop can't pick a client it no longer holds),
   * then closes the socket fail-closed.
   */
  function closeRevoked(ws: WSContext, reason: string) {
    console.warn(`[EventWs] Connection revoked mid-session (${reason}), closing socket`);
    cleanup(ws);
    try {
      sendJson(ws, { type: 'error', message: 'Access revoked' });
      ws.close(4003, 'Access revoked');
    } catch (err) {
      console.error('[EventWs] Failed to close revoked socket:', err instanceof Error ? err.message : err);
    }
  }

  function scheduleRevalidation(
    ws: WSContext,
    identity: EventTicketV2,
    delayMs?: number,
  ) {
    const boundedJitter = Math.max(
      0,
      Math.min(REVALIDATE_JITTER_MAX_MS, Math.floor(jitterMs())),
    );
    const delay = delayMs ?? REVALIDATE_INTERVAL_MS + boundedJitter;
    revalidateTimer = setTimeout(() => {
      revalidateTimer = null;
      void resolveAuthorization(identity).then((result) => {
        if (!client) return;
        if (result.ok) {
          consecutiveDbFailures = 0;
          scheduleRevalidation(ws, result.identity);
          return;
        }
        if (result.reason === 'live_state_unavailable') {
          consecutiveDbFailures += 1;
          if (consecutiveDbFailures === 1) {
            scheduleRevalidation(ws, identity, REVALIDATE_DB_RETRY_MS);
            return;
          }
        }
        closeRevoked(ws, result.reason);
      });
    }, delay);
  }

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      try {
        if (!ticket) {
          sendJson(ws, { type: 'error', message: 'Missing ticket' });
          ws.close(4001, 'Missing ticket');
          return;
        }

        const identity = await consumeTicket(ticket);
        if (!identity) {
          sendJson(ws, { type: 'error', message: 'Invalid or expired ticket' });
          ws.close(4001, 'Invalid or expired ticket');
          return;
        }

        // A consumed ticket is still only a recent snapshot. Resolve it once
        // more before registering with the dispatcher so a revocation between
        // mint and upgrade cannot receive even one event.
        const initialAuthorization = await resolveAuthorization(identity);
        if (!initialAuthorization.ok) {
          sendJson(ws, { type: 'error', message: 'Access revoked' });
          ws.close(4003, 'Access revoked');
          return;
        }
        const liveIdentity = initialAuthorization.identity;

        registeredOrgIds = liveIdentity.allowedOrgIds;
        client = {
          ws,
          userId: liveIdentity.userId,
          subscribedTypes: new Set<string>(),
          // Site-scope (app-layer-only) delivery gate. Undefined for
          // unrestricted users — no filtering, no behaviour change.
          filter: buildSiteFilter(liveIdentity.allowedSiteIds),
        };

        const dispatcher = getEventDispatcher();
        for (const id of registeredOrgIds) {
          dispatcher.register(id, client);
        }
        resetIdleTimer(ws);
        // Mid-session revalidation: stop delivering and close fail-closed once
        // the user's access is revoked (status flipped inactive / row deleted).
        scheduleRevalidation(ws, liveIdentity);

        sendJson(ws, {
          type: 'connected',
          userId: liveIdentity.userId,
          orgIds: registeredOrgIds,
        });
      } catch (err) {
        console.error('[EventWs] onOpen error:', err);
        // Tear down any partial state (dispatcher registration, timers) so a
        // throw after register() doesn't leak a delivering client / interval.
        cleanup(ws);
        sendJson(ws, { type: 'error', message: 'Internal error' });
        ws.close(4001, 'Internal error');
      }
    },

    onMessage: (event: MessageEvent, ws: WSContext) => {
      if (!client) return;

      resetIdleTimer(ws);

      let raw: unknown;
      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        raw = JSON.parse(data);
      } catch {
        sendJson(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      const parsed = clientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        sendJson(ws, { type: 'error', message: 'Invalid message: ' + parsed.error.issues[0]?.message });
        return;
      }

      const msg = parsed.data;

      switch (msg.action) {
        case 'subscribe':
          for (const t of msg.types) {
            if (client.subscribedTypes.size >= 200) break;
            client.subscribedTypes.add(t);
          }
          sendJson(ws, { type: 'subscribed', types: Array.from(client.subscribedTypes) });
          break;

        case 'unsubscribe':
          for (const t of msg.types) {
            client.subscribedTypes.delete(t);
          }
          sendJson(ws, { type: 'subscribed', types: Array.from(client.subscribedTypes) });
          break;

        case 'ping':
          sendJson(ws, { type: 'pong' });
          break;
      }
    },

    onClose: (_event: unknown, ws: WSContext) => {
      cleanup(ws);
    },

    onError: (event: unknown, ws: WSContext) => {
      console.error('[EventWs] WebSocket error:', event);
      cleanup(ws);
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** @internal Clear the in-memory ticket store (for testing) */
export function _clearTicketStore(): void {
  ticketStore.clear();
}

/** @internal Store a legacy ticket to exercise the rolling-deploy reader. */
export function _storeLegacyTicketForTests(record: EventTicketV1): string {
  const ticket = randomBytes(32).toString('base64url');
  ticketStore.set(ticket, record);
  return ticket;
}
