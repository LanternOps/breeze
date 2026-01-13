import { getRedis } from './redis';
import { randomUUID } from 'crypto';

// Event types for type safety
export type EventType =
  // Device events
  | 'device.enrolled'
  | 'device.online'
  | 'device.offline'
  | 'device.updated'
  | 'device.decommissioned'
  // Alert events
  | 'alert.triggered'
  | 'alert.acknowledged'
  | 'alert.resolved'
  | 'alert.escalated'
  // Script events
  | 'script.started'
  | 'script.completed'
  | 'script.failed'
  // Automation events
  | 'automation.started'
  | 'automation.completed'
  | 'automation.failed'
  // Patch events
  | 'patch.available'
  | 'patch.approved'
  | 'patch.installed'
  | 'patch.failed'
  | 'patch.rollback'
  // Remote events
  | 'remote.session.started'
  | 'remote.session.ended'
  | 'remote.file.transferred'
  // User events
  | 'user.login'
  | 'user.logout'
  | 'user.mfa.enabled';

export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export interface BreezeEvent<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  orgId: string;
  source: string;
  priority: EventPriority;
  payload: T;
  metadata: {
    correlationId?: string;
    causationId?: string;
    userId?: string;
    timestamp: string;
  };
}

export interface PublishOptions {
  priority?: EventPriority;
  correlationId?: string;
  causationId?: string;
  userId?: string;
}

export type EventHandler<T = Record<string, unknown>> = (event: BreezeEvent<T>) => Promise<void>;

// Stream key pattern: breeze:events:{orgId}
const STREAM_PREFIX = 'breeze:events';
const CONSUMER_GROUP = 'breeze-api';
const MAX_STREAM_LENGTH = 10000; // Trim streams to prevent unbounded growth

/**
 * EventBus - Redis Streams based event system for reliable event delivery
 *
 * Features:
 * - Guaranteed delivery via Redis Streams consumer groups
 * - Event replay capability
 * - Dead letter queue for failed processing
 * - Correlation ID tracking for distributed tracing
 * - Priority-based routing
 */
class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private consumerName: string;
  private isConsuming = false;

  constructor() {
    this.consumerName = `consumer-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Publish an event to the event bus
   */
  async publish<T = Record<string, unknown>>(
    type: EventType,
    orgId: string,
    payload: T,
    source: string,
    options: PublishOptions = {}
  ): Promise<string> {
    const redis = getRedis();
    const eventId = randomUUID();
    const streamKey = `${STREAM_PREFIX}:${orgId}`;

    const event: BreezeEvent<T> = {
      id: eventId,
      type,
      orgId,
      source,
      priority: options.priority || 'normal',
      payload,
      metadata: {
        correlationId: options.correlationId || eventId,
        causationId: options.causationId,
        userId: options.userId,
        timestamp: new Date().toISOString()
      }
    };

    // Add to Redis Stream
    await redis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      MAX_STREAM_LENGTH.toString(),
      '*',
      'event',
      JSON.stringify(event)
    );

    // Also publish to pub/sub for real-time subscribers
    await redis.publish(`${STREAM_PREFIX}:live:${orgId}`, JSON.stringify(event));

    // Publish to global channel for cross-org subscribers (webhooks, etc.)
    await redis.publish(`${STREAM_PREFIX}:global`, JSON.stringify(event));

    console.log(`[EventBus] Published ${type} for org ${orgId}: ${eventId}`);

    return eventId;
  }

  /**
   * Subscribe to events of a specific type
   */
  subscribe<T = Record<string, unknown>>(
    eventType: EventType | '*',
    handler: EventHandler<T>
  ): () => void {
    const key = eventType;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(key)?.delete(handler as EventHandler);
    };
  }

  /**
   * Start consuming events from Redis Streams
   */
  async startConsuming(orgIds: string[]): Promise<void> {
    if (this.isConsuming) return;
    this.isConsuming = true;

    const redis = getRedis();

    // Ensure consumer groups exist for each org
    for (const orgId of orgIds) {
      const streamKey = `${STREAM_PREFIX}:${orgId}`;
      try {
        await redis.xgroup('CREATE', streamKey, CONSUMER_GROUP, '0', 'MKSTREAM');
      } catch (err: unknown) {
        // Group already exists - ignore
        if (err instanceof Error && !err.message.includes('BUSYGROUP')) {
          throw err;
        }
      }
    }

    // Start consuming loop
    this.consumeLoop(orgIds);
  }

  private async consumeLoop(orgIds: string[]): Promise<void> {
    const redis = getRedis();
    const streams = orgIds.map(orgId => `${STREAM_PREFIX}:${orgId}`);
    const streamArgs = streams.flatMap(s => [s, '>']);

    while (this.isConsuming) {
      try {
        // Read from all streams with blocking
        const results = await redis.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          this.consumerName,
          'COUNT',
          '10',
          'BLOCK',
          '5000',
          'STREAMS',
          ...streamArgs
        );

        if (results) {
          for (const [, messages] of results as [string, [string, string[]][]][]) {
            for (const [messageId, fields] of messages) {
              await this.processMessage(messageId, fields, redis);
            }
          }
        }
      } catch (err) {
        console.error('[EventBus] Error in consume loop:', err);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async processMessage(
    messageId: string,
    fields: string[],
    redis: ReturnType<typeof getRedis>
  ): Promise<void> {
    // Parse event from fields
    const eventJson = fields[1]; // fields = ['event', '{...}']
    if (!eventJson) return;

    let event: BreezeEvent;
    try {
      event = JSON.parse(eventJson);
    } catch {
      console.error(`[EventBus] Failed to parse event: ${messageId}`);
      return;
    }

    // Get handlers for this event type
    const typeHandlers = this.handlers.get(event.type) || new Set();
    const wildcardHandlers = this.handlers.get('*') || new Set();
    const allHandlers = [...typeHandlers, ...wildcardHandlers];

    if (allHandlers.length === 0) {
      // No handlers - acknowledge immediately
      await redis.xack(`${STREAM_PREFIX}:${event.orgId}`, CONSUMER_GROUP, messageId);
      return;
    }

    // Process with all handlers
    let success = true;
    for (const handler of allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[EventBus] Handler failed for ${event.type}:`, err);
        success = false;
      }
    }

    if (success) {
      // Acknowledge successful processing
      await redis.xack(`${STREAM_PREFIX}:${event.orgId}`, CONSUMER_GROUP, messageId);
    } else {
      // Move to dead letter queue after max retries
      // For now, just acknowledge to prevent blocking
      await redis.xack(`${STREAM_PREFIX}:${event.orgId}`, CONSUMER_GROUP, messageId);
      await redis.lpush(`${STREAM_PREFIX}:dlq`, JSON.stringify({ messageId, event }));
    }
  }

  /**
   * Stop consuming events
   */
  stopConsuming(): void {
    this.isConsuming = false;
  }

  /**
   * Replay events from a specific point in time
   */
  async replay(
    orgId: string,
    fromTimestamp: Date,
    toTimestamp?: Date
  ): Promise<BreezeEvent[]> {
    const redis = getRedis();
    const streamKey = `${STREAM_PREFIX}:${orgId}`;

    // Convert timestamps to Redis stream IDs (ms-*)
    const fromId = `${fromTimestamp.getTime()}-0`;
    const toId = toTimestamp ? `${toTimestamp.getTime()}-0` : '+';

    const results = await redis.xrange(streamKey, fromId, toId, 'COUNT', '1000');

    return results.map(([, fields]) => {
      const eventJson = fields[1] || '{}';
      return JSON.parse(eventJson) as BreezeEvent;
    });
  }

  /**
   * Get pending events that haven't been acknowledged
   */
  async getPending(orgId: string, count = 100): Promise<string[]> {
    const redis = getRedis();
    const streamKey = `${STREAM_PREFIX}:${orgId}`;

    const pending = await redis.xpending(
      streamKey,
      CONSUMER_GROUP,
      '-',
      '+',
      count.toString()
    );

    return (pending as [string, string, number, number][]).map(([id]) => id);
  }

  /**
   * Get dead letter queue entries
   */
  async getDeadLetterQueue(count = 100): Promise<{ messageId: string; event: BreezeEvent }[]> {
    const redis = getRedis();
    const entries = await redis.lrange(`${STREAM_PREFIX}:dlq`, 0, count - 1);
    return entries.map(entry => JSON.parse(entry));
  }

  /**
   * Retry a dead letter queue entry
   */
  async retryDeadLetter(index: number): Promise<void> {
    const redis = getRedis();
    const entry = await redis.lindex(`${STREAM_PREFIX}:dlq`, index);
    if (!entry) return;

    const { event } = JSON.parse(entry) as { messageId: string; event: BreezeEvent };

    // Re-publish the event
    await this.publish(
      event.type,
      event.orgId,
      event.payload,
      event.source,
      {
        priority: event.priority,
        correlationId: event.metadata.correlationId,
        causationId: event.id, // Original event becomes causation
        userId: event.metadata.userId
      }
    );

    // Remove from DLQ
    await redis.lrem(`${STREAM_PREFIX}:dlq`, 1, entry);
  }
}

