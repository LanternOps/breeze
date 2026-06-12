import Redis from 'ioredis';
import type { WSContext } from 'hono/ws';
import { resolveRedisUrl } from './redis';

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

class EventDispatcher {
  private clients = new Map<string, Set<ClientEntry>>();
  private subscribers = new Map<string, Redis>();
  private stopped = false;

  register(orgId: string, client: ClientEntry): void {
    if (!this.clients.has(orgId)) {
      this.clients.set(orgId, new Set());
      this.subscribeToOrg(orgId);
    }
    this.clients.get(orgId)!.add(client);
  }

  unregister(orgId: string, client: ClientEntry): void {
    const orgClients = this.clients.get(orgId);
    if (!orgClients) return;
    orgClients.delete(client);
    if (orgClients.size === 0) {
      this.clients.delete(orgId);
      this.unsubscribeFromOrg(orgId);
    }
  }

  private subscribeToOrg(orgId: string): void {
    if (this.subscribers.has(orgId) || this.stopped) return;

    const url = resolveRedisUrl();
    const sub = new Redis(url, {
      maxRetriesPerRequest: 3,
    });

    sub.subscribe(`${STREAM_PREFIX}:live:${orgId}`, (err) => {
      if (err) {
        console.error(`[EventDispatcher] Failed to subscribe to org ${orgId}, removing dead subscriber:`, err.message);
        this.subscribers.delete(orgId);
        sub.quit().catch(() => {});
      }
    });

    sub.on('message', (_channel: string, message: string) => {
      this.dispatch(orgId, message);
    });

    sub.on('error', (err: Error) => {
      console.error(`[EventDispatcher] Redis subscriber error for org ${orgId}:`, err.message);
    });

    this.subscribers.set(orgId, sub);
  }

  private unsubscribeFromOrg(orgId: string): void {
    const sub = this.subscribers.get(orgId);
    if (!sub) return;
    sub.unsubscribe().catch((err: Error) => console.warn(`[EventDispatcher] Failed to unsubscribe org ${orgId}:`, err.message));
    sub.quit().catch((err: Error) => console.warn(`[EventDispatcher] Failed to quit Redis for org ${orgId}:`, err.message));
    this.subscribers.delete(orgId);
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
    for (const [, sub] of this.subscribers) {
      sub.unsubscribe().catch((err: Error) => console.warn('[EventDispatcher] Shutdown unsubscribe error:', err.message));
      sub.quit().catch((err: Error) => console.warn('[EventDispatcher] Shutdown quit error:', err.message));
    }
    this.subscribers.clear();
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
