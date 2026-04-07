import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { randomBytes } from 'crypto';
import { z } from 'zod';
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

// ---------------------------------------------------------------------------
// Ticket store (in-memory for dev, Redis for production)
// ---------------------------------------------------------------------------

interface TicketRecord {
  userId: string;
  orgId: string;
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

export async function createEventWsTicket(userId: string, orgId: string): Promise<{ ticket: string; expiresInSeconds: number }> {
  purgeExpired();

  const ticket = randomBytes(32).toString('base64url');
  const record: TicketRecord = {
    userId,
    orgId,
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

export async function consumeTicket(ticket: string): Promise<{ userId: string; orgId: string } | null> {
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
    return { userId: record.userId, orgId: record.orgId };
  }

  // In-memory path (development)
  const record = ticketStore.get(ticket);
  if (!record) return null;
  ticketStore.delete(ticket); // one-time semantics
  if (isExpired(record.expiresAt)) return null;
  return { userId: record.userId, orgId: record.orgId };
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

    // Resolve orgId for partner/system users who pass it as a query param
    const requestedOrgId = c.req.query('orgId') ?? undefined;
    const orgAccess = await resolveOrgAccess(auth, requestedOrgId);

    let orgId: string;
    if (auth.orgId) {
      orgId = auth.orgId;
    } else if (orgAccess.type === 'single') {
      orgId = orgAccess.orgId;
    } else if (orgAccess.type === 'multiple' && orgAccess.orgIds.length > 0) {
      orgId = orgAccess.orgIds[0]!;
    } else {
      return c.json({ error: 'Organization context required — select an org first' }, 400);
    }

    const result = await createEventWsTicket(auth.user.id, orgId);
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

function createEventWsHandlers(ticket: string | undefined) {
  let client: ClientEntry | null = null;
  let orgId: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (client && orgId) {
      getEventDispatcher().unregister(orgId, client);
      client = null;
      orgId = null;
    }
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

        orgId = identity.orgId;
        client = {
          ws,
          userId: identity.userId,
          subscribedTypes: new Set<string>(),
        };

        getEventDispatcher().register(orgId, client);
        resetIdleTimer(ws);

        sendJson(ws, { type: 'connected', userId: identity.userId });
      } catch (err) {
        console.error('[EventWs] onOpen error:', err);
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
        sendJson(ws, { type: 'error', message: 'Invalid message: ' + parsed.error.errors[0]?.message });
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