// Singleton instance
let eventBusInstance: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!eventBusInstance) {
    eventBusInstance = new EventBus();
  }
  return eventBusInstance;
}

// Convenience function for publishing events
export async function publishEvent<T = Record<string, unknown>>(
  type: EventType,
  orgId: string,
  payload: T,
  source: string,
  options?: PublishOptions
): Promise<string> {
  return getEventBus().publish(type, orgId, payload, source, options);
}

// Export event types for consumers
export const EVENT_TYPES = {
  // Device
  DEVICE_ENROLLED: 'device.enrolled' as const,
  DEVICE_ONLINE: 'device.online' as const,
  DEVICE_OFFLINE: 'device.offline' as const,
  DEVICE_UPDATED: 'device.updated' as const,
  DEVICE_DECOMMISSIONED: 'device.decommissioned' as const,
  // Alert
  ALERT_TRIGGERED: 'alert.triggered' as const,
  ALERT_ACKNOWLEDGED: 'alert.acknowledged' as const,
  ALERT_RESOLVED: 'alert.resolved' as const,
  ALERT_ESCALATED: 'alert.escalated' as const,
  // Script
  SCRIPT_STARTED: 'script.started' as const,
  SCRIPT_COMPLETED: 'script.completed' as const,
  SCRIPT_FAILED: 'script.failed' as const,
  // Automation
  AUTOMATION_STARTED: 'automation.started' as const,
  AUTOMATION_COMPLETED: 'automation.completed' as const,
  AUTOMATION_FAILED: 'automation.failed' as const,
  // Patch
  PATCH_AVAILABLE: 'patch.available' as const,
  PATCH_APPROVED: 'patch.approved' as const,
  PATCH_INSTALLED: 'patch.installed' as const,
  PATCH_FAILED: 'patch.failed' as const,
  PATCH_ROLLBACK: 'patch.rollback' as const,
  // Remote
  REMOTE_SESSION_STARTED: 'remote.session.started' as const,
  REMOTE_SESSION_ENDED: 'remote.session.ended' as const,
  REMOTE_FILE_TRANSFERRED: 'remote.file.transferred' as const,
  // User
  USER_LOGIN: 'user.login' as const,
  USER_LOGOUT: 'user.logout' as const,
  USER_MFA_ENABLED: 'user.mfa.enabled' as const
};
