import Redis from 'ioredis';
import type { WSContext } from 'hono/ws';
import { resolveRedisUrl, REDIS_CLIENT_BASE_OPTIONS } from './redis';

const STREAM_PREFIX = 'breeze:events';

/** Check if an event type matches a subscription pattern */
export function matchesEventType(eventType: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    if (!prefix || prefix.includes('*')) return false;
    return eventType.startsWith(prefix + '.');
  }
  if (pattern.includes('*')) return false;
  return eventType === pattern;
}

export interface ClientEntry {
  ws: WSContext;
  userId: string;
  subscribedTypes: Set<string>;
  /**
   * Optional per-client delivery predicate. When present, an event is only
   * delivered to this client if `filter(event)` returns true (in addition to
   * the event-type subscription match). The dispatcher stays generic — it
   * knows nothing about *why* a client filters; the authz semantics
   * (e.g. site-scope restriction) are owned entirely by the registrant
   * (see `eventWs.ts`). Unset = no extra filtering (full org access).
   *
   * `event` is the parsed `BreezeEvent` payload published on
   * `breeze:events:live:<orgId>`. The predicate must be synchronous and
   * must not throw (the dispatch loop fails closed on throw).
   */
  filter?: (event: Record<string, unknown>) => boolean;
}

const LIVE_CHANNEL_PATTERN = `${STREAM_PREFIX}:live:*`;
const LIVE_CHANNEL_PREFIX = `${STREAM_PREFIX}:live:`;

class EventDispatcher {
  private clients = new Map<string, Set<ClientEntry>>();
  // ONE Redis connection per process, shared across every subscribed org —
  // not one connection per org (that doesn't scale: a large partner with
  // org-access-all holds one client per org it can see, and Redis has a
  // shared server-wide `maxclients`; enough orgs on enough replicas exhausts
  // it for every tenant, not just the one that grew). `PSUBSCRIBE` on the
  // live-channel pattern and route by the channel name in the `pmessage`
  // payload instead — org fan-out moves entirely into this process's memory.
  private sharedSubscriber: Redis | null = null;
  private stopped = false;

  register(orgId: string, client: ClientEntry): void {
    if (!this.clients.has(orgId)) {
      this.clients.set(orgId, new Set());
    }
    this.clients.get(orgId)!.add(client);
    this.ensureSharedSubscriber();
  }

  unregister(orgId: string, client: ClientEntry): void {
    const orgClients = this.clients.get(orgId);
    if (!orgClients) return;
    orgClients.delete(client);
    if (orgClients.size === 0) {
      this.clients.delete(orgId);
    }
    // Deliberately does NOT tear the shared subscriber down when `clients`
    // goes empty: with a single process-wide connection there is no
    // per-org resource to reclaim, and the old per-org churn (subscribe on
    // every first client, unsubscribe on every last) is exactly what used to
    // multiply connections under org-access-all fan-out. It closes only in
    // `shutdown()`.
  }

  /**
   * Lazily create and PSUBSCRIBE the one shared connection. Safe to call on
   * every `register()` — a no-op once the connection exists.
   */
  private ensureSharedSubscriber(): void {
    if (this.sharedSubscriber || this.stopped) return;

    const url = resolveRedisUrl();
    const sub = new Redis(url, {
      ...REDIS_CLIENT_BASE_OPTIONS,
      maxRetriesPerRequest: 3,
    });
    this.sharedSubscriber = sub;

    // ioredis re-issues an active connection's subscriptions automatically
    // on reconnect (it tracks them client-side), so a transient Redis blip
    // does not need explicit resubscribe logic here — only the initial
    // failure path below does, since that's before ioredis has anything to
    // remember.
    sub.psubscribe(LIVE_CHANNEL_PATTERN, (err, count) => {
      if (err) {
        console.error('[EventDispatcher] Failed to psubscribe to live event channels, will retry on next register():', err.message);
        // Unlike the old per-org subscriber map, there is no per-org
        // `clients` entry to strand: leaving `sharedSubscriber` set to this
        // (subscribe-failed) connection would silently swallow every org's
        // events until process restart, so clear it and let the next
        // register() try again on a fresh connection.
        this.sharedSubscriber = null;
        sub.quit().catch(() => {});
        return;
      }
      console.log(`[EventDispatcher] Subscribed to ${count} live event channel pattern(s)`);
    });

    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (!channel.startsWith(LIVE_CHANNEL_PREFIX)) return;
      const orgId = channel.slice(LIVE_CHANNEL_PREFIX.length);
      if (!orgId) return;
      this.dispatch(orgId, message);
    });

    sub.on('error', (err: Error) => {
      console.error('[EventDispatcher] Shared Redis subscriber error:', err.message);
    });
  }

  private dispatch(orgId: string, rawMessage: string): void {
    const orgClients = this.clients.get(orgId);
    if (!orgClients || orgClients.size === 0) return;

    let parsed: { type?: string };
    try {
      parsed = JSON.parse(rawMessage);
    } catch (err) {
      console.error(`[EventDispatcher] Failed to parse event for org ${orgId}:`, err instanceof Error ? err.message : err);
      return;
    }

    const eventType = parsed.type;
    if (!eventType) return;

    const outgoing = JSON.stringify({ type: 'event', data: parsed });

    for (const client of orgClients) {
      if (client.subscribedTypes.size === 0) continue;

      let matches = false;
      for (const pattern of client.subscribedTypes) {
        if (matchesEventType(eventType, pattern)) {
          matches = true;
          break;
        }
      }

      // Per-client delivery predicate (e.g. site-scope authz, set by the WS
      // registrant). Generic hook — the dispatcher carries no site knowledge.
      // Fail closed: a throwing predicate drops the event for this client.
      if (matches && client.filter) {
        try {
          matches = client.filter(parsed);
        } catch (err) {
          console.warn(`[EventDispatcher] Client ${client.userId} filter threw for ${eventType}, dropping event:`, err instanceof Error ? err.message : err);
          matches = false;
        }
      }

      if (matches) {
        try {
          client.ws.send(outgoing);
        } catch (err) {
          console.warn(`[EventDispatcher] Failed to send ${eventType} to client ${client.userId} in org ${orgId}, removing client:`, err instanceof Error ? err.message : err);
          orgClients.delete(client);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const sub = this.sharedSubscriber;
    this.sharedSubscriber = null;
    if (sub) {
      sub.punsubscribe().catch((err: Error) => console.warn('[EventDispatcher] Shutdown punsubscribe error:', err.message));
      sub.quit().catch((err: Error) => console.warn('[EventDispatcher] Shutdown quit error:', err.message));
    }
    this.clients.clear();
  }
}

let instance: EventDispatcher | null = null;

export function getEventDispatcher(): EventDispatcher {
  if (!instance) {
    instance = new EventDispatcher();
  }
  return instance;
}

export async function shutdownEventDispatcher(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}
