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
      lazyConnect: true,
    });

    sub.subscribe(`${STREAM_PREFIX}:live:${orgId}`, (err) => {
      if (err) {
        console.error(`[EventDispatcher] Failed to subscribe to org ${orgId}:`, err.message);
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
    sub.unsubscribe().catch(() => {});
    sub.quit().catch(() => {});
    this.subscribers.delete(orgId);
  }

  private dispatch(orgId: string, rawMessage: string): void {
    const orgClients = this.clients.get(orgId);
    if (!orgClients || orgClients.size === 0) return;

    let parsed: { type?: string };
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
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

      if (matches) {
        try {
          client.ws.send(outgoing);
        } catch {
          console.warn(`[EventDispatcher] Failed to send event to client ${client.userId}, dropping`);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const [orgId] of this.subscribers) {
      this.unsubscribeFromOrg(orgId);
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
