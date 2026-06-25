import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
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

// Mid-session revalidation cadence. The ticket snapshots the user's org access
// at consume time and the connection then delivers events indefinitely with no
// further authorization check — so a user whose status/access is revoked keeps
// receiving live org events until idle/disconnect. Re-check the user is still
// active on this interval and tear the socket down fail-closed if not. Matches
// the desktop/terminal WS ~30s revocation cadence.
const REVALIDATE_INTERVAL_MS = 30 * 1000; // 30 seconds

// ---------------------------------------------------------------------------
// Ticket store (in-memory for dev, Redis for production)
// ---------------------------------------------------------------------------

interface TicketRecord {
  userId: string;
  // The full set of orgs this ticket grants access to. Always populated.
  // For org-scoped users this is a single id; for partner-scoped users
  // it can be the full accessible-orgs set so a single connection
  // receives events across all of them.
  orgIds: string[];
  // Legacy field — kept so older serialised records (in Redis or
  // in-memory across a deploy) still parse cleanly. New writes always
  // populate orgIds.
  orgId?: string;
  // App-layer-only SITE-scope axis (`permissions.allowedSiteIds`). RLS only
  // enforces ORG; events are delivered over Redis pub/sub with no DB backstop,
  // so a site-restricted user's connection must be filtered in the WS layer
  // (see `buildSiteFilter` / the dispatch-time predicate). `undefined` or
  // empty = full org access (no site restriction). Captured at mint time so
  // the restriction is bound to the ticket, not re-derived at connect time.
  allowedSiteIds?: string[];
  expiresAt: number;
}

const ticketStore = new Map<string, TicketRecord>();

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
  allowedSiteIds?: string[],
): Promise<{ ticket: string; expiresInSeconds: number }> {
  purgeExpired();

  const orgIds = Array.isArray(orgIdOrIds) ? [...new Set(orgIdOrIds)] : [orgIdOrIds];
  if (orgIds.length === 0) {
    throw new Error('createEventWsTicket requires at least one orgId');
  }

  // Only persist a site restriction when one is actually present. An empty or
  // undefined allowlist means "no site restriction" (full org access) and is
  // dropped so the ticket carries no `allowedSiteIds` key.
  const normalisedSiteIds =
    allowedSiteIds && allowedSiteIds.length > 0 ? [...new Set(allowedSiteIds)] : undefined;

  const ticket = randomBytes(32).toString('base64url');
  const record: TicketRecord = {
    userId,
    orgIds,
    // Populate the legacy field for forward compat with any reader that
    // hasn't been redeployed yet. Pick the first id deterministically.
    orgId: orgIds[0],
    ...(normalisedSiteIds ? { allowedSiteIds: normalisedSiteIds } : {}),
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

// Redis Lua script for atomic GET+DEL (one-time ticket semantics).
// This is the same pattern used in remoteSessionAuth.ts.
const CONSUME_LUA = `
  local v = redis.call('GET', KEYS[1])
  if v then
    redis.call('DEL', KEYS[1])
  end
  return v
`;

export interface TicketIdentity {
  userId: string;
  orgIds: string[];
  // Carried from the ticket. `undefined` = no site restriction (full org
  // access); a non-empty array means the connection may only receive events
  // positively attributable to one of these sites.
  allowedSiteIds?: string[];
}

function normaliseTicketRecord(record: TicketRecord): TicketIdentity | null {
  // Backward-compat: an older record might only carry orgId.
  const ids = record.orgIds && record.orgIds.length > 0
    ? record.orgIds
    : record.orgId
      ? [record.orgId]
      : [];
  if (ids.length === 0) return null;
  const allowedSiteIds =
    record.allowedSiteIds && record.allowedSiteIds.length > 0 ? record.allowedSiteIds : undefined;
  return { userId: record.userId, orgIds: ids, allowedSiteIds };
}

export async function consumeTicket(ticket: string): Promise<TicketIdentity | null> {
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      console.error('[EventWs] Redis unavailable during ticket consumption');
      return null;
    }

    // Atomic GET+DEL via Lua for one-time semantics across replicas
    const raw = await redis.eval(CONSUME_LUA, 1, `${REDIS_KEY_PREFIX}${ticket}`);
    if (!raw || typeof raw !== 'string') return null;

    let record: TicketRecord;
    try {
      record = JSON.parse(raw) as TicketRecord;
    } catch (err) {
      console.error('[EventWs] Failed to parse ticket record from Redis:', err instanceof Error ? err.message : err);
      return null;
    }

    if (isExpired(record.expiresAt)) return null;
    return normaliseTicketRecord(record);
  }

  // In-memory path (development)
  const record = ticketStore.get(ticket);
  if (!record) return null;
  ticketStore.delete(ticket); // one-time semantics
  if (isExpired(record.expiresAt)) return null;
  return normaliseTicketRecord(record);
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
  allowedSiteIds: string[] | undefined,
): ((event: Record<string, unknown>) => boolean) | undefined {
  if (!allowedSiteIds || allowedSiteIds.length === 0) return undefined;

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
 * The WS ticket carries only `userId` + the org set captured at mint time, so
 * we re-check the authoritative "access revoked" signal the rest of the system
 * uses — `users.status === 'active'` (see `authMiddleware`, which 403s an
 * inactive user). A deactivated/suspended user, or a deleted row, must stop
 * receiving events. Runs under system DB scope because the WS path bypasses
 * JWT middleware (no RLS context set).
 *
 * Fails CLOSED: a thrown DB error resolves to `false` (revoked) at the call
 * site so a transient failure tears the socket down rather than leaking events.
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
    // When `allOrgs=1` is passed (or no specific org is requested), partner-
    // scoped users get a ticket scoped to ALL their accessible orgs so a
    // single connection can receive events for the full set without the
    // client needing to multiplex tickets.
    const requestedOrgId = c.req.query('orgId') ?? undefined;
    const allOrgs = c.req.query('allOrgs') === '1';
    const orgAccess = await resolveOrgAccess(auth, requestedOrgId);

    let orgIds: string[];
    if (auth.orgId) {
      orgIds = [auth.orgId];
    } else if (orgAccess.type === 'single') {
      orgIds = [orgAccess.orgId];
    } else if (orgAccess.type === 'multiple' && orgAccess.orgIds.length > 0) {
      orgIds = allOrgs ? orgAccess.orgIds : [orgAccess.orgIds[0]!];
    } else {
      return c.json({ error: 'Organization context required — select an org first' }, 400);
    }

    // Capture the SITE-scope restriction (app-layer-only axis) so it's bound to
    // the ticket. A site-restricted org user must not receive live events for
    // sites outside their allowlist — RLS doesn't defend this and events are
    // pub/sub, not Postgres. `undefined`/empty = unrestricted (full org access).
    // Sourced from `auth.allowedSiteIds` (set by authMiddleware), NOT
    // `c.get('permissions')` — this route mints a ticket behind authMiddleware
    // only, and `permissions` is populated solely by requirePermission, which
    // does not run here.
    const allowedSiteIds = auth.allowedSiteIds;

    const result = await createEventWsTicket(auth.user.id, orgIds, allowedSiteIds);
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
export function createEventWsHandlers(ticket: string | undefined) {
  let client: ClientEntry | null = null;
  let registeredOrgIds: string[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let revalidateTimer: ReturnType<typeof setInterval> | null = null;

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
      clearInterval(revalidateTimer);
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

  function startRevalidation(ws: WSContext, userId: string) {
    revalidateTimer = setInterval(() => {
      // Fail CLOSED: any inactive/deleted user OR a thrown DB error closes the
      // socket within at most one revalidation interval. Nothing else
      // re-checks authorization once the connection is delivering events.
      void isEventWsUserActive(userId)
        .then((active) => {
          if (!active && client) {
            closeRevoked(ws, 'User no longer active');
          }
        })
        .catch((err) => {
          if (client) {
            console.error('[EventWs] Revalidation check failed, closing socket (fail-closed):', err instanceof Error ? err.message : err);
            closeRevoked(ws, 'Revalidation check failed');
          }
        });
    }, REVALIDATE_INTERVAL_MS);
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

        registeredOrgIds = identity.orgIds;
        client = {
          ws,
          userId: identity.userId,
          subscribedTypes: new Set<string>(),
          // Site-scope (app-layer-only) delivery gate. Undefined for
          // unrestricted users — no filtering, no behaviour change.
          filter: buildSiteFilter(identity.allowedSiteIds),
        };

        const dispatcher = getEventDispatcher();
        for (const id of registeredOrgIds) {
          dispatcher.register(id, client);
        }
        resetIdleTimer(ws);
        // Mid-session revalidation: stop delivering and close fail-closed once
        // the user's access is revoked (status flipped inactive / row deleted).
        startRevalidation(ws, identity.userId);

        sendJson(ws, { type: 'connected', userId: identity.userId, orgIds: registeredOrgIds });
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
